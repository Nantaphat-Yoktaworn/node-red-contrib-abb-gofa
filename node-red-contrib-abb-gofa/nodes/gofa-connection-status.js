'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaConnectionStatusNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) {
                msg.payload = { ok: false, error: 'No robot configured' };
                node.error('No robot configured', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no robot' });
                send(msg); return done();
            }

            var r = node.robot;
            node.status({ fill: 'blue', shape: 'dot', text: 'checking...' });

            function settled(label, promise) {
                return promise.then(
                    function(value) { return { label: label, ok: true, value: value }; },
                    function(err)   { return { label: label, ok: false, error: err.message }; }
                );
            }

            var t0 = Date.now();
            Promise.all([
                settled('ctrlstate', r.rwsGet('/rw/panel/ctrl-state')),
                settled('opmode',    r.rwsGet('/rw/panel/opmode')),
                settled('execution', r.rwsGet('/rw/rapid/execution')),
                settled('speed',     r.rwsGet('/rw/panel/speedratio')),
                settled('socket', (function() {
                    var s0 = Date.now();
                    return r.socketSend({ cmd: 'ping' }).then(function(resp) {
                        if (!resp.startsWith('OK:')) throw new Error('unexpected reply: ' + resp);
                        return Date.now() - s0;
                    });
                })())
            ]).then(function(results) {
                var find = function(label) { return results.filter(function(x) { return x.label === label; })[0]; };
                var ctrlstate = find('ctrlstate');
                var opmode    = find('opmode');
                var execution = find('execution');
                var speed     = find('speed');
                var socket    = find('socket');
                var rwsOk = ctrlstate.ok || opmode.ok || execution.ok || speed.ok;

                var payload = {
                    ok: rwsOk && socket.ok,
                    ip: r.ip,
                    rws: {
                        ok:     rwsOk,
                        motors: ctrlstate.ok ? r.parseXhtml(ctrlstate.value, 'ctrlstate')      : null,
                        mode:   opmode.ok    ? r.parseXhtml(opmode.value, 'opmode')             : null,
                        rapid:  execution.ok ? r.parseXhtml(execution.value, 'ctrlexecstate')   : null,
                        speed:  speed.ok     ? parseInt(r.parseXhtml(speed.value, 'speedratio')) || 0 : null
                    },
                    socket: socket.ok ? { ok: true, rtt: socket.value } : { ok: false, error: socket.error },
                    errors: results.filter(function(x) { return !x.ok; }).map(function(x) { return x.label + ': ' + x.error; })
                };
                msg.payload = payload;

                var statusText = payload.ok ? 'ok ' + (Date.now() - t0) + 'ms'
                                : !rwsOk     ? 'RWS unreachable'
                                : 'socket unreachable';
                var statusFill = payload.ok ? 'green' : (!rwsOk ? 'red' : 'yellow');
                node.status({ fill: statusFill, shape: payload.ok ? 'dot' : 'ring', text: statusText });

                send(msg); done();
            });
        });
    }
    RED.nodes.registerType('gofa-connection-status', GoFaConnectionStatusNode);
};
