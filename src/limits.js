'use strict';

// Single source of defaults. config.js overlays environment variables on these;
// app.js and realtime.js overlay whatever limits they are given (tests pass small values).
//
// Per-IP limits (connections, joins) are keyed by the IP hash, because at that point the
// visitor has no other identity. Per-visitor limits (next, message) are keyed by socket,
// so people who share one public IP (mobile networks, offices) do not throttle each other.
const DEFAULT_LIMITS = Object.freeze({
  maxConnectionsPerIp: 100, // concurrent sockets per IP hash (many people share one mobile/campus IP)
  joinsPerMinute: 120,      // join attempts per IP hash per minute (valid or not); also the burst size
  joinTimeoutMs: 60000,    // a socket that never joins is dropped after this long
  maxMessageBytes: 32768,  // largest single socket message (leaves room for WebRTC offers/answers)
  nextBurst: 5,            // Next presses allowed back to back ...
  nextsPerMinute: 20,      // ... then refilled at this sustained rate
  messageBurst: 10,        // chat messages allowed back to back ...
  messagesPerMinute: 120,  // ... then refilled at this sustained rate
  eventBurst: 100,         // ANY incoming events from one socket back to back ...
  eventsPerSecond: 50,     // ... then this many per second sustained. Far above normal use (this also
                           // has to cover WebRTC signaling later); going over it disconnects the socket.
});

module.exports = { DEFAULT_LIMITS };