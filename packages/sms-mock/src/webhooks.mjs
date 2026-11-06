import { randomUUID } from 'node:crypto';
import { deliveryOf, isReportable } from './jobs.mjs';
import { operatorOf, partsOf } from './sms/jobs-routes.mjs';

const TZ_MS = 3 * 3_600_000; // Europe/Istanbul, sabit +03:00
const REPORT_TIMEOUT_MS = 600_000; // spec: yanıt 10 dakika içinde
const INBOX_TIMEOUT_MS = 4000; // spec: yanıt 4 saniye içinde
const REPORT_BATCH = 500;
const REPORT_CONCURRENCY = 2; // aynı anda en fazla bu kadar rapor isteği (bütün hesaplar ve tick'ler için)

/** `yyyy-MM-dd HH:mm:ss`, Türkiye saatiyle, saat dilimi bilgisi olmadan. */
export function webhookTime(ms) {
  return new Date(ms + TZ_MS).toISOString().slice(0, 19).replace('T', ' ');
}

// Rapor webhook'unda durum, operatör ve iletilmeme nedeni sayısal koddur (spec: ReportWebhookEntry).
// GET /report aynı bilgiyi ad olarak döndürür; tablolar ad → kod eşlemesidir.
/** Sonuçlanmış iletim: `DELIVERED` 1, nedeni `errorCode`'da olan `NOT_DELIVERED` 2. */
export const WEBHOOK_STATUS = { DELIVERED: 1, NOT_DELIVERED: 2 };
/** Kendi durum kodu olan iletilmeme nedenleri (`failReason` → `status`); `errorCode` bu durumlarda 0'dır. */
export const WEBHOOK_FAIL_STATUS = {
  INVALID_NUMBER: 3, NOT_SENT_TO_OPERATOR: 4, OPERATOR_REJECTED: 8, OPERATOR_ERROR: 11, SEND_ERROR: 12,
  DUPLICATE: 13, INSUFFICIENT_CREDIT: 14, BLACKLISTED: 15, IYS_REJECTED: 16, IYS_ERROR: 17,
  MESSAGE_NOT_CREATED: 18, INVALID_NUMBER_FORMAT: 19, NTS_NOT_APPROVED: 20, NO_INTERNATIONAL_PERMISSION: 22,
};
/** `status` 2 iken nedeni veren kod (`failReason` → `errorCode`). Bilinmeyen neden 0. */
export const WEBHOOK_ERROR_CODE = {
  TIMEOUT: 111, SMS_DISABLED_ON_DEVICE: 112, DEVICE_NOT_SUPPORTED: 113, ROUTING_FAILED: 114,
  OPERATOR_TIMEOUT: 115, UNKNOWN_SUBSCRIBER: 116, ILLEGAL_SUBSCRIBER: 117, SYSTEM_ERROR: 119,
};
/** Operatör adı → kod. Netgsm 40/41/43, yurt dışı 210–218 aralığındadır; mock ilkini kullanır. Belirlenemeyen 0. */
export const WEBHOOK_OPERATOR = {
  VODAFONE: 10, TURK_TELEKOM: 20, TURKCELL: 30, NETGSM: 40, AKONTEL: 45, INTERNATIONAL: 210, UNKNOWN: 0,
};

/**
 * Sonuçlanmış bir iletimin (`deliveryOf`) webhook kodları. Bekleyen iletim webhook ile bildirilmez;
 * çağıran bunu önceden ayıklar.
 * @returns {{ status: number, errorCode: number }}
 */
export function webhookCodes({ status, failReason }) {
  if (status === 'DELIVERED') return { status: WEBHOOK_STATUS.DELIVERED, errorCode: 0 };
  if (failReason !== null && failReason in WEBHOOK_FAIL_STATUS) return { status: WEBHOOK_FAIL_STATUS[failReason], errorCode: 0 };
  return { status: WEBHOOK_STATUS.NOT_DELIVERED, errorCode: WEBHOOK_ERROR_CODE[failReason] ?? 0 };
}

/** "Name: value" satırını başlık çiftine çevirir; başlık yoksa null. */
function headerPair(line) {
  if (!line) return null;
  const i = line.indexOf(':');
  return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
}

/**
 * Webhook kayıtları ve teslimi. Her iletim/mesaj yalnızca bir kez gönderilir; başarısız teslim tekrarlanmaz.
 * @param {{ fetchImpl?: typeof fetch, clock: import('./clock.mjs').Clock, log?: (l: string) => void,
 *           jobs?: ReturnType<import('./jobs.mjs').createJobStore>, accounts?: { get(id: string): any } }} deps
 */
export function createWebhookDispatcher({ fetchImpl, clock, log = () => {}, jobs, accounts }) {
  const hooks = { report: new Map(), inbox: new Map() }; // accountId -> { url, headers, registeredMs }
  const sent = new Set(); // `${accountId}:${jobId}:${recordIndex}` (yalnızca henüz tamamı raporlanmamış görevler)
  const reported = new Set(); // `${accountId}:${jobId}`: bütün kayıtları nihai duruma geçip gönderilmiş görevler
  let active = 0;
  const waiting = [];

  /** Rapor isteklerini sınırlı eşzamanlılıkla çalıştırır. */
  async function limited(task) {
    // Boşalan yer doğrudan sıradakine devredilir; arada gelen yeni istek sınırı aşamaz.
    if (active >= REPORT_CONCURRENCY) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await task(); } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  }

  async function post(hook, body, timeoutMs, extraHeaders = {}) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    // kullanıcı başlığı mock'un kendi başlıklarını (büyük/küçük harfe bakılmaksızın) ezemez
    const pair = headerPair(hook.headers);
    if (pair && !Object.keys(headers).some(k => k.toLowerCase() === pair[0].toLowerCase())) headers[pair[0]] = pair[1];
    try {
      const res = await doFetch(hook.url, {
        // Yönlendirme izlenmez: kayıtlı adres başka bir (ör. iç ağdaki) adrese yönlendiremez.
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'manual',
      });
      if (!res || res.status < 200 || res.status > 299) log(`webhook delivery failed: ${hook.url} -> ${res?.status}`);
    } catch (err) {
      log(`webhook delivery failed: ${hook.url} -> ${err?.message ?? err}`);
    }
  }

  return {
    register(accountId, kind, url, headers = null) {
      const hook = { url, headers: headers || null, registeredMs: clock.now() };
      hooks[kind].set(accountId, hook);
      return hook;
    },
    unregister(accountId, kind) { return hooks[kind].delete(accountId); },
    has(accountId, kind) { return hooks[kind].has(accountId); },

    /** Gelen SMS'i anında, tek istekle iletir. Senkron başlar; sonucu beklemek isteğe bağlıdır. */
    onInbound(accountId, msg) {
      const hook = hooks.inbox.get(accountId);
      if (!hook) return Promise.resolve();
      const digits = String(msg.from).replace(/\D/g, '');
      const body = {
        messageId: String(msg.id ?? ''),
        messageDateTime: webhookTime(msg.receivedAt ?? clock.now()),
        sourceNumber: digits.slice(-10),
        content: String(msg.text ?? ''),
        subscriberNumber: String(accounts?.get(accountId)?.username ?? accountId),
      };
      return post(hook, body, INBOX_TIMEOUT_MS, { 'X-Correlation-Id': randomUUID() });
    },

    /**
     * Nihai duruma geçen ve henüz gönderilmemiş iletimleri hesap başına gruplayıp en fazla 500 kayıtlık
     * isteklerle gönderir; istekler sınırlı eşzamanlılıkla (en fazla 2) çalışır. Her kayıt bir kez
     * gönderilir. Bütün kayıtları gönderilen görev "tamamı raporlandı" olarak işaretlenir, kayıt
     * anahtarları bırakılır ve sonraki tick'lerde atlanır.
     */
    async tick() {
      if (!jobs) return;
      const now = clock.now();
      const pending = [];
      for (const [accountId, hook] of hooks.report) {
        const numbers = [];
        for (const job of jobs.all(accountId)) {
          const jobKey = `${accountId}:${job.jobId}`;
          if (reported.has(jobKey) || !isReportable(job)) continue;
          let allSent = true;
          job.records.forEach((record, i) => {
            const d = deliveryOf(job, record, now);
            if (d.status === 'PENDING') { allSent = false; return; }
            const key = `${jobKey}:${record.index ?? i}`;
            if (sent.has(key)) return;
            sent.add(key);
            const recipient = String(record.recipient);
            const { status, errorCode } = webhookCodes(d);
            numbers.push({
              jobid: job.jobId,
              number: recipient.startsWith('-') ? recipient.slice(1) : recipient.slice(2),
              status,
              operator: WEBHOOK_OPERATOR[operatorOf(recipient)] ?? 0,
              msglen: partsOf(job, record),
              deliveredDate: d.deliveredAt === null ? '' : webhookTime(d.deliveredAt),
              errorCode,
              referansID: job.referenceId ?? null,
            });
          });
          if (allSent) {
            reported.add(jobKey);
            job.records.forEach((record, i) => sent.delete(`${jobKey}:${record.index ?? i}`));
          }
        }
        for (let i = 0; i < numbers.length; i += REPORT_BATCH) {
          const batch = numbers.slice(i, i + REPORT_BATCH);
          pending.push(limited(() => post(hook, { numbers: batch }, REPORT_TIMEOUT_MS)));
        }
      }
      await Promise.all(pending);
    },

    /** Test ve teşhis için iç sayaçlar. */
    stats() { return { sentKeys: sent.size, reportedJobs: reported.size, inFlight: active }; },
  };
}
