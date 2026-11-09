'use strict';

const { performance } = require('perf_hooks');

// In-memory token bucket, one bucket per key (e.g. an IP hash).
// `capacity` tokens are available at once; they refill at `refillPerMs`.
// A missing bucket is treated as full, so idle buckets can be swept safely.
// When we scale to several server instances this is the piece that moves to Redis.
// The default clock is monotonic (performance.now), so a system clock change cannot block
// anyone; elapsed time is also clamped at 0 for injected clocks that go backwards.
function createRateLimiter({ capacity, refillPerMs, now = () => performance.now() }) {
  const buckets = new Map();

  function refill(bucket, t) {
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, t - bucket.last) * refillPerMs);
    bucket.last = t;
  }

  function take(key) {
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, last: t };
      buckets.set(key, bucket);
    } else {
      refill(bucket, t);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / refillPerMs) };
  }

  // Drops buckets that have fully refilled (they would be recreated full anyway).
  function sweep() {
    const t = now();
    for (const [key, bucket] of buckets) {
      if (bucket.tokens + Math.max(0, t - bucket.last) * refillPerMs >= capacity) buckets.delete(key);
    }
  }

  const timer = setInterval(sweep, 60000);
  timer.unref();

  // Release a key right away (e.g. when its socket disconnects).
  function forget(key) {
    buckets.delete(key);
  }

  return { take, forget, sweep, size: () => buckets.size, stop: () => clearInterval(timer) };
}

module.exports = { createRateLimiter };