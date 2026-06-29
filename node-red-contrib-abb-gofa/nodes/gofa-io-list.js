'use strict';
module.exports = function(RED) {
    function GoFaIoListNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;

        node.on('input', function(msg, send, done) {
            if (!node.robot) { node.error('No robot configured', msg); return done(); }

            var filterType = '';
            if (msg.payload && typeof msg.payload === 'object' && msg.payload.type) {
                filterType = String(msg.payload.type).toUpperCase();
            }

            node.status({ fill: 'blue', shape: 'dot', text: 'listing...' });

            node.robot.rwsGet('/rw/iosystem/signals')
            .then(function(body) {
                var signals = [];
                var liRegex = /<li class="ios-signal-li"[^>]*>([\s\S]*?)<\/li>/g;
                var spanRegex = /<span class="([^"]+)"[^>]*>([^<]*)<\/span>/g;
                var liMatch;

                while ((liMatch = liRegex.exec(body)) !== null) {
                    var inner = liMatch[1];
                    var item  = {};
                    var spanMatch;
                    spanRegex.lastIndex = 0;
                    while ((spanMatch = spanRegex.exec(inner)) !== null) {
                        var cls = spanMatch[1];
                        var val = spanMatch[2].trim();
                        if (cls === 'name'   || cls === 'type' || cls === 'lvalue') {
                            item[cls] = val;
                        }
                    }
                    if (item.name) {
                        signals.push(item);
                    }
                }

                if (filterType) {
                    signals = signals.filter(function(s) {
                        return s.type && s.type.toUpperCase() === filterType;
                    });
                }

                msg.payload = { ok: true, count: signals.length, signals: signals };
                node.status({ fill: 'green', shape: 'dot', text: signals.length + ' signals' });
                send(msg); done();
            })
            .catch(function(err) {
                msg.payload = { ok: false, error: err.message };
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err, msg); done(err);
            });
        });
    }
    RED.nodes.registerType('gofa-io-list', GoFaIoListNode);
};
