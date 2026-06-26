'use strict';
module.exports = function(RED) {
    function GoFaDeletePointNode(config) {
        RED.nodes.createNode(this, config);
        this.robot     = RED.nodes.getNode(config.robot);
        this.pointName = config.pointName || '';
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var p = msg.payload || {};
            var nameOrId = p.name || p.id || node.pointName;
            var pt = node.robot.findPoint(nameOrId);
            if (!pt) {
                msg.payload = { ok: false, error: 'Point not found: ' + nameOrId };
                return send(msg), done();
            }
            node.robot.deletePoint(pt.id);
            msg.payload = { ok: true, deleted: pt, points: node.robot.getPoints() };
            node.status({ fill: 'green', shape: 'dot', text: 'deleted: ' + pt.name });
            send(msg); done();
        });
    }
    RED.nodes.registerType('gofa-delete-point', GoFaDeletePointNode);
};
