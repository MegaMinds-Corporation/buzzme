'use strict';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { createChatController } = require('./controllers/chatController');
const { DEFAULT_LIMITS } = require('./config/limits');
const { createOriginCheck } = require('./middleware/originCheck');
const { registerSockets } = require('./sockets');

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
  const sockets = registerSockets({ io, config, limits, isBanned, hash, chat: realtime });

  server.on('close', () => {
    realtime.close();
    sockets.close();
  });

  return { app, server, io, realtime };
}

module.exports = { createApp };