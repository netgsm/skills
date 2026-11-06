/** @typedef {{ now(): number, advance(ms: number): void, reset?(): void }} Clock */

/** Gerçek saat artı `advance` ile eklenen ofset. */
export function createClock() {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance(ms) { offset += ms; },
    reset() { offset = 0; },
  };
}

/** Zaman yalnızca `advance` ile ilerler; ms sınırı doğrulayan testler için. */
export function createManualClock(startMs = Date.now()) {
  let t = startMs;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    reset() { t = startMs; },
  };
}
