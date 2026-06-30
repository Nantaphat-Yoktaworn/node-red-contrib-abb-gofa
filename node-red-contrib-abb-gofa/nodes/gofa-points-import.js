'use strict';
var fs = require('fs');
module.exports = function(RED) {
    function GoFaPointsImportNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.loadPath = config.loadPath || '';
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var loadPath;
            if (typeof msg.payload === 'string' && msg.payload) {
                loadPath = msg.payload;
            } else if (msg.payload && msg.payload.loadPath) {
                loadPath = msg.payload.loadPath;
            } else {
                loadPath = msg.loadPath || node.loadPath || '';
            }
            var arr;

            if (loadPath) {
                try {
                    var raw = fs.readFileSync(loadPath, 'utf8');
                    var parsed = JSON.parse(raw);
                    arr = Array.isArray(parsed) ? parsed
                        : (parsed && Array.isArray(parsed.points)) ? parsed.points
                        : null;
                    if (!arr) throw new Error('File must contain an array or {points:[...]}');
                } catch (err) {
                    msg.payload = { ok: false, error: 'File read failed: ' + err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'read error' });
                    node.error(err, msg); return done(err);
                }
            } else {
                arr = Array.isArray(msg.payload) ? msg.payload
                    : (msg.payload && Array.isArray(msg.payload.points)) ? msg.payload.points
                    : [];
            }

            node.robot._points = arr;
            node.robot._savePoints();
            msg.payload = { ok: true, count: arr.length, loadedFrom: loadPath || null };
            node.status({ fill: 'green', shape: 'dot', text: arr.length + ' points imported' });
            send(msg); done();
        });
    }
    RED.nodes.registerType('gofa-points-import', GoFaPointsImportNode);
};
