'use strict';

// Cap on open connections per IP hash. attach() counts the new socket, releases its slot on
// every kind of disconnect, and rejects a socket over the cap. It returns true when the socket
// may continue, false when it was rejected and disconnected.
function createConnectionCap(maxPerIp) {
  const connectionsByIp = new Map(); // ip hash -> open sockets

  function attach(socket) {
    const ipHash = socket.data.ipHash;
    const open = (connectionsByIp.get(ipHash) || 0) + 1;
    connectionsByIp.set(ipHash, open);

    socket.on('disconnect', () => {
      const left = (connectionsByIp.get(ipHash) || 1) - 1;
      if (left <= 0) connectionsByIp.delete(ipHash);
      else connectionsByIp.set(ipHash, left);
    });

    if (open > maxPerIp) {
      socket.emit('error', { code: 'rate_limited' });
      socket.disconnect(true);
      return false;
    }
    return true;
  }

  return { attach };
}

module.exports = { createConnectionCap };
