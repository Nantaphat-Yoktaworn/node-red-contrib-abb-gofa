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

// Build GOTO token — rounded to stay under RAPID's 80-char string limit; null on bad data
function gotoToken(t) {
    var vals = [t.x, t.y, t.z, t.q1, t.q2, t.q3, t.q4, t.cf1, t.cf4, t.cf6, t.cfx];
    if (vals.some(function(v) { return !isFinite(v); })) return null;
    function r(v, d) { return Number(v).toFixed(d); }
    return 'GOTO' + [
        r(t.x,1), r(t.y,1), r(t.z,1),
        r(t.q1,4), r(t.q2,4), r(t.q3,4), r(t.q4,4),
        Math.round(t.cf1), Math.round(t.cf4), Math.round(t.cf6), Math.round(t.cfx)
    ].join(';');
}

module.exports = function(RED) {
    function GoFaRobotNode(config) {
        RED.nodes.createNode(this, config);
        this.ip         = config.ip         || '192.168.20.15';
        this.rwsPort    = parseInt(config.rwsPort)    || 443;
        this.socketPort = parseInt(config.socketPort) || 1025;
        this.username   = config.username   || 'NNNN';
        this.password   = (this.credentials && this.credentials.password) || 'robotics';
        this.pointsFile = config.pointsFile || path.join(RED.settings.userDir || '.', 'points.json');

        this._cookie       = null;
        this._loginPromise = null;
        this._points       = [];
        this._seqStop      = false;
        this._seqRunning   = false;

        this._loadPoints();
        var node = this;
        node.on('close', function() { node._cookie = null; });
    }

    GoFaRobotNode.prototype._loadPoints = function() {
        try { this._points = JSON.parse(fs.readFileSync(this.pointsFile, 'utf8')); }
        catch(e) { this._points = []; }
    };

    GoFaRobotNode.prototype._savePoints = function() {
        try { fs.writeFileSync(this.pointsFile, JSON.stringify(this._points, null, 2)); }
        catch(e) { this.warn('points.json write failed: ' + e.message); }
    };

    GoFaRobotNode.prototype.getPoints  = function() { return this._points; };

    GoFaRobotNode.prototype.addPoint = function(name, target) {
        name = (name || '').trim();
        if (!name) {
            // find next unused "Point N"
            var n = 1;
            var names = this._points.map(function(p) { return p.name; });
            while (names.indexOf('Point ' + n) >= 0) n++;
            name = 'Point ' + n;
        } else if (this._points.some(function(p) { return p.name === name; })) {
            return { error: 'A point named "' + name + '" already exists' };
        }
        var pt = { id: 'p' + Date.now(), name: name, target: target };
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

    GoFaRobotNode.prototype._request = function(method, urlPath, body, forceAuth) {
        var node = this;
        return new Promise(function(resolve, reject) {
            var headers = { 'Accept': 'application/xhtml+xml;v=2.0' };
            if (forceAuth || !node._cookie) {
                headers['Authorization'] = 'Basic ' +
                    Buffer.from(node.username + ':' + node.password).toString('base64');
            } else {
                headers['Cookie'] = node._cookie;
            }
            if (method === 'POST' || method === 'PUT') {
                headers['Content-Type']   = 'application/x-www-form-urlencoded;v=2.0';
                headers['Content-Length'] = Buffer.byteLength(body || '');
            }
            var proto = node.rwsPort === 443 ? https : http;
            var req = proto.request({
                hostname: node.ip, port: node.rwsPort,
                path: urlPath, method: method,
                headers: headers, rejectUnauthorized: false
            }, function(res) {
                if (res.headers['set-cookie']) {
                    node._cookie = res.headers['set-cookie']
                        .map(function(c) { return c.split(';')[0]; }).join('; ');
                }
                var data = '';
                res.on('data', function(c) { data += c; });
                res.on('end', function() {
                    if (res.statusCode === 401 && !forceAuth) {
                        node._cookie = null;
                        node._request(method, urlPath, body, true).then(resolve).catch(reject);
                    } else if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error('HTTP ' + res.statusCode + ' ' + urlPath));
                    }
                });
            });
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    };

    GoFaRobotNode.prototype._getSession = function() {
        if (this._cookie) return Promise.resolve();
        if (!this._loginPromise) {
            var node = this;
            this._loginPromise = this._request('GET', '/rw/system', null, true)
                .then(function() { node._loginPromise = null; })
                .catch(function(e) { node._loginPromise = null; throw e; });
        }
        return this._loginPromise;
    };

    GoFaRobotNode.prototype.rwsGet = function(p) {
        var node = this;
        return this._getSession().then(function() { return node._request('GET', p, null, false); });
    };
    GoFaRobotNode.prototype.rwsPost = function(p, b) {
        var node = this;
        return this._getSession().then(function() { return node._request('POST', p, b, false); });
    };
    GoFaRobotNode.prototype.rwsPut = function(p, b) {
        var node = this;
        return this._getSession().then(function() { return node._request('PUT', p, b, false); });
    };
    GoFaRobotNode.prototype.withMastership = function(fn) {
        return this._withMastershipDomain('edit', fn);
    };
    GoFaRobotNode.prototype._withMastershipDomain = function(domain, fn) {
        var node = this;
        var req = '/rw/mastership/' + domain + '/request';
        var rel = '/rw/mastership/' + domain + '/release';
        return node._getSession()
            .then(function() { return node._request('POST', req, '', false); })
            .then(function() {
                return fn().then(
                    function(result) {
                        return node._request('POST', rel, '', false)
                            .then(function() { return result; });
                    },
                    function(err) {
                        return node._request('POST', rel, '', false)
                            .then(function() { throw err; }, function() { throw err; });
                    }
                );
            });
    };

    GoFaRobotNode.prototype.socketSend = function(cmd) {
        var node = this;
        return new Promise(function(resolve, reject) {
            var sock = new net.Socket();
            var buf = '', settled = false;
            function finish(err, val) {
                if (settled) return; settled = true;
                sock.destroy();
                err ? reject(err) : resolve(val);
            }
            sock.setTimeout(5000);
            sock.connect(node.socketPort, node.ip, function() { sock.write(cmd + '\n'); });
            sock.on('data', function(d) {
                buf += d.toString();
                if (buf.indexOf('\n') >= 0) finish(null, buf.trim());
            });
            sock.on('timeout', function() { finish(new Error('socket timeout')); });
            sock.on('error', finish);
            sock.on('close', function() { if (!settled) finish(new Error('socket closed')); });
        });
    };

    GoFaRobotNode.prototype.parseXhtml = parseXhtml;
    GoFaRobotNode.prototype.gotoToken  = gotoToken;

    RED.httpAdmin.get('/gofa-robot/:id/points', RED.auth.needsPermission('gofa-robot.read'), function(req, res) {
        var node = RED.nodes.getNode(req.params.id);
        res.json(node ? node.getPoints() : []);
    });

    RED.nodes.registerType('gofa-robot', GoFaRobotNode, {
        credentials: { password: { type: 'password' } }
    });
};

module.exports.parseXhtml = parseXhtml;
module.exports.gotoToken  = gotoToken;
