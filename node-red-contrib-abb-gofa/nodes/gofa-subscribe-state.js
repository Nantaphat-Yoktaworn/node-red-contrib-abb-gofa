'use strict';
var https = require('https');
var http  = require('http');
var WS    = require('ws');

module.exports = function(RED) {
    function GoFaSubscribeStateNode(config) {
        RED.nodes.createNode(this, config);
        this.robot = RED.nodes.getNode(config.robot);
        var node = this;
        node._ws      = null;
        node._pollkey = null;

        function startSubscription() {
            if (!node.robot) { node.error('No robot configured'); return; }
            if (node._ws)    { return; }
            var robot        = node.robot;
            var resourcePath = '/rw/panel/ctrl-state;ctrlstate';
            var priority     = 1;

            node.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });

            robot._getSession().then(function() {
                return new Promise(function(resolve, reject) {
                    var body = 'resources=1&1=' + encodeURIComponent(resourcePath) + '&1-p=' + priority;
                    var headers = {
                        'Content-Type':   'application/x-www-form-urlencoded;v=2.0',
                        'Content-Length': Buffer.byteLength(body),
                        'Accept':         'application/xhtml+xml;v=2.0'
                    };
                    if (robot._cookie) headers['Cookie'] = robot._cookie;
                    else headers['Authorization'] = 'Basic ' + Buffer.from(robot.username + ':' + robot.password).toString('base64');
                    var proto = robot.rwsPort === 443 ? https : http;
                    var req = proto.request({
                        hostname: robot.ip, port: robot.rwsPort,
                        path: '/subscription', method: 'POST',
                        headers: headers, rejectUnauthorized: false
                    }, function(res) {
                        var data = '';
                        res.on('data', function(c) { data += c; });
                        res.on('end', function() {
                            if (res.statusCode === 201) resolve(res.headers.location);
                            else reject(new Error('Subscription failed: HTTP ' + res.statusCode));
                        });
                    });
                    req.on('error', reject);
                    req.write(body);
                    req.end();
                });
            }).then(function(location) {
                node._pollkey = location.split('/poll/').pop();
                var wsUrl = location;
                var ws = new WS(wsUrl, ['robapi2_subscription'], {
                    rejectUnauthorized: false,
                    headers: { Cookie: robot._cookie || '' }
                });
                node._ws = ws;
                ws.on('open', function() {
                    node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                });
                ws.on('message', function(data) {
                    var str = data.toString();
                    var m = str.match(/class="ctrlstate">([^<]+)</);
                    if (m) {
                        var state = m[1].trim();
                        node.status({ fill: 'green', shape: 'dot', text: state });
                        node.send({ payload: { ok: true, state: state } });
                    }
                });
                ws.on('error', function(err) { node.error(err); });
                ws.on('close', function() {
                    if (node._ws) {
                        node._ws = null;
                        node.status({ fill: 'grey', shape: 'ring', text: 'disconnected' });
                    }
                });
            }).catch(function(err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.error(err);
            });
        }

        node.on('input', function(msg, send, done) {
            startSubscription();
            done();
        });

        node.on('close', function(done) {
            var ws = node._ws;
            node._ws = null;
            if (ws) { ws.terminate(); }
            if (node._pollkey && node.robot) {
                var pk = node._pollkey;
                node._pollkey = null;
                node.robot._request('DELETE', '/subscription/' + pk, null, false)
                    .catch(function(){})
                    .then(function(){ done(); });
            } else { done(); }
        });
    }
    RED.nodes.registerType('gofa-subscribe-state', GoFaSubscribeStateNode);
};
