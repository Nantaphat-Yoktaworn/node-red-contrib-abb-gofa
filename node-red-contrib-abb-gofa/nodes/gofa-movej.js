'use strict';
module.exports = function(RED) {
    function GoFaMoveJNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.joints = config.joints || '[0,0,85,0,0,0]';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

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
                    msg.payload = { ok: false, error: 'Invalid joints config: ' + node.joints };
                    node.error('Invalid joints config: ' + node.joints, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                    send(msg); return done();
                }
            }

            if (!Array.isArray(j) || j.length !== 6) {
                msg.payload = { ok: false, error: 'joints must be a 6-element array' };
                node.error('joints must be a 6-element array', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                send(msg); return done();
            }

            var nums = j.map(function(v) { return parseFloat(v); });
            if (nums.some(function(v) { return isNaN(v); })) {
                msg.payload = { ok: false, error: 'joints contains non-numeric values' };
                node.error('joints contains non-numeric values', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joints' });
                send(msg); return done();
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
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-movej', GoFaMoveJNode);
};
