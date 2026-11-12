'use strict';

const { pool } = require('./config/database');

// A visitor is banned if an unexpired ban matches their IP hash OR device token hash.
// expires_at NULL means a permanent ban. `device_token = NULL` is never true in SQL,
// so passing no token simply skips that half of the check.
const BAN_SQL = `
  SELECT 1 FROM bans
  WHERE (ip_hash = $1 OR device_token = $2)
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1`;

// `db` defaults to the shared pool; tests pass a transaction client instead.
async function isBanned({ ipHash, deviceTokenHash = null }, db = pool) {
  const result = await db.query(BAN_SQL, [ipHash, deviceTokenHash]);
  return result.rowCount > 0;
}

function close() {
  return pool.end();
}

module.exports = { isBanned, close };