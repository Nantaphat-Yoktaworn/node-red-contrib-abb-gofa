'use strict';
var gate = require('./lib/gate');
var parseSignalList = require('./lib/list-signals');

// Signal types offered in the Known Signals dropdown.
//
// The read path itself is type-agnostic: GET /rw/iosystem/signals/<name>
// returns the same name/type/lvalue shape for every signal kind (confirmed live
// 2026-08-05 against both ABB_Scalable_IO_0_DI1 and ABB_Scalable_IO_0_DO1), so
// this node has always been able to read a DO — only the dropdown filtered them
// out. A name typed by hand still reaches any signal, including the controller's
// GO group outputs. Only the digital types are *listed* because the value goes
// through parseInt, which would silently truncate an analog reading.
var LISTED_TYPES = ['DI', 'DO'];

// One implementation, called from both the deployed node and the editor panel's
// "Read Value" button — see CLAUDE.md, "Runtime vs. admin-route duplication".
function readSignal(robot, signal) {
    return robot.rwsGet('/rw/iosystem/signals/' + encodeURIComponent(signal))
    .then(function(body) {
        var value = parseInt(robot.parseXhtml(body, 'lvalue'));
        if (isNaN(value)) {
            throw new Error('Could not parse lvalue from response');
        }
        // `type` is whatever the controller reports (DI/DO/GO/…), or null on a
        // response that omits it — never inferred from the signal's name.
        return { ok: true, signal: signal, value: value, type: robot.parseXhtml(body, 'type') };
    });
}

function listSignals(robot) {
    return robot.rwsGet('/rw/iosystem/signals')
    .then(function(body) {
        return parseSignalList(body).filter(function(s) {
            return LISTED_TYPES.indexOf(s.type) !== -1;
        });
    });
}

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

            readSignal(node.robot, signal)
            .then(function(result) {
                msg.payload = result;
                node.status({ fill: 'green', shape: 'dot', text: signal + '=' + result.value });
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
        readSignal(robot, signal)
        .then(function(result) { res.json(result); })
        .catch(function(err) { res.status(502).json({ error: err.message }); });
    });

    RED.httpAdmin.get('/gofa-di-read/:id/signals', RED.auth.needsPermission('gofa-di-read.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        listSignals(robot)
        .then(function(signals) { res.json({ ok: true, signals: signals }); })
        .catch(function(err) { res.status(502).json({ error: err.message }); });
    });
};

module.exports.LISTED_TYPES = LISTED_TYPES;
