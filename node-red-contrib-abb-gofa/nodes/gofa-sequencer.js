'use strict';
var requireAdminAuth = require('./lib/require-admin-auth');
var gate = require('./lib/gate');
var resolveMoveType = require('./gofa-robot').resolveMoveType;
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
        this.storage  = config.storage  || 'local';
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
            var steps     = (p.steps     != null) ? p.steps     : node.steps;
            var dwell     = (p.dwell     != null) ? p.dwell     : node.dwell;
            var loop      = (p.loop      != null) ? p.loop      : node.loop;
            var pingpong  = (p.pingpong  != null) ? p.pingpong  : node.pingpong;
            var count     = (p.count     != null) ? p.count     : node.count;
            var moveType  = resolveMoveType(p.moveType, node.moveType);
            var storage   = p.storage || node.storage;
            // startStep is 1-based; clamp to valid range after cmds is built
            var startStep = (p.startStep != null) ? Math.max(1, parseInt(p.startStep) || 1) : 1;

            if (!steps || !steps.length) { node.warn('No steps configured'); return done(); }

            r._seqRunning = true;

            // Fetch the whole points array once up front (one RWS round trip for
            // remote storage, not one per step), then resolve steps against it
            // synchronously exactly like before — only the source of the array
            // changes between local/remote, nothing below this point does.
            var pointsPromise = (storage === 'remote') ? r.remoteGetPoints() : Promise.resolve(r.getPoints());

            pointsPromise.then(function(allPoints) {
                function findPt(nameOrId) {
                    return allPoints.find(function(pt) { return pt.id === nameOrId || pt.name === nameOrId; }) || null;
                }

                var cmds = [];
                for (var i = 0; i < steps.length; i++) {
                    var pt = findPt(steps[i].name);
                    if (!pt) { node.warn('Point not found: ' + steps[i].name); continue; }
                    var stepMoveType = resolveMoveType(steps[i].moveType, moveType);
                    var obj = r.gotoObj(pt.target, stepMoveType);
                    if (!obj) { node.warn('Point has invalid data (NaN): ' + pt.name); continue; }
                    cmds.push({ name: pt.name, obj: obj, moveType: stepMoveType, dwell: steps[i].dwell != null ? steps[i].dwell : null });
                }
                if (!cmds.length) {
                    node.error('No valid points in sequence', msg);
                    r._seqRunning = false;
                    return done();
                }

                if (pingpong) {
                    cmds = cmds.concat(cmds.slice(0, cmds.length - 1).reverse());
                }

                // clamp startStep to valid index (0-based internally)
                var startIdx = Math.min(startStep - 1, cmds.length - 1);

                r._seqStop = false;
                var total = cmds.length;
                var loopCount = 0;
                node.status({ fill: 'blue', shape: 'dot', text: 'running...' });

                function finish(err) { r._seqRunning = false; done(err); }

                function runStep(idx) {
                    if (r._seqStop) {
                        node.status({ fill: 'yellow', shape: 'ring', text: 'stopped' });
                        var stopMsg = RED.util.cloneMessage(msg);
                        stopMsg.payload = { done: false, stopped: true, loops: loopCount };
                        send([null, stopMsg]);
                        return finish();
                    }
                    if (idx >= cmds.length) {
                        loopCount++;
                        if (loop && (count === 0 || loopCount < count)) {
                            return runStep(0);
                        }
                        node.status({ fill: 'green', shape: 'dot', text: 'done' });
                        var doneMsg = RED.util.cloneMessage(msg);
                        doneMsg.payload = { done: true, loops: loopCount };
                        send([null, doneMsg]);
                        return finish();
                    }
                    var c = cmds[idx];
                    var stepDwell = (c.dwell != null) ? c.dwell : dwell;
                    var loopLabel = (loop && count > 0) ? ' [' + (loopCount + 1) + '/' + count + ']' : '';
                    node.status({ fill: 'blue', shape: 'dot', text: (idx + 1) + '/' + total + ' ' + c.name + loopLabel });
                    r.socketSend(c.obj).then(function(ack) {
                        if (!ack.startsWith('OK:')) {
                            node.warn('Step ' + (idx + 1) + ' (' + c.name + ') got: ' + ack);
                        }
                        var stepMsg = RED.util.cloneMessage(msg);
                        stepMsg.payload = { step: idx + 1, total: total, name: c.name, ack: ack, loop: loopCount + 1, moveType: c.moveType };
                        send([stepMsg, null]);
                        setTimeout(function() { runStep(idx + 1); }, stepDwell);
                    }).catch(function(err) {
                        node.status({ fill: 'red', shape: 'ring', text: 'error at step ' + (idx + 1) });
                        var errMsg = RED.util.cloneMessage(msg);
                        errMsg.payload = { ok: false, error: err.message, step: idx + 1, name: c.name };
                        node.error(err, msg);
                        send([null, errMsg]); finish(err);
                    });
                }

                runStep(startIdx);
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
        var dwell = parseInt(req.body.dwell) || 800;
        var loop = req.body.loop === true;
        var pingpong = req.body.pingpong === true;
        var count = parseInt(req.body.count) || 0;
        var moveType = resolveMoveType(req.body.moveType, 'J');
        var storage = req.body.storage || 'local';

        if (!steps || !steps.length) {
            return res.status(400).json({ error: 'No steps configured' });
        }

        robot._seqRunning = true;
        robot._seqStop = false;

        var pointsPromise = (storage === 'remote') ? robot.remoteGetPoints() : Promise.resolve(robot.getPoints());

        pointsPromise.then(function(allPoints) {
            function findPt(nameOrId) {
                return allPoints.find(function(pt) { return pt.id === nameOrId || pt.name === nameOrId; }) || null;
            }

            var cmds = [];
            for (var i = 0; i < steps.length; i++) {
                var pt = findPt(steps[i].name);
                if (!pt) continue;
                var stepMoveType = resolveMoveType(steps[i].moveType, moveType);
                var obj = robot.gotoObj(pt.target, stepMoveType);
                if (!obj) continue;
                cmds.push({ name: pt.name, obj: obj, moveType: stepMoveType, dwell: steps[i].dwell != null ? steps[i].dwell : null });
            }

            if (!cmds.length) {
                robot._seqRunning = false;
                return res.status(400).json({ error: 'No valid points found in sequence' });
            }

            if (pingpong) {
                cmds = cmds.concat(cmds.slice(0, cmds.length - 1).reverse());
            }

            var loopCount = 0;

            function runStep(idx) {
                if (robot._seqStop) {
                    robot._seqRunning = false;
                    return;
                }
                if (idx >= cmds.length) {
                    loopCount++;
                    if (loop && (count === 0 || loopCount < count)) {
                        return runStep(0);
                    }
                    robot._seqRunning = false;
                    return;
                }
                var c = cmds[idx];
                var stepDwell = (c.dwell != null) ? c.dwell : dwell;

                robot.socketSend(c.obj).then(function(ack) {
                    if (!ack.startsWith('OK:')) {
                        robot.warn('gofa-sequencer panel: step ' + (idx + 1) + ' (' + c.name + ') got: ' + ack);
                    }
                    setTimeout(function() { runStep(idx + 1); }, stepDwell);
                }).catch(function(err) {
                    robot.warn('gofa-sequencer panel: sequence aborted at step ' + (idx + 1) + ' (' + c.name + '): ' + err.message);
                    robot._seqRunning = false;
                });
            }

            res.json({ ok: true, message: 'Sequence started', totalSteps: cmds.length });

            runStep(0);
        }).catch(function(err) {
            robot._seqRunning = false;
            res.status(502).json({ error: err.message });
        });
    });
};
