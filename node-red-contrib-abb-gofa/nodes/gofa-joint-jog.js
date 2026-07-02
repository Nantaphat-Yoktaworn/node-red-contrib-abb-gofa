'use strict';
module.exports = function(RED) {
    function GoFaJointJogNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.joint = config.joint || 'J1';
        this.dir   = config.dir   || '+';
        this.step  = parseFloat(config.step) || 5;
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var p     = msg.payload || {};
            var joint = p.joint !== undefined ? p.joint : node.joint;
            var dir   = p.dir   !== undefined ? p.dir   : node.dir;
            var step  = p.step  !== undefined ? parseFloat(p.step) : node.step;
            step = Math.max(1, Math.min(30, step));
            var token = joint + dir + step;
            node.status({ fill: 'blue', shape: 'dot', text: token });
            node.robot.socketSend(token).then(function(ack) {
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
    RED.nodes.registerType('gofa-joint-jog', GoFaJointJogNode);
};
