---
name: netgsm-sms
description: >-
  Netgsm SMS API v3 ve Identity (token) API uzmanı. Netgsm ile SMS gönderimi, toplu SMS (bulk SMS),
  OTP, şablonla gönderim, iletim raporu (delivery report), gelen SMS (inbox), webhook, gönderici
  başlığı (sender), bakiye / kredi / kalan paket sorgulama (GET /sms/v3/balance), İYS, ext-api.netgsm.com.tr, Netgsm hata kodları (QUEUE_UNCONFIRMED,
  REJECTED_HEADER, E_SIGNATURE_REQUIRED, invalid_credentials vb.), 401/429/503/504, Retry-After ve rate limit
  sorularında kullan. "API key / kullanıcı adı / şifre nereden alınır", "API erişimi nasıl açılır"
  sorularını da yanıtlar. Netgsm sandbox'ı (ext-sandbox.netgsm.com.tr: SMS API ve Identity, demo hesaplar
  8500000000 vb., TESTHEADER) sorularında da kullan. Netgsm SMS API entegrasyon kodu yazarken, incelerken
  ya da abonelik olmadan yerel mock API ile test ederken kullan. Resmî doküman: api-docs.netgsm.com.tr.
  English triggers: Netgsm SMS API, send SMS, bulk SMS, OTP, delivery report, webhook, sender ID,
  account balance, sandbox, mock server, Türkiye.
---

# Netgsm SMS API v3

Bu skill, Netgsm SMS API v3 ve kimlik doğrulama (Identity) API'siyle entegrasyon yazan yazılımcıya
yardım eder. Bu dosya kuralları ve yönlendirmeyi içerir; ayrıntılar `references/` altındadır.
Yalnızca sorunun gerektirdiği referans dosyasını oku.

**Resmî doküman:** https://api-docs.netgsm.com.tr/ (SMS API v3, Identity, sandbox). Bu skill onun
özetidir; yazılımcı her zaman oraya yönlendirilir (kural 11).

**İlgili skill'ler:** İYS izin kaydı ve sorgusu, marka kodu, NetİYS → `netgsm-iys`. Gönderimdeki
`iysFilter`, `INSUFFICIENT_CREDIT` ve bakiye sorgusu (`GET /sms/v3/balance`: kredi, kalan SMS, paket ve
kampanyalar) bu skill'dedir.

## Adresler ve akış

| API | Canlı | Sandbox | Yerel mock |
|---|---|---|---|
| Identity | `https://ext-api.netgsm.com.tr/auth/v3` | `https://ext-sandbox.netgsm.com.tr/auth/v3` | `http://127.0.0.1:4010/auth/v3` |
| SMS | `https://ext-api.netgsm.com.tr/sms/v3` | `https://ext-sandbox.netgsm.com.tr/sms/v3` | `http://127.0.0.1:4010/sms/v3` |

1. `POST /auth/v3/token` gövdesi `{ "username": "<abone numarası>", "password": "<API alt kullanıcısı şifresi>", "scope": "sms" }`.
2. Yanıttaki `access_token` saklanır ve her SMS isteğine `Authorization: Bearer <access_token>` olarak eklenir.
3. `POST /sms/v3/send` ile gönderilir. 202 yanıtındaki `jobId` ile `GET /sms/v3/report` sorgulanır ya da
   rapor webhook'u (`POST /sms/v3/webhooks/report`) kaydedilir.

## Değişmez kurallar

Kod yazarken, incelerken ya da öneride bulunurken bu kurallar hiçbir zaman çiğnenmez.

1. **Token önbelleğe alınır, her istekte yeniden alınmaz.** `POST /auth/v3/token` IP başına dakikada 30
   istekle sınırlıdır. Token, `expires_in` süresi (canlıda 86400 sn, yani 24 saat) dolmadan
   `POST /auth/v3/token/refresh` ile yenilenir ve yanıttaki yeni `access_token` ile `refresh_token`
   saklanır. Yenileme, o oturumun eski access token'ını geçersiz kılar. Her süreç (pod, worker) kendi
   oturumunu tutabilir, ama aynı refresh token birden fazla süreçte koordinasyonsuz kullanılmaz.
   SMS API'den `401 UNAUTHENTICATED` ya da Identity'den `401 invalid_token` alınırsa yeniden giriş
   yapılır (`POST /auth/v3/token`) ve istek bir kez tekrarlanır.
2. **Çok alıcı tek `/send` isteğinde gönderilir.** Bir istek 1.000.000 kayda kadar taşır ve her kaydın
   kendi metni olabilir. `/send` sınırı hesap başına dakikada 50.000 **istektir**, mesaj değil. Alıcı
   başına ayrı istek atmak ya da kendi gönderim kuyruğunu yazmak gerekmez. (`/send/template` istek
   başına en fazla 20 kayıt alır.)
3. **429'da `Retry-After` kadar beklenir.** `Retry-After` başlığı yoksa (`message`
   `sending is suspended for this account`) hesabın gönderimi askıya alınmıştır. Beklemek işe yaramaz,
   tekrar denenmez ve destek ekibine başvurulur.
4. **5xx'in anlamı uç noktaya göre değişir; toplu gönderim körlemesine tekrarlanmaz.** İstekler
   tekilleştirilmez: aynı istek iki görev oluşturur.
   - `/send`, `/send/template`: `503 SERVICE_UNAVAILABLE` "servis geçici olarak kullanılamıyor" demektir;
     görev çoğunlukla kuyruğa alınmamıştır, ama bu kesin değildir. Toplu gönderim körlemesine yeniden
     gönderilmez, önce `GET /report` ile kontrol edilir. Bu uçlarda `504` yoktur.
   - `/directory/send`: `503` ya da `504 QUEUE_UNCONFIRMED` sonrası görev kuyruğa alınmış olabilir;
     yeniden göndermeden önce `GET /report` ile kontrol edilir.
   - `/send/otp`: `503` hiçbir şeyin gönderilmediğini gösterir; artan beklemeyle güvenle tekrar denenir.
   - `/cancel`: `503`, `504` ve `500` sonrası iptali tekrarlamak her zaman güvenlidir (iptal edildiyse `404`).
   - Okuma ve ayar uçlarında `503` artan beklemeyle tekrar denenir.
   - Gönderim uçlarında `500 INTERNAL_ERROR` "kuyruğa alınmış (OTP'de gönderilmiş) olabilir" diye ele
     alınır: doküman kuyruk durumunu söylemez, körlemesine tekrar denenmez. Belirsizlik sürerse
     `requestId` ile teknik desteğe danışılır.
5. **400, 403, 413 ve 422 tekrar denenmez.** Aynı istek aynı sonucu verir; istek ya da hesap düzeltilir.
6. **202 yanıtındaki `rejectedItems` her zaman işlenir.** Kısmi başarı normaldir: geçerli kayıtlar
   gönderilir, hatalılar `index` ve `reason` ile bildirilir. `accepted + rejected` istekteki kayıt
   sayısına eşittir. Liste en fazla 100 kayıt taşır, fazlası varsa `rejectedItemsTruncated` true olur.
7. **Hata mantığı HTTP durum koduna değil `code` alanına göre kurulur.** Aynı durum kodu farklı
   kodlarla gelir (örneğin 422: `REJECTED_HEADER`, `REJECTED_IYS`, `NO_DELIVERABLE_MESSAGES`,
   `INSUFFICIENT_CREDIT`).
8. **Her hata loglanırken kimliği saklanır.** SMS API'de `requestId`, Identity'de `request_id`.
   Gönderimlerde `jobId` de loglanır. Şifre, access token ve refresh token loglanmaz.
9. **Canlı API'ye istek göndermeden önce onay alınır.** `ext-api.netgsm.com.tr` adresine istek atan bir
   komutu ya da kodu çalıştırmadan önce kullanıcıya bunun gerçek hesapla çalışacağını ve gönderim
   uçlarında **gerçek, ücretli SMS** gideceğini açıkça söyle ve açık onayını al. Onay yoksa mock'u
   ya da SMS göndermeyen sandbox'ı kullan. Testler ve örnek çalıştırmalar her zaman mock'a gider.
10. **Dokümanda yoksa uydurma.** Spec'te ve bu referanslarda olmayan bir davranış, limit, alan, hata
    kodu ya da panel adımı hakkında tahmin yürütme. "Bu dokümanda yok" de; yazılımcıyı önce resmî
    dokümana ve Bilgi Bankası'na (kural 11), orada da yoksa `requestId` (SMS) ya da `request_id`
    (Identity) ile teknik desteğe (`teknikdestek@netgsm.com.tr`) yönlendir.
11. **Her yanıt resmî kaynağı gösterir.** Bir uç nokta, alan, limit ya da hata kodu hakkındaki her
    yanıtta [Resmî doküman sayfaları](#resmî-doküman-sayfaları) tablosundaki ilgili api-docs adresini
    ver (birden fazla uç nokta varsa her birininkini). Hesap, panel ve süreç konuları (gönderici adı
    talebi, API alt kullanıcısı, API erişimi, IP / ülke izni, hizmet aktivasyonu, şifre) API
    dokümanında değil Bilgi Bankası'ndadır: https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/api-ile-sms,
    https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi, genel olarak
    https://bilgibankasi.netgsm.com.tr/. Orada da yanıt yoksa [Destek](#destek) kanalları.

## Yerel mock API

Aboneliği olmayan yazılımcı da kendi makinesinde geliştirip test edebilir. Mock, gerçek API ile aynı
yolları ve aynı sözleşmeyi konuşur. Node ≥ 20 yeterlidir, `npm install` gerekmez.

```bash
# Bu skill dizininden (bu SKILL.md dosyasının bulunduğu dizinden):
node scripts/netgsm-sms-mock.mjs
# Başka bir dizinden, tam yolla:
node <skill dizini>/scripts/netgsm-sms-mock.mjs
```

Seçenekler:
`--port 4010`, `--host 127.0.0.1`, `--token-ttl <sn>` (kısa token ömrüyle yenilemeyi denemek için),
`--rate-scale <oran>` (1'den küçük değer sınırları sıkılaştırır, 429 işlemeyi denemek için), `--quiet`.

- Hazır hesap: `username` `8500000000`, `password` `password001`, `sender` `MOCKTEST` ya da
  `TESTHEADER` (sandbox'ın başlığı; ikisi de kullanılabilir).
  `8500000001`–`8500000010` hesapları kimlik, yetki ve hesap kısıtı hatalarını ve kurumsal OTP'yi (`x-client`) tetikler; listesi mock
  açılırken yazdırılır. `8500000000`–`8500000005` sandbox'ın demo hesaplarıyla aynıdır. Sandbox'ın sabit
  verisi (başlık `TESTHEADER`, şablon `1`, kara liste `5000000001` / `5000000002`) mock'ta da vardır.
- Spec örneklerindeki `NETGSM` başlığı mock'ta kayıtlı değildir. Kendi onaylı başlığını (mock'ta
  `MOCKTEST` ya da `TESTHEADER`, sandbox'ta `TESTHEADER`) kullan.
- Mock her isteği konsola doğru/yanlış diye yazar. `GET /__mock/advice` entegrasyondaki yanlış
  kalıpları listeler (alıcı başına ayrı `/send`, sık token alma, kuyruğa alınmış olabilecek gönderimi körlemesine tekrar gibi).
- Mock gerçek başlık onayını, İYS izinlerini ve operatör iletimini taklit etmez; `GET /balance` hesap
  başına sabit örnek veri döndürür ve gönderimlerle azalmaz. Gerçek API'den bilinçli farkları: loopback webhook adreslerine izin verir ve yanıtlara `X-Request-Id`
  başlığı ekler.
- Test hesaplarının tamamı, hata senaryoları, kontrol uçları ve curl örnekleri:
  [testing.md](references/testing.md).

**Mock → sandbox → canlı.**

1. **Mock:** geliştirme, otomatik testler ve sandbox'ın gösteremediği her şey: istenen anda hata
   (`503`, `504`, `500`, `429`), istek sınırları, İYS ve kredi hataları, webhook'lar, farklı iletim
   raporları, `/__mock/advice` bulguları.
2. **Sandbox** (`https://ext-sandbox.netgsm.com.tr`, `/auth/v3` ve `/sms/v3`): gerçek ağ, TLS ve token
   akışı; istek doğrulaması ve hata gövdeleri canlıyla aynı, veri sabit (`TESTHEADER`, şablon `1`).
   SMS göndermez, ücretsizdir; webhook uçları, istek sınırları, İYS / kredi / gönderim penceresi
   denetimi yoktur. Ayrıntı → [sandbox.md](references/sandbox.md).
3. **Canlı:** yalnızca base URL (`https://ext-api.netgsm.com.tr`), kimlik bilgileri ve başlık değişir.

## Sık yapılan hatalar

- **Alıcı biçimi:** Türkiye için `90` ve 10 rakam (`905061234567`), yurt dışı için `-` ve ülke koduyla
  9–17 rakam (`-4915112345678`). `+905…`, `05…` ve `5…` biçimleri `INVALID_RECIPIENT` ile reddedilir.
- **Gönderici:** `sender` kayıtlı başlıkla birebir eşleşmelidir (büyük/küçük harf dahil, kırpma yok).
  Kullanılabilir başlıklar `GET /sms/v3/senders` ile görülür.
- **Uzunluk:** En fazla `DEFAULT` 917, `TURKISH` 888, `UNICODE` 396 karakter. Alfanümerik başlık 5
  karakter tutar. Metin `POST /sms/v3/length` ile ölçülür (send ile aynı sayım).
- **OTP:** `/send/otp` tek alıcıya tek mesaj gönderir; alıcı `5…`, `05…` ya da `905…` cep numarası (başına
  `+` eklenebilir),
  gönderici büyük/küçük harf ayırmaz. Metin kırpılır ve ASCII'ye çevrilir (Türkçe harfler Latin
  karşılığına, desteklenmeyenler `?`'e); çevrilmiş metin alfanümerik başlıkta en fazla 155, abone
  numarasında 160 karakterdir. Kurumsal OTP hesabı `x-client: enterprise` gönderir, diğerleri göndermez.
  İstek sınırı yoktur. OTP `jobId`'si `GET /report` ile sorgulanamaz.
- **Rehbere gönderim:** `/directory/send` (eski `/send/directory` değil) dakikada 60 istekle sınırlıdır,
  her zaman `QUEUED` döner ve `/cancel` ile iptal edilemez.
- **Ticari ileti:** İYS izinlerine göre filtrelemek için `iysFilter` kullanılır (`BRAND`, `RETAILER`,
  `BRAND_AND_RETAILER`). Bilgilendirme iletileri için `NONE` kullanılır. İzinlerin İYS'ye
  kaydedilmesi (İYS API) `netgsm-iys` skill'indedir.
- **Rapor sorgulama:** Aynı görevin raporu dakikada bir, istatistiği 10 dakikada bir sorgulanabilir.
  Sık sorgulamak yerine rapor webhook'u kullanılır.
- **Rapor webhook'u sayısal kod taşır:** `status` (`1` iletildi, `2` iletilmedi ve nedeni `errorCode`'da,
  `3`–`22` kendi nedeniyle), `operator` ve `errorCode` sayıdır; `failReason` yoktur, `referansID` `null`
  olabilir. `GET /report` aynı bilgiyi adla verir; çeviri tablosu `endpoints/webhooks.md`'de.
- **Tür hataları:** Alanlar dokümandaki türleriyle gönderilir. Listede olmayan `encoding` (`turkish`, `GSM`),
  saat dilimsiz `startAt` ya da dizi yerine tek değer gibi yapısal uyumsuzluk `400` `1 field(s) rejected` ve
  tek `violations` kaydı alır. Yalnızca bozuk
  JSON `request body could not be read as json` alır.
- **Bakiye:** `GET /sms/v3/balance` büyük bir kampanyadan önce bir kez sorgulanır; her mesajdan önce ya da
  döngüde değil (10 sn önbellek, hesap başına dakikada 60 istek). Kayıtlar `balance_name` ile bulunur,
  `Kredi Bakiye` virgüllü metindir (`"92,150"` = 92,15 TL).

## Soruya göre nereye bakılır

- "API key, kullanıcı adı, şifre nereden alınır?", "API erişimi nasıl açılır?", ilk kurulum →
  [getting-started.md](references/getting-started.md). API v3'te ayrı bir API anahtarı kullanılmaz:
  abone numarası ve API alt kullanıcısı şifresiyle token alınır.
- Token, yenileme, oturum, scope, `401` → [auth.md](references/auth.md).
- Herhangi bir hata kodu, `message` değeri, red nedeni (`rejectedItems[].reason`) ya da iletim hata
  nedeni (`failReason`) → [errors.md](references/errors.md). Rapor webhook'undaki sayısal `status` /
  `errorCode` / `operator` kodları → [endpoints/webhooks.md](references/endpoints/webhooks.md).
- Bir uç noktanın alanları, örnekleri ve kendine özgü hataları →
  `references/endpoints/` altındaki dosyası (aşağıdaki tablo). Orada olmayan bir ayrıntı için
  [openapi.yaml](references/openapi.yaml): dosya büyüktür, tamamını okuma; ilgili yolu (`/send:`,
  `/report:` gibi) ya da şemayı arayıp o bölümü oku.
- Bakiye, kredi, kalan SMS / paket, kampanya öncesi kontrol, faturalı hesap →
  [endpoints/balance.md](references/endpoints/balance.md).
- Limitler, `429` / `Retry-After`, toplu gönderim, "kendi kuyruğumu yazmalı mıyım?", rapor sorgulama
  aralıkları, webhook mı polling mi → [limits-and-batching.md](references/limits-and-batching.md).
- Mock'u başlatma, test hesapları, hata senaryoları, `/__mock/*` uçları, canlıya geçiş →
  [testing.md](references/testing.md).
- Entegrasyon kodu yazmak, hazır istemci, "Laravel/Spring/ASP.NET/Next.js'te nasıl?" → dile göre
  `references/examples/` (aşağıdaki tablo). Kod yazarken bu örneklerin kurallarını (token önbelleği, 401'de
  bir kez yeniden giriş, `Retry-After`, gönderimde 5xx sonrası körlemesine tekrar yok (OTP'de 503 tekrarı), `rejectedItems`, `requestId`
  loglama, kimlik bilgisi ortam değişkeninden ve yalnızca sunucuda) koru.
- Identity sözleşmesinin ayrıntısı → [identity-openapi.json](references/identity-openapi.json).

## Referans haritası

| Dosya | İçerik |
|---|---|
| [references/getting-started.md](references/getting-started.md) | Ön koşullar, API alt kullanıcısı, API erişimi, IP/ülke izinleri, koda girecek bilgiler, ilk istek, canlıya geçiş |
| [references/auth.md](references/auth.md) | Identity uç noktaları, istek/yanıt örnekleri, scope, oturum modeli, limitler, önerilen token istemcisi |
| [references/errors.md](references/errors.md) | Her iki API'nin tüm hata kodları, uç nokta bazlı `message` değerleri, red ve iletim hata nedenleri, panel adımları, destek kanalları |
| [references/limits-and-batching.md](references/limits-and-batching.md) | Uç nokta başına limit tablosu (yalnızca spec'in verdiği sayılar), Identity limitleri, `Retry-After`, toplu gönderim ve parçalama, webhook'un polling'e tercihi |
| [references/sandbox.md](references/sandbox.md) | SMS API ve Identity sandbox'ı: adresler, demo hesaplar ve şifreleri, sabit veri, `profile` token ile 403 hesapları, canlıdan ve mock'tan farklar, sık sorulanlar |
| [references/testing.md](references/testing.md) | Mock'u başlatma (`node scripts/netgsm-sms-mock.mjs`; Claude Code'da `/sms-mock`), test hesapları, senaryo kodları ve curl örnekleri, `/__mock/advice`, `/__mock/inbound`, `/__mock/clock`, `--token-ttl`, `--rate-scale`, sapmalar, canlıya geçiş |
| [references/endpoints/send.md](references/endpoints/send.md) | `POST /send`: toplu SMS, alanlar, alıcı biçimi, kodlama, İYS, `rejectedItems`, `SCHEDULED` / `QUEUED` |
| [references/endpoints/send-directory.md](references/endpoints/send-directory.md) | `POST /directory/send`: rehbere SMS gönderme (gruplar ve kişiler), `addressType`, `review`, `E_SIGNATURE_REQUIRED` |
| [references/endpoints/send-template.md](references/endpoints/send-template.md) | `POST /send/template`: şablonla gönderim, `params` türleri |
| [references/endpoints/send-otp.md](references/endpoints/send-otp.md) | `POST /send/otp`: tek alıcıya OTP, `x-client`, numara ve metnin işlenmesi (karakter çevirisi) |
| [references/endpoints/length.md](references/endpoints/length.md) | `POST /length`: uzunluk ve parça hesabı, sayım kuralları |
| [references/endpoints/cancel.md](references/endpoints/cancel.md) | `POST /cancel`: zamanlanmış görevi iptal |
| [references/endpoints/report.md](references/endpoints/report.md) | `GET /report`: iletim raporları, sayfalama, görev bazlı sorgu sınırı |
| [references/endpoints/stats.md](references/endpoints/stats.md) | `GET /stats`: görev istatistikleri ve ücretlendirme |
| [references/endpoints/inbox.md](references/endpoints/inbox.md) | `GET /inbox`: gelen SMS'ler |
| [references/endpoints/senders.md](references/endpoints/senders.md) | `GET /senders`, `GET`/`PUT /senders/default`: başlıklar, `usable` / `reason` |
| [references/endpoints/templates.md](references/endpoints/templates.md) | `GET /templates`: şablon listesi |
| [references/endpoints/blacklist.md](references/endpoints/blacklist.md) | `GET /blacklist`: kara liste ve tek numara sorgusu |
| [references/endpoints/webhooks.md](references/endpoints/webhooks.md) | `/webhooks/report`, `/webhooks/inbox`: kayıt, gelen isteklerin gövdesi (rapor webhook'unun sayısal kodları ve `GET /report` karşılıkları), teslim kuralları |
| [references/endpoints/balance.md](references/endpoints/balance.md) | `GET /balance`: kalan paket, kampanya ve kredi; `stip`, `service`, virgüllü kredi, `stip=2` özeti, 10 sn önbellek, dakikada 60 istek |
| [references/examples/typescript.md](references/examples/typescript.md) | TypeScript referans istemcisinin kullanımı; Express, Next.js route handler (`app/api/sms/route.ts`), NestJS; kimlik bilgilerinin yalnızca sunucuda kalması |
| [references/examples/netgsm-client.ts](references/examples/netgsm-client.ts) | Bağımlılıksız TypeScript istemcisi (mock'a karşı test edilir): token önbelleği ve yenileme, 401, 429, uç noktaya göre 5xx, `rejectedItems` |
| [references/examples/curl.md](references/examples/curl.md) | bash + curl + jq ile token önbellekli tam gönderim betiği ve hata dalları |
| [references/examples/php.md](references/examples/php.md) | PHP (ext-curl) istemcisi; PHP-FPM'de token'ı APCu/cache'te tutma |
| [references/examples/csharp.md](references/examples/csharp.md) | C# (.NET 8, `HttpClient`, `System.Text.Json`) istemcisi; singleton kaydı |
| [references/examples/python.md](references/examples/python.md) | Python (`requests`) istemcisi |
| [references/examples/java.md](references/examples/java.md) | Java (`java.net.http.HttpClient` + Jackson) istemcisi |
| [references/openapi.yaml](references/openapi.yaml) | SMS API v3 sözleşmesi (tek doğruluk kaynağı) |
| [references/identity-openapi.json](references/identity-openapi.json) | Identity API sözleşmesi (`/auth/v3`) |

## Resmî doküman sayfaları

Ana sayfa: https://api-docs.netgsm.com.tr/introduction/

| Konu | Sayfa |
|---|---|
| `POST /send` | https://api-docs.netgsm.com.tr/send-sms/ |
| `POST /send/otp` | https://api-docs.netgsm.com.tr/send-otp/ |
| `POST /send/template` | https://api-docs.netgsm.com.tr/send-from-template/ |
| `POST /directory/send` | https://api-docs.netgsm.com.tr/send-to-directory/ |
| `POST /cancel` | https://api-docs.netgsm.com.tr/cancel-job/ |
| `POST /length` | https://api-docs.netgsm.com.tr/measure-length/ |
| `GET /report` | https://api-docs.netgsm.com.tr/read-reports/ |
| `GET /stats` | https://api-docs.netgsm.com.tr/read-stats/ |
| `GET /inbox` | https://api-docs.netgsm.com.tr/read-inbox/ |
| `GET /senders` | https://api-docs.netgsm.com.tr/list-senders/ |
| `GET /senders/default` · `PUT /senders/default` | https://api-docs.netgsm.com.tr/read-default-sender/ · https://api-docs.netgsm.com.tr/change-default-sender/ |
| `GET /templates` | https://api-docs.netgsm.com.tr/list-templates/ |
| `GET /blacklist` | https://api-docs.netgsm.com.tr/read-blacklist/ |
| `GET /balance` (bakiye, paket, kredi) | https://api-docs.netgsm.com.tr/get-balance/ |
| Rapor webhook'u (`POST` · `DELETE`) | https://api-docs.netgsm.com.tr/register-report-webhook/ · https://api-docs.netgsm.com.tr/delete-report-webhook/ |
| Gelen SMS webhook'u (`POST` · `DELETE`) | https://api-docs.netgsm.com.tr/register-inbox-webhook/ · https://api-docs.netgsm.com.tr/delete-inbox-webhook/ |
| Bölüm sayfaları: Gönderim · Raporlar ve gelen kutusu · Gönderici adları · Template · Kara liste · Webhook'lar · Hesap | https://api-docs.netgsm.com.tr/gonderim/ · https://api-docs.netgsm.com.tr/raporlar-ve-gelen-kutusu/ · https://api-docs.netgsm.com.tr/gonderici-adlari/ · https://api-docs.netgsm.com.tr/template/ · https://api-docs.netgsm.com.tr/kara-liste/ · https://api-docs.netgsm.com.tr/webhooklar/ · https://api-docs.netgsm.com.tr/hesap/ |
| Identity: token alma · yenileme | https://api-docs.netgsm.com.tr/auth/token/ · https://api-docs.netgsm.com.tr/auth/refresh-token/ |
| SMS API sandbox'ı | https://api-docs.netgsm.com.tr/sandbox/sms-api-v-3-sandbox/ |
| Hesap, panel, süreç (başlık talebi, API alt kullanıcısı, API erişimi, IP izni, aktivasyon) | Bilgi Bankası: https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/api-ile-sms · https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi · https://bilgibankasi.netgsm.com.tr/ |

## Destek

Önce resmî doküman ve Bilgi Bankası (yukarıda); yanıt orada yoksa:

| Kanal | Bilgi | Ne zaman |
|---|---|---|
| Çağrı merkezi (SMS) | `+90 850 303 0 303` · `+90 312 911 0 911` | Hizmet aktivasyonu, 403'ler, acil durumlar |
| Teknik destek | `teknikdestek@netgsm.com.tr` | API hataları, `requestId` / `request_id` ile bildirimler, belirsiz gönderimler (`503` / `504`), `E_SIGNATURE_REQUIRED` |
| Abonelik işlemleri | `abone.islemleri@netgsm.com.tr` | Hizmet aktivasyonu, alt kullanıcı ve hesap işlemleri |

API v3 dokümantasyonu (birincil kaynak): https://api-docs.netgsm.com.tr/ · Bilgi Bankası:
https://bilgibankasi.netgsm.com.tr/ · Portal: https://portal.netgsm.com.tr
