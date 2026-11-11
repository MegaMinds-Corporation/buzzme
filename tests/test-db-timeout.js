'use strict';

// A database that accepts connections but never answers must make isBanned fail within a
// few seconds (so the join fails closed) instead of hanging. Runs in about 5 seconds.

const net = require('net');

const silent = net.createServer(() => {}); // accepts, never replies

silent.listen(0, '127.0.0.1', async () => {
  process.env.DATABASE_URL = `postgres://u:p@127.0.0.1:${silent.address().port}/d?sslmode=disable`;
  process.env.IP_HASH_SECRET = 'x'.repeat(40);
  const { isBanned } = require('../src/db');

  const started = Date.now();
  const outcome = await Promise.race([
    isBanned({ ipHash: 'a'.repeat(64) }).then(() => 'answered', () => 'rejected'),
    new Promise((r) => setTimeout(() => r('still waiting'), 9000)),
  ]);
  const seconds = (Date.now() - started) / 1000;

  const ok = outcome === 'rejected' && seconds < 8;
  console.log(`${ok ? 'PASS' : 'FAIL'}  a silent database makes the ban check fail in ${seconds.toFixed(1)}s (${outcome})`);
  console.log(`\npassed=${ok ? 1 : 0} failed=${ok ? 0 : 1}`);
  process.exit(ok ? 0 : 1);
});
