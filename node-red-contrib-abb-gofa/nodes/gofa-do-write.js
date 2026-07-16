'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaDoWriteNode(config) {
        RED.nodes.createNode(this, config);
        this.robot     = RED.nodes.getNode(config.robot);
        this.signal    = config.signal || 'ABB_Scalable_IO_0_DO1';
        this.value     = parseInt(config.value) || 0;
        this.transport = config.transport || 'rws';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var signal    = node.signal;
            var value     = node.value;
            var transport = node.transport;

            if (msg.payload !== null && msg.payload !== undefined) {
                if (typeof msg.payload === 'object') {
                    if (msg.payload.signal    !== undefined) { signal    = msg.payload.signal;    }
                    if (msg.payload.value     !== undefined) { value     = msg.payload.value;      }
                    if (msg.payload.transport !== undefined) { transport = msg.payload.transport;  }
                } else {
                    value = msg.payload;
                }
            }

            value = parseInt(value);
            if (isNaN(value) || (value !== 0 && value !== 1)) {
                msg.payload = { ok: false, error: 'Invalid digital value (must be 0 or 1): ' + value };
                node.error('Invalid digital value (must be 0 or 1): ' + value, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad value' });
                send(msg); return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: signal + '=' + value });

            var writePromise = (transport === 'socket')
                // RAPID's DispatchJson matches signal names case-sensitively against an
                // ALL-CAPS allow-list (unlike the legacy text protocol, which CleanCmd
                // uppercases automatically) — confirmed live: a mixed-case name like this
                // node's own default, "ABB_Scalable_IO_0_DO1", gets ERR:SETDO ("unknown
                // signal") unless upper-cased first.
                ? node.robot.socketSend({ cmd: 'setdo', name: signal.toUpperCase(), val: value }).then(function(reply) {
                    if (!/^OK:SETDO/.test(reply)) throw new Error('Socket write failed: ' + reply);
                })
                : node.robot.rwsPost('/rw/iosystem/signals/' + encodeURIComponent(signal) + '/set-value', 'lvalue=' + value);

            writePromise.then(function() {
                msg.payload = { ok: true, signal: signal, value: value, transport: transport };
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
    RED.nodes.registerType('gofa-do-write', GoFaDoWriteNode);

    RED.httpAdmin.get('/gofa-do-write/:id/read', RED.auth.needsPermission('gofa-do-write.read'), function(req, res) {
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

    RED.httpAdmin.post('/gofa-do-write/:id/write', RED.auth.needsPermission('gofa-do-write.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot) {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var signal = req.body.signal;
        var value = parseInt(req.body.value);
        var transport = req.body.transport || 'rws';
        if (!signal) {
            return res.status(400).json({ error: 'Missing signal name' });
        }
        if (isNaN(value) || (value !== 0 && value !== 1)) {
            return res.status(400).json({ error: 'Invalid value (must be 0 or 1)' });
        }

        var writePromise = (transport === 'socket')
            ? (typeof robot.socketSend === 'function'
                ? robot.socketSend({ cmd: 'setdo', name: signal.toUpperCase(), val: value }).then(function(reply) {
                    if (!/^OK:SETDO/.test(reply)) throw new Error('Socket write failed: ' + reply);
                })
                : Promise.reject(new Error('Socket transport not configured/supported')))
            : (typeof robot.rwsPost === 'function'
                ? robot.rwsPost('/rw/iosystem/signals/' + encodeURIComponent(signal) + '/set-value', 'lvalue=' + value)
                : Promise.reject(new Error('RWS transport not configured/supported')));

        writePromise.then(function() {
            res.json({ ok: true, signal: signal, value: value, transport: transport });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
