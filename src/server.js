'use strict';

const config = require('./config');
const db = require('./db');
const { makeHasher } = require('./utils/hash');
const { createApp } = require('./app');

const { server, io } = createApp({
  config,
  isBanned: db.isBanned,
  hash: makeHasher(config.ipHashSecret),
});

server.listen(config.port, () => {
  console.log(`[server] BuzzMe listening on :${config.port} (${config.nodeEnv})`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  io.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));