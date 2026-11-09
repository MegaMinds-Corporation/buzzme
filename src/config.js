'use strict';

require('dotenv').config();
const { DEFAULT_LIMITS } = require('./limits');

function fail(message) {
  console.error(`[config] ${message}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`PORT must be an integer between 1 and 65535 (got "${process.env.PORT}")`);
}

const nodeEnv = process.env.NODE_ENV || 'development';
if (!['development', 'production', 'test'].includes(nodeEnv)) {
  fail(`NODE_ENV must be development, production or test (got "${nodeEnv}")`);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (nodeEnv === 'production' && allowedOrigins.length === 0) {
  fail('ALLOWED_ORIGINS must be set in production');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail('DATABASE_URL is required');
}

// Secret key for hashing IPs and device tokens (spec section 7). Changing it
// later makes every stored hash unmatchable, which silently lifts all bans.
const ipHashSecret = process.env.IP_HASH_SECRET || '';
if (ipHashSecret.length < 32) {
  fail('IP_HASH_SECRET is required and must be at least 32 characters');
}

// How many of YOUR proxies (Nginx, a platform load balancer) sit in front of this
// server. 0 = none: X-Forwarded-For is ignored. Wrong values let clients fake their IP.
const trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS || 0);
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) {
  fail(`TRUSTED_PROXY_HOPS must be an integer between 0 and 5 (got "${process.env.TRUSTED_PROXY_HOPS}")`);
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

// Only the limits worth tuning per deployment are environment variables; the rest
// live in src/limits.js.
const limits = Object.freeze({
  ...DEFAULT_LIMITS,
  maxConnectionsPerIp: intEnv('MAX_CONNECTIONS_PER_IP', DEFAULT_LIMITS.maxConnectionsPerIp, 1, 1000),
  joinsPerMinute: intEnv('JOIN_RATE_PER_MINUTE', DEFAULT_LIMITS.joinsPerMinute, 1, 1000),
  joinTimeoutMs: intEnv('JOIN_TIMEOUT_MS', DEFAULT_LIMITS.joinTimeoutMs, 1000, 3600000),
});

module.exports = Object.freeze({
  port,
  nodeEnv,
  allowedOrigins,
  databaseUrl,
  ipHashSecret,
  trustedProxyHops,
  limits,
});