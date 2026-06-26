'use strict';
module.exports = function(RED) {
    function GoFaSavePointNode(config) {
        RED.nodes.createNode(this, config);
        this.robot     = RED.nodes.getNode(config.robot);
        this.pointName = config.pointName || '';
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var name = (msg.payload && msg.payload.name) || node.pointName || '';
            var r = node.robot;
            node.status({ fill: 'blue', shape: 'dot', text: 'reading pose...' });
            r.rwsGet('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base')
            .then(function(body) {
                var p = function(c){ return parseFloat(r.parseXhtml(body, c)); };
                var target = {
                    x: p('x'), y: p('y'), z: p('z'),
                    q1: p('q1'), q2: p('q2'), q3: p('q3'), q4: p('q4'),
                    cf1: p('cf1'), cf4: p('cf4'), cf6: p('cf6'), cfx: p('cfx')
                };
                var pt = r.addPoint(name, target);
                if (pt.error) {
                    msg.payload = { ok: false, error: pt.error };
                    node.status({ fill: 'red', shape: 'ring', text: pt.error });
                    return send(msg), done();
                }
                msg.payload = { ok: true, point: pt, points: r.getPoints() };
                node.status({ fill: 'green', shape: 'dot', text: 'saved: ' + pt.name });
                send(msg); done();
            }).catch(function(err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-save-point', GoFaSavePointNode);
};
