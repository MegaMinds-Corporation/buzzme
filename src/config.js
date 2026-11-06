'use strict';

require('dotenv').config();

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

module.exports = Object.freeze({ port, nodeEnv, allowedOrigins });