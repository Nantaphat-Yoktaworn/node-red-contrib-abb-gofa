'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaPingNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            node.status({ fill: 'blue', shape: 'dot', text: 'pinging...' });
            var t0 = Date.now();

            node.robot.socketSend({ cmd: 'ping' }).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                var rtt = Date.now() - t0;
                msg.payload = { ok: true, rtt: rtt };
                node.status({ fill: 'green', shape: 'dot', text: rtt + 'ms' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-ping', GoFaPingNode);

    RED.httpAdmin.get('/gofa-ping/:id/read', RED.auth.needsPermission('gofa-ping.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var t0 = Date.now();
        robot.socketSend({ cmd: 'ping' }).then(function(resp) {
            if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
            var rtt = Date.now() - t0;
            res.json({ ok: true, rtt: rtt });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
