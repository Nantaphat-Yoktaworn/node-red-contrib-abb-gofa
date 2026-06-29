'use strict';
module.exports = function(RED) {
    function GoFaDiReadNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.signal = config.signal || 'DI10_1';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var signal = node.signal;
            if (msg.payload !== null && msg.payload !== undefined && typeof msg.payload === 'string' && msg.payload !== '') {
                signal = msg.payload;
            }

            node.status({ fill: 'blue', shape: 'dot', text: signal });

            node.robot.rwsGet('/rw/iosystem/signals/' + encodeURIComponent(signal))
            .then(function(body) {
                var raw = node.robot.parseXhtml(body, 'lvalue');
                var value = parseInt(raw);
                if (isNaN(value)) {
                    throw new Error('Could not parse lvalue from response');
                }
                msg.payload = { ok: true, signal: signal, value: value };
                node.status({ fill: 'green', shape: 'dot', text: signal + '=' + value });
                send(msg); done();
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-di-read', GoFaDiReadNode);
};
