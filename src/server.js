'use strict';

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./config');

const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: config.allowedOrigins },
  // Origin check on every connection attempt (spec section 8).
  // Browsers always send Origin, so an unlisted one is rejected.
  // Non-browser clients send none; they can spoof it anyway, so
  // this check only exists to stop other websites hijacking a visitor's browser.
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    const ok = !origin || config.allowedOrigins.includes(origin);
    callback(null, ok);
  },
});

io.on('connection', (socket) => {
  console.log(`[ws] connected ${socket.id}`);
  socket.on('disconnect', (reason) => {
    console.log(`[ws] disconnected ${socket.id} (${reason})`);
  });
});

server.listen(config.port, () => {
  console.log(`[server] BuzzMe listening on :${config.port} (${config.nodeEnv})`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));