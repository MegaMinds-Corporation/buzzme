'use strict';

const { createRateLimiter } = require('../services/rateLimiter');

// Coarse cap on EVERY incoming event from one socket (spec section 8). It sits far above
// normal use; a socket that goes over it is flooding and is disconnected.
// attach() guards one socket; stop() ends the limiter's cleanup timer when the server closes.
function createEventLimit({ burst, perSecond }) {
  const limiter = createRateLimiter({
    capacity: burst,
    refillPerMs: perSecond / 1000,
  });

  function attach(socket) {
    socket.on('disconnect', () => {
      limiter.forget(socket.id);
    });

    socket.use((packet, next) => {
      if (limiter.take(socket.id).allowed) return next();
      socket.emit('error', { code: 'rate_limited' });
      socket.disconnect(true);
    });
  }

  return { attach, stop: () => limiter.stop() };
}

module.exports = { createEventLimit };
