'use strict';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { getClientIp } = require('./utils/clientIp');
const { validateJoin } = require('./validators/join');
const { createRealtime } = require('./realtime');
const { createRateLimiter } = require('./services/rateLimiter');
const { DEFAULT_LIMITS } = require('./config/limits');
const { createOriginCheck } = require('./middleware/originCheck');
const { attachJoinTimeout } = require('./middleware/joinTimeout');
const { createConnectionCap } = require('./middleware/connectionCap');
const { createEventLimit } = require('./middleware/eventLimit');

// Builds the HTTP + Socket.IO server WITHOUT listening, so tests can start it
// on any port with fake dependencies. `isBanned` and `hash` are injected;
// `realtimeOptions` lets tests swap the matchmaker or shorten timers.
function createApp({ config, isBanned, hash, realtimeOptions = {} }) {
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  const server = http.createServer(app);

  const io = new Server(server, {
    cors: { origin: config.allowedOrigins },
    // Hard cap on any single incoming message (spec section 8). Socket.IO closes the
    // connection if a client exceeds it. The default (32 KB) leaves room for WebRTC offers/answers.
    maxHttpBufferSize: limits.maxMessageBytes,
    allowRequest: createOriginCheck(config.allowedOrigins), // origin check (spec section 8)
  });

  const realtime = createRealtime({ io, limits, ...realtimeOptions });

  // Join attempts per IP hash. Every attempt counts, valid or not, and is counted
  // BEFORE validation and the database ban check, so spamming cannot hammer the database.
  const joinLimiter = createRateLimiter({
    capacity: limits.joinsPerMinute,
    refillPerMs: limits.joinsPerMinute / 60000,
  });
  const connectionCap = createConnectionCap(limits.maxConnectionsPerIp);

  const eventLimit = createEventLimit({ burst: limits.eventBurst, perSecond: limits.eventsPerSecond });

  server.on('close', () => {
    realtime.close();
    joinLimiter.stop();
    eventLimit.stop();
  });

  io.on('connection', (socket) => {
    // Only the hash is kept; the raw IP is never stored or logged.
    socket.data.ipHash = hash(getClientIp(socket.request, config.trustedProxyHops));
    socket.data.state = 'new'; // new -> joining -> joined

    if (!connectionCap.attach(socket)) return; // per-IP connection cap

    attachJoinTimeout(socket, limits.joinTimeoutMs);

    eventLimit.attach(socket); // flood protection on every incoming event

    realtime.attach(socket); // next, stop, message and disconnect handling

    socket.on('join', async (payload) => {
      if (socket.data.state !== 'new') {
        socket.emit('error', { code: 'invalid' });
        return;
      }
      if (!joinLimiter.take(socket.data.ipHash).allowed) {
        socket.emit('error', { code: 'rate_limited' });
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
        // The visitor may have left while the ban check was running. Do not admit a
        // dead socket (it would end up in the matching queue later).
        if (socket.disconnected) return;
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
      realtime.admit(socket); // emits waiting or matched, plus the online count
    });
  });

  return { app, server, io, realtime };
}

module.exports = { createApp };