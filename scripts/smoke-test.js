'use strict';

// Needs the real server running (npm start). Exercises the real database path.

const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;
const ORIGIN = { Origin: 'http://localhost:5173' };

function tryConnect(label, headers) {
  return new Promise((resolve) => {
    const socket = io(URL, { transports: ['websocket'], reconnection: false, extraHeaders: headers });
    const done = (result) => {
      socket.close();
      console.log(`${label}: ${result}`);
      resolve(result.startsWith('connected'));
    };
    socket.on('connect', () => done('connected'));
    socket.on('connect_error', (err) => done(`rejected (${err.message})`));
    setTimeout(() => done('timeout'), 3000);
  });
}

// Connect, send join, and report the first server reply (waiting / error / nothing).
function tryJoin(label, payload) {
  return new Promise((resolve) => {
    const socket = io(URL, { transports: ['websocket'], reconnection: false, extraHeaders: ORIGIN });
    const done = (result) => {
      socket.close();
      console.log(`${label}: ${result}`);
      resolve(result);
    };
    socket.on('connect', () => socket.emit('join', payload));
    socket.on('waiting', () => done('waiting'));
    socket.on('error', (e) => done(`error ${e && e.code}`));
    socket.on('connect_error', (err) => done(`connect_error (${err.message})`));
    setTimeout(() => done('timeout (is the database reachable?)'), 8000);
  });
}

(async () => {
  const health = await fetch(`${URL}/health`).then((r) => r.json());
  console.log('GET /health:', JSON.stringify(health));

  let pass = health.status === 'ok';
  const origins = [
    // [label, headers, should connect?]
    ['allowed origin   ', ORIGIN, true],
    ['no origin header ', {}, true],
    ['evil origin      ', { Origin: 'http://evil.example' }, false],
  ];
  for (const [label, headers, expected] of origins) {
    const connected = await tryConnect(label, headers);
    const ok = connected === expected;
    console.log(`  -> ${ok ? 'PASS' : 'FAIL'} (expected ${expected ? 'connect' : 'reject'})`);
    pass = pass && ok;
  }

  const joins = [
    // [label, payload, expected reply]
    ['join valid (real DB)', { ageConfirmed: true, nickname: 'SmokeTest', mode: 'text' }, 'waiting'],
    ['join invalid        ', { ageConfirmed: true, nickname: '<b>', mode: 'text' }, 'error invalid'],
    ['join without 18+    ', { nickname: 'SmokeTest', mode: 'text' }, 'error invalid'],
  ];
  for (const [label, payload, expected] of joins) {
    const result = await tryJoin(label, payload);
    const ok = result === expected;
    console.log(`  -> ${ok ? 'PASS' : 'FAIL'} (expected ${expected})`);
    pass = pass && ok;
  }

  console.log(pass ? '\nALL PASS' : '\nSOME FAILED');
  process.exit(pass ? 0 : 1);
})();