'use strict';
module.exports = function(RED) {
    function GoFaPointListNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            msg.payload = node.robot.getPoints();
            node.status({ fill: 'green', shape: 'dot', text: msg.payload.length + ' points' });
            send(msg); done();
        });
    }
    RED.nodes.registerType('gofa-point-list', GoFaPointListNode);
};
