'use strict';
var gate = require('./lib/gate');
var parseSignalList = require('./lib/list-signals');
module.exports = function(RED) {
    function GoFaDiReadNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.signal = config.signal || 'ABB_Scalable_IO_0_DI1';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var signal = node.signal;
            if (msg.payload !== null && msg.payload !== undefined && typeof msg.payload === 'string' && msg.payload !== '') {
                signal = msg.payload;
            }

            node.status({ fill: 'blue', shape: 'dot', text: signal });

            node.robot.rwsGet('/rw/iosystem/signals/' + encodeURIComponent(signal))
            .then(function(body) {
                var raw = node.robot.parseXhtml(body, 'lvalue');
                var value = parseInt(raw);
                if (isNaN(value)) {
                    throw new Error('Could not parse lvalue from response');
                }
                msg.payload = { ok: true, signal: signal, value: value };
                node.status({ fill: 'green', shape: 'dot', text: signal + '=' + value });
                send(msg); done();
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-di-read', GoFaDiReadNode);

    RED.httpAdmin.get('/gofa-di-read/:id/read', RED.auth.needsPermission('gofa-di-read.read'), function(req, res) {
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

    RED.httpAdmin.get('/gofa-di-read/:id/signals', RED.auth.needsPermission('gofa-di-read.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        robot.rwsGet('/rw/iosystem/signals')
        .then(function(body) {
            var signals = parseSignalList(body).filter(function(s) { return s.type === 'DI'; });
            res.json({ ok: true, signals: signals });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
