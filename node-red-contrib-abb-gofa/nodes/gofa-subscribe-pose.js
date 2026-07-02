'use strict';

module.exports = function(RED) {
    function GoFaSubscribePoseNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.interval = parseInt(config.interval) || 500;
        var node = this;
        node._timer   = null;
        node._running = false;

        function poll() {
            if (!node.robot || !node._running) return;
            node.robot.rwsGet('/rw/motionsystem/mechunits/ROB_1/robtarget?tool=tool0&wobj=wobj0&coordinate=Base')
            .then(function(body) {
                var p = node.robot.parseXhtml;
                var x  = parseFloat(p(body, 'x'));
                var y  = parseFloat(p(body, 'y'));
                var z  = parseFloat(p(body, 'z'));
                var q1 = parseFloat(p(body, 'q1'));
                var q2 = parseFloat(p(body, 'q2'));
                var q3 = parseFloat(p(body, 'q3'));
                var q4 = parseFloat(p(body, 'q4'));
                node.status({ fill: 'green', shape: 'dot',
                    text: 'x=' + x.toFixed(1) + ' y=' + y.toFixed(1) });
                node.send({ payload: { ok: true, x: x, y: y, z: z, q1: q1, q2: q2, q3: q3, q4: q4 } });
                if (node._running) node._timer = setTimeout(poll, node.interval);
            })
            .catch(function(err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err);
                if (node._running) node._timer = setTimeout(poll, node.interval);
            });
        }

        function startPolling() {
            if (node._running) return;
            node._running = true;
            node.status({ fill: 'yellow', shape: 'ring', text: 'polling' });
            poll();
        }

        function stopPolling() {
            node._running = false;
            if (node._timer) { clearTimeout(node._timer); node._timer = null; }
            node.status({ fill: 'grey', shape: 'ring', text: 'stopped' });
        }

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            if (node._running) {
                stopPolling();
            } else {
                var raw = msg.payload;
                if (raw && typeof raw.interval === 'number') {
                    node.interval = Math.max(100, Math.round(raw.interval));
                }
                startPolling();
            }
            done();
        });

        node.on('close', function(done) {
            stopPolling();
            done();
        });
    }
    RED.nodes.registerType('gofa-subscribe-pose', GoFaSubscribePoseNode);
};
