'use strict';
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
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var r = node.robot;
            if (r._seqRunning) { node.warn('Sequence already running'); return done(); }

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
                if (!cmds.length) { node.error('No valid points in sequence', msg); return done(); }

                if (pingpong) {
                    cmds = cmds.concat(cmds.slice(0, cmds.length - 1).reverse());
                }

                // clamp startStep to valid index (0-based internally)
                var startIdx = Math.min(startStep - 1, cmds.length - 1);

                r._seqStop = false;
                r._seqRunning = true;
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
                done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-sequencer', GoFaSequencerNode);
};
