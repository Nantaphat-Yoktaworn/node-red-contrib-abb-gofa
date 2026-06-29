'use strict';
module.exports = function(RED) {
    function GoFaRapidVarWriteNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.task     = config.task     || 'T_ROB1';
        this.module   = config.module   || 'MainModule';
        this.variable = config.variable || '';
        this.value    = config.value    !== undefined ? config.value : '';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var task     = node.task;
            var module   = node.module;
            var variable = node.variable;
            var value    = node.value;

            if (msg.payload !== null && msg.payload !== undefined) {
                if (typeof msg.payload === 'object') {
                    if (msg.payload.task     !== undefined) task     = msg.payload.task;
                    if (msg.payload.module   !== undefined) module   = msg.payload.module;
                    if (msg.payload.variable !== undefined) variable = msg.payload.variable;
                    if (msg.payload.value    !== undefined) value    = msg.payload.value;
                } else {
                    value = msg.payload;
                }
            }

            if (!variable) {
                node.error('No variable name configured', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no variable' });
                return done();
            }

            var path = '/rw/rapid/symbol/data/RAPID/' +
                encodeURIComponent(task) + '/' +
                encodeURIComponent(module) + '/' +
                encodeURIComponent(variable);

            var body = 'value=' + encodeURIComponent(String(value));

            node.status({ fill: 'blue', shape: 'dot', text: variable + '=' + value });

            node.robot.rwsPost(path, body)
            .then(function() {
                msg.payload = { ok: true, variable: variable, value: String(value) };
                node.status({ fill: 'green', shape: 'dot', text: variable + '=' + value });
                send(msg); done();
            })
            .catch(function(err) {
                var hint = '';
                if (err.message.indexOf('404') >= 0 ||
                    err.message.indexOf('-1073445866') >= 0 ||
                    err.message.toLowerCase().indexOf('resource not found') >= 0) {
                    hint = ' (requires PC Interface RobotWare option on controller)';
                } else if (err.message.indexOf('405') >= 0 ||
                    err.message.toLowerCase().indexOf('method not supported') >= 0) {
                    hint = ' (RAPID variable write requires PC Interface and/or mastership)';
                }
                var fullMsg = err.message + hint;
                msg.payload = { ok: false, error: fullMsg };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(fullMsg, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-var-write', GoFaRapidVarWriteNode);
};
