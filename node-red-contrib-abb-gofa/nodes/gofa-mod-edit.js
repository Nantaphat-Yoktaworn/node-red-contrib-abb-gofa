'use strict';
var gate = require('./lib/gate');
var patchServerIp = require('./lib/patch-server-ip');

// RWS fileservice directory-listing parser. NOT verified against a live
// controller (none was reachable when this node was written — see the
// socket-server-stuck open bug). Per the RWS docs the listing is one
// <li class="fs-file"> / <li class="fs-dir"> per entry, with the name in the
// li's title attribute, an fs-name span, or the anchor text — try all three,
// most specific first. If the body has no fs-file classes at all (unknown
// listing shape), fall back to bare <a href> basenames, which may include
// directories since nothing distinguishes them there.
function parseFileList(body) {
    var files = [];
    var m, t, name;
    var liRe = /<li class="fs-file[^"]*"([^>]*)>([\s\S]*?)<\/li>/g;
    while ((m = liRe.exec(body)) !== null) {
        name = null;
        t = /title="([^"]+)"/.exec(m[1]);
        if (t) name = t[1].trim();
        if (!name) { t = /class="fs-name"[^>]*>([^<]+)</.exec(m[2]); if (t) name = t[1].trim(); }
        if (!name) { t = /<a[^>]*>([^<]+)<\/a>/.exec(m[2]); if (t) name = t[1].trim(); }
        if (!name) { t = /<a[^>]*href="([^"]+)"/.exec(m[2]); if (t) name = decodeURIComponent(t[1].replace(/\/+$/, '').split('/').pop()); }
        if (name && files.indexOf(name) < 0) files.push(name);
    }
    if (files.length === 0 && body.indexOf('fs-file') < 0) {
        var aRe = /<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g;
        while ((m = aRe.exec(body)) !== null) {
            name = (m[2] || '').trim() || decodeURIComponent(m[1].replace(/\/+$/, '').split('/').pop());
            if (name && name !== '.' && name !== '..' && files.indexOf(name) < 0) files.push(name);
        }
    }
    return files;
}

// Reads a JSON request body without body-parser (not a dependency, and
// RED.httpAdmin isn't guaranteed to have JSON middleware mounted). If some
// middleware already parsed it, use that.
function readJsonBody(req) {
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
        return Promise.resolve(req.body);
    }
    return new Promise(function(resolve, reject) {
        var data = '';
        req.on('data', function(c) { data += c; });
        req.on('end', function() {
            try { resolve(JSON.parse(data || '{}')); }
            catch (e) { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

module.exports = function(RED) {
    function GoFaModEditNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.remotePath   = config.remotePath || '';
        this.content      = config.content || '';
        this.autoChangeIp = config.autoChangeIp !== false;
        var node = this;

        // Runtime input re-uploads the content stored in the node config to
        // remotePath — the actual editing/saving happens in the edit dialog
        // via the admin endpoints below.
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            if (!node.remotePath) {
                msg.payload = { ok: false, error: 'No remote path configured — pick or name a file in the node properties' };
                node.error(msg.payload.error, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no remote path' });
                send(msg); return done();
            }
            if (!node.content) {
                msg.payload = { ok: false, error: 'No content — write or load the file in the node properties first' };
                node.error(msg.payload.error, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no content' });
                send(msg); return done();
            }

            var r = node.robot;
            var contentToUpload = String(node.content);
            var serverIpInjected = false;
            if (node.autoChangeIp) {
                var result = patchServerIp(contentToUpload, r.ip);
                contentToUpload = result.text;
                serverIpInjected = result.injected;
            }
            var body = Buffer.from(contentToUpload, 'utf8');

            node.status({ fill: 'blue', shape: 'dot', text: 'uploading…' });
            r.rwsPut('/fileservice/' + node.remotePath, body, 'text/plain;v=2.0')
            .then(function() {
                msg.payload = { ok: true, remotePath: node.remotePath, bytes: body.length, serverIpInjected: serverIpInjected };
                node.status({ fill: 'green', shape: 'dot', text: 'uploaded ' + body.length + 'B' });
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
    RED.nodes.registerType('gofa-mod-edit', GoFaModEditNode);

    // ── admin endpoints for the edit dialog ─────────────────────────────────
    // :id is the gofa-robot CONFIG node id — it must be deployed already,
    // since only a deployed config node carries credentials/session state.
    function getRobot(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.requestRaw !== 'function') {
            res.status(400).json({ error: 'Robot config node not found — deploy the flow (with its gofa-robot config node) first' });
            return null;
        }
        return robot;
    }

    RED.httpAdmin.get('/gofa-mod-edit/:id/files', RED.auth.needsPermission('gofa-mod-edit.read'), function(req, res) {
        var robot = getRobot(req, res);
        if (!robot) return;
        var dir = req.query.dir || '$HOME/Programs';
        robot.requestRaw('GET', '/fileservice/' + dir, null, { accept: 'application/xhtml+xml;v=2.0' })
        .then(function(r) {
            if (r.statusCode === 404) return res.status(404).json({ error: 'Directory not found on controller: ' + dir });
            if (r.statusCode < 200 || r.statusCode >= 300) return res.status(502).json({ error: 'HTTP ' + r.statusCode + ' listing ' + dir });
            res.json({ dir: dir, files: parseFileList(r.body.toString('utf8')) });
        })
        .catch(function(err) { res.status(502).json({ error: err.message }); });
    });

    RED.httpAdmin.get('/gofa-mod-edit/:id/file', RED.auth.needsPermission('gofa-mod-edit.read'), function(req, res) {
        var robot = getRobot(req, res);
        if (!robot) return;
        var p = req.query.path;
        if (!p) return res.status(400).json({ error: 'Missing path' });
        robot.requestRaw('GET', '/fileservice/' + p, null, { accept: '*/*' })
        .then(function(r) {
            if (r.statusCode === 404) return res.status(404).json({ error: 'File not found on controller: ' + p });
            if (r.statusCode < 200 || r.statusCode >= 300) return res.status(502).json({ error: 'HTTP ' + r.statusCode + ' reading ' + p });
            res.json({ path: p, content: r.body.toString('utf8') });
        })
        .catch(function(err) { res.status(502).json({ error: err.message }); });
    });

    RED.httpAdmin.delete('/gofa-mod-edit/:id/file', RED.auth.needsPermission('gofa-mod-edit.write'), function(req, res) {
        var robot = getRobot(req, res);
        if (!robot) return;
        var p = req.query.path;
        if (!p) return res.status(400).json({ error: 'Missing path' });
        robot.requestRaw('DELETE', '/fileservice/' + p, null, {})
        .then(function(r) {
            if (r.statusCode === 404) return res.status(404).json({ error: 'File not found on controller: ' + p });
            if (r.statusCode < 200 || r.statusCode >= 300) return res.status(502).json({ error: 'HTTP ' + r.statusCode + ' deleting ' + p });
            res.json({ ok: true, path: p, deleted: true });
        })
        .catch(function(err) { res.status(502).json({ error: err.message }); });
    });

    RED.httpAdmin.post('/gofa-mod-edit/:id/file', RED.auth.needsPermission('gofa-mod-edit.write'), function(req, res) {
        var robot = getRobot(req, res);
        if (!robot) return;
        readJsonBody(req)
        .then(function(body) {
            if (!body.path) throw new Error('Missing path');
            if (typeof body.content !== 'string') throw new Error('Missing content');
            var contentToUpload = body.content;
            var serverIpInjected = false;
            if (body.autoChangeIp !== false) {
                // Keep SERVER_IP synced on dialog saves too, same as runtime uploads.
                var result = patchServerIp(contentToUpload, robot.ip);
                contentToUpload = result.text;
                serverIpInjected = result.injected;
            }
            // fileservice PUT requires text/plain;v=2.0 (application/json is 415) — confirmed live.
            return robot.rwsPut('/fileservice/' + body.path, Buffer.from(contentToUpload, 'utf8'), 'text/plain;v=2.0')
                .then(function() { res.json({ ok: true, path: body.path, bytes: Buffer.byteLength(contentToUpload, 'utf8'), serverIpInjected: serverIpInjected }); });
        })
        .catch(function(err) {
            var code = /^Missing |^Invalid JSON/.test(err.message) ? 400 : 502;
            res.status(code).json({ error: err.message });
        });
    });
};

module.exports.parseFileList = parseFileList;
