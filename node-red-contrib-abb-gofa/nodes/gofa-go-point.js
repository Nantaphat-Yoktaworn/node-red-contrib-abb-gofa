'use strict';
var gate = require('./lib/gate');
var resolveMoveType = require('./gofa-robot').resolveMoveType;
module.exports = function(RED) {
    function GoFaGoPointNode(config) {
        RED.nodes.createNode(this, config);
        this.robot     = RED.nodes.getNode(config.robot);
        this.pointName = config.pointName || '';
        this.moveType  = resolveMoveType(config.moveType, 'J');
        this.storage   = config.storage   || 'local';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var p = msg.payload || {};
            var nameOrId = p.name || p.id || node.pointName;
            var storage  = p.storage || node.storage;
            var findPromise = (storage === 'remote')
                ? node.robot.remoteFindPoint(nameOrId)
                : Promise.resolve(node.robot.findPoint(nameOrId));
            findPromise.then(function(pt) {
                if (!pt) {
                    msg.payload = { ok: false, error: 'Point not found: ' + nameOrId };
                    return send(msg), done();
                }
                var moveType = resolveMoveType(p.moveType, node.moveType);
                var obj = node.robot.gotoObj(pt.target, moveType);
                if (!obj) {
                    msg.payload = { ok: false, error: 'Point has invalid data (NaN): ' + pt.name };
                    return send(msg), done();
                }
                node.status({ fill: 'blue', shape: 'dot', text: pt.name + ' (' + moveType + ')' });
                return node.robot.socketSend(obj).then(function(ack) {
                    var ok = ack.startsWith('OK:');
                    msg.payload = { ok: ok, ack: ack, point: pt, moveType: moveType };
                    node.status({ fill: ok ? 'green' : 'red', shape: 'dot', text: ack });
                    send(msg); done();
                });
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-go-point', GoFaGoPointNode);

    RED.httpAdmin.post('/gofa-go-point/:id/go', RED.auth.needsPermission('gofa-go-point.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot) {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var nameOrId = req.body.pointName;
        var storage = req.body.storage || 'local';
        var moveType = req.body.moveType || 'J';

        if (!nameOrId) {
            return res.status(400).json({ error: 'No point specified' });
        }

        var findPromise = (storage === 'remote')
            ? (typeof robot.remoteFindPoint === 'function' ? robot.remoteFindPoint(nameOrId) : Promise.reject(new Error('Remote storage not supported')))
            : Promise.resolve(typeof robot.findPoint === 'function' ? robot.findPoint(nameOrId) : null);

        findPromise.then(function(pt) {
            if (!pt) {
                return res.status(404).json({ error: 'Point not found: ' + nameOrId });
            }
            if (typeof robot.gotoObj !== 'function' || typeof robot.socketSend !== 'function') {
                return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
            }
            var obj = robot.gotoObj(pt.target, moveType);
            if (!obj) {
                return res.status(400).json({ error: 'Point has invalid data (NaN): ' + pt.name });
            }
            return robot.socketSend(obj).then(function(ack) {
                var ok = ack.startsWith('OK:');
                if (!ok) {
                    throw new Error(ack);
                }
                res.json({ ok: true, ack: ack, point: pt, moveType: moveType });
            });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
