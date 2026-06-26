'use strict';
module.exports = function(RED) {
    function GoFaStopSeqNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            node.robot._seqStop = true;
            msg.payload = { ok: true, message: 'stop requested' };
            node.status({ fill: 'yellow', shape: 'ring', text: 'stop sent' });
            send(msg); done();
        });
    }
    RED.nodes.registerType('gofa-stop-seq', GoFaStopSeqNode);
};
