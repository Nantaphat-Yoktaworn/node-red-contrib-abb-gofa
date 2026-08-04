'use strict';
var gate = require('./lib/gate');
var PALETTE_VERSION = require('./gofa-robot').PALETTE_VERSION;
var versionsCompatible = require('./gofa-robot').versionsCompatible;

// C1 (2026-08-04): single implementation shared by the runtime node and the
// editor-panel route. These were two ~60-line copies that had already drifted
// apart once (the runtime path was missing the .catch the admin route had —
// bug B3). Probing the controller and shaping the payload now happens here
// exactly once; the two callers only differ in how they deliver the result.
function gatherStatus(r) {
    function settled(label, promise) {
        return promise.then(
            function(value) { return { label: label, ok: true, value: value }; },
            function(err)   { return { label: label, ok: false, error: err.message }; }
        );
    }
    var t0 = Date.now();
    return Promise.all([
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
        // T_ROB1's socket goes down whenever RAPID/T_ROB1 is stopped (teach workflow,
        // EGM session). BackgroundLed.mod runs in a separate SEMISTATIC task that
        // survives that — pinging it splits ok=false into "T_ROB1 socket specifically
        // down" vs. "whole controller unreachable" (RWS also down).
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
        var socketStatus = !socket.ok || socketVersion === null ? 'unknown'
            : (versionsCompatible(socketVersion, PALETTE_VERSION) ? 'match' : 'mismatch');
        var backgroundVersion = background.ok ? r.getLastPingVersion(r.backgroundPort) : null;
        var backgroundStatus = !background.ok || backgroundVersion === null ? 'unknown'
            : (versionsCompatible(backgroundVersion, PALETTE_VERSION) ? 'match' : 'mismatch');

        return {
            payload: {
                ok: rwsOk && socket.ok,
                ip: r.ip,
                rws: {
                    ok:     rwsOk,
                    motors: ctrlstate.ok ? r.parseXhtml(ctrlstate.value, 'ctrlstate')    : null,
                    mode:   opmode.ok    ? r.parseXhtml(opmode.value, 'opmode')          : null,
                    rapid:  execution.ok ? r.parseXhtml(execution.value, 'ctrlexecstate') : null,
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
                errors: results.filter(function(x) { return !x.ok; })
                               .map(function(x) { return x.label + ': ' + x.error; })
            },
            rwsOk: rwsOk,
            socketStatus: socketStatus,
            backgroundStatus: backgroundStatus,
            socketVersion: socketVersion,
            backgroundVersion: backgroundVersion,
            duration: Date.now() - t0
        };
    });
}
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
            node.status({ fill: 'blue', shape: 'dot', text: 'checking...' });

            gatherStatus(node.robot).then(function(res) {
                msg.payload = res.payload;

                var statusText = res.payload.ok ? 'ok ' + res.duration + 'ms'
                               : !res.rwsOk     ? 'RWS unreachable'
                               : 'socket unreachable';
                var statusFill  = res.payload.ok ? 'green' : (!res.rwsOk ? 'red' : 'yellow');
                var statusShape = res.payload.ok ? 'dot' : 'ring';

                if (res.payload.ok && (res.socketStatus === 'mismatch' || res.backgroundStatus === 'mismatch')) {
                    statusFill = 'yellow';
                    var mismatchVersion = res.socketStatus === 'mismatch' ? res.socketVersion : res.backgroundVersion;
                    statusText = 'ok, module v' + mismatchVersion + ' mismatch (expected v' + PALETTE_VERSION + ')';
                }

                node.status({ fill: statusFill, shape: statusShape, text: statusText });
                send(msg); done();
            })
            // B3: gatherStatus settles every probe internally so it cannot reject on
            // an unreachable controller — but a throw in the handling above (a parse
            // blowing up, node.status on a torn-down node) used to leave done()
            // uncalled AND surface as an unhandled rejection, which on Node >=15
            // terminates the process. This node is documented "never raises — safe to
            // poll" and flows/watchdog_flow.json polls it on a timer.
            .catch(function(err) {
                msg.payload = { ok: false, ip: node.robot.ip, error: err.message, errors: [err.message] };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
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
        gatherStatus(robot).then(function(r) {
            res.json(Object.assign({}, r.payload, { duration: r.duration }));
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};

module.exports.gatherStatus = gatherStatus;
