'use strict';

// Starts its own copy of the server on a free port, then exercises the real database
// path (needs DATABASE_URL and IP_HASH_SECRET in .env). To test a server that is
// already running instead, set SMOKE_URL, e.g. SMOKE_URL=http://localhost:3000.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { io } = require('socket.io-client');

let URL = process.env.SMOKE_URL || null;
const ORIGIN = { Origin: 'http://localhost:5173' };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    // Fixed origin settings so the result does not depend on your .env values.
    env: { ...process.env, PORT: String(port), ALLOWED_ORIGINS: ORIGIN.Origin, TRUSTED_PROXY_HOPS: '0' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  process.on('exit', () => { if (!exited) child.kill('SIGTERM'); });

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error('server exited during startup (see messages above)');
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return { url, stop: () => child.kill('SIGTERM') };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy within 10 seconds');
}

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
  const started = URL ? null : await startServer();
  if (started) URL = started.url;
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
  if (started) started.stop();
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error('smoke test crashed:', err.message);
  process.exit(1);
});