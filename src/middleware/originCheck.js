'use strict';

// Origin check on every connection attempt (spec section 8). A request that carries an
// Origin header must come from the allow list; a request with no Origin header is let through.
function createOriginCheck(allowedOrigins) {
  return (req, callback) => {
    const origin = req.headers.origin;
    callback(null, !origin || allowedOrigins.includes(origin));
  };
}

module.exports = { createOriginCheck };
