'use strict';

const { createMatchmaker } = require('./services/matchmaker');
const { validateMessage } = require('./validate');
const { createRateLimiter } = require('./services/rateLimiter');
const { DEFAULT_LIMITS } = require('./config/limits');

// Connects Socket.IO sockets to the matchmaker. app.js calls:
//   attach(socket)  once per connection: registers next, stop, message and disconnect
//   admit(socket)   once the visitor has passed validation and the ban check
//
// What the visitor sees (spec section 6):
//   waiting                               no partner yet
//   matched {partnerNickname, initiator}  a partner was found (initiator = send the WebRTC offer)
//   message {text}                        text from the partner
//   partner_left                          the partner pressed Next/Stop or disconnected
//   online {count}                        number of people currently on the service
//   error {code}                          invalid | rate_limited | server_error
//
// Privacy rules kept here: the partner only ever receives a nickname and message text,
// never a socket id, session id or address, and message text is never stored or logged.
//
// Rate limits here are per visitor (socket): Next and message. Per-IP limits (connections,
// joins) live in app.js.
//
// Not here yet (next steps): report flow, signaling.

const MEMBERS_ROOM = 'members'; // everyone admitted; the audience for `online`

function createRealtime({
  io,
  matchmaker = createMatchmaker(),
  // Minimum gap between `online` broadcasts, so a burst of joins does not make every
  // visitor receive one message per join.
  onlineIntervalMs = 1000,
  limits = {},
}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const limiterFor = (burst, perMinute) =>
    createRateLimiter({ capacity: burst, refillPerMs: perMinute / 60000 });
  const nextLimiter = limiterFor(L.nextBurst, L.nextsPerMinute);
  const messageLimiter = limiterFor(L.messageBurst, L.messagesPerMinute);

  let onlineTimer = null;
  let onlineDirty = false;

  const socketOf = (id) => io.sockets.sockets.get(id);

  function sendTo(id, event, payload) {
    const target = socketOf(id);
    if (!target) return;
    // Events without a payload (partner_left) must carry no argument at all, not null.
    if (payload === undefined) target.emit(event);
    else target.emit(event, payload);
  }

  function announceMatch(result) {
    const [a, b] = result.members;
    for (const [me, other] of [[a, b], [b, a]]) {
      sendTo(me.id, 'matched', {
        partnerNickname: other.nickname,
        initiator: me.id === result.initiatorId,
      });
    }
  }

  // Sends the current head count to every member, at most once per interval. Changes
  // inside the interval are folded into one more broadcast when it ends. Returns true if
  // it broadcast right now (so the caller knows its own socket already got the count).
  function announceOnline() {
    if (onlineTimer) {
      onlineDirty = true;
      return false;
    }
    io.to(MEMBERS_ROOM).emit('online', { count: matchmaker.stats().users });
    onlineTimer = setTimeout(() => {
      onlineTimer = null;
      if (onlineDirty) {
        onlineDirty = false;
        announceOnline();
      }
    }, onlineIntervalMs);
    onlineTimer.unref();
    return true;
  }

  // A handler that throws must not take the server down or leave the visitor hanging.
  // The error text is logged without the payload (it may contain chat text).
  const safe = (socket, handler) => (...args) => {
    try {
      handler(...args);
    } catch (err) {
      console.error('[realtime] handler failed:', err.message);
      socket.emit('error', { code: 'server_error' });
    }
  };

  const reject = (socket) => socket.emit('error', { code: 'invalid' });
  const limited = (socket) => socket.emit('error', { code: 'rate_limited' });
  const isMember = (socket) => socket.data.state === 'joined';

  // Puts a validated visitor (socket.data.nickname and .mode are set) into matching.
  function admit(socket) {
    try {
      socket.join(MEMBERS_ROOM);
      const result = matchmaker.enqueue({
        id: socket.id,
        nickname: socket.data.nickname,
        mode: socket.data.mode,
      });
      if (result.status === 'matched') announceMatch(result);
      else if (result.status === 'waiting') socket.emit('waiting');
      else reject(socket);
      if (!announceOnline()) socket.emit('online', { count: matchmaker.stats().users });
    } catch (err) {
      // We cannot tell what state the visitor is in, so do not keep the connection.
      console.error('[realtime] admit failed:', err.message);
      socket.emit('error', { code: 'server_error' });
      socket.disconnect(true);
    }
  }

  function attach(socket) {
    // Next: leave the current partner (if any) and look for someone new. Also works
    // after the partner left or after Stop. Pressing it while already waiting keeps
    // the place in the queue.
    socket.on('next', safe(socket, () => {
      if (!isMember(socket)) return reject(socket);
      if (!nextLimiter.take(socket.id).allowed) return limited(socket);
      const result = matchmaker.next(socket.id);
      if (result.ended) sendTo(result.ended.partnerId, 'partner_left');
      if (result.status === 'matched') announceMatch(result);
      else if (result.status === 'waiting') socket.emit('waiting');
      else reject(socket);
    }));

    // Stop: end the session or leave the queue. The visitor stays connected and can
    // press Next to search again. No event is sent back: the client asked for it.
    socket.on('stop', safe(socket, () => {
      if (!isMember(socket)) return reject(socket);
      const { ended } = matchmaker.stop(socket.id);
      if (ended) sendTo(ended.partnerId, 'partner_left');
    }));

    // Message: plain text for the current partner. Malformed input gets `invalid`.
    // A well-formed message with nobody to receive it is dropped silently: that is the
    // normal race when the partner pressed Next a moment before the visitor hit send.
    socket.on('message', safe(socket, (payload) => {
      if (!isMember(socket)) return reject(socket);
      if (!messageLimiter.take(socket.id).allowed) return limited(socket);
      const parsed = validateMessage(payload);
      if (!parsed.ok) return reject(socket);
      const partnerId = matchmaker.partnerOf(socket.id);
      if (partnerId === null) return;
      sendTo(partnerId, 'message', { text: parsed.value });
    }));

    socket.on('disconnect', safe(socket, () => {
      nextLimiter.forget(socket.id);
      messageLimiter.forget(socket.id);
      const wasMember = matchmaker.stateOf(socket.id) !== null;
      const { ended } = matchmaker.disconnect(socket.id);
      if (ended) sendTo(ended.partnerId, 'partner_left');
      if (wasMember) announceOnline();
    }));
  }

  function close() {
    clearTimeout(onlineTimer);
    onlineTimer = null;
    nextLimiter.stop();
    messageLimiter.stop();
  }

  return { attach, admit, close, matchmaker };
}

module.exports = { createRealtime };