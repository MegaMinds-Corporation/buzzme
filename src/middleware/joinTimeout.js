'use strict';

// A socket that has not finished joining in time is dropped: it never joined, or its ban
// check got stuck (stops connection hoarding).
function attachJoinTimeout(socket, timeoutMs) {
  const timer = setTimeout(() => {
    if (socket.data.state !== 'joined') socket.disconnect(true);
  }, timeoutMs);
  socket.on('disconnect', () => clearTimeout(timer));
}

module.exports = { attachJoinTimeout };
