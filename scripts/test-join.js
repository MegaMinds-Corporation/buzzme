'use strict';

// Starts the real app in-process on a random port with a FAKE ban checker,
// so no database is touched. (isBanned itself is proven by test:bans.)

const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { makeHasher } = require('../src/hash');

const hash = makeHasher('t'.repeat(40));
let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${detail}`}`);
  ok ? passed++ : failed++;
};

async function start(overrides = {}, isBanned = async () => false) {
  const calls = [];
  const config = { allowedOrigins: ['http://localhost:5173'], trustedProxyHops: 0, ...overrides };
  const { server, io } = createApp({
    config,
    hash,
    isBanned: async (args) => { calls.push(args); return isBanned(args); },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => io.close(r));
  return { url, io, calls, close };
}

function client(url, headers = {}) {
  const s = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: 'http://localhost:5173', ...headers },
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
  while (Date.now() < end) { if (fn()) return true; await wait(20); }
  return false;
}
const names = (s) => s.events.map((e) => e.name).join(',');

(async () => {
  // ---- valid join ----
  let t = await start();
  let c = await client(t.url);
  c.emit('join', { nickname: '  Kofi   Mensah ', mode: 'text' });
  check(await until(() => names(c) === 'waiting'), 'valid join -> waiting');
  const serverSide = [...t.io.sockets.sockets.values()][0];
  check(serverSide.data.nickname === 'Kofi Mensah', 'nickname is trimmed and whitespace-collapsed');
  check(serverSide.data.mode === 'text', 'mode is stored');
  check(t.calls.length === 1 && t.calls[0].deviceTokenHash === null, 'ban check ran once, no device token');
  check(/^[0-9a-f]{64}$/.test(t.calls[0].ipHash), 'ban check receives a hash, not an IP');
  check(t.calls[0].ipHash === hash('127.0.0.1'), 'hops=0 hashes the socket address');
  c.emit('join', { nickname: 'Again', mode: 'text' });
  check(await until(() => c.events.some((e) => e.name === 'error' && e.payload.code === 'invalid')), 'second join -> invalid');
  c.close();

  // ---- default mode ----
  c = await client(t.url);
  c.emit('join', { nickname: 'DefaultMode' });
  await until(() => names(c) === 'waiting');
  const last = [...t.io.sockets.sockets.values()].pop();
  check(last.data.mode === 'video', 'mode defaults to video');
  c.close();

  // ---- invalid payloads ----
  const bad = [
    ['null payload', null],
    ['string payload', 'hello'],
    ['missing nickname', { mode: 'text' }],
    ['nickname not a string', { nickname: 42 }],
    ['nickname too short', { nickname: 'a' }],
    ['nickname too long', { nickname: 'x'.repeat(21) }],
    ['nickname with markup', { nickname: '<script>x</script>' }],
    ['unknown mode', { nickname: 'Valid', mode: 'audio' }],
    ['device token wrong type', { nickname: 'Valid', deviceToken: 5 }],
    ['device token too long', { nickname: 'Valid', deviceToken: 'x'.repeat(129) }],
  ];
  const before = t.calls.length;
  for (const [label, payload] of bad) {
    c = await client(t.url);
    c.emit('join', payload);
    const ok = await until(() => c.events.length === 1);
    check(ok && c.events[0].name === 'error' && c.events[0].payload.code === 'invalid', `${label} -> invalid`);
    c.close();
  }
  check(t.calls.length === before, 'invalid joins never reach the ban check');
  await t.close();

  // ---- device token is hashed before the ban check ----
  t = await start();
  c = await client(t.url);
  c.emit('join', { nickname: 'Tokened', deviceToken: 'secret-device-token' });
  await until(() => names(c) === 'waiting');
  check(t.calls[0].deviceTokenHash === hash('secret-device-token'), 'device token reaches the ban check hashed');
  check(t.calls[0].deviceTokenHash !== 'secret-device-token', 'raw device token is never passed on');
  c.close();
  await t.close();

  // ---- banned ----
  t = await start({}, async () => true);
  c = await client(t.url);
  let disconnected = false;
  c.on('disconnect', () => { disconnected = true; });
  c.emit('join', { nickname: 'Banned1' });
  check(await until(() => c.events.some((e) => e.name === 'error' && e.payload.code === 'banned')), 'banned -> error banned');
  check(await until(() => disconnected), 'banned visitor is disconnected');
  check(!c.events.some((e) => e.name === 'waiting'), 'banned visitor never gets waiting');
  await t.close();

  // ---- ban check failure fails closed ----
  t = await start({}, async () => { throw new Error('db down'); });
  c = await client(t.url);
  const origErr = console.error; console.error = () => {};
  c.emit('join', { nickname: 'DbDown1' });
  const gotErr = await until(() => c.events.some((e) => e.name === 'error' && e.payload.code === 'server_error'));
  console.error = origErr;
  check(gotErr, 'ban check failure -> error server_error');
  check(!c.events.some((e) => e.name === 'waiting'), 'ban check failure never admits the visitor');
  c.close();
  await t.close();

  // ---- proxy handling ----
  t = await start({ trustedProxyHops: 1 });
  c = await client(t.url, { 'X-Forwarded-For': '9.9.9.9, 5.6.7.8' });
  c.emit('join', { nickname: 'Proxied' });
  await until(() => names(c) === 'waiting');
  check(t.calls[0].ipHash === hash('5.6.7.8'), 'hops=1 hashes the proxy-reported client, not the spoofed one');
  c.close();
  await t.close();

  t = await start({ trustedProxyHops: 0 });
  c = await client(t.url, { 'X-Forwarded-For': '9.9.9.9' });
  c.emit('join', { nickname: 'Spoofer' });
  await until(() => names(c) === 'waiting');
  check(t.calls[0].ipHash === hash('127.0.0.1'), 'hops=0 ignores a spoofed X-Forwarded-For end to end');
  c.close();
  await t.close();

  // ---- visitor leaves while the ban check is running ----
  let release;
  const gate = new Promise((r) => { release = r; });
  t = await start({}, () => gate);
  c = await client(t.url);
  const leaver = [...t.io.sockets.sockets.values()][0];
  c.emit('join', { nickname: 'Leaver' });
  await until(() => t.calls.length === 1);
  c.close();
  await until(() => leaver.disconnected);
  release(false);
  await wait(100);
  check(leaver.data.state !== 'joined', 'visitor who disconnects during the ban check is never admitted');
  await t.close();

  // ---- oversized message closes the connection ----
  t = await start();
  c = await client(t.url);
  let dropped = false;
  c.on('disconnect', () => { dropped = true; });
  c.emit('join', { nickname: 'Big', deviceToken: 'x'.repeat(40 * 1024) });
  check(await until(() => dropped), 'message over 32 KB drops the connection');
  check(t.calls.length === 0, 'oversized message never reaches the ban check');
  await t.close();

  console.log(`\npassed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();