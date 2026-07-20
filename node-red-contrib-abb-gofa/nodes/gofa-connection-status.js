'use strict';
var gate = require('./lib/gate');
var PALETTE_VERSION = require('./gofa-robot').PALETTE_VERSION;
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
                })()),
                // T_ROB1's socket (above) goes down whenever RAPID/T_ROB1 is stopped (teach
                // workflow, EGM session). BackgroundLed.mod runs in a separate SEMISTATIC task
                // that survives that — pinging it lets ok=false be split into "T_ROB1 socket
                // specifically down" vs. "whole controller unreachable" (RWS also down).
                settled('background', (function() {
                    var b0 = Date.now();
                    return r.socketSend({ cmd: 'ping' }, r.backgroundPort).then(function(resp) {
                        if (!resp.startsWith('OK:')) throw new Error('unexpected reply: ' + resp);
                        return Date.now() - b0;
                    });
                })())
            ]).then(function(results) {
                var find = function(label) { return results.filter(function(x) { return x.label === label; })[0]; };
                var ctrlstate  = find('ctrlstate');
                var opmode     = find('opmode');
                var execution  = find('execution');
                var speed      = find('speed');
                var socket     = find('socket');
                var background = find('background');
                var rwsOk = ctrlstate.ok || opmode.ok || execution.ok || speed.ok;

                var socketVersion = socket.ok ? r.getLastPingVersion() : null;
                var socketStatus = !socket.ok || socketVersion === null ? 'unknown' : (socketVersion === PALETTE_VERSION ? 'match' : 'mismatch');
                var backgroundVersion = background.ok ? r.getLastPingVersion(r.backgroundPort) : null;
                var backgroundStatus = !background.ok || backgroundVersion === null ? 'unknown' : (backgroundVersion === PALETTE_VERSION ? 'match' : 'mismatch');

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
                    background: background.ok ? { ok: true, rtt: background.value } : { ok: false, error: background.error },
                    moduleVersion: {
                        expected: PALETTE_VERSION,
                        socket: { version: socketVersion, status: socketStatus },
                        background: { version: backgroundVersion, status: backgroundStatus }
                    },
                    // An active EGM session (gofa-egm) deliberately keeps RAPID's execution
                    // state at 'running' for the whole session while closing T_ROB1's socket —
                    // the exact same shape as a genuine socket wedge. Consumers that treat
                    // "running but socket down" as a fault (e.g. flows/watchdog_flow.json) must
                    // also check this flag, or they'll misdiagnose every EGM session as wedged.
                    egmActive: !!r._egmActive,
                    errors: results.filter(function(x) { return !x.ok; }).map(function(x) { return x.label + ': ' + x.error; })
                };
                msg.payload = payload;

                var statusText = payload.ok ? 'ok ' + (Date.now() - t0) + 'ms'
                                : !rwsOk     ? 'RWS unreachable'
                                : 'socket unreachable';
                var statusFill = payload.ok ? 'green' : (!rwsOk ? 'red' : 'yellow');
                var statusShape = payload.ok ? 'dot' : 'ring';

                if (payload.ok && (socketStatus === 'mismatch' || backgroundStatus === 'mismatch')) {
                    statusFill = 'yellow';
                    var mismatchVersion = socketStatus === 'mismatch' ? socketVersion : backgroundVersion;
                    statusText = 'ok, module v' + mismatchVersion + ' mismatch (expected v' + PALETTE_VERSION + ')';
                }

                node.status({ fill: statusFill, shape: statusShape, text: statusText });

                send(msg); done();
            });
        });
    }
    RED.nodes.registerType('gofa-connection-status', GoFaConnectionStatusNode);

    RED.httpAdmin.get('/gofa-connection-status/:id/test', RED.auth.needsPermission('gofa-connection-status.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        function settled(label, promise) {
            return promise.then(
                function(value) { return { label: label, ok: true, value: value }; },
                function(err)   { return { label: label, ok: false, error: err.message }; }
            );
        }
        var t0 = Date.now();
        Promise.all([
            settled('ctrlstate', robot.rwsGet('/rw/panel/ctrl-state')),
            settled('opmode',    robot.rwsGet('/rw/panel/opmode')),
            settled('execution', robot.rwsGet('/rw/rapid/execution')),
            settled('speed',     robot.rwsGet('/rw/panel/speedratio')),
            settled('socket', (function() {
                var s0 = Date.now();
                return robot.socketSend({ cmd: 'ping' }).then(function(resp) {
                    if (!resp.startsWith('OK:')) throw new Error('unexpected reply: ' + resp);
                    return Date.now() - s0;
                });
            })()),
            settled('background', (function() {
                var b0 = Date.now();
                return robot.socketSend({ cmd: 'ping' }, robot.backgroundPort).then(function(resp) {
                    if (!resp.startsWith('OK:')) throw new Error('unexpected reply: ' + resp);
                    return Date.now() - b0;
                });
            })())
        ]).then(function(results) {
            var find = function(label) { return results.filter(function(x) { return x.label === label; })[0]; };
            var ctrlstate  = find('ctrlstate');
            var opmode     = find('opmode');
            var execution  = find('execution');
            var speed      = find('speed');
            var socket     = find('socket');
            var background = find('background');
            var rwsOk = ctrlstate.ok || opmode.ok || execution.ok || speed.ok;

            var socketVersion = socket.ok ? robot.getLastPingVersion() : null;
            var socketStatus = !socket.ok || socketVersion === null ? 'unknown' : (socketVersion === PALETTE_VERSION ? 'match' : 'mismatch');
            var backgroundVersion = background.ok ? robot.getLastPingVersion(robot.backgroundPort) : null;
            var backgroundStatus = !background.ok || backgroundVersion === null ? 'unknown' : (backgroundVersion === PALETTE_VERSION ? 'match' : 'mismatch');

            res.json({
                ok: rwsOk && socket.ok,
                ip: robot.ip,
                rws: {
                    ok:     rwsOk,
                    motors: ctrlstate.ok ? robot.parseXhtml(ctrlstate.value, 'ctrlstate')      : null,
                    mode:   opmode.ok    ? robot.parseXhtml(opmode.value, 'opmode')             : null,
                    rapid:  execution.ok ? robot.parseXhtml(execution.value, 'ctrlexecstate')   : null,
                    speed:  speed.ok     ? parseInt(robot.parseXhtml(speed.value, 'speedratio')) || 0 : null
                },
                socket: socket.ok ? { ok: true, rtt: socket.value } : { ok: false, error: socket.error },
                background: background.ok ? { ok: true, rtt: background.value } : { ok: false, error: background.error },
                moduleVersion: {
                    expected: PALETTE_VERSION,
                    socket: { version: socketVersion, status: socketStatus },
                    background: { version: backgroundVersion, status: backgroundStatus }
                },
                egmActive: !!robot._egmActive,
                errors: results.filter(function(x) { return !x.ok; }).map(function(x) { return x.label + ': ' + x.error; }),
                duration: Date.now() - t0
            });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
