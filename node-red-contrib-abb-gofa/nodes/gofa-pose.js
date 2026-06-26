'use strict';
module.exports = function(RED) {
    function GoFaPoseNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var r = node.robot;
            r.rwsGet('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base')
            .then(function(body) {
                var p = function(c) { return parseFloat(r.parseXhtml(body, c)); };
                msg.payload = {
                    x: p('x'), y: p('y'), z: p('z'),
                    q1: p('q1'), q2: p('q2'), q3: p('q3'), q4: p('q4'),
                    cf1: p('cf1'), cf4: p('cf4'), cf6: p('cf6'), cfx: p('cfx')
                };
                send(msg); done();
            }).catch(function(err) { node.error(err, msg); done(err); });
        });
    }
    RED.nodes.registerType('gofa-pose', GoFaPoseNode);
};
