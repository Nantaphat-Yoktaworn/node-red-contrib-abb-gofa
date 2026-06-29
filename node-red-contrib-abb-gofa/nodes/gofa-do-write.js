'use strict';
module.exports = function(RED) {
    function GoFaDoWriteNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.signal = config.signal || 'DO10_1';
        this.value  = parseInt(config.value) || 0;
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var signal = node.signal;
            var value  = node.value;

            if (msg.payload !== null && msg.payload !== undefined) {
                if (typeof msg.payload === 'object') {
                    if (msg.payload.signal !== undefined) { signal = msg.payload.signal; }
                    if (msg.payload.value  !== undefined) { value  = msg.payload.value;  }
                } else {
                    value = msg.payload;
                }
            }

            value = parseInt(value);
            if (isNaN(value) || (value !== 0 && value !== 1)) {
                node.error('Invalid digital value (must be 0 or 1): ' + value, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad value' });
                return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: signal + '=' + value });

            node.robot.rwsPost('/rw/iosystem/signals/' + encodeURIComponent(signal) + '?action=set', 'lvalue=' + value)
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
    RED.nodes.registerType('gofa-do-write', GoFaDoWriteNode);
};
