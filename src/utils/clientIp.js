'use strict';

const net = require('net');

// "::ffff:1.2.3.4" (IPv4 seen over a dual-stack socket) -> "1.2.3.4",
// so one client never produces two different hashes.
function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  const mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const value = mapped ? mapped[1] : trimmed;
  return net.isIP(value) ? value : null;
}

// trustedProxyHops = how many proxies of YOURS sit in front of this server.
//   0 -> ignore X-Forwarded-For completely and use the socket's address.
//   N -> each trusted proxy appended the address it received the request from,
//        so the real client is the Nth entry from the RIGHT. Anything further
//        left was supplied by the client and is never trusted.
// If the header does not have the expected shape, fall back to the socket address.
function getClientIp(req, trustedProxyHops = 0) {
  const remote = normalizeIp(req.socket && req.socket.remoteAddress) || 'unknown';
  if (trustedProxyHops < 1) return remote;

  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string') return remote;
  const entries = header.split(',').map((e) => e.trim()).filter(Boolean);
  if (entries.length < trustedProxyHops) return remote;

  return normalizeIp(entries[entries.length - trustedProxyHops]) || remote;
}

module.exports = { getClientIp, normalizeIp };