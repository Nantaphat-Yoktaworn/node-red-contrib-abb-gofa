'use strict';
module.exports = function(RED) {
    function GoFaSequencerNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.steps    = config.steps    || [];
        this.dwell    = parseInt(config.dwell) || 800;
        this.loop     = config.loop     || false;
        this.pingpong = config.pingpong || false;
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var r = node.robot;
            if (r._seqRunning) { node.warn('Sequence already running'); return done(); }

            // runtime overrides from msg.payload (used by HTTP dashboard endpoint)
            var p = msg.payload || {};
            var steps    = (p.steps    != null) ? p.steps    : node.steps;
            var dwell    = (p.dwell    != null) ? p.dwell    : node.dwell;
            var loop     = (p.loop     != null) ? p.loop     : node.loop;
            var pingpong = (p.pingpong != null) ? p.pingpong : node.pingpong;

            if (!steps || !steps.length) { node.warn('No steps configured'); return done(); }

            var cmds = [];
            for (var i = 0; i < steps.length; i++) {
                var pt = r.findPoint(steps[i].name);
                if (!pt) { node.warn('Point not found: ' + steps[i].name); continue; }
                var tok = r.gotoToken(pt.target);
                if (!tok) { node.warn('Point has invalid data (NaN): ' + pt.name); continue; }
                cmds.push({ name: pt.name, token: tok });
            }
            if (!cmds.length) { node.error('No valid points in sequence'); return done(); }

            if (pingpong) {
                cmds = cmds.concat(cmds.slice(0, cmds.length - 1).reverse());
            }

            r._seqStop = false;
            r._seqRunning = true;
            var total = cmds.length;
            node.status({ fill: 'blue', shape: 'dot', text: 'running...' });

            function finish(err) { r._seqRunning = false; done(err); }

            function runStep(idx) {
                if (r._seqStop) {
                    node.status({ fill: 'yellow', shape: 'ring', text: 'stopped' });
                    send([null, { payload: { done: false, stopped: true } }]);
                    return finish();
                }
                if (idx >= cmds.length) {
                    if (loop) return runStep(0);
                    node.status({ fill: 'green', shape: 'dot', text: 'done' });
                    send([null, { payload: { done: true } }]);
                    return finish();
                }
                var c = cmds[idx];
                node.status({ fill: 'blue', shape: 'dot', text: (idx + 1) + '/' + total + ' ' + c.name });
                r.socketSend(c.token).then(function(ack) {
                    var stepMsg = RED.util.cloneMessage(msg);
                    stepMsg.payload = { step: idx + 1, total: total, name: c.name, ack: ack };
                    send([stepMsg, null]);
                    setTimeout(function() { runStep(idx + 1); }, dwell);
                }).catch(function(err) {
                    node.status({ fill: 'red', shape: 'ring', text: 'error at step ' + (idx + 1) });
                    node.error(err, msg); finish(err);
                });
            }

            runStep(0);
        });
    }
    RED.nodes.registerType('gofa-sequencer', GoFaSequencerNode);
};
