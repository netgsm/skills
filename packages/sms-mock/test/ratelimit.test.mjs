import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixedWindowLimiter } from '../src/ratelimit.mjs';
import { createManualClock } from '../src/clock.mjs';

test('sabit pencere: ilk istekle başlar, limit aşılınca Retry-After kalan saniyedir', () => {
  const clock = createManualClock();
  const l = createFixedWindowLimiter({ limit: 2, windowMs: 60_000, countRejected: false, clock });
  assert.equal(l.hit('a').allowed, true);
  clock.advance(10_000);
  assert.equal(l.hit('a').allowed, true);
  const third = l.hit('a');
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSec, 50);
  clock.advance(50_000);
  assert.equal(l.hit('a').allowed, true);
});

test('rateScale limiti küçültür ama 1 in altına indirmez', () => {
  const l = createFixedWindowLimiter({ limit: 20, windowMs: 60_000, countRejected: true, clock: createManualClock(), rateScale: 0.001 });
  assert.equal(l.hit('k').limit, 1);
});

test('countRejected=true: reddedilenler sayılır, pencere ilk istekten başlayıp uzamaz', () => {
  const clock = createManualClock();
  const l = createFixedWindowLimiter({ limit: 2, windowMs: 60_000, countRejected: true, clock });
  assert.equal(l.hit('k').count, 1);
  clock.advance(20_000);
  assert.equal(l.hit('k').count, 2);
  clock.advance(20_000);
  const rejected = l.hit('k');
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.count, 3);
  assert.equal(rejected.remaining, 0);
  assert.equal(rejected.resetSec, 20);
  assert.equal(l.hit('k').count, 4);
  clock.advance(19_999);
  assert.equal(l.hit('k').allowed, false);
  clock.advance(1); // ilk istekten tam 60 sn sonra pencere sıfırlanır
  const fresh = l.hit('k');
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.count, 1);
});

test('countRejected=false: reddedilen istek sayacı değiştirmez', () => {
  const clock = createManualClock();
  const l = createFixedWindowLimiter({ limit: 2, windowMs: 60_000, countRejected: false, clock });
  l.hit('k'); l.hit('k');
  assert.equal(l.hit('k').count, 2);
  assert.equal(l.hit('k').count, 2);
  clock.advance(60_000);
  assert.equal(l.hit('k').count, 1);
});
