'use strict';
module.exports = function(RED) {
    function GoFaAoWriteNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.signal = config.signal || 'AO1';
        this.value  = parseFloat(config.value) || 0.0;
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var signal = node.signal;
            var value  = node.value;

            if (msg.payload !== null && msg.payload !== undefined) {
                if (typeof msg.payload === 'object') {
                    if (msg.payload.signal !== undefined) { signal = msg.payload.signal; }
                    if (msg.payload.value  !== undefined) { value  = msg.payload.value;  }
                } else if (typeof msg.payload === 'number') {
                    value = msg.payload;
                }
            }

            value = parseFloat(value);
            if (isNaN(value)) {
                node.error('Invalid analog value: ' + value, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad value' });
                return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: signal + '=' + value });

            node.robot.rwsPost('/rw/iosystem/signals/' + encodeURIComponent(signal) + '/set', 'lvalue=' + value)
            .then(function() {
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
    RED.nodes.registerType('gofa-ao-write', GoFaAoWriteNode);
};
