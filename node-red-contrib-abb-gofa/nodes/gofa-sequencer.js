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
            // startStep is 1-based; clamp to valid range after cmds is built
            var startStep = (p.startStep != null) ? Math.max(1, parseInt(p.startStep) || 1) : 1;

            if (!steps || !steps.length) { node.warn('No steps configured'); return done(); }

            var cmds = [];
            for (var i = 0; i < steps.length; i++) {
                var pt = r.findPoint(steps[i].name);
                if (!pt) { node.warn('Point not found: ' + steps[i].name); continue; }
                var stepMoveType = resolveMoveType(steps[i].moveType, moveType);
                var tok = r.gotoToken(pt.target, stepMoveType);
                if (!tok) { node.warn('Point has invalid data (NaN): ' + pt.name); continue; }
                cmds.push({ name: pt.name, token: tok, moveType: stepMoveType, dwell: steps[i].dwell != null ? steps[i].dwell : null });
            }
            if (!cmds.length) { node.error('No valid points in sequence'); return done(); }

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
                r.socketSend(c.token).then(function(ack) {
                    if (!ack.startsWith('OK:')) {
                        node.warn('Step ' + (idx + 1) + ' (' + c.name + ') got: ' + ack);
                    }
                    var stepMsg = RED.util.cloneMessage(msg);
                    stepMsg.payload = { step: idx + 1, total: total, name: c.name, ack: ack, loop: loopCount + 1, moveType: c.moveType };
                    send([stepMsg, null]);
                    setTimeout(function() { runStep(idx + 1); }, stepDwell);
                }).catch(function(err) {
                    node.status({ fill: 'red', shape: 'ring', text: 'error at step ' + (idx + 1) });
                    node.error(err, msg); finish(err);
                });
            }

            runStep(startIdx);
        });
    }
    RED.nodes.registerType('gofa-sequencer', GoFaSequencerNode);
};
