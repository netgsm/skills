import { explain } from './explain.mjs';

/**
 * @typedef {{ method: string, path: string, status: number, code: string|null, accountId: string|null,
 *   username: string|null, ip: string, bodyHash: string|null, messageCount: number|null,
 *   tokenState: 'ok'|'expired'|'revoked'|'superseded'|'invalid'|'none', requestId: string, at: number,
 *   retryAfterSec?: number|null, query?: string|null, perJob?: boolean, mayHaveBeenQueued?: boolean }} ObservedExchange
 * `mayHaveBeenQueued`: 503 yanıtı verildiği hâlde görev kuyruğa alındı (mock'un QUEUE_UNCONFIRMED senaryosu).
 * @typedef {{ rule: string, severity: 'warn'|'error', message: string, requestId: string, at: string }} Finding
 */

const SEND = '/sms/v3/send';
const TEMPLATE = '/sms/v3/send/template';
const DIRECTORY = '/sms/v3/directory/send';
const REPORT = '/sms/v3/report';
const BALANCE = '/sms/v3/balance';
// Kuyruğa alınıp alınmadığı belirsiz kalabilen gönderimler. /send/otp'ta 503 hiçbir şeyin
// gönderilmediğini gösterir (504 yoktur); OTP'yi yeniden denemek güvenlidir.
const UNCONFIRMED_PATHS = new Set([SEND, TEMPLATE, DIRECTORY]);
// Yalnızca gövdenin kendisinden kaynaklanan hatalar: aynı gövdeyle tekrar denemek anlamsızdır.
// (Kredi, başlık onayı, yetki, İYS gibi dışarıda düzeltilebilen hatalar bilerek hariç.)
const BODY_CAUSED = new Set(['INVALID_REQUEST', 'NO_DELIVERABLE_MESSAGES', 'INVALID_SEND_WINDOW']);
const NON_RETRYABLE_STATUS = new Set([400, 413, 422]);
const REPEAT_WINDOW_MS = 60_000;
const BURST_WINDOW_MS = 10_000;
const BURST_COUNT = 5;
const CHURN_WINDOW_MS = 60_000;
const CHURN_COUNT = 3;
const BALANCE_WINDOW_MS = 60_000;
const BALANCE_COUNT = 10;
const EMIT_INTERVAL_MS = 60_000;
const MAX_FINDINGS = 500;
const MAX_TRACKED = 5000;
// auth.md / SKILL.md ile aynı token tavsiyesi.
const TOKEN_ADVICE = "token'ı önbellekte tutun, süresi dolmadan (expires_in) POST /auth/v3/token/refresh ile refresh edin; SMS API'den 401 UNAUTHENTICATED ya da Identity'den 401 invalid_token alırsanız yeniden giriş yapın ve isteği bir kez tekrarlayın.";

/** Sorgudaki jobId / jobIds değerlerini listeler. */
function jobsOf(query) {
  if (!query) return [];
  const p = new URLSearchParams(query);
  return [...new Set([...p.getAll('jobId'), ...p.getAll('jobIds')].flatMap(v => v.split(',')).map(s => s.trim()).filter(Boolean))];
}

/**
 * Doğru/yanlış tavsiyecisi. Her yanıttan sonra `observe` çağrılır; hatasız ama kötü alışkanlıkları
 * (tek alıcılı seri gönderim, token tekrarı, kuyruğa alınmış olabilecek gönderimi kontrol etmeden yeniden
 * gönderme, Retry-After'ı yok sayma, ...) bulgu olarak üretir.
 * Bir kural aynı hesap için 60 sn içinde en fazla bir kez bulgu üretir.
 * @param {{ clock: { now(): number } }} deps
 */
export function createAdvisor({ clock }) {
  let found = [];
  let lastEmit = new Map();     // `${rule}|${key}` -> ms
  let bursts = new Map();       // key -> ms[]
  let tokens = new Map();       // username -> ms[]
  let balanceReads = new Map(); // key -> ms[] (GET /balance)
  let unconfirmed = new Map();  // `${key}|${path}|${bodyHash}` -> { status, code } (kuyruğa alınmış olabilecek gönderimler)
  let failedBodies = new Map(); // `${key}|${path}|${bodyHash}` -> ms (gövde kaynaklı hata)
  let blockedUntil = new Map(); // `${key}|${path}` -> ms (Retry-After sonu)

  function recent(map, key, now, windowMs) {
    const list = (map.get(key) ?? []).filter(t => now - t < windowMs);
    map.set(key, list);
    return list;
  }

  /** @param {ObservedExchange} e @returns {Finding[]} */
  function observe(e) {
    const now = e.at ?? clock.now();
    const key = e.accountId ?? e.username ?? e.ip ?? 'anon';
    const out = [];
    const emit = (rule, severity, message) => {
      const k = `${rule}|${key}`;
      const prev = lastEmit.get(k);
      if (prev !== undefined && now - prev < EMIT_INTERVAL_MS) return;
      lastEmit.set(k, now);
      const f = { rule, severity, message, requestId: e.requestId, at: new Date(clock.now()).toISOString() };
      out.push(f);
      found.push(f);
      if (found.length > MAX_FINDINGS) found.shift();
    };

    // SINGLE_RECIPIENT_BURST
    if (e.method === 'POST' && e.path === SEND && e.messageCount === 1 && e.status >= 200 && e.status < 300) {
      const list = recent(bursts, key, now, BURST_WINDOW_MS);
      list.push(now);
      if (list.length >= BURST_COUNT) {
        emit('SINGLE_RECIPIENT_BURST', 'warn',
          `${BURST_WINDOW_MS / 1000} saniyede ${list.length} tek alıcılı /send isteği gönderdiniz → alıcıları tek istekte messages dizisine toplayın; her alıcı için ayrı istek hız sınırına daha çabuk takılır ve gereksiz yük oluşturur.`);
      }
    }

    // TOKEN_CHURN
    if (e.method === 'POST' && e.path === '/auth/v3/token' && e.status === 200) {
      const user = e.username ?? key;
      const list = recent(tokens, user, now, CHURN_WINDOW_MS);
      list.push(now);
      if (list.length >= CHURN_COUNT) {
        emit('TOKEN_CHURN', 'warn',
          `Aynı kullanıcı için ${CHURN_WINDOW_MS / 1000} saniyede ${list.length} kez token alındı → her istekte yeni token almayın; ${TOKEN_ADVICE}`);
      }
    }

    // RETRY_AFTER_QUEUE_UNCONFIRMED (önce kontrol, sonra kaydet). Arada yapılan bir GET /report
    // kontrol sayılır ve hesabın bekleyen kayıtlarını temizler.
    if (e.method === 'GET' && e.path === REPORT && e.status === 200) {
      for (const k of [...unconfirmed.keys()]) if (k.startsWith(`${key}|`)) unconfirmed.delete(k);
    }
    const unconfirmedKey = e.bodyHash && UNCONFIRMED_PATHS.has(e.path) ? `${key}|${e.path}|${e.bodyHash}` : null;
    const first = unconfirmedKey ? unconfirmed.get(unconfirmedKey) : undefined;
    if (first) {
      const label = `${first.status} ${first.code ?? ''}`.trim();
      if (e.path === DIRECTORY) {
        emit('RETRY_AFTER_QUEUE_UNCONFIRMED', 'error',
          `/directory/send'de ${label} alan bir gönderimin aynı gövdesi GET /report ile kontrol edilmeden yeniden gönderildi → ilk istek kuyruğa alınmış olabilir, bu gruplara iki kez SMS demektir; yeniden göndermeden önce GET /report ile kontrol etmelisiniz, belirsizse ilk yanıttaki requestId ile teknikdestek@netgsm.com.tr adresine yazın.`);
      } else {
        emit('RETRY_AFTER_QUEUE_UNCONFIRMED', 'warn',
          `${e.path} isteği ${label} aldıktan sonra aynı gövde GET /report ile kontrol edilmeden yeniden gönderildi; ilk görev kuyruğa alınmıştı → 503 çoğunlukla hiçbir şeyin kuyruğa alınmadığını gösterir ama görev kuyruğa alınmış olabilir, körlemesine tekrar çift SMS demektir; toplu gönderimi yeniden göndermeden önce GET /report ile kontrol edin.`);
      }
    }
    if (unconfirmedKey && ((e.path === DIRECTORY && (e.status === 503 || e.status === 504)) || (e.status === 503 && e.mayHaveBeenQueued))) {
      unconfirmed.delete(unconfirmedKey);
      unconfirmed.set(unconfirmedKey, { status: e.status, code: e.code });
      if (unconfirmed.size > MAX_TRACKED) unconfirmed.delete(unconfirmed.keys().next().value);
    }

    // RETRY_NON_RETRYABLE
    if (e.bodyHash) {
      const k = `${key}|${e.path}|${e.bodyHash}`;
      const failedAt = failedBodies.get(k);
      if (failedAt !== undefined && now - failedAt >= REPEAT_WINDOW_MS) failedBodies.delete(k);
      if (failedAt !== undefined && now - failedAt < REPEAT_WINDOW_MS) {
        emit('RETRY_NON_RETRYABLE', 'warn',
          `${e.method} ${e.path} aynı gövdeyle tekrar gönderildi ve daha önce ${e.code ?? 'bir hata'} almıştı → bu hata gövdeden kaynaklanıyor, tekrarla düzelmez; gövdeyi düzeltmeden yeniden denemeyin. ${e.code ? explain(e.code, { path: e.path }) : ''}`.trim());
      }
      if (e.status < 300) failedBodies.delete(k);
      else if (NON_RETRYABLE_STATUS.has(e.status) && BODY_CAUSED.has(e.code)) {
        failedBodies.delete(k);
        failedBodies.set(k, now);
        if (failedBodies.size > MAX_TRACKED) failedBodies.delete(failedBodies.keys().next().value);
      }
    }

    // IGNORED_RETRY_AFTER
    const jobIds = (e.path === '/sms/v3/report' || e.path === '/sms/v3/stats') ? jobsOf(e.query) : [];
    const baseKey = `${key}|${e.path}`;
    const checkKeys = [baseKey, ...jobIds.map(id => `${baseKey}|${id}`)];
    const until = Math.max(-Infinity, ...checkKeys.map(k => blockedUntil.get(k) ?? -Infinity));
    if (until !== -Infinity) {
      if (now < until) {
        emit('IGNORED_RETRY_AFTER', 'warn',
          `${e.path} için Retry-After süresi dolmadan (${Math.ceil((until - now) / 1000)} sn kaldı) yeni istek gönderildi → 429 yanıtındaki Retry-After süresini bekleyin, sonra yeniden deneyin.`);
      } else for (const k of checkKeys) blockedUntil.delete(k);
    }
    if (e.status === 429 && typeof e.retryAfterSec === 'number' && e.retryAfterSec > 0) {
      // Görev kuralı 429'u yalnızca ilgili jobId'leri bloklar; hesap düzeyindeki 429 yolun tamamını.
      const keys = e.perJob && jobIds.length > 0 ? jobIds.map(id => `${baseKey}|${id}`) : [baseKey];
      for (const k of keys) blockedUntil.set(k, now + e.retryAfterSec * 1000);
      if (blockedUntil.size > MAX_TRACKED) blockedUntil.delete(blockedUntil.keys().next().value);
    }

    // STALE_TOKEN
    if (e.tokenState === 'revoked' || e.tokenState === 'superseded' || e.tokenState === 'expired') {
      const why = e.tokenState === 'revoked'
        ? 'POST /auth/v3/token/revoke ile iptal edilmiş (revoke)'
        : e.tokenState === 'expired'
          ? 'süresi dolmuş (expires_in geçmiş)'
          : 'yenisiyle değiştirilmiş (aynı oturum refresh edilmiş ya da aynı hesapta diğer kimliğin girişi eskisini kapatmış)';
      emit('STALE_TOKEN', 'warn',
        `Kullandığınız token ${why} → eski token'ı atın; ${TOKEN_ADVICE}`);
    }

    // REPORT_POLLING
    if (e.status === 429 && (e.path === '/sms/v3/report' || e.path === '/sms/v3/stats')) {
      emit('REPORT_POLLING', 'warn',
        `${e.path} sorgulamasında sınıra takıldınız (aynı görev kısa sürede tekrar sorgulandı) → durumu sık sık sorgulamak yerine webhook kullanın: POST /sms/v3/webhooks/report ile iletim raporunu size göndersin.`);
    }

    // BALANCE_POLLING: bakiye döngüde sorgulanıyor (dakikada 10+ istek ya da 429)
    if (e.method === 'GET' && e.path === BALANCE) {
      const list = recent(balanceReads, key, now, BALANCE_WINDOW_MS);
      list.push(now);
      if (e.status === 429 || list.length >= BALANCE_COUNT) {
        emit('BALANCE_POLLING', 'warn',
          `${BALANCE_WINDOW_MS / 1000} saniyede ${list.length} bakiye sorgusu (GET /sms/v3/balance) gönderdiniz → bakiyeyi döngüde ya da her gönderimden önce sorgulamayın; büyük bir kampanyadan önce bir kez bakın. Yanıt 10 sn önbellekte tutulur, sık sorgu yeni bilgi getirmez; sınır hesap başına dakikada 60 istektir.`);
      }
    }

    return out;
  }

  return {
    observe,
    findings: () => found.map(f => ({ ...f })),
    clear() {
      found = []; lastEmit = new Map(); bursts = new Map(); tokens = new Map(); balanceReads = new Map();
      unconfirmed = new Map(); failedBodies = new Map(); blockedUntil = new Map();
    },
  };
}
