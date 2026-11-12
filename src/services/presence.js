'use strict';

const MEMBERS_ROOM = 'members'; // everyone admitted; the audience for `online`

// The online head count (spec section 6): every admitted visitor sits in one room and is told
// how many people are on the service. Broadcasts are limited to one per interval, so a burst
// of joins does not make every visitor receive one message per join.
//   enter(socket)  puts an admitted visitor in the room
//   announce()     broadcasts the count now, or folds the change into the next broadcast.
//                  Returns true if it broadcast right now (the caller's socket got it too)
//   tell(socket)   sends the current count to one socket
//   stop()         cancels the pending timer
function createPresence({ io, matchmaker, intervalMs = 1000 }) {
  let timer = null;
  let dirty = false;

  function enter(socket) {
    socket.join(MEMBERS_ROOM);
  }

  function tell(socket) {
    socket.emit('online', { count: matchmaker.stats().users });
  }

  function announce() {
    if (timer) {
      dirty = true;
      return false;
    }
    io.to(MEMBERS_ROOM).emit('online', { count: matchmaker.stats().users });
    timer = setTimeout(() => {
      timer = null;
      if (dirty) {
        dirty = false;
        announce();
      }
    }, intervalMs);
    timer.unref();
    return true;
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  return { enter, announce, tell, stop };
}

module.exports = { createPresence };
