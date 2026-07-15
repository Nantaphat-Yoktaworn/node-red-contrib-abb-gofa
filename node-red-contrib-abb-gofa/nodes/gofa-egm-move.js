'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaEgmMoveNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) {
                node.error('gofa-egm-move: No robot configured', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no robot' });
                return done();
            }

            var payload = msg.payload;
            var joints = Array.isArray(payload) ? payload
                       : (payload && Array.isArray(payload.joints)) ? payload.joints
                       : null;
            if (!joints || joints.length !== 6 ||
                joints.some(function(j) { return typeof j !== 'number' || !isFinite(j); })) {
                node.error('gofa-egm-move: msg.payload must be a 6-number joint array or {joints:[...]}', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad target' });
                return done();
            }

            // Normalized to a bare [j1..j6] array on both outputs — gofa-movej
            // accepts this shape directly, so the fallback output can be wired
            // straight into it with no change node in between.
            msg.payload = joints;

            if (node.robot._egmActive) {
                node.robot._egmTarget = joints;
                node.status({ fill: 'green', shape: 'dot', text: 'target set' });
                send([msg, null]);
            } else {
                node.status({ fill: 'yellow', shape: 'ring', text: 'EGM not active — fallback' });
                send([null, msg]);
            }
            done();
        });
    }
    RED.nodes.registerType('gofa-egm-move', GoFaEgmMoveNode);
};
