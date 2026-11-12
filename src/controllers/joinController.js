'use strict';

const { validateJoin } = require('../validators/join');

// The `join` event: a visitor picks a nickname and a mode and asks to be matched.
// In order: the socket must not have joined already, the per-IP join rate must allow it,
// the payload must be valid, and the ban check must pass. If the ban check cannot be done,
// nobody joins (fail closed). Then admit(socket) puts the visitor into matching.
function createJoinController({ joinLimiter, isBanned, hash, admit }) {
  async function join(socket, payload) {
    if (socket.data.state !== 'new') {
      socket.emit('error', { code: 'invalid' });
      return;
    }
    if (!joinLimiter.take(socket.data.ipHash).allowed) {
      socket.emit('error', { code: 'rate_limited' });
      return;
    }
    const parsed = validateJoin(payload);
    if (!parsed.ok) {
      socket.emit('error', { code: 'invalid' });
      return;
    }

    socket.data.state = 'joining'; // blocks a second join while the ban check is running
    const { nickname, mode, deviceToken } = parsed.value;
    try {
      const banned = await isBanned({
        ipHash: socket.data.ipHash,
        deviceTokenHash: deviceToken === null ? null : hash(deviceToken),
      });
      // The visitor may have left while the ban check was running. Do not admit a
      // dead socket (it would end up in the matching queue later).
      if (socket.disconnected) return;
      if (banned) {
        socket.emit('error', { code: 'banned' });
        socket.disconnect(true);
        return;
      }
    } catch (err) {
      // Fail closed: if we cannot check bans, nobody joins.
      console.error('[join] ban check failed:', err.message);
      socket.data.state = 'new';
      socket.emit('error', { code: 'server_error' });
      return;
    }

    socket.data.nickname = nickname;
    socket.data.mode = mode;
    socket.data.state = 'joined';
    admit(socket); // emits waiting or matched, plus the online count
  }

  return { join };
}

module.exports = { createJoinController };
