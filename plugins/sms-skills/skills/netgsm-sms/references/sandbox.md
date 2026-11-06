# Sandbox: SMS API ve Identity

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/sandbox/sms-api-v-3-sandbox/ · Identity:
https://api-docs.netgsm.com.tr/auth/token/

Netgsm, SMS API v3'ün ve Identity API'nin (token, yenileme, sonlandırma, `/me`) bir sandbox sürümünü
yayınlar. Sandbox canlıyla **aynı istekleri kabul eder ve aynı biçimde yanıt verir**: alan adları,
doğrulama kuralları, hata kodları ve hata mesajları canlıdakiyle aynıdır. Fark: yanıtların arkasındaki
veri sabittir, sandbox hiçbir gerçek hesaba bağlanmaz ve yalnızca aşağıdaki demo hesapları tanır.

> **Sandbox hiçbir koşulda SMS göndermez.** Gönderim uçları isteği doğrular ve gerçekçi bir yanıt
> döner; mesaj hiçbir operatöre iletilmez, kaydedilmez ve ücretlendirilmez.

| | Sandbox | Canlı |
|---|---|---|
| Identity base URL | `https://ext-sandbox.netgsm.com.tr/auth/v3` | `https://ext-api.netgsm.com.tr/auth/v3` |
| SMS base URL | `https://ext-sandbox.netgsm.com.tr/sms/v3` | `https://ext-api.netgsm.com.tr/sms/v3` |

Sandbox'ta alınan token yalnızca sandbox'ta (sandbox'ın SMS API'sinde ve Identity'sinde) geçerlidir;
canlıda geçmez.

## Ne zaman kullanılır

Önerilen sıra **mock → sandbox → canlı**:

| Ortam | Ne için |
|---|---|
| Yerel mock ([testing.md](testing.md)) | Geliştirme ve otomatik testler; sandbox'ın gösteremediği her şey: istenen anda `503` / `504` / `500` / `429` (senaryolar), istek sınırları, İYS ve kredi hataları, gönderim penceresi, webhook'lar, gerçekçi ve değişen iletim raporları, gelen SMS, `/__mock/advice` bulguları. |
| Sandbox | Gerçek bir sunucuya karşı ağ, TLS, proxy ve zaman aşımı ayarları; token alma, önbellek, yenileme ve `401`'de yeniden giriş; istek doğrulamasının (`400`, `422`, `violations`) ve hata gövdelerinin canlıyla birebir aynı olduğunu görmek. Veri sabittir. |
| Canlı | Yalnızca base URL, kimlik bilgileri ve başlık değişir. Gönderim uçları **gerçek, ücretli SMS** gönderir. |

- Kendi hesabınızla sandbox'a giriş yapılamaz; tanımsız kullanıcı ya da yanlış şifre
  `401 invalid_credentials` alır.
- Sandbox'a istek atmak ücretsizdir ve hiçbir şey tetiklemez; asistan, kullanıcıya sormadan sandbox'a
  istek atabilir (canlı için onay kuralı geçerlidir).

## Hızlı başlangıç

```bash
SB=https://ext-sandbox.netgsm.com.tr
TOKEN=$(curl -s $SB/auth/v3/token -H 'Content-Type: application/json' \
  -d '{"username":"8500000000","password":"password001","scope":"sms"}' \
  | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
curl -s $SB/sms/v3/send -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sender":"TESTHEADER","messages":[{"text":"Merhaba","recipient":"905551112233"}]}'
```

```json
{
  "jobId": "17937053582689000017972015",
  "status": "QUEUED",
  "accepted": 1,
  "rejected": 0,
  "rejectedItems": [],
  "rejectedItemsTruncated": false,
  "referenceId": null
}
```

Token `expires_in` `86400` saniye (24 saat) geçerlidir; süresi dolan token SMS API'de `401` alır,
yeni token alınır (bkz. [auth.md](auth.md)). Mock'ta yazdığınız kod, base URL'yi
`https://ext-sandbox.netgsm.com.tr` yapıp başlık olarak `TESTHEADER` kullandığınızda değişmeden çalışır.

## Demo hesaplar

| `username` | Şifre | Durum | `POST /auth/v3/token` sonucu | SMS API'deki davranış |
|---|---|---|---|---|
| `8500000000` | `password001` | Aktif ana hesap, tüm hizmetler aktif | Her scope ile `200` | Bütün uç noktalarda başarılı yanıt. Denemeler için bu hesabı kullanın. |
| `8500000001` | `password002` | Aktif ana hesap, hizmet aktivasyonu yok | `profile`, `contact`, `email` ve aktivasyon gerektirmeyen `financial`, `digital-services`, `voice-sms`: `200`. Diğer hizmet scope'ları (`sms`, `voice`, `fax` …): `403 service_not_activated` + `denied_scopes` | `profile` token ile: `/send`, `/send/template`, `/send/otp`, `/directory/send`, `/inbox` → `403 FORBIDDEN` `account is not activated for this operation`. Diğer uç noktalar başarılı. |
| `8500000002` | `password003` | Aktif hesap, IP erişim izni yok | `403 ip_not_allowed` | Token alınamaz. |
| `8500000003` | `password004` | Aktif hesabın alt kullanıcısı, hizmet yetkisi yok | `profile`, `contact`, `email`: `200` (`sub_user_id: 4001`). Hizmet scope'ları (`sms`, `voice`, `fax` …): `403 sub_user_not_permitted` + `denied_scopes` | `profile` token ile: `/length`, `/blacklist` ve `/balance` dışında bütün uç noktalarda `403 FORBIDDEN` `sub user may not use the sms api`. |
| `8500000004` | `password005` | Aktif ana hesap, API erişimi yok | `403 api_access_denied` | Token alınamaz. |
| `8500000005` | `password006` | Pasif hesap | `403 account_inactive` | Token alınamaz. |
| (diğer) | | Tanımsız kullanıcı ya da yanlış şifre | `401 invalid_credentials` | — |

**`profile` token ile SMS API'deki `403`'leri görmek.** `8500000001` ve `8500000003` `scope: "sms"` ile
token alamaz. Bu iki hesabın SMS API'deki `403` yanıtlarını denemek için `scope: "profile"` ile token
alın; sandbox'ın SMS API'si bu token'ı kabul eder ve hesaba göre yukarıdaki `403`'ü döner:

```bash
T1=$(curl -s $SB/auth/v3/token -H 'Content-Type: application/json' \
  -d '{"username":"8500000001","password":"password002","scope":"profile"}' \
  | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
curl -s $SB/sms/v3/send -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
  -d '{"sender":"TESTHEADER","messages":[{"text":"a","recipient":"905551112233"}]}'
# 403 {"code":"FORBIDDEN","message":"account is not activated for this operation",...}
```

Bu yalnızca sandbox'taki bir deneme kolaylığıdır. Gerçek entegrasyonda token her zaman
`scope: "sms"` ile alınır (bkz. [auth.md](auth.md)). Yerel mock da `profile` token'ı aynı şekilde kabul
eder ve aynı `403`'leri döner.

Hesap bilgileri (`/me` ve token yanıtında görünenler):

| `username` | `user_id` | `user_code` | Ad Soyad | E-posta |
|---|---|---|---|---|
| `8500000000` | `900001` | `8500000000` | Demo Aktif | `8500000000@sandbox.example.com` |
| `8500000001` | `900002` | `8500000001` | Demo Aktivasyonsuz | `8500000001@sandbox.example.com` |
| `8500000002` | `900003` | `8500000002` | Demo IP | `8500000002@sandbox.example.com` |
| `8500000003` | `900004` | `8500000003` | Demo Ana Hesap (alt kullanıcı `4001`: Demo Alt Kullanıcı) | `8500000003@sandbox.example.com` |
| `8500000004` | `900005` | `8500000004` | Demo API | `8500000004@sandbox.example.com` |
| `8500000005` | `900006` | `8500000005` | Demo Pasif | `8500000005@sandbox.example.com` |

Demo şifreler herkese açıktır; yalnızca sandbox'ta işe yarar. Canlıda kullanıcı adı abone numaranız,
şifre API alt kullanıcınızın şifresidir (bkz. [getting-started.md](getting-started.md)).

Yerel mock aynı altı hesabı aynı şifre ve aynı sonuçlarla tanır. Mock'ta bunlara ek olarak yalnızca
mock'ta bulunan `8500000006`–`8500000010` hesapları vardır (bkz. [testing.md](testing.md#test-hesapları));
bunlar sandbox'ta `401 invalid_credentials` alır.

## SMS sandbox'ındaki sabit veri

Canlıda hesabınıza ait olan veriler sandbox'ta herkes için aynıdır:

| Veri | Sandbox'taki değer |
|---|---|
| Gönderici başlıkları (`GET /senders`) | `TESTHEADER` (alfanümerik, kullanılabilir, **varsayılan**) ve `8500000000` (abone numarası, **kullanılamaz**: `reason` `SUBSCRIBER_NUMBER_RESTRICTED`; gönderimde `422 REJECTED_HEADER`) |
| Şablonlar (`GET /templates`) | Tek şablon: `templateId` `1`, `AUTH_OTP`, herkese açık, içerik `Merhaba ${name}, kodunuz ${code}` (`name` `TEXT` en fazla 50, `code` `TEXT` en fazla 10). Başka kimlikler `400` `templates not found` alır. |
| Kara liste (`GET /blacklist`) | `5000000001`, `5000000002` |
| Rapor satırı (`GET /report`) | Her `jobId` için: numara `5000000000`, `DELIVERED`, operatör `NETGSM`, 1 parça, teslim `2026-01-01T12:00:00+03:00` |
| İstatistik (`GET /stats`) | Her `jobId` için tek `DELIVERED` satırı |
| Gelen kutusu (`GET /inbox`) | Tek mesaj: gönderen `5000000000`, metin `Sandbox inbound message` |
| Bakiye (`GET /balance`) | Bütün hesaplar için aynı: 1500 `Adet SMS` (iki kayıt), 300 `Adet OTP SMS`, 600 `Dakika` (ses), 50 `Adet Fax`, 100 `Whatsapp Authentication`, kredi 125,50 TL. Hesap faturasızdır. |

`5000000000`, `5000000001` ve `5000000002` gerçek bir aboneye ait olamayacak örnek numaralardır.

Sandbox'taki SMS uç noktaları canlıdakilerle aynıdır: `/send`, `/send/template`, `/send/otp`,
`/directory/send`, `/length`, `/cancel`, `/report`, `/stats`, `/inbox`, `/senders`,
`/senders/default` (`GET`, `PUT`), `/templates`, `/blacklist`, `/balance`. **Webhook uçları (`/webhooks/report`,
`/webhooks/inbox`) sandbox'ta yoktur** (`404 NOT_FOUND` `no such endpoint`); webhook'ları mock'ta
deneyin.

## SMS sandbox'ının canlıdan farkları

İstek doğrulaması ve hata yanıtları canlıyla aynıdır. Şu konularda farklı davranır:

| Konu | Sandbox |
|---|---|
| Gönderim | SMS gönderilmez, kaydedilmez, ücretlendirilmez; `jobId` gerçek bir gönderime karşılık gelmez. |
| İYS | İzin kontrolü yapılmaz; `iysFilter` kabul edilir ama etkisi yoktur (`REJECTED_IYS` dönmez). |
| Gönderim penceresi | `startAt` / `stopAt` denetlenmez. `/send`'de `startAt` gelecekteyse `status` `SCHEDULED` döner. |
| Bakiye | Denetlenmez; OTP'de `422 INSUFFICIENT_CREDIT` dönmez. `GET /balance` her hesap için aynı sabit bakiyeyi döner ve gönderimlerle azalmaz; canlıdaki 10 saniyelik önbellek yoktur. Faturalı hesap özeti (`stip=2` → `"0"`) sandbox'ta görülmez. |
| `/directory/send` | Grup numaralarını rehberde aramaz; her grup numarası kabul edilir. |
| `/report`, `/stats`, `/inbox` | Sabit veri döner. Tarih aralığı doğrulanır ama veriyi süzmez: hangi aralığı sorarsanız sorun aynı kayıtlar döner. |
| Bilinmeyen `jobId` | Canlıdaki `404 job not found` (`/stats`) ve `404 job not found for this account, or no longer waiting to be sent` (`/cancel`) dönmez; her `jobId` başarılı yanıt alır. |
| `PUT /senders/default` | Kaydedilmez. |
| İstek sınırları | Uygulanmaz; `429` dönmez. |
| Webhook'lar | Yok (`404`). |
| `503 SERVICE_UNAVAILABLE` | Sandbox'ta token doğrulamasına o an ulaşılamadığını gösterir; yeniden deneyin. |
| Yanıt süresi | Her istekte token doğrulandığı için yanıtlar canlıdan biraz yavaş olabilir. |

**Bilinen farklar.** Sandbox'ı denerken şu yanıtların sözleşmeden ya da sandbox'ın kendi
dokümanından farklı olduğu görülmüştür. Kodunuzu bu davranışlara göre değil sözleşmeye
([openapi.yaml](openapi.yaml)) göre yazın:

- `templates not found` mesajında kimlikler köşeli parantezsiz yazılabilir (`templates not found: 2`;
  sözleşme ve mock `templates not found: [2]`). `message`'ı tam eşitlikle karşılaştırmayın.
- `violations` listesinin sırası istekten isteğe değişebilir; alanları sıraya göre değil `field`
  değerine göre okuyun.

## Mock ile sandbox arasındaki farklar

Mock, sandbox'ın sabit verisini de taşır: her mock hesabında `TESTHEADER` başlığı, `1` numaralı şablon
ve `5000000001` / `5000000002` kara liste numaraları vardır; `profile` token ile `8500000001` ve
`8500000003` aynı `403`'leri alır; `N field(s) rejected`'daki N ihlal sayısıdır ve eksik ya da boş
`sender`, `messages`, `text`, `name`, `jobId` için `violations` mesajları aynıdır (boş `sender`:
`must not be blank` ve `size must be between 1 and 35`, iki ihlal). Diğer ihlallerin `message` metni
farklı olabilir; kodunuz `field`'a bakmalıdır. Bilinçli farklar:

| Konu | Mock | Sandbox |
|---|---|---|
| Başlıklar | `MOCKTEST` (varsayılan), `TESTHEADER`, `MOCKKAPALI` (kullanılamaz), hesabın abone numarası (kullanılabilir) | `TESTHEADER` (varsayılan), abone numarası `8500000000` kullanılamaz |
| Şablonlar | `1`, `3`, `4`, `5` | Yalnızca `1` |
| Raporlar, istatistik, gelen kutusu | Gönderimden üretilir: 5 sn sonra `DELIVERED`, `00` ile biten alıcı `NOT_DELIVERED`; gelen SMS `/__mock/inbound` ile eklenir | Sabit veri |
| Bilinmeyen `jobId` | `/stats` ve `/cancel` `404` (canlı gibi) | Başarılı yanıt |
| İYS, kredi, gönderim penceresi, istek sınırları | Uygulanır (canlı gibi) | Uygulanmaz |
| Webhook'lar | Var | Yok |
| Bakiye (`GET /balance`) | Hesaba göre değişen örnek veri (kredili, yalnızca SMS paketli, faturalı, boş); 10 sn önbellek ve dakikada 60 istek uygulanır | Her hesapta aynı sabit veri; önbellek yok, faturalı özet görülmez |
| Hata enjeksiyonu, saat, tavsiyeler | `/__mock/*` uçları | Yok |

## Identity sandbox'ı

### Örnek

```bash
curl -s $SB/auth/v3/token \
  -H 'Content-Type: application/json' \
  -d '{"username":"8500000000","password":"password001","scope":"profile"}'
```

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiJ9...",
  "token_type": "Bearer",
  "expires_in": 86400,
  "refresh_token": "4d5b2e0d-09fa-4cbe-b3f9-d325290a612e",
  "scope": "profile",
  "user_id": 900001,
  "sub_user_id": 0
}
```

```bash
curl -s $SB/auth/v3/me -H 'Authorization: Bearer <access_token>'
```

```json
{
  "user_id": 900001,
  "username": "8500000000",
  "user_code": "8500000000",
  "first_name": "Demo",
  "last_name": "Aktif",
  "email": "8500000000@sandbox.example.com",
  "contract_accepted": true
}
```

Hata örneği (`8500000001`, `scope: sms`):

```json
{
  "type": "urn:problem-type:identity:service-not-activated",
  "title": "Hizmet aktif değil",
  "status": 403,
  "detail": "Hesabınızda istenen hizmet aktif değil.",
  "instance": "/auth/v3/token",
  "code": "service_not_activated",
  "error": "invalid_scope",
  "error_description": "The requested service is not active on this account.",
  "request_id": "…",
  "denied_scopes": ["sms"]
}
```

Hata kodlarının anlamı ve yapılacaklar: [errors.md](errors.md). Uç noktaların ayrıntısı: [auth.md](auth.md).

### Identity sandbox'ının canlıdan farkları

| Konu | Canlı | Sandbox |
|---|---|---|
| Hesaplar | Gerçek abonelikler | Yalnızca yukarıdaki demo hesaplar |
| Oturumların kalıcılığı | Kalıcı | Sandbox yeniden başlatılırsa bütün token'lar geçersiz olur (`401 invalid_token`); istemci yeniden giriş yapmalıdır. İstemciniz bunu zaten doğru işlemelidir. |
| Ana hesap / alt kullanıcı oturum çakışması | Var: aynı hesapta ana hesap ve alt kullanıcı sırayla giriş yaptığında birbirlerinin önceki oturumları düşebilir | Yok; oturumlar birbirinden bağımsızdır |
| Hatalı giriş kilidi | Hesap bazlı kilit ve kullanıcı adı + IP başına dakikada 5 hatalı deneme sınırı | Hesap bazlı kilit yok; kullanıcı adı + IP başına dakikada 5 hatalı deneme sınırı aynen çalışır (`429 too_many_failed_attempts`) |

Diğer her şey (doğrulama kuralları, scope eşleme, hata gövdeleri, limitler, RateLimit başlıkları,
token ömrü) canlıyla aynıdır. `/me` yanıtı canlıdaki gibi kısa süre önbellekte tutulur: refresh'ten sonra
eski access token birkaç saniye `/me`'de geçerli görünebilir (bkz. [auth.md](auth.md#hesap-bilgisi-me)).

## Sık sorulanlar

- **Sandbox'ta SMS gönderebilir miyim?** Gönderim uçlarını çağırabilirsiniz ve gerçekçi bir `202`
  alırsınız, ama sandbox hiçbir koşulda SMS göndermez ve ücretlendirmez.
- **Hangi başlığı kullanmalıyım?** `TESTHEADER`. Abone numarası başlığı (`8500000000`) sandbox'ta
  `422 REJECTED_HEADER` (`SUBSCRIBER_NUMBER_RESTRICTED`) alır; kendi başlığınız sandbox'ta kayıtlı değildir
  (`NOT_REGISTERED`).
- **Kendi kullanıcı adım ve şifremle girebilir miyim?** Hayır, yalnızca demo hesaplar tanınır.
- **Sandbox token'ını canlıda kullanabilir miyim?** Hayır. Sandbox'ta alınan token yalnızca sandbox'ta
  geçerlidir.
- **Webhook'larımı sandbox'ta deneyebilir miyim?** Hayır, webhook uçları sandbox'ta yoktur. Mock'ta
  deneyin (bkz. [testing.md](testing.md)).
- **Hata senaryolarını (`503`, `429`, `INSUFFICIENT_CREDIT`, `REJECTED_IYS`) sandbox'ta görebilir miyim?**
  Hayır; sandbox bu kontrolleri yapmaz ve istek sınırı uygulamaz. Bunları mock'ta senaryo ya da test
  hesaplarıyla tetikleyin. Sandbox'ta görülebilen hatalar: doğrulama (`400`), başlık (`422 REJECTED_HEADER`),
  kayıtların reddi (`422 NO_DELIVERABLE_MESSAGES`), `401` ve demo hesapların `403`'leri.
- **Raporlarım neden hep aynı?** Sandbox'ın rapor, istatistik ve gelen kutusu verisi sabittir; tarih
  aralığı veriyi süzmez. Değişen raporları mock'ta deneyin.
- **Canlıya geçince ne değişir?** Base URL (`https://ext-api.netgsm.com.tr`), kimlik bilgileri (abone
  numarası, API alt kullanıcısı şifresi) ve onaylı başlığınız. Kod değişmez.
- **Sandbox'a istek atmak ücretli mi, bir şey tetikler mi?** Hayır. Sandbox hiçbir gerçek hesaba ya da
  sisteme bağlanmaz.
- **Token'ı birden çok kez aldım, sorun olur mu?** Identity limitleri canlıdaki gibi uygulanır:
  `POST /token` IP başına dakikada 30 istektir. Token'ı önbelleğe alın, her istekte yeni token almayın.
