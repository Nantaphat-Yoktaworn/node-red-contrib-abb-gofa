'use strict';
var gate = require('./lib/gate');
var createSubscription = require('./lib/rws-subscription');

function parseState(body) {
    var m = String(body).match(/class="ctrlstate">([^<]+)</);
    return m ? m[1].trim() : null;
}

module.exports = function(RED) {
    function GoFaSubscribeStateNode(config) {
        RED.nodes.createNode(this, config);
        this.robot   = RED.nodes.getNode(config.robot);
        this.oneshot = !!config.oneshot;
        var node = this;
        var _rawSend = node.send.bind(node);
        node.send = gate(config, _rawSend);
        node._ws      = null;
        node._pollkey = null;
        node._wsTimer = null;
        node._stopped = false;

        function emit(state) {
            node.status({ fill: 'green', shape: 'dot', text: state });
            node.send({ payload: { ok: true, state: state } });
        }
        function readOnce() {
            return node.robot.rwsGet('/rw/panel/ctrl-state').then(function(body) {
                var state = parseState(body);
                if (state) emit(state);
            });
        }

        // C3: subscribe/WS/reconnect mechanics live in lib/rws-subscription.js —
        // this node only supplies the resource and what to do with a frame.
        var sub = createSubscription(node, {
            resourcePath: '/rw/panel/ctrl-state;ctrlstate',
            priority: 1,
            onStatus: function(s) { node.status(s); },
            onMessage: function(data) {
                var state = parseState(data.toString());
                if (state) emit(state);
            },
            // Report the current state immediately on connect rather than waiting
            // for the controller's first change notification.
            onOpen: function() { readOnce().catch(function() {}); }
        });

        node.on('input', function(msg, send, done) {
            send = gate(config, send);
            if (!node.robot) { node.error('No robot configured'); return done(); }
            if (node.oneshot) {
                node.status({ fill: 'yellow', shape: 'ring', text: 'reading' });
                readOnce().catch(function(err) {
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    node.error(err);
                });
            } else if (node._ws) {
                readOnce().catch(function(err) { node.error(err); });
            } else {
                sub.start();
            }
            done();
        });

        node.on('close', function(done) {
            node._stopped = true;
            sub.stop(done);
        });
    }
    RED.nodes.registerType('gofa-subscribe-state', GoFaSubscribeStateNode);
};
