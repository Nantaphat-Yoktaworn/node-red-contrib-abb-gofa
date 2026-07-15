'use strict';
var gate = require('./lib/gate');
var fs = require('fs');
module.exports = function(RED) {
    function GoFaPointsNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.action   = config.action || 'export';
        this.path     = config.path || '';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            
            var action = node.action;
            if (msg.payload && typeof msg.payload === 'object' && msg.payload.action) {
                action = msg.payload.action;
            }

            if (action === 'export') {
                var points   = node.robot.getPoints();
                var raw      = msg.payload;
                var savePath = (typeof raw === 'string' && raw) ? raw
                             : (raw && raw.savePath)             ? raw.savePath
                             : msg.savePath || node.path || '';
                msg.payload  = { ok: true, count: points.length, points: points };

                if (!savePath) {
                    node.status({ fill: 'green', shape: 'dot', text: points.length + ' points' });
                    send(msg); return done();
                }

                if (!/\.json$/i.test(savePath)) {
                    savePath += '.json';
                }

                try {
                    fs.writeFileSync(savePath, JSON.stringify(points, null, 2), 'utf8');
                    msg.payload.savedTo = savePath;
                    node.status({ fill: 'green', shape: 'dot', text: points.length + ' pts → ' + savePath });
                    send(msg); done();
                } catch (err) {
                    msg.payload = { ok: false, error: 'File write failed: ' + err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'write error' });
                    node.error(err, msg);
                    send(msg); done(err);
                }
            } else if (action === 'import') {
                var loadPath;
                if (typeof msg.payload === 'string' && msg.payload) {
                    loadPath = msg.payload;
                } else if (msg.payload && msg.payload.loadPath) {
                    loadPath = msg.payload.loadPath;
                } else {
                    loadPath = msg.loadPath || node.path || '';
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
                        node.error(err, msg);
                        send(msg); return done(err);
                    }
                } else {
                    arr = Array.isArray(msg.payload) ? msg.payload
                        : (msg.payload && Array.isArray(msg.payload.points)) ? msg.payload.points
                        : [];
                }
                var result = node.robot.replacePoints(arr);
                if (result.error) {
                    var err = new Error(result.error);
                    msg.payload = { ok: false, error: result.error };
                    node.status({ fill: 'red', shape: 'ring', text: 'import error' });
                    node.error(err, msg);
                    send(msg); return done(err);
                }

                msg.payload = { ok: true, count: result.length, loadedFrom: loadPath || null };
                node.status({ fill: 'green', shape: 'dot', text: result.length + ' points imported' });
                send(msg); done();
            } else {
                msg.payload = { ok: false, error: 'Unknown action: ' + action };
                node.error('Unknown action: ' + action, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'unknown action' });
                send(msg); done();
            }
        });
    }
    RED.nodes.registerType('gofa-points', GoFaPointsNode);
};
