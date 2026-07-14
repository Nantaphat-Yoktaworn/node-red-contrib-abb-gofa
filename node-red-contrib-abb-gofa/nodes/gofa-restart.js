'use strict';
module.exports = function(RED) {
    function GoFaRestartNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        this.mode  = config.mode || 'restart';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) {
                msg.payload = { ok: false, error: 'No robot configured' };
                node.status({ fill: 'red', shape: 'ring', text: 'no robot' });
                node.error('No robot configured', msg);
                send(msg);
                return done();
            }

            var mode = node.mode;
            if (msg.payload !== null && msg.payload !== undefined) {
                if (typeof msg.payload === 'object' && msg.payload.mode !== undefined) {
                    mode = msg.payload.mode;
                } else if (typeof msg.payload === 'string' && msg.payload.trim()) {
                    mode = msg.payload.trim();
                }
            }

            var validModes = ['restart', 'pstart', 'istart', 'xstart', 'bstart', 'shutdown'];
            if (typeof mode !== 'string' || validModes.indexOf(mode.toLowerCase()) === -1) {
                var errStr = 'Invalid restart mode: ' + mode;
                msg.payload = { ok: false, error: errStr };
                node.status({ fill: 'red', shape: 'ring', text: 'invalid mode' });
                node.error(errStr, msg);
                send(msg);
                return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: 'restarting (' + mode + ')...' });

            node.robot.rwsPost('/ctrl', 'restart-mode=' + mode.toLowerCase())
            .then(function() {
                msg.payload = { ok: true, mode: mode };
                node.status({ fill: 'green', shape: 'dot', text: 'restart command sent' });
                send(msg); done();
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-restart', GoFaRestartNode);
};
