'use strict';
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
                var token = node.robot.gotoToken(pt.target, moveType);
                if (!token) {
                    msg.payload = { ok: false, error: 'Point has invalid data (NaN): ' + pt.name };
                    return send(msg), done();
                }
                node.status({ fill: 'blue', shape: 'dot', text: pt.name + ' (' + moveType + ')' });
                return node.robot.socketSend(token).then(function(ack) {
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
};
