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
    self._fragments = null;   // accumulated payload chunks of an in-progress fragmented message
    self._fragOpcode = null;  // opcode (0x1 text / 0x2 binary) the fragmented message started with

    self.req.on('upgrade', function(res, socket, head) {
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

        // `head` is any bytes of the upgraded stream Node's HTTP parser already read
        // off the socket in the same chunk as the 101 response headers (common when a
        // server pushes its first frame immediately after accepting the upgrade — the
        // response and the frame can arrive in one TCP read). Those bytes will NEVER
        // appear in a later 'data' event, so they have to be fed in here or the first
        // frame(s) are silently lost.
        if (head && head.length) {
            self.buffer = Buffer.concat([self.buffer, head]);
            self._parseFrames();
        }
    });

    // A server that rejects the upgrade (bad path, bad auth, etc.) responds with a
    // normal HTTP response instead of a 101 — that fires 'response', not 'upgrade'.
    // Without this, such a rejection surfaces as neither an 'open' nor an 'error': the
    // caller just hangs waiting on a connection that will never come.
    self.req.on('response', function(res) {
        res.resume(); // drain so the socket can close cleanly
        self.emit('error', new Error('WebSocket upgrade rejected: HTTP ' + res.statusCode));
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

        var fin = (byte0 & 0x80) !== 0;
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

        if (opcode === 0x0) {
            // Continuation frame — only valid mid-fragmented-message.
            if (self._fragments) {
                self._fragments.push(payload);
                if (fin) self._finishFragmented();
            }
        } else if (opcode === 0x1 || opcode === 0x2) {
            if (!fin) {
                // First frame of a fragmented message — buffer it, don't emit yet.
                // Control frames (ping/pong/close) can legally interleave before the
                // closing continuation frame, so they're handled independently below,
                // not gated on self._fragments.
                self._fragOpcode = opcode;
                self._fragments = [payload];
            } else {
                self.emit('message', opcode === 0x1 ? payload.toString('utf8') : payload);
            }
        } else if (opcode === 0x8) {
            self.socket.end();
        } else if (opcode === 0x9) {
            // Respond with Pong (minimal frame assembly for client-to-server)
            self._sendPong(payload);
        }
    }
};

SimpleWS.prototype._finishFragmented = function() {
    var full = Buffer.concat(this._fragments);
    var opcode = this._fragOpcode;
    this._fragments = null;
    this._fragOpcode = null;
    this.emit('message', opcode === 0x1 ? full.toString('utf8') : full);
};

SimpleWS.prototype._sendPong = function(payload) {
    var self = this;
    if (!self.socket || self.socket.destroyed) return;
    // Control frames are capped at 125 bytes by RFC 6455 §5.5 — a compliant server
    // never sends a bigger ping, but truncate defensively rather than let a payload
    // >=126 corrupt the single-byte length field below (126/127 are reserved as
    // extended-length markers, not literal lengths).
    if (payload.length > 125) payload = payload.subarray(0, 125);
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
