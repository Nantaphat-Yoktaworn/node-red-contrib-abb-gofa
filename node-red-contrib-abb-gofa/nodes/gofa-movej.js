'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
var gofaRobot = require('./gofa-robot');
var resolveMoveType = gofaRobot.resolveMoveType;
var validateJoints = gofaRobot.validateJoints;

// Keys an object payload may carry WITHOUT being a joint target — these are
// control-only overrides, so {moveType:'L'} still means "use the configured
// joints, but move linearly" rather than "here is a broken target".
var CONTROL_KEYS = ['moveType', 'action'];

// A1 (2026-08-04): resolve msg.payload into joints, distinguishing "no target
// supplied" from "target supplied but malformed".
//
// Before this, BOTH collapsed to j=null and fell through to the node's configured
// joints — so a 5-element array, or {x:1,y:2}, silently moved the arm to the
// configured pose instead of erroring. The array-length and j1 checks further down
// could never fire on those inputs. For a motion node that is the wrong failure
// mode: a typo'd payload moved the robot somewhere the flow never asked for.
//
// Returns { joints: [...] }            -> use these
//         { useConfigured: true }      -> no target supplied; fall back (unchanged)
//         { error: '...' }             -> supplied but malformed; refuse to move
function resolveJointsPayload(payload) {
    // Absent, or a bare trigger value (inject timestamp, boolean) -> configured joints.
    if (payload === null || payload === undefined) return { useConfigured: true };
    if (typeof payload === 'number' || typeof payload === 'boolean') return { useConfigured: true };
    if (typeof payload === 'string') {
        if (payload.trim() === '') return { useConfigured: true };
        // Non-empty string: accept a JSON array, matching what the admin route has
        // always done (it JSON.parses req.body.joints). Anything else is malformed.
        var parsed;
        try { parsed = JSON.parse(payload); }
        catch (e) {
            return { error: 'msg.payload string is not valid JSON — expected a 6-element ' +
                            'joint array, e.g. "[0,0,85,0,0,0]"' };
        }
        return resolveJointsPayload(parsed);
    }
    if (Array.isArray(payload)) {
        if (payload.length !== 6) {
            return { error: 'joints must be a 6-element array (got ' + payload.length + ')' };
        }
        return { joints: payload };
    }
    if (typeof payload === 'object') {
        if (payload.j1 !== undefined) {
            // Partial objects ({j1,j2} only) fall through to the numeric check below,
            // which already rejects the resulting undefined entries.
            return { joints: [payload.j1, payload.j2, payload.j3, payload.j4, payload.j5, payload.j6] };
        }
        if (Array.isArray(payload.joints)) return resolveJointsPayload(payload.joints);
        // Control-only object (or {}) -> no target supplied, use the configured joints.
        var keys = Object.keys(payload);
        var onlyControl = keys.every(function(k) { return CONTROL_KEYS.indexOf(k) >= 0; });
        if (onlyControl) return { useConfigured: true };
        return { error: 'msg.payload has no joint target — expected a 6-element array, ' +
                        '{j1..j6}, or {joints:[...]} (got keys: ' + keys.join(', ') + ')' };
    }
    return { error: 'msg.payload type ' + (typeof payload) + ' is not a joint target' };
}
module.exports = function(RED) {
    function GoFaMoveJNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.joints   = config.joints || '[0,0,85,0,0,0]';
        this.moveType = resolveMoveType(config.moveType, 'J');
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var resolved = resolveJointsPayload(msg.payload);
            if (resolved.error) {
                // Supplied but malformed — refuse to move rather than silently
                // falling back to the configured pose.
                msg.payload = { ok: false, error: resolved.error };
                node.error(resolved.error, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad payload' });
                send(msg); return done();
            }

            var j = resolved.joints;
            if (!j) {
                try {
                    j = JSON.parse(node.joints);
                } catch(e) {
                    msg.payload = { ok: false, error: 'Invalid joints config: ' + node.joints };
                    node.error('Invalid joints config: ' + node.joints, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                    send(msg); return done();
                }
            }

            if (!Array.isArray(j) || j.length !== 6) {
                msg.payload = { ok: false, error: 'joints must be a 6-element array' };
                node.error('joints must be a 6-element array', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                send(msg); return done();
            }

            var nums = j.map(function(v) { return parseFloat(v); });
            if (nums.some(function(v) { return isNaN(v); })) {
                msg.payload = { ok: false, error: 'joints contains non-numeric values' };
                node.error('joints contains non-numeric values', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                send(msg); return done();
            }

            // Soft joint-limit check (fail fast with a clean error instead of a
            // RAPID motion fault). Limits come from the robot config node
            // (CRB 15000-12 hardware defaults unless overridden).
            var jchk = validateJoints(nums, node.robot.jointLimits);
            if (!jchk.ok) {
                var jerr = 'Joint ' + jchk.joint + ' = ' + jchk.value + '° is outside its limit [' + jchk.min + ', ' + jchk.max + ']';
                msg.payload = { ok: false, error: jerr, joint: jchk.joint, value: jchk.value, min: jchk.min, max: jchk.max };
                node.error(jerr, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'joint ' + jchk.joint + ' out of range' });
                send(msg); return done();
            }

            // Move type: J = MoveAbsJ (joint-interpolated, default, most reliable),
            // L = straight-line TCP path to the pose those joints describe (the
            // RAPID server does the forward kinematics via CalcRobT). Same
            // per-message override names gofa-points' go action uses.
            var moveType = node.moveType;
            if (msg.moveType !== undefined) moveType = resolveMoveType(msg.moveType, moveType);
            if (msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) && msg.payload.moveType !== undefined) {
                moveType = resolveMoveType(msg.payload.moveType, moveType);
            }
            var cmdName = moveType === 'L' ? 'movel' : 'movej';

            node.status({ fill: 'blue', shape: 'dot', text: cmdName + ': [' + nums.map(function(v) { return v.toFixed(1); }).join(',') + ']' });

            node.robot.socketSend({ cmd: cmdName, val: nums.map(function(v) { return parseFloat(v.toFixed(2)); }) }).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true, joints: nums, moveType: moveType };
                node.status({ fill: 'green', shape: 'dot', text: '[' + nums.map(function(v) { return v.toFixed(1); }).join(',') + ']' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-movej', GoFaMoveJNode);

    RED.httpAdmin.post('/gofa-movej/:id/move', requireAdminAuth(RED, 'gofa-movej.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var moveType = resolveMoveType(req.body.moveType, 'J');

        // Same resolver the runtime node uses, so the two paths cannot disagree
        // about what counts as a valid target (they did before A1: the panel
        // already 400'd on a wrong-length array while the node silently moved to
        // its configured pose). The panel always supplies joints explicitly, so
        // there is no configured-joints fallback here — useConfigured is an error.
        var resolved = resolveJointsPayload(req.body.joints);
        if (resolved.error) {
            return res.status(400).json({ error: resolved.error });
        }
        if (!resolved.joints) {
            return res.status(400).json({ error: 'joints must be a 6-element array' });
        }
        var j = resolved.joints;

        var nums = j.map(function(v) { return parseFloat(v); });
        if (nums.some(function(v) { return isNaN(v); })) {
            return res.status(400).json({ error: 'joints contains non-numeric values' });
        }

        var jchk = validateJoints(nums, robot.jointLimits);
        if (!jchk.ok) {
            return res.status(400).json({ error: 'Joint ' + jchk.joint + ' = ' + jchk.value +
                '° is outside its limit [' + jchk.min + ', ' + jchk.max + ']',
                joint: jchk.joint, value: jchk.value, min: jchk.min, max: jchk.max });
        }

        var cmdName = moveType === 'L' ? 'movel' : 'movej';

        return robot.socketSend({ cmd: cmdName, val: nums.map(function(v) { return parseFloat(v.toFixed(2)); }) }).then(function(resp) {
            if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
            res.json({ ok: true, joints: nums, moveType: moveType });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};

module.exports.resolveJointsPayload = resolveJointsPayload;
