'use strict';
module.exports = function(RED) {
    function GoFaMoveNode(config) {
        RED.nodes.createNode(this, config);
        this.robot   = RED.nodes.getNode(config.robot);
        this.command = config.command || 'HOME';
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var raw = msg.payload;
            var cmd = (typeof raw === 'string' && raw) ? raw
                    : (raw && raw.command)             ? raw.command
                    : node.command;
            node.status({ fill:'blue', shape:'dot', text: cmd });
            node.robot.socketSend(cmd).then(function(ack) {
                var ok = ack.startsWith('OK:');
                msg.payload = { ok: ok, ack: ack };
                node.status({ fill: ok?'green':'red', shape:'dot', text: ack });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill:'red', shape:'ring', text:'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-move', GoFaMoveNode);
};
