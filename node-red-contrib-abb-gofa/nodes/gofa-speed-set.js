'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaSpeedSetNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.speed  = parseInt(config.speed) || 50;
        this.action = config.action || 'set';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var raw = msg.payload;
            var action = (raw && typeof raw === 'object' && raw.action) ? raw.action : node.action;

            // Chaining hazard: this node's own success output is {ok, action, speed} — the
            // same shape msg.payload.action reads from. Wiring one gofa-speed-set node
            // straight into another would silently repeat the first node's action instead
            // of running the second node's configured one (same class of bug already found
            // in gofa-rapid-exec/gofa-asi-led — see CLAUDE.md).
            if (raw && typeof raw === 'object' && raw.ok !== undefined && raw.action !== undefined) {
                node.warn('msg.payload looks like another gofa-speed-set node\'s own output ({ok, action, speed}) — ' +
                    'if unintentional, insert a change node to clear msg.payload between chained gofa-speed-set ' +
                    'nodes; action "' + raw.action + '" is currently overriding this node\'s configured action');
            }

            if (action === 'read') {
                node.status({ fill: 'blue', shape: 'dot', text: 'reading...' });
                // Reads CMotSet.vel.oride (the VelSet override actually driving motion) via the
                // "getspeed" socket command — NOT RWS speedratio, which is the FlexPendant/
                // production-window dial, a separate value confirmed live not to reflect what
                // Set writes. Requires RAPID running, same as Set.
                node.robot.socketSend({ cmd: 'getspeed' }).then(function(resp) {
                    if (!resp.startsWith('VAL:')) throw new Error('Robot error: ' + resp);
                    var speed = parseInt(resp.slice(4)) || 0;
                    msg.payload = { ok: true, action: 'read', speed: speed };
                    node.status({ fill: 'green', shape: 'dot', text: speed + '%' });
                    send(msg); done();
                }).catch(function(err) {
                    msg.payload = { ok: false, error: err.message, action: 'read' };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err, msg);
                    send(msg); done(err);
                });
                return;
            }

            var speedRaw;
            if (raw && typeof raw === 'object' && raw.speed !== undefined) {
                speedRaw = raw.speed;
            } else if (typeof raw === 'number') {
                speedRaw = raw;
            } else if (typeof raw === 'string' && raw !== '') {
                speedRaw = raw;
            } else {
                speedRaw = node.speed;
            }

            var speed = parseInt(speedRaw);
            if (isNaN(speed)) {
                msg.payload = { ok: false, error: 'Invalid speed value: ' + speedRaw };
                node.error('Invalid speed value: ' + speedRaw, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad value' });
                send(msg); return done();
            }
            if (speed < 1)   { node.warn('Speed clamped to 1');   speed = 1;   }
            if (speed > 100) { node.warn('Speed clamped to 100'); speed = 100; }

            node.status({ fill: 'blue', shape: 'dot', text: speed + '%' });

            node.robot.socketSend({ cmd: 'speed', val: speed }).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true, action: 'set', speed: speed };
                node.status({ fill: 'green', shape: 'dot', text: speed + '%' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message, action: 'set' };
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

    RED.httpAdmin.get('/gofa-speed-set/:id/read', RED.auth.needsPermission('gofa-speed-set.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        robot.socketSend({ cmd: 'getspeed' }).then(function(resp) {
            if (!resp.startsWith('VAL:')) throw new Error('Robot error: ' + resp);
            res.json({ ok: true, speed: parseInt(resp.slice(4)) || 0 });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
