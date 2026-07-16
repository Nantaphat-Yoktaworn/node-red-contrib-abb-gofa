'use strict';
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var EventEmitter = require('events');

function SimpleWS(urlStr, protocols, options) {
    EventEmitter.call(this);
    var self = this;
    options = options || {};
    var url = new URL(urlStr);
    var isSecure = url.protocol === 'wss:';
    var lib = isSecure ? https : http;
    
    var key = crypto.randomBytes(16).toString('base64');
    var headers = Object.assign({
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
    }, options.headers);
    
    if (protocols && protocols.length) {
        headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
    }

    var reqOpts = {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (isSecure ? 443 : 80),
        path: url.pathname + url.search,
        headers: headers,
        rejectUnauthorized: options.rejectUnauthorized !== false
    };

    self.req = lib.request(reqOpts);
    self.socket = null;
    self.buffer = Buffer.alloc(0);

    self.req.on('upgrade', function(res, socket) {
        self.socket = socket;
        
        var acceptExpected = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        var acceptActual = res.headers['sec-websocket-accept'];
        if (acceptActual !== acceptExpected) {
            self.emit('error', new Error('Sec-WebSocket-Accept mismatch'));
            socket.destroy();
            return;
        }

        self.emit('open');

        socket.on('data', function(chunk) {
            self.buffer = Buffer.concat([self.buffer, chunk]);
            self._parseFrames();
        });

        socket.on('close', function() { self.emit('close'); });
        socket.on('error', function(err) { self.emit('error', err); });
    });

    self.req.on('error', function(err) { self.emit('error', err); });
    self.req.end();
}

require('util').inherits(SimpleWS, EventEmitter);

SimpleWS.prototype._parseFrames = function() {
    var self = this;
    while (true) {
        if (self.buffer.length < 2) return;
        var byte0 = self.buffer[0];
        var byte1 = self.buffer[1];
        
        var opcode = byte0 & 0x0f;
        var masked = (byte1 & 0x80) !== 0;
        var payloadLen = byte1 & 0x7f;
        
        var headerLen = 2;
        if (payloadLen === 126) {
            if (self.buffer.length < 4) return;
            payloadLen = self.buffer.readUInt16BE(2);
            headerLen = 4;
        } else if (payloadLen === 127) {
            if (self.buffer.length < 10) return;
            var val = self.buffer.readBigUInt64BE(2);
            payloadLen = Number(val);
            headerLen = 10;
        }

        if (masked) {
            if (self.buffer.length < headerLen + 4) return;
            headerLen += 4;
        }

        var totalFrameLen = headerLen + payloadLen;
        if (self.buffer.length < totalFrameLen) return;

        var payload = self.buffer.subarray(headerLen, totalFrameLen);
        if (masked) {
            var mask = self.buffer.subarray(headerLen - 4, headerLen);
            var unmasked = Buffer.alloc(payloadLen);
            for (var i = 0; i < payloadLen; i++) {
                unmasked[i] = payload[i] ^ mask[i % 4];
            }
            payload = unmasked;
        }

        self.buffer = self.buffer.subarray(totalFrameLen);

        if (opcode === 0x1) {
            self.emit('message', payload.toString('utf8'));
        } else if (opcode === 0x2) {
            self.emit('message', payload);
        } else if (opcode === 0x8) {
            self.socket.end();
        } else if (opcode === 0x9) {
            // Respond with Pong (minimal frame assembly for client-to-server)
            self._sendPong(payload);
        }
    }
};

SimpleWS.prototype._sendPong = function(payload) {
    var self = this;
    if (!self.socket || self.socket.destroyed) return;
    var mask = crypto.randomBytes(4);
    var payloadLen = payload.length;
    var header = Buffer.alloc(6); // 2 bytes header + 4 bytes mask key
    header[0] = 0x8A; // FIN=1, Opcode=0xA (Pong)
    header[1] = 0x80 | payloadLen; // Masked = 1
    mask.copy(header, 2);
    
    var maskedPayload = Buffer.alloc(payloadLen);
    for (var i = 0; i < payloadLen; i++) {
        maskedPayload[i] = payload[i] ^ mask[i % 4];
    }
    self.socket.write(Buffer.concat([header, maskedPayload]));
};

SimpleWS.prototype.terminate = function() {
    if (this.socket) this.socket.destroy();
    if (this.req) this.req.destroy();
};

module.exports = SimpleWS;
