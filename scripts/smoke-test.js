'use strict';

const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}`;

function tryConnect(label, headers) {
  return new Promise((resolve) => {
    const socket = io(URL, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: headers,
    });
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

(async () => {
  const health = await fetch(`${URL}/health`).then((r) => r.json());
  console.log('GET /health:', JSON.stringify(health));

  const results = [
    // [label, headers, should connect?]
    ['allowed origin   ', { Origin: 'http://localhost:5173' }, true],
    ['no origin header ', {}, true],
    ['evil origin      ', { Origin: 'http://evil.example' }, false],
  ];
  let pass = health.status === 'ok';
  for (const [label, headers, expected] of results) {
    const connected = await tryConnect(label, headers);
    const ok = connected === expected;
    console.log(`  -> ${ok ? 'PASS' : 'FAIL'} (expected ${expected ? 'connect' : 'reject'})`);
    pass = pass && ok;
  }
  console.log(pass ? '\nALL PASS' : '\nSOME FAILED');
  process.exit(pass ? 0 : 1);
})();