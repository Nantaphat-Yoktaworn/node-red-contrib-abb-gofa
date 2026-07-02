'use strict';
module.exports = function(RED) {
    function GoFaGripNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.action = config.action || 'on';
        this.signal = config.signal || 'DO10_1';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var action;
            if (msg.payload !== null && msg.payload !== undefined) {
                var raw = msg.payload;
                if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && raw.action !== undefined) {
                    raw = raw.action;
                }
                if (raw === true || raw === 1 || String(raw).toLowerCase() === 'on' || String(raw).toLowerCase() === 'gripon') {
                    action = 'on';
                } else if (raw === false || raw === 0 || String(raw).toLowerCase() === 'off' || String(raw).toLowerCase() === 'gripoff') {
                    action = 'off';
                } else {
                    msg.payload = { ok: false, error: 'Invalid grip action: ' + raw };
                    node.error('Invalid grip action: ' + raw, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'bad action' });
                    send(msg); return done();
                }
            } else {
                action = node.action;
            }

            var cmd = (action === 'on') ? 'GRIPON' : 'GRIPOFF';
            node.status({ fill: 'blue', shape: 'dot', text: node.signal + ' ' + action.toUpperCase() });

            node.robot.socketSend(cmd).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true, action: action, signal: node.signal };
                node.status({ fill: 'green', shape: 'dot', text: node.signal + ' ' + action.toUpperCase() });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-grip', GoFaGripNode);
};
