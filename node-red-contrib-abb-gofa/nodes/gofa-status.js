'use strict';
module.exports = function(RED) {
    function GoFaStatusNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }
            var r = node.robot;
            Promise.all([
                r.rwsGet('/rw/panel/ctrl-state'),
                r.rwsGet('/rw/panel/opmode'),
                r.rwsGet('/rw/panel/speedratio'),
                r.rwsGet('/rw/rapid/execution')
            ]).then(function(b) {
                msg.payload = {
                    ctrlstate: r.parseXhtml(b[0], 'ctrlstate'),
                    opmode:    r.parseXhtml(b[1], 'opmode'),
                    speed:     parseInt(r.parseXhtml(b[2], 'speedratio')) || 0,
                    rapid:     r.parseXhtml(b[3], 'ctrlexecstate')
                };
                node.status({ fill:'green', shape:'dot', text: msg.payload.ctrlstate });
                send(msg); done();
            }).catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-status', GoFaStatusNode);
};
