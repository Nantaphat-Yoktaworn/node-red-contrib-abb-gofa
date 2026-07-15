'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    function GoFaDeletePointNode(config) {
        RED.nodes.createNode(this, config);
        this.robot     = RED.nodes.getNode(config.robot);
        this.pointName = config.pointName || '';
        this.storage   = config.storage   || 'local';
        var node = this;
        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var p = msg.payload || {};
            var nameOrId = p.name || p.id || node.pointName;
            var storage  = p.storage || node.storage;
            var r = node.robot;

            var findAndDelete = (storage === 'remote')
                ? r.remoteFindPoint(nameOrId).then(function(pt) {
                    if (!pt) return null;
                    return r.remoteDeletePoint(pt.id).then(function() {
                        return r.remoteGetPoints().then(function(points) { return { deleted: pt, points: points }; });
                    });
                })
                : Promise.resolve().then(function() {
                    var pt = r.findPoint(nameOrId);
                    if (!pt) return null;
                    r.deletePoint(pt.id);
                    return { deleted: pt, points: r.getPoints() };
                });

            findAndDelete.then(function(result) {
                if (!result) {
                    msg.payload = { ok: false, error: 'Point not found: ' + nameOrId };
                    return send(msg), done();
                }
                msg.payload = { ok: true, deleted: result.deleted, points: result.points };
                node.status({ fill: 'green', shape: 'dot', text: 'deleted: ' + result.deleted.name });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-delete-point', GoFaDeletePointNode);
};
