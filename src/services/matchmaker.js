'use strict';

const crypto = require('crypto');
const { MODES } = require('../validate');

// In-memory matchmaker: one waiting queue per mode, the live sessions, and who each
// user talked to last. It knows nothing about sockets, IPs or the database. Callers
// pass an opaque user id (the socket id), then act on what comes back (emit events).
//
// A known user is always in exactly one state:
//   idle     known, but not queued and not in a session (just joined, stopped, or
//            their partner left)
//   waiting  in the queue for their mode
//   matched  in a live session with exactly one partner
//
// Rules (spec sections 4 and 5):
//   - people are only matched with others in the same mode
//   - the longest-waiting compatible person is picked first (FIFO)
//   - "Next" must give a NEW person: the last `recentLimit` partners are skipped,
//     from both sides
//
// Known limit: with only two people online, they cannot be re-matched with each
// other until someone else joins. That is the intended meaning of "Next".
function createMatchmaker({ recentLimit = 1 } = {}) {
  const users = new Map(); // id -> { id, nickname, mode, state, sessionId, recent: [] }
  const queues = new Map(MODES.map((m) => [m, new Map()])); // mode -> Map(id -> user), insertion order = FIFO
  const sessions = new Map(); // sessionId -> { id, mode, a, b }

  function assertUser(u) {
    if (u === null || typeof u !== 'object') throw new TypeError('user must be an object');
    if (typeof u.id !== 'string' || u.id === '') throw new TypeError('user.id must be a non-empty string');
    if (typeof u.nickname !== 'string' || u.nickname === '') throw new TypeError('user.nickname must be a non-empty string');
    if (!MODES.includes(u.mode)) throw new TypeError(`user.mode must be one of: ${MODES.join(', ')}`);
  }

  const canMatch = (x, y) => x.id !== y.id && !x.recent.includes(y.id) && !y.recent.includes(x.id);

  // Pair `user` with the first compatible waiting person, or put them in the queue.
  function place(user) {
    const queue = queues.get(user.mode);
    for (const candidate of queue.values()) {
      if (!canMatch(user, candidate)) continue;
      queue.delete(candidate.id);
      const session = { id: crypto.randomUUID(), mode: user.mode, a: candidate.id, b: user.id };
      sessions.set(session.id, session);
      candidate.state = 'matched';
      candidate.sessionId = session.id;
      user.state = 'matched';
      user.sessionId = session.id;
      return {
        status: 'matched',
        sessionId: session.id,
        mode: session.mode,
        // The one who waited longer makes the WebRTC offer, so exactly one side initiates.
        initiatorId: candidate.id,
        members: [
          { id: candidate.id, nickname: candidate.nickname },
          { id: user.id, nickname: user.nickname },
        ],
      };
    }
    user.state = 'waiting';
    queue.set(user.id, user);
    return { status: 'waiting' };
  }

  // Ends a live session: both people become idle and remember each other as "recent".
  function endSession(user) {
    const session = sessions.get(user.sessionId);
    const partner = users.get(session.a === user.id ? session.b : session.a);
    sessions.delete(session.id);
    for (const [me, other] of [[user, partner], [partner, user]]) {
      me.state = 'idle';
      me.sessionId = null;
      me.recent.push(other.id);
      while (me.recent.length > recentLimit) me.recent.shift();
    }
    return { sessionId: session.id, partnerId: partner.id, mode: session.mode };
  }

  // Join (or re-join after being idle). Returns { status: 'waiting' }, a 'matched'
  // result, or { status: 'busy' } if this user is already waiting or matched.
  function enqueue(input) {
    assertUser(input);
    let user = users.get(input.id);
    if (user && user.state !== 'idle') return { status: 'busy' };
    if (!user) {
      user = { id: input.id, nickname: input.nickname, mode: input.mode, state: 'idle', sessionId: null, recent: [] };
      users.set(user.id, user);
    } else {
      user.nickname = input.nickname;
      user.mode = input.mode;
    }
    return place(user);
  }

  // "Next": leave the current partner (if any) and look for someone new, same mode.
  // `ended` tells the caller whom to notify with partner_left.
  function next(id) {
    const user = users.get(id);
    if (!user) return { status: 'unknown', ended: null };
    if (user.state === 'waiting') return { status: 'waiting', ended: null }; // keeps their place in line
    const ended = user.state === 'matched' ? endSession(user) : null;
    return { ended, ...place(user) };
  }

  // "Stop" or "Report": leave the queue or end the session, but stay known (idle).
  function stop(id) {
    const user = users.get(id);
    if (!user) return { ended: null };
    if (user.state === 'matched') return { ended: endSession(user) };
    if (user.state === 'waiting') {
      queues.get(user.mode).delete(id);
      user.state = 'idle';
    }
    return { ended: null };
  }

  // The socket closed: same as stop, then forget the user completely.
  function disconnect(id) {
    const { ended } = stop(id);
    users.delete(id);
    return { ended };
  }

  function partnerOf(id) {
    const user = users.get(id);
    if (!user || user.state !== 'matched') return null;
    const session = sessions.get(user.sessionId);
    return session.a === id ? session.b : session.a;
  }

  function sessionOf(id) {
    const user = users.get(id);
    if (!user || user.state !== 'matched') return null;
    const session = sessions.get(user.sessionId);
    return { sessionId: session.id, mode: session.mode, partnerId: session.a === id ? session.b : session.a };
  }

  const stateOf = (id) => (users.has(id) ? users.get(id).state : null);

  function stats() {
    const waiting = {};
    for (const [mode, q] of queues) waiting[mode] = q.size;
    return { users: users.size, sessions: sessions.size, waiting };
  }

  return { enqueue, next, stop, disconnect, partnerOf, sessionOf, stateOf, stats };
}

module.exports = { createMatchmaker };
