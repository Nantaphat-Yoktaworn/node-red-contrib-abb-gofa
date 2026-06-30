'use strict';
module.exports = function(RED) {
    function GoFaRapidExecNode(config) {
        RED.nodes.createNode(this, config);
        this.robot  = RED.nodes.getNode(config.robot);
        this.action = config.action || 'start';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var raw    = msg.payload;
            var action = (typeof raw === 'string' && raw) ? raw
                       : (raw && raw.action)              ? raw.action
                       : node.action;
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

            // RWS 2.0 (OmniCore) path-based actions.
            // resetpp requires edit mastership (/rw/mastership/edit/request).
            // start/stop work without mastership given Remote Start/Stop UAS grant.
            var doAction = action === 'resetpp'
                ? node.robot.withMastership(function() {
                    return node.robot.rwsPost('/rw/rapid/execution/resetpp', '');
                })
                : node.robot.rwsPost('/rw/rapid/execution/' + action, bodies[action]);

            doAction.then(function() {
                msg.payload = { ok: true, action: action };
                node.status({ fill: 'green', shape: 'dot', text: labels[action] });
                send(msg); done();
            })
            .catch(function(err) {
                var hint = '';
                if (err.message.indexOf('-757') >= 0 || err.message.indexOf('not allowed access') >= 0) {
                    hint = ' (requires Remote Start/Stop grant — RobotStudio → Edit User Accounts)';
                }
                msg.payload = { ok: false, error: err.message + hint };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err.message + hint, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-exec', GoFaRapidExecNode);
};
