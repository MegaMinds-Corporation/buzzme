'use strict';

// Tests src/services/matchmaker.js directly: no sockets, no database.

const { createMatchmaker } = require('../src/services/matchmaker');
const { MODES } = require('../src/config/modes');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${detail}`}`);
  ok ? passed++ : failed++;
};
const throwsType = (fn) => { try { fn(); return false; } catch (e) { return e instanceof TypeError; } };
const U = (id, mode = 'text') => ({ id, nickname: `Nick-${id}`, mode });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- basic pairing ----
let m = createMatchmaker();
let r = m.enqueue(U('a'));
check(r.status === 'waiting', 'first visitor waits');
check(m.stateOf('a') === 'waiting' && m.stats().waiting.text === 1, 'waiting visitor is queued');
r = m.enqueue(U('b'));
check(r.status === 'matched' && r.mode === 'text', 'second visitor in same mode is matched');
check(r.initiatorId === 'a', 'the visitor who waited longer is the initiator');
check(r.members.length === 2 && r.members[0].id === 'a' && r.members[0].nickname === 'Nick-a' && r.members[1].id === 'b', 'result lists both members with nicknames');
check(UUID_RE.test(r.sessionId), 'session id is a random UUID');
check(m.partnerOf('a') === 'b' && m.partnerOf('b') === 'a', 'partnerOf works both ways');
const sess = m.sessionOf('b');
check(sess.partnerId === 'a' && sess.mode === 'text' && sess.sessionId === r.sessionId, 'sessionOf describes the session');
check(m.stats().sessions === 1 && m.stats().waiting.text === 0 && m.stats().users === 2, 'stats after a match');

// ---- modes never mix ----
m = createMatchmaker();
check(m.enqueue(U('v', 'video')).status === 'waiting', 'video visitor waits');
check(m.enqueue(U('x', 'voice')).status === 'waiting', 'voice visitor does not match video');
check(m.enqueue(U('t', 'text')).status === 'waiting', 'text visitor does not match video or voice');
check(m.stats().waiting.video === 1 && m.stats().waiting.voice === 1 && m.stats().waiting.text === 1, 'each mode has its own queue');
r = m.enqueue(U('v2', 'video'));
check(r.status === 'matched' && r.initiatorId === 'v' && m.partnerOf('v2') === 'v', 'second video visitor matches the first video visitor');
check(m.stateOf('x') === 'waiting' && m.stateOf('t') === 'waiting', 'other modes are untouched');

// ---- distinct session ids ----
m = createMatchmaker();
m.enqueue(U('a')); const s1 = m.enqueue(U('b')).sessionId;
m.enqueue(U('c')); const s2 = m.enqueue(U('d')).sessionId;
check(s1 !== s2, 'every session gets a different id');

// ---- Next: new person, never the one just left ----
m = createMatchmaker();
m.enqueue(U('a'));
const abSession = m.enqueue(U('b')).sessionId;
r = m.next('a');
check(r.ended && r.ended.partnerId === 'b' && r.ended.sessionId === abSession, 'next reports who to notify with partner_left');
check(r.status === 'waiting' && m.stateOf('a') === 'waiting', 'next puts the leaver back in the queue');
check(m.stateOf('b') === 'idle' && m.partnerOf('b') === null && m.partnerOf('a') === null, 'the other person becomes idle');
check(m.stats().sessions === 0, 'session is gone after next');
r = m.enqueue(U('b'));
check(r.status === 'waiting', 'b is NOT re-matched with the person just left');
check(m.stats().waiting.text === 2, 'both wait for someone new');
r = m.enqueue(U('c'));
check(r.status === 'matched' && r.initiatorId === 'a' && m.partnerOf('c') === 'a', 'newcomer is matched with the longest waiter (FIFO)');
check(m.stateOf('b') === 'waiting', 'the other waiter keeps waiting');
// c presses Next: a is skipped (just left), b is waiting and not a recent partner
r = m.next('c');
check(r.ended && r.ended.partnerId === 'a', 'c leaving reports a as the partner to notify');
check(r.status === 'matched' && m.partnerOf('c') === 'b' && m.stateOf('a') === 'idle', 'next matches c with b, not with a');
check(m.enqueue(U('a')).status === 'waiting', 'a, who just left c, waits for someone new');

// ---- next edge cases ----
m = createMatchmaker();
check(m.next('ghost').status === 'unknown' && m.next('ghost').ended === null, 'next for an unknown visitor says unknown');
m.enqueue(U('a'));
r = m.next('a');
check(r.status === 'waiting' && r.ended === null && m.stats().waiting.text === 1, 'next while waiting keeps the place in line');
m = createMatchmaker();
m.enqueue(U('b')); m.stop('b'); // b is idle and has never talked to anyone
m.enqueue(U('a'));              // a waits
r = m.next('b');
check(r.status === 'matched' && r.ended === null && m.partnerOf('b') === 'a', 'next from idle searches again and finds the waiting visitor');

// ---- stop ----
m = createMatchmaker();
m.enqueue(U('a')); m.enqueue(U('b'));
r = m.stop('a');
check(r.ended && r.ended.partnerId === 'b', 'stop in a session reports the partner');
check(m.stateOf('a') === 'idle' && m.stateOf('b') === 'idle' && m.stats().sessions === 0, 'stop makes both idle');
check(m.stop('a').ended === null, 'stop when idle does nothing');
m.enqueue(U('c'));
check(m.stateOf('c') === 'waiting', 'c waits (a and b are idle)');
check(m.stop('c').ended === null && m.stateOf('c') === 'idle' && m.stats().waiting.text === 0, 'stop while waiting leaves the queue');
check(m.stop('ghost').ended === null, 'stop for an unknown visitor does nothing');

// ---- disconnect ----
m = createMatchmaker();
m.enqueue(U('a'));
check(m.disconnect('a').ended === null && m.stats().waiting.text === 0 && m.stats().users === 0, 'waiting visitor who disconnects is removed from the queue');
m.enqueue(U('a')); m.enqueue(U('b'));
r = m.disconnect('a');
check(r.ended && r.ended.partnerId === 'b', 'disconnect in a session reports the partner');
check(m.stateOf('a') === null && m.stateOf('b') === 'idle' && m.stats().sessions === 0 && m.stats().users === 1, 'disconnected visitor is forgotten, partner is idle');
check(m.disconnect('a').ended === null, 'disconnecting twice is harmless');
check(m.next('a').status === 'unknown', 'a forgotten visitor is unknown');
check(m.enqueue(U('b')).status === 'waiting', 'the partner can search again');

// ---- busy ----
m = createMatchmaker();
m.enqueue(U('a'));
check(m.enqueue(U('a')).status === 'busy' && m.stats().waiting.text === 1, 'enqueue while waiting is busy and does not duplicate');
m.enqueue(U('b'));
check(m.enqueue(U('a')).status === 'busy' && m.enqueue(U('b')).status === 'busy' && m.stats().sessions === 1, 'enqueue while matched is busy');

// ---- idle visitor may change mode ----
m = createMatchmaker();
m.enqueue(U('a', 'text')); m.stop('a');
r = m.enqueue(U('a', 'video'));
check(r.status === 'waiting' && m.stats().waiting.video === 1 && m.stats().waiting.text === 0, 'an idle visitor can come back in another mode');

// ---- recentLimit ----
m = createMatchmaker({ recentLimit: 0 });
m.enqueue(U('a')); m.enqueue(U('b')); m.next('a');
check(m.enqueue(U('b')).status === 'matched', 'recentLimit 0 allows immediate re-match');
// a talks to b, then to c, then presses Next: a is alone in the queue, b and c are idle
function aTalkedToBThenC(options) {
  const mm = createMatchmaker(options);
  mm.enqueue(U('a')); mm.enqueue(U('b')); mm.next('a'); // a waits, b idle
  mm.enqueue(U('c'));                                    // c matches a
  mm.next('a');                                          // a waits again; b and c idle
  return mm;
}
// b reconnects with an empty memory, so only a's own memory decides whether they match
m = aTalkedToBThenC({ recentLimit: 1 }); m.disconnect('b');
check(m.enqueue(U('b')).status === 'matched' && m.partnerOf('b') === 'a', 'recentLimit 1 only remembers the LAST partner: a would meet b again');
m = aTalkedToBThenC({ recentLimit: 2 }); m.disconnect('b');
check(m.enqueue(U('b')).status === 'waiting', 'recentLimit 2 also remembers the partner before last: a skips b');
m = aTalkedToBThenC({ recentLimit: 2 });
check(m.enqueue(U('b')).status === 'waiting', 'b waits too (b remembers a)');
r = m.enqueue(U('c'));
check(r.status === 'matched' && m.partnerOf('c') === 'b' && m.stateOf('a') === 'waiting', 'b and c (strangers to each other) are matched; a keeps waiting');

// ---- input validation ----
m = createMatchmaker();
check(throwsType(() => m.enqueue(null)), 'null user throws');
check(throwsType(() => m.enqueue({ nickname: 'x', mode: 'text' })), 'missing id throws');
check(throwsType(() => m.enqueue({ id: '', nickname: 'x', mode: 'text' })), 'empty id throws');
check(throwsType(() => m.enqueue({ id: 5, nickname: 'x', mode: 'text' })), 'non-string id throws');
check(throwsType(() => m.enqueue({ id: 'a', mode: 'text' })), 'missing nickname throws');
check(throwsType(() => m.enqueue({ id: 'a', nickname: 'x', mode: 'audio' })), 'unknown mode throws');
check(m.stats().users === 0, 'rejected input leaves no trace');

// ---- randomized stress: invariants must hold after every operation ----
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stress(seed, ops) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const mm = createMatchmaker();
  const ids = Array.from({ length: 40 }, (_, i) => `u${i}`);
  const connected = new Set();
  const modeOf = new Map();
  const lastPartner = new Map();
  let problem = null;
  const fail = (msg) => { if (!problem) problem = `seed ${seed}: ${msg}`; };

  function noteEnded(id, ended) {
    if (!ended) return;
    lastPartner.set(id, ended.partnerId);
    lastPartner.set(ended.partnerId, id);
  }
  function noteResult(id, res) {
    if (res.status !== 'matched') return;
    const [x, y] = res.members.map((mem) => mem.id);
    if (x === y) fail('matched with self');
    if (modeOf.get(x) !== res.mode || modeOf.get(y) !== res.mode) fail('modes mixed in a match');
    if (lastPartner.get(x) === y || lastPartner.get(y) === x) fail('re-matched a recent partner');
    if (!res.members.some((mem) => mem.id === id)) fail('match does not include the caller');
  }

  for (let i = 0; i < ops && !problem; i++) {
    const id = pick(ids);
    const op = pick(['enqueue', 'enqueue', 'next', 'stop', 'disconnect']);
    if (op === 'enqueue') {
      const mode = pick(MODES);
      const res = mm.enqueue({ id, nickname: `n-${id}`, mode });
      if (res.status !== 'busy') { connected.add(id); modeOf.set(id, mode); }
      noteResult(id, res);
    } else if (op === 'next') {
      const res = mm.next(id);
      noteEnded(id, res.ended);
      noteResult(id, res);
    } else if (op === 'stop') {
      noteEnded(id, mm.stop(id).ended);
    } else {
      noteEnded(id, mm.disconnect(id).ended);
      connected.delete(id); lastPartner.delete(id);
    }

    // invariants
    let matched = 0;
    const waiting = { video: 0, voice: 0, text: 0 };
    for (const uid of ids) {
      const st = mm.stateOf(uid);
      if (!connected.has(uid)) { if (st !== null) fail(`${uid} should be unknown`); continue; }
      if (st === 'matched') {
        matched++;
        const p = mm.partnerOf(uid);
        if (p === null || p === uid || mm.partnerOf(p) !== uid || mm.stateOf(p) !== 'matched') fail(`${uid} partner link is not symmetric`);
        const s = mm.sessionOf(uid);
        if (!s || s.partnerId !== p || s.mode !== modeOf.get(uid) || s.mode !== modeOf.get(p)) fail(`${uid} session info is wrong`);
      } else if (st === 'waiting') {
        waiting[modeOf.get(uid)]++;
        if (mm.partnerOf(uid) !== null) fail(`${uid} is waiting but has a partner`);
      } else if (st === 'idle') {
        if (mm.partnerOf(uid) !== null) fail(`${uid} is idle but has a partner`);
      } else fail(`${uid} has no state`);
    }
    const stt = mm.stats();
    if (stt.sessions * 2 !== matched) fail(`sessions (${stt.sessions}) vs matched users (${matched})`);
    if (stt.users !== connected.size) fail('user count drifted');
    for (const mode of MODES) if (stt.waiting[mode] !== waiting[mode]) fail(`queue size drifted for ${mode}`);
  }
  return problem;
}

for (const seed of [1, 2, 3, 4, 5]) {
  const problem = stress(seed, 20000);
  check(problem === null, `stress run, seed ${seed}: 20000 random operations keep every invariant`, problem || '');
}

console.log(`\npassed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
