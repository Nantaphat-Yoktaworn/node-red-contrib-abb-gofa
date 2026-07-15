'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaPointListNode(config) {
        RED.nodes.createNode(this, config);
        this.robot   = RED.nodes.getNode(config.robot);
        this.storage = config.storage || 'local';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var storage = (msg.payload && msg.payload.storage) || node.storage;
            var pointsPromise = (storage === 'remote')
                ? node.robot.remoteGetPoints()
                : Promise.resolve(node.robot.getPoints());
            pointsPromise.then(function(points) {
                msg.payload = points;
                node.status({ fill: 'green', shape: 'dot', text: points.length + ' points' });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-point-list', GoFaPointListNode);
};
