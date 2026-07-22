'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');

var STOP_BODY  = 'stopmode=stop&usetsp=normal';
var START_BODY = 'regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false';

module.exports = function(RED) {
    // "immediate": RWS execution-stop halts an in-progress blocking move at once
    // — the socket serve loop can't, since it's blocked inside the Move
    // instruction (moves run without \Conc since 2.4.2). RWS stop also stops
    // T_ROB1's socket server (it's part of main()), so resetpp + start rebuilds
    // it. main() re-runs with NO motion, so the arm stays exactly where it
    // halted (does not auto-home) — confirmed live. resetpp BEFORE start so it
    // restarts from the top of main() instead of resuming the interrupted move.
    // Attempting a RAPID interrupt/TRAP to abort the move without a restart was
    // tried live and rejected: it halts the arm but the aborted MoveAbsJ never
    // returns, hanging the serve loop (see ideas/issue-3-midmove-stop-plan.md).
    function immediateStop(robot) {
        // The real success criterion is "the serve loop is back", not "every RWS
        // call in the sequence returned 2xx". A concurrent execution-control
        // operation (a second gofa-stop-motion, or gofa-rapid-exec) can win the
        // controller's execution-orchestration lock and 403 one of our calls
        // ("Orchestration already active") — but it is itself stopping+restarting
        // the program, so the robot still ends stopped and healthy. Confirmed
        // live: two concurrent immediate stops leave rapid=running/motoron. So we
        // remember any sequence error but let waitForSocket be the verdict —
        // swallow the error if the socket comes back, surface it only if it does not.
        var seqErr = null;
        return robot.rwsPost('/rw/rapid/execution/stop', STOP_BODY)
            .then(function() { return robot.withMastership(function() { return robot.rwsPost('/rw/rapid/execution/resetpp', ''); }); })
            .then(function() { return robot.rwsPost('/rw/rapid/execution/start', START_BODY); })
            .catch(function(err) { seqErr = err; })
            .then(function() { return waitForSocket(robot, 10000); })
            .catch(function(err) { throw seqErr || err; });
    }

    // Poll the socket PING until the serve loop is back (proof start actually
    // ran — RWS start returns HTTP 200 even when it silently didn't start).
    function waitForSocket(robot, timeoutMs) {
        var deadline = Date.now() + timeoutMs;
        function attempt() {
            return robot.socketSend({ cmd: 'ping' }).then(function(reply) {
                if (reply !== 'OK:PING') throw new Error('unexpected reply: ' + reply);
            }).catch(function(err) {
                if (Date.now() >= deadline) {
                    throw new Error('stopped, but the socket server did not come back after restart (' +
                        err.message + ') — check motors are on and the controller is in Auto');
                }
                return new Promise(function(res){ setTimeout(res, 300); }).then(attempt);
            });
        }
        return attempt();
    }

    // "queued": the legacy socket STOP — works on any module, but the serve loop
    // can't process it until the current blocking move finishes, so it only
    // cancels a move that hasn't started yet (or halts a jog).
    function queuedStop(robot) {
        return robot.socketSend({ cmd: 'stop' }).then(function(resp) {
            if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
        });
    }

    function resolveMode(configMode, payload) {
        var mode = (configMode === 'queued') ? 'queued' : 'immediate';
        var override = (typeof payload === 'string') ? payload.toLowerCase()
                     : (payload && payload.mode) ? String(payload.mode).toLowerCase() : null;
        if (override === 'immediate' || override === 'queued') mode = override;
        return mode;
    }

    function GoFaStopMotionNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.mode  = config.mode || 'immediate';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var mode = resolveMode(node.mode, msg.payload);
            node.status({ fill: 'blue', shape: 'dot', text: mode === 'immediate' ? 'stopping (immediate)...' : 'stopping (queued)...' });

            var run = (mode === 'immediate') ? immediateStop(node.robot) : queuedStop(node.robot);
            run.then(function() {
                msg.payload = { ok: true, mode: mode };
                node.status({ fill: 'green', shape: 'dot', text: 'stopped' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message, mode: mode };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-stop-motion', GoFaStopMotionNode);

    RED.httpAdmin.post('/gofa-stop-motion/:id/stop', requireAdminAuth(RED, 'gofa-stop-motion.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var mode = (req.body && req.body.mode === 'queued') ? 'queued' : 'immediate';
        var run = (mode === 'immediate') ? immediateStop(robot) : queuedStop(robot);
        run.then(function() {
            res.json({ ok: true, mode: mode });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
