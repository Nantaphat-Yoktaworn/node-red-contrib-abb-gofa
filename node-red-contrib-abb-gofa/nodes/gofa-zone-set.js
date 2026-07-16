'use strict';
var gate = require('./lib/gate');
module.exports = function(RED) {
    var VALID_ZONES = ['fine','z1','z5','z10','z20','z50','z100'];

    function GoFaZoneSetNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.zone  = config.zone || 'z10';
        var node = this;

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var zone;
            if (typeof msg.payload === 'string' && msg.payload !== '') {
                zone = msg.payload.toLowerCase();
            } else {
                zone = node.zone;
            }

            if (VALID_ZONES.indexOf(zone) === -1) {
                msg.payload = { ok: false, error: 'Invalid zone: ' + zone + '. Must be one of: ' + VALID_ZONES.join(', ') };
                node.error('Invalid zone: ' + zone + '. Must be one of: ' + VALID_ZONES.join(', '), msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad zone' });
                send(msg); return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: zone });

            node.robot.socketSend({ cmd: 'zone', val: zone.toUpperCase() }).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true, zone: zone };
                node.status({ fill: 'green', shape: 'dot', text: zone });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-zone-set', GoFaZoneSetNode);

    RED.httpAdmin.post('/gofa-zone-set/:id/set', RED.auth.needsPermission('gofa-zone-set.write'), function(req, res) {
        var robot = RED.nodes.getNode(req.params.id);
        if (!robot || typeof robot.socketSend !== 'function') {
            return res.status(400).json({ error: 'Robot config node not found — deploy the flow first' });
        }
        var zone = (req.body.zone || 'z10').toLowerCase();
        if (VALID_ZONES.indexOf(zone) === -1) {
            return res.status(400).json({ error: 'Invalid zone: ' + zone });
        }

        robot.socketSend({ cmd: 'zone', val: zone.toUpperCase() }).then(function(resp) {
            if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
            res.json({ ok: true, zone: zone });
        }).catch(function(err) {
            res.status(502).json({ error: err.message });
        });
    });
};
