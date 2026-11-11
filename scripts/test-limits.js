'use strict';

// In-process server on a random port with a fake ban checker (no database).

const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { makeHasher } = require('../src/utils/hash');

const { DEFAULT_LIMITS } = require('../src/config/limits');
const hash = makeHasher('t'.repeat(40));
let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${detail}`}`);
  ok ? passed++ : failed++;
};

async function start(limits = {}, overrides = {}, banCheck = null) {
  const calls = [];
  const config = { allowedOrigins: ['http://localhost:5173'], trustedProxyHops: 0, limits, ...overrides };
  const { server, io } = createApp({
    config,
    hash,
    isBanned: async (args) => { calls.push(args); return banCheck ? banCheck(args) : false; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    io,
    calls,
    close: () => new Promise((r) => io.close(r)),
  };
}

function client(url, headers = {}) {
  const s = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: 'http://localhost:5173', ...headers },
  });
  s.events = [];
  s.gone = false;
  s.onAny((name, payload) => s.events.push({ name, payload }));
  s.on("disconnect", () => { s.gone = true; });
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(20); }
  return false;
}
const got = (s, name, code) => s.events.some((e) => e.name === name && (code === undefined || e.payload.code === code));

async function joinOnce(url, nickname, headers) {
  const c = await client(url, headers);
  c.emit('join', { nickname, ageConfirmed: true });
  await until(() => c.events.length > 0);
  const first = c.events[0];
  c.close();
  return first ? (first.name === 'error' ? `error:${first.payload.code}` : first.name) : 'none';
}

(async () => {
  // ---- connection cap per IP ----
  let t = await start({ maxConnectionsPerIp: 3 });
  const open = [];
  for (let i = 0; i < 3; i++) open.push(await client(t.url));
  await wait(150);
  check(open.every((c) => !c.gone && c.events.length === 0), 'connections up to the cap are accepted');
  const over = await client(t.url);
  check(await until(() => got(over, 'error', 'rate_limited')), '4th connection -> error rate_limited');
  check(await until(() => over.gone), '4th connection is disconnected');
  open[0].close();
  await until(() => t.io.sockets.sockets.size <= 2);
  const again = await client(t.url);
  await wait(150);
  check(!again.gone && again.events.length === 0, 'closing a connection frees a slot');
  [...open, again].forEach((c) => c.close());
  await t.close();

  // ---- cap is per IP: a different client IP is unaffected ----
  t = await start({ maxConnectionsPerIp: 1 }, { trustedProxyHops: 1 });
  const a = await client(t.url, { 'X-Forwarded-For': '5.5.5.5' });
  const b = await client(t.url, { 'X-Forwarded-For': '6.6.6.6' });
  await wait(150);
  check(!a.gone && !b.gone, 'a different IP has its own connection allowance');
  const a2 = await client(t.url, { 'X-Forwarded-For': '5.5.5.5' });
  check(await until(() => got(a2, 'error', 'rate_limited')), 'the same IP is capped');
  [a, b, a2].forEach((c) => c.close());
  await t.close();

  // ---- join rate limit ----
  t = await start({ joinsPerMinute: 3 });
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await joinOnce(t.url, `Visitor${i}`));
  check(results.join() === 'waiting,waiting,waiting,error:rate_limited', '4th join in a minute -> rate_limited', `(got ${results})`);
  check(t.calls.length === 3, 'the rate-limited join never reached the ban check');
  await t.close();

  // ---- invalid attempts also count, and never reach the database ----
  t = await start({ joinsPerMinute: 3 });
  const bad = [];
  for (let i = 0; i < 3; i++) {
    const c = await client(t.url);
    c.emit('join', { nickname: '<x>', ageConfirmed: true });
    await until(() => c.events.length > 0);
    bad.push(c.events[0].payload.code);
    c.close();
  }
  check(bad.join() === 'invalid,invalid,invalid', 'invalid joins answer invalid while tokens remain');
  const valid = await joinOnce(t.url, 'RealUser');
  check(valid === 'error:rate_limited', 'after 3 invalid attempts even a valid join is rate limited', `(got ${valid})`);
  check(t.calls.length === 0, 'database was never queried');
  await t.close();

  // ---- join limit is per IP ----
  t = await start({ joinsPerMinute: 1 }, { trustedProxyHops: 1 });
  const r1 = await joinOnce(t.url, 'FirstUser', { 'X-Forwarded-For': '5.5.5.5' });
  const r2 = await joinOnce(t.url, 'SecondUser', { 'X-Forwarded-For': '5.5.5.5' });
  const r3 = await joinOnce(t.url, 'ThirdUser', { 'X-Forwarded-For': '6.6.6.6' });
  check(r1 === 'waiting' && r2 === 'error:rate_limited' && r3 === 'waiting', 'join allowance is per IP', `(got ${r1},${r2},${r3})`);
  await t.close();

  // ---- join timeout ----
  t = await start({ joinTimeoutMs: 400 });
  const idle = await client(t.url);
  const joiner = await client(t.url);
  joiner.emit('join', { nickname: 'OnTime', ageConfirmed: true });
  check(await until(() => idle.gone, 2000), 'a socket that never joins is dropped');
  await wait(300);
  check(!joiner.gone && got(joiner, 'waiting'), 'a socket that joined in time stays connected');
  joiner.close();
  await t.close();

  // ---- join timeout also covers a ban check that never answers ----
  t = await start({ joinTimeoutMs: 400 }, {}, () => new Promise(() => {}));
  const stuck = await client(t.url);
  stuck.emit('join', { nickname: 'Stuck1', mode: 'text', ageConfirmed: true });
  await until(() => t.calls.length === 1);
  check(await until(() => stuck.gone, 2000), 'a visitor whose ban check never answers is dropped');
  await t.close();

  // ---- overall event cap per socket ----
  t = await start({ eventBurst: 20, eventsPerSecond: 5 });
  const flooder = await client(t.url);
  const bystander = await client(t.url);
  for (let i = 0; i < 40; i++) flooder.emit('stop');
  check(await until(() => got(flooder, 'error', 'rate_limited')), 'flooding events -> error rate_limited');
  check(await until(() => flooder.gone), 'a flooding socket is disconnected');
  await wait(100);
  check(!bystander.gone && bystander.events.length === 0, 'another connection is not affected by the flood');
  const polite = await client(t.url);
  for (let i = 0; i < 10; i++) polite.emit('stop');
  await wait(200);
  check(!polite.gone && !got(polite, 'error', 'rate_limited'), 'normal bursts of events are fine');
  [bystander, polite].forEach((c) => c.close());
  await t.close();

  // ---- shipped defaults are generous enough for shared addresses ----
  check(DEFAULT_LIMITS.maxConnectionsPerIp >= 100 && DEFAULT_LIMITS.joinsPerMinute >= 120,
    'default per-IP limits allow many people behind one address');

  // ---- message size cap ----
  t = await start({ maxMessageBytes: 1000 });
  const big = await client(t.url);
  big.emit('join', { nickname: 'Big', mode: 'text', ageConfirmed: true, deviceToken: 'x'.repeat(5000) });
  check(await until(() => big.gone), 'an oversized message closes the connection');
  check(t.calls.length === 0, 'an oversized message is never processed');
  const small = await client(t.url);
  small.emit('join', { nickname: 'Small', ageConfirmed: true });
  check(await until(() => got(small, 'waiting')), 'normal-sized messages still work');
  small.close();
  await t.close();

  // ---- message limit (per visitor) ----
  t = await start({ messageBurst: 3, messagesPerMinute: 60 });
  const alice = await client(t.url);
  const bob = await client(t.url);
  alice.emit('join', { nickname: 'Alice1', mode: 'text', ageConfirmed: true });
  await until(() => got(alice, 'waiting'));
  bob.emit('join', { nickname: 'Bobby1', mode: 'text', ageConfirmed: true });
  await until(() => got(alice, 'matched') && got(bob, 'matched'));
  for (let i = 0; i < 5; i++) alice.emit('message', { text: `m${i}` });
  const limitedCount = () => alice.events.filter((e) => e.name === 'error' && e.payload.code === 'rate_limited').length;
  check(await until(() => limitedCount() === 2), '5 quick messages with a burst of 3 -> 2 rate_limited');
  await wait(150);
  check(bob.events.filter((e) => e.name === 'message').length === 3, 'the partner receives only the 3 allowed messages');
  bob.emit('message', { text: 'hello back' });
  check(await until(() => alice.events.some((e) => e.name === 'message' && e.payload.text === 'hello back')),
    "one visitor's limit does not affect the other");
  alice.close(); bob.close();
  await t.close();

  // ---- next limit (per visitor) ----
  t = await start({ nextBurst: 2, nextsPerMinute: 60 });
  const solo = await client(t.url);
  solo.emit('join', { nickname: 'Solo11', mode: 'text', ageConfirmed: true });
  await until(() => got(solo, 'waiting'));
  for (let i = 0; i < 4; i++) solo.emit('next');
  const nextLimited = () => solo.events.filter((e) => e.name === 'error' && e.payload.code === 'rate_limited').length;
  check(await until(() => nextLimited() === 2), '4 quick Next presses with a burst of 2 -> 2 rate_limited');
  solo.close();
  await t.close();

  console.log(`\npassed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();