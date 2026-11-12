'use strict';

const { getClientIp } = require('../utils/clientIp');
const { createRateLimiter } = require('../services/rateLimiter');
const { createConnectionCap } = require('../middleware/connectionCap');
const { attachJoinTimeout } = require('../middleware/joinTimeout');
const { createEventLimit } = require('../middleware/eventLimit');
const { createJoinController } = require('../controllers/joinController');

// Wires every Socket.IO connection to the middleware and controllers. `chat` is the chat
// controller (next, stop, message, disconnect, admit). Returns { close }, which stops the
// limiters' cleanup timers when the server closes.
function registerSockets({ io, config, limits, isBanned, hash, chat }) {
  // Join attempts per IP hash. Every attempt counts, valid or not, and is counted
  // BEFORE validation and the database ban check, so spamming cannot hammer the database.
  const joinLimiter = createRateLimiter({
    capacity: limits.joinsPerMinute,
    refillPerMs: limits.joinsPerMinute / 60000,
  });
  const connectionCap = createConnectionCap(limits.maxConnectionsPerIp);
  const eventLimit = createEventLimit({ burst: limits.eventBurst, perSecond: limits.eventsPerSecond });
  const joinController = createJoinController({ joinLimiter, isBanned, hash, admit: (socket) => chat.admit(socket) });

  io.on('connection', (socket) => {
    // Only the hash is kept; the raw IP is never stored or logged.
    socket.data.ipHash = hash(getClientIp(socket.request, config.trustedProxyHops));
    socket.data.state = 'new'; // new -> joining -> joined

    if (!connectionCap.attach(socket)) return; // per-IP connection cap

    attachJoinTimeout(socket, limits.joinTimeoutMs);

    eventLimit.attach(socket); // flood protection on every incoming event

    chat.attach(socket); // next, stop, message and disconnect handling

    socket.on('join', (payload) => joinController.join(socket, payload));
  });

  function close() {
    joinLimiter.stop();
    eventLimit.stop();
  }

  return { close };
}

module.exports = { registerSockets };
