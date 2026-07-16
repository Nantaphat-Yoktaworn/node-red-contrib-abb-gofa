'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaPoseNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) {
                msg.payload = { ok: false, error: 'No robot configured' };
                node.status({ fill: 'red', shape: 'ring', text: 'no robot' });
                node.error('No robot configured', msg);
                send(msg);
                return done();
            }
            node.status({ fill: 'blue', shape: 'dot', text: 'reading...' });
            var r = node.robot;
            r.rwsGet('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base')
            .then(function(body) {
                var p = function(c) { return parseFloat(r.parseXhtml(body, c)); };
                var xVal = p('x');
                var yVal = p('y');
                msg.payload = {
                    ok: true,
                    x: xVal, y: yVal, z: p('z'),
                    q1: p('q1'), q2: p('q2'), q3: p('q3'), q4: p('q4'),
                    cf1: p('cf1'), cf4: p('cf4'), cf6: p('cf6'), cfx: p('cfx')
                };
                var text = (isNaN(xVal) || isNaN(yVal)) ? 'read' : 'x=' + xVal.toFixed(1) + ' y=' + yVal.toFixed(1);
                node.status({ fill: 'green', shape: 'dot', text: text });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-pose', GoFaPoseNode);

    RED.httpAdmin.get('/gofa-pose/:id/read', RED.auth.needsPermission('gofa-pose.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        robot.rwsGet('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base')
        .then(function(body) {
            var p = function(c) { return parseFloat(robot.parseXhtml(body, c)); };
            res.json({
                ok: true,
                x: p('x'), y: p('y'), z: p('z'),
                q1: p('q1'), q2: p('q2'), q3: p('q3'), q4: p('q4'),
                cf1: p('cf1'), cf4: p('cf4'), cf6: p('cf6'), cfx: p('cfx')
            });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
