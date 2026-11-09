import { smsError, fieldsRejected } from './api-error.mjs';
import { bindBody } from './bind.mjs';
import { afterJobCreated, DIRECTORY_SEND, SEND_TEMPLATE, SEND_OTP } from '../scenarios.mjs';
import { authenticate, authorize } from './auth.mjs';
import { createSchemaValidator, stripNulls } from './schema.mjs';
import { measure } from './length.mjs';
import { createFixedWindowLimiter } from '../ratelimit.mjs';
import { smsSpec } from '../generated/specs.mjs';
import {
  validateRecords, resolveSendWindow, checkSender, checkIys, normalizeIysFilter, checkBody, findOtpSender, MAX_REPORTED, SENDER_RULES,
} from './send.mjs';

const validator = createSchemaValidator(smsSpec);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const OTP_MAX_ALPHANUMERIC = 155;
const OTP_MAX_SUBSCRIBER = 160;
const LIST_MAX_SIZE = 100;
const LIST_MAX_FILTER = 100;
const ENCODINGS = ['DEFAULT', 'TURKISH', 'UNICODE'];

const invalid = (message, extras) => smsError(400, 'INVALID_REQUEST', message, extras);

/** `a.0.b` → `a[0].b`, spec'teki alan yazımı. */
function bracketed(violations) {
  return violations.map(v => ({ ...v, field: v.field.replace(/\.(\d+)(?=\.|$)/g, '[$1]') }));
}

function rateLimited(message, hit) {
  return smsError(429, 'RATE_LIMITED', message, {}, { 'Retry-After': String(hit.retryAfterSec) });
}

// --- şablon parametreleri --------------------------------------------------------------------------

function validDate(d, m, y) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isDate(v) {
  const m = /^(\d{2})([./])(\d{2})\2(\d{4})$/.exec(v);
  return m !== null && validDate(Number(m[1]), Number(m[3]), Number(m[4]));
}

function isDateTime(v) {
  const m = /^(\d{2})([./])(\d{2})\2(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m === null || !validDate(Number(m[1]), Number(m[3]), Number(m[4]))) return false;
  return Number(m[5]) <= 23 && Number(m[6]) <= 59 && (m[7] === undefined || Number(m[7]) <= 59);
}

const INT64_MAX = 9223372036854775807n;

const PARAM_CHECKS = {
  BIGINT: (v) => {
    if (!/^-?\d+$/.test(v)) return false;
    const n = BigInt(v);
    return n <= INT64_MAX && n >= -INT64_MAX - 1n;
  },
  FLOAT: (v) => /^-?\d+(\.\d{1,4})?$/.test(v),
  TEXT: (v, p) => p.maxLength == null || v.length <= p.maxLength,
  DATE: isDate,
  DATETIME: isDateTime,
};

/** Bir kaydı doldurur. Başarıda metin, hatada 400 yanıtı döner. */
function fillTemplate(template, params = {}) {
  const defined = template.parameters.map(p => p.name);
  const given = Object.keys(params);
  const missing = defined.filter(n => typeof params[n] !== 'string' || params[n] === '');
  if (missing.length > 0) {
    return invalid(`Invalid params for templateId ${template.templateId}. Missing params: [${missing.join(', ')}]`);
  }
  const unexpected = given.filter(n => !defined.includes(n));
  if (unexpected.length > 0) {
    return invalid(`Invalid params for templateId ${template.templateId}. Unexpected params: [${unexpected.join(', ')}]`);
  }
  for (const p of template.parameters) {
    if (!PARAM_CHECKS[p.type](params[p.name], p)) return invalid(`param '${p.name}' is not a valid ${p.type}`);
  }
  return template.content.replace(/\$\{([^}]+)\}/g, (all, name) => params[name] ?? all);
}

// --- rehber --------------------------------------------------------------------------------------------

// addressType → metnin başına eklenen parçalar (spec tablosu)
const A1 = 'address1';
const A2 = 'address2';
const ADDRESS_PARTS = [
  [], [A1, 'name'], [A1, 'name', 'surname'], [A1, 'surname'],
  [A1, 'name', A2], [A1, 'name', 'surname', A2], [A1, 'surname', A2],
  ['name'], ['surname'], ['name', 'surname'],
  ['address'], ['address', 'name'], ['address', 'name', 'surname'], ['address', 'surname'],
  ['address', A2], ['address', 'name', A2], ['address', 'name', 'surname', A2], ['address', 'surname', A2],
];

function personalize(text, addressType, contact, shared) {
  if (!contact || addressType === 0) return text;
  const source = { ...contact, address1: shared.address1, address2: shared.address2 };
  const parts = ADDRESS_PARTS[addressType].map(k => source[k]).filter(v => typeof v === 'string' && v.length > 0);
  return parts.length === 0 ? text : `${parts.join(' ')} ${text}`;
}

/**
 * Rehber gönderim aralığı. Tarihler dakikaya yuvarlanır (saniyeler atılır). `stopAt` verilirse
 * başlangıçtan (verilmezse şimdiden) 1 ile 21 saat sonra olmalıdır; değilse 400 INVALID_SEND_WINDOW.
 */
export function resolveDirectoryWindow({ startAt, stopAt, nowMs }) {
  const minute = (ms) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  const start = startAt === undefined ? null : minute(Date.parse(startAt));
  const stop = stopAt === undefined ? null : minute(Date.parse(stopAt));
  if (stop !== null) {
    const span = stop - (start ?? minute(nowMs));
    if (span < HOUR_MS || span > 21 * HOUR_MS) return smsError(400, 'INVALID_SEND_WINDOW', 'the send window was rejected');
  }
  const startMs = start !== null && start > nowMs ? start : nowMs;
  return { startMs, stopMs: stop ?? startMs + 21 * HOUR_MS };
}

// --- OTP ------------------------------------------------------------------------------------------------

// Metindeki karakter → gönderilen (spec'teki OtpSendRequest.text tablosu). Satır sonu ayrıca işlenir.
const OTP_TRANSLATION = new Map(Object.entries({
  'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u',
  'Ç': 'C', 'Ğ': 'G', 'İ': 'I', 'Ö': 'O', 'Ş': 'S', 'Ü': 'U',
  '{': '(', '[': '(', '}': ')', ']': ')',
  '“': '"', '”': '"', '`': '"', '‘': "'", '’': "'",
  '~': '?', '€': ';EO;', '\t': ' ', '|': ' ', '^': '',
}));

/**
 * OTP metnini gönderilecek hâline çevirir: baştaki ve sondaki boşluklar kırpılır, karakterler tabloya
 * göre çevrilir, satır sonu iki karakterlik `\n` olur, desteklenmeyen her karakter (yazdırılabilir
 * ASCII dışı) `?` olur. Uzunluk bu metin üzerinden sayılır.
 */
export function translateOtpText(text) {
  let out = '';
  for (const ch of text.trim().replace(/\r\n?/g, '\n')) {
    if (ch === '\n') { out += '\\n'; continue; }
    const mapped = OTP_TRANSLATION.get(ch);
    if (mapped !== undefined) { out += mapped; continue; }
    const c = ch.codePointAt(0);
    out += c >= 0x20 && c <= 0x7d ? ch : '?';
  }
  return out;
}

// Türkiye cep numarası: 5XXXXXXXXX, 05XXXXXXXXX ya da 905XXXXXXXXX; başına + eklenebilir. Boşluk ya da
// yurt dışı numarası kabul edilmez.
const OTP_RECIPIENT = /^\+?(?:90|0)?5\d{9}$/;
const OTP_FIELDS = ['sender', 'text', 'recipient'];

/** OTP gövdesi: türü uymayan değer (bağlama), eksik ya da boş alan, numara biçimi. Sorun yoksa null. */
function checkOtpBody(json) {
  const unbound = bindBody('OtpSendRequest', json);
  if (unbound) return unbound;
  const body = stripNulls(json);
  const violations = OTP_FIELDS
    .filter(f => body[f] === undefined || body[f].trim() === '')
    .map(field => ({ field, message: 'must not be blank' }));
  if (violations.length > 0) return fieldsRejected(violations);
  if (!OTP_RECIPIENT.test(body.recipient)) return invalid('recipient is not a valid number');
  return null;
}

// --- yollar ---------------------------------------------------------------------------------------------

export function registerSendFamilyRoutes(ctx) {
  const limiter = (limit, countRejected) => createFixedWindowLimiter({
    limit, windowMs: MINUTE_MS, countRejected, clock: ctx.clock, rateScale: ctx.opts.rateScale, registry: ctx.resettables,
  });
  const directoryLimiter = limiter(60, false);
  const templateLimiter = limiter(1000, true);
  const listLimiter = limiter(20, true);

  // ---- POST /directory/send
  ctx.routes.add('POST', DIRECTORY_SEND, (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;

    // encoding listesi bağlamada UNICODE'u da tanır; UNICODE aşağıda kendi mesajıyla reddedilir.
    const unbound = bindBody('DirectorySendRequest', req.json ?? {}, { loose: ['iysFilter'], enums: { encoding: ENCODINGS } });
    if (unbound) return unbound;

    const body = stripNulls(req.json ?? {});
    const iysFilter = normalizeIysFilter(body.iysFilter);
    delete body.iysFilter; // spec'teki gevşek eşleme (send gibi)
    const unicode = body.encoding === 'UNICODE';
    if (unicode) delete body.encoding; // kendi mesajıyla reddedilir
    const bad = checkBody(validator, 'DirectorySendRequest', body, {
      dateFields: ['startAt', 'stopAt'], blankFields: ['sender'], rename: bracketed,
    });
    if (bad) return bad;

    const denied = authorize(account, login, 'SEND');
    if (denied) return denied;
    const hit = directoryLimiter.hit(account.id);
    if (!hit.allowed) return rateLimited('directory send rate limit exceeded', hit);

    if (unicode) return invalid('encoding UNICODE is not supported for directory sends');
    const groupIds = body.groupIds ?? [];
    const contacts = body.contacts ?? [];
    if (groupIds.length === 0 && contacts.length === 0) {
      return invalid('a directory send names at least one group or contact; for numbers alone use /sms/v3/send');
    }
    const groups = account.directory?.groups ?? [];

    const badHeader = checkSender(account, body.sender); // /send gibi birebir, büyük/küçük harf dahil
    if (badHeader) return badHeader;

    const senderEntry = account.senders.find(s => s.name === body.sender);
    const alphanumeric = senderEntry.type === 'ALPHANUMERIC';
    const encoding = body.encoding ?? 'DEFAULT';
    const m = measure(body.text, encoding, alphanumeric);
    if (!m.fits) return invalid(`text exceeds ${m.limit - (alphanumeric ? 5 : 0)} characters for this encoding and sender`);

    // Platformun kontrolleri: İYS filtresi ve gönderim aralığı.
    if (iysFilter !== 'NONE' && (!account.iysMode || !(senderEntry.brandCode > 0))) {
      return smsError(422, 'REJECTED_IYS', 'consent filtering cannot be applied to this sender or account');
    }
    const window = resolveDirectoryWindow({ startAt: body.startAt, stopAt: body.stopAt, nowMs: ctx.clock.now() });
    if ('status' in window) return window;

    const addressType = body.addressType ?? 0;
    const shared = { address1: body.address1, address2: body.address2 };
    const entries = [];
    for (const id of groupIds) {
      for (const c of groups.find(g => g.groupId === id)?.contacts ?? []) entries.push({ number: c.number, contact: c });
    }
    for (const c of contacts) entries.push({ number: c.number, contact: c });
    for (const n of body.recipients ?? []) entries.push({ number: n, contact: null });
    const records = entries.map((e, index) => ({
      index, recipient: e.number, text: personalize(body.text, addressType, e.contact, shared),
    }));

    // Yanıt her zaman QUEUED: görev ileri bir başlangıçla da iptal edilemez (POST /cancel 404 döner).
    const job = ctx.jobs.create({
      accountId: account.id, kind: 'DIRECTORY', status: 'QUEUED',
      startMs: window.startMs, stopMs: window.stopMs, sender: body.sender, records, referenceId: null,
      encoding, alphanumericSender: alphanumeric,
    });
    return afterJobCreated(req, ctx, { status: 202, body: { jobId: job.jobId, status: 'QUEUED', review: 'NONE' } });
  });

  // ---- POST /send/template
  ctx.routes.add('POST', SEND_TEMPLATE, (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;

    const unbound = bindBody('TemplateSendRequest', req.json ?? {}, { loose: ['iysFilter'] });
    if (unbound) return unbound;

    const body = stripNulls(req.json ?? {});
    const iysFilter = normalizeIysFilter(body.iysFilter);
    delete body.iysFilter;
    // alıcı biçimi şablon doldurulduktan sonra denetlenir; burada yalnızca boşluk ve uzunluk bakılır
    const itemViolations = [];
    if (Array.isArray(body.templates)) {
      body.templates.forEach((t, i) => {
        const lengthOk = t !== null && typeof t === 'object' && typeof t.recipient === 'string' && t.recipient.length >= 1 && t.recipient.length <= 17;
        const probe = lengthOk ? { ...t, recipient: '905000000000' } : t;
        for (const v of validator.validate('TemplateMessage', probe)) {
          itemViolations.push({ ...v, field: v.field === '' ? `templates.${i}` : `templates.${i}.${v.field}` });
        }
      });
    }
    const bad = checkBody(validator, 'TemplateSendRequest', body, {
      skipProperties: ['templates.items'], dateFields: ['startAt', 'stopAt'], ...SENDER_RULES,
      extraViolations: itemViolations, rename: bracketed,
    });
    if (bad) return bad;

    const denied = authorize(account, login, 'SEND');
    if (denied) return denied;
    const hit = templateLimiter.hit(account.id);
    if (!hit.allowed) return rateLimited('template send rate limit exceeded', hit);

    const byId = new Map(account.templates.map(t => [t.templateId, t]));
    const missingIds = [...new Set(body.templates.map(t => t.templateId).filter(id => !byId.has(id)))];
    if (missingIds.length > 0) return invalid(`templates not found: [${missingIds.join(', ')}]`);

    const records = [];
    for (const t of body.templates) {
      const text = fillTemplate(byId.get(t.templateId), t.params);
      if (typeof text !== 'string') return text;
      records.push({ recipient: t.recipient, text });
    }

    const badHeader = checkSender(account, body.sender);
    if (badHeader) return badHeader;
    const badIys = checkIys(account, iysFilter, body.sender);
    if (badIys) return badIys;

    const count = records.length;
    const window = resolveSendWindow({ startAt: body.startAt, stopAt: body.stopAt, count, nowMs: ctx.clock.now() });
    if (typeof window.status === 'number') return window;

    const senderEntry = account.senders.find(s => s.name === body.sender);
    const { accepted, rejected, rejectedTotal } = validateRecords(records, {
      encoding: body.encoding ?? 'DEFAULT',
      alphanumericSender: senderEntry.type === 'ALPHANUMERIC',
      account,
    });
    const truncated = rejectedTotal > MAX_REPORTED;
    if (accepted.length === 0) {
      return smsError(422, 'NO_DELIVERABLE_MESSAGES', `all ${count} messages rejected`, {
        rejectedItems: rejected, rejectedItemsTruncated: truncated,
      });
    }

    const job = ctx.jobs.create({
      accountId: account.id, kind: 'TEMPLATE', status: window.status,
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

  // ---- POST /send/otp
  // Sıra: gövde JSON (sunucu) → token gönderildi → zorunlu alanlar ve numara → token geçerli → yetki
  // (x-client dahil) → başlık → metin uzunluğu → kredi. İstek sınırı yoktur.
  // Bu sıra diğer SMS uçlarından farklıdır; sunucunun gövdeden önceki token denetimi (authFirst) bu uçta kapalıdır.
  ctx.routes.add('POST', SEND_OTP, (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth && auth.body.message === 'no bearer token') return auth;
    const bad = checkOtpBody(req.json ?? {});
    if (bad) return bad;
    const body = stripNulls(req.json ?? {});
    if ('status' in auth) return auth;
    const { login, account } = auth;

    const denied = authorize(account, login, 'SEND');
    if (denied) return denied;
    // Kurumsal OTP hesabı `x-client: enterprise` (birebir) gönderir; diğer hesaplar göndermez.
    if (Boolean(account.enterpriseOtp) !== (req.headers?.['x-client'] === 'enterprise')) {
      return smsError(403, 'FORBIDDEN', 'account operator is not served for this operation');
    }

    const sender = findOtpSender(account, body.sender);
    if (sender.error) return sender.error;
    const text = translateOtpText(body.text);
    const max = sender.entry.type === 'SUBSCRIBER_NUMBER' ? OTP_MAX_SUBSCRIBER : OTP_MAX_ALPHANUMERIC;
    if (text.length > max) return invalid(`text is longer than ${max} characters for this sender`);

    if (!account.otpCredit) {
      return smsError(422, 'INSUFFICIENT_CREDIT', 'no credit, package or campaign to pay for the otp');
    }

    const now = ctx.clock.now();
    const job = ctx.jobs.create({
      accountId: account.id, kind: 'OTP', status: 'QUEUED', startMs: now, stopMs: now + MINUTE_MS, sender: sender.entry.name,
      records: [{ index: 0, recipient: `90${body.recipient.slice(-10)}`, text }], referenceId: null,
    });
    return { status: 202, body: { jobId: job.jobId } };
  }, { authFirst: false });

  // ---- GET /templates
  ctx.routes.add('GET', '/sms/v3/templates', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;

    const denied = authorize(account, login, 'USER');
    if (denied) return denied;
    const hit = listLimiter.hit(account.id);
    if (!hit.allowed) return rateLimited('template list rate limit exceeded', hit);

    const q = req.query;
    const intParam = (name, fallback) => {
      const raw = q.get(name);
      if (raw === null || raw === '') return fallback;
      return /^-?\d+$/.test(raw) ? Number(raw) : NaN;
    };
    const page = intParam('page', 0);
    const size = intParam('size', 20);
    if (Number.isNaN(page)) return invalid('page must be an integer');
    if (page < 0) return invalid('page must not be negative');
    if (Number.isNaN(size) || size < 1 || size > LIST_MAX_SIZE) return invalid(`size must be between 1 and ${LIST_MAX_SIZE}`);

    const filters = {};
    for (const name of ['type', 'search', 'content']) {
      const v = q.get(name);
      if (v === null || v.trim() === '') continue;
      if (v.length > LIST_MAX_FILTER) return invalid(`${name} must be at most ${LIST_MAX_FILTER} characters`);
      filters[name] = v;
    }
    const includePublic = (q.get('includePublic') ?? 'true').toLowerCase() !== 'false';

    const lower = (s) => String(s ?? '').toLowerCase();
    const matches = account.templates
      .filter(t => includePublic || !t.public)
      .filter(t => filters.type === undefined || t.type === filters.type)
      .filter(t => filters.search === undefined || lower(t.description).includes(lower(filters.search)))
      .filter(t => filters.content === undefined || lower(t.content).includes(lower(filters.content)))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const slice = matches.slice(page * size, page * size + size);
    return {
      status: 200,
      body: {
        count: slice.length, page, total: matches.length, totalPages: Math.ceil(matches.length / size),
        templates: slice.map(t => ({
          templateId: t.templateId, content: t.content, type: t.type, description: t.description ?? null,
          public: t.public, parameters: t.parameters.map(p => ({ name: p.name, type: p.type, maxLength: p.maxLength ?? null })),
          createdAt: t.createdAt ?? null,
        })),
      },
    };
  });
}
