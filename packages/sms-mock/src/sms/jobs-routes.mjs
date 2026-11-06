import { smsError, fieldsRejected } from './api-error.mjs';
import { bindBody } from './bind.mjs';
import { authenticate, authorize } from './auth.mjs';
import { createSchemaValidator } from './schema.mjs';
import { measure } from './length.mjs';
import { createFixedWindowLimiter } from '../ratelimit.mjs';
import { deliveryOf, isReportable as reportable } from '../jobs.mjs';
import { istanbulTimestamp } from '../http.mjs';
import { smsSpec } from '../generated/specs.mjs';

const validator = createSchemaValidator(smsSpec);

const PAGE_SIZE = 100;
const MINUTE_MS = 60_000;
const TZ_MS = 3 * 3_600_000; // Europe/Istanbul, sabit +03:00
const REPORT_JOB_WINDOW_MS = MINUTE_MS;
const STATS_JOB_WINDOW_MS = 10 * MINUTE_MS;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const CANCEL_GONE = 'job not found for this account, or no longer waiting to be sent';
const CANCELLABLE_KINDS = new Set(['SEND', 'TEMPLATE']);

const invalid = (message) => smsError(400, 'INVALID_REQUEST', message);
const limited = (message, retryAfterSec) => smsError(429, 'RATE_LIMITED', message, {}, { 'Retry-After': String(retryAfterSec) });

export function operatorOf(recipient) {
  const r = String(recipient);
  if (r.startsWith('-')) return 'INTERNATIONAL';
  const p = r.slice(2, 5);
  if (/^53\d$/.test(p) || p === '561') return 'TURKCELL';
  if (/^54\d$/.test(p)) return 'VODAFONE';
  if (['501', '505', '506', '507'].includes(p) || /^55[1-9]$/.test(p)) return 'TURK_TELEKOM';
  return 'UNKNOWN';
}

// Parça sayısı gönderimdekiyle aynı kuralla: görevin kayıtlı kodlaması ve gönderici türü.
export const partsOf = (job, record) => measure(String(record.text ?? ''), job.encoding, job.alphanumericSender).parts;
const monthOf = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 7);

/** Anahtar başına son kullanma anı tutar: süre dolmadan ikinci okuma reddedilir. */
function createMarkers(clock) {
  const map = new Map();
  return {
    remainingMs(key) {
      const exp = map.get(key);
      if (exp === undefined) return 0;
      const left = exp - clock.now();
      if (left <= 0) { map.delete(key); return 0; }
      return left;
    },
    mark(key, windowMs) { map.set(key, clock.now() + windowMs); },
    reset() { map.clear(); },
  };
}

/** Rapor penceresini çözer. Hata olursa MockResponse döner. */
function resolveWindow(query, nowMs) {
  const rawStart = query.get('startAt');
  const rawStop = query.get('stopAt');
  for (const [name, v] of [['startAt', rawStart], ['stopAt', rawStop]]) {
    if (v !== null && (!ISO.test(v) || Number.isNaN(Date.parse(v)))) return invalid(`${name} is not an ISO-8601 date-time`);
  }
  if ((rawStart === null) !== (rawStop === null)) return invalid('startAt and stopAt must be sent together, or neither');
  let start; let stop;
  if (rawStart === null) {
    const d = new Date(nowMs + TZ_MS);
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_MS;
    stop = nowMs;
  } else {
    start = Date.parse(rawStart);
    stop = Date.parse(rawStop);
    if (stop < start) return invalid('stopAt is before startAt');
    const limit = new Date(start + TZ_MS);
    limit.setUTCMonth(limit.getUTCMonth() + 1);
    if (stop + TZ_MS > limit.getTime()) return invalid('the window is wider than one month');
  }
  // dakika hassasiyeti: startAt'ın dakikasının başından stopAt'ın dakikasının sonuna
  return { from: Math.floor(start / MINUTE_MS) * MINUTE_MS, to: (Math.floor(stop / MINUTE_MS) + 1) * MINUTE_MS };
}

export function registerJobsRoutes(ctx) {
  const scale = ctx.opts.rateScale;
  const limiter = (limit) => createFixedWindowLimiter({ limit, windowMs: MINUTE_MS, countRejected: false, clock: ctx.clock, rateScale: scale, registry: ctx.resettables });
  const reportLimiter = limiter(60);
  const statsLimiter = limiter(60);
  const cancelLimiter = limiter(25_000);
  const reportMarks = createMarkers(ctx.clock);
  ctx.resettables.push(reportMarks);
  const statsMarks = createMarkers(ctx.clock);
  ctx.resettables.push(statsMarks);

  ctx.routes.add('GET', '/sms/v3/report', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;
    const denied = authorize(account, login, 'REPORT');
    if (denied) return denied;

    const jobIds = [...new Set(req.query.getAll('jobIds').flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean))];

    // Sayaçlar sayfa ve pencere denetiminden önce çalışır: hatalı istek de hesap sayacına yazılır.
    const hit = reportLimiter.hit(account.id);
    if (!hit.allowed) return limited('report rate limit exceeded', hit.retryAfterSec);
    const wait = Math.max(0, ...jobIds.map(id => reportMarks.remainingMs(`${account.id}:${id}`)));
    if (wait > 0) return limited('a jobId in this request was queried too recently', Math.ceil(wait / 1000));
    for (const id of jobIds) reportMarks.mark(`${account.id}:${id}`, REPORT_JOB_WINDOW_MS);

    const rawPage = req.query.get('page');
    let page = 0;
    if (rawPage !== null) {
      if (!/^-?\d+$/.test(rawPage.trim())) return invalid('page must be an integer');
      page = Number(rawPage.trim());
      if (page < 0) return invalid('page must not be negative');
    }
    const window = resolveWindow(req.query, ctx.clock.now());
    if ('status' in window) return window;

    const now = ctx.clock.now();
    const want = jobIds.length > 0 ? new Set(jobIds) : null;
    const rows = [];
    for (const job of ctx.jobs.all(account.id)) {
      if (!reportable(job) || (want && !want.has(job.jobId))) continue;
      if (job.startMs < window.from || job.startMs >= window.to) continue; // gönderim zamanına göre
      for (const record of job.records) rows.push({ job, record });
    }
    const reports = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ job, record }) => {
      const d = deliveryOf(job, record, now);
      const recipient = String(record.recipient);
      return {
        jobId: job.jobId,
        number: recipient.startsWith('-') ? recipient.slice(1) : recipient.slice(2),
        status: d.status,
        operator: operatorOf(recipient),
        messageLength: partsOf(job, record),
        deliveredAt: d.deliveredAt === null ? null : istanbulTimestamp(d.deliveredAt),
        failReason: d.failReason,
        referenceId: job.referenceId ?? null,
      };
    });
    return { status: 200, body: { count: reports.length, page, reports } };
  });

  ctx.routes.add('GET', '/sms/v3/stats', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;
    const denied = authorize(account, login, 'REPORT');
    if (denied) return denied;

    const jobId = (req.query.get('jobId') ?? '').trim();
    if (jobId === '') return invalid("query parameter 'jobId' must not be blank");
    const rawMonth = req.query.get('month');
    if (rawMonth !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth)) return invalid("query parameter 'month' must be yyyy-MM");
    const now = ctx.clock.now();
    const month = rawMonth ?? monthOf(now);

    const hit = statsLimiter.hit(account.id);
    if (!hit.allowed) return limited('stats rate limit exceeded', hit.retryAfterSec);
    const key = `${account.id}:${jobId}`;
    const left = statsMarks.remainingMs(key);
    if (left > 0) return limited('this jobId was queried too recently', Math.ceil(left / 1000));
    statsMarks.mark(key, STATS_JOB_WINDOW_MS); // okuma 404 ile bitse de sayılır

    const job = ctx.jobs.get(account.id, jobId);
    if (!job || !reportable(job) || job.records.length === 0 || monthOf(job.startMs) !== month) {
      return smsError(404, 'NOT_FOUND', 'job not found');
    }
    const groups = new Map();
    for (const record of job.records) {
      const d = deliveryOf(job, record, now);
      // istatistikte yalnızca kısa neden listesi görülür; diğerleri UNKNOWN döner
      const failReason = d.failReason === null ? null : 'UNKNOWN';
      const domestic = !String(record.recipient).startsWith('-');
      const k = `${d.status}|${failReason}|${domestic}`;
      let g = groups.get(k);
      if (!g) { g = { status: d.status, failReason, domestic, messageCount: 0, totalParts: 0 }; groups.set(k, g); }
      g.messageCount++;
      if (d.status !== 'NOT_DELIVERED') g.totalParts += partsOf(job, record);
    }
    const stats = [...groups.values()].map(g => ({
      status: g.status,
      failReason: g.failReason,
      messageCount: g.messageCount,
      totalParts: g.totalParts,
      domestic: g.domestic,
      charging: g.status === 'DELIVERED' ? 'charged' : 'uncharged',
      chargeDescription: g.status === 'DELIVERED' ? `${(g.totalParts * 0.315).toFixed(2)} TL from: credit balance` : null,
    }));
    return { status: 200, body: { jobId: job.jobId, month, count: stats.length, stats } };
  });

  ctx.routes.add('POST', '/sms/v3/cancel', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;
    const unbound = bindBody('CancelRequest', req.json ?? {});
    if (unbound) return unbound;
    const body = req.json ?? {};
    let violations = validator.validate('CancelRequest', body);
    // yalnızca boşluktan oluşan jobId de reddedilir; geçerli jobId kırpılmadan kullanılır
    if (typeof body.jobId === 'string' && body.jobId.trim() === '') {
      violations = [{ field: 'jobId', message: 'must not be blank' }];
    }
    if (violations.length > 0) return fieldsRejected(violations);
    const denied = authorize(account, login, 'USER');
    if (denied) return denied;
    const hit = cancelLimiter.hit(account.id);
    if (!hit.allowed) return limited('cancel rate limit exceeded', hit.retryAfterSec);

    const now = ctx.clock.now();
    const job = ctx.jobs.get(account.id, body.jobId);
    // yalnızca /send ya da /send/template yanıtında SCHEDULED almış ve başlangıcı gelmemiş görev geri
    // çekilebilir; /directory/send görevleri (her zaman QUEUED) ve OTP iptal edilemez
    if (!job || !CANCELLABLE_KINDS.has(job.kind) || job.status !== 'SCHEDULED' || job.startMs <= now) {
      return smsError(404, 'NOT_FOUND', CANCEL_GONE);
    }
    job.status = 'CANCELLED';
    job.cancelledMs = now;
    return { status: 200, body: { jobId: body.jobId, cancelledAt: istanbulTimestamp(now) } };
  });
}
