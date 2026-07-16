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

    RED.httpAdmin.get('/gofa-point-list/:id/read', RED.auth.needsPermission('gofa-point-list.read'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot) {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var storage = req.query.storage || 'local';
        var pointsPromise = (storage === 'remote')
            ? (typeof robot.remoteGetPoints === 'function' ? robot.remoteGetPoints() : Promise.reject(new Error('Remote points not supported')))
            : (typeof robot.getPoints === 'function' ? Promise.resolve(robot.getPoints()) : Promise.reject(new Error('Local points not supported')));
        
        pointsPromise.then(function(points) {
            res.json({ ok: true, points: points });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
