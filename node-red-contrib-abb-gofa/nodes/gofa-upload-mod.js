'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');

module.exports = function(RED) {
    function GoFaUploadModNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.remotePath = config.remotePath || '$HOME/Programs/MainModule.mod';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var r = node.robot;
            var remotePath = node.remotePath;
            var content;

            // Resolve content and optional path override from msg.payload
            if (msg.payload && typeof msg.payload === 'object' && !Buffer.isBuffer(msg.payload)) {
                if (msg.payload.remotePath) remotePath = msg.payload.remotePath;
                content = msg.payload.content;
            } else {
                content = msg.payload;
            }

            // If content looks like a local file path, read it from disk
            if (typeof content === 'string' && (content.startsWith('/') || content.startsWith('./'))) {
                try {
                    content = fs.readFileSync(content);
                } catch(e) {
                    node.error('Could not read file: ' + e.message, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'file read error' });
                    return done(e);
                }
            }

            if (!content) {
                node.error('No file content in msg.payload', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no content' });
                return done();
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
                msg.payload = { ok: true, remotePath: remotePath, bytes: body.length };
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
