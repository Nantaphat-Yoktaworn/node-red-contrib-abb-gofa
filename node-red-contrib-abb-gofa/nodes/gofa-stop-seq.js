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
            // Since 2.4.2's \Conc removal, socket 'stop' no longer interrupts a move
            // already executing (HOME/GOTOJ/GOTOL/MOVEJ/MOVEL) - it only cancels one
            // that hasn't started yet. So this stops the sequence from advancing past
            // the current step, but that step's own move still runs to completion;
            // the _seqStop flag (checked at the top of each runStep) is what actually
            // prevents the next step from starting.
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
