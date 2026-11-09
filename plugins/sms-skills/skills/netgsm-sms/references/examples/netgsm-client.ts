/**
 * Netgsm SMS API v3 için bağımlılıksız TypeScript istemcisi (Node ≥ 20, global `fetch`).
 *
 * YALNIZCA SUNUCU TARAFINDA kullanın. Kullanıcı adı ve şifre tarayıcıya, mobil uygulamaya ya da
 * istemciye giden bir pakete (ör. `NEXT_PUBLIC_*`) asla konmaz; ortam değişkeninden okunur.
 *
 * Uyguladığı kurallar (bkz. ../auth.md, ../errors.md, ../limits-and-batching.md):
 * - Token önbelleğe alınır; süresinin son min(5 dk, ömrün %10'u) kısmında refresh edilir.
 *   Eş zamanlı çağrılar tek bir token isteğini paylaşır. Başarısız refresh'ten sonra eski token
 *   geçerliyse 30 sn onunla devam edilir.
 * - SMS API `401 UNAUTHENTICATED` → o istekte kullanılan token atılır, yeniden giriş yapılır ve
 *   istek bir kez tekrarlanır.
 * - `429` + `Retry-After` (≤ maxRetryAfterSec) → o kadar beklenir, bir kez tekrarlanır.
 *   `Retry-After` yoksa gönderim askıya alınmıştır: beklemeden hata fırlatılır.
 * - Toplu gönderim uçlarında (`/send`, `/send/template`, `/directory/send`) her 5xx, `503` dahil → tekrar
 *   YOK, `mayHaveBeenQueued: true`. `/send` ve `/send/template`'te 503 sonrası görev çoğunlukla kuyruğa
 *   alınmamıştır ama bu kesin değildir; `/directory/send`'de 503 ve 504 görevin kuyruğa alınmış olabileceğini gösterir.
 *   Aynı isteği tekrar göndermeden önce `GET /report` ile kontrol edin.
 * - `POST /send/otp`: 503 hiçbir şeyin gönderilmediğini gösterir → 1, 2, 4 sn arayla en fazla 3 tekrar.
 *   503 dışındaki 5xx (500, 502) → tekrar YOK, `mayHaveBeenQueued: true` (OTP gönderilmiş olabilir).
 * - Diğer GET olmayan isteklerde 503 → 1, 2, 4 sn arayla en fazla 3 tekrar; diğer 5xx → tekrar YOK,
 *   `mayHaveBeenQueued: true`.
 * - `POST /cancel`'da 5xx (500, 502, 503, 504) tekrar denenir: iptali tekrarlamak her zaman güvenlidir
 *   (errors.md). Tekrardan sonra 404 bekleyen görev kalmadığını (iptal edildi ya da gönderildi) gösterir.
 * - Okuma (GET) isteklerinde 5xx, 503 gibi tekrar denenir; ama görev bazlı sayacı olan okumalarda
 *   (`/stats`, jobIds'li `/report`) tekrar YOK: hatayla biten okuma da sayaca sayılır, hemen tekrar
 *   429 alır. Hata `retryable: true` döner; görev penceresi dolunca (report 1 dk, stats 10 dk) deneyin.
 * - Okunamayan `Retry-After` (sayı ya da HTTP tarihi değil) → tekrar yok, `retryable: true`.
 * - Ağ hatası, zaman aşımı ya da iptal (`fetch` reddedildi; `status: 0`, `code: 'NETWORK_ERROR'`) → tekrar YOK.
 *   Yanıt alınamadı ama istek ulaşmış olabilir: GET olmayan isteklerde (iptal hariç; gönderim, OTP, şablon ve
 *   rehber gönderimi dahil) 5xx gibi `mayHaveBeenQueued: true`, `retryable: false`. Okuma ve iptalde `retryable: true`.
 *   `2xx` yanıtın gövdesi okunamazsa (`code: 'INVALID_RESPONSE'`) tekrar yok; gönderim kabul edilmiş olabilir.
 * - `400`, `403`, `413`, `422` ve diğer 4xx → tekrar yok, `retryable: false`.
 * - `202` yanıtındaki `rejectedItems` olduğu gibi döner; çağıran işler.
 * - `GET /balance` (`getBalance`): `429`'da beklemez ve tekrar etmez; `retryable: true` ve `retryAfterSec`
 *   ile hata fırlatır, ne zaman deneneceğine çağıran karar verir. Bakiye büyük bir kampanyadan önce bir
 *   kez okunur; her mesajdan önce okunmaz, döngüde sorgulanmaz (hesap başına dakikada 60 istek). Yanıt
 *   10 sn önbellektedir: gönderimden hemen sonra okunan değer en fazla 10 sn eski olabilir. Varlık listesi
 *   sabit değildir: kayıtlar sıraya göre değil `balance_name` ile, büyük/küçük harfe duyarsız bulunur (`findBalance`), kredi metni
 *   `parseCredit` ile sayıya çevrilir.
 * - Rapor webhook'unun gövdesi sayısal kodlar taşır (`status`, `operator`, `errorCode`); `webhookToReport`
 *   bunları `GET /report`'taki adlara çevirir.
 * - Her hata `requestId` (SMS) / `request_id` (Identity) taşır; mesajda da yazar. Şifre ve token
 *   hiçbir hata mesajına girmez.
 */

export interface NetgsmClientOptions {
  /** Netgsm abone numarası. */
  username: string;
  /** API alt kullanıcısının şifresi. */
  password: string;
  /**
   * ZORUNLU, varsayılanı yoktur. Canlı: 'https://ext-api.netgsm.com.tr', mock: 'http://127.0.0.1:4010'.
   * Ortam değişkeninden okuyun (ör. NETGSM_BASE_URL); canlıya geçişte yalnızca bu adres ve kimlik değişir.
   */
  baseUrl: string;
  /** Varsayılan 'sms'. */
  scope?: string;
  /**
   * Hesapta kurumsal OTP hizmeti tanımlıysa true: `POST /send/otp` isteklerine `x-client: enterprise`
   * başlığı eklenir. Diğer hesaplarda false (varsayılan) kalmalıdır; uyuşmazlık iki yönde de 403 FORBIDDEN.
   */
  enterpriseOtp?: boolean;
  /** Bundan uzun Retry-After beklenmez, hata fırlatılır (retryable: true). Varsayılan 60. */
  maxRetryAfterSec?: number;
  /** Testte ya da proxy arkasında başka bir fetch vermek için. */
  fetch?: typeof fetch;
  /** Saat (ms). Testte sahte saat vermek için. */
  now?: () => number;
}

// --- Tipler (openapi.yaml şemalarından, yalnızca kullanılan alanlar) ------------------------------

export type Encoding = 'DEFAULT' | 'TURKISH' | 'UNICODE';
export type IysFilter = 'NONE' | 'BRAND' | 'RETAILER' | 'BRAND_AND_RETAILER';

export interface SmsMessage {
  text: string;
  /** Türkiye: '90' + 10 rakam (905xxxxxxxxx). Yurt dışı: '-' + ülke koduyla 9–17 rakam. */
  recipient: string;
}

export interface SmsSendRequest {
  sender: string;
  /** Bütün alıcılar tek istekte (1–1.000.000 kayıt). */
  messages: SmsMessage[];
  encoding?: Encoding;
  iysFilter?: IysFilter;
  startAt?: string;
  stopAt?: string;
  partnerCode?: string;
  referenceId?: string;
  appName?: string;
}

export interface RejectedItem {
  index: number;
  recipient: string;
  reason: string;
}

export interface SmsSendResponse {
  jobId: string;
  status: 'SCHEDULED' | 'QUEUED';
  accepted: number;
  rejected: number;
  rejectedItems: RejectedItem[];
  rejectedItemsTruncated: boolean;
  referenceId: string | null;
}

export interface OtpSendRequest {
  /** Kayıtlı başlık ya da abone numarası; büyük/küçük harf fark etmez. */
  sender: string;
  /** Kırpılır ve ASCII'ye çevrilir (Türkçe harf → Latin, desteklenmeyen → '?'); çevrilmiş metin en fazla 155 (abone numarasında 160). */
  text: string;
  /** Türkiye cep numarası: '5XXXXXXXXX', '05XXXXXXXXX' ya da '905XXXXXXXXX'; başına '+' eklenebilir. Boşluk ya da yurt dışı numarası olmaz. */
  recipient: string;
  appName?: string;
}

export interface OtpSendResponse {
  jobId: string;
}

export interface ReportRow {
  jobId: string;
  number: string;
  status: 'PENDING' | 'DELIVERED' | 'NOT_DELIVERED' | null;
  operator: string | null;
  messageLength: number;
  deliveredAt: string | null;
  failReason: string | null;
  referenceId: string | null;
}

export interface ReportResponse {
  count: number;
  page: number;
  reports: ReportRow[];
}

/** `GET /balance` varlık kaydı. `amount`: tek kayıt metin (`"767"`), toplanmış kayıtlar sayı (`277`). */
export interface BalanceEntry {
  amount: string | number;
  /** Örn. `Adet SMS`, `Adet OTP SMS`, `Dakika`, `Kredi Bakiye`. Liste hesaba göre değişir. */
  balance_name: string;
}

/** `stip` 1 ve 3. `stip=3` sona her zaman `Kredi Bakiye` kaydını (TL, `"92,150"`) ekler. */
export interface BalanceListResponse {
  balance: BalanceEntry[];
}

/** `stip=2` özeti. `balance`: faturasızda kredi (`"92,150"`) ya da SMS adedi (`type: 'AdetSMS'`); faturalıda `"0"`; ikisi de yoksa alan yok. */
export interface BalanceSummaryResponse {
  code: '00';
  balance?: string;
  type?: 'AdetSMS';
}

export type BalanceService =
  'sms' | 'otp' | 'ses' | 'fax' | 'whatsapp' | 'santral' | 'netsipp' | 'gsm' | 'internet' | 'numara' | 'ai' | 'ucret';

/** Rapor webhook'unun bir kaydı. Bekleyen gönderimler webhook ile gelmez. */
export interface ReportWebhookEntry {
  jobid: string;
  number: string;
  /** 1 iletildi; 2 iletilmedi (nedeni `errorCode`); 3, 4, 8, 11–20, 22 nedeni kendisi söyler. */
  status: number;
  /** 10 Vodafone, 20 Türk Telekom, 30 Turkcell, 40/41/43 Netgsm, 45 Akontel, 210–218 yurt dışı, 0 bilinmiyor. */
  operator: number;
  msglen: number;
  /** `yyyy-MM-dd HH:mm:ss`, Türkiye saati; yoksa `""`. */
  deliveredDate: string;
  /** Yalnızca `status` 2 iken anlamlıdır (111–117, 119); 0 ya da null: neden bilinmiyor. */
  errorCode: number | null;
  /** Gönderimdeki `referenceId`; verilmediyse null. */
  referansID: string | null;
}

export interface ReportWebhookPayload {
  numbers: ReportWebhookEntry[];
}

// --- Bakiye ve webhook yardımcıları (saf fonksiyonlar) -------------------------------------------

/**
 * `Kredi Bakiye` / `stip=2` metnini TL sayıya çevirir: `"92,150"` → 92.15, `"0"` → 0, `277` → 277.
 * Okunamayan değerde null döner, hiç hata fırlatmaz.
 */
export function parseCredit(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!/^-?\d+(?:[.,]\d+)?$/.test(t)) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Varlığı adıyla bulur (sıraya güvenilmez; ad büyük/küçük harfe duyarsız); `amount` sayıya çevrilir. Yoksa null. */
export function findBalance(list: BalanceEntry[], name: string): number | null {
  const want = name.trim().toLocaleLowerCase('tr');
  const entry = list.find(e => String(e.balance_name).trim().toLocaleLowerCase('tr') === want);
  return entry ? parseCredit(entry.amount) : null;
}

/** Webhook `status` → `GET /report` `failReason` (kendi nedeni olan kodlar). */
export const WEBHOOK_STATUS_REASON: Readonly<Record<number, string>> = {
  3: 'INVALID_NUMBER', 4: 'NOT_SENT_TO_OPERATOR', 8: 'OPERATOR_REJECTED', 11: 'OPERATOR_ERROR', 12: 'SEND_ERROR',
  13: 'DUPLICATE', 14: 'INSUFFICIENT_CREDIT', 15: 'BLACKLISTED', 16: 'IYS_REJECTED', 17: 'IYS_ERROR',
  18: 'MESSAGE_NOT_CREATED', 19: 'INVALID_NUMBER_FORMAT', 20: 'NTS_NOT_APPROVED', 22: 'NO_INTERNATIONAL_PERMISSION',
};

/** Webhook `errorCode` (`status` 2 iken) → `GET /report` `failReason`. */
export const WEBHOOK_ERROR_REASON: Readonly<Record<number, string>> = {
  111: 'TIMEOUT', 112: 'SMS_DISABLED_ON_DEVICE', 113: 'DEVICE_NOT_SUPPORTED', 114: 'ROUTING_FAILED',
  115: 'OPERATOR_TIMEOUT', 116: 'UNKNOWN_SUBSCRIBER', 117: 'ILLEGAL_SUBSCRIBER', 119: 'SYSTEM_ERROR',
};

/** Webhook `operator` kodu → `GET /report` `operator` adı. */
export function webhookOperator(code: number): string {
  if (code === 10) return 'VODAFONE';
  if (code === 20) return 'TURK_TELEKOM';
  if (code === 30) return 'TURKCELL';
  if (code === 40 || code === 41 || code === 43) return 'NETGSM';
  if (code === 45) return 'AKONTEL';
  if (code >= 210 && code <= 218) return 'INTERNATIONAL';
  return 'UNKNOWN';
}

/**
 * Webhook kaydının kodlarını `GET /report` adlarına çevirir. `errorCode` yalnızca `status` 2 iken okunur.
 * Tabloda olmayan bir `status` `NOT_DELIVERED` + `UNKNOWN` sayılır.
 */
export function webhookToReport(e: Pick<ReportWebhookEntry, 'status' | 'operator' | 'errorCode'>):
  { status: 'DELIVERED' | 'NOT_DELIVERED'; failReason: string | null; operator: string } {
  const operator = webhookOperator(e.operator);
  if (e.status === 1) return { status: 'DELIVERED', failReason: null, operator };
  const failReason = e.status === 2
    ? WEBHOOK_ERROR_REASON[e.errorCode ?? 0] ?? 'UNKNOWN'
    : WEBHOOK_STATUS_REASON[e.status] ?? 'UNKNOWN';
  return { status: 'NOT_DELIVERED', failReason, operator };
}

// --- Hata ----------------------------------------------------------------------------------------

export class NetgsmApiError extends Error {
  /** HTTP durum kodu; yanıt alınamadıysa (ağ hatası, zaman aşımı, iptal) 0. */
  readonly status: number;
  /**
   * SMS API `code` (ör. REJECTED_HEADER) ya da Identity `code` (ör. invalid_credentials). Mantık buna göre kurulur.
   * İstemcinin kendi kodları: `NETWORK_ERROR` (yanıt alınamadı), `INVALID_RESPONSE` (2xx gövdesi okunamadı).
   */
  readonly code: string;
  /** SMS `requestId` ya da Identity `request_id`. Loglayın; destek talebinde paylaşın. */
  readonly requestId: string | null;
  /** 429/503 yanıtındaki Retry-After (sn); yoksa null. */
  readonly retryAfterSec: number | null;
  /** true: aynı istek daha sonra değiştirilmeden tekrar denenebilir. */
  readonly retryable: boolean;
  /** true: toplu gönderimde (/send, /send/template, /directory/send) herhangi bir 5xx, diğer GET olmayan isteklerde (iptal hariç) 503 dışında bir 5xx ya da bu isteklerde yanıtın alınamaması (NETWORK_ERROR, INVALID_RESPONSE). İşlem yapılmış olabilir; körlemesine tekrar göndermeyin, önce GET /report. */
  readonly mayHaveBeenQueued: boolean;
  /** Yalnızca 422 NO_DELIVERABLE_MESSAGES'ta: kayıtların red nedenleri. */
  readonly rejectedItems?: RejectedItem[];

  constructor(init: {
    status: number; code: string; detail: string; requestId: string | null; retryAfterSec?: number | null;
    retryable: boolean; mayHaveBeenQueued?: boolean; rejectedItems?: RejectedItem[]; operation: string;
  }) {
    super(`${init.operation} → ${init.status} ${init.code}: ${init.detail} (requestId ${init.requestId ?? '-'})`);
    this.name = 'NetgsmApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterSec = init.retryAfterSec ?? null;
    this.retryable = init.retryable;
    this.mayHaveBeenQueued = init.mayHaveBeenQueued ?? false;
    if (init.rejectedItems) this.rejectedItems = init.rejectedItems;
  }
}

// --- Yardımcılar ---------------------------------------------------------------------------------

const UNAVAILABLE_BACKOFF_SEC = [1, 2, 4];
const REFRESH_BACKOFF_MS = 30_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Bekleme sonuna eklenen küçük rastgele pay: aynı anda bekleyen süreçler aynı anda dönmez. */
const jitterMs = () => Math.floor(Math.random() * 250);

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const sec = Number(value);
  if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Toplu gönderim uçları: 503 dahil her 5xx'te görev kuyruğa alınmış olabilir (errors.md "503 ve 504 sonrası kontrol"). */
function isBatchSend(method: string, path: string): boolean {
  const p = path.split('?')[0];
  return method === 'POST' && (p === '/send' || p === '/send/template' || p === '/directory/send');
}

/** Tekrarı yeni bir işlem yapmayan GET olmayan istekler: iptal (tekrarı SMS göndermez). */
function isSafeToRepeat(method: string, path: string): boolean {
  return method === 'POST' && path.split('?')[0] === '/cancel';
}

/** Hatayla biten okuması da görev sayacına sayılan sorgular: /stats ve jobIds verilmiş /report. */
function hasPerJobLimit(path: string): boolean {
  const [p, qs = ''] = path.split('?');
  if (p === '/stats') return true;
  if (p !== '/report') return false;
  const q = new URLSearchParams(qs);
  return q.has('jobIds');
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text().catch(() => ''); // gövde okunurken bağlantı kopabilir
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/** `fetch`'in fırlattığı hata (ağ hatası, zaman aşımı, iptal) için kısa açıklama; URL ve gövde yazılmaz. */
function networkDetail(err: unknown): string {
  return `ağ hatası, zaman aşımı ya da iptal (${err instanceof Error ? err.name : 'Error'}): yanıt alınamadı`;
}

// --- Token yöneticisi (references/auth.md "Önerilen istemci deseni" ile aynı davranış) -----------

type Tokens = { access: string; refresh: string; expiresAt: number; marginMs: number };
type TokenResponse = { access_token: string; refresh_token: string; expires_in: number };

export class NetgsmTokenManager {
  private tokens?: Tokens;
  private inflight?: Promise<string>;
  private retryAfterMs = 0; // başarısız yenilemeden sonra kısa bekleme
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly scope: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: { baseUrl: string; username: string; password: string; scope: string; fetch: typeof fetch; now: () => number }) {
    this.baseUrl = opts.baseUrl;
    this.username = opts.username;
    this.password = opts.password;
    this.scope = opts.scope;
    this.fetchImpl = opts.fetch;
    this.now = opts.now;
  }

  /** Geçerli access token; süresinin son min(5 dk, ömrün %10'u) kısmına girildiyse önce yeniler. */
  async get(): Promise<string> {
    const t = this.tokens;
    const now = this.now();
    if (t && (now < t.expiresAt - t.marginMs || now < this.retryAfterMs) && now < t.expiresAt) {
      return t.access;
    }
    // Aynı anda gelen çağrılar tek bir yenilemeyi bekler.
    this.inflight ??= this.renew().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  /**
   * SMS API 401 UNAUTHENTICATED döndüğünde, o istekte kullanılan token ile çağrılır. Başka bir çağrı
   * token'ı zaten yenilediyse yeni token silinmez; aksi halde sonraki get() yeniden giriş yapar.
   */
  invalidate(staleAccessToken: string): void {
    if (this.tokens?.access === staleAccessToken) this.tokens = undefined;
  }

  private async renew(): Promise<string> {
    const old = this.tokens;
    if (old) {
      let r: Response | undefined;
      let networkError: NetgsmApiError | undefined;
      try {
        r = await this.post('/auth/v3/token/refresh', { refresh_token: old.refresh });
      } catch (err) {
        if (!(err instanceof NetgsmApiError)) throw err;
        networkError = err; // ağ hatası: geçici hata gibi
      }
      if (r?.ok) return this.store(await r.json());
      const p: any = r ? await readJson(r) : {};
      // Refresh beklenirken invalidate() token'ı silmiş olabilir; o zaman eski token kullanılmaz.
      const invalidated = this.tokens !== old;
      if (p.code !== 'invalid_refresh_token' && !invalidated) {
        // Geçici hata (ağ, 429, 5xx): eski token hâlâ geçerliyse onu kullan ve 30 sn sonra yeniden dene.
        if (this.now() < old.expiresAt) {
          this.retryAfterMs = this.now() + REFRESH_BACKOFF_MS;
          return old.access;
        }
        throw r ? this.identityError('POST /auth/v3/token/refresh', r, p) : networkError;
      }
      if (!r) throw networkError; // token geçersiz kılınmış ve refresh yanıtı yok
      this.tokens = undefined; // oturum bitmiş ya da token geçersiz kılınmış: yeniden giriş
    }
    const r = await this.post('/auth/v3/token', { username: this.username, password: this.password, scope: this.scope });
    if (!r.ok) throw this.identityError('POST /auth/v3/token', r, await readJson(r));
    return this.store(await r.json());
  }

  private store(t: TokenResponse): string {
    const lifeMs = t.expires_in * 1000;
    this.tokens = {
      access: t.access_token,
      refresh: t.refresh_token,
      expiresAt: this.now() + lifeMs,
      marginMs: Math.min(5 * 60_000, lifeMs / 10), // kısa ömürlü token'da (ör. mock --token-ttl 60) da çalışır
    };
    this.retryAfterMs = 0;
    return t.access_token;
  }

  private identityError(operation: string, r: Response, p: any): NetgsmApiError {
    const code = typeof p.code === 'string' ? p.code : `HTTP_${r.status}`;
    return new NetgsmApiError({
      operation,
      status: r.status,
      code,
      detail: p.detail ?? p.error_description ?? r.statusText,
      requestId: p.request_id ?? r.headers.get('X-Thread-Id'),
      retryAfterSec: parseRetryAfter(r.headers.get('Retry-After'), this.now()),
      // rate_limited ve 5xx sonra tekrar denenebilir; too_many_failed_attempts ve diğer 4xx için önce düzeltme gerekir.
      retryable: r.status >= 500 || code === 'rate_limited',
    });
  }

  private async post(path: string, body: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Token isteğinin yanıtı alınamadı. SMS isteği henüz gönderilmedi: daha sonra tekrar denemek güvenlidir.
      throw new NetgsmApiError({
        operation: `POST ${path}`, status: 0, code: 'NETWORK_ERROR', detail: networkDetail(err), requestId: null, retryable: true,
      });
    }
  }
}

// --- SMS istemcisi -------------------------------------------------------------------------------

export class NetgsmClient {
  private readonly baseUrl: string;
  private readonly maxRetryAfterSec: number;
  private readonly enterpriseOtp: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly tokens: NetgsmTokenManager;

  constructor(opts: NetgsmClientOptions) {
    if (!opts.username || !opts.password) throw new Error('Netgsm kullanıcı adı ve şifresi gerekli (ortam değişkenlerinden okuyun)');
    if (typeof opts.baseUrl !== 'string' || opts.baseUrl.trim() === '') {
      throw new Error("Netgsm baseUrl gerekli: canlı için 'https://ext-api.netgsm.com.tr', mock için 'http://127.0.0.1:4010' (ortam değişkeninden okuyun)");
    }
    this.baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    this.maxRetryAfterSec = opts.maxRetryAfterSec ?? 60;
    this.enterpriseOtp = opts.enterpriseOtp ?? false;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.tokens = new NetgsmTokenManager({
      baseUrl: this.baseUrl, username: opts.username, password: opts.password, scope: opts.scope ?? 'sms',
      fetch: this.fetchImpl, now: this.now,
    });
  }

  /** POST /sms/v3/send. Bütün alıcıları tek istekte gönderin; dönen rejectedItems'ı işleyin. */
  send(req: SmsSendRequest): Promise<SmsSendResponse> {
    return this.request<SmsSendResponse>('POST', '/send', req);
  }

  /** POST /sms/v3/send/otp. Tek alıcı, tek mesaj. 503 güvenle tekrarlanır; 500'de tekrar göndermek iki farklı şifre demek olabilir. */
  sendOtp(req: OtpSendRequest): Promise<OtpSendResponse> {
    return this.request<OtpSendResponse>('POST', '/send/otp', req, this.enterpriseOtp ? { 'x-client': 'enterprise' } : undefined);
  }

  /** GET /sms/v3/report. Aynı jobId dakikada bir sorulabilir; sürekli takip için rapor webhook'u kullanın. */
  report(query: Record<string, string>): Promise<ReportResponse> {
    const qs = new URLSearchParams(query).toString();
    return this.request<ReportResponse>('GET', qs ? `/report?${qs}` : '/report');
  }

  /**
   * GET /sms/v3/balance. `stip` 1 (varsayılan): varlıklar; 2: tek satır özet; 3: varlıklar ve kredi.
   * `service` listeyi bir hizmet grubuyla sınırlar (büyük/küçük harf fark etmez; geçersiz değer 400).
   * Büyük bir kampanyadan önce bir kez okuyun; döngüde ya da her mesajdan önce sorgulamayın.
   * 429'da beklemez: `retryable: true` ve `retryAfterSec` ile hata fırlatır.
   */
  getBalance(opts: { stip: 2; service?: BalanceService | string }): Promise<BalanceSummaryResponse>;
  getBalance(opts?: { stip?: 1 | 3; service?: BalanceService | string }): Promise<BalanceListResponse>;
  getBalance(opts: { stip?: 1 | 2 | 3; service?: BalanceService | string } = {}): Promise<BalanceListResponse | BalanceSummaryResponse> {
    const q = new URLSearchParams();
    if (opts.stip !== undefined) q.set('stip', String(opts.stip));
    if (opts.service !== undefined) q.set('service', opts.service);
    const qs = q.toString();
    return this.request('GET', qs ? `/balance?${qs}` : '/balance');
  }

  /** Diğer uç noktalar için: `path` /sms/v3'e göredir (ör. '/senders', '/stats?jobId=…&month=2026-09'). */
  async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const operation = `${method} /sms/v3${path.split('?')[0]}`;
    const isRead = method === 'GET';
    const repeatable = isRead || isSafeToRepeat(method, path);
    let reloggedIn = false;
    let rateLimitRetried = false;
    let unavailableRetries = 0;

    for (;;) {
      const token = await this.tokens.get();
      const headers: Record<string, string> = { ...extraHeaders, Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      // Yanıt alınamadıysa: okuma ve iptalde tekrar denenebilir; gönderimde (ve diğer GET olmayan isteklerde)
      // istek işlenmiş olabilir, 5xx gibi körlemesine tekrar YOK, önce GET /report.
      const uncertainHint = repeatable ? '' : '; istek işlenmiş olabilir: yeniden göndermeden önce GET /report ile kontrol edin';
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/sms/v3${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        // Ağ hatası / zaman aşımı / iptal. Bu döngü hiçbir istekte bunu tekrar etmez.
        throw new NetgsmApiError({
          operation, status: 0, code: 'NETWORK_ERROR', detail: networkDetail(err) + uncertainHint, requestId: null,
          retryable: repeatable, mayHaveBeenQueued: !repeatable,
        });
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text().catch(() => '');
        try { return JSON.parse(text) as T; } catch { /* aşağıda INVALID_RESPONSE */ }
        // 2xx alındı ama gövde okunamadı: gönderim kabul edilmiş olabilir, jobId bilinmiyor. Tekrar YOK.
        throw new NetgsmApiError({
          operation, status: res.status, code: 'INVALID_RESPONSE', detail: 'yanıt gövdesi okunamadı' + uncertainHint,
          requestId: res.headers.get('X-Request-Id'), retryable: false, mayHaveBeenQueued: !repeatable,
        });
      }

      const p = await readJson(res);
      const code: string = typeof p.code === 'string' ? p.code : `HTTP_${res.status}`;
      const rawRetryAfter = res.headers.get('Retry-After');
      const retryAfterSec = parseRetryAfter(rawRetryAfter, this.now());
      const fail = (retryable: boolean, mayHaveBeenQueued = false, hint = '') => new NetgsmApiError({
        operation, status: res.status, code, detail: (p.message ?? res.statusText) + hint,
        requestId: p.requestId ?? res.headers.get('X-Request-Id'), retryAfterSec, retryable, mayHaveBeenQueued,
        rejectedItems: Array.isArray(p.rejectedItems) ? p.rejectedItems : undefined,
      });

      // 401: token geçersiz (süresi doldu, yenilendi, oturum düştü). Bir kez yeniden giriş, bir kez tekrar.
      if (res.status === 401 && code === 'UNAUTHENTICATED' && !reloggedIn) {
        this.tokens.invalidate(token);
        reloggedIn = true;
        continue;
      }

      // 429: Retry-After yoksa gönderim askıya alınmıştır; beklemek işe yaramaz.
      if (res.status === 429) {
        if (rawRetryAfter === null) throw fail(false);
        // Bakiye sorgusu beklenmez ve tekrarlanmaz: çağıran Retry-After'a göre karar verir (döngü yok).
        if (path.split('?')[0] === '/balance') throw fail(true);
        // Okunamayan Retry-After: hemen tekrar denenmez, çağıran daha sonra dener.
        if (retryAfterSec === null || rateLimitRetried || retryAfterSec > this.maxRetryAfterSec) throw fail(true);
        rateLimitRetried = true;
        await sleep(retryAfterSec * 1000 + jitterMs());
        continue;
      }

      // Toplu gönderimde her 5xx, 503 dahil: görev kuyruğa alınmış olabilir. Tekrar YOK; önce GET /report.
      if (isBatchSend(method, path) && res.status >= 500) {
        throw fail(false, true, '; görev kuyruğa alınmış olabilir: yeniden göndermeden önce GET /report ile kontrol edin');
      }

      // Diğer GET olmayan isteklerde 503 dışındaki 5xx (500, 502, 504): işlem yapılmış olabilir.
      // Tekrar YOK. Çağıran önce GET /report ile kontrol eder; belirsizse requestId ile teknik destek.
      // İptal hariç: iptali tekrarlamak SMS göndermez, aşağıda okuma gibi tekrar denenir.
      if (!repeatable && res.status >= 500 && res.status !== 503) throw fail(false, true);

      // Görev bazlı sayacı olan okumalar (/stats, jobIds'li /report): hatayla biten okuma da sayaca
      // sayılır; hemen tekrar etmek 429 (stats'ta ~10 dk) demektir. Otomatik tekrar YOK.
      if (res.status >= 500 && hasPerJobLimit(path)) {
        throw fail(true, false, '; bu sorgu görev başına sınırlıdır (report 1 dk, stats 10 dk): o süre dolunca tekrar deneyin');
      }

      // 503 (OTP, okuma ve ayar istekleri; okuma ya da iptal isteklerinde diğer 5xx da): artan beklemeyle tekrar.
      if (res.status === 503 || (repeatable && res.status >= 500)) {
        if (unavailableRetries >= UNAVAILABLE_BACKOFF_SEC.length) throw fail(true);
        const waitSec = retryAfterSec ?? UNAVAILABLE_BACKOFF_SEC[unavailableRetries];
        if (waitSec > this.maxRetryAfterSec) throw fail(true);
        unavailableRetries++;
        await sleep(waitSec * 1000 + jitterMs());
        continue;
      }

      // 400, 403, 404, 409, 413, 422 ...: aynı istek aynı sonucu verir. İstek ya da hesap düzeltilir.
      throw fail(false);
    }
  }
}
