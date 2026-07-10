'use strict';
module.exports = function(RED) {
    function GoFaRapidVarWriteNode(config) {
        RED.nodes.createNode(this, config);
        this.robot    = RED.nodes.getNode(config.robot);
        this.variable = config.variable || '';
        this.value    = config.value    !== undefined ? config.value : '';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var variable = node.variable;
            var value    = node.value;

            if (msg.payload !== null && msg.payload !== undefined) {
                if (typeof msg.payload === 'object') {
                    if (msg.payload.variable !== undefined) variable = msg.payload.variable;
                    if (msg.payload.value    !== undefined) value    = msg.payload.value;
                } else {
                    value = msg.payload;
                }
            }

            if (!variable) {
                msg.payload = { ok: false, error: 'No variable name configured' };
                node.error('No variable name configured', msg);
                node.status({ fill: 'red', shape: 'ring', text: 'no variable' });
                send(msg); return done();
            }

            node.status({ fill: 'blue', shape: 'dot', text: variable + '=' + value });

            var parsedValue = value;
            var isNumericString = typeof value === 'string' && value !== '' && !isNaN(Number(value));
            if (isNumericString) {
                var isStringPrefix = variable.toLowerCase().startsWith('s');
                if (!isStringPrefix) {
                    parsedValue = Number(value);
                }
            }

            node.robot.socketSend({ cmd: 'setvar', name: variable, val: parsedValue })
            .then(function(reply) {
                if (reply.startsWith('OK:SETVAR')) {
                    msg.payload = { ok: true, variable: variable, value: String(value) };
                    node.status({ fill: 'green', shape: 'dot', text: variable + '=' + value });
                    send(msg); done();
                } else {
                    var hint = '';
                    if (reply === 'ERR:UNKNOWN_VAR') {
                        hint = ' — add "' + variable.toUpperCase() + '" to TryGetVar/TrySetVar in MainModule.mod';
                    } else if (reply === 'ERR:PARSE') {
                        hint = ' — value "' + value + '" cannot be parsed as the variable\'s RAPID type';
                    }
                    var fullMsg = reply + hint;
                    msg.payload = { ok: false, error: fullMsg };
                    node.status({ fill: 'red', shape: 'ring', text: reply });
                    node.error(fullMsg, msg);
                    send(msg); done(new Error(fullMsg));
                }
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err.message, msg);
                send(msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-rapid-var-write', GoFaRapidVarWriteNode);
};
