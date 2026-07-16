'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaStatusNode(config) {
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
            Promise.all([
                r.rwsGet('/rw/panel/ctrl-state'),
                r.rwsGet('/rw/panel/opmode'),
                r.rwsGet('/rw/panel/speedratio'),
                r.rwsGet('/rw/rapid/execution')
            ]).then(function(b) {
                msg.payload = {
                    ok: true,
                    ctrlstate: r.parseXhtml(b[0], 'ctrlstate'),
                    opmode:    r.parseXhtml(b[1], 'opmode'),
                    speed:     parseInt(r.parseXhtml(b[2], 'speedratio')) || 0,
                    rapid:     r.parseXhtml(b[3], 'ctrlexecstate')
                };
                node.status({ fill:'green', shape:'dot', text: msg.payload.ctrlstate });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-status', GoFaStatusNode);

    RED.httpAdmin.get('/gofa-status/:id/read', RED.auth.needsPermission('gofa-status.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        Promise.all([
            robot.rwsGet('/rw/panel/ctrl-state'),
            robot.rwsGet('/rw/panel/opmode'),
            robot.rwsGet('/rw/panel/speedratio'),
            robot.rwsGet('/rw/rapid/execution')
        ]).then(function(b) {
            res.json({
                ok: true,
                ctrlstate: robot.parseXhtml(b[0], 'ctrlstate'),
                opmode:    robot.parseXhtml(b[1], 'opmode'),
                speed:     parseInt(robot.parseXhtml(b[2], 'speedratio')) || 0,
                rapid:     robot.parseXhtml(b[3], 'ctrlexecstate')
            });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
