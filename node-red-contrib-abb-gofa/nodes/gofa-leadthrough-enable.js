'use strict';
module.exports = function(RED) {
    function GoFaLeadthroughEnableNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            node.status({ fill: 'blue', shape: 'dot', text: 'stopping motion...' });
            // Clear any queued \Conc moves before activating lead-through, otherwise
            // in-flight moves keep executing autonomously while hand-guiding is active.
            node.robot.socketSend({ cmd: 'stop' })
            .then(function(ack) {
                if (!ack.startsWith('OK:')) {
                    throw new Error('Stop motion failed: ' + ack);
                }
            })
            .catch(function(err) {
                var isSocketError = err.message && (
                    err.message.indexOf('socket') >= 0 ||
                    err.message.indexOf('connect') >= 0 ||
                    err.message.indexOf('ECONNREFUSED') >= 0
                );
                if (!isSocketError) {
                    throw err;
                }
            })
            .then(function() {
                node.status({ fill: 'blue', shape: 'dot', text: 'enabling...' });
                return node.robot.rwsPost('/rw/motionsystem/mechunits/ROB_1/lead-through', 'status=active');
            })
            .then(function() {
                msg.payload = { ok: true };
                node.status({ fill: 'green', shape: 'dot', text: 'enabled' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-leadthrough-enable', GoFaLeadthroughEnableNode);
};
