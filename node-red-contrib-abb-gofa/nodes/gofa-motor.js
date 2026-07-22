'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaMotorNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.action = config.action || 'motoron';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
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

    RED.httpAdmin.get('/gofa-motor/:id/read', RED.auth.needsPermission('gofa-motor.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        robot.rwsGet('/rw/panel/ctrl-state')
        .then(function(body) {
            res.json({ ok: true, ctrlstate: robot.parseXhtml(body, 'ctrlstate') });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });

    RED.httpAdmin.post('/gofa-motor/:id/toggle', requireAdminAuth(RED, 'gofa-motor.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsPost !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var action = req.body.action;
        if (action !== 'motoron' && action !== 'motoroff') {
            return res.status(400).json({ error: 'Invalid action: ' + action });
        }
        robot.rwsPost('/rw/panel/ctrl-state', 'ctrl-state=' + action)
        .then(function() {
            res.json({ ok: true, action: action });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
