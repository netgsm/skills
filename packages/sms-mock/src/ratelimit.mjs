/**
 * Sabit pencereli sayaç. Pencere anahtarın ilk isteğiyle başlar ve uzamaz.
 * countRejected=false iken reddedilen istekler sayılmaz.
 */
export function createFixedWindowLimiter({ limit, windowMs, countRejected, clock, rateScale = 1, registry }) {
  const effective = Math.max(1, Math.ceil(limit * rateScale));
  const windows = new Map();
  const limiter = {
    reset() { windows.clear(); },
    hit(key) {
      const now = clock.now();
      let w = windows.get(key);
      if (!w || now >= w.start + windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      const allowed = w.count < effective;
      if (allowed || countRejected) w.count++;
      const resetSec = Math.max(1, Math.ceil((w.start + windowMs - now) / 1000));
      return {
        allowed,
        limit: effective,
        count: w.count, // penceredeki sayılan istek (countRejected=false iken reddedilenler hariç)
        remaining: Math.max(0, effective - w.count),
        resetSec,
        retryAfterSec: allowed ? 0 : resetSec,
      };
    },
  };
  registry?.push(limiter);
  return limiter;
}
