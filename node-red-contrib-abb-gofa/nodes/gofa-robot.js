'use strict';
const https = require('https');
const http  = require('http');
const net   = require('net');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

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

function gotoObj(t, moveType) {
    var vals = [t.x, t.y, t.z, t.q1, t.q2, t.q3, t.q4, t.cf1, t.cf4, t.cf6, t.cfx];
    if (vals.some(function(v) { return !isFinite(v); })) return null;
    function r(v, d) { return Number(Number(v).toFixed(d)); }
    var linear = (resolveMoveType(moveType, 'J') === 'L');
    return {
        cmd: linear ? 'gotol' : 'gotoj',
        val: [
            r(t.x,1), r(t.y,1), r(t.z,1),
            r(t.q1,4), r(t.q2,4), r(t.q3,4), r(t.q4,4),
            Math.round(t.cf1), Math.round(t.cf4), Math.round(t.cf6), Math.round(t.cfx)
        ]
    };
}

function scanIp(ip, port, timeout) {
    return new Promise(function(resolve) {
        var socket = new net.Socket();
        var status = false;
        socket.setTimeout(timeout);
        socket.connect(port, ip, function() {
            status = true;
            socket.destroy();
        });
        socket.on('error', function() { socket.destroy(); });
        socket.on('timeout', function() { socket.destroy(); });
        socket.on('close', function() { resolve({ ip: ip, open: status }); });
    });
}

function verifyIsABB(ip, port) {
    return new Promise(function(resolve) {
        var proto = port === 443 ? https : http;
        var req = proto.request({
            hostname: ip, port: port, path: '/rw/system', method: 'GET',
            rejectUnauthorized: false, timeout: 1000
        }, function(res) {
            var authHeader = res.headers['www-authenticate'] || '';
            var isABB = authHeader.toLowerCase().indexOf('abb') >= 0 || authHeader.toLowerCase().indexOf('robot') >= 0;
            // Deliberately NOT falling back to "any bare 200/401 counts" — that
            // false-positives on ordinary LAN devices (SPA-routed admin UIs return
            // 200 for any path; anything behind Basic/Digest auth returns 401 for
            // any path). Require the ABB-specific WWW-Authenticate realm instead.
            resolve(isABB);
        });
        req.on('error', function() { resolve(false); });
        req.on('timeout', function() { req.destroy(); resolve(false); });
        req.end();
    });
}

function discover(opts) {
    opts = opts || {};
    var rwsPort = parseInt(opts.rwsPort) || 443;
    var timeout = parseInt(opts.timeout) || 250;
    
    var subnets = [];
    var interfaces = os.networkInterfaces();
    for (var name of Object.keys(interfaces)) {
        for (var info of interfaces[name]) {
            if (info.family === 'IPv4' && (!info.internal || opts.includeInternal)) {
                var parts = info.address.split('.');
                if (parts.length === 4) {
                    subnets.push(parts.slice(0, 3).join('.'));
                }
            }
        }
    }
    
    subnets = subnets.filter(function(item, pos, self) {
        return self.indexOf(item) === pos;
    });
    
    if (subnets.length === 0) {
        return Promise.resolve([]);
    }
    
    var scanPromises = [];
    subnets.forEach(function(base) {
        for (var i = 1; i <= 254; i++) {
            var ip = base + '.' + i;
            scanPromises.push(scanIp(ip, rwsPort, timeout));
        }
    });
    
    return Promise.all(scanPromises).then(function(results) {
        var openIps = results.filter(function(r) { return r.open; }).map(function(r) { return r.ip; });
        if (openIps.length === 0) return [];
        
        var verifyPromises = openIps.map(function(ip) {
            return verifyIsABB(ip, rwsPort).then(function(isABB) {
                return { ip: ip, isABB: isABB };
            });
        });
        
        return Promise.all(verifyPromises).then(function(verifyResults) {
            return verifyResults.filter(function(r) { return r.isABB; }).map(function(r) { return r.ip; });
        });
    });
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
    // Location), or a binary-safe body (gofa-file downloading non-UTF8
    // files) — resolves the raw {statusCode, headers, body: Buffer} instead of
    // just a decoded string. Exists so node files stop hand-rolling their own
    // https/http request against private fields (ip/cookie/etc) — that
    // duplication is exactly what broke the old gofa-upload-mod (now gofa-file upload) when session state
    // moved into this closure: three more node files (subscribe-io,
    // subscribe-state, file-read) had the same private-field reach-in and the
    // same latent bug.
    //
    // Retries once with forced Basic-auth on a 401, same policy as request()
    // above — a stale in-memory cookie (e.g. a subscribe node's first call in a
    // while, after the RWS session expired server-side) used to hard-fail here
    // instead of transparently re-authenticating like every rwsGet/rwsPost-based
    // node already does.
    function requestRawOnce(method, urlPath, body, opts, forceAuth) {
        return new Promise(function(resolve, reject) {
            var headers = { 'Accept': opts.accept || 'application/xhtml+xml;v=2.0' };
            if (forceAuth || !cookie) headers['Authorization'] = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
            else headers['Cookie'] = cookie;
            if (opts.contentType) headers['Content-Type'] = opts.contentType;
            if (body) headers['Content-Length'] = Buffer.byteLength(body);
            var proto = rwsPort === 443 ? https : http;
            var req = proto.request({
                hostname: ip, port: rwsPort, path: urlPath, method: method,
                headers: headers, rejectUnauthorized: false
            }, function(res) {
                // Capture the cookie that belongs to THIS specific response synchronously,
                // in this same callback — not via a later separate getCookie() call. The
                // shared `cookie` variable can be overwritten by another concurrent request's
                // response in between (OmniCore reissues Set-Cookie on many responses, and
                // node-red flows commonly have several nodes sharing one gofa-robot config
                // node firing requests around the same time — confirmed live: two
                // gofa-subscribe-io nodes starting concurrently raced on exactly this,
                // causing whichever one's WS-connect ran after the other's cookie overwrite
                // to fail its upgrade with "held by someone else"-style session mismatch).
                // A same-callback read is immune to that, since Node never interleaves two
                // response callbacks mid-execution.
                var thisCookie = cookie;
                if (res.headers['set-cookie']) {
                    thisCookie = res.headers['set-cookie'].map(function(c) { return c.split(';')[0]; }).join('; ');
                    cookie = thisCookie;
                }
                var chunks = [];
                res.on('data', function(c) { chunks.push(c); });
                res.on('end', function() {
                    if (res.statusCode === 401 && !forceAuth) {
                        cookie = null;
                        requestRawOnce(method, urlPath, body, opts, true).then(resolve).catch(reject);
                        return;
                    }
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), cookie: thisCookie });
                });
            });
            req.on('error', reject);
            req.setTimeout(opts.timeout || 8000, function() { req.destroy(new Error('RWS request timeout: ' + urlPath)); });
            if (body) req.write(body);
            req.end();
        });
    }
    function requestRaw(method, urlPath, body, opts) {
        opts = opts || {};
        return getSession().then(function() {
            return requestRawOnce(method, urlPath, body, opts, false);
        });
    }
    function getCookie() { return getSession().then(function() { return cookie; }); }
    // Best-effort session teardown for node 'close' (redeploy/stop/restart). Never
    // throws and never re-authenticates on failure — the controller only allows 19
    // concurrent sessions once any WebSocket subscription is active (see abb-rws
    // skill), and this client never logged out anywhere before, so every redeploy
    // left its old session to rot until the controller's own 5-minute inactivity
    // timeout. Enough leaked sessions from repeated redeploys can exhaust that pool
    // and lock FlexPendant out with "too many device login".
    function logout() {
        if (!cookie) return Promise.resolve();
        var savedCookie = cookie;
        cookie = null;
        return new Promise(function(resolve) {
            var proto = rwsPort === 443 ? https : http;
            var req = proto.request({
                hostname: ip, port: rwsPort, path: '/logout', method: 'GET',
                headers: { 'Cookie': savedCookie, 'Accept': 'application/xhtml+xml;v=2.0' },
                rejectUnauthorized: false
            }, function(res) { res.resume(); res.on('end', resolve); });
            req.on('error', function() { resolve(); });
            req.setTimeout(3000, function() { req.destroy(); resolve(); });
            req.end();
        });
    }
function translateToJSON(cmd) {
        if (typeof cmd === 'object' && cmd !== null) return JSON.stringify(cmd);
        if (typeof cmd !== 'string') return cmd;
        var trimmed = cmd.trim();
        if (trimmed.indexOf('{') === 0) return trimmed; // already JSON
        
        if (trimmed === 'PING')     return JSON.stringify({ cmd: 'ping' });
        if (trimmed === 'HOME')     return JSON.stringify({ cmd: 'home' });
        if (trimmed === 'SETHOME')  return JSON.stringify({ cmd: 'sethome' });
        if (trimmed === 'STOP')     return JSON.stringify({ cmd: 'stop' });
        if (trimmed === 'RESETLED') return JSON.stringify({ cmd: 'resetled' });
        if (trimmed === 'EGMJOINT') return JSON.stringify({ cmd: 'egmjoint' });
        
        if (trimmed.indexOf('SPEED') === 0) {
            var spd = parseInt(trimmed.substring(5));
            return JSON.stringify({ cmd: 'speed', val: spd });
        }
        
        if (trimmed.indexOf('ZONE') === 0) {
            var zone = trimmed.substring(4);
            return JSON.stringify({ cmd: 'zone', val: zone });
        }
        
        var gotoMatch = trimmed.match(/^(GOTOJ|GOTOL|GOTO)(.+)$/);
        if (gotoMatch) {
            var type = gotoMatch[1].toLowerCase();
            if (type === 'goto') type = 'gotoj';
            var vals = gotoMatch[2].split(';').map(Number);
            return JSON.stringify({ cmd: type, val: vals });
        }
        
        if (trimmed.indexOf('MOVEJ') === 0 || trimmed.indexOf('MOVEL') === 0) {
            var vals = trimmed.substring(5).split(';').map(Number);
            return JSON.stringify({ cmd: trimmed.substring(0, 5).toLowerCase(), val: vals });
        }
        
        var jogMatch = trimmed.match(/^(R?)([XYZ])([+-])(\d+(\.\d+)?)$/);
        if (jogMatch) {
            var rot = jogMatch[1] === 'R';
            var axis = jogMatch[2];
            var sgn = jogMatch[3];
            var val = Number(jogMatch[4]);
            return JSON.stringify({ cmd: 'jog', axis: axis, sgn: sgn, val: val, rot: rot });
        }
        
        var jointJogMatch = trimmed.match(/^J([1-6])([+-])(\d+(\.\d+)?)$/);
        if (jointJogMatch) {
            var joint = parseInt(jointJogMatch[1]);
            var sgn = jointJogMatch[2];
            var val = Number(jointJogMatch[3]);
            return JSON.stringify({ cmd: 'jointjog', joint: joint, sgn: sgn, val: val });
        }
        
        if (trimmed.indexOf('SETLED:') === 0) {
            var vals = trimmed.substring(7).split(';').map(Number);
            return JSON.stringify({ cmd: 'setled', val: vals });
        }
        
        if (trimmed.indexOf('SETDO:') === 0) {
            var parts = trimmed.substring(6).split(':');
            var name = parts[0];
            var val = parseInt(parts[1]);
            return JSON.stringify({ cmd: 'setdo', name: name, val: val });
        }
        
        if (trimmed.indexOf('GETVAR:') === 0) {
            var name = trimmed.substring(7);
            return JSON.stringify({ cmd: 'getvar', name: name });
        }
        
        if (trimmed.indexOf('SETVAR:') === 0) {
            var parts = trimmed.substring(7).split(':');
            var name = parts[0];
            var valstr = parts.slice(1).join(':');
            var val = Number(valstr);
            if (isNaN(val)) val = valstr;
            return JSON.stringify({ cmd: 'setvar', name: name, val: val });
        }

        return trimmed;
    }

    function socketSend(cmd, port) {
        return new Promise(function(resolve, reject) {
            var sock = new net.Socket();
            var buf = '', settled = false;
            function finish(err, val) {
                if (settled) return; settled = true;
                sock.destroy();
                err ? reject(err) : resolve(val);
            }
            var jsonCmd = translateToJSON(cmd);
            sock.setTimeout(5000);
            sock.connect(port || socketPort, ip, function() { sock.write(jsonCmd + '\n'); });
            sock.on('data', function(d) {
                buf += d.toString();
                if (buf.indexOf('\n') >= 0) {
                    var rawResp = buf.trim();
                    if (rawResp.indexOf('{') === 0) {
                        try {
                            var json = JSON.parse(rawResp);
                            if (json.status === 'ok') {
                                if (json.cmd === 'getvar') {
                                    finish(null, 'VAL:' + json.val);
                                } else if (json.cmd === 'ping') {
                                    finish(null, 'OK:PING');
                                } else if (json.cmd === 'stop') {
                                    finish(null, 'OK:STOP');
                                } else if (json.cmd === 'resetled') {
                                    finish(null, 'OK:RESETLED');
                                } else if (json.cmd === 'gotoj' || json.cmd === 'gotol') {
                                    finish(null, 'OK:GOTO');
                                } else if (json.cmd === 'movej') {
                                    finish(null, 'OK:MOVEJ');
                                } else if (json.cmd === 'zone') {
                                    finish(null, 'OK:ZONE' + (json.val !== undefined ? json.val : ''));
                                } else if (json.cmd === 'setvar') {
                                    finish(null, 'OK:SETVAR');
                                } else if (json.cmd === 'setdo') {
                                    finish(null, 'OK:SETDO');
                                } else if (json.cmd === 'setled') {
                                    finish(null, 'OK:SETLED');
                                } else if (json.cmd === 'jog') {
                                    finish(null, 'OK:JOG');
                                } else if (json.cmd === 'jointjog') {
                                    finish(null, 'OK:JOINTJOG');
                                } else if (json.cmd === 'egmjoint') {
                                    finish(null, 'OK:EGMJOINT');
                                } else {
                                    finish(null, 'OK:' + json.cmd.toUpperCase());
                                }
                            } else {
                                finish(null, 'ERR:' + (json.cmd || 'UNKNOWN').toUpperCase());
                            }
                        } catch (e) {
                            finish(new Error('failed to parse json response: ' + rawResp));
                        }
                    } else {
                        finish(null, rawResp);
                    }
                }
            });
            sock.on('timeout', function() { finish(new Error('socket timeout')); });
            sock.on('error', finish);
            sock.on('close', function() { if (!settled) finish(new Error('socket closed')); });
        });
    }

    return {
        rwsGet: rwsGet, rwsPost: rwsPost, rwsPut: rwsPut, rwsPostHal: rwsPostHal,
        withMastership: withMastership, socketSend: socketSend,
        requestRaw: requestRaw, getCookie: getCookie, logout: logout
    };
}

module.exports = function(RED) {
    function GoFaRobotNode(config) {
        RED.nodes.createNode(this, config);
        this.ip         = config.ip         || '192.168.20.33';
        this.rwsPort    = parseInt(config.rwsPort)    || 443;
        this.socketPort = parseInt(config.socketPort) || 1025;
        this.ledPort    = parseInt(config.ledPort)    || 1026;
        this.username   = config.username   || 'Default User';
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
        this._egmActive    = false;
        this._egmTarget    = null;
        this._egmBaseline  = null;
        this._egmSocket    = null;

        this._loadPoints();

        var node = this;
        this.on('close', function(done) {
            node.logout().then(function() { done(); });
        });
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

    GoFaRobotNode.prototype.replacePoints = function(arr) {
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
        var result = [];
        for (var i = 0; i < arr.length; i++) {
            var item = arr[i];
            var pt = {
                id: item.id || ('p' + baseTime + '-' + i),
                name: item.name.trim(),
                target: item.target
            };
            result.push(pt);
        }

        this._points = result;
        this._savePoints();
        return result;
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

    // Re-fetches the remote points file right before an overwrite and warns if it
    // changed since `originalPoints` was read — same best-effort drift detection as
    // local _savePoints()'s mtime check above, adapted for the on-robot file (which
    // has no filesystem mtime to compare against, just the file's own content).
    // Doesn't fully close the race (a write could still land in the gap between this
    // check and the PUT below), but turns a previously-silent overwrite into at least
    // a visible warning, matching what the local path already does.
    function warnIfRemoteChanged(node, originalPoints) {
        var before = JSON.stringify(originalPoints);
        return node.remoteGetPoints().then(function(current) {
            if (JSON.stringify(current) !== before) {
                node.warn('Remote points file (' + node.remotePointsPath + ') changed since it was ' +
                          'last read (another flow or write in progress?) — this save will overwrite those changes');
            }
        });
    }

    GoFaRobotNode.prototype.remoteAddPoint = function(name, target) {
        var node = this;
        return node.remoteGetPoints().then(function(points) {
            var resolved = resolvePointName(name, points);
            if (resolved.error) return resolved;
            var pt = { id: 'p' + Date.now(), name: resolved.name, target: target };
            var updated = points.concat([pt]);
            return warnIfRemoteChanged(node, points).then(function() {
                return node.remoteSavePoints(updated).then(function() { return pt; });
            });
        });
    };

    GoFaRobotNode.prototype.remoteDeletePoint = function(idOrName) {
        var node = this;
        return node.remoteGetPoints().then(function(points) {
            var pt = points.find(function(p) { return p.id === idOrName || p.name === idOrName; }) || null;
            if (!pt) return null;
            var remaining = points.filter(function(p) { return p.id !== pt.id; });
            return warnIfRemoteChanged(node, points).then(function() {
                return node.remoteSavePoints(remaining).then(function() { return pt; });
            });
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
    GoFaRobotNode.prototype.socketSend    = function(cmd, port) { return this._client.socketSend(cmd, port); };
    GoFaRobotNode.prototype.requestRaw    = function(method, p, b, opts) { return this._client.requestRaw(method, p, b, opts); };
    GoFaRobotNode.prototype.getCookie     = function()     { return this._client.getCookie(); };
    GoFaRobotNode.prototype.logout        = function()     { return this._client.logout(); };

    GoFaRobotNode.prototype.parseXhtml = parseXhtml;
    GoFaRobotNode.prototype.gotoToken  = gotoToken;
    GoFaRobotNode.prototype.gotoObj    = gotoObj;

    RED.httpAdmin.get('/gofa-robot/:id/points', RED.auth.needsPermission('gofa-robot.read'), function(req, res) {
        var node = RED.nodes.getNode(req.params.id);
        res.json(node ? node.getPoints() : []);
    });

    RED.httpAdmin.get('/gofa-robot/:id/remote-points', RED.auth.needsPermission('gofa-robot.read'), function(req, res) {
        var node = RED.nodes.getNode(req.params.id);
        if (!node) return res.json([]);
        node.remoteGetPoints().then(function(pts) { res.json(pts); }).catch(function() { res.json([]); });
    });

    RED.httpAdmin.get('/gofa-robot/discover', RED.auth.needsPermission('gofa-robot.read'), function(req, res) {
        var rwsPort = parseInt(req.query.rwsPort) || 443;
        discover({ rwsPort: rwsPort })
            .then(function(ips) { res.json(ips); })
            .catch(function() { res.json([]); });
    });

    RED.nodes.registerType('gofa-robot', GoFaRobotNode, {
        credentials: { password: { type: 'password' } }
    });
};

module.exports.parseXhtml          = parseXhtml;
module.exports.gotoToken           = gotoToken;
module.exports.gotoObj             = gotoObj;
module.exports.resolveMoveType     = resolveMoveType;
module.exports.atomicWriteFileSync = atomicWriteFileSync;
module.exports.fileMtimeMs         = fileMtimeMs;
module.exports.createRobotClient   = createRobotClient;
module.exports.discover            = discover;
