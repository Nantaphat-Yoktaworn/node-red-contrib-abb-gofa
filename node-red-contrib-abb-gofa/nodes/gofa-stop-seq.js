'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaStopSeqNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            node.robot._seqStop = true;
            // Abort the in-progress \Conc move immediately so the robot doesn't
            // finish the current move + full dwell before the flag is checked.
            node.robot.socketSend({ cmd: 'stop' }).catch(function() {});
            msg.payload = { ok: true, message: 'stop requested' };
            node.status({ fill: 'yellow', shape: 'ring', text: 'stop sent' });
            send(msg); done();
        });
    }
    RED.nodes.registerType('gofa-stop-seq', GoFaStopSeqNode);

    RED.httpAdmin.post('/gofa-stop-seq/:id/stop', RED.auth.needsPermission('gofa-stop-seq.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        robot._seqStop = true;
        robot.socketSend({ cmd: 'stop' }).then(function() {
            res.json({ ok: true, message: 'stop requested' });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
