'use strict';
var fs = require('fs');
module.exports = function(RED) {
    function GoFaPointsExportNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.savePath = config.savePath || '';
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var points   = node.robot.getPoints();
            var raw      = msg.payload;
            var savePath = (typeof raw === 'string' && raw) ? raw
                         : (raw && raw.savePath)             ? raw.savePath
                         : msg.savePath || node.savePath || '';
            msg.payload  = { ok: true, count: points.length, points: points };

            if (!savePath) {
                node.status({ fill: 'green', shape: 'dot', text: points.length + ' points' });
                send(msg); return done();
            }

            try {
                fs.writeFileSync(savePath, JSON.stringify(points, null, 2), 'utf8');
                msg.payload.savedTo = savePath;
                node.status({ fill: 'green', shape: 'dot', text: points.length + ' pts → ' + savePath });
                send(msg); done();
            } catch (err) {
                msg.payload = { ok: false, error: 'File write failed: ' + err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'write error' });
                node.error(err, msg); done(err);
            }
        });
    }
    RED.nodes.registerType('gofa-points-export', GoFaPointsExportNode);
};
