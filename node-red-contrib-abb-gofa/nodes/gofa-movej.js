'use strict';
module.exports = function(RED) {
    function GoFaMoveJNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.joints = config.joints || '[0,0,85,0,0,0]';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var j;
            if (msg.payload !== null && msg.payload !== undefined) {
                if (Array.isArray(msg.payload) && msg.payload.length === 6) {
                    j = msg.payload;
                } else if (typeof msg.payload === 'object' && !Array.isArray(msg.payload)) {
                    var p = msg.payload;
                    if (p.j1 !== undefined) {
                        j = [p.j1, p.j2, p.j3, p.j4, p.j5, p.j6];
                    } else {
                        j = null;
                    }
                } else {
                    j = null;
                }
            } else {
                j = null;
            }

            if (!j) {
                try {
                    j = JSON.parse(node.joints);
                } catch(e) {
                    node.error('Invalid joints config: ' + node.joints, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                    return done();
                }
            }

            if (!Array.isArray(j) || j.length !== 6) {
                node.error('joints must be a 6-element array', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                return done();
            }

            var nums = j.map(function(v) { return parseFloat(v); });
            if (nums.some(function(v) { return isNaN(v); })) {
                node.error('joints contains non-numeric values', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                return done();
            }

            var cmd = 'MOVEJ' + nums.map(function(v) { return v.toFixed(2); }).join(';');
            node.status({ fill: 'blue', shape: 'dot', text: cmd });

            node.robot.socketSend(cmd).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true, joints: nums };
                node.status({ fill: 'green', shape: 'dot', text: '[' + nums.map(function(v) { return v.toFixed(1); }).join(',') + ']' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-movej', GoFaMoveJNode);
};
