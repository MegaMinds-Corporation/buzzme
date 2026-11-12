'use strict';

// Tests src/utils/hash.js and src/models/Ban.js (isBanned). Database checks run inside a
// transaction that is ALWAYS rolled back, in a temporary schema: nothing is saved.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../src/config');
const { makeHasher } = require('../src/utils/hash');
const { isBanned } = require('../src/models/Ban');
const { pool } = require('../src/config/database');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${detail}`}`);
  ok ? passed++ : failed++;
};

(async () => {
  // ---- hashing ----
  const hash = makeHasher(config.ipHashSecret);
  const otherHash = makeHasher('x'.repeat(40));
  check(/^[0-9a-f]{64}$/.test(hash('203.0.113.7')), 'hash is 64 lowercase hex characters');
  check(hash('203.0.113.7') === hash('203.0.113.7'), 'hash is deterministic');
  check(hash('203.0.113.7') !== hash('203.0.113.8'), 'different IPs give different hashes');
  check(hash('203.0.113.7') !== otherHash('203.0.113.7'), 'different secrets give different hashes');
  check(!hash('203.0.113.7').includes('203'), 'hash does not contain the raw IP');
  let threw = false;
  try { makeHasher('short'); } catch { threw = true; }
  check(threw, 'a short secret is rejected');

  // ---- isBanned against the real schema, rolled back ----
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const c = new Client({ connectionString: config.databaseUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('CREATE SCHEMA buzzme_test');
    await c.query('SET LOCAL search_path TO buzzme_test');
    await c.query(schemaSql);

    const banned = hash('198.51.100.1');
    const tokenBanned = hash('token-bad');
    const expired = hash('198.51.100.2');
    const permanent = hash('198.51.100.3');
    const clean = hash('198.51.100.99');

    await c.query(`INSERT INTO bans (ip_hash, device_token, reason, expires_at)
                   VALUES ($1, $2, 'spam', now() + interval '1 day')`, [banned, tokenBanned]);
    await c.query(`INSERT INTO bans (ip_hash, reason, expires_at)
                   VALUES ($1, 'old', now() - interval '1 day')`, [expired]);
    await c.query(`INSERT INTO bans (ip_hash, reason) VALUES ($1, 'permanent')`, [permanent]);

    check((await isBanned({ ipHash: banned }, c)) === true, 'banned IP is detected');
    check((await isBanned({ ipHash: clean, deviceTokenHash: tokenBanned }, c)) === true,
      'new IP with a banned device token is still detected');
    check((await isBanned({ ipHash: permanent }, c)) === true, 'permanent ban is detected');
    check((await isBanned({ ipHash: expired }, c)) === false, 'expired ban is ignored');
    check((await isBanned({ ipHash: clean }, c)) === false, 'unknown visitor is not banned');
    check((await isBanned({ ipHash: clean, deviceTokenHash: hash('token-ok') }, c)) === false,
      'unknown visitor with an unknown token is not banned');
  } catch (err) {
    check(false, 'unexpected error', err.message);
  } finally {
    await c.query('ROLLBACK');
    const left = await c.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'buzzme_test'`);
    check(left.rowCount === 0, 'test schema discarded (nothing persisted)');
    await c.end();
    await pool.end();
  }

  console.log(`\npassed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();