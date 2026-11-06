import { randomInt } from 'node:crypto';

/** Kayıt, `startMs + DELIVERY_DELAY_MS` anına kadar PENDING kalır. */
export const DELIVERY_DELAY_MS = 5000;

/**
 * Görev deposu. Görevler hesap başına tutulur; kayıtlar `{ index, recipient, text }` olarak saklanır.
 * @param {{ clock: import('./clock.mjs').Clock }} deps
 */
export function createJobStore({ clock }) {
  const byAccount = new Map(); // accountId -> Map(jobId -> Job)
  const usedIds = new Set();

  function newJobId() {
    for (;;) {
      const id = String(randomInt(1_000_000_000, 10_000_000_000));
      if (!usedIds.has(id)) { usedIds.add(id); return id; }
    }
  }

  return {
    create(job) {
      const created = { encoding: 'DEFAULT', alphanumericSender: false, ...job, jobId: newJobId(), createdMs: clock.now() };
      let jobs = byAccount.get(created.accountId);
      if (!jobs) { jobs = new Map(); byAccount.set(created.accountId, jobs); }
      jobs.set(created.jobId, created);
      return created;
    },
    get(accountId, jobId) {
      return byAccount.get(accountId)?.get(String(jobId)) ?? null;
    },
    all(accountId) {
      return [...(byAccount.get(accountId)?.values() ?? [])];
    },
  };
}

/**
 * Bir kaydın o anki iletim durumu. Alıcının son iki hanesi `00` ise abone bulunamaz.
 * @returns {{ status: 'PENDING'|'DELIVERED'|'NOT_DELIVERED', failReason: string|null, deliveredAt: number|null }}
 */
export function deliveryOf(job, record, nowMs) {
  // İptal edilen görev hiç gönderilmez: asla teslim edilmiş görünmez.
  if (job.status === 'CANCELLED') return { status: 'PENDING', failReason: null, deliveredAt: null };
  const at = job.startMs + DELIVERY_DELAY_MS;
  if (nowMs < at) return { status: 'PENDING', failReason: null, deliveredAt: null };
  if (String(record.recipient).endsWith('00')) {
    return { status: 'NOT_DELIVERED', failReason: 'UNKNOWN_SUBSCRIBER', deliveredAt: null };
  }
  return { status: 'DELIVERED', failReason: null, deliveredAt: at };
}

/**
 * Raporlanabilir görev mi? OTP görevleri GET /report ve /stats ile sorgulanamaz (spec);
 * iptal edilen görev hiç gönderilmediği için rapor satırı üretmez.
 */
export function isReportable(job) {
  return job.kind !== 'OTP' && job.status !== 'CANCELLED';
}
