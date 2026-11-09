'use strict';

const { createRateLimiter } = require('../src/rateLimiter');

let passed = 0;
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` ${detail}`}`);
  ok ? passed++ : failed++;
};

// 3 tokens, refilling 3 per minute (1 per 20 s), driven by a fake clock.
function make() {
  let t = 0;
  const limiter = createRateLimiter({ capacity: 3, refillPerMs: 3 / 60000, now: () => t });
  return { limiter, advance: (ms) => { t += ms; } };
}

let { limiter, advance } = make();
check([1, 2, 3].every(() => limiter.take('a').allowed), 'allows up to capacity');
let r = limiter.take('a');
check(!r.allowed, 'blocks beyond capacity');
check(r.retryAfterMs > 0 && r.retryAfterMs <= 20000, 'reports a sensible retry delay', `(got ${r.retryAfterMs})`);
check(limiter.take('b').allowed, 'other keys are independent');

advance(19000);
check(!limiter.take('a').allowed, 'not refilled too early');
advance(1000);
check(limiter.take('a').allowed, 'one token is back after 20 seconds');
check(!limiter.take('a').allowed, 'and only one');

advance(10 * 60000);
const burst = [1, 2, 3, 4].map(() => limiter.take('a').allowed);
check(burst.join() === 'true,true,true,false', 'long idle refills to capacity, never beyond');

({ limiter, advance } = make());
limiter.take('x');
limiter.take('y');
limiter.take('y');
limiter.take('y');
check(limiter.size() === 2, 'two keys tracked');
advance(30000);
limiter.sweep();
check(limiter.size() === 1, 'sweep drops a fully refilled key, keeps a depleted one');
advance(60000);
limiter.sweep();
check(limiter.size() === 0, 'sweep drops everything once refilled');
check(limiter.take('y').allowed, 'a swept key starts full again');

({ limiter, advance } = make());
limiter.take('s'); limiter.take('s'); limiter.take('s');
check(!limiter.take('s').allowed, 'a depleted key is blocked');
limiter.forget('s');
check(limiter.size() === 0 && limiter.take('s').allowed, 'forget() releases a key, which then starts full');

limiter.stop();
console.log(`\npassed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);