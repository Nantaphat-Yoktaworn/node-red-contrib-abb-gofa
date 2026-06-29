'use strict';
module.exports = function(RED) {
    function GoFaSpeedSetNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.speed  = parseInt(config.speed) || 50;
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var raw;
            if (msg.payload !== null && msg.payload !== undefined) {
                raw = (typeof msg.payload === 'object' && msg.payload.speed !== undefined)
                    ? msg.payload.speed
                    : msg.payload;
            } else {
                raw = node.speed;
            }

            var speed = parseInt(raw);
            if (isNaN(speed)) {
                node.error('Invalid speed value: ' + raw, msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad value' });
                return done();
            }
            if (speed < 1)   { node.warn('Speed clamped to 1');   speed = 1;   }
            if (speed > 100) { node.warn('Speed clamped to 100'); speed = 100; }

            node.status({ fill: 'blue', shape: 'dot', text: speed + '%' });

            node.robot.rwsPost('/rw/mastership/request', '')
            .then(function() {
                return node.robot.rwsPost('/rw/panel/speedratio', 'speed-ratio=' + speed);
            })
            .then(function() {
                return node.robot.rwsPost('/rw/mastership/release', '');
            })
            .then(function() {
                msg.payload = { ok: true, speed: speed };
                node.status({ fill: 'green', shape: 'dot', text: speed + '%' });
                send(msg); done();
            })
            .catch(function(err) {
                node.robot.rwsPost('/rw/mastership/release', '').catch(function(){});
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-speed-set', GoFaSpeedSetNode);
};
