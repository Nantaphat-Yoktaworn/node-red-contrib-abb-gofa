'use strict';
module.exports = function(RED) {
    function GoFaLeadthroughDisableNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            node.status({ fill: 'blue', shape: 'dot', text: 'disabling...' });
            node.robot.rwsPost('/rw/motionsystem/mechunits/ROB_1/lead-through', 'status=inactive')
            .then(function() {
                msg.payload = { ok: true };
                node.status({ fill: 'green', shape: 'dot', text: 'disabled' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-leadthrough-disable', GoFaLeadthroughDisableNode);
};
