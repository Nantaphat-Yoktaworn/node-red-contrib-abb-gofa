'use strict';
var gate = require('./lib/gate');
const fs = require('fs');
var patchServerIp = require('./lib/patch-server-ip');

module.exports = function(RED) {
    function GoFaFileNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.action     = config.action     || 'download';
        this.localPath  = config.localPath  || '';
        this.remotePath = config.remotePath || '$HOME/Programs/MainModule.mod';
        this.encoding   = config.encoding   || 'utf8';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var action = node.action;
            if (msg.payload && typeof msg.payload === 'object' && msg.payload.action) {
                action = msg.payload.action;
            }

            var remotePath = node.remotePath;
            var localPath  = node.localPath;
            var encoding   = node.encoding;

            if (action === 'download' || action === 'delete') {
                if (msg.payload && typeof msg.payload === 'string') {
                    remotePath = msg.payload;
                } else if (msg.payload && typeof msg.payload === 'object') {
                    if (msg.payload.remotePath) remotePath = msg.payload.remotePath;
                    if (msg.payload.encoding)   encoding   = msg.payload.encoding;
                }
            } else if (action === 'upload') {
                if (msg.payload && typeof msg.payload === 'string' && msg.payload !== '') {
                    localPath = msg.payload;
                } else if (msg.payload && typeof msg.payload === 'object' && !Buffer.isBuffer(msg.payload)) {
                    if (msg.payload.localPath)  localPath  = msg.payload.localPath;
                    if (msg.payload.remotePath) remotePath = msg.payload.remotePath;
                }
            }

            var escapedPath = remotePath.split('/').map(encodeURIComponent).join('/').replace(/%24/g, '$');
            var r = node.robot;

            if (action === 'download') {
                node.status({ fill: 'blue', shape: 'dot', text: 'reading…' });
                r.requestRaw('GET', '/fileservice/' + escapedPath, null, { accept: '*/*' })
                .then(function(res) {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        throw new Error('HTTP ' + res.statusCode + ' ' + remotePath);
                    }
                    var content = encoding === 'base64'
                        ? res.body.toString('base64')
                        : res.body.toString('utf8');
                    msg.payload = {
                        ok: true,
                        remotePath: remotePath,
                        content: content,
                        bytes: res.body.length
                    };
                    node.status({ fill: 'green', shape: 'dot', text: res.body.length + ' bytes' });
                    send(msg); done();
                })
                .catch(function(err) {
                    msg.payload = { ok: false, error: err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err, msg);
                    send(msg); done(err);
                });
            } else if (action === 'upload') {
                var content;
                if (Buffer.isBuffer(msg.payload)) {
                    content = msg.payload;
                }

                if (!content) {
                    if (!localPath) {
                        msg.payload = { ok: false, error: 'No local file path configured — set it in node properties or pass via msg.payload' };
                        node.error('No local file path configured — set it in node properties or pass via msg.payload', msg);
                        node.status({ fill: 'red', shape: 'ring', text: 'no local path' });
                        send(msg); return done();
                    }
                    try {
                        content = fs.readFileSync(localPath);
                    } catch(e) {
                        msg.payload = { ok: false, error: 'Could not read file "' + localPath + '": ' + e.message };
                        node.error('Could not read file "' + localPath + '": ' + e.message, msg);
                        node.status({ fill: 'red', shape: 'ring', text: 'file read error' });
                        send(msg); return done(e);
                    }
                }

                var isBuffer = Buffer.isBuffer(content);
                var result = { text: content, injected: false };
                if (isBuffer) {
                    var canPatch = false;
                    const bufferModule = require('buffer');
                    if (typeof bufferModule.isUtf8 === 'function') {
                        canPatch = bufferModule.isUtf8(content);
                    } else {
                        try {
                            const { TextDecoder } = require('util');
                            new TextDecoder('utf-8', { fatal: true }).decode(content);
                            canPatch = true;
                        } catch (e) {
                            canPatch = false;
                        }
                    }

                    if (canPatch) {
                        var textResult = patchServerIp(content.toString('utf8'), r.ip);
                        content = Buffer.from(textResult.text, 'utf8');
                        result.injected = textResult.injected;
                    }
                } else {
                    var textResult = patchServerIp(String(content), r.ip);
                    content = textResult.text;
                    result.injected = textResult.injected;
                }

                var body = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
                var urlPath = '/fileservice/' + remotePath;

                node.status({ fill: 'blue', shape: 'dot', text: 'uploading…' });

                r.rwsPut(urlPath, body, 'text/plain;v=2.0')
                .then(function() {
                    msg.payload = { ok: true, remotePath: remotePath, bytes: body.length, serverIpInjected: result.injected };
                    node.status({ fill: 'green', shape: 'dot', text: 'uploaded ' + body.length + 'B' });
                    send(msg); done();
                })
                .catch(function(err) {
                    msg.payload = { ok: false, error: err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err, msg);
                    send(msg); done(err);
                });
            } else if (action === 'delete') {
                node.status({ fill: 'blue', shape: 'dot', text: 'deleting…' });
                r.requestRaw('DELETE', '/fileservice/' + escapedPath, null, {})
                .then(function(res) {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        msg.payload = { ok: true, remotePath: remotePath, deleted: true };
                        node.status({ fill: 'green', shape: 'dot', text: 'deleted' });
                        send(msg); done();
                    } else if (res.statusCode === 404) {
                        var errStr = 'File not found on controller: ' + remotePath;
                        msg.payload = { ok: false, error: errStr };
                        node.status({ fill: 'red', shape: 'ring', text: 'not found' });
                        node.error(errStr, msg);
                        send(msg); done(new Error(errStr));
                    } else {
                        throw new Error('HTTP ' + res.statusCode + ' ' + remotePath);
                    }
                })
                .catch(function(err) {
                    msg.payload = { ok: false, error: err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err, msg);
                    send(msg); done(err);
                });
            } else {
                msg.payload = { ok: false, error: 'Unknown action: ' + action };
                node.error('Unknown action: ' + action, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'unknown action' });
                send(msg); done();
            }
        });
    }
    RED.nodes.registerType('gofa-file', GoFaFileNode);
};
