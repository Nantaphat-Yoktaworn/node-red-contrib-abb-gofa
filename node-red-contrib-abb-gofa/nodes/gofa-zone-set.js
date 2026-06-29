'use strict';
module.exports = function(RED) {
    var VALID_ZONES = ['fine','z1','z5','z10','z20','z50','z100'];

    function GoFaZoneSetNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.zone  = config.zone || 'z10';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var zone;
            if (typeof msg.payload === 'string' && msg.payload !== '') {
                zone = msg.payload.toLowerCase();
            } else {
                zone = node.zone;
            }

            if (VALID_ZONES.indexOf(zone) === -1) {
                node.error('Invalid zone: ' + zone + '. Must be one of: ' + VALID_ZONES.join(', '), msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad zone' });
                return done();
            }

            var cmd = 'ZONE' + zone.toUpperCase();
            node.status({ fill: 'blue', shape: 'dot', text: zone });

            node.robot.socketSend(cmd).then(function(resp) {
                if (!resp.startsWith('OK:')) throw new Error('Robot error: ' + resp);
                msg.payload = { ok: true, zone: zone };
                node.status({ fill: 'green', shape: 'dot', text: zone });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-zone-set', GoFaZoneSetNode);
};
