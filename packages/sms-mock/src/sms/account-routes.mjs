import { smsError } from './api-error.mjs';
import { checkBody } from './send.mjs';
import { bindBody } from './bind.mjs';
import { authenticate, authorize } from './auth.mjs';
import { createSchemaValidator } from './schema.mjs';
import { createFixedWindowLimiter } from '../ratelimit.mjs';
import { istanbulTimestamp } from '../http.mjs';
import { smsSpec } from '../generated/specs.mjs';

const validator = createSchemaValidator(smsSpec);

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const TZ_MS = 3 * HOUR_MS; // Europe/Istanbul, sabit +03:00
const BLACKLIST_PAGE_SIZE = 200;
const BLACKLIST_QUERY_WINDOW_MS = 10 * MINUTE_MS;
const INBOX_CAP = 500;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const OPERATOR = 'NETGSM MOBIL';

const invalid = (message) => smsError(400, 'INVALID_REQUEST', message);
const limited = (message, retryAfterSec) => smsError(429, 'RATE_LIMITED', message, {}, { 'Retry-After': String(retryAfterSec) });

/**
 * Hesap başına gelen kutusu. `add` mesajı saklar ve `onAdd` ile kayıtlı dinleyicilere bildirir
 * (webhook iletimi gibi yan etkiler buradan bağlanır).
 */
export function createInboxStore({ clock }) {
  const byAccount = new Map();
  const listeners = [];
  let seq = 0;
  return {
    add(accountId, { from, text, receivedAt }) {
      const message = {
        id: String(++seq),
        accountId,
        from: String(from),
        text: String(text),
        operator: OPERATOR,
        receivedAt: receivedAt ?? clock.now(),
      };
      if (!byAccount.has(accountId)) byAccount.set(accountId, []);
      byAccount.get(accountId).push(message);
      for (const fn of listeners) {
        try { fn(accountId, message); } catch { /* dinleyici hatası eklemeyi bozmaz */ }
      }
      return message;
    },
    all(accountId) { return [...(byAccount.get(accountId) ?? [])]; },
    /** Mesaj eklendikçe `fn(accountId, message)` çağrılır. */
    onAdd(fn) { listeners.push(fn); },
  };
}

/** Yurt içi numaralar 90 öneki olmadan yazılır. */
function senderOf(from) {
  const n = from.replace(/^\+/, '');
  return /^90\d{10}$/.test(n) ? n.slice(2) : n;
}

function toInboxMessage(m) {
  return {
    id: m.id,
    jobId: null,
    sender: senderOf(m.from),
    text: m.text,
    operator: m.operator,
    receivedAt: istanbulTimestamp(m.receivedAt),
  };
}

function resolveWindow(query, nowMs) {
  const rawStart = query.get('startAt');
  const rawStop = query.get('stopAt');
  for (const [name, v] of [['startAt', rawStart], ['stopAt', rawStop]]) {
    if (v !== null && (!ISO.test(v) || Number.isNaN(Date.parse(v)))) return invalid(`${name} is not an ISO-8601 date-time`);
  }
  if ((rawStart === null) !== (rawStop === null)) return invalid('startAt and stopAt must be sent together, or neither');
  if (rawStart === null) {
    const d = new Date(nowMs + TZ_MS);
    return { from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_MS, to: nowMs };
  }
  const start = Date.parse(rawStart);
  const stop = Date.parse(rawStop);
  if (stop < start) return invalid('stopAt must not be before startAt');
  const limit = new Date(start + TZ_MS);
  limit.setUTCMonth(limit.getUTCMonth() + 2);
  if (stop + TZ_MS > limit.getTime()) return invalid('the window between startAt and stopAt may not exceed 2 months');
  return { from: start, to: stop };
}

export function registerAccountRoutes(ctx) {
  const scale = ctx.opts.rateScale;
  const limiter = (limit, windowMs) => createFixedWindowLimiter({ limit, windowMs, countRejected: true, clock: ctx.clock, rateScale: scale, registry: ctx.resettables });
  // Mock varsayımları (sözleşme değildir; spec sayı vermez): /senders okuma, varsayılan başlık değişikliği, /inbox.
  const sendersReadLimiter = limiter(60, MINUTE_MS); // GET /senders ve GET /senders/default tek sayaç
  const defaultChangeLimiter = limiter(4, HOUR_MS);
  const inboxLimiter = limiter(60, MINUTE_MS);
  const blacklistLimiter = limiter(60, MINUTE_MS);
  const blacklistMarks = new Map(); // `${account}:${page}:${number}` -> bitiş anı
  ctx.resettables.push({ reset: () => blacklistMarks.clear() });

  const entry = (s) => ({ name: s.name, type: s.type, brandCode: s.brandCode, usable: s.usable, reason: s.reason ?? null });

  ctx.routes.add('GET', '/sms/v3/senders', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;
    const denied = authorize(account, login, 'USER');
    if (denied) return denied;
    const hit = sendersReadLimiter.hit(account.id);
    if (!hit.allowed) return limited('sender read rate limit exceeded', hit.retryAfterSec);
    const senders = account.senders.map(entry);
    return { status: 200, body: { count: senders.length, senders } };
  });

  ctx.routes.add('GET', '/sms/v3/senders/default', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;
    const denied = authorize(account, login, 'USER');
    if (denied) return denied;
    const hit = sendersReadLimiter.hit(account.id);
    if (!hit.allowed) return limited('sender read rate limit exceeded', hit.retryAfterSec);
    const current = account.senders.find(s => s.name === account.defaultSender);
    return { status: 200, body: { sender: current ? entry(current) : null } };
  });

  ctx.routes.add('PUT', '/sms/v3/senders/default', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;
    const bad = bindBody('DefaultSenderChangeRequest', req.json ?? {})
      ?? checkBody(validator, 'DefaultSenderChangeRequest', req.json ?? {}, { blankFields: ['name'] });
    if (bad) return bad;
    const denied = authorize(account, login, 'USER');
    if (denied) return denied;
    // her deneme sayılır; sayaç başlık adına bakılmadan önce işler
    const hit = defaultChangeLimiter.hit(account.id);
    if (!hit.allowed) return limited('default sender change rate limit exceeded', hit.retryAfterSec);

    const name = req.json.name;
    const reject = (message) => smsError(422, 'REJECTED_HEADER', message);
    if (account.senders.length === 0) return reject('NO_HEADERS_REGISTERED');
    const match = account.senders.find(s => s.name === name);
    if (!match) {
      const lower = name.toLowerCase();
      return reject(account.senders.some(s => s.name.toLowerCase() === lower) ? 'CASE_MISMATCH' : 'NOT_REGISTERED');
    }
    account.defaultSender = match.name;
    return { status: 200, body: { sender: entry(match) } };
  });

  ctx.routes.add('GET', '/sms/v3/inbox', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;
    const denied = authorize(account, login, 'RECEIVE');
    if (denied) return denied;
    const hit = inboxLimiter.hit(account.id);
    if (!hit.allowed) return limited('inbox rate limit exceeded', hit.retryAfterSec);
    const window = resolveWindow(req.query, ctx.clock.now());
    if ('status' in window) return window;

    // saniye hassasiyeti: iki sınır da dahil
    const lo = Math.floor(window.from / 1000);
    const hi = Math.floor(window.to / 1000);
    const inRange = ctx.inbox.all(account.id).filter(m => {
      const s = Math.floor(m.receivedAt / 1000);
      return s >= lo && s <= hi;
    });
    const truncated = inRange.length >= INBOX_CAP;
    const messages = inRange.slice(0, INBOX_CAP).map(toInboxMessage);
    return { status: 200, body: { count: messages.length, messages, truncated } };
  });

  ctx.routes.add('GET', '/sms/v3/blacklist', (req) => {
    // işlem yetkisi aranmaz: liste hesabın kendisinindir
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { account } = auth;

    const rawNumber = (req.query.get('number') ?? '').trim();
    const lookup = rawNumber !== '';
    const rawPage = req.query.get('page');
    let page = 0;
    if (rawPage !== null) {
      if (!/^-?\d+$/.test(rawPage.trim())) return invalid('page must be an integer');
      page = Number(rawPage.trim());
      if (page < 0) return invalid('page must not be negative');
    }
    if (lookup && !/^[0-9]{1,15}$/.test(rawNumber)) return invalid('number must be up to 15 digits');

    const hit = blacklistLimiter.hit(account.id);
    if (!hit.allowed) return limited('blacklist rate limit exceeded', hit.retryAfterSec);
    const key = `${account.id}:${page}:${lookup ? rawNumber : ''}`;
    const now = ctx.clock.now();
    const expires = blacklistMarks.get(key);
    if (expires !== undefined && expires > now) {
      return limited('the same blacklist query was made too recently', Math.max(1, Math.ceil((expires - now) / 1000)));
    }

    let body;
    if (lookup) {
      const found = account.blacklist.includes(rawNumber);
      body = { count: found ? 1 : 0, page: null, number: rawNumber, numbers: found ? [rawNumber] : [] };
    } else {
      const newestFirst = [...account.blacklist].reverse();
      const numbers = newestFirst.slice(page * BLACKLIST_PAGE_SIZE, (page + 1) * BLACKLIST_PAGE_SIZE);
      body = { count: numbers.length, page, number: null, numbers };
    }
    blacklistMarks.set(key, now + BLACKLIST_QUERY_WINDOW_MS); // yalnızca cevaplanan sorgu işaretlenir
    return { status: 200, body };
  });

  // Kontrol ucu: sahte gelen SMS ekler. Kimlik doğrulama yok, düz JSON zarfı.
  ctx.routes.add('POST', '/__mock/inbound', (req) => {
    const b = req.json;
    const bad = (m) => ({ status: 400, body: { error: m } });
    if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('body must be a JSON object');
    for (const k of ['username', 'from', 'text']) {
      if (typeof b[k] !== 'string' || b[k] === '') return bad(`${k} is required`);
    }
    const account = ctx.accounts.get(b.username);
    if (!account) return { status: 404, body: { error: `unknown username: ${b.username}` } };
    const stored = ctx.inbox.add(account.id, { from: b.from, text: b.text });
    return { status: 201, body: stored };
  });
}
