'use strict';
const https = require('https');
const http  = require('http');
const net   = require('net');
const fs    = require('fs');
const path  = require('path');

function parseXhtml(body, cls) {
    var m = body.match(new RegExp('class="' + cls + '">([^<]+)<'));
    return m ? m[1].trim() : null;
}

// Write via temp-file + rename so a crash/interruption mid-write can never
// leave points.json truncated or half-written.
function atomicWriteFileSync(filePath, contents) {
    var tmpPath = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmpPath, contents);
    fs.renameSync(tmpPath, filePath);
}

function fileMtimeMs(filePath) {
    try { return fs.statSync(filePath).mtimeMs; }
    catch (e) { return null; }
}

// Validates a move-type value ('J' or 'L'); anything else resolves to fallback.
function resolveMoveType(v, fallback) {
    return (v === 'L' || v === 'J') ? v : fallback;
}

// Shared by addPoint() (local, sync) and remoteAddPoint() (on-robot, async) —
// auto-names "Point N" when blank, rejects a name that's already taken.
function resolvePointName(name, existingPoints) {
    name = (name || '').trim();
    if (!name) {
        var n = 1;
        var names = existingPoints.map(function(p) { return p.name; });
        while (names.indexOf('Point ' + n) >= 0) n++;
        return { name: 'Point ' + n };
    }
    if (existingPoints.some(function(p) { return p.name === name; })) {
        return { error: 'A point named "' + name + '" already exists' };
    }
    return { name: name };
}

// Build GOTO token — rounded to stay under RAPID's 80-char string limit; null on bad data.
// moveType 'L' selects MoveL (straight-line TCP path); anything else (default) selects MoveJ.
function gotoToken(t, moveType) {
    var vals = [t.x, t.y, t.z, t.q1, t.q2, t.q3, t.q4, t.cf1, t.cf4, t.cf6, t.cfx];
    if (vals.some(function(v) { return !isFinite(v); })) return null;
    function r(v, d) { return Number(v).toFixed(d); }
    return 'GOTO' + resolveMoveType(moveType, 'J') + [
        r(t.x,1), r(t.y,1), r(t.z,1),
        r(t.q1,4), r(t.q2,4), r(t.q3,4), r(t.q4,4),
        Math.round(t.cf1), Math.round(t.cf4), Math.round(t.cf6), Math.round(t.cfx)
    ].join(';');
}

// RED-independent RWS/socket client — carries the session/auth/cookie state
// and connection logic on its own, so it can be used both by GoFaRobotNode
// (wrapped in the RED node lifecycle) and by standalone scripts (check-status.js)
// that have no Node-RED runtime at all.
function createRobotClient(opts) {
    var ip         = opts.ip;
    var rwsPort    = opts.rwsPort;
    var socketPort = opts.socketPort;
    var username   = opts.username;
    var password   = opts.password;

    var cookie       = null;
    var loginPromise = null;

    function request(method, urlPath, body, forceAuth, accept, contentType) {
        return new Promise(function(resolve, reject) {
            var headers = { 'Accept': accept || 'application/xhtml+xml;v=2.0' };
            if (forceAuth || !cookie) {
                headers['Authorization'] = 'Basic ' +
                    Buffer.from(username + ':' + password).toString('base64');
            } else {
                headers['Cookie'] = cookie;
            }
            if (method === 'POST' || method === 'PUT') {
                headers['Content-Type']   = contentType || 'application/x-www-form-urlencoded;v=2.0';
                headers['Content-Length'] = Buffer.byteLength(body || '');
            }
            var proto = rwsPort === 443 ? https : http;
            var req = proto.request({
                hostname: ip, port: rwsPort,
                path: urlPath, method: method,
                headers: headers, rejectUnauthorized: false
            }, function(res) {
                if (res.headers['set-cookie']) {
                    cookie = res.headers['set-cookie']
                        .map(function(c) { return c.split(';')[0]; }).join('; ');
                }
                var data = '';
                res.on('data', function(c) { data += c; });
                res.on('end', function() {
                    if (res.statusCode === 401 && !forceAuth) {
                        cookie = null;
                        request(method, urlPath, body, true, accept, contentType).then(resolve).catch(reject);
                    } else if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        // RWS error bodies carry a human-readable reason (xhtml <span class="msg">
                        // or hal+json "msg":"..."), e.g. "Operation not allowed for current PGM
                        // state" on activate/loadmod while RAPID is running — surface it instead
                        // of just the status code, which alone gives no hint what went wrong.
                        var reason = (/class="msg">([^<]+)</.exec(data) || /"msg"\s*:\s*"([^"]+)"/.exec(data) || [])[1];
                        reject(new Error('HTTP ' + res.statusCode + ' ' + urlPath + (reason ? ' — ' + reason : '')));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(8000, function() { req.destroy(new Error('RWS request timeout: ' + urlPath)); });
            if (body) req.write(body);
            req.end();
        });
    }

    function getSession() {
        if (cookie) return Promise.resolve();
        if (!loginPromise) {
            loginPromise = request('GET', '/rw/system', null, true)
                .then(function() { loginPromise = null; })
                .catch(function(e) { loginPromise = null; throw e; });
        }
        return loginPromise;
    }

    function rwsGet(p) { return getSession().then(function() { return request('GET', p, null, false); }); }
    function rwsPost(p, b) { return getSession().then(function() { return request('POST', p, b, false); }); }
    function rwsPut(p, b, contentType) { return getSession().then(function() { return request('PUT', p, b, false, undefined, contentType); }); }
    // The RWS task loadmod resource is the one confirmed exception that requires
    // application/hal+json;v=2.0 — every other endpoint in this palette uses xhtml+xml
    // and errors ("Server cannot generate response for given accept header") on hal+json.
    function rwsPostHal(p, b) { return getSession().then(function() { return request('POST', p, b, false, 'application/hal+json;v=2.0'); }); }
    // Edit mastership is the only domain OmniCore allows requesting explicitly —
    // general mastership is always held internally by the RAPID runtime.
    function withMastership(fn) {
        var req = '/rw/mastership/edit/request';
        var rel = '/rw/mastership/edit/release';
        return getSession()
            .then(function() { return request('POST', req, '', false); })
            .then(function() {
                return fn().then(
                    function(result) {
                        return request('POST', rel, '', false)
                            .then(function() { return result; });
                    },
                    function(err) {
                        return request('POST', rel, '', false)
                            .then(function() { throw err; }, function() { throw err; });
                    }
                );
            });
    }
    // Low-level escape hatch for callers that need something the body-only
    // rwsGet/rwsPost/rwsPut don't expose: a response header (RWS subscription's
    // Location), or a binary-safe body (gofa-file-read downloading non-UTF8
    // files) — resolves the raw {statusCode, headers, body: Buffer} instead of
    // just a decoded string. No 401 auto-retry (unlike request()); callers so
    // far only use this right after another call has already established a
    // session. Exists so node files stop hand-rolling their own https/http
    // request against private fields (ip/cookie/etc) — that duplication is
    // exactly what broke gofa-upload-mod when session state moved into this
    // closure: three more node files (subscribe-io, subscribe-state, file-read)
    // had the same private-field reach-in and the same latent bug.
    function requestRaw(method, urlPath, body, opts) {
        opts = opts || {};
        return getSession().then(function() {
            return new Promise(function(resolve, reject) {
                var headers = { 'Accept': opts.accept || 'application/xhtml+xml;v=2.0' };
                if (cookie) headers['Cookie'] = cookie;
                else headers['Authorization'] = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
                if (opts.contentType) headers['Content-Type'] = opts.contentType;
                if (body) headers['Content-Length'] = Buffer.byteLength(body);
                var proto = rwsPort === 443 ? https : http;
                var req = proto.request({
                    hostname: ip, port: rwsPort, path: urlPath, method: method,
                    headers: headers, rejectUnauthorized: false
                }, function(res) {
                    if (res.headers['set-cookie']) {
                        cookie = res.headers['set-cookie'].map(function(c) { return c.split(';')[0]; }).join('; ');
                    }
                    var chunks = [];
                    res.on('data', function(c) { chunks.push(c); });
                    res.on('end', function() {
                        if (res.statusCode === 401) { cookie = null; return reject(new Error('HTTP 401 Unauthorized')); }
                        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
                    });
                });
                req.on('error', reject);
                req.setTimeout(opts.timeout || 8000, function() { req.destroy(new Error('RWS request timeout: ' + urlPath)); });
                if (body) req.write(body);
                req.end();
            });
        });
    }
    function getCookie() { return getSession().then(function() { return cookie; }); }
    function socketSend(cmd) {
        return new Promise(function(resolve, reject) {
            var sock = new net.Socket();
            var buf = '', settled = false;
            function finish(err, val) {
                if (settled) return; settled = true;
                sock.destroy();
                err ? reject(err) : resolve(val);
            }
            sock.setTimeout(5000);
            sock.connect(socketPort, ip, function() { sock.write(cmd + '\n'); });
            sock.on('data', function(d) {
                buf += d.toString();
                if (buf.indexOf('\n') >= 0) finish(null, buf.trim());
            });
            sock.on('timeout', function() { finish(new Error('socket timeout')); });
            sock.on('error', finish);
            sock.on('close', function() { if (!settled) finish(new Error('socket closed')); });
        });
    }

    return {
        rwsGet: rwsGet, rwsPost: rwsPost, rwsPut: rwsPut, rwsPostHal: rwsPostHal,
        withMastership: withMastership, socketSend: socketSend,
        requestRaw: requestRaw, getCookie: getCookie
    };
}

module.exports = function(RED) {
    function GoFaRobotNode(config) {
        RED.nodes.createNode(this, config);
        this.ip         = config.ip         || '192.168.20.33';
        this.rwsPort    = parseInt(config.rwsPort)    || 443;
        this.socketPort = parseInt(config.socketPort) || 1025;
        this.username   = config.username   || 'NNNN';
        this.password   = (this.credentials && this.credentials.password) || '';
        if (!this.password) {
            this.warn('gofa-robot: no password configured — set one in the node credentials');
        }
        this.pointsFile = config.pointsFile || path.join(RED.settings.userDir || '.', 'points.json');
        this.remotePointsPath = config.remotePointsPath || '$HOME/Programs/gofa_points.json';

        this._client = createRobotClient({
            ip: this.ip, rwsPort: this.rwsPort, socketPort: this.socketPort,
            username: this.username, password: this.password
        });
        this._points       = [];
        this._pointsMtime  = null;
        this._seqStop      = false;
        this._seqRunning   = false;

        this._loadPoints();
    }

    GoFaRobotNode.prototype._loadPoints = function() {
        try {
            this._points = JSON.parse(fs.readFileSync(this.pointsFile, 'utf8'));
            this._pointsMtime = fileMtimeMs(this.pointsFile);
        }
        catch(e) { this._points = []; this._pointsMtime = null; }
    };

    GoFaRobotNode.prototype._savePoints = function() {
        var onDisk = fileMtimeMs(this.pointsFile);
        if (this._pointsMtime !== null && onDisk !== null && onDisk !== this._pointsMtime) {
            this.warn('points.json changed on disk since it was last read (another flow or ' +
                      'config node using the same file?) — this save will overwrite those changes');
        }
        try {
            atomicWriteFileSync(this.pointsFile, JSON.stringify(this._points, null, 2));
            this._pointsMtime = fileMtimeMs(this.pointsFile);
        }
        catch(e) { this.warn('points.json write failed: ' + e.message); }
    };

    GoFaRobotNode.prototype.getPoints  = function() { return this._points; };

    GoFaRobotNode.prototype.addPoint = function(name, target) {
        var resolved = resolvePointName(name, this._points);
        if (resolved.error) return resolved;
        var pt = { id: 'p' + Date.now(), name: resolved.name, target: target };
        this._points.push(pt);
        this._savePoints();
        return pt;
    };

    GoFaRobotNode.prototype.deletePoint = function(id) {
        this._points = this._points.filter(function(p) { return p.id !== id; });
        this._savePoints();
    };

    GoFaRobotNode.prototype.findPoint = function(nameOrId) {
        return this._points.find(function(p) {
            return p.id === nameOrId || p.name === nameOrId;
        }) || null;
    };

    // On-robot point storage — same shape/behavior as the local methods above,
    // but backed by a JSON file on the robot's own disk (RWS fileservice
    // GET/PUT) instead of points.json on the Node-RED host. Confirmed live:
    // GET on a missing file is a clean 404 (-> []); PUT requires
    // Content-Type: text/plain;v=2.0 (application/json is rejected, 415) and
    // fully overwrites (no append). No concurrent-write protection (unlike
    // local storage's mtime-drift check) — acceptable for a human-paced
    // "teach a point" workflow, not built.
    GoFaRobotNode.prototype.remoteGetPoints = function() {
        var node = this;
        return node.requestRaw('GET', '/fileservice/' + node.remotePointsPath, null, { accept: '*/*' })
            .then(function(res) {
                if (res.statusCode === 404) return [];
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    throw new Error('HTTP ' + res.statusCode + ' reading remote points file');
                }
                try { return JSON.parse(res.body.toString('utf8')) || []; }
                catch (e) { throw new Error('Remote points file is not valid JSON: ' + e.message); }
            });
    };

    GoFaRobotNode.prototype.remoteSavePoints = function(points) {
        return this.rwsPut('/fileservice/' + this.remotePointsPath, JSON.stringify(points, null, 2), 'text/plain;v=2.0');
    };

    GoFaRobotNode.prototype.remoteAddPoint = function(name, target) {
        var node = this;
        return node.remoteGetPoints().then(function(points) {
            var resolved = resolvePointName(name, points);
            if (resolved.error) return resolved;
            var pt = { id: 'p' + Date.now(), name: resolved.name, target: target };
            points.push(pt);
            return node.remoteSavePoints(points).then(function() { return pt; });
        });
    };

    GoFaRobotNode.prototype.remoteDeletePoint = function(idOrName) {
        var node = this;
        return node.remoteGetPoints().then(function(points) {
            var pt = points.find(function(p) { return p.id === idOrName || p.name === idOrName; }) || null;
            if (!pt) return null;
            var remaining = points.filter(function(p) { return p.id !== pt.id; });
            return node.remoteSavePoints(remaining).then(function() { return pt; });
        });
    };

    GoFaRobotNode.prototype.remoteFindPoint = function(nameOrId) {
        return this.remoteGetPoints().then(function(points) {
            return points.find(function(p) { return p.id === nameOrId || p.name === nameOrId; }) || null;
        });
    };

    GoFaRobotNode.prototype.rwsGet        = function(p)    { return this._client.rwsGet(p); };
    GoFaRobotNode.prototype.rwsPost       = function(p, b) { return this._client.rwsPost(p, b); };
    GoFaRobotNode.prototype.rwsPut        = function(p, b, contentType) { return this._client.rwsPut(p, b, contentType); };
    GoFaRobotNode.prototype.rwsPostHal    = function(p, b) { return this._client.rwsPostHal(p, b); };
    GoFaRobotNode.prototype.withMastership = function(fn)  { return this._client.withMastership(fn); };
    GoFaRobotNode.prototype.socketSend    = function(cmd)  { return this._client.socketSend(cmd); };
    GoFaRobotNode.prototype.requestRaw    = function(method, p, b, opts) { return this._client.requestRaw(method, p, b, opts); };
    GoFaRobotNode.prototype.getCookie     = function()     { return this._client.getCookie(); };

    GoFaRobotNode.prototype.parseXhtml = parseXhtml;
    GoFaRobotNode.prototype.gotoToken  = gotoToken;

    RED.httpAdmin.get('/gofa-robot/:id/points', RED.auth.needsPermission('gofa-robot.read'), function(req, res) {
        var node = RED.nodes.getNode(req.params.id);
        res.json(node ? node.getPoints() : []);
    });

    RED.httpAdmin.get('/gofa-robot/:id/remote-points', RED.auth.needsPermission('gofa-robot.read'), function(req, res) {
        var node = RED.nodes.getNode(req.params.id);
        if (!node) return res.json([]);
        node.remoteGetPoints().then(function(pts) { res.json(pts); }).catch(function() { res.json([]); });
    });

    RED.nodes.registerType('gofa-robot', GoFaRobotNode, {
        credentials: { password: { type: 'password' } }
    });
};

module.exports.parseXhtml          = parseXhtml;
module.exports.gotoToken           = gotoToken;
module.exports.resolveMoveType     = resolveMoveType;
module.exports.atomicWriteFileSync = atomicWriteFileSync;
module.exports.fileMtimeMs         = fileMtimeMs;
module.exports.createRobotClient   = createRobotClient;
