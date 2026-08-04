'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
const fs = require('fs');
var patchServerIp = require('./lib/patch-server-ip');
var escapeFileservicePath = require('./gofa-robot').escapeFileservicePath;

// C1 (2026-08-04): the three fileservice actions, implemented once and shared by
// the runtime node and the editor-panel route. These were two near-identical
// copies — and that is exactly how bug 3 survived: the "use escapedPath" fix was
// needed in BOTH upload branches, and the raw-path version threw client-side
// ("Request path contains unescaped characters") for any path with a space.
//
// Each resolves a plain result object, or rejects. A rejection carrying
// .localReadFailed marks a bad local file (client error, 400) rather than a
// controller/transport failure (502).

function localReadError(message) {
    var err = new Error(message);
    err.localReadFailed = true;
    return err;
}

// Applies the SERVER_IP rewrite when asked, on text content only. A binary file
// is left untouched (patching it would corrupt it), which is why the UTF-8 check
// is here rather than a blind toString().
function maybePatchServerIp(content, ip, enabled) {
    var out = { content: content, injected: false };
    if (!enabled) return out;
    if (Buffer.isBuffer(content)) {
        var canPatch = false;
        var bufferModule = require('buffer');
        if (typeof bufferModule.isUtf8 === 'function') {
            canPatch = bufferModule.isUtf8(content);
        } else {
            try {
                var TextDecoder = require('util').TextDecoder;
                new TextDecoder('utf-8', { fatal: true }).decode(content);
                canPatch = true;
            } catch (e) { canPatch = false; }
        }
        if (canPatch) {
            var t = patchServerIp(content.toString('utf8'), ip);
            out.content = Buffer.from(t.text, 'utf8');
            out.injected = t.injected;
        }
        return out;
    }
    var r = patchServerIp(String(content), ip);
    out.content = r.text;
    out.injected = r.injected;
    return out;
}

function fileDownload(robot, opts) {
    var remotePath = opts.remotePath;
    var encoding   = opts.encoding || 'utf8';
    var localPath  = opts.localPath || '';
    return robot.requestRaw('GET', '/fileservice/' + escapeFileservicePath(remotePath), null, { accept: '*/*' })
    .then(function(res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error('HTTP ' + res.statusCode + ' ' + remotePath);
        }
        var content = encoding === 'base64' ? res.body.toString('base64') : res.body.toString('utf8');
        // D3: async write — a sync one blocks Node-RED's whole event loop, and a
        // controller file can be large or the destination a slow/remote mount.
        return Promise.resolve(localPath
            ? fs.promises.writeFile(localPath, res.body).catch(function(e) {
                throw new Error('Failed to save file locally at ' + localPath + ': ' + e.message);
              })
            : null
        ).then(function() {
            return { ok: true, remotePath: remotePath, localPath: localPath || null,
                     content: content, bytes: res.body.length };
        });
    });
}

function fileUpload(robot, opts) {
    var remotePath = opts.remotePath;
    // Either explicit content (a Buffer straight off msg.payload) or a local file.
    var source = Buffer.isBuffer(opts.content)
        ? Promise.resolve(opts.content)
        : fs.promises.readFile(opts.localPath).catch(function(e) {
            throw localReadError('Could not read file "' + opts.localPath + '": ' + e.message);
          });
    return source.then(function(content) {
        var patched = maybePatchServerIp(content, robot.ip, opts.autoChangeIp);
        var body = Buffer.isBuffer(patched.content) ? patched.content : Buffer.from(String(patched.content));
        // escapedPath, not the raw remotePath — see the header comment (bug 3).
        return robot.rwsPut('/fileservice/' + escapeFileservicePath(remotePath), body, 'text/plain;v=2.0')
        .then(function() {
            return { ok: true, remotePath: remotePath, bytes: body.length, serverIpInjected: patched.injected };
        });
    });
}

function fileDelete(robot, opts) {
    var remotePath = opts.remotePath;
    return robot.requestRaw('DELETE', '/fileservice/' + escapeFileservicePath(remotePath), null, {})
    .then(function(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            return { ok: true, remotePath: remotePath, deleted: true };
        }
        if (res.statusCode === 404) {
            var e = new Error('File not found on controller: ' + remotePath);
            e.notFound = true;
            throw e;
        }
        throw new Error('HTTP ' + res.statusCode + ' ' + remotePath);
    });
}

module.exports = function(RED) {
    function GoFaFileNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.action     = config.action     || 'download';
        this.localPath  = config.localPath  || '';
        this.remotePath = config.remotePath || '$HOME/Programs/MainModule.mod';
        this.encoding   = config.encoding   || 'utf8';
        this.autoChangeIp = config.autoChangeIp === true;
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var p = msg.payload;
            var action = (p && typeof p === 'object' && p.action) ? p.action : node.action;
            var remotePath = node.remotePath;
            var localPath  = node.localPath;
            var encoding   = node.encoding;

            if (action === 'download' || action === 'delete') {
                if (p && typeof p === 'string') {
                    remotePath = p;
                } else if (p && typeof p === 'object') {
                    if (p.remotePath) remotePath = p.remotePath;
                    if (p.encoding)   encoding   = p.encoding;
                    if (p.localPath)  localPath  = p.localPath;
                }
            } else if (action === 'upload') {
                if (p && typeof p === 'string' && p !== '') {
                    localPath = p;
                } else if (p && typeof p === 'object' && !Buffer.isBuffer(p)) {
                    if (p.localPath)  localPath  = p.localPath;
                    if (p.remotePath) remotePath = p.remotePath;
                }
            }

            function fail(err, statusText) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: statusText || 'error' });
                node.error(err.message, msg);
                send(msg); done(err);
            }

            if (action === 'download') {
                node.status({ fill: 'blue', shape: 'dot', text: 'reading…' });
                fileDownload(node.robot, { remotePath: remotePath, encoding: encoding, localPath: localPath })
                .then(function(out) {
                    msg.payload = out;
                    node.status({ fill: 'green', shape: 'dot', text: out.bytes + ' bytes' + (out.localPath ? ' saved' : '') });
                    send(msg); done();
                }).catch(function(err) { fail(err); });

            } else if (action === 'upload') {
                if (!Buffer.isBuffer(p) && !localPath) {
                    var m = 'No local file path configured — set it in node properties or pass via msg.payload';
                    msg.payload = { ok: false, error: m };
                    node.error(m, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'no local path' });
                    send(msg); return done();
                }
                node.status({ fill: 'blue', shape: 'dot', text: 'uploading…' });
                fileUpload(node.robot, {
                    remotePath: remotePath,
                    content: Buffer.isBuffer(p) ? p : null,
                    localPath: localPath,
                    autoChangeIp: node.autoChangeIp
                }).then(function(out) {
                    msg.payload = out;
                    node.status({ fill: 'green', shape: 'dot', text: 'uploaded ' + out.bytes + 'B' });
                    send(msg); done();
                }).catch(function(err) { fail(err, err.localReadFailed ? 'file read error' : 'error'); });

            } else if (action === 'delete') {
                node.status({ fill: 'blue', shape: 'dot', text: 'deleting…' });
                fileDelete(node.robot, { remotePath: remotePath })
                .then(function(out) {
                    msg.payload = out;
                    node.status({ fill: 'green', shape: 'dot', text: 'deleted' });
                    send(msg); done();
                }).catch(function(err) { fail(err, err.notFound ? 'not found' : 'error'); });

            } else {
                var e = 'Unknown action: ' + action;
                msg.payload = { ok: false, error: e };
                node.error(e, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'unknown action' });
                send(msg); done();
            }
        });
    }
    RED.nodes.registerType('gofa-file', GoFaFileNode);

    RED.httpAdmin.post('/gofa-file/:id/test', requireAdminAuth(RED, 'gofa-file.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.requestRaw !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var action     = req.body.action || 'download';
        var remotePath = req.body.remotePath || '';
        var localPath  = req.body.localPath || '';
        if (!remotePath) {
            return res.status(400).json({ error: 'Remote path is required' });
        }

        function fail(err) {
            // Unreadable local file is a client error; anything else is a transport failure.
            var code = err.localReadFailed ? 400 : (err.notFound ? 404 : 502);
            res.status(code).json({ error: err.message });
        }

        if (action === 'download') {
            fileDownload(robot, { remotePath: remotePath, encoding: req.body.encoding || 'utf8', localPath: localPath })
            .then(function(out) {
                // Editor preview only needs the first KB, not the whole file.
                res.json({ ok: true, remotePath: out.remotePath, localPath: out.localPath,
                           bytes: out.bytes, preview: out.content.slice(0, 1000) });
            }).catch(fail);
        } else if (action === 'upload') {
            if (!localPath) {
                return res.status(400).json({ error: 'Local path is required for upload test' });
            }
            fileUpload(robot, { remotePath: remotePath, localPath: localPath,
                                autoChangeIp: req.body.autoChangeIp === true })
            .then(function(out) { res.json(out); }).catch(fail);
        } else if (action === 'delete') {
            fileDelete(robot, { remotePath: remotePath })
            .then(function(out) { res.json(out); }).catch(fail);
        } else {
            res.status(400).json({ error: 'Unknown action: ' + action });
        }
    });
};

module.exports.fileDownload = fileDownload;
module.exports.fileUpload   = fileUpload;
module.exports.fileDelete   = fileDelete;
