'use strict';
var gate = require('./lib/gate');
var parseSignalList = require('./lib/list-signals');
module.exports = function(RED) {
    function GoFaIoListNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var filterType = '';
            if (msg.payload && typeof msg.payload === 'object' && msg.payload.type) {
                filterType = String(msg.payload.type).toUpperCase();
            }

            node.status({ fill: 'blue', shape: 'dot', text: 'listing...' });

            node.robot.rwsGet('/rw/iosystem/signals')
            .then(function(body) {
                var signals = parseSignalList(body);

                if (filterType) {
                    signals = signals.filter(function(s) {
                        return s.type && s.type.toUpperCase() === filterType;
                    });
                }

                msg.payload = { ok: true, count: signals.length, signals: signals };
                node.status({ fill: 'green', shape: 'dot', text: signals.length + ' signals' });
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
    RED.nodes.registerType('gofa-io-list', GoFaIoListNode);

    RED.httpAdmin.get('/gofa-io-list/:id/read', RED.auth.needsPermission('gofa-io-list.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var filterType = (req.query.type || '').toUpperCase();
        robot.rwsGet('/rw/iosystem/signals')
        .then(function(body) {
            var signals = parseSignalList(body);

            if (filterType) {
                signals = signals.filter(function(s) {
                    return s.type && s.type.toUpperCase() === filterType;
                });
            }

            res.json({ ok: true, count: signals.length, signals: signals });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
