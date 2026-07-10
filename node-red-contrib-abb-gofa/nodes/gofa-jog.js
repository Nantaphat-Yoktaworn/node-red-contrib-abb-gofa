'use strict';
module.exports = function(RED) {
    function GoFaJogNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.axis  = config.axis  || 'X';
        this.dir   = config.dir   || '+';
        this.step  = parseFloat(config.step) || 10;
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var p    = msg.payload || {};
            var axis = p.axis !== undefined ? p.axis : node.axis;
            if (typeof axis !== 'string') {
                msg.payload = { ok: false, error: 'Invalid or missing axis: ' + axis };
                node.error('Invalid or missing axis: ' + axis, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad axis' });
                send(msg); return done();
            }
            var upperAxis = axis.toUpperCase();
            if (['X', 'Y', 'Z', 'RX', 'RY', 'RZ'].indexOf(upperAxis) === -1) {
                msg.payload = { ok: false, error: 'Invalid axis: ' + axis };
                node.error('Invalid axis: ' + axis, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad axis' });
                send(msg); return done();
            }
            axis = upperAxis;
            var dir  = p.dir  !== undefined ? p.dir  : node.dir;
            if (dir !== '+' && dir !== '-') {
                msg.payload = { ok: false, error: 'Invalid direction: ' + dir };
                node.error('Invalid direction: ' + dir, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad dir' });
                send(msg); return done();
            }
            var step = p.step !== undefined ? parseFloat(p.step) : node.step;
            if (isNaN(step)) {
                msg.payload = { ok: false, error: 'Invalid step value: ' + p.step };
                node.error('Invalid step value: ' + p.step, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad step' });
                send(msg); return done();
            }
            var rot  = upperAxis.charAt(0) === 'R';
            step = Math.max(1, Math.min(rot ? 30 : 50, step));
            var token = axis + dir + step;
            var axisLetter = rot ? axis.substring(1) : axis;
            node.status({ fill: 'blue', shape: 'dot', text: token });
            node.robot.socketSend({ cmd: 'jog', axis: axisLetter, sgn: dir, val: step, rot: rot }).then(function(ack) {
                var ok = ack.startsWith('OK:');
                msg.payload = { ok: ok, ack: ack, token: token };
                node.status({ fill: ok ? 'green' : 'red', shape: 'dot', text: ack });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-jog', GoFaJogNode);
};
