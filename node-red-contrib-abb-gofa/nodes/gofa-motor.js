'use strict';
module.exports = function(RED) {
    function GoFaMotorNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.action = config.action || 'motoron';
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var raw    = msg.payload;
            var action = (typeof raw === 'string' && raw) ? raw
                       : (raw && raw.action)              ? raw.action
                       : node.action;
            if (typeof action === 'string') {
                action = action.toLowerCase();
            }
            if (action !== 'motoron' && action !== 'motoroff') {
                msg.payload = { ok: false, error: 'Invalid action: ' + action };
                node.error('Invalid action: ' + action, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad action' });
                send(msg); return done();
            }
            node.status({ fill:'blue', shape:'dot', text: action });
            node.robot.rwsPost('/rw/panel/ctrl-state', 'ctrl-state=' + action)
            .then(function() {
                msg.payload = { ok: true, action: action };
                node.status({ fill:'green', shape:'dot', text: action });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill:'red', shape:'ring', text:'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-motor', GoFaMotorNode);
};
