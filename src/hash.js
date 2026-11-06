'use strict';

const crypto = require('crypto');

// Returns a function: value -> 64-char lowercase hex HMAC-SHA256.
// Used for IPs and device tokens so raw values are never stored (spec section 7).
function makeHasher(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('hash secret must be a string of at least 32 characters');
  }
  return (value) => crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

module.exports = { makeHasher };