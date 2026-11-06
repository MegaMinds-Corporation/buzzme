'use strict';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { getClientIp } = require('./clientIp');
const { validateJoin } = require('./validate');

// Builds the HTTP + Socket.IO server WITHOUT listening, so tests can start it
// on any port with fake dependencies. `isBanned` and `hash` are injected.
function createApp({ config, isBanned, hash }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  const server = http.createServer(app);

  const io = new Server(server, {
    cors: { origin: config.allowedOrigins },
    // Origin check on every connection attempt (spec section 8).
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || config.allowedOrigins.includes(origin));
    },
  });

  io.on('connection', (socket) => {
    // Only the hash is kept; the raw IP is never stored or logged.
    socket.data.ipHash = hash(getClientIp(socket.request, config.trustedProxyHops));
    socket.data.state = 'new'; // new -> joining -> joined

    socket.on('join', async (payload) => {
      if (socket.data.state !== 'new') {
        socket.emit('error', { code: 'invalid' });
        return;
      }
      const parsed = validateJoin(payload);
      if (!parsed.ok) {
        socket.emit('error', { code: 'invalid' });
        return;
      }

      socket.data.state = 'joining'; // blocks a second join while the ban check is running
      const { nickname, mode, deviceToken } = parsed.value;
      try {
        const banned = await isBanned({
          ipHash: socket.data.ipHash,
          deviceTokenHash: deviceToken === null ? null : hash(deviceToken),
        });
        if (banned) {
          socket.emit('error', { code: 'banned' });
          socket.disconnect(true);
          return;
        }
      } catch (err) {
        // Fail closed: if we cannot check bans, nobody joins.
        console.error('[join] ban check failed:', err.message);
        socket.data.state = 'new';
        socket.emit('error', { code: 'server_error' });
        return;
      }

      socket.data.nickname = nickname;
      socket.data.mode = mode;
      socket.data.state = 'joined';
      socket.emit('waiting');
    });

    socket.on('disconnect', () => {});
  });

  return { app, server, io };
}

module.exports = { createApp };