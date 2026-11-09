'use strict';

// Starts the real app in-process with a FAKE ban checker (no database) and drives it
// with real Socket.IO clients: matching, messages, next, stop, disconnects, the online
// count, privacy of what the partner receives, failure handling and a randomized soak.

const assert = require('assert');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { createMatchmaker } = require('../src/matchmaker');
const { makeHasher } = require('../src/hash');
const { validateMessage, MESSAGE_MAX_CHARS } = require('../src/validate');

const hash = makeHasher('t'.repeat(40));
let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${detail}`}`);
  ok ? passed++ : failed++;
};
const eq = (x, y) => { try { assert.deepStrictEqual(x, y); return true; } catch { return false; } };

async function start(realtimeOptions = {}) {
    // Many visitors share one address here; rate limits are proven in test-limits.js.
  const limits = { joinsPerMinute: 10000, maxConnectionsPerIp: 10000, nextBurst: 10000, messageBurst: 10000 };
  const config = { allowedOrigins: ['http://localhost:5173'], trustedProxyHops: 0, limits };
  const { server, io, realtime } = createApp({
    config,
    hash,
    isBanned: async () => false,
    realtimeOptions: { onlineIntervalMs: 40, ...realtimeOptions },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => io.close(r));
  return { url, io, realtime, mm: realtime.matchmaker, close };
}

function client(url) {
  const s = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: 'http://localhost:5173' },
  });
  s.events = [];
  s.onAny((name, payload) => s.events.push({ name, payload }));
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(15); }
  return false;
}
const evs = (c) => c.events.filter((e) => e.name !== 'online').map((e) => e.name).join(',');
const of = (c, name) => c.events.filter((e) => e.name === name).map((e) => e.payload);
const lastOnline = (c) => { const o = of(c, 'online'); return o.length ? o[o.length - 1].count : null; };
const join = (c, nickname, mode = 'text', extra = {}) => c.emit('join', { ageConfirmed: true, nickname, mode, ...extra });
const quiet = async (ms = 120) => wait(ms);
const silence = (fn) => async (...args) => {
  const orig = console.error; console.error = () => {};
  try { return await fn(...args); } finally { console.error = orig; }
};

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {
  // ---- message validation (unit) ----
  const v = (text) => validateMessage({ text });
  check(eq(v('  hi  there \n'), { ok: true, value: 'hi  there' }), 'message: trimmed, inner spaces kept');
  check(eq(v('a\r\nb\rc'), { ok: true, value: 'a\nb\nc' }), 'message: line endings become \\n');
  check(v('tab\there').ok && v('two\nlines').ok, 'message: tab and newline are allowed');
  check(v('x'.repeat(MESSAGE_MAX_CHARS)).ok && !v('x'.repeat(MESSAGE_MAX_CHARS + 1)).ok, 'message: limit is exactly 500 characters');
  check(v('\u{1F600}'.repeat(MESSAGE_MAX_CHARS)).ok && !v('\u{1F600}'.repeat(MESSAGE_MAX_CHARS + 1)).ok, 'message: an emoji counts as one character');
  check(v('\u00C7a va tr\u00E8s bien \u4F60\u597D \u0645\u0631\u062D\u0628\u0627').ok, 'message: any language is fine');
  check(!v('').ok && !v('   \n\t ').ok, 'message: empty or blank is rejected');
  check(!v('a\u0000b').ok && !v('a\u001Bb').ok && !v('a\u007Fb').ok && !v('a\u0085b').ok, 'message: control characters are rejected');
  check(!v('a\u202Eb').ok && !v('a\u2066b').ok, 'message: bidi override characters are rejected');
  check(![null, undefined, 'hi', 5, [], [{ text: 'hi' }], {}, { text: 5 }, { text: null }, { text: ['hi'] }].some((p) => validateMessage(p).ok), 'message: wrong shapes are rejected');
  check(eq(validateMessage({ text: 'ok', extra: 1 }), { ok: true, value: 'ok' }), 'message: extra fields are ignored');

  // ---- pairing and the matched payload ----
  let t = await start();
  let a = await client(t.url);
  let b = await client(t.url);
  join(a, 'Alice');
  check(await until(() => evs(a) === 'waiting'), 'first visitor gets waiting');
  join(b, 'Bobby');
  check(await until(() => evs(a) === 'waiting,matched' && evs(b) === 'matched'), 'second visitor and the first both get matched (second never sees waiting)');
  check(eq(of(a, 'matched'), [{ partnerNickname: 'Bobby', initiator: true }]), 'longer waiter is told initiator: true and sees the partner nickname');
  check(eq(of(b, 'matched'), [{ partnerNickname: 'Alice', initiator: false }]), 'newcomer is told initiator: false');

  // ---- messages between partners ----
  a.emit('message', { text: '  hello  there ' });
  check(await until(() => of(b, 'message').length === 1), 'partner receives the message');
  check(eq(of(b, 'message')[0], { text: 'hello  there' }), 'message is delivered trimmed, text only');
  await quiet();
  check(of(a, 'message').length === 0, 'sender gets no echo');
  b.emit('message', { text: 'hi back', evil: '<script>', to: 'someone' });
  check(await until(() => of(a, 'message').length === 1) && eq(of(a, 'message')[0], { text: 'hi back' }), 'works both ways and extra fields are dropped');
  a.emit('message', { text: 'a\r\nb' });
  check(await until(() => of(b, 'message').length === 2) && of(b, 'message')[1].text === 'a\nb', 'line endings are normalised on delivery');
  a.emit('message', { text: 'x'.repeat(500) });
  check(await until(() => of(b, 'message').length === 3), '500-character message is delivered');
  a.emit('message', { text: '\u{1F600}'.repeat(500) });
  check(await until(() => of(b, 'message').length === 4), '500 emoji (1000 UTF-16 units) are delivered');

  const badMessages = [
    ['501 characters', { text: 'x'.repeat(501) }],
    ['501 emoji', { text: '\u{1F600}'.repeat(501) }],
    ['empty text', { text: '' }],
    ['blank text', { text: '   ' }],
    ['text is a number', { text: 5 }],
    ['text is an object', { text: { toString: 'x' } }],
    ['missing text', {}],
    ['null payload', null],
    ['string payload', 'hello'],
    ['array payload', ['hello']],
    ['control character', { text: 'a\u0000b' }],
    ['bidi override', { text: 'a\u202Eb' }],
  ];
  let errors = 0;
  for (const [label, payload] of badMessages) {
    a.emit('message', payload);
    errors++;
    check(await until(() => of(a, 'error').length === errors) && a.events[a.events.length - 1].payload.code === 'invalid', `bad message (${label}) -> invalid`);
  }
  await quiet();
  check(of(b, 'message').length === 4, 'no bad message ever reached the partner');
  check(a.connected && b.connected, 'bad messages do not disconnect anyone');
  a.close(); b.close();
  await t.close();

  // ---- sending when not in a session ----
  t = await start();
  let u = await client(t.url);
  for (const event of ['message', 'next', 'stop']) {
    u.emit(event, event === 'message' ? { text: 'hi' } : undefined);
  }
  check(await until(() => of(u, 'error').length === 3) && of(u, 'error').every((e) => e.code === 'invalid'), 'message, next and stop before join -> invalid');
  join(u, 'Lonely');
  check(await until(() => evs(u) === 'error,error,error,waiting'), 'the visitor can still join after those');
  u.emit('message', { text: 'anyone there?' });
  u.emit('stop');
  u.emit('stop');
  await quiet();
  check(evs(u) === 'error,error,error,waiting', 'message and stop while waiting are quietly ignored (no error, no event)');
  check(t.mm.stateOf(u.id) === 'idle' && t.mm.stats().waiting.text === 0, 'stop while waiting leaves the queue (twice is harmless)');
  u.close();
  await t.close();

  // ---- next ----
  t = await start();
  a = await client(t.url); b = await client(t.url);
  let c = await client(t.url);
  join(a, 'Alice'); join(b, 'Bobby');
  await until(() => evs(b) === 'matched');
  join(c, 'Cathy');
  check(await until(() => evs(c) === 'waiting'), 'a third visitor waits while the first two talk');
  a.emit('next');
  check(await until(() => evs(b) === 'matched,partner_left'), 'Next: the old partner gets partner_left');
  check(await until(() => evs(a) === 'waiting,matched,matched' && evs(c) === 'waiting,matched'), 'Next: the leaver and the waiting visitor are matched');
  check(eq(of(c, 'matched'), [{ partnerNickname: 'Alice', initiator: true }]) && of(a, 'matched')[1].initiator === false, 'Next: the one who waited longer initiates');
  check(t.mm.stateOf(b.id) === 'idle', 'the old partner is idle on the server');
  b.emit('message', { text: 'anyone?' });
  await quiet();
  check(of(a, 'message').length === 0 && of(c, 'message').length === 0 && of(b, 'error').length === 0, 'a message sent while idle goes nowhere and is not an error');
  b.emit('next');
  check(await until(() => evs(b) === 'matched,partner_left,waiting'), 'Next from idle searches again (nobody free: waiting)');
  c.emit('next');
  check(await until(() => evs(a) === 'waiting,matched,matched,partner_left' && evs(c) === 'waiting,matched,matched'), 'Next again: the old partner is told');
  check(eq(of(c, 'matched')[1], { partnerNickname: 'Bobby', initiator: false }) && eq(of(b, 'matched')[1], { partnerNickname: 'Cathy', initiator: true }), 'and is matched with the other waiter, never with the one just left');
  a.emit('next');
  check(await until(() => evs(a) === 'waiting,matched,matched,partner_left,waiting'), 'the visitor left behind searches and waits');
  c.emit('next'); c.emit('next');
  await until(() => evs(b).endsWith('partner_left'));
  check(t.mm.stats().sessions === 0 && t.mm.stats().users === 3, 'state is consistent after a lot of Next presses');
  a.close(); b.close(); c.close();
  await t.close();

  // ---- two people only: Next never repeats the last partner ----
  t = await start();
  a = await client(t.url); b = await client(t.url);
  join(a, 'Alice'); join(b, 'Bobby');
  await until(() => evs(b) === 'matched');
  a.emit('next');
  await until(() => evs(a) === 'waiting,matched,waiting');
  b.emit('next');
  check(await until(() => evs(b) === 'matched,partner_left,waiting'), 'two people: Next from both leaves both waiting, not re-matched');
  check(t.mm.stats().waiting.text === 2 && t.mm.stats().sessions === 0, 'both are queued');
  c = await client(t.url);
  join(c, 'Cathy');
  check(await until(() => evs(c) === 'matched' && evs(a).endsWith('matched')), 'a newcomer is matched with the visitor who waited longest');
  check(eq(of(c, 'matched'), [{ partnerNickname: 'Alice', initiator: false }]) && t.mm.stateOf(b.id) === 'waiting', 'the other waiter keeps waiting');
  a.close(); b.close(); c.close();
  await t.close();

  // ---- stop ----
  t = await start();
  a = await client(t.url); b = await client(t.url);
  join(a, 'Alice'); join(b, 'Bobby');
  await until(() => evs(b) === 'matched');
  a.emit('stop');
  check(await until(() => evs(b) === 'matched,partner_left'), 'Stop: the partner gets partner_left');
  await quiet();
  check(evs(a) === 'waiting,matched', 'Stop: the visitor who stopped gets no event');
  check(t.mm.stateOf(a.id) === 'idle' && t.mm.stateOf(b.id) === 'idle' && t.mm.stats().sessions === 0, 'Stop: the session is gone, both idle, both still connected');
  a.emit('message', { text: 'still there?' });
  b.emit('message', { text: 'hello?' });
  await quiet();
  check(of(a, 'message').length === 0 && of(b, 'message').length === 0 && of(a, 'error').length === 0, 'messages after Stop go nowhere');
  a.emit('stop');
  await quiet();
  check(evs(b) === 'matched,partner_left' && of(a, 'error').length === 0, 'a second Stop does nothing');
  a.emit('next');
  check(await until(() => evs(a) === 'waiting,matched,waiting'), 'after Stop, Next starts a new search');
  b.emit('next');
  check(await until(() => evs(b) === 'matched,partner_left,waiting'), 'and the other one is not re-matched with the one they just left');
  a.close(); b.close();
  await t.close();

  // ---- disconnect ----
  t = await start();
  a = await client(t.url); b = await client(t.url); c = await client(t.url);
  join(a, 'Alice'); join(b, 'Bobby'); join(c, 'Cathy');
  await until(() => evs(b) === 'matched' && evs(c) === 'waiting');
  a.close();
  check(await until(() => evs(b) === 'matched,partner_left'), 'disconnect: the partner gets partner_left');
  check(await until(() => t.mm.stats().users === 2 && t.mm.stats().sessions === 0), 'disconnect: the visitor is forgotten, the session is gone');
  c.close();
  check(await until(() => t.mm.stats().users === 1 && t.mm.stats().waiting.text === 0), 'disconnect while waiting: removed from the queue');
  b.emit('next');
  check(await until(() => evs(b) === 'matched,partner_left,waiting'), 'the remaining visitor can search again and is never paired with a dead socket');
  const d = await client(t.url);
  join(d, 'Dennis');
  check(await until(() => evs(d) === 'matched') && of(d, 'matched')[0].partnerNickname === 'Bobby', 'a later visitor is paired with the live waiter');
  b.close(); d.close();
  await t.close();

  // ---- modes never mix ----
  t = await start();
  const vid1 = await client(t.url); const vox = await client(t.url); const txt = await client(t.url); const vid2 = await client(t.url);
  join(vid1, 'Vid1', 'video'); join(vox, 'Vox1', 'voice'); join(txt, 'Txt1', 'text');
  await until(() => evs(vid1) === 'waiting' && evs(vox) === 'waiting' && evs(txt) === 'waiting');
  const st = t.mm.stats();
  check(st.waiting.video === 1 && st.waiting.voice === 1 && st.waiting.text === 1 && st.sessions === 0, 'one visitor per mode: nobody is matched across modes');
  join(vid2, 'Vid2', 'video');
  check(await until(() => evs(vid2) === 'matched' && evs(vid1) === 'waiting,matched'), 'a second video visitor matches the first video visitor');
  await quiet();
  check(evs(vox) === 'waiting' && evs(txt) === 'waiting', 'voice and text visitors are left alone');
  for (const x of [vid1, vox, txt, vid2]) x.close();
  await t.close();

  // ---- online count ----
  t = await start({ onlineIntervalMs: 60 });
  const lurker = await client(t.url); // connected, never joins
  a = await client(t.url); b = await client(t.url);
  join(a, 'Alice');
  check(await until(() => lastOnline(a) === 1), 'online: the first visitor is told 1');
  join(b, 'Bobby');
  check(await until(() => lastOnline(a) === 2 && lastOnline(b) === 2), 'online: both are told 2');
  b.close();
  check(await until(() => lastOnline(a) === 1), 'online: a disconnect is announced');
  await quiet(200);
  check(lurker.events.length === 0, 'online: a connection that never joined hears nothing');
  lurker.close(); a.close();
  await t.close();

  // a burst is folded together, and nobody is left with a stale number
  t = await start({ onlineIntervalMs: 300 });
  const watcher = await client(t.url);
  const crowd = await Promise.all(Array.from({ length: 8 }, () => client(t.url)));
  join(watcher, 'Watcher');
  await until(() => lastOnline(watcher) === 1);
  crowd.forEach((x, i) => join(x, `Crowd${i}`, 'video'));
  check(await until(() => [watcher, ...crowd].every((x) => lastOnline(x) === 9), 2500), 'online burst: everybody ends up with the right count');
  check(of(watcher, 'online').length <= 4, `online burst: 8 joins sent the watcher ${of(watcher, 'online').length} online messages, not 9`);
  [watcher, ...crowd].forEach((x) => x.close());
  await t.close();

  t = await start({ onlineIntervalMs: 300 });
  a = await client(t.url); b = await client(t.url);
  join(a, 'Alice');
  await until(() => lastOnline(a) === 1);
  join(b, 'Bobby'); // inside the interval: b is told 2 directly
  await until(() => lastOnline(b) === 2);
  a.close(); // the count is back to 1, the same as the last broadcast
  check(await until(() => lastOnline(b) === 1, 2000), 'online: a count that returns to the last broadcast value still reaches a visitor who was told something else');
  b.close();
  await t.close();

  // ---- what the partner is allowed to learn ----
  t = await start();
  a = await client(t.url); b = await client(t.url);
  join(a, 'Alice', 'text', { deviceToken: 'device-token-AAAA' });
  join(b, 'Bobby');
  await until(() => evs(b) === 'matched');
  a.emit('message', { text: 'hello' });
  await until(() => of(b, 'message').length === 1);
  a.close();
  await until(() => evs(b) === 'matched,partner_left');
  const seen = JSON.stringify(b.events);
  check(!seen.includes(a.id) && !seen.includes(hash('127.0.0.1')) && !seen.includes('127.0.0.1') && !seen.includes('device-token-AAAA'), 'the partner never receives a socket id, address hash, address or device token');
  check(eq(Object.keys(of(b, 'matched')[0]).sort(), ['initiator', 'partnerNickname']) && b.events.find((e) => e.name === 'partner_left').payload === undefined, 'matched carries only a nickname and the initiator flag; partner_left carries nothing');
  b.close();
  await t.close();

  // ---- failures are contained ----
  const failingAdmit = { ...createMatchmaker(), enqueue() { throw new Error('boom'); } };
  t = await start({ matchmaker: failingAdmit });
  a = await client(t.url);
  let dropped = false;
  a.on('disconnect', () => { dropped = true; });
  await silence(async () => {
    join(a, 'Alice');
    check(await until(() => of(a, 'error').some((e) => e.code === 'server_error')), 'matchmaker failure on join -> server_error');
    check(await until(() => dropped), 'matchmaker failure on join -> the visitor is disconnected');
  })();
  check((await fetch(`${t.url}/health`)).ok, 'the server is still up after a matchmaker failure on join');
  await t.close();

  const failingNext = { ...createMatchmaker(), next() { throw new Error('boom'); } };
  t = await start({ matchmaker: failingNext });
  a = await client(t.url);
  join(a, 'Alice');
  await until(() => evs(a) === 'waiting');
  await silence(async () => {
    a.emit('next');
    check(await until(() => of(a, 'error').some((e) => e.code === 'server_error')), 'matchmaker failure on next -> server_error');
  })();
  check(a.connected && (await fetch(`${t.url}/health`)).ok, 'the visitor stays connected and the server stays up');
  a.close();
  await t.close();

  // ---- soak: random actions through real sockets, then compare both sides ----
  async function soak(seed, ops) {
    const rand = rng(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const t2 = await start({ onlineIntervalMs: 20 });
    let eventCount = 0;
    let counter = 0;
    const slots = Array.from({ length: 6 }, (_, i) => ({ nick: `User${i}`, sock: null, log: [], partners: new Set(), received: [], errors: 0, online: null }));
    const slotById = (id) => slots.find((s) => s.sock && s.sock.id === id);

    const settle = async () => {
      let last = eventCount;
      for (;;) {
        await wait(6);
        if (eventCount === last) { await wait(6); if (eventCount === last) return; }
        last = eventCount;
      }
    };

    async function open(s) {
      s.sock = await client(t2.url);
      s.log = [];
      s.sock.onAny((name, payload) => {
        eventCount++;
        if (name === 'online') { s.online = payload.count; return; }
        s.log.push({ name, payload });
        if (name === 'matched') s.partners.add(payload.partnerNickname);
        if (name === 'message') s.received.push(payload.text);
        if (name === 'error') s.errors++;
      });
      join(s.sock, s.nick, pick(['text', 'text', 'video']));
    }

    for (let i = 0; i < ops; i++) {
      const s = pick(slots);
      if (!s.sock) await open(s);
      else {
        const op = pick(['next', 'next', 'next', 'message', 'message', 'stop', 'close']);
        if (op === 'next') s.sock.emit('next');
        else if (op === 'message') s.sock.emit('message', { text: `m|${s.nick}|${counter++}` });
        else if (op === 'stop') { s.sock.emit('stop'); s.log.push({ own: 'stop' }); }
        else { s.sock.close(); s.sock = null; }
      }
      await settle();
    }
    await settle();
    await wait(150);

    const live = slots.filter((s) => s.sock);
    let problem = null;
    const fail = (msg) => { if (!problem) problem = `seed ${seed}: ${msg}`; };
    let matchedCount = 0;

    for (const s of live) {
      let view = null;
      for (const entry of s.log) {
        if (entry.own === 'stop') view = 'idle';
        else if (entry.name === 'waiting') view = 'waiting';
        else if (entry.name === 'matched') view = 'matched';
        else if (entry.name === 'partner_left') view = 'idle';
      }
      const server = t2.mm.stateOf(s.sock.id);
      if (view !== server) fail(`${s.nick} believes "${view}" but the server says "${server}"`);
      if (server === 'matched') {
        matchedCount++;
        const partnerSlot = slotById(t2.mm.partnerOf(s.sock.id));
        const lastMatched = s.log.filter((e) => e.name === 'matched').pop();
        if (!partnerSlot) fail(`${s.nick} is matched with a socket that is gone`);
        else {
          if (t2.mm.partnerOf(partnerSlot.sock.id) !== s.sock.id) fail(`${s.nick} partner link is not symmetric`);
          if (lastMatched.payload.partnerNickname !== partnerSlot.nick) fail(`${s.nick} was told the wrong partner`);
        }
      }
      if (s.errors > 0) fail(`${s.nick} received an error event`);
      for (const text of s.received) {
        const from = text.split('|')[1];
        if (!s.partners.has(from)) fail(`${s.nick} received a message from ${from}, who was never a partner`);
      }
      if (s.online !== t2.mm.stats().users) fail(`${s.nick} last heard online=${s.online}, real count ${t2.mm.stats().users}`);
    }
    const stats = t2.mm.stats();
    if (stats.users !== live.length) fail(`server knows ${stats.users} visitors, ${live.length} are connected`);
    if (stats.sessions * 2 !== matchedCount) fail('session count does not match matched visitors');

    live.forEach((s) => s.sock.close());
    await t2.close();
    return problem;
  }

  for (const seed of [11, 12]) {
    const problem = await soak(seed, 130);
    check(problem === null, `soak, seed ${seed}: 130 random actions on real sockets leave both sides in agreement`, problem || '');
  }

  console.log(`\npassed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('test run crashed:', err);
  process.exit(1);
});
