'use strict';

const config = require('./config');
const Ban = require('./models/Ban');
const { pool } = require('./config/database');
const { makeHasher } = require('./utils/hash');
const { createApp } = require('./app');

const { server, io } = createApp({
  config,
  isBanned: Ban.isBanned,
  hash: makeHasher(config.ipHashSecret),
});

server.listen(config.port, () => {
  console.log(`[server] BuzzMe listening on :${config.port} (${config.nodeEnv})`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  io.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));