'use strict';

module.exports = function(RED) {
    function GoFaFileReadNode(config) {
        RED.nodes.createNode(this, config);
        this.robot      = RED.nodes.getNode(config.robot);
        this.remotePath = config.remotePath || '$HOME/Programs/MainModule.mod';
        this.encoding   = config.encoding   || 'utf8';
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { msg.payload = { ok: false, error: 'No robot configured' }; node.error('No robot configured', msg); send(msg); return done(); }

            var remotePath = node.remotePath;
            var encoding   = node.encoding;

            if (msg.payload && typeof msg.payload === 'string') {
                remotePath = msg.payload;
            } else if (msg.payload && typeof msg.payload === 'object') {
                if (msg.payload.remotePath) remotePath = msg.payload.remotePath;
                if (msg.payload.encoding)   encoding   = msg.payload.encoding;
            }

            node.status({ fill: 'blue', shape: 'dot', text: 'reading…' });

            var robot = node.robot;
            robot.requestRaw('GET', '/fileservice/' + remotePath, null, { accept: '*/*' })
            .then(function(res) {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    throw new Error('HTTP ' + res.statusCode + ' ' + remotePath);
                }
                var content = encoding === 'base64'
                    ? res.body.toString('base64')
                    : res.body.toString('utf8');
                msg.payload = {
                    ok: true,
                    remotePath: remotePath,
                    content: content,
                    bytes: res.body.length
                };
                node.status({ fill: 'green', shape: 'dot', text: res.body.length + ' bytes' });
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
    RED.nodes.registerType('gofa-file-read', GoFaFileReadNode);
};
