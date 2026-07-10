'use strict';
module.exports = function(RED) {
    function GoFaJointsNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) {
                msg.payload = { ok: false, error: 'No robot configured' };
                node.status({ fill: 'red', shape: 'ring', text: 'no robot' });
                node.error('No robot configured', msg);
                send(msg);
                return done();
            }
            node.status({ fill: 'blue', shape: 'dot', text: 'reading...' });
            var r = node.robot;
            r.rwsGet('/rw/motionsystem/mechunits/ROB_1/jointtarget')
            .then(function(body) {
                var p = function(c) { return parseFloat(r.parseXhtml(body, c)); };
                msg.payload = {
                    ok: true,
                    j1: p('rax_1'), j2: p('rax_2'), j3: p('rax_3'),
                    j4: p('rax_4'), j5: p('rax_5'), j6: p('rax_6')
                };
                node.status({ fill: 'green', shape: 'dot', text: 'read' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-joints', GoFaJointsNode);
};
