'use strict';

// Proves db/schema.sql inside a transaction that is ALWAYS rolled back:
// a temporary schema is created, tested, and discarded, so nothing is ever saved.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

let passed = 0;
let failed = 0;
const report = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${detail}`}`);
  ok ? passed++ : failed++;
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('[test-db] DATABASE_URL is not set (put it in .env)');
    process.exit(1);
  }
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const expectError = async (label, code, sql, params = []) => {
    await c.query('SAVEPOINT attempt');
    try {
      await c.query(sql, params);
      report(false, label, '(statement succeeded, expected an error)');
    } catch (err) {
      report(err.code === code, label, `(got ${err.code}: ${err.message})`);
    }
    await c.query('ROLLBACK TO SAVEPOINT attempt');
  };

  try {
    await c.query('BEGIN');
    await c.query('CREATE SCHEMA buzzme_test');
    await c.query('SET LOCAL search_path TO buzzme_test');

    await c.query(schemaSql);
    await c.query(schemaSql);
    report(true, 'schema applies twice (idempotent)');

    const tables = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'buzzme_test' ORDER BY 1`
    );
    report(tables.rows.map((r) => r.table_name).join() === 'bans,reports', 'tables exist: bans, reports');

    await c.query(
      `INSERT INTO bans (ip_hash, device_token, reason, expires_at) VALUES ($1,'tok1','spam', now() + interval '1 day')`, [H1]);
    await c.query(
      `INSERT INTO bans (ip_hash, reason, expires_at) VALUES ($1,'old', now() - interval '1 day')`, [H2]);
    await c.query(`INSERT INTO bans (ip_hash, reason) VALUES ($1,'permanent')`, [H3]);

    const BAN = `SELECT count(*)::int AS n FROM bans
                 WHERE (ip_hash = $1 OR device_token = $2)
                   AND (expires_at IS NULL OR expires_at > now())`;
    const banCount = async (ip, tok) => (await c.query(BAN, [ip, tok])).rows[0].n;
    report((await banCount(H1, 'x')) === 1, 'active ban found by ip');
    report((await banCount('d'.repeat(64), 'tok1')) === 1, 'active ban found by token');
    report((await banCount(H3, 'x')) === 1, 'permanent ban found');
    report((await banCount(H2, 'x')) === 0, 'expired ban ignored');
    report((await banCount('d'.repeat(64), 'x')) === 0, 'unknown visitor not banned');

    await c.query(
      `INSERT INTO reports (reporter_ip_hash, reported_ip_hash, mode, reason, message_snapshot)
       VALUES ($1,$2,'text','abuse',$3)`, [H1, H2, JSON.stringify([{ from: 'partner', text: 'hi' }])]);
    report(true, 'text report with snapshot accepted');
    await c.query(
      `INSERT INTO reports (reporter_ip_hash, reported_ip_hash, mode, reason) VALUES ($1,$2,'video','nudity')`, [H1, H2]);
    report(true, 'video report without snapshot accepted');

    const CHECK = '23514'; // check_violation
    await expectError('video report WITH snapshot rejected', CHECK,
      `INSERT INTO reports (reporter_ip_hash, reported_ip_hash, mode, reason, message_snapshot) VALUES ($1,$2,'video','x','[]')`, [H1, H2]);
    await expectError('unknown mode rejected', CHECK,
      `INSERT INTO reports (reporter_ip_hash, reported_ip_hash, mode, reason) VALUES ($1,$2,'audio','x')`, [H1, H2]);
    await expectError('malformed ip_hash (too long) rejected', CHECK,
      `INSERT INTO bans (ip_hash, reason) VALUES ($1,'x')`, [H1 + 'a']);
    await expectError('malformed ip_hash (not hex) rejected', CHECK,
      `INSERT INTO bans (ip_hash, reason) VALUES ($1,'x')`, ['z'.repeat(64)]);
  } catch (err) {
    report(false, 'unexpected error', err.message);
  } finally {
    await c.query('ROLLBACK');
    const leftover = await c.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'buzzme_test'`);
    report(leftover.rowCount === 0, 'test schema discarded (nothing persisted)');
    await c.end();
  }

  console.log(`\npassed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();