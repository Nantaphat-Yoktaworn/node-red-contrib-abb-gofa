'use strict';
module.exports = function(RED) {
    function GoFaPointsExportNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var points = node.robot.getPoints();
            msg.payload = { ok: true, count: points.length, points: points };
            node.status({ fill: 'green', shape: 'dot', text: points.length + ' points' });
            send(msg); done();
        });
    }
    RED.nodes.registerType('gofa-points-export', GoFaPointsExportNode);
};
