/**
 * Netgsm İYS API v1 için bağımlılıksız TypeScript istemcisi (Node ≥ 20, global `fetch` ve `crypto`).
 *
 * YALNIZCA SUNUCU TARAFINDA kullanın. Kullanıcı adı ve şifre ortam değişkeninden okunur; tarayıcıya,
 * mobil uygulamaya ya da istemciye giden bir pakete asla konmaz.
 *
 * İYS'NİN SANDBOX'I VE MOCK'U YOKTUR: bu istemcinin her isteği canlı İleti Yönetim Sistemi'ne gider.
 * Testlerde `fetch` seçeneğiyle sahte bir fetch verin. Gerçek numarayla test ya da örnek izin
 * kaydetmeyin; izin kayıtları hukuki kayıttır, silinemez ve düzenlenemez.
 *
 * Uyguladığı kurallar (bkz. ../getting-started.md, ../errors.md, ../consents.md):
 * - Token `POST /auth/v3/token` ile `scope: "sms"` alınır ve önbelleğe konur; süresinin son
 *   min(5 dk, ömrün %10'u) kısmında refresh edilir. Eş zamanlı çağrılar tek token isteğini paylaşır.
 *   Başarısız refresh'ten sonra eski token geçerliyse 30 sn onunla devam edilir (bu sürede refresh denenmez).
 * - İYS `401` (errorCode 50–53) → token atılır, yeniden giriş yapılır, istek bir kez tekrarlanır.
 * - `429` (150) ve `503` (141) → 1, 2, 4 sn arayla en fazla 3 tekrar (yanıtta `Retry-After` varsa o).
 * - `424` (112), `500` (110) ve diğer 5xx: `GET /consents` ve `POST /webhooks`'ta tekrar denenir;
 *   `POST /consents`'te tekrar YOK, `mayHaveBeenProcessed: true` (önce GET /consents ve webhook ile kontrol).
 * - Diğer 4xx (`400`, `403`, `404`, `405`, `409`, `422`) → tekrar yok, `retryable: false`.
 * - Her isteğe `X-Request-Id` eklenir (verilmezse UUID); hata `threadId` (`X-Thread-Id`) taşır.
 * - Şifre ve token hiçbir hata mesajına girmez. Alıcılar hata mesajına yazılmaz.
 */

export interface IysClientOptions {
  /** Netgsm abone numarası. */
  username: string;
  /** API alt kullanıcısının şifresi. */
  password: string;
  /**
   * ZORUNLU. Tek ortam canlıdır: 'https://ext-api.netgsm.com.tr'. Ortam değişkeninden okuyun
   * (ör. NETGSM_BASE_URL). Testte sahte fetch ile herhangi bir adres verilebilir.
   */
  baseUrl: string;
  /** İYS marka kodu; her istekte gönderilir. */
  brandCode: number;
  /** Bundan uzun bekleme yapılmaz, hata fırlatılır (retryable: true). Varsayılan 60. */
  maxWaitSec?: number;
  /** Testte sahte fetch vermek için. */
  fetch?: typeof fetch;
  /** Saat (ms). Testte sahte saat vermek için. */
  now?: () => number;
  /** Bekleme. Testte beklemeden geçmek için. */
  sleep?: (ms: number) => Promise<void>;
}

// --- Tipler (openapi.yaml şemalarından) ---------------------------------------------------------

export type RecipientType = 'BIREYSEL' | 'TACIR';
export type ConsentType = 'ARAMA' | 'MESAJ' | 'EPOSTA';
export type ConsentStatus = 'ONAY' | 'RET';
export type IysPath = 'SANTRAL' | 'SMSAPI' | 'WEBPORTAL';
export type ConsentSource =
  | 'HS_FIZIKSEL_ORTAM' | 'HS_ISLAK_IMZA' | 'HS_WEB' | 'HS_CAGRI_MERKEZI' | 'HS_SOSYAL_MEDYA'
  | 'HS_EPOSTA' | 'HS_MESAJ' | 'HS_MOBIL' | 'HS_EORTAM' | 'HS_ETKINLIK' | 'HS_2015' | 'HS_ATM' | 'HS_KARAR';

export interface ConsentRecord {
  /** '+90XXXXXXXXXX' ya da e-posta adresi. */
  recipient: string;
  recipientType: RecipientType;
  type: ConsentType;
  source: ConsentSource;
  status: ConsentStatus;
  /** İznin alındığı an, 'YYYY-MM-DD HH:mm:ss' (bkz. formatIysDate). */
  consentDate: string;
  retailerCode?: number | null;
  retailerAccess?: number[] | null;
}

export interface RejectedConsent { index: number; field: string; message: string }

export interface SaveConsentsResult {
  uid: string;
  /** İYS'nin reddettiği kayıtlar; `index` permissions içindeki sıfırdan başlayan sıra. Hiçbiri yoksa []. */
  rejected: RejectedConsent[];
  /** Gönderilen X-Request-Id. */
  requestId: string;
}

export interface ConsentQuery { recipient: string; recipientType: RecipientType; type: ConsentType; refId?: string }

export interface Consent {
  type: string | null;
  source: string | null;
  recipient: string;
  status: string | null;
  consentDate: string | null;
  recipientType: string;
  /** Kayıt bazlı sonuç: 0 başarılı, 81 kayıt bulunamadı, 120 hatalı istek, 112 İYS'den yanıt alınamadı. */
  errorCode: number;
  message: string | null;
}

export class IysApiError extends Error {
  readonly status: number;
  /** İYS errorCode; Identity hatasında Problem `code` (ör. 'invalid_credentials'), ağ hatasında 'NETWORK'. */
  readonly errorCode: number | string;
  readonly threadId: string | null;
  readonly retryable: boolean;
  /** true: istek İYS'de işlenmiş olabilir. Aynı kayıtları yeniden göndermeden önce GET /consents ile kontrol edin. */
  readonly mayHaveBeenProcessed: boolean;
  /** Hata gövdesinin `data` alanı (422'de `errors`). */
  readonly data: unknown;

  constructor(init: {
    operation: string; status: number; errorCode: number | string; detail: string; threadId: string | null;
    retryable: boolean; mayHaveBeenProcessed?: boolean; data?: unknown;
  }) {
    super(`${init.operation} → ${init.status} ${init.errorCode}: ${init.detail} (X-Thread-Id ${init.threadId ?? '-'})`);
    this.name = 'IysApiError';
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.threadId = init.threadId;
    this.retryable = init.retryable;
    this.mayHaveBeenProcessed = init.mayHaveBeenProcessed ?? false;
    this.data = init.data;
  }
}

// --- Yardımcılar ---------------------------------------------------------------------------------

const BACKOFF_SEC = [1, 2, 4];
const IYS_PHONE = /^\+90\d{10}$/;

/**
 * Date → 'YYYY-MM-DD HH:mm:ss'. Sözleşme saat dilimi belirtmez; burada varsayılan Türkiye saatidir
 * ('Europe/Istanbul'). Kendi sisteminizde hangi saat dilimini kullandığınızı resmî dokümanla teyit edin.
 */
export function formatIysDate(date: Date, timeZone = 'Europe/Istanbul'): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** SMS API v3 biçimi (905XXXXXXXXX) → İYS biçimi (+905XXXXXXXXX). */
export function toIysRecipient(smsRecipient: string): string {
  if (!/^90\d{10}$/.test(smsRecipient)) throw new TypeError('SMS API v3 numarası 90XXXXXXXXXX biçiminde olmalı');
  return `+${smsRecipient}`;
}

/** Loglar için: '+905321234567' → '+90532*****67', 'ad@alan.com' → 'a***@alan.com'. */
export function maskRecipient(recipient: string): string {
  if (recipient.includes('@')) {
    const [user, domain] = recipient.split('@');
    return `${user.slice(0, 1)}***@${domain}`;
  }
  return recipient.length > 8 ? `${recipient.slice(0, 6)}${'*'.repeat(recipient.length - 8)}${recipient.slice(-2)}` : '***';
}

/** Diziyi en fazla `size` elemanlı parçalara böler. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function assertRecipient(recipient: string, where: string): void {
  if (recipient.includes('@')) return;
  if (!IYS_PHONE.test(recipient)) {
    // Alıcı hata mesajına yazılmaz (kişisel veri).
    throw new TypeError(`${where}: telefon numarası +90XXXXXXXXXX biçiminde olmalı (SMS API'nin 90… biçimi değil)`);
  }
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const sec = Number(value);
  if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

// --- Token yöneticisi ----------------------------------------------------------------------------

type Tokens = { access: string; refresh: string; expiresAt: number; marginMs: number };

const REFRESH_BACKOFF_MS = 30_000;

class TokenManager {
  private tokens?: Tokens;
  private inflight?: Promise<string>;
  private retryAfterMs = 0; // başarısız yenilemeden sonra kısa bekleme

  private readonly o: { baseUrl: string; username: string; password: string; fetch: typeof fetch; now: () => number };

  constructor(o: { baseUrl: string; username: string; password: string; fetch: typeof fetch; now: () => number }) {
    this.o = o;
  }

  async get(): Promise<string> {
    const t = this.tokens;
    const now = this.o.now();
    // Yenileme payına girilmediyse ya da başarısız bir yenilemeden sonraki bekleme sürüyorsa eski token kullanılır.
    if (t && (now < t.expiresAt - t.marginMs || now < this.retryAfterMs) && now < t.expiresAt) return t.access;
    this.inflight ??= this.renew().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  /** 401 alındığında, o istekte kullanılan token ile çağrılır; başka bir çağrının yenilediği token silinmez. */
  invalidate(stale: string): void {
    if (this.tokens?.access === stale) this.tokens = undefined;
  }

  private async renew(): Promise<string> {
    const old = this.tokens;
    if (old) {
      let r: Response | undefined;
      let networkError: IysApiError | undefined;
      try {
        r = await this.post('/auth/v3/token/refresh', { refresh_token: old.refresh });
      } catch (err) {
        if (!(err instanceof IysApiError)) throw err;
        networkError = err; // ağ hatası: geçici hata gibi
      }
      if (r?.ok) return this.store(await r.json());
      // Geçici refresh hatasında (ağ, 401 dışı yanıt) eski token hâlâ geçerliyse onunla devam edilir ve 30 sn
      // yeniden refresh denenmez; ancak refresh beklenirken invalidate() token'ı silmişse (this.tokens !== old) kullanılmaz.
      if (r?.status !== 401 && this.tokens === old && this.o.now() < old.expiresAt) {
        this.retryAfterMs = this.o.now() + REFRESH_BACKOFF_MS;
        return old.access;
      }
      if (!r) throw networkError; // refresh yanıtı yok ve eski token kullanılamıyor
      this.tokens = undefined;
    }
    // İYS için de scope "sms" (Netgsm kuralı; sözleşme scope belirtmez).
    const r = await this.post('/auth/v3/token', { username: this.o.username, password: this.o.password, scope: 'sms' });
    if (!r.ok) {
      const p = await readJson(r);
      throw new IysApiError({
        operation: 'POST /auth/v3/token', status: r.status, errorCode: p.code ?? `HTTP_${r.status}`,
        detail: p.detail ?? r.statusText, threadId: p.request_id ?? r.headers.get('X-Thread-Id'),
        retryable: r.status >= 500 || p.code === 'rate_limited',
      });
    }
    return this.store(await r.json());
  }

  private store(t: { access_token: string; refresh_token: string; expires_in: number }): string {
    const lifeMs = t.expires_in * 1000;
    this.tokens = {
      access: t.access_token, refresh: t.refresh_token,
      expiresAt: this.o.now() + lifeMs, marginMs: Math.min(5 * 60_000, lifeMs / 10),
    };
    this.retryAfterMs = 0;
    return t.access_token;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    try {
      return await this.o.fetch(this.o.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Token isteğinin yanıtı alınamadı. İYS isteği henüz gönderilmedi: daha sonra tekrar denemek güvenlidir.
      throw new IysApiError({
        operation: `POST ${path}`, status: 0, errorCode: 'NETWORK', detail: (err as Error).message, threadId: null, retryable: true,
      });
    }
  }
}

// --- İYS istemcisi -------------------------------------------------------------------------------

export class IysClient {
  private readonly baseUrl: string;
  private readonly brandCode: number;
  private readonly maxWaitSec: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tokens: TokenManager;

  constructor(opts: IysClientOptions) {
    if (!opts.username || !opts.password) throw new Error('Netgsm kullanıcı adı ve şifresi gerekli (ortam değişkenlerinden okuyun)');
    if (typeof opts.baseUrl !== 'string' || opts.baseUrl.trim() === '') {
      throw new Error("baseUrl gerekli: 'https://ext-api.netgsm.com.tr' (İYS'nin sandbox'ı yoktur; ortam değişkeninden okuyun)");
    }
    if (!Number.isInteger(opts.brandCode) || opts.brandCode < 1) throw new Error('brandCode (İYS marka kodu) pozitif tam sayı olmalı');
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    this.brandCode = opts.brandCode;
    this.maxWaitSec = opts.maxWaitSec ?? 60;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.tokens = new TokenManager({
      baseUrl: this.baseUrl, username: opts.username, password: opts.password, fetch: this.fetchImpl, now: this.now,
    });
  }

  /**
   * POST /iys/v1/consents. En fazla 500 kayıt. CANLI İYS'YE HUKUKİ KAYIT YAZAR: yalnızca gerçekten
   * alınmış izinler (ya da retler) gönderilir. Dönen `rejected` her zaman işlenir.
   */
  async saveConsents(permissions: ConsentRecord[], opts: { refId?: string; path?: IysPath; requestId?: string } = {}): Promise<SaveConsentsResult> {
    if (permissions.length < 1 || permissions.length > 500) throw new RangeError('POST /consents istek başına 1–500 kayıt alır; chunk(permissions, 500) kullanın');
    permissions.forEach((p, i) => assertRecipient(p.recipient, `permissions[${i}]`));
    const body = { brandCode: this.brandCode, ...(opts.path ? { path: opts.path } : {}), ...(opts.refId ? { refId: opts.refId } : {}), permissions };
    const { json, requestId } = await this.request('POST', '/consents', body, opts.requestId);
    return { uid: json.data?.uid, rejected: Array.isArray(json.data?.erroritem) ? json.data.erroritem : [], requestId };
  }

  /**
   * GET /iys/v1/consents, çoklu sorgu. Kayıtlar `chunkSize`'lık (varsayılan 100, en fazla 1000)
   * isteklere bölünür; sonuçlar gönderilen sırayla döner. Yalnızca `status === 'ONAY'` izin demektir.
   */
  async searchConsents(queries: ConsentQuery[], opts: { chunkSize?: number; refId?: string; path?: IysPath } = {}): Promise<Consent[]> {
    const size = opts.chunkSize ?? 100;
    if (size < 1 || size > 1000) throw new RangeError('chunkSize 1–1000 olmalı');
    queries.forEach((q, i) => assertRecipient(q.recipient, `queries[${i}]`));
    const out: Consent[] = [];
    for (const part of chunk(queries, size)) {
      const qs = new URLSearchParams({ brandCode: String(this.brandCode) });
      if (opts.path) qs.set('path', opts.path);
      if (opts.refId) qs.set('refId', opts.refId);
      part.forEach((q, i) => {
        qs.set(`data[${i}][recipient]`, q.recipient); // URLSearchParams '+' işaretini %2B yapar
        qs.set(`data[${i}][recipientType]`, q.recipientType);
        qs.set(`data[${i}][type]`, q.type);
        if (q.refId) qs.set(`data[${i}][refId]`, q.refId);
      });
      try {
        const { json } = await this.request('GET', `/consents?${qs}`);
        const rows: any[] = Array.isArray(json.data) ? json.data : [];
        // Tek kayıtlı istek tekil sorgu gibi yanıtlanır; kayıt bazlı errorCode olmayabilir.
        out.push(...rows.map(r => ({ ...r, errorCode: typeof r.errorCode === 'number' ? r.errorCode : 0, message: r.message ?? null })));
      } catch (err) {
        // Tekil sorguda "kayıt bulunamadı" isteğin hatası (404 / 81) olarak gelebilir: kayıt bazlı 81'e çevrilir.
        if (part.length === 1 && err instanceof IysApiError && err.errorCode === 81) {
          const q = part[0];
          out.push({ type: q.type, source: null, recipient: q.recipient, status: null, consentDate: null, recipientType: q.recipientType, errorCode: 81, message: null });
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  /** POST /iys/v1/webhooks. Marka için önceki adresin yerine geçer. Canlı hesabın ayarını değiştirir. */
  async saveWebhook(webhookUrl: string, opts: { path?: IysPath; requestId?: string } = {}): Promise<{ uid: string; requestId: string }> {
    const body = { brandCode: this.brandCode, ...(opts.path ? { path: opts.path } : {}), webhookUrl };
    const { json, requestId } = await this.request('POST', '/webhooks', body, opts.requestId);
    return { uid: json.data?.uid, requestId };
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, requestId: string = globalThis.crypto.randomUUID()): Promise<{ json: any; requestId: string }> {
    const operation = `${method} /iys/v1${path.split('?')[0]}`;
    // POST /consents dışındaki istekler tekrar edilebilir: okuma ya da tek adresli ayar (yerine geçer).
    const repeatable = !(method === 'POST' && path === '/consents');
    let reloggedIn = false;
    let retries = 0;

    for (;;) {
      const token = await this.tokens.get();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Request-Id': requestId };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/iys/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (err) {
        // Ağ hatası / zaman aşımı: istek ulaşmış olabilir. Otomatik tekrar yok.
        throw new IysApiError({
          operation, status: 0, errorCode: 'NETWORK', detail: (err as Error).message, threadId: requestId,
          retryable: repeatable, mayHaveBeenProcessed: !repeatable,
        });
      }
      const json = await readJson(res);
      const errorCode: number | string = typeof json.errorCode === 'number' ? json.errorCode : `HTTP_${res.status}`;
      if (res.ok && json.success !== false && (json.errorCode === undefined || json.errorCode === 0)) return { json, requestId };

      const threadId = res.headers.get('X-Thread-Id') ?? requestId;
      const fail = (retryable: boolean, mayHaveBeenProcessed = false) => new IysApiError({
        operation, status: res.status, errorCode, detail: json.message ?? res.statusText, threadId,
        retryable, mayHaveBeenProcessed, data: json.data,
      });

      // 401 (50–53): bir kez yeniden giriş, bir kez tekrar.
      if (res.status === 401) {
        if (reloggedIn) throw fail(false);
        this.tokens.invalidate(token);
        reloggedIn = true;
        continue;
      }

      // 424, 500 ve diğer 5xx (503 hariç): POST /consents'te kayıt işlenmiş olabilir → tekrar YOK.
      const uncertain = res.status === 424 || (res.status >= 500 && res.status !== 503);
      if (uncertain && !repeatable) throw fail(false, true);

      // 429, 503 ve (tekrar edilebilir isteklerde) 424 / 5xx: artan beklemeyle en fazla 3 tekrar.
      if (res.status === 429 || res.status === 503 || uncertain) {
        if (retries >= BACKOFF_SEC.length) throw fail(true);
        const waitSec = parseRetryAfter(res.headers.get('Retry-After'), this.now()) ?? BACKOFF_SEC[retries];
        if (waitSec > this.maxWaitSec) throw fail(true);
        retries++;
        await this.sleep(waitSec * 1000);
        continue;
      }

      // 400, 403, 404, 405, 409, 422: aynı istek aynı sonucu verir.
      throw fail(false);
    }
  }
}
