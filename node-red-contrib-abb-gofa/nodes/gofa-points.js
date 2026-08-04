'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
var resolveMoveType = require('./gofa-robot').resolveMoveType;
var fs = require('fs');

// Shared action logic for both the runtime node and the admin (editor-panel) routes below.
// Each fn takes (robot, opts) and returns a Promise resolving to a plain result object —
// on(input) turns that into msg.payload; the admin routes turn it into res.json(...).
// A returned {error:...} (no throw) means "not found"/"validation failed" (400/404-shaped);
// a thrown/rejected error means a transport-level failure (502-shaped).
//
// 2.5.0: local (Node-RED-host) point storage was removed entirely, by request — every action
// now operates on the robot controller's own on-disk point list via RWS fileservice
// (robot.remoteGetPoints/remoteAddPoint/remoteDeletePoint/remoteFindPoint/remoteSavePoints in
// gofa-robot.js). export/import were repurposed to match: export reads the on-robot list
// (optionally also backing it up to a file on the Node-RED host), import validates and
// REPLACES the on-robot list (from a file, or an array/`{points:[...]}` straight off the
// payload) instead of the local in-memory list that no longer exists.

// Same validation gofa-robot.js's old (now-removed) replacePoints() used for the local list —
// import needs it since remoteSavePoints() itself does no validation, just JSON.stringify+PUT.
function validatePointsArray(arr) {
    if (!Array.isArray(arr)) {
        return { error: 'Input must be an array' };
    }
    for (var i = 0; i < arr.length; i++) {
        var item = arr[i];
        if (!item || typeof item !== 'object') {
            return { error: 'Element is not an object', invalidAt: i };
        }
        if (typeof item.name !== 'string' || !item.name.trim()) {
            return { error: 'Element missing a non-empty name string', invalidAt: i };
        }
        if (!item.target || typeof item.target !== 'object') {
            return { error: 'Element missing target object', invalidAt: i };
        }
        var t = item.target;
        var vals = [t.x, t.y, t.z, t.q1, t.q2, t.q3, t.q4, t.cf1, t.cf4, t.cf6, t.cfx];
        if (vals.some(function(v) { return typeof v !== 'number' || !isFinite(v); })) {
            return { error: 'Element target has non-numeric fields', invalidAt: i };
        }
    }
    var baseTime = Date.now();
    var points = arr.map(function(item, i) {
        return { id: item.id || ('p' + baseTime + '-' + i), name: item.name.trim(), target: item.target };
    });
    return { points: points };
}

// The 11 robtarget fields every stored point must carry.
var TARGET_FIELDS = ['x', 'y', 'z', 'q1', 'q2', 'q3', 'q4', 'cf1', 'cf4', 'cf6', 'cfx'];

function doSave(robot, opts) {
    var name = String(opts.name || '').trim();
    return robot.rwsGet('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base')
    .then(function(body) {
        var p = function(c){ return parseFloat(robot.parseXhtml(body, c)); };
        var target = {
            x: p('x'), y: p('y'), z: p('z'),
            q1: p('q1'), q2: p('q2'), q3: p('q3'), q4: p('q4'),
            cf1: p('cf1'), cf4: p('cf4'), cf6: p('cf6'), cfx: p('cfx')
        };
        // B1: validate BEFORE persisting. parseXhtml returns null for a class that
        // isn't in the response, parseFloat(null) is NaN, and JSON.stringify writes
        // NaN as null — so a partial/unexpected robtarget response used to be stored
        // silently as a corrupt point, only failing much later at gotoObj ("Point has
        // invalid data (NaN)") when someone tried to move to it. Same isFinite check
        // validatePointsArray already applies on the import path.
        var bad = TARGET_FIELDS.filter(function(f) { return !isFinite(target[f]); });
        if (bad.length) {
            return { error: 'Could not read a valid robtarget from the controller — ' +
                'missing/non-numeric field(s): ' + bad.join(', ') +
                '. Point not saved (check RAPID is running and ROB_1 is the active mechunit).' };
        }
        return robot.remoteAddPoint(name, target).then(function(pt) {
            if (pt.error) return pt;
            return robot.remoteGetPoints().then(function(points) { return { point: pt, points: points }; });
        });
    });
}

function doGo(robot, opts) {
    var nameOrId = opts.name;
    var moveType = opts.moveType; // already resolved (with the right default) by the caller
    return robot.remoteFindPoint(nameOrId).then(function(pt) {
        if (!pt) return { error: 'Point not found: ' + nameOrId };
        var obj = robot.gotoObj(pt.target, moveType);
        if (!obj) return { error: 'Point has invalid data (NaN): ' + pt.name };
        return robot.socketSend(obj).then(function(ack) {
            var ok = ack.indexOf('OK:') === 0;
            return { ok: ok, ack: ack, point: pt, moveType: moveType };
        });
    });
}

function doList(robot, opts) {
    return robot.remoteGetPoints().then(function(points) { return { points: points }; });
}

function doDelete(robot, opts) {
    var nameOrId = opts.name;
    return robot.remoteFindPoint(nameOrId).then(function(pt) {
        if (!pt) return null;
        return robot.remoteDeletePoint(pt.id).then(function() {
            return robot.remoteGetPoints().then(function(points) { return { deleted: pt, points: points }; });
        });
    }).then(function(result) {
        if (!result) return { error: 'Point not found: ' + nameOrId };
        return result;
    });
}

function doExport(robot, opts) {
    var savePath = opts.path || '';
    return robot.remoteGetPoints().then(function(points) {
        if (!savePath) return { count: points.length, points: points };
        var p = savePath;
        if (!/\.json$/i.test(p)) p += '.json';
        // D3: async — a sync write blocks Node-RED's whole event loop, and this
        // path can target a slow/remote mount.
        return fs.promises.writeFile(p, JSON.stringify(points, null, 2), 'utf8')
            .then(function() { return { count: points.length, points: points, savedTo: p }; },
                  function(err) { throw new Error('File write failed: ' + err.message); });
    });
}

function doImport(robot, opts) {
    var loadPath = opts.path || '';
    // D3: async read, same reasoning as doExport above.
    var arrPromise = loadPath
        ? fs.promises.readFile(loadPath, 'utf8').then(function(raw) {
            var parsed = JSON.parse(raw);
            var arr = Array.isArray(parsed) ? parsed
                : (parsed && Array.isArray(parsed.points)) ? parsed.points
                : null;
            if (!arr) throw new Error('File must contain an array or {points:[...]}');
            return arr;
          }).catch(function(err) { throw new Error('File read failed: ' + err.message); })
        : Promise.resolve(Array.isArray(opts.points) ? opts.points : []);

    return arrPromise.then(function(arr) {
        var validated = validatePointsArray(arr);
        if (validated.error) return { error: validated.error };
        return robot.remoteSavePoints(validated.points).then(function() {
            return { count: validated.points.length, loadedFrom: loadPath || null };
        });
    });
}

var ACTIONS = { save: doSave, go: doGo, list: doList, delete: doDelete, export: doExport, import: doImport };

module.exports = function(RED) {
    function GoFaPointsNode(config) {
        RED.nodes.createNode(this, config);
        this.robot     = RED.nodes.getNode(config.robot);
        this.action    = config.action    || 'list';
        this.pointName = config.pointName || '';
        this.moveType  = resolveMoveType(config.moveType, 'J');
        this.path      = config.path      || '';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var raw = msg.payload;
            var action = (raw && typeof raw === 'object' && raw.action) ? raw.action : node.action;
            if (!ACTIONS.hasOwnProperty(action)) {
                msg.payload = { ok: false, error: 'Unknown action: ' + action };
                node.error('Unknown action: ' + action, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'unknown action' });
                send(msg); return done();
            }

            // A bare-string msg.payload is never an action override (that's .action only, see
            // above) — its meaning depends on which action is actually running, matching each
            // original single-purpose node's own convention: the point name/id for
            // save/go/delete, the file path for export/import, unused for list.
            var bareString = (typeof raw === 'string' && raw) ? raw : '';
            var obj = (raw && typeof raw === 'object') ? raw : {};

            var opts = {
                name:     obj.name || obj.id || bareString || node.pointName,
                moveType: resolveMoveType(obj.moveType, node.moveType),
                path:     bareString || obj.path || obj.savePath || obj.loadPath || node.path
            };
            // import with no path falls back to the raw payload itself (array or {points:[...]})
            if (action === 'import' && !opts.path) {
                opts.points = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.points) ? raw.points : []);
            }

            node.status({ fill: 'blue', shape: 'dot', text: action + '...' });
            ACTIONS[action](node.robot, opts)
            .then(function(result) {
                if (result.error) {
                    msg.payload = { ok: false, error: result.error };
                    node.status({ fill: 'red', shape: 'ring', text: result.error });
                    send(msg);
                    // import's {error} case (validation failure) is a real error to Node-RED —
                    // matches the original standalone gofa-points node's behavior; save/go/delete's
                    // {error} case (duplicate name / not found) is not.
                    if (action === 'import') {
                        var validationErr = new Error(result.error);
                        node.error(validationErr, msg);
                        return done(validationErr);
                    }
                    return done();
                }
                msg.payload = buildOutput(action, result);
                node.status({ fill: 'green', shape: 'dot', text: statusText(action, result) });
                send(msg); done();
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-points', GoFaPointsNode);

    function buildOutput(action, result) {
        switch (action) {
            case 'save':   return { ok: true, point: result.point, points: result.points };
            case 'go':     return result.ok
                ? { ok: true, ack: result.ack, point: result.point, moveType: result.moveType }
                : { ok: false, ack: result.ack, point: result.point, moveType: result.moveType };
            case 'list':   return result.points;
            case 'delete': return { ok: true, deleted: result.deleted, points: result.points };
            case 'export': return result.savedTo
                ? { ok: true, count: result.count, points: result.points, savedTo: result.savedTo }
                : { ok: true, count: result.count, points: result.points };
            case 'import': return { ok: true, count: result.count, loadedFrom: result.loadedFrom };
        }
    }

    function statusText(action, result) {
        switch (action) {
            case 'save':   return 'saved: ' + result.point.name;
            case 'go':     return result.ack;
            case 'list':   return result.points.length + ' points';
            case 'delete': return 'deleted: ' + result.deleted.name;
            case 'export': return result.count + (result.savedTo ? ' pts → ' + result.savedTo : ' points');
            case 'import': return result.count + ' points imported';
        }
    }

    // Single admin route for the editor panel's "Run action now" button — used by every
    // action. list/export are read-only-safe but still routed through the same POST+write-auth
    // gate as the mutating actions for one consistent, simple permission story (matches the
    // majority of the six actions, which do mutate).
    RED.httpAdmin.post('/gofa-points/:id/run', requireAdminAuth(RED, 'gofa-points.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot) {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var action = req.body.action || 'list';
        if (!ACTIONS.hasOwnProperty(action)) {
            return res.status(400).json({ error: 'Unknown action: ' + action });
        }
        var opts = {
            name:     req.body.pointName || '',
            moveType: resolveMoveType(req.body.moveType, 'J'),
            path:     req.body.path || '',
            points:   Array.isArray(req.body.points) ? req.body.points : []
        };
        if ((action === 'go' || action === 'delete') && !opts.name) {
            return res.status(400).json({ error: 'No point specified' });
        }
        if (action === 'import' && !opts.path) {
            return res.status(400).json({ error: 'File path is required for import action' });
        }

        ACTIONS[action](robot, opts)
        .then(function(result) {
            if (result.error) {
                var status = (action === 'go' || action === 'delete') ? 404 : 400;
                return res.status(status).json({ error: result.error });
            }
            if (action === 'go' && !result.ok) {
                return res.status(502).json({ error: result.ack });
            }
            if (action === 'export') {
                // Editor preview only needs a few rows, not the whole list.
                return res.json({ ok: true, count: result.count, points: result.points.slice(0, 5), savedTo: result.savedTo || null });
            }
            res.json(Object.assign({ ok: true }, result));
        })
        .catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
