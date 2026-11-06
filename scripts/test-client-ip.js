'use strict';

const { getClientIp, normalizeIp } = require('../src/clientIp');

let passed = 0;
let failed = 0;
const eq = (actual, expected, label) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` (expected ${expected}, got ${actual})`}`);
  ok ? passed++ : failed++;
};

const req = (remote, xff) => ({
  socket: { remoteAddress: remote },
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
});

eq(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4', 'IPv4-mapped IPv6 is normalized');
eq(normalizeIp('2001:db8::1'), '2001:db8::1', 'real IPv6 is kept');
eq(normalizeIp('not-an-ip'), null, 'garbage is rejected');

eq(getClientIp(req('1.2.3.4', '9.9.9.9'), 0), '1.2.3.4', 'hops=0 ignores a spoofed X-Forwarded-For');
eq(getClientIp(req('::ffff:1.2.3.4'), 0), '1.2.3.4', 'hops=0 normalizes the socket address');
eq(getClientIp(req('10.0.0.1', '5.6.7.8'), 1), '5.6.7.8', 'hops=1 reads the proxy-added entry');
eq(getClientIp(req('10.0.0.1', '9.9.9.9, 5.6.7.8'), 1), '5.6.7.8', 'hops=1 ignores a client-supplied extra entry');
eq(getClientIp(req('10.0.0.2', 'fake, 5.6.7.8, 10.0.0.1'), 2), '5.6.7.8', 'hops=2 takes the 2nd entry from the right');
eq(getClientIp(req('10.0.0.1'), 1), '10.0.0.1', 'hops=1 without the header falls back to the socket address');
eq(getClientIp(req('10.0.0.1', '5.6.7.8'), 2), '10.0.0.1', 'fewer entries than hops falls back to the socket address');
eq(getClientIp(req('10.0.0.1', 'garbage'), 1), '10.0.0.1', 'an invalid entry falls back to the socket address');
eq(getClientIp(req('10.0.0.1', '::ffff:5.6.7.8'), 1), '5.6.7.8', 'mapped IPv6 in the header is normalized');

console.log(`\npassed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);