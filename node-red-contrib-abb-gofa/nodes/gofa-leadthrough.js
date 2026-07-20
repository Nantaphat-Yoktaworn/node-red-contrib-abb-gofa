'use strict';
var gate = require('./lib/gate');

function readLeadThroughState(robot) {
    return robot.rwsGet('/rw/motionsystem/mechunits/ROB_1/lead-through').then(function(body) {
        return robot.parseXhtml(body, 'status');
    });
}
function waitForLeadThroughState(robot, want, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    function poll() {
        return readLeadThroughState(robot).then(function(state) {
            if (state === want) return state;
            if (Date.now() >= deadline) {
                var err = new Error('Lead-through did not reach "' + want + '" (now "' + state + '") — check the controller Safety event log (gofa-elog, domain 9)');
                err.leadThroughState = state;
                throw err;
            }
            return new Promise(function(res) { setTimeout(res, 300); }).then(poll);
        });
    }
    return poll();
}

// Clears queued \Conc moves before activating lead-through — otherwise in-flight
// moves keep executing autonomously while hand-guiding is active. Only meaningful
// while RAPID is actually running; if it's already stopped (the normal case for
// this palette's teach flows, which stop RAPID before enabling lead-through)
// there's nothing queued to clear, and T_ROB1's socket server is down anyway
// (it's part of RAPID's own main() loop) — attempting the clear there is
// guaranteed to fail only after the full 5s socket timeout, for no benefit.
// Confirmed live 2026-07-20: this was costing ~5s of every single `enable`
// call in that exact sequence. Checking execstate first (a single fast RWS
// GET, ~10ms) and skipping the clear when already stopped removes that wait
// entirely without changing behavior for the case it actually protects
// (RAPID still running when enable is called).
function clearQueuedMovesIfRunning(robot) {
    return Promise.resolve().then(function() {
        return robot.rwsGet('/rw/rapid/execution');
    }).then(function(body) {
        return robot.parseXhtml(body, 'ctrlexecstate');
    }).catch(function() {
        return null; // state check itself failed — fall back to attempting the clear, same as before this optimization existed
    }).then(function(execstate) {
        if (execstate === 'stopped') return;
        return robot.socketSend({ cmd: 'stop' })
        .then(function(ack) {
            if (!ack.startsWith('OK:')) {
                throw new Error('Stop motion failed: ' + ack);
            }
        })
        .catch(function(err) {
            var isSocketError = err.message && (
                err.message.indexOf('socket') >= 0 ||
                err.message.indexOf('connect') >= 0 ||
                err.message.indexOf('ECONNREFUSED') >= 0
            );
            if (!isSocketError) {
                throw err;
            }
        });
    });
}

module.exports = function(RED) {
    function GoFaLeadthroughNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.action = config.action || 'enable';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            
            var action = node.action;
            if (typeof msg.payload === 'string' && (msg.payload === 'enable' || msg.payload === 'disable')) {
                action = msg.payload;
            } else if (msg.payload && typeof msg.payload === 'object' && msg.payload.action) {
                action = msg.payload.action;
            }

            if (action === 'enable') {
                node.status({ fill: 'blue', shape: 'dot', text: 'checking RAPID state...' });
                clearQueuedMovesIfRunning(node.robot)
                .then(function() {
                    node.status({ fill: 'blue', shape: 'dot', text: 'enabling...' });
                    return node.robot.rwsPost('/rw/motionsystem/mechunits/ROB_1/lead-through', 'status=active');
                })
                .then(function() {
                    // RWS returns 2xx even when the safety controller immediately rejects
                    // activation (e.g. a Tool Speed Supervision violation) and reverts
                    // lead-through back to Inactive a moment later — confirmed live. Poll
                    // the real status instead of trusting the POST response, same "HTTP 200
                    // lies" pattern gofa-rapid-exec's start action already guards against.
                    return waitForLeadThroughState(node.robot, 'Active', 1500);
                })
                .then(function() {
                    msg.payload = { ok: true };
                    node.status({ fill: 'green', shape: 'dot', text: 'enabled' });
                    send(msg); done();
                }).catch(function(err) {
                    msg.payload = { ok: false, error: err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err, msg);
                    send(msg); done(err);
                });
            } else if (action === 'disable') {
                node.status({ fill: 'blue', shape: 'dot', text: 'disabling...' });
                node.robot.rwsPost('/rw/motionsystem/mechunits/ROB_1/lead-through', 'status=inactive')
                .then(function() {
                    // Confirmed live: the real status doesn't always flip to Inactive the
                    // instant the POST returns 2xx (settles a beat later) — poll the same
                    // way 'enable' does instead of trusting the response immediately.
                    return waitForLeadThroughState(node.robot, 'Inactive', 3000);
                })
                .then(function() {
                    msg.payload = { ok: true };
                    node.status({ fill: 'green', shape: 'dot', text: 'disabled' });
                    send(msg); done();
                }).catch(function(err) {
                    msg.payload = { ok: false, error: err.message };
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err, msg);
                    send(msg); done(err);
                });
            } else {
                msg.payload = { ok: false, error: 'Unknown action: ' + action };
                node.error('Unknown action: ' + action, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'unknown action' });
                send(msg); done();
            }
        });
    }
    RED.nodes.registerType('gofa-leadthrough', GoFaLeadthroughNode);

    RED.httpAdmin.get('/gofa-leadthrough/:id/read', RED.auth.needsPermission('gofa-leadthrough.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsGet !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        robot.rwsGet('/rw/motionsystem/mechunits/ROB_1/lead-through')
        .then(function(body) {
            res.json({ ok: true, status: robot.parseXhtml(body, 'status') });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });

    RED.httpAdmin.post('/gofa-leadthrough/:id/toggle', RED.auth.needsPermission('gofa-leadthrough.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.rwsPost !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var action = req.body.action;
        if (action !== 'enable' && action !== 'disable') {
            return res.status(400).json({ error: 'Invalid action: ' + action });
        }

        var p = Promise.resolve();
        if (action === 'enable') {
            p = clearQueuedMovesIfRunning(robot);
        }

        p.then(function() {
            var statusVal = action === 'enable' ? 'active' : 'inactive';
            return robot.rwsPost('/rw/motionsystem/mechunits/ROB_1/lead-through', 'status=' + statusVal);
        }).then(function() {
            return waitForLeadThroughState(robot, action === 'enable' ? 'Active' : 'Inactive', action === 'enable' ? 1500 : 3000);
        }).then(function() {
            res.json({ ok: true });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
