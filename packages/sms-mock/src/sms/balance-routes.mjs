// GET /sms/v3/balance (etiket "Hesap"): hesabın kalan paketleri, kampanyaları ve kredi bakiyesi.
// Yanıt gövdesi API'nin genel kurallarına uymaz (spec): `amount` metin ya da sayı, kredi virgüllü metin,
// `stip=2` özetinde bazı alanlar hiç bulunmaz. Veri hesap başına sabittir (accounts.mjs BALANCES).
import { smsError } from './api-error.mjs';
import { authenticate } from './auth.mjs';
import { createFixedWindowLimiter } from '../ratelimit.mjs';

export const BALANCE_PATH = '/sms/v3/balance';
export const BALANCE_SERVICES = ['sms', 'otp', 'ses', 'fax', 'whatsapp', 'santral', 'netsipp', 'gsm', 'internet', 'numara', 'ai', 'ucret'];
export const CREDIT_NAME = 'Kredi Bakiye';
const CACHE_MS = 10_000;
const RATE_LIMIT = 60;
const MINUTE_MS = 60_000;

/** TL kredi → virgüllü, üç ondalıklı metin: 92.15 → "92,150". */
export const formatCredit = (tl) => tl.toFixed(3).replace('.', ',');

/** `stip`: 1, 2 ya da 3; başka bir değer ya da hiç verilmemesi 1 sayılır (hata dönmez). */
export function parseStip(raw) {
  const m = /^\s*([123])\s*$/.exec(raw ?? '');
  return m ? Number(m[1]) : 1;
}

/** Tek kayıt metin (`"767"`), birden fazla kayıt toplanıp sayı (`277`). */
const amountOf = (amounts) => (amounts.length === 1 ? String(amounts[0]) : amounts.reduce((a, b) => a + b, 0));

function assetList(balance, service) {
  return balance.assets
    // service verilmezse SMS gönderim hizmetinin varlıkları (OTP SMS paketleri dahil); service=sms bunları içermez.
    .filter(a => (service === null ? a.sendService : a.service === service))
    .map(a => ({ amount: amountOf(a.amounts), balance_name: a.name }));
}

/** `stip=2` özeti: faturalı "0"; faturasızda kredi, yoksa SMS adedi (`type: AdetSMS`), ikisi de yoksa yalnızca `code`. */
function summary(balance) {
  if (balance.postpaid) return { code: '00', balance: '0' };
  if (balance.credit > 0) return { code: '00', balance: formatCredit(balance.credit) };
  const sms = balance.assets.filter(a => a.name === 'Adet SMS').flatMap(a => a.amounts).reduce((a, b) => a + b, 0);
  if (sms > 0) return { code: '00', balance: String(sms), type: 'AdetSMS' };
  return { code: '00' };
}

export function registerBalanceRoutes(ctx) {
  // Her istek sayılır (reddedilenler dahil); pencere ilk istekle başlar ve sabittir.
  const limiter = createFixedWindowLimiter({
    limit: RATE_LIMIT, windowMs: MINUTE_MS, countRejected: true, clock: ctx.clock, rateScale: ctx.opts.rateScale, registry: ctx.resettables,
  });
  // Aynı hesap, aynı stip ve aynı service için yanıt 10 sn saklanır.
  const cache = new Map(); // `${accountId}|${stip}|${service}` -> { at, body }
  ctx.resettables.push({ reset: () => cache.clear() });

  ctx.routes.add('GET', BALANCE_PATH, (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const { account } = auth; // geçerli bir token yeterlidir; ayrıca yetki istenmez

    const hit = limiter.hit(account.id);
    if (!hit.allowed) {
      return smsError(429, 'RATE_LIMITED', 'balance rate limit exceeded', {}, { 'Retry-After': String(hit.retryAfterSec) });
    }

    const stip = parseStip(req.query.get('stip'));
    const rawService = req.query.get('service');
    const service = rawService === null || rawService.trim() === '' ? null : rawService.trim().toLowerCase();
    if (service !== null && !BALANCE_SERVICES.includes(service)) {
      return smsError(400, 'INVALID_REQUEST', `service must be one of ${BALANCE_SERVICES.join(', ')}`);
    }

    const now = ctx.clock.now();
    const key = `${account.id}|${stip}|${service ?? ''}`;
    const cached = cache.get(key);
    if (cached && now - cached.at < CACHE_MS) return { status: 200, body: structuredClone(cached.body) };

    const { balance } = account;
    let body;
    if (stip === 2) {
      body = summary(balance); // service özeti etkilemez
    } else {
      const list = assetList(balance, service);
      if (stip === 3) list.push({ amount: formatCredit(balance.credit), balance_name: CREDIT_NAME });
      body = { balance: list };
    }
    cache.set(key, { at: now, body: structuredClone(body) });
    return { status: 200, body };
  });
}
