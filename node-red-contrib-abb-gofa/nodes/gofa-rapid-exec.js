'use strict';
module.exports = function(RED) {
    function GoFaRapidExecNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.action = config.action || 'start';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var action = (msg.payload && msg.payload.action) || node.action;
            node.status({ fill: 'blue', shape: 'dot', text: action });

            var bodies = {
                start:   'regain=continue&execmode=continue&cycle=forever&condition=none&stopatbp=disabled&alltaskbytsp=false',
                stop:    'stopmode=stop&usetsp=normal',
                resetpp: ''
            };

            var labels = { start: 'running', stop: 'stopped', resetpp: 'PP reset' };

            if (!bodies.hasOwnProperty(action)) {
                node.error('Unknown action: ' + action + ' (use start, stop, or resetpp)', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'bad action' });
                return done();
            }

            node.robot.rwsPost('/rw/rapid/execution?action=' + action, bodies[action])
            .then(function() {
                msg.payload = { ok: true, action: action };
                node.status({ fill: 'green', shape: 'dot', text: labels[action] });
                send(msg); done();
            })
            .catch(function(err) {
                var hint = err.message.indexOf('405') >= 0 || err.message.indexOf('method not supported') >= 0
                    ? ' (requires PC Interface RobotWare option on controller)'
                    : '';
                msg.payload = { ok: false, error: err.message + hint };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err.message + hint, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-exec', GoFaRapidExecNode);
};
