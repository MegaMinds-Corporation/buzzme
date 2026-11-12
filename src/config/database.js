'use strict';

const { Pool } = require('pg');
const config = require('./index');

// A slow or unreachable database must fail the ban check (and so the join) quickly instead of
// leaving the visitor waiting: pg waits forever by default.
const DB_TIMEOUT_MS = 5000;
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 5,
  connectionTimeoutMillis: DB_TIMEOUT_MS, // waiting for a free or new connection
  query_timeout: DB_TIMEOUT_MS,           // waiting for the answer to a query
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

module.exports = { pool };
