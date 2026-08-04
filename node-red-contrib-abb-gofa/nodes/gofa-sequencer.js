'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
var resolveMoveType = require('./gofa-robot').resolveMoveType;

// C1 (2026-08-04): the point-resolution and step-runner logic, implemented once
// and shared by the runtime node and the editor-panel route. These were two
// copies of the same loop that had already drifted (the panel copy silently
// dropped unresolvable points where the node warned about each one).

// Resolves the configured steps against the robot's stored points in ONE round
// trip, returning executable commands plus a note for anything skipped.
function buildCommands(robot, steps, defaultMoveType) {
    return robot.remoteGetPoints().then(function(allPoints) {
        function findPt(nameOrId) {
            return allPoints.find(function(pt) { return pt.id === nameOrId || pt.name === nameOrId; }) || null;
        }
        var cmds = [];
        var skipped = [];
        for (var i = 0; i < steps.length; i++) {
            var pt = findPt(steps[i].name);
            if (!pt) { skipped.push('Point not found: ' + steps[i].name); continue; }
            var stepMoveType = resolveMoveType(steps[i].moveType, defaultMoveType);
            var obj = robot.gotoObj(pt.target, stepMoveType);
            if (!obj) { skipped.push('Point has invalid data (NaN): ' + pt.name); continue; }
            cmds.push({ name: pt.name, obj: obj, moveType: stepMoveType,
                        dwell: steps[i].dwell != null ? steps[i].dwell : null });
        }
        return { cmds: cmds, skipped: skipped };
    });
}

// Drives the visit loop. Every observable event goes through `hooks` so the two
// callers can render progress differently without re-implementing the sequencing,
// the loop/ping-pong arithmetic, or the _seqStop/_seqRunning bookkeeping.
//
// hooks: { onStep, onStopped, onDone, onError, onStatus } — all optional.
function runSequence(robot, cmds, opts, hooks) {
    hooks = hooks || {};
    var dwell     = opts.dwell;
    var loop      = opts.loop;
    var count     = opts.count;
    var startIdx  = opts.startIdx || 0;
    var total     = cmds.length;
    var loopCount = 0;
    var call = function(name, arg) { if (hooks[name]) hooks[name](arg); };

    return new Promise(function(resolve) {
        function finish(err) { robot._seqRunning = false; resolve(err || null); }

        function runStep(idx) {
            if (robot._seqStop) {
                call('onStopped', { done: false, stopped: true, loops: loopCount });
                return finish();
            }
            if (idx >= cmds.length) {
                loopCount++;
                if (loop && (count === 0 || loopCount < count)) return runStep(0);
                call('onDone', { done: true, loops: loopCount });
                return finish();
            }
            var c = cmds[idx];
            var stepDwell = (c.dwell != null) ? c.dwell : dwell;
            var loopLabel = (loop && count > 0) ? ' [' + (loopCount + 1) + '/' + count + ']' : '';
            call('onStatus', { fill: 'blue', shape: 'dot',
                               text: (idx + 1) + '/' + total + ' ' + c.name + loopLabel });

            robot.socketSend(c.obj).then(function(ack) {
                call('onStep', { step: idx + 1, total: total, name: c.name, ack: ack,
                                 loop: loopCount + 1, moveType: c.moveType,
                                 unexpected: !ack.startsWith('OK:') });
                setTimeout(function() { runStep(idx + 1); }, stepDwell);
            }).catch(function(err) {
                call('onError', { ok: false, error: err.message, step: idx + 1, name: c.name, err: err });
                finish(err);
            });
        }
        runStep(startIdx);
    });
}

module.exports = function(RED) {
    function GoFaSequencerNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.steps    = config.steps    || [];
        this.dwell    = parseInt(config.dwell) || 800;
        this.loop     = config.loop     || false;
        this.pingpong = config.pingpong || false;
        this.count    = parseInt(config.count)  || 0;   // 0 = infinite
        this.moveType = resolveMoveType(config.moveType, 'J');
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var r = node.robot;
            if (r._seqRunning) {
                node.warn('Sequence already running. Stopping current sequence.');
                r._seqStop = true;
                node.status({ fill: 'yellow', shape: 'ring', text: 'stopping' });
                r.socketSend({ cmd: 'stop' }).catch(function() {});
                return done();
            }

            var p = msg.payload || {};
            var steps    = (p.steps    != null) ? p.steps    : node.steps;
            var dwell    = (p.dwell    != null) ? p.dwell    : node.dwell;
            var loop     = (p.loop     != null) ? p.loop     : node.loop;
            var pingpong = (p.pingpong != null) ? p.pingpong : node.pingpong;
            var count    = (p.count    != null) ? p.count    : node.count;
            var moveType = resolveMoveType(p.moveType, node.moveType);
            // startStep is 1-based; clamped to the built command list below
            var startStep = (p.startStep != null) ? Math.max(1, parseInt(p.startStep) || 1) : 1;

            if (!steps || !steps.length) { node.warn('No steps configured'); return done(); }

            r._seqRunning = true;

            buildCommands(r, steps, moveType).then(function(built) {
                built.skipped.forEach(function(w) { node.warn(w); });
                var cmds = built.cmds;
                if (!cmds.length) {
                    node.error('No valid points in sequence', msg);
                    r._seqRunning = false;
                    return done();
                }
                if (pingpong) cmds = cmds.concat(cmds.slice(0, cmds.length - 1).reverse());

                r._seqStop = false;
                node.status({ fill: 'blue', shape: 'dot', text: 'running...' });

                return runSequence(r, cmds, {
                    dwell: dwell, loop: loop, count: count,
                    startIdx: Math.min(startStep - 1, cmds.length - 1)
                }, {
                    onStatus: function(s) { node.status(s); },
                    onStep: function(info) {
                        if (info.unexpected) {
                            node.warn('Step ' + info.step + ' (' + info.name + ') got: ' + info.ack);
                        }
                        var stepMsg = RED.util.cloneMessage(msg);
                        stepMsg.payload = { step: info.step, total: info.total, name: info.name,
                                            ack: info.ack, loop: info.loop, moveType: info.moveType };
                        send([stepMsg, null]);
                    },
                    onStopped: function(payload) {
                        node.status({ fill: 'yellow', shape: 'ring', text: 'stopped' });
                        var m = RED.util.cloneMessage(msg); m.payload = payload; send([null, m]);
                    },
                    onDone: function(payload) {
                        node.status({ fill: 'green', shape: 'dot', text: 'done' });
                        var m = RED.util.cloneMessage(msg); m.payload = payload; send([null, m]);
                    },
                    onError: function(info) {
                        node.status({ fill: 'red', shape: 'ring', text: 'error at step ' + info.step });
                        var m = RED.util.cloneMessage(msg);
                        m.payload = { ok: false, error: info.error, step: info.step, name: info.name };
                        node.error(info.err, msg);
                        send([null, m]);
                    }
                }).then(function(err) { done(err || undefined); });
            }).catch(function(err) {
                node.error(err, msg);
                r._seqRunning = false;
                done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-sequencer', GoFaSequencerNode);

    RED.httpAdmin.get('/gofa-sequencer/:id/status', RED.auth.needsPermission('gofa-sequencer.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot) {
            return res.status(400).json({ error: 'Robot config node not found' });
        }
        res.json({ running: !!robot._seqRunning });
    });

    RED.httpAdmin.post('/gofa-sequencer/:id/stop', requireAdminAuth(RED, 'gofa-sequencer.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        robot._seqStop = true;
        robot.socketSend({ cmd: 'stop' }).then(function() {
            res.json({ ok: true, message: 'Stop sent' });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });

    RED.httpAdmin.post('/gofa-sequencer/:id/start', requireAdminAuth(RED, 'gofa-sequencer.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        if (robot._seqRunning) {
            return res.status(400).json({ error: 'Sequence already running' });
        }
        var steps = req.body.steps || [];
        if (!steps.length) {
            return res.status(400).json({ error: 'No steps configured' });
        }
        var moveType = resolveMoveType(req.body.moveType, 'J');
        robot._seqRunning = true;
        robot._seqStop = false;

        buildCommands(robot, steps, moveType).then(function(built) {
            var cmds = built.cmds;
            if (!cmds.length) {
                robot._seqRunning = false;
                return res.status(400).json({ error: 'No valid points found in sequence' });
            }
            if (req.body.pingpong === true) cmds = cmds.concat(cmds.slice(0, cmds.length - 1).reverse());

            // Respond as soon as the sequence is validated and starting — the run
            // itself outlives this request.
            res.json({ ok: true, message: 'Sequence started', totalSteps: cmds.length,
                       skipped: built.skipped });

            runSequence(robot, cmds, {
                dwell: parseInt(req.body.dwell) || 800,
                loop:  req.body.loop === true,
                count: parseInt(req.body.count) || 0,
                startIdx: 0
            }, {
                onStep: function(info) {
                    if (info.unexpected) {
                        robot.warn('gofa-sequencer panel: step ' + info.step + ' (' + info.name + ') got: ' + info.ack);
                    }
                },
                onError: function(info) {
                    robot.warn('gofa-sequencer panel: sequence aborted at step ' + info.step +
                               ' (' + info.name + '): ' + info.error);
                }
            });
        }).catch(function(err) {
            robot._seqRunning = false;
            res.status(502).json({ error: err.message });
        });
    });
};

module.exports.buildCommands = buildCommands;
module.exports.runSequence   = runSequence;
