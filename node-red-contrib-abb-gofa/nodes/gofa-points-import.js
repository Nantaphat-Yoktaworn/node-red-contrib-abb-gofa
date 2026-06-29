'use strict';
module.exports = function(RED) {
    function GoFaPointsImportNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }
            var arr = Array.isArray(msg.payload) ? msg.payload
                    : (msg.payload && Array.isArray(msg.payload.points)) ? msg.payload.points
                    : null;
            if (!arr) {
                node.error('msg.payload must be an array of points or {points:[...]}', msg);
                return done();
            }
            node.robot._points = arr;
            node.robot._savePoints();
            msg.payload = { ok: true, count: arr.length };
            node.status({ fill: 'green', shape: 'dot', text: arr.length + ' points imported' });
            send(msg); done();
        });
    }
    RED.nodes.registerType('gofa-points-import', GoFaPointsImportNode);
};
