import { isIP } from 'node:net';
import { smsError, fieldsRejected } from './api-error.mjs';
import { authenticate, authorize } from './auth.mjs';
import { createSchemaValidator } from './schema.mjs';
import { createFixedWindowLimiter } from '../ratelimit.mjs';
import { bindBody } from './bind.mjs';
import { istanbulTimestamp } from '../http.mjs';
import { smsSpec } from '../generated/specs.mjs';

const validator = createSchemaValidator(smsSpec);

// Mock varsayımı (sözleşme değildir; spec sayı vermez): webhook çağrılarının dördü
// (kayıt/silme x rapor/gelen) hesap başına tek sayaç. İstemci 429 ve Retry-After'a göre davranmalıdır.
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

// Tek satır `Name: value`; yalnızca yazdırılabilir ASCII, değerde virgül ve iki nokta üst üste yok.
const HEADER_LINE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t\x20-\x2B\x2D-\x39\x3B-\x7E]*$/;
// WHATWG URL'nin IPv4 saydığı biçim: her etiket onluk ya da 0x onaltılık sayı.
const NUMBER_LABEL = /^(\d+|0x[0-9a-f]*)$/i;
const DOTTED_DECIMAL = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const RESERVED_SUFFIX = /\.(local|localhost|internal|localdomain|lan|home|corp|intranet)$/;
// Mock'un bilinçli sapması: spec loopback'i yasaklar; mock yalnızca kendisi loopback adreste dinlerken
// yerel alıcıya izin verir (ctx.opts.allowLoopbackWebhooks).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const invalid = (message) => smsError(400, 'INVALID_REQUEST', message);

function isPublicIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  const l = ip.toLowerCase();
  if (l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff')) return false;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (dotted) return isPublicIp(dotted[1]);
  // URL ayrıştırıcı eşlenmiş adresi onaltılık normalleştirir: ::ffff:7f00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPublicIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return true;
}

/** Hata mesajı ya da null. DNS çözümlemesi yoktur: adlar yalnızca biçimce denetlenir. */
function checkUrl(raw, allowLoopback) {
  const url = String(raw).trim();
  let u;
  try { u = new URL(url); } catch { return 'url must be an absolute http or https URL with a host'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'url must be an absolute http or https URL with a host';
  if (!u.hostname) return 'url must be an absolute http or https URL with a host';
  if (u.port !== '' && (Number(u.port) < 1 || Number(u.port) > 65535)) return 'port must be between 1 and 65535';
  let host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  if (host.endsWith('.')) host = host.slice(0, -1); // mutlak ad: localhost. == localhost
  const nonPublic = 'url must point to a public address';
  if (LOCAL_HOSTS.has(host)) return allowLoopback ? null : nonPublic;
  if (isIP(host) !== 0) return isPublicIp(host) ? null : nonPublic;
  if (host.split('.').every(l => NUMBER_LABEL.test(l)) && !DOTTED_DECIMAL.test(host)) return nonPublic;
  if (!host.includes('.') || RESERVED_SUFFIX.test(host)) return nonPublic;
  return null;
}

export function registerWebhookRoutes(ctx) {
  const limiter = createFixedWindowLimiter({
    limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS, countRejected: true, clock: ctx.clock, rateScale: ctx.opts.rateScale, registry: ctx.resettables,
  });
  const names = { report: 'report', inbox: 'inbox' };

  /** Yetki, sayaç; sorun varsa MockResponse, yoksa `{ account }`. */
  function gate(req, validate) {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { login, account } = auth;
    if (validate) {
      const unbound = bindBody('WebhookRequest', req.json ?? {});
      if (unbound) return unbound;
      const violations = validator.validate('WebhookRequest', req.json ?? {});
      if (violations.length > 0) return fieldsRejected(violations);
    }
    const denied = authorize(account, login, 'USER');
    if (denied) return denied;
    const hit = limiter.hit(account.id);
    if (!hit.allowed) return smsError(429, 'RATE_LIMITED', 'webhook rate limit exceeded', {}, { 'Retry-After': String(hit.retryAfterSec) });
    return { account };
  }

  for (const kind of ['report', 'inbox']) {
    const path = `/sms/v3/webhooks/${kind}`;
    ctx.routes.add('POST', path, (req) => {
      const g = gate(req, true);
      if ('status' in g) return g;
      const { account } = g;
      const { url: rawUrl, headers: rawHeaders } = req.json;
      const problem = checkUrl(rawUrl, ctx.opts.allowLoopbackWebhooks !== false);
      if (problem) return invalid(problem);
      const headers = typeof rawHeaders === 'string' && rawHeaders.trim() !== '' ? rawHeaders.trim() : null;
      if (headers !== null && !HEADER_LINE.test(headers)) {
        return invalid("headers must be one 'Name: value' line of printable ASCII, with no comma or colon in the value");
      }
      if (ctx.webhooks.has(account.id, kind)) {
        return smsError(409, 'ALREADY_EXISTS', `a ${names[kind]} webhook is already registered; delete it first`);
      }
      const url = String(rawUrl).trim();
      const hook = ctx.webhooks.register(account.id, kind, url, headers);
      return { status: 201, body: { url, headers, registeredAt: istanbulTimestamp(hook.registeredMs) } };
    });
    ctx.routes.add('DELETE', path, (req) => {
      const g = gate(req, false);
      if ('status' in g) return g;
      if (!ctx.webhooks.unregister(g.account.id, kind)) {
        return smsError(404, 'NOT_FOUND', `no ${names[kind]} webhook is registered`);
      }
      return { status: 204 };
    });
  }
}
