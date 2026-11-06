'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL is not set (put it in .env)');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query(sql);
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name IN ('bans','reports')
       ORDER BY table_name`
    );
    console.log('[migrate] schema applied. tables present:', rows.map((r) => r.table_name).join(', '));
  } catch (err) {
    console.error('[migrate] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();