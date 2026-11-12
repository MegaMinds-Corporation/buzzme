'use strict';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { getClientIp } = require('./utils/clientIp');
const { createChatController } = require('./controllers/chatController');
const { createRateLimiter } = require('./services/rateLimiter');
const { DEFAULT_LIMITS } = require('./config/limits');
const { createOriginCheck } = require('./middleware/originCheck');
const { attachJoinTimeout } = require('./middleware/joinTimeout');
const { createConnectionCap } = require('./middleware/connectionCap');
const { createEventLimit } = require('./middleware/eventLimit');
const { createJoinController } = require('./controllers/joinController');

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

  const realtime = createChatController({ io, limits, ...realtimeOptions });

  // Join attempts per IP hash. Every attempt counts, valid or not, and is counted
  // BEFORE validation and the database ban check, so spamming cannot hammer the database.
  const joinLimiter = createRateLimiter({
    capacity: limits.joinsPerMinute,
    refillPerMs: limits.joinsPerMinute / 60000,
  });
  const connectionCap = createConnectionCap(limits.maxConnectionsPerIp);

  const eventLimit = createEventLimit({ burst: limits.eventBurst, perSecond: limits.eventsPerSecond });
  const joinController = createJoinController({ joinLimiter, isBanned, hash, admit: (socket) => realtime.admit(socket) });

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

    socket.on('join', (payload) => joinController.join(socket, payload));
  });

  return { app, server, io, realtime };
}

module.exports = { createApp };