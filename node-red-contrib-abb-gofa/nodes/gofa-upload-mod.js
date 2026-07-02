'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');

// Rewrite MainModule.mod's SERVER_IP constant to match the robot config
// node's IP, so it can't drift out of sync with what Node-RED actually
// connects to. No-ops (injected: false) if the constant isn't present.
function patchServerIp(text, ip) {
    var injected = false;
    var patched = text.replace(/(CONST\s+string\s+SERVER_IP\s*:=\s*")[^"]*(")/i, function(m, p1, p2) {
        injected = true;
        return p1 + ip + p2;
    });
    return { text: patched, injected: injected };
}

module.exports = function(RED) {
    function GoFaUploadModNode(config) {
        RED.nodes.createNode(this, config);
        this.robot          = RED.nodes.getNode(config.robot);
        this.localPath      = config.localPath  || '';
        this.remotePath     = config.remotePath || '$HOME/Programs/MainModule.mod';
        this.injectServerIp = config.injectServerIp !== false;
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var r          = node.robot;
            var localPath  = node.localPath;
            var remotePath = node.remotePath;
            var content;

            // msg.payload overrides
            if (Buffer.isBuffer(msg.payload)) {
                content = msg.payload;
            } else if (msg.payload && typeof msg.payload === 'object') {
                if (msg.payload.localPath)  localPath  = msg.payload.localPath;
                if (msg.payload.remotePath) remotePath = msg.payload.remotePath;
            } else if (typeof msg.payload === 'string' && msg.payload !== '') {
                localPath = msg.payload;
            }

            // Read from disk if we have a path but no content yet
            if (!content) {
                if (!localPath) {
                    node.error('No local file path configured — set it in node properties or pass via msg.payload', msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'no local path' });
                    return done();
                }
                try {
                    content = fs.readFileSync(localPath);
                } catch(e) {
                    node.error('Could not read file "' + localPath + '": ' + e.message, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'file read error' });
                    return done(e);
                }
            }

            var serverIpInjected = false;
            if (node.injectServerIp) {
                var isBuffer = Buffer.isBuffer(content);
                var result = patchServerIp(isBuffer ? content.toString('utf8') : String(content), r.ip);
                content = isBuffer ? Buffer.from(result.text, 'utf8') : result.text;
                serverIpInjected = result.injected;
            }

            var body   = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
            var urlPath = '/fileservice/' + remotePath;

            node.status({ fill: 'blue', shape: 'dot', text: 'uploading…' });

            r._getSession().then(function() {
                return new Promise(function(resolve, reject) {
                    var headers = {
                        'Content-Type':   'text/plain;v=2.0',
                        'Content-Length': body.length
                    };
                    if (r._cookie) {
                        headers['Cookie'] = r._cookie;
                    } else {
                        headers['Authorization'] = 'Basic ' +
                            Buffer.from(r.username + ':' + r.password).toString('base64');
                    }

                    var proto = r.rwsPort === 443 ? https : http;
                    var req = proto.request({
                        hostname: r.ip, port: r.rwsPort,
                        path: urlPath, method: 'PUT',
                        headers: headers, rejectUnauthorized: false
                    }, function(res) {
                        if (res.headers['set-cookie']) {
                            r._cookie = res.headers['set-cookie']
                                .map(function(c) { return c.split(';')[0]; }).join('; ');
                        }
                        var data = '';
                        res.on('data', function(c) { data += c; });
                        res.on('end', function() {
                            if (res.statusCode === 401) {
                                r._cookie = null;
                                reject(new Error('HTTP 401 — auth failed'));
                            } else if (res.statusCode >= 200 && res.statusCode < 300) {
                                resolve(data);
                            } else {
                                reject(new Error('HTTP ' + res.statusCode + ' ' + urlPath + (data ? ': ' + data : '')));
                            }
                        });
                    });
                    req.on('error', reject);
                    req.write(body);
                    req.end();
                });
            })
            .then(function() {
                msg.payload = { ok: true, remotePath: remotePath, bytes: body.length, serverIpInjected: serverIpInjected };
                node.status({ fill: 'green', shape: 'dot', text: 'uploaded ' + body.length + 'B' });
                send(msg); done();
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-upload-mod', GoFaUploadModNode);
};

module.exports.patchServerIp = patchServerIp;
