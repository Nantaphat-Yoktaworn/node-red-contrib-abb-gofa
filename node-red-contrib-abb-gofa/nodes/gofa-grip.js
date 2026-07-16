'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaGripNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.action = config.action || 'on';
        this.signal = config.signal || 'ABB_Scalable_IO_0_DO1';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var action;
            if (msg.payload !== null && msg.payload !== undefined) {
                var raw = msg.payload;
                if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && raw.action !== undefined) {
                    raw = raw.action;
                }
                if (raw === true || raw === 1 || String(raw).toLowerCase() === 'on' || String(raw).toLowerCase() === 'gripon') {
                    action = 'on';
                } else if (raw === false || raw === 0 || String(raw).toLowerCase() === 'off' || String(raw).toLowerCase() === 'gripoff') {
                    action = 'off';
                } else {
                    msg.payload = { ok: false, error: 'Invalid grip action: ' + raw };
                    node.error('Invalid grip action: ' + raw, msg);
                    node.status({ fill: 'red', shape: 'ring', text: 'bad action' });
                    send(msg); return done();
                }
            } else {
                action = node.action;
            }

            var value = (action === 'on') ? 1 : 0;
            node.status({ fill: 'blue', shape: 'dot', text: node.signal + ' ' + action.toUpperCase() });

            node.robot.rwsPost('/rw/iosystem/signals/' + encodeURIComponent(node.signal) + '/set-value', 'lvalue=' + value).then(function() {
                msg.payload = { ok: true, action: action, signal: node.signal };
                node.status({ fill: 'green', shape: 'dot', text: node.signal + ' ' + action.toUpperCase() });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-grip', GoFaGripNode);

    RED.httpAdmin.get('/gofa-grip/:id/read', RED.auth.needsPermission('gofa-grip.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var signal = req.query.signal;
        if (!signal) {
            return res.status(400).json({ error: 'Missing signal name' });
        }
        robot.rwsGet('/rw/iosystem/signals/' + encodeURIComponent(signal))
        .then(function(body) {
            var raw = robot.parseXhtml(body, 'lvalue');
            var value = parseInt(raw);
            if (isNaN(value)) {
                throw new Error('Could not parse lvalue from response');
            }
            res.json({ ok: true, signal: signal, value: value });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });

    RED.httpAdmin.post('/gofa-grip/:id/toggle', RED.auth.needsPermission('gofa-grip.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsPost !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var signal = req.body.signal;
        var action = req.body.action; // 'on' or 'off'
        if (!signal) {
            return res.status(400).json({ error: 'Missing signal name' });
        }
        if (action !== 'on' && action !== 'off') {
            return res.status(400).json({ error: 'Invalid action: ' + action });
        }
        var value = action === 'on' ? 1 : 0;
        robot.rwsPost('/rw/iosystem/signals/' + encodeURIComponent(signal) + '/set-value', 'lvalue=' + value)
        .then(function() {
            res.json({ ok: true, action: action, signal: signal });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
