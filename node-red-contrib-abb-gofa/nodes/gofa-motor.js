'use strict';
module.exports = function(RED) {
    function GoFaMotorNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.action = config.action || 'motoron';
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var action = (msg.payload && msg.payload.action) || node.action;
            node.status({ fill:'blue', shape:'dot', text: action });
            node.robot.rwsPost('/rw/panel/ctrl-state', 'ctrl-state=' + action)
            .then(function() {
                msg.payload = { ok: true, action: action };
                node.status({ fill:'green', shape:'dot', text: action });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill:'red', shape:'ring', text:'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-motor', GoFaMotorNode);
};
