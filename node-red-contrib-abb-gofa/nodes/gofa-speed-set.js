'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaSpeedSetNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.speed  = parseInt(config.speed) || 50;
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var raw;
            if (typeof msg.payload === 'number') {
                raw = msg.payload;
            } else if (typeof msg.payload === 'string' && msg.payload !== '') {
                raw = msg.payload;
            } else {
                raw = node.speed;
            }

            var speed = parseInt(raw);
            if (isNaN(speed)) {
                msg.payload = { ok: false, error: 'Invalid speed value: ' + raw };
                node.error('Invalid speed value: ' + raw, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad value' });
                send(msg); return done();
            }
            if (speed < 1)   { node.warn('Speed clamped to 1');   speed = 1;   }
            if (speed > 100) { node.warn('Speed clamped to 100'); speed = 100; }

            node.status({ fill: 'blue', shape: 'dot', text: speed + '%' });

            node.robot.socketSend({ cmd: 'speed', val: speed }).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true, speed: speed };
                node.status({ fill: 'green', shape: 'dot', text: speed + '%' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-speed-set', GoFaSpeedSetNode);

    RED.httpAdmin.post('/gofa-speed-set/:id/set', RED.auth.needsPermission('gofa-speed-set.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var speed = parseInt(req.body.speed);
        if (isNaN(speed) || speed < 1 || speed > 100) {
            return res.status(400).json({ error: 'Invalid speed value: ' + req.body.speed });
        }

        robot.socketSend({ cmd: 'speed', val: speed }).then(function(resp) {
            if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
            res.json({ ok: true, speed: speed });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
