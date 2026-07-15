'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaStopMotionNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            node.status({ fill: 'blue', shape: 'dot', text: 'stopping...' });

            node.robot.socketSend({ cmd: 'stop' }).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true };
                node.status({ fill: 'green', shape: 'dot', text: 'stopped' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-stop-motion', GoFaStopMotionNode);
};
