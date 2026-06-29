'use strict';
module.exports = function(RED) {
    function GoFaLeadthroughEnableNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            node.status({ fill: 'blue', shape: 'dot', text: 'enabling...' });
            node.robot.rwsPost('/rw/motionsystem/mechunits/ROB_1/lead-through?action=activate', 'status=active')
            .then(function() {
                msg.payload = { ok: true };
                node.status({ fill: 'green', shape: 'dot', text: 'enabled' });
                send(msg); done();
            }).catch(function(err) {
                var hint = (err.message && err.message.indexOf('404') !== -1)
                    ? 'Lead-through requires manual mode with enable switch held'
                    : err.message;
                msg.payload = { ok: false, error: err.message, hint: hint };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-leadthrough-enable', GoFaLeadthroughEnableNode);
};
