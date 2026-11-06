import { smsError, fieldsRejected } from './api-error.mjs';
import { bindBody } from './bind.mjs';
import { afterJobCreated } from '../scenarios.mjs';
import { authenticate, authorize } from './auth.mjs';
import { createSchemaValidator } from './schema.mjs';
import { fitsSend } from './length.mjs';
import { createFixedWindowLimiter } from '../ratelimit.mjs';
import { smsSpec } from '../generated/specs.mjs';

const validator = createSchemaValidator(smsSpec);

export const MAX_REPORTED = 100;
const RECIPIENT = /^(90\d{10}|-\d{9,17})$/;
const MIN_SMALL_MS = 5 * 60_000;
const MIN_LARGE_MS = 10 * 60_000;
const SMALL_BATCH = 1000;
const MAX_WINDOW_MS = 21 * 3_600_000;
const MINUTE_MS = 60_000;
const MAX_MESSAGES = 1_000_000;
const MAX_FUTURE_MONTHS = 18;

/**
 * Kayıtları tek geçişte doğrular. `rejected` en fazla 100 kayıt taşır; kesin sayı `rejectedTotal`'dır.
 * @returns {{ accepted: Array<{index:number,recipient:string,text:string}>, rejected: object[], rejectedTotal: number }}
 */
export function validateRecords(records, { encoding = 'DEFAULT', alphanumericSender = false, account }) {
  const n = records.length;
  const duplicate = new Uint8Array(n);
  if (!account.duplicatesAllowed) {
    const seen = new Set();
    for (let i = n - 1; i >= 0; i--) {
      const r = records[i];
      const rcp = r !== null && typeof r === 'object' ? r.recipient : undefined;
      if (typeof rcp !== 'string') continue;
      if (seen.has(rcp)) duplicate[i] = 1; else seen.add(rcp);
    }
  }
  const accepted = [];
  const rejected = [];
  let rejectedTotal = 0;
  for (let i = 0; i < n; i++) {
    const r = records[i];
    const isObj = r !== null && typeof r === 'object' && !Array.isArray(r);
    const recipient = isObj && typeof r.recipient === 'string' ? r.recipient : null;
    const text = isObj ? r.text : undefined;
    let reason = null;
    if (duplicate[i]) reason = 'DUPLICATE_RECIPIENT';
    else if (!isObj) reason = 'MALFORMED_ENTRY';
    else if (typeof text === 'string' && !fitsSend(text, encoding, alphanumericSender)) reason = 'MESSAGE_TOO_LONG';
    else if (recipient === null || !RECIPIENT.test(recipient)) reason = 'INVALID_RECIPIENT';
    else if (typeof text !== 'string' || text.length === 0) reason = 'INVALID_MESSAGE';
    else if (recipient.charCodeAt(0) === 45 && !account.international) reason = 'NO_INTERNATIONAL_PERMISSION';
    if (reason === null) { accepted.push({ index: i, recipient, text }); continue; }
    rejectedTotal++;
    if (rejected.length < MAX_REPORTED) rejected.push({ index: i, recipient, reason });
  }
  return { accepted, rejected, rejectedTotal };
}

/**
 * Gönderim penceresini çözer (düzeltmeler hata döndürmez). Yalnızca çok ileri bir başlangıç reddedilir.
 * Tüm hesaplar epoch milisaniyesi üzerindendir; yerel saat okunmaz.
 * @returns {{ status: 'QUEUED'|'SCHEDULED', startMs: number, stopMs: number } | import('../http.mjs').MockResponse}
 */
export function resolveSendWindow({ startAt, stopAt, count, nowMs }) {
  const reqStart = startAt == null ? NaN : Date.parse(startAt);
  const reqStop = stopAt == null ? NaN : Date.parse(stopAt);
  let startMs = nowMs;
  if (!Number.isNaN(reqStart)) {
    const limit = new Date(nowMs);
    limit.setUTCMonth(limit.getUTCMonth() + MAX_FUTURE_MONTHS);
    if (reqStart > limit.getTime()) {
      return smsError(400, 'INVALID_SEND_WINDOW', `startAt is further ahead than ${MAX_FUTURE_MONTHS} months`);
    }
    if (reqStart > nowMs) startMs = reqStart;
  }
  // verilmeyen ya da geçmişteki bitiş: başlangıç + 21 saat
  let stopMs = Number.isNaN(reqStop) || reqStop < nowMs ? startMs + MAX_WINDOW_MS : reqStop;
  const min = count < SMALL_BATCH ? MIN_SMALL_MS : MIN_LARGE_MS;
  if (stopMs - startMs < min) stopMs = startMs + min;
  else if (stopMs - startMs > MAX_WINDOW_MS) stopMs = startMs + MAX_WINDOW_MS;
  // dakikaya göre sayılır: tam dakika cinsinden bir dakikadan fazla ileri ise SCHEDULED
  const status = Math.floor((startMs - nowMs) / MINUTE_MS) > 1 ? 'SCHEDULED' : 'QUEUED';
  return { status, startMs, stopMs };
}

/** Gönderici başlığı kontrolü: kayıtlı mı, yazımı birebir mi, kullanılabilir mi. */
export function checkSender(account, sender) {
  const reject = (message) => smsError(422, 'REJECTED_HEADER', message);
  const list = account.senders ?? [];
  if (list.length === 0) return reject('NO_HEADERS_REGISTERED');
  const match = list.find(s => s.name === sender);
  if (!match) {
    const lower = String(sender).toLowerCase();
    return reject(list.some(s => s.name.toLowerCase() === lower) ? 'CASE_MISMATCH' : 'NOT_REGISTERED');
  }
  if (!match.usable) return reject(match.reason || 'ROUTING_CODE_MISSING');
  return null;
}

/** Spec'e göre geçerli İYS filtresi: bilinmeyen değer NONE sayılır, büyük/küçük harf fark etmez. */
export function normalizeIysFilter(value) {
  const v = typeof value === 'string' ? value.toUpperCase() : 'NONE';
  return ['BRAND', 'RETAILER', 'BRAND_AND_RETAILER'].includes(v) ? v : 'NONE';
}

/**
 * OTP göndericisi: büyük/küçük harf fark etmez; abone numarası başında `0` ya da `90` ile de yazılabilir.
 * `CASE_MISMATCH` üretmez. Başarıda `{ entry }`, aksi halde `{ error }` (422 REJECTED_HEADER) döner.
 */
export function findOtpSender(account, sender) {
  const reject = (message) => ({ error: smsError(422, 'REJECTED_HEADER', message) });
  const list = account.senders ?? [];
  if (list.length === 0) return reject('NO_HEADERS_REGISTERED');
  const lower = sender.toLowerCase();
  const national = /^\d+$/.test(sender) ? sender.replace(/^(?:90|0)(?=\d{10}$)/, '') : null;
  const match = list.find(s => s.name.toLowerCase() === lower)
    ?? (national === null ? undefined : list.find(s => s.type === 'SUBSCRIBER_NUMBER' && s.name === national));
  if (!match) return reject('NOT_REGISTERED');
  if (!match.usable) return reject(match.reason || 'ROUTING_CODE_MISSING');
  return { entry: match };
}

/**
 * İYS filtresi kontrolü (`/send`, `/send/template`). Yalnızca `BRAND` ve `RETAILER` denetlenir;
 * `BRAND_AND_RETAILER` için bu iki kontrol yapılmaz. Marka kodu yalnızca `sender` verilirse denetlenir.
 */
export function checkIys(account, iysFilter, sender) {
  const filter = normalizeIysFilter(iysFilter);
  if (filter !== 'BRAND' && filter !== 'RETAILER') return null;
  if (!account.iysMode) return smsError(422, 'REJECTED_IYS', 'account is not in iys mode, filtering cannot be applied');
  if (sender !== undefined) {
    const header = (account.senders ?? []).find(s => s.name === sender);
    if (!header || !(header.brandCode > 0)) return smsError(422, 'REJECTED_IYS', 'sender header has no iys brand code');
  }
  return null;
}

/**
 * Alan doğrulaması (400 `N field(s) rejected`, `violations` ile). Sorun yoksa null. Türlerin bağlanması
 * (`bindBody`, bkz. bind.mjs) bundan önce çalışır: bir değer türüne uymuyorsa istek orada tek ihlalle
 * reddedilir ve bu doğrulamaya hiç gelinmez. Burada yalnızca zorunluluk, boşluk ve uzunluk gibi kurallar kalır.
 * `dateFields`: bağlamada denetlenen tarih alanları; şema doğrulamasına girmez.
 * `blankFields`: eksik, boş ya da yalnızca boşluktan oluşan değer `must not be blank` ile reddedilir.
 * `sizeFields`: alan → `[min, max]`; uzunluk ihlali `size must be between min and max` olur. Boş string
 *   hem `must not be blank` hem uzunluk ihlali alır (iki ihlal); yalnızca boşluktan oluşan değer yalnızca ilkini.
 * `notEmptyFields`: eksik ya da boş dizi `must not be empty` ile reddedilir.
 * @param {{ skipProperties?: string[], dateFields?: string[], blankFields?: string[],
 *   sizeFields?: Record<string, [number, number]>, notEmptyFields?: string[],
 *   extraViolations?: Array<{field:string,message:string}>,
 *   rename?: (v: Array<{field:string,message:string}>) => Array<{field:string,message:string}> }} [opts]
 */
export function checkBody(validator, schema, body, opts = {}) {
  const {
    skipProperties = [], dateFields = [], blankFields = [], sizeFields = {}, notEmptyFields = [],
    extraViolations = [], rename = (v) => v,
  } = opts;
  const probe = { ...body };
  for (const f of dateFields) delete probe[f];
  const raw = validator.validate(schema, probe, { skipProperties, keywords: true });
  const sizeMessage = (f) => `size must be between ${sizeFields[f][0]} and ${sizeFields[f][1]}`;
  let violations = raw.map(({ field, message, keyword }) => {
    if (notEmptyFields.includes(field) && (keyword === 'required' || keyword === 'minItems')) return { field, message: 'must not be empty' };
    if (blankFields.includes(field) && keyword === 'required') return { field, message: 'must not be blank' };
    if (sizeFields[field] && (keyword === 'minLength' || keyword === 'maxLength')) return { field, message: sizeMessage(field) };
    return { field, message };
  });
  const blank = [];
  for (const f of blankFields) {
    const v = body[f];
    if (typeof v === 'string' && v.trim() === '') {
      violations = violations.filter(x => x.field !== f);
      blank.push({ field: f, message: 'must not be blank' });
      if (sizeFields[f] && v.length < sizeFields[f][0]) blank.push({ field: f, message: sizeMessage(f) });
    }
  }
  violations = [...blank, ...violations, ...extraViolations];
  return violations.length > 0 ? fieldsRejected(rename(violations)) : null;
}

/** `sender` kuralları (`/send`, `/send/template`): 1–35 karakter, boş olamaz. */
export const SENDER_RULES = { blankFields: ['sender'], sizeFields: { sender: [1, 35] } };

/** Üst düzey `null` alanları siler; `messages` dizisine dokunmaz (büyük gövdelerde kopya maliyeti yok). */
function stripTopLevelNulls(body) {
  const out = {};
  for (const k of Object.keys(body)) if (body[k] !== null) out[k] = body[k];
  return out;
}

export function registerSendRoutes(ctx) {
  const limiter = createFixedWindowLimiter({
    limit: 50_000, windowMs: 60_000, countRejected: false, clock: ctx.clock, rateScale: ctx.opts.rateScale, registry: ctx.resettables,
  });

  ctx.routes.add('POST', '/sms/v3/send', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;

    const unbound = bindBody('SmsSendRequest', req.json ?? {}, { loose: ['iysFilter'] });
    if (unbound) return unbound;

    const body = stripTopLevelNulls(req.json ?? {});
    const iysFilter = normalizeIysFilter(body.iysFilter);
    delete body.iysFilter; // enum denetimi yerine spec'teki gevşek eşleme uygulanır
    // kayıtların türleri bağlamada denetlendi; içerikleri burada denetlenmez (büyük gövdelerde maliyetli),
    // yalnızca dizinin boş olup olmadığı.
    // 1.000.000 sınırı aşağıda kendi mesajıyla denetlenir.
    const probe = { ...body, messages: Array.isArray(body.messages) && body.messages.length > 0 ? [null] : body.messages };
    const bad = checkBody(validator, 'SmsSendRequest', probe, {
      skipProperties: ['messages.items'], dateFields: ['startAt', 'stopAt'], ...SENDER_RULES, notEmptyFields: ['messages'],
    });
    if (bad) return bad;

    const denied = authorize(account, login, 'SEND');
    if (denied) return denied;

    const hit = limiter.hit(account.id);
    if (!hit.allowed) {
      return smsError(429, 'RATE_LIMITED', 'send rate limit exceeded', {}, { 'Retry-After': String(hit.retryAfterSec) });
    }

    const badHeader = checkSender(account, body.sender);
    if (badHeader) return badHeader;
    const badIys = checkIys(account, iysFilter, body.sender);
    if (badIys) return badIys;

    const count = body.messages.length;
    const window = resolveSendWindow({ startAt: body.startAt, stopAt: body.stopAt, count, nowMs: ctx.clock.now() });
    if (typeof window.status === 'number') return window;
    if (count > MAX_MESSAGES) return smsError(400, 'INVALID_REQUEST', `${count} messages exceeds the limit of ${MAX_MESSAGES}`);

    const senderEntry = account.senders.find(s => s.name === body.sender);
    const { accepted, rejected, rejectedTotal } = validateRecords(body.messages, {
      encoding: body.encoding ?? 'DEFAULT',
      alphanumericSender: senderEntry.type === 'ALPHANUMERIC',
      account,
    });
    const truncated = rejectedTotal > rejected.length;
    if (accepted.length === 0) {
      return smsError(422, 'NO_DELIVERABLE_MESSAGES', `all ${count} messages rejected`, {
        rejectedItems: rejected, rejectedItemsTruncated: truncated,
      });
    }

    const job = ctx.jobs.create({
      accountId: account.id, kind: 'SEND', status: window.status,
      startMs: window.startMs, stopMs: window.stopMs, sender: body.sender,
      records: accepted, referenceId: body.referenceId ?? null,
      encoding: body.encoding ?? 'DEFAULT', alphanumericSender: senderEntry.type === 'ALPHANUMERIC',
    });
    return afterJobCreated(req, ctx, {
      status: 202,
      body: {
        jobId: job.jobId, status: job.status, accepted: accepted.length, rejected: rejectedTotal,
        rejectedItems: rejected, rejectedItemsTruncated: truncated, referenceId: job.referenceId,
      },
    });
  });
}
