'use strict';
module.exports = function(RED) {
    function GoFaPingNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            node.status({ fill: 'blue', shape: 'dot', text: 'pinging...' });
            var t0 = Date.now();

            node.robot.socketSend('PING').then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                var rtt = Date.now() - t0;
                msg.payload = { ok: true, rtt: rtt };
                node.status({ fill: 'green', shape: 'dot', text: rtt + 'ms' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-ping', GoFaPingNode);
};
