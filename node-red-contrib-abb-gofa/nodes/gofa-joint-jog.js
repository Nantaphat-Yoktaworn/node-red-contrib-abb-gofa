'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaJointJogNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.joint = config.joint || 'J1';
        this.dir   = config.dir   || '+';
        this.step  = parseFloat(config.step) || 5;
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var p     = msg.payload || {};
            var joint = p.joint !== undefined ? p.joint : node.joint;
            var jointNum = parseInt(String(joint).replace('J', ''));
            if (isNaN(jointNum) || jointNum < 1 || jointNum > 6) {
                msg.payload = { ok: false, error: 'Invalid joint: ' + joint };
                node.error('Invalid joint: ' + joint, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad joint' });
                send(msg); return done();
            }
            var dir   = p.dir   !== undefined ? p.dir   : node.dir;
            if (dir !== '+' && dir !== '-') {
                msg.payload = { ok: false, error: 'Invalid direction: ' + dir };
                node.error('Invalid direction: ' + dir, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad dir' });
                send(msg); return done();
            }
            var step  = p.step  !== undefined ? parseFloat(p.step) : node.step;
            if (isNaN(step)) {
                msg.payload = { ok: false, error: 'Invalid step value: ' + p.step };
                node.error('Invalid step value: ' + p.step, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad step' });
                send(msg); return done();
            }
            step = Math.max(1, Math.min(30, step));
            var token = 'J' + jointNum + dir + step;
            node.status({ fill: 'blue', shape: 'dot', text: token });
            node.robot.socketSend({ cmd: 'jointjog', joint: jointNum, sgn: dir, val: step }).then(function(ack) {
                var ok = ack.startsWith('OK:');
                msg.payload = { ok: ok, ack: ack, token: token };
                node.status({ fill: ok ? 'green' : 'red', shape: 'dot', text: ack });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-joint-jog', GoFaJointJogNode);

    RED.httpAdmin.post('/gofa-joint-jog/:id/jog', requireAdminAuth(RED, 'gofa-joint-jog.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var joint = req.body.joint || 'J1';
        var dir = req.body.dir || '+';
        var step = parseFloat(req.body.step) || 5;

        var jointNum = parseInt(String(joint).replace('J', ''));
        if (isNaN(jointNum) || jointNum < 1 || jointNum > 6) {
            return res.status(400).json({ error: 'Invalid joint: ' + joint });
        }

        if (dir !== '+' && dir !== '-') {
            return res.status(400).json({ error: 'Invalid direction: ' + dir });
        }

        step = Math.max(1, Math.min(30, step));

        robot.socketSend({ cmd: 'jointjog', joint: jointNum, sgn: dir, val: step }).then(function(ack) {
            var ok = ack.startsWith('OK:');
            if (!ok) {
                throw new Error(ack);
            }
            res.json({ ok: true, ack: ack });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
