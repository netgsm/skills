# Kimlik doğrulama (Identity API)

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/auth/token/ · https://api-docs.netgsm.com.tr/auth/refresh-token/ · sandbox:
https://api-docs.netgsm.com.tr/sandbox/sms-api-v-3-sandbox/

SMS API v3'ün her isteği bir Bearer access token ister. Token, Identity API'den kullanıcı adı ve şifreyle
alınır.

- Canlı: `https://ext-api.netgsm.com.tr/auth/v3`. Yalnızca HTTPS kabul edilir; düz HTTP isteği
  `403 https_required` alır.
- Sandbox: `https://ext-sandbox.netgsm.com.tr/auth/v3` (yalnızca demo hesaplar, bkz. [sandbox.md](sandbox.md)).
- Mock: `http://127.0.0.1:4010/auth/v3` (yerelde HTTP).
- Sözleşmenin tamamı: [identity-openapi.json](identity-openapi.json). Hata kodlarının tamamı ve
  yapılacaklar: [errors.md](errors.md).

## Uç noktalar

| Metot | Yol | Yetki | Görevi | Başarılı yanıt |
|---|---|---|---|---|
| POST | `/auth/v3/token` | — | `username`, `password` ve `scope` doğrulanır; access ve refresh token döner | `200` |
| POST | `/auth/v3/token/refresh` | — | Refresh token ile yeni token çifti üretir | `200` |
| POST | `/auth/v3/token/revoke` | Bearer | Token'ın ait olduğu oturumu sonlandırır | `204` (gövde yok) |
| GET | `/auth/v3/me` | Bearer | Giriş yapan hesabın bilgilerini döner | `200` |

- İstek gövdesi `application/json` ya da `application/x-www-form-urlencoded` olabilir.
- `username`, `password` ve `refresh_token` yalnızca gövdede gönderilir. Query string'de gönderilirse
  istek `422` ile reddedilir.
- Token ve hesap bilgisi içeren yanıtlar `Cache-Control: no-store` ve `Pragma: no-cache` taşır.

## Token alma

```http
POST /auth/v3/token
Content-Type: application/json

{ "username": "312XXXXXXX", "password": "XXXXXXX", "scope": "sms" }
```

Aynı istek form olarak:

```bash
curl -s https://ext-api.netgsm.com.tr/auth/v3/token \
  -d 'username=312XXXXXXX' -d 'password=XXXXXXX' -d 'scope=sms'
```

| Alan | Zorunlu | Açıklama |
|---|---|---|
| `username` | evet | Netgsm abone numarası (en fazla 255 karakter) |
| `password` | evet | Giriş yapan kimliğin şifresi; tercihen API alt kullanıcısının (en fazla 255 karakter) |
| `scope` | evet | İstenen kapsam; SMS entegrasyonu için `sms` (aşağıya bakın) |

Yanıt (`200`):

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiJ9...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "a170696c-8c1f-4eb5-81bd-391e29fbebc4",
  "scope": "sms",
  "user_id": 100001,
  "sub_user_id": 2
}
```

| Alan | Açıklama |
|---|---|
| `access_token` | JWT. SMS isteklerinde `Authorization: Bearer <access_token>` olarak gönderilir. |
| `token_type` | Her zaman `Bearer`. |
| `expires_in` | Access token'ın geçerlilik süresi, saniye. Canlıda 86400 (24 saat). Kodda sabit yazılmaz, yanıttan okunur. |
| `refresh_token` | Token yenilemek için kullanılır (UUID). |
| `scope` | Verilen kapsam. |
| `user_id` | Hesap kimliği. |
| `sub_user_id` | Alt kullanıcı kimliği; ana hesapla girişte `0`. |

## Token'ı kullanma

Her SMS API isteğine `Authorization: Bearer <access_token>` eklenir. SMS API token'ı her şeyden önce
kontrol eder. Token yoksa ya da geçersizse istek ne olursa olsun `401 UNAUTHENTICATED` döner;
`message` `no bearer token` ya da `invalid or expired token` olur.

## Token yenileme

```http
POST /auth/v3/token/refresh
Content-Type: application/json

{ "refresh_token": "a170696c-8c1f-4eb5-81bd-391e29fbebc4" }
```

Yanıt, token alma yanıtıyla aynıdır.

- Yanıttaki **yeni** `access_token` ve `refresh_token` saklanır. `refresh_token` değeri aynı kalabilir,
  ama her zaman yanıttaki değer saklanmalıdır.
- Yenilemeden sonra **hemen yeni access token'a geçilir**: oturum başına tek geçerli access token vardır
  ve önceki token artık kullanılmaz.
- Önceki token'ın ne zaman reddedileceği kesin değildir. Gözlenen davranış: yenilemeden hemen önce
  kullanılmış eski access token SMS API'de kısa bir süre (gözlemlerde yaklaşık bir dakikadan kısa) daha
  kabul edilebilir; hiç kullanılmamış eski token ise hemen `401 UNAUTHENTICATED` alır. Bu bir sözleşme
  değildir: istemci ne eski token'ın hemen reddedileceğine ne de bir süre daha çalışacağına güvenir. Eski
  token'la yola çıkmış bir istek `401` alırsa yeni token'la bir kez tekrarlanır
  ([önerilen istemci deseni](#önerilen-istemci-deseni)).
- Yenilemede kapsam değişmez.
- Süresi dolmuş ya da sonlandırılmış bir oturumun refresh token'ı `401 invalid_refresh_token` alır.
  UUID olmayan bir değer de aynı hatayı alır. Bu durumda `POST /auth/v3/token` ile yeniden giriş yapılır.

## Oturumu sonlandırma

```http
POST /auth/v3/token/revoke
Authorization: Bearer <access_token>
```

Gövde gerekmez, yanıt `204` ve gövdesizdir. Oturumun access token'ı ve refresh token'ı geçersiz olur.
Uygulama bir oturumu kalıcı olarak bıraktığında (örneğin kapanırken ya da kimlik bilgisi değiştiğinde)
çağrılabilir. Zaten sonlandırılmış bir oturumun token'ı `401 invalid_token` alır.

## Hesap bilgisi (`/me`)

```http
GET /auth/v3/me
Authorization: Bearer <access_token>
```

Dönen alanlar token'ın kapsamına bağlıdır; `user_id` her zaman döner. `scope: "sms"` ile API alt
kullanıcısı girişinde örnek yanıt:

```json
{
  "user_id": 100001,
  "username": "100001",
  "user_code": "3120000000",
  "contract_accepted": true,
  "sub_user_id": 2,
  "sub_user": { "id": 2, "first_name": "Ad", "last_name": "Soyad" }
}
```

`sub_user_id` `0` ve `sub_user` `null` ise giriş ana hesapla yapılmıştır. `/me` yanıtı token ve istemci
IP'si başına kısa süre (varsayılan 30 sn) önbellekte tutulur: revoke edilen token hemen geçersiz görünür,
ama refresh sonrası eski access token bu süre boyunca `/me`'de geçerli görünebilir. SMS API'deki
davranış için [token yenileme](#token-yenileme).

## Scope

**Her SMS entegrasyonunda `scope: "sms"` kullanın.** SMS API sözleşmesi de token'ı `scope` olarak
`sms` göndererek almanızı ister.

Gerekçe: Scope yalnızca girişte kontrol edilir. SMS API v3 ise her istekte hesabın SMS gönderim ya da
alım hizmetinin açık olduğunu, alt kullanıcının SMS yetkisi olduğunu ve gönderimde hedef operatöre
hizmet verilebildiğini ayrıca kontrol eder; sağlanmazsa `403 FORBIDDEN` döner. Bu yüzden daha dar bir
scope (`sms:send` gibi) SMS API'de ek bir koruma sağlamaz. Yanlış seçilen bir scope ise girişi
bozabilir: hesapta açık olmayan bir hizmeti isteyen scope `403 service_not_activated`, alt kullanıcının
yetkisi olmayan bir hizmeti isteyen scope `403 sub_user_not_permitted` alır (`denied_scopes` alanı
ilgili scope'ları listeler).

SMS ile ilgili scope'lar:

| scope | Kapsam |
|---|---|
| `sms` | SMS hizmeti (gönderim ya da alım; GSM hariç) |
| `sms:send` | SMS gönderimi |
| `sms:receive` | Gelen SMS |
| `sms:send:gsm` | GSM SMS gönderimi |
| `sms:receive:gsm` | GSM gelen SMS |

- Alt kapsamlar (`hizmet:işlem`) hizmetin yalnızca o işlemini kapsar.
- GSM hizmetleri ayrıdır (`hizmet:işlem:gsm`); `sms` GSM'i kapsamaz.
- Hizmet kapsamı (`sms`) aynı hizmetin bir alt kapsamıyla birlikte istenirse yok sayılır; token alt
  kapsamla verilir ve yanıttaki `scope` bunu gösterir.
- Birden fazla kapsam boşlukla ayrılarak istenebilir. Diğer kabul edilen değerler (`profile`,
  `contact`, `email`, `voice`, `fax` vb.) [identity-openapi.json](identity-openapi.json)'da listelenir.
  `/me`'den belirli bir alana ihtiyaç varsa tek kapsam istenir: 2–4 kapsamda `/me` yalnızca
  kapsamlardan birinin alanlarını döner.
- Boş ya da tanınmayan bir kapsam `422 validation_failed` alır; `errors.scope` izin verilen değerleri
  listeler.

## Oturum modeli

- Her `POST /auth/v3/token` çağrısı **ayrı bir oturum** açar. Aynı kimlikle açılan birden fazla oturum
  birlikte geçerli kalır.
- Refresh yalnızca **kendi oturumunun** eski access token'ını geçersiz kılar (kısa geçiş için
  [token yenileme](#token-yenileme)).
- Bu yüzden her süreç ya da pod kendi oturumunu tutabilir. Tek kural: **aynı refresh token birden fazla
  süreçte koordinasyonsuz kullanılmaz.** Bir süreç yenilediğinde, aynı oturumu kullanan diğer süreçlerin
  elindeki access token geçersiz sayılmalıdır: kısa bir süre daha kabul edilebilir, ama her an `401` alabilir.
- **Aynı hesapta API için tek bir kimlik kullanın.** Ana hesap ile alt kullanıcı aynı hesapta sırayla
  giriş yaptığında birbirlerinin önceki oturumları düşebilir (`401 invalid_token`).
- Identity'den `401 invalid_token` ya da SMS API'den `401 UNAUTHENTICATED` alınırsa refresh yerine
  **yeniden giriş** yapılır ve istek bir kez tekrarlanır. Yeni token ile de 401 alınıyorsa döngüye
  girilmez; kimlik bilgileri ve hesap durumu kontrol edilir.
- Her istekte yeni token almak hem `/token` sınırına (IP başına dakikada 30) takılır hem de gereksiz
  oturum açar. Mock bunu `TOKEN_CHURN` bulgusuyla bildirir.

## Önerilen istemci deseni

Token yöneticisi süreç başına tektir, token'ı bellekte tutar, aynı anda tek yenileme yapar ve süresi
dolmadan yeniler. TypeScript taslağı:

```ts
type Tokens = { access: string; refresh: string; expiresAt: number; marginMs: number };

class NetgsmTokenManager {
  private tokens?: Tokens;
  private inflight?: Promise<string>;
  private retryAfterMs = 0; // başarısız yenilemeden sonra kısa bekleme
  constructor(private baseUrl: string, private username: string, private password: string) {}

  /** Geçerli access token; süresinin son min(5 dk, ömrün %10'u) kısmına girildiyse önce yeniler. */
  async get(): Promise<string> {
    const t = this.tokens;
    if (t && (Date.now() < t.expiresAt - t.marginMs || Date.now() < this.retryAfterMs) && Date.now() < t.expiresAt) {
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
      let networkError: unknown;
      try {
        r = await this.post('/auth/v3/token/refresh', { refresh_token: old.refresh });
      } catch (err) {
        networkError = err; // ağ hatası: geçici hata gibi
      }
      if (r?.ok) return this.store(await r.json());
      const p = r ? await r.json().catch(() => ({})) : {};
      // Refresh beklenirken invalidate() token'ı silmiş olabilir; o zaman eski token kullanılmaz.
      const invalidated = this.tokens !== old;
      if (p.code !== 'invalid_refresh_token' && !invalidated) {
        // Geçici hata (ağ, 429, 5xx): eski token hâlâ geçerliyse onu kullan ve 30 sn sonra yeniden dene.
        if (Date.now() < old.expiresAt) {
          this.retryAfterMs = Date.now() + 30_000;
          return old.access;
        }
        throw r ? new Error(`refresh: ${p.code} ${p.request_id}`) : networkError;
      }
      if (!r) throw networkError; // token geçersiz kılınmış ve refresh yanıtı yok
      this.tokens = undefined; // oturum bitmiş ya da token geçersiz kılınmış: yeniden giriş
    }
    const r = await this.post('/auth/v3/token', { username: this.username, password: this.password, scope: 'sms' });
    if (!r.ok) {
      const p = await r.json().catch(() => ({}));
      throw new Error(`token: ${p.code} ${p.request_id}`); // code'a göre ele alın, bkz. errors.md
    }
    return this.store(await r.json());
  }

  private store(t: { access_token: string; refresh_token: string; expires_in: number }): string {
    const lifeMs = t.expires_in * 1000;
    this.tokens = {
      access: t.access_token,
      refresh: t.refresh_token,
      expiresAt: Date.now() + lifeMs,
      marginMs: Math.min(5 * 60_000, lifeMs / 10), // kısa ömürlü token'da (ör. mock --token-ttl 60) da çalışır
    };
    this.retryAfterMs = 0;
    return t.access_token;
  }

  private post(path: string, body: unknown) {
    return fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
```

SMS isteği sarmalayıcısı `401 UNAUTHENTICATED` aldığında o istekte kullandığı token ile
`invalidate(token)` çağırır, `get()` ile yeni token alır ve isteği **bir kez** tekrarlar. Identity `429 rate_limited` yanıtında `Retry-After` (gövdede
`retry_after`) kadar beklenir. `429 too_many_failed_attempts`'te de beklenir, ama aynı yanlış bilgiyle
tekrar denenmez; önce kimlik bilgisi düzeltilir. `5xx` yanıtlarında istek bir süre sonra tekrar denenir
(`503`'te `Retry-After` varsa ona uyulur). Diğer `4xx` yanıtlarında tekrar denenmez.

## Limitler

Tüm limitler dakika bazlıdır ve yaklaşık uygulanır.

| Kapsam | Limit | Anahtar |
|---|---|---|
| `POST /auth/v3/token` | 30 istek / dakika | IP |
| Hatalı giriş (`invalid_credentials`) | 5 deneme / dakika; başarılı giriş sayacı sıfırlar | Kullanıcı adı + IP |
| `POST /auth/v3/token/refresh` | 60 istek / dakika | IP |
| `GET /auth/v3/me`, `POST /auth/v3/token/revoke` | 60 istek / dakika | Access token |
| `GET /auth/v3/me`, `POST /auth/v3/token/revoke` | 300 istek / dakika | IP |

Limitli uçların yanıtları IETF RateLimit başlıklarını taşır:

| Başlık | Örnek | Anlamı |
|---|---|---|
| `RateLimit-Limit` | `30` | Penceredeki istek hakkı (en kısıtlayıcı kural) |
| `RateLimit-Remaining` | `29` | Kalan istek hakkı |
| `RateLimit-Reset` | `42` | Pencerenin sıfırlanmasına kalan süre (saniye) |
| `RateLimit-Policy` | `30;w=60` | Kural: 60 saniyede 30 istek |

Limit aşıldığında `429` döner (`rate_limited` ya da hatalı girişte `too_many_failed_attempts`).
İstemci `Retry-After` başlığındaki süre (saniye) kadar bekler; aynı değer gövdede `retry_after` olarak da
bulunur.

Girdi sınırları:

| Alan | Sınır |
|---|---|
| İstek gövdesi | 1 MB (aşılırsa `413 payload_too_large`) |
| `username`, `password` | 255 karakter |
| `scope` | 255 karakter |
| `refresh_token` | UUID (değilse `401 invalid_refresh_token`) |
| Bearer token | 4096 karakter |

## Hata yanıtları

Identity hataları RFC 9457 Problem Details biçimindedir (`Content-Type: application/problem+json`):

```json
{
  "type": "urn:problem-type:identity:invalid-credentials",
  "title": "Kimlik doğrulanamadı",
  "status": 401,
  "detail": "Kullanıcı adı veya şifre hatalı.",
  "instance": "/auth/v3/token",
  "code": "invalid_credentials",
  "error": "invalid_grant",
  "error_description": "Username or password is incorrect.",
  "request_id": "0b6c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4"
}
```

- İstemci mantığı `code` alanına göre kurulur.
- `title` ve `detail` Türkçedir ve son kullanıcıya gösterilebilir.
- `request_id` destek taleplerinde iletilir; `X-Thread-Id` yanıt başlığıyla aynıdır.
- `error` ve `error_description` OAuth 2.0 uyumluluğu içindir (OAuth istemci kütüphaneleri hatayı bu
  alanlardan tanır); `error_description` İngilizcedir.
- `401` yanıtları `WWW-Authenticate` başlığı taşır. `422` yanıtında `errors` alan bazlı mesajları,
  `429`'da `retry_after`, `service_not_activated` ve `sub_user_not_permitted`'da `denied_scopes` bulunur.
- İstemciden kaynaklanan hatalar `4xx`, sunucu tarafı hatalar `5xx` döner. `5xx` hatalarında istek
  değiştirilmeden, bir süre sonra tekrar denenebilir.

Her kodun anlamı, olası nedeni ve yapılacak iş: [errors.md](errors.md).
