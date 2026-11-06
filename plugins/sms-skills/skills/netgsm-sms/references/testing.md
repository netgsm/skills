# Mock ile test

Yerel mock, Netgsm SMS API v3 ve Identity API ile aynı yolları ve aynı sözleşmeyi konuşan, kendi
makinenizde çalışan bir HTTP sunucusudur. Abonelik gerekmez, gerçek SMS gitmez, ücret yoktur. Bütün
geliştirme ve otomatik testler mock'a karşı yapılır.

## Başlatma

**Claude Code'da:** `/sms-mock` komutu mock'u başlatır.

**Elle:** Node ≥ 20 yeterlidir, `npm install` gerekmez. Yol, skill dizinine göredir:

```bash
node <skill dizini>/scripts/netgsm-sms-mock.mjs
# Seçeneklerle:
node <skill dizini>/scripts/netgsm-sms-mock.mjs --port 4010 --host 127.0.0.1 --token-ttl 86400 --rate-scale 1
```

| Seçenek | Varsayılan | Görevi |
|---|---|---|
| `--port <n>` | `4010` | Dinlenecek port. Port kullanımdaysa başka bir port seçin (örn. `--port 4011`). |
| `--host <h>` | `127.0.0.1` | Dinlenecek adres. Loopback dışı bir adreste (örn. `0.0.0.0`) mock bir uyarı yazar: ağdaki diğer makineler de erişebilir ve kontrol uçlarında kimlik doğrulaması yoktur. Bu modda loopback webhook adresleri gerçek API'deki gibi reddedilir. |
| `--token-ttl <sn>` | `86400` | Access token ömrü, saniye. Kısa değer yenilemeyi denemek içindir. |
| `--rate-scale <oran>` | `1` | Bütün hız sınırlarının çarpanı. `1`'den küçük değer sıkılaştırır, büyük değer gevşetir. |
| `--quiet` | kapalı | Konsola yalnızca hataları (✘) ve bulguları (⚠) yazar. |
| `--help` | | Yardımı gösterir. |

Base URL'ler:

| API | Mock | Canlı |
|---|---|---|
| Identity | `http://127.0.0.1:4010/auth/v3` | `https://ext-api.netgsm.com.tr/auth/v3` |
| SMS | `http://127.0.0.1:4010/sms/v3` | `https://ext-api.netgsm.com.tr/sms/v3` |

Netgsm'in sandbox'ı da vardır: `https://ext-sandbox.netgsm.com.tr/auth/v3` ve
`https://ext-sandbox.netgsm.com.tr/sms/v3` (SMS göndermez, veri sabittir; bkz. [sandbox.md](sandbox.md)).
Mock, sandbox'ın sabit verisini de taşır: mock'ta yazılan kod base URL değişince sandbox'ta da çalışır.

Mock açılırken test hesaplarını ve kontrol uçlarını konsola yazar. Her isteği tek satırla
değerlendirir: `✔` başarılı, `✘` hata (kodun anlamıyla), `⚠` hata olmayan ama yanlış bir kalıp.
Durdurmak için Ctrl+C. Durum bellekte tutulur; mock kapanınca görevler ve oturumlar silinir.

## Test hesapları

`8500000000`–`8500000005`, Netgsm sandbox'ının demo hesaplarıyla aynıdır: aynı şifre, aynı
`user_id`, aynı Identity sonucu ve `profile` token ile aynı SMS API `403`'leri (bkz. [sandbox.md](sandbox.md)). `8500000006`–`8500000010` yalnızca
mock'ta vardır.

| `username` | Şifre | Ne gösterir |
|---|---|---|
| `8500000000` | `password001` | Her şey açık: gönderim, rapor, gelen kutusu, İYS modu, yurt dışı izni, OTP kredisi. `MOCKTEST` ve `TESTHEADER` başlıklarının İYS marka kodu `4567`. Ana hesap (`sub_user_id: 0`). |
| `8500000001` | `password002` | Hizmet aktivasyonu yok → `sms`, `voice`, `fax` … `403 service_not_activated`; `profile`, `contact`, `email`, `financial`, `digital-services`, `voice-sms` `200`. `profile` token ile SMS API: `/send`, `/send/template`, `/send/otp`, `/directory/send`, `/inbox` `403 FORBIDDEN` (`account is not activated for this operation`), diğerleri başarılı. |
| `8500000002` | `password003` | IP izni yok → `403 ip_not_allowed`. |
| `8500000003` | `password004` | Hizmet yetkisi olmayan alt kullanıcı (`sub_user_id: 4001`) → hizmet scope'ları `403 sub_user_not_permitted`; `profile`, `contact`, `email` `200`. `profile` token ile SMS API: `/length`, `/blacklist` ve `/balance` dışında `403 FORBIDDEN` (`sub user may not use the sms api`). |
| `8500000004` | `password005` | API erişimi kapalı → `403 api_access_denied`. |
| `8500000005` | `password006` | Hesap aktif değil → `403 account_inactive`. |
| `8500000006` | `password007` | Yalnızca mock. Token alınır, ama `/send` `403 FORBIDDEN` (`account operator is not served for this operation`). |
| `8500000007` | `password008` | Yalnızca mock. Ülke izni yok → `403 country_not_allowed`. |
| `8500000008` | `password009` | Yalnızca mock. İYS modu, yurt dışı gönderim izni ve OTP kredisi yok: `iysFilter` `BRAND` ya da `RETAILER` `422 REJECTED_IYS`, yurt dışı kayıt `NO_INTERNATIONAL_PERMISSION`, `/send/otp` `422 INSUFFICIENT_CREDIT`. |
| `8500000009` | `password010` / `password011` | Yalnızca mock. `password010` ana hesap, `password011` aynı hesabın SMS yetkili API alt kullanıcısı (`sub_user_id: 1`). Ana hesap ile alt kullanıcının sırayla giriş yapınca birbirinin oturumunu düşürmesini (canlıdaki davranış) denemek içindir. Bakiyesi boş (aşağıda). |
| `8500000010` | `password012` | Yalnızca mock. "Demo Kurumsal OTP": her şey açık, hesapta kurumsal OTP hizmeti tanımlı. `/send/otp` `x-client: enterprise` başlığını ister; göndermezse `403 FORBIDDEN` (`account operator is not served for this operation`). Diğer hesaplar bu başlıkla istek yaparsa aynı `403`'ü alır. |

Hesaplardaki hazır veriler:

- **Başlıklar (`sender`):** `MOCKTEST` (varsayılan) ve `TESTHEADER` (sandbox'ın başlığı) kullanılabilir
  (alfanümerik, İYS modundaki hesapta marka kodu `4567`). `MOCKKAPALI` kayıtlı ama
  kullanılamaz (`ROUTING_CODE_MISSING`); gönderimde `422 REJECTED_HEADER` alır. Hesabın abone numarası
  (`username`) da başlık olarak kullanılabilir (sandbox'ta abone numarası başlığı `SUBSCRIBER_NUMBER_RESTRICTED` ile kullanılamaz). Eşleşme birebirdir: `mocktest` `CASE_MISMATCH` alır
  (`/send/otp` hariç; orada gönderici büyük/küçük harf ayırmaz).
  Spec örneklerindeki `NETGSM` mock'ta kayıtlı değildir.
- **Şablonlar:** 1 (sandbox'ınkiyle aynı: herkese açık `AUTH_OTP`, `Merhaba ${name}, kodunuz ${code}`,
  `name` `TEXT` en fazla 50, `code` `TEXT` en fazla 10), 3 (`AUTH_OTP`, `Dogrulama kodunuz: ${otpCode}`,
  `otpCode` `BIGINT`), 4 (herkese açık, parametresiz), 5 (`${date}` `DATE`, `${note}` `TEXT` en fazla 30).
- **Rehber:** `groupId` 7 ("Müşteriler", üç kişi).
- **Kara liste:** `5000000001`, `5000000002` (sandbox'ınkiyle aynı).
- **Bakiye (`GET /balance`):** değerler sabittir, gönderimlerle azalmaz.

  | Hesap | `stip=3` listesi | `stip=2` özeti |
  |---|---|---|
  | Diğer bütün hesaplar (faturasız, kredi var) | `Adet SMS` `277` (iki kaydın toplamı, sayı), `Adet OTP SMS` `"767"`, `Dakika` `"242"`, `Kredi Bakiye` `"92,150"` (spec örneği) | `{"code":"00","balance":"92,150"}` |
  | `8500000008` (faturasız, yalnızca SMS paketi) | `Adet SMS` `"1500"`, `Kredi Bakiye` `"0,000"` | `{"code":"00","balance":"1500","type":"AdetSMS"}` |
  | `8500000009` (faturasız, ne kredi ne paket) | `Kredi Bakiye` `"0,000"` | `{"code":"00"}` |
  | `8500000010` (faturalı) | `Adet OTP SMS` `"5000"`, `Kredi Bakiye` `"0,000"` | `{"code":"00","balance":"0"}` |

  `service` verilmezse listede üç tür de vardır; `service=sms` yalnızca `Adet SMS`, `service=otp` yalnızca
  `Adet OTP SMS`, `service=ses` yalnızca `Dakika` döndürür; diğer gruplar boş liste döner. Önbellek (10 sn) ve istek sınırı (dakikada 60, `--rate-scale` ile ölçeklenir) spec'teki gibidir;
  `/__mock/clock` ile önbelleğin dolmasını hızlandırabilirsiniz.

## Temel akış

Aşağıdaki örnekler bash içindir ve bu iki değişkeni kullanır:

```bash
M=http://127.0.0.1:4010
TOKEN=$(curl -s $M/auth/v3/token -H 'Content-Type: application/json' \
  -d '{"username":"8500000000","password":"password001","scope":"sms"}' \
  | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
SEND='{"sender":"MOCKTEST","messages":[{"recipient":"905061234567","text":"Merhaba"}]}'
```

```bash
# Gönder (202, jobId döner)
curl -s $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
# Raporu sor (5 saniye sonra DELIVERED)
curl -s "$M/sms/v3/report?jobIds=<jobId>" -H "Authorization: Bearer $TOKEN"
```

Adım adım ilk kurulum ve token alma: [getting-started.md](getting-started.md) (6. adım).

**Windows notu:** Bazı Windows kabuklarında `-d` ile verilen Türkçe karakterler (`ş`, `ğ` gibi) UTF-8
olarak gitmeyebilir ve uzunluk yanlış hesaplanır. Türkçe metinli gövdeyi bir dosyaya UTF-8 olarak yazıp
`--data-binary @govde.json` ile gönderin.

## İletim simülasyonu

- Kabul edilen her kayıt, görevin başlangıcından 5 saniye sonrasına kadar `PENDING`, sonra `DELIVERED`
  olur.
- `00` ile biten alıcılar (`905061234500` gibi) `NOT_DELIVERED` ve `failReason` `UNKNOWN_SUBSCRIBER`
  döner. `/stats`'ta bu neden listede olmadığı için `UNKNOWN` görünür.
- `startAt` en az 120 saniye ilerideyse görev `SCHEDULED` olur ve `POST /cancel` ile iptal edilebilir;
  61–119 saniye ilerideyse `QUEUED` olur. İptal edilen görev `/report`'ta satır üretmez, `/stats` `404`
  döner.
- OTP görevleri `/report`'ta görünmez; `/stats` ve `/cancel` onlar için `404` döner.
- Rapor webhook'u kayıtlıysa sonuçlanan her rapor bir kez gönderilir (bekleyenler gönderilmez). Webhook
  gövdesi sayısal kodlar taşır: iletilen kayıt `status` `1`, `errorCode` `0`; `00` ile biten alıcı `status`
  `2`, `errorCode` `116` (`UNKNOWN_SUBSCRIBER`). Operatör kodu `GET /report`'taki adın karşılığıdır (`TURKCELL`
  → `30`, `VODAFONE` → `10`, `TURK_TELEKOM` → `20`; mock yurt dışına `210`, bilinmeyene `0` verir); referans
  verilmediyse `referansID` `null`'dır. Kodların tamamı: [endpoints/webhooks.md](endpoints/webhooks.md#kodlar-ve-get-report-karşılıkları).

## Hata senaryoları

`POST /__mock/scenario` sıradaki isteğe bir hata enjekte eder. Kontrol uçları kimlik doğrulaması
istemez. Kontrol uçlarına `POST` istekleri `Content-Type: application/json` ister (gövdesiz `reset`
dahil); başka bir içerik türü `415` alır.

| Alan | Açıklama |
|---|---|
| `code` | Senaryo kodu (aşağıdaki tablo). |
| `path` | İsteğe bağlı. Verilirse yalnızca o yola uygulanır (`/sms/v3/send` gibi). Verilmezse aynı API'nin (SMS ya da Identity) sıradaki isteğine uygulanır. |
| `times` | İsteğe bağlı, varsayılan 1. Kaç isteğe uygulanacağı. |
| `retryAfter` | İsteğe bağlı, varsayılan 30. `RATE_LIMITED`, `rate_limited` ve `too_many_failed_attempts`'te `Retry-After` saniyesi. |

- SMS senaryoları yalnızca geçerli token taşıyan isteğe uygulanır; token'ı geçersiz istek kendi `401`'ini
  alır ve senaryo kuyrukta kalır.
- `GET /__mock/scenario` kuyruktaki senaryoları listeler, `DELETE /__mock/scenario` kuyruğu temizler.
- Bilinmeyen bir kod `400` ile desteklenen kodların listesini döner.

| `code` | Yanıt | `message` |
|---|---|---|
| `SERVICE_UNAVAILABLE` | `503` | `service is temporarily unavailable` |
| `QUEUE_UNCONFIRMED` | Yola göre `503` ya da `504` (aşağıda) | — |
| `INTERNAL_ERROR` | `500` | `internal error` |
| `RATE_LIMITED` | `429` + `Retry-After` | `send rate limit exceeded` (`/sms/v3/balance` yolunda `balance rate limit exceeded`) |
| `SENDING_SUSPENDED` | `429`, `Retry-After` yok | `sending is suspended for this account` |
| `INSUFFICIENT_CREDIT` | `422` | `no credit, package or campaign to pay for the otp` |
| `REJECTED_HEADER` | `422` | `NOT_REGISTERED` |
| `REJECTED_IYS` | `422` | `account is not in iys mode, filtering cannot be applied` |
| `FORBIDDEN` | `403` | `account is not activated for this operation` |
| `E_SIGNATURE_REQUIRED` | `403` | `the requested menu requires an e-signature login on the account` |
| `service_unavailable` | Identity `503` | — |
| `service_misconfigured` | Identity `502` | — |
| `internal_error` | Identity `500` | — |
| `login_not_permitted` | Identity `403` (`access_denied`) | — |
| `rate_limited` | Identity `429` + `Retry-After` | — |
| `too_many_failed_attempts` | Identity `429` + `Retry-After` | — |

`message` değerleri mock'undur; gerçek API'nin `503`, `504` ve `500` mesajları farklı olabilir. Kodunuz
`message`'a değil `code`'a göre karar vermelidir.

**`QUEUE_UNCONFIRMED`, "kuyruğa alınmış olabilir" durumunu yola göre canlandırır:**

| Yol | Mock ne yapar |
|---|---|
| `/sms/v3/directory/send` | Görevi gerçekten oluşturur, sonra `504 QUEUE_UNCONFIRMED` döner. |
| `/sms/v3/send`, `/sms/v3/send/template` | Görevi gerçekten oluşturur, sonra `503 SERVICE_UNAVAILABLE` döner (`503`'ün "çoğunlukla alınmamıştır, kesin değil" kısmı). |
| `/sms/v3/send/otp` | Hiçbir şey göndermeden `503 SERVICE_UNAVAILABLE` döner (OTP'de `503` güvenle tekrar denenir). |
| `/sms/v3/cancel` | `504 QUEUE_UNCONFIRMED` döner. |

Oluşan görev `/report`'ta görünür: "`503`/`504` gönderilmedi demek değildir" bu şekilde denenir.
`SERVICE_UNAVAILABLE` senaryosu ise hiçbir görev oluşturmaz; ikisi aynı `503`'ü döndürdüğü için kodunuz
`/send`'de bu iki durumu ayıramaz, bu yüzden yeniden göndermeden önce `/report`'a bakmalıdır. Senaryo, bir
görev gerçekten oluşana kadar kuyrukta kalır (istek önce `4xx` alırsa tüketilmez).

Her kod için bir örnek (önce senaryoyu kurun, sonra tetikleyen isteği gönderin). Örnekleri arka arkaya
çalıştıracaksanız aralarında `curl -s -X POST $M/__mock/reset -H 'Content-Type: application/json'` çağırın ve `TOKEN`'ı yeniden alın (reset
oturumları da siler). Reset olmadan `GET /__mock/advice` iki bulgu gösterir: aynı `$SEND` gövdesi
`QUEUE_UNCONFIRMED`'in yanıtından sonra yeniden gönderildiği için `RETRY_AFTER_QUEUE_UNCONFIRMED`,
`RATE_LIMITED`'in `Retry-After` süresi (5 sn) dolmadan sonraki istek gönderildiği için
`IGNORED_RETRY_AFTER`. Bu bulgular doğrudur: aynı sıra gerçek bir entegrasyonda çift gönderim ve
sınırın yok sayılması olurdu; burada sebep yalnızca örneklerin art arda çalıştırılmasıdır.

```bash
# SERVICE_UNAVAILABLE: hiçbir görev oluşmaz. /send'de kodunuz bunu QUEUE_UNCONFIRMED'in 503'ünden ayıramaz:
# yeniden göndermeden önce /report'a bakın. /send/otp'de 503 güvenle tekrar denenir.
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"SERVICE_UNAVAILABLE","path":"/sms/v3/send"}'
curl -s -i $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
```

```bash
# QUEUE_UNCONFIRMED (/send): görev oluşur, 503 döner; aynı gövdeyi körlemesine tekrar göndermek çift gönderimdir
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"QUEUE_UNCONFIRMED","path":"/sms/v3/send"}'
curl -s -i $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
curl -s $M/sms/v3/report -H "Authorization: Bearer $TOKEN"   # görev burada görünür
```

```bash
# QUEUE_UNCONFIRMED (/directory/send): görev oluşur, 504 döner
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"QUEUE_UNCONFIRMED","path":"/sms/v3/directory/send"}'
curl -s -i $M/sms/v3/directory/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sender":"MOCKTEST","text":"Merhaba","groupIds":[7]}'
```

```bash
# E_SIGNATURE_REQUIRED: rehber gönderimi 403 alır; kodla çözülmez
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"E_SIGNATURE_REQUIRED","path":"/sms/v3/directory/send"}'
curl -s -i $M/sms/v3/directory/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sender":"MOCKTEST","text":"Merhaba","groupIds":[7]}'
```

```bash
# INTERNAL_ERROR: gönderim ucunda kuyruğa alınmış olabilir gibi ele alınır
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"INTERNAL_ERROR","path":"/sms/v3/send"}'
curl -s -i $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
```

```bash
# RATE_LIMITED: Retry-After: 5 kadar bekleyin
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"RATE_LIMITED","path":"/sms/v3/send","retryAfter":5}'
curl -s -i $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
```

```bash
# SENDING_SUSPENDED: Retry-After yok; tekrar denemeyin
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"SENDING_SUSPENDED","path":"/sms/v3/send"}'
curl -s -i $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
```

```bash
# INSUFFICIENT_CREDIT: OTP ucunun hatası
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"INSUFFICIENT_CREDIT","path":"/sms/v3/send/otp"}'
curl -s -i $M/sms/v3/send/otp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sender":"MOCKTEST","text":"Dogrulama kodunuz: 123456","recipient":"905061234567"}'
```

```bash
# Kurumsal OTP: 8500000010 x-client: enterprise ile 202 alır, başlıksız 403
OTP_TOKEN=$(curl -s $M/auth/v3/token -H 'Content-Type: application/json' \
  -d '{"username":"8500000010","password":"password012","scope":"sms"}' \
  | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
curl -s -i $M/sms/v3/send/otp -H "Authorization: Bearer $OTP_TOKEN" -H 'x-client: enterprise' \
  -H 'Content-Type: application/json' -d '{"sender":"MOCKTEST","text":"Dogrulama kodunuz: 123456","recipient":"5061234567"}'
```

```bash
# REJECTED_HEADER
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"REJECTED_HEADER","path":"/sms/v3/send"}'
curl -s -i $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
```

```bash
# REJECTED_IYS
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"REJECTED_IYS","path":"/sms/v3/send"}'
curl -s -i $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
```

```bash
# FORBIDDEN
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"FORBIDDEN","path":"/sms/v3/send"}'
curl -s -i $M/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
```

```bash
# Identity: service_unavailable (503), service_misconfigured (502), internal_error (500)
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"service_unavailable","path":"/auth/v3/token"}'
curl -s -i $M/auth/v3/token -H 'Content-Type: application/json' -d '{"username":"8500000000","password":"password001","scope":"sms"}'
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"service_misconfigured","path":"/auth/v3/token"}'
curl -s -i $M/auth/v3/token -H 'Content-Type: application/json' -d '{"username":"8500000000","password":"password001","scope":"sms"}'
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"internal_error","path":"/auth/v3/token"}'
curl -s -i $M/auth/v3/token -H 'Content-Type: application/json' -d '{"username":"8500000000","password":"password001","scope":"sms"}'
```

```bash
# Identity: rate_limited ve too_many_failed_attempts (Retry-After ve gövdede retry_after)
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"rate_limited","path":"/auth/v3/token","retryAfter":7}'
curl -s -i $M/auth/v3/token -H 'Content-Type: application/json' -d '{"username":"8500000000","password":"password001","scope":"sms"}'
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"too_many_failed_attempts","path":"/auth/v3/token"}'
curl -s -i $M/auth/v3/token -H 'Content-Type: application/json' -d '{"username":"8500000000","password":"password001","scope":"sms"}'
```

```bash
# Aynı hatayı art arda üç isteğe uygulamak (artan bekleme mantığını denemek için)
curl -s -X POST $M/__mock/scenario -H 'Content-Type: application/json' -d '{"code":"SERVICE_UNAVAILABLE","path":"/sms/v3/send","times":3}'
```

### Gerçek girdiyle tetiklenen hatalar

Senaryo gerektirmeyen hatalar, gerçek API'deki gibi yanlış girdiyle ya da test hesaplarıyla üretilir:

| Hata | Nasıl |
|---|---|
| `401 UNAUTHENTICATED` | `Authorization` başlığı olmadan istek. |
| `400 INVALID_REQUEST` | Eksik alan, örn. `{"sender":"MOCKTEST"}`. Türü uymayan değer (`"encoding":"turkish"`) tek ihlalle `1 field(s) rejected`; bozuk JSON `request body could not be read as json`. `GET /balance?service=x`. |
| `400 INVALID_SEND_WINDOW` | `/send`'de `startAt` 18 aydan daha ileride. |
| `202` + `rejectedItems` | Bir kayıtta `+905061234567` (`INVALID_RECIPIENT`). |
| `422 NO_DELIVERABLE_MESSAGES` | Bütün kayıtlar hatalı. |
| `422 REJECTED_HEADER` `CASE_MISMATCH` / `ROUTING_CODE_MISSING` | `sender` `mocktest` / `MOCKKAPALI`. |
| `404 NOT_FOUND` | Bilinmeyen `jobId` ile `GET /stats` ya da `POST /cancel`. |
| `409 ALREADY_EXISTS` | Aynı webhook'u iki kez kaydetmek. |
| Identity `403` kodları | `8500000001`–`8500000005` ve `8500000007` hesapları (yukarıdaki tablo). |
| `429` görev bazlı | Aynı `jobId` ile `GET /report`'u bir dakika içinde iki kez çağırmak. |

```bash
# Kimlik hatası: API erişimi kapalı hesap
curl -s $M/auth/v3/token -H 'Content-Type: application/json' \
  -d '{"username":"8500000004","password":"password005","scope":"sms"}'
```

## Yanlış kalıplar: `/__mock/advice`

Mock, hata olmayan ama yanlış olan kalıpları konsola `⚠` ile yazar ve `GET /__mock/advice` ile
listeler. Asistan bu ucu okuyup entegrasyonu yorumlayabilir.

```bash
curl -s $M/__mock/advice
```

```json
{
  "findings": [
    {
      "rule": "RETRY_AFTER_QUEUE_UNCONFIRMED",
      "severity": "error",
      "message": "Kuyruğa alınmış olabilecek bir gönderimin aynı gövdesi yeniden gönderildi → ...",
      "requestId": "6855ceec96b39e5a2a22dcfee083ccff",
      "at": "2026-10-30T14:53:24.449Z"
    }
  ]
}
```

| `rule` | Ne zaman | Doğrusu |
|---|---|---|
| `SINGLE_RECIPIENT_BURST` | 10 saniyede tek kayıtlı en az 5 `/send` isteği | Alıcıları tek `/send` isteğinde toplayın ([limits-and-batching.md](limits-and-batching.md#kendi-kuyruğunu-yazma)). |
| `TOKEN_CHURN` | Aynı kullanıcı için 60 saniyede en az 3 başarılı `/token` | Token'ı önbellekte tutun, süresi dolmadan refresh edin; `401` alırsanız yeniden giriş yapın ([auth.md](auth.md#önerilen-istemci-deseni)). |
| `RETRY_AFTER_QUEUE_UNCONFIRMED` | Kuyruğa alınmış olabilecek bir gönderimin (`QUEUE_UNCONFIRMED` senaryosu) aynı gövdesinin yeniden gönderilmesi | Önce `/report` ile kontrol ([errors.md](errors.md#503-ve-504-sonrası-kontrol)). |
| `RETRY_NON_RETRYABLE` | `INVALID_REQUEST`, `NO_DELIVERABLE_MESSAGES` ya da `INVALID_SEND_WINDOW` sonrası aynı gövdenin 60 saniye içinde yeniden gönderilmesi | İsteği düzeltin; aynı istek aynı sonucu verir. |
| `IGNORED_RETRY_AFTER` | `Retry-After` dolmadan yeni istek | `Retry-After` kadar bekleyin. |
| `STALE_TOKEN` | Revoke edilmiş, yenilemeyle ya da diğer kimliğin girişiyle geçersiz kalmış veya süresi dolmuş token kullanımı | Token'ı önbellekte tutun, süresi dolmadan refresh edin ve yanıttaki yeni token'ı kullanın; `401` alırsanız yeniden giriş yapın ([auth.md](auth.md#oturum-modeli)). |
| `REPORT_POLLING` | `/report` ya da `/stats`'ta görev bazlı `429` | Rapor webhook'u kullanın. |
| `BALANCE_POLLING` | 60 saniyede en az 10 `GET /balance` ya da `/balance`'ta `429` | Bakiyeyi büyük bir kampanyadan önce bir kez sorgulayın; döngüde ya da her gönderimden önce sorgulamayın ([endpoints/balance.md](endpoints/balance.md)). |

Her kural hesap başına 60 saniyede en fazla bir kez bildirilir.

## Gelen SMS: `/__mock/inbound`

Hesaba gelen bir SMS'i taklit eder. Mesaj `GET /inbox`'ta görünür; hesapta gelen SMS webhook'u
kayıtlıysa anında o adrese de `POST` edilir.

```bash
curl -s -X POST $M/__mock/inbound -H 'Content-Type: application/json' \
  -d '{"username":"8500000000","from":"905061234567","text":"IPTAL"}'
curl -s $M/sms/v3/inbox -H "Authorization: Bearer $TOKEN"
```

Alanlar: `username` (test hesabı), `from` (gönderen numara), `text`. Başarılı yanıt `201`'dir.

## Saat: `/__mock/clock`

Mock'un saatini ileri alır. İletim simülasyonu, zamanlanmış görevler, görev bazlı sorgu aralıkları,
hız sınırı pencereleri ve token ömrü bu saate göre işler.

```bash
# 61 saniye ileri: aynı görevin raporu tekrar sorulabilir
curl -s -X POST $M/__mock/clock -H 'Content-Type: application/json' -d '{"advanceSeconds":61}'
```

`advanceSeconds` pozitif bir sayıdır; yanıt mock'un yeni saatini (`now`) döner.

`POST /__mock/reset` (`-H 'Content-Type: application/json'` ile) bütün durumu (görevler, oturumlar, gelen kutusu, webhook kayıtları, senaryolar,
sayaçlar ve saat) başa döndürür. Testler arasında çağrılması önerilir.

## Token yenilemeyi denemek: `--token-ttl`

```bash
node <skill dizini>/scripts/netgsm-sms-mock.mjs --token-ttl 60
```

Access token 60 saniyede dolar. Kodunuzun süre dolmadan `POST /auth/v3/token/refresh` ile yenilediğini
ve süresi dolmuş token ile gelen `401 UNAUTHENTICATED`'da (`invalid or expired token`) yeniden giriş
yapıp isteği bir kez tekrarladığını beklemeden denemek için saati ileri alın:

```bash
curl -s -X POST $M/__mock/clock -H 'Content-Type: application/json' -d '{"advanceSeconds":61}'
curl -s -i $M/sms/v3/senders -H "Authorization: Bearer $TOKEN"   # 401 UNAUTHENTICATED
```

Yenilemeden sonra eski access token'ı ya da süresi dolmuş token'ı kullanmak `STALE_TOKEN` bulgusu üretir.

## `429` işlemeyi denemek: `--rate-scale`

Bütün sınırlar `max(1, yukarı yuvarla(sınır × oran))` olur. Görev ve sorgu bazlı aralıklar (`/report`
1 dakika, `/stats` ve `/blacklist` 10 dakika) değişmez.

```bash
node <skill dizini>/scripts/netgsm-sms-mock.mjs --rate-scale 0.0001
```

Bu ayarla `/send` dakikada 5 istek kabul eder (50.000 × 0,0001); 6. istek `429` ve `Retry-After` alır:

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w '%{http_code}\n' $M/sms/v3/send \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND"
done
```

Bu döngü aynı zamanda `SINGLE_RECIPIENT_BURST` bulgusunu da üretir. Spec'teki sınırların listesi:
[limits-and-batching.md](limits-and-batching.md).

## Mock'un varsayımları (sözleşme değildir)

Spec aşağıdaki uç noktalar için sayı vermez. Mock, `429` ve `Retry-After` işlemeyi deneyebilmeniz için
bu uç noktalarda da bir sınır uygular. **Bu değerler mock varsayımıdır, sözleşme değildir**: gerçek
API'de farklı olabilir ve değişebilir. Kodunuzu bu sayılara göre değil `429` ve `Retry-After`'a göre
yazın.

| Uç nokta | Mock'un uyguladığı sınır (hesap başına) |
|---|---|
| `GET /inbox` | Dakikada 60 istek |
| `GET /senders`, `GET /senders/default` | Dakikada 60 istek, ikisi için ortak |
| `PUT /senders/default` | Saatte 4 istek |
| `POST`/`DELETE` `/webhooks/report`, `/webhooks/inbox` | 60 saniyede 10 istek, dördü için ortak |

## Mock'un taklit etmedikleri

- Gerçek başlık onayı: yalnızca `MOCKTEST`, `TESTHEADER`, `MOCKKAPALI` ve hesabın abone numarası kayıtlıdır.
- Gerçek İYS izinleri: `iysFilter` alıcıları elemez; yalnızca hesap ve başlık kuralları (`REJECTED_IYS`)
  uygulanır.
- Gerçek bakiye ve ücretlendirme: `GET /balance` hesap başına sabit örnek veri döndürür ve gönderimlerle
  azalmaz; `/stats`'taki `charging` ve `chargeDescription` temsilidir.
- Gerçek operatör iletimi: iletim sonucu yalnızca 5 saniye ve `00` kuralına göre üretilir; operatör adı
  temsilidir.
- Refresh token ve oturumların süresi: mockta refresh token ve oturumlar hiç dolmaz (yalnızca access
  token `--token-ttl` ile dolar); revoke ve diğer kimliğin girişi oturumu yine kapatır. Gerçek API'de
  refresh token da dolabilir: `invalid_refresh_token`'da yeniden giriş yapın.
- `REJECTED_HEADER`'ın abone numarası eki: gerçek API, abone numarasından gönderime onaylı olmayan
  hesapta tamamı rakam bir `sender` için `message`'ın sonuna ` (subscriber number headers were not
  offered)` ekleyebilir; mock bu eki üretmez. `message`'ı tam eşitlikle karşılaştırmayın
  ([errors.md](errors.md#rejected_header-422)).
- Hesabın ticari gönderim tipi: gerçek API'de hesap ticari (marka ya da bayi) tipinde tanımlıysa
  istekteki `iysFilter` yok sayılır ve hesabın tipi uygulanır; mock istekteki değeri kullanır.
- `jobId` biçimi: mock kısa sayısal kimlikler üretir, gerçek kimlikler daha uzundur. `jobId`'yi her zaman
  string olarak saklayın, uzunluğuna ya da biçimine güvenmeyin.

## Gerçek API'den bilinçli sapmalar

| Sapma | Mock | Gerçek API |
|---|---|---|
| Webhook adresi | Mock loopback adreste dinlerken (varsayılan) `localhost`, `127.0.0.1` ve `::1` kabul edilir (yerel alıcıyla test için); `--host` loopback dışıysa gerçek API gibi reddedilir. | Loopback, özel ve iç adresler `400 INVALID_REQUEST` alır; adres genel (public) olmalıdır. |
| `X-Request-Id` yanıt başlığı | Her yanıtta bulunur (kolaylık). | Buna güvenmeyin; SMS'te gövdedeki `requestId`'yi, Identity'de `request_id`'yi loglayın. |

## Sandbox'a ve canlıya geçiş

1. **Mock:** bütün geliştirme ve otomatik testler; sandbox'ın gösteremediği her şey: senaryolarla
   istenen anda hata (`503`, `504`, `500`, `429`), istek sınırları, İYS ve kredi hataları, gönderim
   penceresi, webhook'lar, değişen iletim raporları, gelen SMS, `/__mock/advice`.
2. **Sandbox:** `https://ext-sandbox.netgsm.com.tr` (`/auth/v3`, `/sms/v3`). Gerçek ağ, TLS ve token akışı;
   istek doğrulaması ve hata gövdeleri canlıyla aynı, veri sabit. Demo hesaplar ve sabit veri
   (`TESTHEADER`, şablon `1`, kara liste) mock'takiyle aynıdır; mock'tan farklar
   [sandbox.md](sandbox.md#mock-ile-sandbox-arasındaki-farklar)'de.
3. **Canlı:** yalnızca base URL (`https://ext-api.netgsm.com.tr`) ve kimlik bilgileri değişir (abone
   numarası, API alt kullanıcısı şifresi, onaylı başlığınız). Kod değişmez.

**Canlıda gönderim uçları gerçek, ücretli SMS gönderir.** Asistan, canlı adrese istek atan bir komutu ya
da kodu çalıştırmadan önce bunu açıkça söyler ve onay alır. Otomatik testler canlıya bağlanmaz.

Canlıya geçmeden önce kontrol listesi:
[getting-started.md](getting-started.md#7-mock--sandbox--canlı).
