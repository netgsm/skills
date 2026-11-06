# Hata kodları ve yapılacaklar

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/introduction/ (ortak hata biçimi ve kodlar); her uç noktanın kendi
hataları o uç noktanın sayfasında: https://api-docs.netgsm.com.tr/send-sms/, https://api-docs.netgsm.com.tr/send-otp/, https://api-docs.netgsm.com.tr/send-from-template/,
https://api-docs.netgsm.com.tr/send-to-directory/, https://api-docs.netgsm.com.tr/cancel-job/, https://api-docs.netgsm.com.tr/read-reports/, https://api-docs.netgsm.com.tr/read-stats/, https://api-docs.netgsm.com.tr/read-inbox/,
https://api-docs.netgsm.com.tr/list-senders/, https://api-docs.netgsm.com.tr/change-default-sender/, https://api-docs.netgsm.com.tr/list-templates/, https://api-docs.netgsm.com.tr/read-blacklist/,
https://api-docs.netgsm.com.tr/measure-length/, https://api-docs.netgsm.com.tr/register-report-webhook/. Identity hataları: https://api-docs.netgsm.com.tr/auth/token/,
https://api-docs.netgsm.com.tr/auth/refresh-token/. Hesap ve panel adımları (aktivasyon, IP izni, alt kullanıcı):
https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/api-ile-sms.

Bu dosya SMS API v3 ve Identity API'nin bütün hata kodlarını, uç noktalara özgü `message` değerlerini,
kayıt red nedenlerini ve iletim hata nedenlerini anlatır. Kaynak: [openapi.yaml](openapi.yaml) ve
[identity-openapi.json](identity-openapi.json). Burada olmayan bir kod ya da davranış için tahmin
yürütülmez; yazılımcı önce resmî dokümana ve Bilgi Bankası'na (https://bilgibankasi.netgsm.com.tr/),
orada da yoksa `requestId` / `request_id` ile teknik desteğe yönlendirilir.

**Üç temel kural**

1. Hata mantığı HTTP durum koduna değil `code` alanına göre kurulur.
2. Her hata `requestId` (SMS) ya da `request_id` (Identity) ile loglanır; gönderimlerde `jobId` de.
3. `400`, `403`, `413` ve `422` tekrar denenmez: aynı istek aynı sonucu verir.

"Tekrar" sütunu: **Evet** = aynı istek değiştirilmeden tekrar denenebilir. **Hayır** = istek ya da
hesap düzeltilmeden tekrar denenmez. **Koşullu** = yalnızca belirtilen koşulla.

## Hızlı karar tablosu

| Yanıt | Tekrar | Ne yapılır |
|---|---|---|
| SMS `401 UNAUTHENTICATED` | Koşullu | Yeniden giriş yapılır (`POST /auth/v3/token`), istek yeni token ile **bir kez** tekrarlanır. Yine 401 ise kimlik bilgileri ve hesap kontrol edilir. |
| SMS `429 RATE_LIMITED`, `Retry-After` var | Evet | `Retry-After` saniye kadar beklenir. |
| SMS `429 RATE_LIMITED`, `Retry-After` yok (`sending is suspended for this account`) | Hayır | Gönderim askıya alınmış; beklemek işe yaramaz. Destek ekibine başvurulur. |
| SMS `503 SERVICE_UNAVAILABLE`, `/send` ve `/send/template` | Koşullu | Servis geçici olarak kullanılamıyor; görev çoğunlukla kuyruğa alınmamıştır (her zaman değil). Körlemesine tekrar yok: önce `GET /report` ile kontrol ([503 ve 504 sonrası kontrol](#503-ve-504-sonrası-kontrol)); görev yoksa yeniden gönderilir. |
| SMS `503` ya da `504 QUEUE_UNCONFIRMED`, `/directory/send` | Koşullu | Görev kuyruğa alınmış olabilir. Yeniden göndermeden önce `GET /report` ile kontrol edilmelidir. |
| SMS `503`, `/send/otp` | Evet | Hiçbir şey gönderilmedi. Artan beklemeyle (örneğin 1, 2, 4 sn) tekrar denenir. |
| SMS `503`, `504` ya da `500`, `/cancel` | Evet | İptali yeniden göndermek her zaman güvenlidir; görev iptal edildiyse `404` döner. |
| SMS `503`, diğer uç noktalar | Evet | Hiçbir şey yapılmadı. Artan beklemeyle (örneğin 1, 2, 4 sn) tekrar denenir. |
| SMS `500 INTERNAL_ERROR` | Koşullu | Okuma isteklerinde kısa süre sonra tekrar. Gönderim uçlarında (`/send`, `/send/template`, `/directory/send`, `/send/otp`) doküman kuyruk durumunu söylemez: kuyruğa alınmış (OTP'de gönderilmiş) olabilir gibi davranılır, körlemesine tekrar yok. `requestId` ile bildirilir. |
| SMS `400`, `403`, `413`, `422` | Hayır | `code`, `message` ve `violations`'a göre istek ya da hesap düzeltilir. |
| SMS `404 NOT_FOUND` | Hayır | Yol ya da kimlik (`jobId`, `month`) kontrol edilir. |
| SMS `409 ALREADY_EXISTS` | Koşullu | Webhook zaten kayıtlıysa önce silinir. Başka bir kayıt sürüyorsa o bitince tekrar gönderilir. |
| Identity `429` | Koşullu | `Retry-After` kadar beklenir. `too_many_failed_attempts`'te önce kimlik bilgisi düzeltilir. |
| Identity `500`, `502`, `503` | Evet | İstek değiştirilmeden bir süre sonra tekrar denenir; `503`'te `Retry-After` varsa ona uyulur. |
| Identity diğer `4xx` | Hayır | `code`'a göre düzeltilir (aşağıdaki tablolar). |

## SMS API hata yapısı

Bütün SMS API hataları aynı `ApiError` yapısıyla döner:

```json
{
  "code": "REJECTED_HEADER",
  "message": "NOT_REGISTERED",
  "requestId": "ca6fa668966d42169e615c6d236191e2",
  "timestamp": "2026-09-07T16:42:31.123+03:00",
  "violations": null
}
```

| Alan | Açıklama |
|---|---|
| `code` | Makine tarafından okunan hata kodu. Mantık buna göre kurulur. |
| `message` | Okunabilir ayrıntı. Bazı kodlarda sabit değerler alır (aşağıdaki uç nokta tabloları). |
| `requestId` | İsteğe özgü 32 onaltılık karakter. Destek talebinde paylaşılır. |
| `timestamp` | Saat dilimli ISO-8601. |
| `violations` | Yalnızca gövde doğrulamasından gelen `INVALID_REQUEST`'te dolu (`[{ field, message }]`), aksi halde `null`. |
| `rejectedItems`, `rejectedItemsTruncated` | Yalnızca `NO_DELIVERABLE_MESSAGES`'ta bulunur; 202 yanıtındaki listeyle aynı biçim. |

Her uç noktada görülebilecek genel durumlar:

| HTTP | `code` | Ne zaman |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. |
| 404 | `NOT_FOUND` | Adres yok. |
| 405 | `INVALID_REQUEST` | Adres bu metodu desteklemiyor; desteklenenler `Allow` başlığında. |
| 406 | — | `Accept` başlığı JSON'u kabul etmiyor. Yanıtın gövdesi yoktur. |
| 413 | `INVALID_REQUEST` | Gövde 500 MB'ı aşıyor. |
| 415 | `INVALID_REQUEST` | Gövde JSON değil ya da sıkıştırılmış (`Content-Encoding` yalnızca `identity` olabilir). |
| 503 | `SERVICE_UNAVAILABLE` | Servis isteği şu an kabul edemiyor. Gönderim uçlarındaki anlamı uç noktaya göre değişir (yukarıdaki tablo). |

## SMS API kodları

| Kod | HTTP | Anlamı | Olası neden | Ne yapılır | Tekrar |
|---|---|---|---|---|---|
| `UNAUTHENTICATED` | 401 | Bearer token yok, geçersiz ya da süresi dolmuş. `message`: `no bearer token` ya da `invalid or expired token`. | `Authorization` başlığı eksik ya da `Bearer <token>` biçiminde değil; token'ın süresi doldu; token refresh ile yenilendi ve eskisi kullanıldı; oturum revoke edildi; aynı hesapta başka bir kimlikle giriş oturumu düşürdü. | Yeniden giriş, isteği bir kez tekrar. Token'ı her istekte almak çözüm değildir. | Koşullu |
| `SERVICE_UNAVAILABLE` | 503 | Servis geçici olarak kullanılamıyor. Okuma uçlarında, ayar uçlarında ve `/send/otp`'de hiçbir şey yapılmadı. `/send` ve `/send/template`'te görev çoğunlukla kuyruğa alınmamıştır (her zaman değil). `/directory/send`'de görev kuyruğa alınmış olabilir. `/cancel`'da görev büyük olasılıkla iptal edilmedi. | Geçici bir sorun. | Okuma ve ayar uçlarında, `/send/otp`'de ve `/cancel`'da artan beklemeyle tekrar. `/send`, `/send/template` ve `/directory/send`'de önce `GET /report` ile kontrol ([503 ve 504 sonrası kontrol](#503-ve-504-sonrası-kontrol)). Uzun sürerse `requestId` ile teknik destek. | Koşullu |
| `FORBIDDEN` | 403 | Hesap ya da alt kullanıcı bu işlemi yapamaz. `message` nedeni söyler (aşağıda). | Alt kullanıcının SMS yetkisi yok, hesapta SMS gönderim/alım hizmeti açık değil, hedef operatöre gönderim yapılamıyor ya da `/send/otp`'de `x-client` başlığı hesabın OTP hizmetine uymuyor. | Alt kullanıcıysa önce SMS yetkisi kontrol edilir (`sub_user_not_permitted` adımı). `/send/otp`'de önce `x-client` kullanımı kontrol edilir. Değilse ya da sürüyorsa çağrı merkezi veya diğer destek kanalları (`requestId` ile). | Hayır |
| `E_SIGNATURE_REQUIRED` | 403 | `/directory/send`: bu gönderim için hesapta e-imza ile giriş gerekiyor. `message` `the requested menu requires an e-signature login on the account`. | Hesapta e-imzalı giriş yapılmamış. | Kodla çözülmez. Hesaba e-imza ile giriş yapılması gerekir; nasıl yapılacağı bu dokümanda yok: `requestId` ile çağrı merkezi ya da teknik destek. Ayrıntı [aşağıda](#e_signature_required-403). | Hayır |
| `ALREADY_EXISTS` | 409 | Webhook kaydı var ya da hesap için başka bir kayıt sürüyor. | Hesap başına bir rapor ve bir gelen SMS webhook'u olabilir; var olanın üzerine yazılmaz. | Adres değişecekse önce `DELETE`, sonra `POST`. Kayıt sürüyorsa o tamamlanınca tekrar. | Koşullu |
| `NOT_FOUND` | 404 | Adres ya da kayıt yok. | Yolda `/sms/v3` öneki eksik ya da yol yanlış (`message` `no such endpoint`); `/cancel`'da bekleyen görev yok (hiç olmadı, başka hesaba ait, zaten gönderildi ya da daha önce iptal edildi); `/stats`'ta görev o ayda yok (`message` `job not found`); webhook silmede kayıtlı webhook yok. | Yolu ve `jobId`'yi kontrol edin. `/stats`'ta `month`'u görevin gönderildiği aya (`yyyy-MM`) ayarlayın. | Hayır |
| `INVALID_REQUEST` | 400, 405, 413, 415 | İstek biçimi geçersiz. | Gövde doğrulaması (`violations` alanları söyler), yapısal olarak türüne uymayan değer (listede olmayan `encoding`, saat dilimi farkı olmayan tarih, dizi yerine tek değer; `1 field(s) rejected`, tek ihlal), gövde geçerli bir JSON değil, sorgu parametresi hatalı (`message` parametreyi söyler), `/send`'de 1.000.000'dan fazla mesaj, `/directory/send`'de `UNICODE`, grup/kişi yok ya da metin çok uzun, `/send/otp`'de geçersiz numara ya da çevrilmiş metin çok uzun, `/send/template`'te şablon ya da parametre hatası, `/balance`'ta geçersiz `service`; 405 metot; 413 gövde 500 MB üstü ya da toplu gönderim kuyruğa alınamayacak kadar büyük; 415 JSON değil ya da sıkıştırılmış. | `violations` ve `message`'a göre düzeltin. 413'te gönderimi birden fazla isteğe bölün. | Hayır |
| `INVALID_SEND_WINDOW` | 400 | Gönderim aralığı geçersiz. | `/send` ve `/send/template`'te `startAt` 18 aydan daha ileride; `/directory/send`'de platform aralığı kabul etmedi (`message` `the send window was rejected`; orada `stopAt`, `startAt`'tan 1 ile 21 saat sonra olmalıdır). | `startAt` / `stopAt` düzeltilir. | Hayır |
| `REJECTED_HEADER` | 422 | Gönderici başlığı bu hesapta kullanılamıyor. `message` ret adıdır (aşağıda). | Başlık kayıtlı değil, büyük/küçük harf farklı, hesapta hiç başlık yok, yönlendirme kodu eksik ya da abone numarasından gönderim kısıtlı. | `GET /senders` ile kayıtlı başlıkları ve `usable` / `reason` değerlerini görün; kayıtlı hâliyle birebir yazın. Gerekirse başlık talebi açın. | Hayır |
| `REJECTED_IYS` | 422 | İstenen İYS filtresi uygulanamıyor. | `/send` ve `/send/template`'te: hesap İYS modunda değil ve `iysFilter` `BRAND` ya da `RETAILER`; ya da bu iki filtreden biri uygulanacak ama başlığın İYS marka kodu yok (`GET /senders`'ta `brandCode` 0). `BRAND_AND_RETAILER` için bu kontroller yapılmaz. `/directory/send`'de platform filtreyi uygulayamadı. | `iysFilter` kullanımını kontrol edin. Bilgilendirme iletisinde `NONE` kullanılır. Hesabı İYS moduna almak ya da başlığa marka kodu tanımlamak için destek ekibiyle görüşün (`requestId` ile). | Hayır |
| `NO_DELIVERABLE_MESSAGES` | 422 | Kayıtların hepsi reddedildi, görev oluşturulmadı. `message` `all N messages rejected`. | Her kaydın nedeni `rejectedItems` içinde (bkz. [Kayıt red nedenleri](#kayıt-red-nedenleri)). | `rejectedItems[].reason`'a göre kayıtları düzeltin. | Hayır |
| `INSUFFICIENT_CREDIT` | 422 | `/send/otp`: OTP gönderimini karşılayacak kredi, paket ya da kampanya yok. `message` `no credit, package or campaign to pay for the otp`. Hiçbir şey gönderilmedi. | Bakiye ya da paket bitmiş. | Paket tanımlayın ya da bakiye yükleyin (https://www.netgsm.com.tr/fiyatlar/toplu-sms), sonra tekrar deneyin. | Koşullu |
| `RATE_LIMITED` | 429 | Uç noktanın sınırı aşıldı ya da hesabın gönderimi askıya alındı; `message` hangisi olduğunu söyler. | Alıcı başına ayrı istek, sık rapor/istatistik sorgusu, aynı görevin tekrar sorgulanması. | `Retry-After` kadar bekleyin. `Retry-After` yoksa tekrar denemeyin, destek ekibine başvurun. Toplu gönderim ve webhook kullanın. | Koşullu |
| `QUEUE_UNCONFIRMED` | 504 | Yalnızca `/directory/send` ve `/cancel`. Gönderim (ya da iptal) iletildi ama yanıtı alınamadı; görev kuyruğa alınmış (ya da iptal edilmiş) olabilir. | İstek iletildi ama yanıtı alınamadı. | `/directory/send`: **körlemesine tekrar yok**, önce `GET /report` ile kontrol edin, belirsizse `requestId` ile teknik destek. `/cancel`: iptali yeniden gönderin; iptal edildiyse `404` döner. Ayrıntı [aşağıda](#503-ve-504-sonrası-kontrol). | Koşullu |
| `INTERNAL_ERROR` | 500 | Beklenmeyen hata. `message` `internal error`. | Sunucu tarafı. | `requestId` ile teknik desteğe bildirin. Okuma isteklerini ve `/cancel`'ı kısa süre sonra tekrarlayın; gönderim isteklerinde kuyruğa alınmış olabilir gibi davranın. | Koşullu |

`INSUFFICIENT_CREDIT` toplu gönderimin iletim raporunda da `failReason` olarak görülebilir (bkz.
[İletim hata nedenleri](#iletim-hata-nedenleri)).

## Uç noktaya göre `message` değerleri

### `FORBIDDEN` (403)

Gönderim uçlarında (`/send`, `/directory/send`, `/send/template`, `/send/otp`) `message` şunlardan biridir:

| `message` | Anlamı | Ne yapılır |
|---|---|---|
| `account is not activated for this operation` | Hesapta SMS gönderimi etkin değil. | Hizmet aktivasyonu yazılımcının yapabileceği bir işlem değildir: çağrı merkezi ya da diğer destek kanalları (`requestId` ile). |
| `sub user may not use the sms api` | Alt kullanıcının SMS API'sini kullanma izni yok. | Alt kullanıcının yetkilerinde SMS hizmetini işaretleyin (bkz. [Panel adımları](#hata--yapılacak-iş-panel-adımları)). |
| `account operator is not served for this operation` | `/send`, `/send/template`, `/directory/send`: hesabın operatörüne bu uç noktadan hizmet verilmiyor. `/send/otp`: hesap bu OTP hizmetine tanımlı değil; kurumsal OTP hesabı `x-client: enterprise` göndermedi ya da kurumsal olmayan bir hesap bu başlıkla istek yaptı. | `/send/otp`'de `x-client` başlığını hesabınıza göre düzeltin: yalnızca kurumsal OTP hizmeti tanımlı hesaplar `enterprise` (küçük harfle) gönderir. Diğer durumlarda çağrı merkezi ya da diğer destek kanalları (`requestId` ile). |
| `account is not permitted to send` | Platform, hesabın gönderim yetkisi olmadığını bildirdi (yalnızca `/directory/send`). | Çağrı merkezi ya da diğer destek kanalları (`requestId` ile). |

Diğer uç noktalarda 403 anlamı:

| Uç nokta | Anlamı |
|---|---|
| `/inbox` | Hesapta gelen SMS etkin değil ya da SMS menüsü olmayan bir alt kullanıcı. |
| `/report`, `/stats`, `/cancel`, `/senders`, `/senders/default`, `/webhooks/report`, `/webhooks/inbox` | SMS menüsü olmayan bir alt kullanıcı (`/cancel`'da `message` `sub user may not use the sms api`). |

### `E_SIGNATURE_REQUIRED` (403)

Yalnızca `/directory/send`'de, `FORBIDDEN`'dan ayrı bir `code` olarak gelir:

| `message` | Anlamı | Ne yapılır |
|---|---|---|
| `the requested menu requires an e-signature login on the account` | Bu gönderim için hesapta e-imza ile giriş gerekiyor. | Kodla ya da istekle çözülmez; tekrar denemeyin. Hesaba e-imza ile giriş yapılması gerekir. Bunun nasıl yapılacağı bu dokümanda yok: `requestId` ile çağrı merkezine (`+90 850 303 0 303` · `+90 312 911 0 911`) ya da teknik desteğe (`teknikdestek@netgsm.com.tr`) başvurun. |

Hata mantığını `code`'a göre kuruyorsanız `403`'ü yalnızca `FORBIDDEN` sanmayın: `/directory/send`'de
`E_SIGNATURE_REQUIRED`'ı ayrıca ele alın.

### `REJECTED_HEADER` (422)

Gönderim uçlarında `message` şunlardan biridir. `PUT /senders/default` yalnızca ilk üçünü döndürür.
`/send/otp`'de gönderici büyük/küçük harf ayırmadığı için `CASE_MISMATCH` yoktur.

| `message` | Anlamı | Ne yapılır |
|---|---|---|
| `NO_HEADERS_REGISTERED` | Hesapta kayıtlı başlık yok. | Başlık talebi: https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi |
| `NOT_REGISTERED` | `sender` hesaba kayıtlı değil. | `GET /senders` ile kayıtlı başlıkları görün. Abone numarası başında `0` ya da `90` olmadan yazılır. |
| `CASE_MISMATCH` | Başlık kayıtlı ama büyük/küçük harfi farklı yazılmış. | `GET /senders`'taki `name` değerini birebir kullanın. |
| `ROUTING_CODE_MISSING` | Alfanümerik başlık için hesapta yönlendirme kodu tanımlı değil. | Kodla çözülmez; destek ekibiyle görüşün (`requestId` ile). |
| `SUBSCRIBER_NUMBER_RESTRICTED` | Hesapta abone numarasından gönderim kısıtlı. | Onaylı bir alfanümerik başlık kullanın ya da destek ekibiyle görüşün. |

Abone numarasından gönderime onaylı olmayan bir hesapta, tamamı rakamlardan oluşan bir `sender` için
`NOT_REGISTERED` ve `NO_HEADERS_REGISTERED` mesajlarının sonuna
` (subscriber number headers were not offered)` eklenir (`/send`, `/send/template`, `/directory/send`;
`/send/otp`'de eklenmez). `message`'ı tam eşitlikle değil, bu eki dikkate alarak karşılaştırın.

`GET /senders` her başlık için `usable` ve kullanılamıyorsa `reason` (`ROUTING_CODE_MISSING`,
`SUBSCRIBER_NUMBER_RESTRICTED`) döndürür; gönderimden önce kontrol için kullanılır.
`PUT /senders/default` kullanılamayan bir başlığı da varsayılan yapar: hata değil, `200` ile
`usable: false` ve `reason` döner.

### `REJECTED_IYS` (422)

| `message` | Uç nokta | Anlamı |
|---|---|---|
| `sender header has no iys brand code` | `/send`, `/send/template` | `BRAND` ya da `RETAILER` filtresi uygulanacak ama başlığın İYS marka kodu yok. |
| `account is not in iys mode, filtering cannot be applied` | `/send`, `/send/template` | Hesap İYS modunda değil; `iysFilter` `BRAND` ya da `RETAILER` olamaz. |
| `consent filtering cannot be applied to this sender or account` | `/directory/send` | Platform, istenen İYS filtresini bu başlık ya da hesap için uygulayamadı. |

`iysFilter` değerleri: `NONE` (filtre yok; yalnızca bilgilendirme iletileri), `BRAND`, `RETAILER`,
`BRAND_AND_RETAILER`. Büyük/küçük harf fark etmez; bunların dışındaki her değer `NONE` sayılır (üç
gönderim ucunda da). Hesap ticari gönderim (marka ya da bayi) tipinde tanımlıysa istekteki değer yok
sayılır ve hesabın tipi uygulanır. `/send` ve `/send/template`'te marka kodu ve İYS modu kontrolleri
yalnızca `BRAND` ve `RETAILER` için yapılır; `BRAND_AND_RETAILER` bu iki kontrolden muaftır.

### `RATE_LIMITED` (429)

| Uç nokta | Sınır (hesap başına) | `message` | Not |
|---|---|---|---|
| `/send` | Dakikada 50.000 istek | `send rate limit exceeded` | Reddedilen istekler sınıra sayılmaz. |
| `/send` | — (gönderim askıya alınmış; `Retry-After` yok) | `sending is suspended for this account` | Beklemek işe yaramaz; destek ekibine başvurulur. |
| `/send/template` | Dakikada 1000 istek, `/send`'den ayrı | `template send rate limit exceeded` | Reddedilen istekler de sayılır. |
| `/directory/send` | Dakikada 60 istek, `/send`'den ayrı | `directory send rate limit exceeded` | — |
| `/cancel` | Dakikada 25.000 istek | `cancel rate limit exceeded` | — |
| `/templates` | Dakikada 20 istek | `template list rate limit exceeded` | Reddedilen istekler de sayılır. |
| `/report` | Dakikada 60 istek; ayrıca istekteki bir `jobId` son bir dakika içinde sorulmuşsa | `message` hangisi olduğunu söyler | — |
| `/stats` | Dakikada 60 istek; ayrıca aynı `jobId` son 10 dakika içinde sorulmuşsa | `message` hangisi olduğunu söyler | İki sayaç da okuma 404 ya da 503 ile bitse bile işler. |
| `/blacklist` | Dakikada 60 istek; ayrıca aynı sorgu (aynı `page` ve `number`) son 10 dakika içinde yanıtlanmışsa | `message` hangisi olduğunu söyler | Hatayla biten bir sorgu beklemeden tekrar gönderilebilir. |
| `/balance` | Dakikada 60 istek | `balance rate limit exceeded` | Her istek sayılır. Bakiye döngüde sorgulanmaz; yanıt zaten 10 sn önbellektedir ([balance.md](endpoints/balance.md)). |
| Diğer uç noktalar | Spec sayı vermez | `message` sınırı belirtir | `429` ve `Retry-After`'a göre davranın. |

- `/send`, `/send/template`, `/directory/send`, `/cancel`, `/templates` ve `/balance` sınırlarında pencere
  ilk istekle başlar ve sabittir. `Retry-After` yeniden denemeden önce beklenecek saniyedir.
- `/send/otp`'de istek sınırı yoktur; spec bu uç nokta için `429` tanımlamaz.
- Ortak 429 tanımına göre `Retry-After` yalnızca hesabın gönderimi askıya alındığında bulunmaz.
  `Retry-After` yoksa beklemek işe yaramaz; tekrar denenmez ve destek ekibine başvurulur.
- `/report` ya da `/stats`'ta görev bazlı 429 alıyorsanız durumu sorgulayarak takip etmek yerine rapor
  webhook'u (`POST /webhooks/report`) kullanın.

### `INVALID_REQUEST` (400) için öne çıkan `message` değerleri

**Türü uymayan değer (bütün JSON gövdeli uçlar).** Alanları dokümandaki türleriyle gönderin. Gövde geçerli
bir JSON olduğu hâlde bir alanın değeri yapısal olarak türüne uymuyorsa (aşağıdaki tablo) istek `400 INVALID_REQUEST`, `message` `1 field(s) rejected` ile reddedilir ve
`violations` **tek** ihlal taşır: okuma gövdedeki sırayla ilk hatalı alanda durur. Bu kontrol diğer alan
doğrulamalarından önce çalışır; tetiklendiğinde diğer ihlaller (örneğin eksik `sender`) bildirilmez,
düzeltip yeniden gönderdiğinizde görünür. Reddedilen değer yanıtta yer almaz. `field` bir yoldur:
`encoding`, `startAt`, `messages[2].recipient`, `templates[0].params.code` gibi.

Reddedilen durumlar:

| Beklenen | `violations[].message` | Reddedilen örnek |
|---|---|---|
| Listedeki bir değer | `must be one of DEFAULT, TURKISH, UNICODE (case sensitive)` | `encoding`: listede olmayan ya da harfi farklı ad (`turkish`, `GSM`, `Unicode`), `true`, nesne |
| Saat dilimi farkı olan tarih | `must be an ISO-8601 date-time with an offset, e.g. 2026-09-10T09:00:00+03:00` | `startAt`: `2026-09-10T09:00:00` (fark yok), `yarın`, `true`, nesne |
| Dizi | `must be an array` | `messages`: `"x"` ya da tek bir nesne; `groupIds`: `7` (tek değer diziye çevrilmez) |
| Sayı | `must be a number` | `templateId`: `"abc"`, `groupIds[0]`: `true`, nesne ya da dizi |
| `true` / `false` | `must be true or false` | `alphanumericSender`: `"evet"`, nesne |
| Metin | `must be a string` | `messages[0].recipient`: nesne ya da dizi (`["905061234567"]`) |
| Diğer | `has an invalid value` | `messages[1]`: `7` (kayıt nesne değil) |

Yalnızca JSON sözdizimi hatası (bozuk gövde) `request body could not be read as json` alır;
`violations` o zaman `null`'dır. `encoding` büyük/küçük harfe duyarlıdır: `turkish` sözdizimi hatası
değil, `encoding` alanının ihlalidir.

`/send` (`/send/template` aynı alan kurallarını paylaşır: `sender`, `encoding`, `startAt`, `stopAt`):

| `message` | Anlamı |
|---|---|
| `N field(s) rejected` | Alanlar doğrulamadan geçmedi: `sender` eksik, boş ya da 35 karakterden uzun, `messages` eksik ya da boş, ya da bir alan uzunluk sınırını aşıyor. `violations` hangi alanın neden reddedildiğini söyler. N ihlal sayısıdır, alan sayısı değil: boş `sender` hem `must not be blank` hem `size must be between 1 and 35` alır (iki ihlal). |
| `1 field(s) rejected` (tür) | Bir değer türüne uymuyor: `encoding` listede olmayan bir değer (`turkish`, `GSM` dahil), `startAt` / `stopAt` saat dilimi farkı olan bir tarih değil, `messages` dizi değil gibi. Tek ihlal; `encoding` için geçerli değerler `violations`'ta listelenir (yukarıdaki tablo). |
| `request body could not be read as json` | Gövde geçerli bir JSON değil (sözdizimi hatası). `violations` `null`. |
| `N messages exceeds the limit of 1000000` | 1.000.000'dan fazla mesaj. |

`/send/template`:

| `message` | Anlamı |
|---|---|
| gövde doğrulaması, `violations` ile | Zorunlu alan eksik, 20'den fazla kayıt, bir kaydın `recipient`'ı boş ya da 17 karakterden uzun (`violations` alanı belirtir, örn. `templates[0].recipient`). Türü uymayan değer (`templateId` metin, `params` değeri sayı gibi) `1 field(s) rejected` ile tek ihlal alır. |
| `templates not found: [4]` | Şablon yok, silinmiş ya da başka bir hesaba ait; bu durumlar ayrılmaz. `GET /templates` ile kullanılabilir şablonlara bakın. |
| `Invalid params for templateId 3. Missing params: [otpCode]` | Şablonun bir parametresi verilmemiş ya da boş. |
| `Invalid params for templateId 3. Unexpected params: [code]` | Şablonda olmayan bir parametre verilmiş. |
| `param 'otpCode' is not a valid BIGINT` | Değer parametrenin türüne ya da uzunluğuna uymuyor; `message` parametreyi söyler. |

`/send/template`'te şablon hataları isteğin tamamını reddeder, hiçbir şey gönderilmez. Şablonlar
doldurulduktan sonra kayıtlar `/send`'deki gibi tek tek değerlendirilir ve `rejectedItems`'ta bildirilir.

`/directory/send`:

| `message` | Anlamı |
|---|---|
| `N field(s) rejected` | Alanlar doğrulamadan geçmedi (eksik `sender` ya da `text`, uzunluk sınırları, `addressType` 0–17 dışında, `contacts[].number` boş) ya da bir değer türüne uymuyor (`encoding` listede yok, tarih saat dilimi farkı olmadan yazılmış gibi; tek ihlal). `violations` belirtir. |
| `request body could not be read as json` | Gövde geçerli bir JSON değil. |
| `encoding UNICODE is not supported for directory sends` | `encoding` `UNICODE`. |
| `a directory send names at least one group or contact; for numbers alone use /sms/v3/send` | `groupIds` ve `contacts` ikisi de boş. |
| `text exceeds N characters for this encoding and sender` | Metin sınırı aşıyor (`DEFAULT` 917, `TURKISH` 888; alfanümerik başlıkta 5 eksik). |
| `a required field is missing` | Platform eksik bir alan bildirdi. |

`/send/otp`:

| `message` | Anlamı |
|---|---|
| `N field(s) rejected` | `sender`, `text` ya da `recipient` eksik veya boş, ya da metin yerine nesne veya dizi (tek ihlal, `must be a string`). `violations` belirtir. |
| `request body could not be read as json` | Gövde geçerli bir JSON değil. |
| `recipient is not a valid number` | `recipient` bir Türkiye cep numarası değil (`5XXXXXXXXX`, `05XXXXXXXXX` ya da `905XXXXXXXXX`, başına `+` eklenebilir; boşluk ya da yurt dışı numarası olmaz). |
| `text is longer than 155 characters for this sender` | Çevrilmiş metin alfanümerik başlıkta 155, abone numarasında 160 karakteri aşıyor (abone numarasında `message` `160` yazar). |

OTP metni reddedilmez, çevrilir: Türkçe harfler ASCII karşılığına, desteklenmeyen karakterler `?`'e
döner ve uzunluk çevrilmiş metne göre sayılır (tablo: [send-otp.md](endpoints/send-otp.md)).

`/cancel`:

| `message` | Anlamı |
|---|---|
| `1 field(s) rejected` | `jobId` eksik, boş, yalnızca boşluktan oluşuyor, 64 karakterden uzun ya da nesne veya dizi. |
| `request body could not be read as json` | Gövde geçerli bir JSON değil. |

`/templates`:

| `message` | Anlamı |
|---|---|
| `page must not be negative` | `page` negatif. |
| `size must be between 1 and 100` | `size` aralık dışında. |
| `type must be at most 100 characters` | Bir filtre (`type`, `search`, `content`) 100 karakterden uzun. |

Diğer uç noktalarda `INVALID_REQUEST` nedenleri:

| Uç nokta | Neden |
|---|---|
| `/length` | `text` yok ya da 10000 karakterden uzun, `encoding` bilinmiyor (tür ihlali, `1 field(s) rejected`), gövde JSON değil. |
| `/report` | Sınırlardan biri ISO-8601 değil ya da `page` sayı değil; `page` negatif; `startAt` ve `stopAt`'tan yalnızca biri var; `stopAt` `startAt`'tan önce; aralık 1 aydan geniş. |
| `/inbox` | Sınırlardan biri ISO-8601 değil; yalnızca biri var; `stopAt` önce; aralık 2 aydan geniş. |
| `/stats` | `jobId` eksik ya da boş; `month` `yyyy-MM` değil. |
| `/blacklist` | `page` sayı değil ya da negatif; `number` 1–15 rakam değil. |
| `PUT /senders/default` | `name` eksik ya da boş; gövde JSON değil. |
| `/balance` | `service` tabloda yok: `service must be one of sms, otp, ses, fax, whatsapp, santral, netsipp, gsm, internet, numara, ai, ucret`. Geçersiz `stip` hata değildir, `1` sayılır. |
| `/webhooks/report`, `/webhooks/inbox` | `url` eksik, çok uzun (1024), host içeren mutlak bir http(s) URL değil ya da yalnızca genel (public) adreslere çözümlenmiyor; `headers` çok uzun (500), tek bir `Name: value` satırı değil ya da değerinde virgül veya iki nokta üst üste var. |

Sorgu parametrelerinde saat dilimi farkındaki `+` URL'de `%2B` olarak kodlanmalıdır.

### `503` ve `504` sonrası kontrol

İstekler tekilleştirilmez: aynı istek iki kez gönderilirse iki görev oluşur. Bu yüzden `5xx` yanıtının
uç noktaya göre ne anlama geldiğini bilmeniz gerekir. `504 QUEUE_UNCONFIRMED` artık yalnızca
`/directory/send` ve `/cancel`'da döner.

| Uç nokta | Yanıt | Anlamı | Ne yapılır |
|---|---|---|---|
| `/send`, `/send/template` | `503 SERVICE_UNAVAILABLE` | Servis geçici olarak kullanılamıyor. Görev çoğunlukla kuyruğa alınmamıştır; bu kesin olmadığı için yeniden göndermeden önce kontrol gerekir. | Toplu gönderimi körlemesine yeniden göndermeyin. Önce aşağıdaki gibi `GET /report` ile kontrol edin; görev yoksa yeniden gönderin. |
| `/directory/send` | `503 SERVICE_UNAVAILABLE` | Platforma ulaşılamadı, platform bir hata döndü ya da görev numarası vermedi. Ulaşılamadıysa hiçbir şey kuyruğa alınmamıştır; diğer durumlarda görev kuyruğa alınmış olabilir. Yanıt hangisi olduğunu ayırmaz. | Yeniden göndermeden önce `GET /report` ile kontrol edin. |
| `/directory/send` | `504 QUEUE_UNCONFIRMED` | Gönderim platforma iletildi ama yanıtı alınamadı; görev kuyruğa alınmış olabilir. | Yeniden göndermeden önce `GET /report` ile kontrol edin; emin olamıyorsanız `requestId` ile teknik destek. |
| `/send/otp` | `503 SERVICE_UNAVAILABLE` | Servis ya da OTP kanalı kullanılamıyor; hiçbir şey gönderilmedi. | Artan beklemeyle tekrar deneyin. OTP ucunda `504` yoktur. |
| `/cancel` | `503 SERVICE_UNAVAILABLE` | İptal servisine ulaşılamadı, servis bir hata ya da tanınmayan bir yanıt verdi. Görev büyük olasılıkla iptal edilmedi. | İptali yeniden gönderin; görev bu arada iptal edildiyse `404` döner. |
| `/cancel` | `504 QUEUE_UNCONFIRMED` | İptal iletildi ama yanıtı alınamadı; görev iptal edilmiş olabilir. | İptali yeniden gönderin: iptal edildiyse `404` döner. İptal isteğini tekrarlamak SMS göndermez. |

Gönderim uçlarındaki `500 INTERNAL_ERROR` için doküman kuyruk durumunu söylemez; `/send`,
`/send/template` ve `/directory/send`'de aynı kontrolü yapın. `/send/otp`'de `500` sonrası otomatik
tekrar göndermeyin: OTP gönderilmiş olabilir ve alıcıya iki farklı şifre ulaşabilir. OTP iletimleri
`GET /report` ile sorgulanamaz; durumu öğrenmek için `requestId` ile teknik destek.

**`GET /report` ile kontrol.** `GET /report`'u gönderim zamanını kapsayan aralıkla (`startAt`/`stopAt`;
zamanlanmış gönderimde istekteki `startAt` civarı) sorgulayıp istekteki alıcıları rapor satırlarının
`number` alanında arayın (yurt içi numaralar orada `90` öneki olmadan yazılır). `/directory/send`'de
grupların alıcılarını kendi rehber kaydınızdan, `contacts` ve `recipients`'ı istekten bilirsiniz.
Raporda satır olmaması görevin oluşmadığını kanıtlamaz: rapor henüz gelmemiş olabilir, yeni raporun
yansıması 5 dakikayı bulabilir. Emin olamıyorsanız `requestId` ile teknik destek
(`teknikdestek@netgsm.com.tr`).

`/send` ve `/send/template` isteklerinde verilen `referenceId` (en fazla 50 karakter) ek bir ipucudur:
rapor webhook'unun `referansID` alanı gönderimde verilen referanstır (verilmediyse `null`). `GET /report`
satırlarındaki `referenceId` dolu geliyorsa eşleştirmede kullanılabilir; ama `/report` bu alana göre
filtrelenemez ve spec onu yalnızca "iletim raporunun referansı" olarak tanımlar, bu yüzden asıl kontrol
alıcı numaralarıdır. `/directory/send` ve `/send/otp`'de `referenceId` alanı yoktur.

### Diğer uç nokta notları

- `/stats` `404` (`job not found`): bilinmeyen görev, başka hesabın görevi ve yanlış ay aynı görünür.
  `200` yanıtında her zaman en az bir satır bulunur.
- `/directory/send`: bekletilen bir görev de `202` alır. `review` alanı görevin gönderilmeden önce
  bekletilip bekletilmediğini söyler: `NONE` (bekletilmedi), `ADMIN_APPROVAL` (yönetici onayı
  bekliyor), `FORBIDDEN_WORD` (metinde yasaklı kelime), `UNKNOWN` (neden bilinmiyor). `status` her zaman
  `QUEUED`'dur, bu yüzden görev `/cancel` ile iptal edilemez. Bilinmeyen grup kimlikleri hata vermez;
  hiç grup ya da kişi verilmezse `400` döner.
- `/report`'ta gönderilen bir alıcı yoksa iletim raporu henüz gelmemiştir. Bu bir hata değildir; rapor
  daha sonra yeniden sorgulanır.

## Kimlik (Identity) hata yapısı

Identity hataları RFC 9457 Problem Details biçimindedir (`application/problem+json`):

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

Mantık `code`'a göre kurulur. `title` ve `detail` Türkçedir ve son kullanıcıya gösterilebilir.
`error` / `error_description` OAuth 2.0 istemci kütüphaneleri içindir. `request_id` destek talebinde
iletilir. Ek alanlar: `errors` (422), `retry_after` (429), `denied_scopes`
(`service_not_activated`, `sub_user_not_permitted`).

## Kimlik kodları

| `code` | HTTP | `error` | Anlamı | Olası neden | Ne yapılır | Tekrar |
|---|---|---|---|---|---|---|
| `validation_failed` | 422 | `invalid_request` (`scope` alanında `invalid_scope`) | Girdi doğrulanamadı; `errors` alan bazlı mesajları taşır. | `username`, `password` ya da `scope` eksik; boş ya da tanınmayan scope (`errors.scope` izin verilenleri listeler); alan 255 karakteri aşıyor; kimlik bilgisi query string'de gönderilmiş. | `errors`'a göre düzeltin; scope olarak `sms` gönderin; bilgileri gövdede gönderin. | Hayır |
| `invalid_request` | 400 | `invalid_request` | İstek işlenemedi. | Dokümanda ayrıntı yok. | Gövdenin geçerli JSON ya da form olduğunu ve `Content-Type`'ı kontrol edin; sürerse `request_id` ile teknik destek. | Hayır |
| `invalid_credentials` | 401 | `invalid_grant` | Kullanıcı adı ya da şifre hatalı. | `username` abone numarası değil; şifre giriş yapılan kimliğin (tercihen API alt kullanıcısının) şifresi değil. | Bilgileri kontrol edin (bkz. [Panel adımları](#hata--yapılacak-iş-panel-adımları)). Aynı yanlış bilgiyle tekrar denemeyin: aynı kullanıcı adı ve IP'den dakikada 5 hatalı deneme `too_many_failed_attempts` getirir. | Hayır |
| `invalid_refresh_token` | 401 | `invalid_grant` | Refresh token geçersiz, süresi dolmuş ya da oturum sonlandırılmış. | Oturum revoke edildi ya da süresi doldu; değer UUID değil; eski bir refresh token kullanıldı. | `POST /auth/v3/token` ile yeniden giriş. | Hayır |
| `invalid_token` | 401 | `invalid_token` | Access token eksik, geçersiz, süresi dolmuş ya da oturumu sonlandırılmış. | Süre doldu; refresh sonrası eski token kullanıldı; revoke edildi; aynı hesapta ana hesap ile alt kullanıcı sırayla giriş yaptı. | Refresh yerine yeniden giriş; istek bir kez tekrarlanır. Aynı hesapta API için tek kimlik kullanın. | Koşullu |
| `login_not_permitted` | 403 | `access_denied` | Bu hesapla giriş yapılamıyor. | Dokümanda ayrıntı yok. | `request_id` ile destek ekibi (çağrı merkezi ya da abonelik işlemleri). | Hayır |
| `api_access_denied` | 403 | `access_denied` | Hesabın API erişimi yok. | API erişimi aktifleştirilmemiş. | Panelde API İşlemleri → Aktifleştir. | Hayır |
| `ip_not_allowed` | 403 | `access_denied` | Bu IP adresinden erişim izni yok. | İsteğin çıktığı (sunucunun dış) IP adresi yetkili değil. | Abonelik İşlemleri → API İşlemleri → API Erişim İzinleri altında bu IP'yi yetkilendirin. | Hayır |
| `country_not_allowed` | 403 | `access_denied` | Yurt dışından erişim izni yok. | İstek yurt dışındaki bir sunucudan geliyor. | Abonelik İşlemleri → API İşlemleri → API Erişim İzinleri altında ülke erişimini yetkilendirin. | Hayır |
| `account_inactive` | 403 | `access_denied` | Hesap aktif değil. | Dokümanda ayrıntı yok. | `request_id` ile destek ekibi (çağrı merkezi ya da abonelik işlemleri). | Hayır |
| `service_not_activated` | 403 | `invalid_scope` | İstenen hizmet hesapta aktif değil (`denied_scopes`). | Hesapta SMS gönderim ya da alım hizmeti açık değil. Aktivasyon Netgsm'in sürecine bağlıdır. | Çağrı merkezi ya da diğer destek kanalları (`request_id` ile). Kod ya da panel çözümü yoktur. | Hayır |
| `sub_user_not_permitted` | 403 | `invalid_scope` | Alt kullanıcının istenen hizmete yetkisi yok (`denied_scopes`). | Alt kullanıcıya SMS yetkisi verilmemiş. | Alt kullanıcının yetkilerinde SMS hizmetini işaretleyin. | Hayır |
| `https_required` | 403 | — | İstek düz HTTP ile gönderildi; yalnızca HTTPS kabul edilir. | Adres `http://` ile yazılmış. | `https://ext-api.netgsm.com.tr` kullanın. | Hayır |
| `not_found` | 404 | `invalid_request` | Adres bulunamadı. | Yolda `/auth/v3` öneki eksik ya da yanlış. | Yolu düzeltin. | Hayır |
| `method_not_allowed` | 405 | `invalid_request` | HTTP metodu desteklenmiyor. | Uç noktanın desteklemediği bir metot kullanıldı. | Uç nokta tablosundaki metodu kullanın. | Hayır |
| `payload_too_large` | 413 | `invalid_request` | İstek gövdesi çok büyük. | Gövde 1 MB'ı aşıyor. | Gövdeyi küçültün. | Hayır |
| `too_many_failed_attempts` | 429 | `invalid_grant` | Çok fazla hatalı giriş denemesi. | Aynı kullanıcı adı ve IP'den dakikada 5 hatalı deneme. | `retry_after` / `Retry-After` kadar bekleyin ve kimlik bilgisini düzeltin. Başarılı giriş sayacı sıfırlar. | Koşullu |
| `rate_limited` | 429 | `temporarily_unavailable` | İstek limiti aşıldı. | Örneğin her istekte token alınması (`/token` IP başına dakikada 30). | `Retry-After` kadar bekleyin; token'ı önbelleğe alın. | Evet |
| `internal_error` | 500 | `server_error` | Beklenmeyen hata. | Sunucu tarafı. | Bir süre sonra tekrar; sürerse `request_id` ile teknik destek. | Evet |
| `service_misconfigured` | 502 | `temporarily_unavailable` | Sunucu tarafı yapılandırma hatası. | Sunucu tarafı. | Bir süre sonra tekrar; sürerse `request_id` ile teknik destek. | Evet |
| `service_unavailable` | 503 | `temporarily_unavailable` | Kimlik doğrulama altyapısına ulaşılamıyor. | Geçici. Art arda hatalarda istekler bir süre doğrudan reddedilir. | `Retry-After` varsa o kadar, yoksa bir süre bekleyip tekrar. | Evet |

## Hata → yapılacak iş (panel adımları)

| Kod | Neden | Yapılacak |
|---|---|---|
| `invalid_credentials` | Kullanıcı adı ya da şifre hatalı. `username` abone numarası olmalı, şifre giriş yapılan kimliğin (tercihen API alt kullanıcısının) şifresi. | Bilgileri kontrol edin. Alt kullanıcı şifresi unutulduysa panelde alt kullanıcının yanındaki Düzenle → yeni şifre. |
| `api_access_denied` | Hesabın API erişim izni yok. | Panelde API İşlemleri → Aktifleştir. |
| `sub_user_not_permitted` | Alt kullanıcının SMS yetkisi yok (`denied_scopes`). | Alt kullanıcı yetkilerinde SMS hizmetini işaretleyin. Alt kullanıcılar: Online İşlemler → Abonelik İşlemleri → Alt Kullanıcı Hesapları. Yeni bir API alt kullanıcısı da aynı yerden **Yeni Kayıt** ile oluşturulur. |
| `service_not_activated` | Hesapta istenen hizmet (SMS gönderim/alım) açık değil (`denied_scopes`). Hizmet aktivasyonu Netgsm'in aktivasyon sürecine bağlıdır, yazılımcı kendisi açamaz. | Çağrı merkezi veya diğer destek kanallarından Netgsm destek ekibiyle iletişime geçin (`request_id` ile). Kod ya da panel çözümü yoktur. |
| `ip_not_allowed` | İsteğin geldiği IP adresine API erişim izni verilmemiş. | İsteğin çıktığı (sunucunun dış) IP adresini öğrenin. Portalda Abonelik İşlemleri → API İşlemleri → API Erişim İzinleri altında bu IP'yi yetkilendirin. |
| `country_not_allowed` | Hesabın yurt dışından erişim izni yok. | Portalda Abonelik İşlemleri → API İşlemleri → API Erişim İzinleri altında ülke erişimini yetkilendirin. |
| SMS API `403 FORBIDDEN` | Alt kullanıcının SMS yetkisi yok, hesapta SMS gönderim/alım hizmeti açık değil ya da hedef operatöre SMS gönderimi yapılamıyor. | Alt kullanıcıysa önce SMS yetkisini kontrol edin (`sub_user_not_permitted` adımı). Değilse ya da sorun sürüyorsa çağrı merkezi veya diğer destek kanallarından destek ekibiyle iletişime geçin (`requestId` ile). |
| `too_many_failed_attempts` | Dakikada 5 hatalı giriş. | `retry_after` kadar bekleyin, kimlik bilgisini düzeltin. |
| `REJECTED_HEADER` | Başlık onaylı değil ya da yanlış yazılmış. | `GET /senders` ile kayıtlı başlıkları görün. Gerekirse başlık talebi açın: https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi |
| `INSUFFICIENT_CREDIT` | Paket ya da bakiye bitmiş. | Paket tanımlayın: https://www.netgsm.com.tr/fiyatlar/toplu-sms |
| `REJECTED_IYS` | İYS filtresi. | `iysFilter` kullanımını kontrol edin. |
| `NO_INTERNATIONAL_PERMISSION` | Hesabın yurt dışı gönderim izni yok. | İzin için destek ekibiyle iletişime geçin (çağrı merkezi ya da abonelik işlemleri). |
| `E_SIGNATURE_REQUIRED` | `/directory/send` için hesapta e-imza ile giriş gerekiyor. | Kodla çözülmez. `requestId` ile çağrı merkezi ya da teknik destek. |
| `QUEUE_UNCONFIRMED` / gönderimde `503` | Görev kuyruğa alınmış olabilir (`/directory/send` `503`/`504`, `/send` ve `/send/template` `503`). | Körlemesine tekrar denemeyin. Önce rapor sorun ([503 ve 504 sonrası kontrol](#503-ve-504-sonrası-kontrol)) ya da destek ekibine `requestId` iletin (teknik destek). |

## Kayıt red nedenleri

`/send` ve `/send/template` 202 yanıtında (ve `NO_DELIVERABLE_MESSAGES` hatasında) reddedilen kayıtlar
`rejectedItems` içinde `{ index, recipient, reason }` olarak döner. `index`, istekteki `messages`
(şablonda `templates`) dizisindeki sıfırdan başlayan konumdur; `recipient` kayıtta alıcı yoksa `null`
olur. Liste `index` sırasıyla ilk 100 kaydı taşır; `rejected` sayısı liste kesilse de kesindir.

| `reason` | Ne zaman | Ne yapılır | Tekrar |
|---|---|---|---|
| `INVALID_RECIPIENT` | Numara eksik ya da biçimi yanlış. | Türkiye: `90` ve 10 rakam (`905061234567`). Yurt dışı: `-` ve ülke koduyla 9–17 rakam (`-4915112345678`). `+`, baştaki `0`, `00`, boşluk, parantez ya da ayraç olarak tire kullanılmaz. | Düzeltilmiş kayıt yeni bir istekte |
| `INVALID_MESSAGE` | Metin eksik ya da boş. | Metni doldurun. | Düzeltilmiş kayıt yeni bir istekte |
| `MESSAGE_TOO_LONG` | Metin, `encoding` ve gönderici türüne göre sınırı aşıyor. | En fazla `DEFAULT` 917, `TURKISH` 888, `UNICODE` 396 karakter; alfanümerik başlıkta her sınır 5 eksik. `POST /length` ile ölçün; metni kısaltın ya da uygun `encoding`'i seçin. | Düzeltilmiş kayıt yeni bir istekte |
| `MALFORMED_ENTRY` | Kayıt `null`. | Diziye `null` eleman eklemeyin. | Düzeltilmiş kayıt yeni bir istekte |
| `DUPLICATE_RECIPIENT` | Aynı alıcı istekte daha sonra yeniden geçiyor. Yalnızca son geçen kayıt gönderilir, öncekiler bu nedenle reddedilir (son kayıt başka bir nedenle reddedilse bile). Numaralar yazıldığı gibi karşılaştırılır. Mükerrer gönderime izin verilen hesaplarda uygulanmaz. | Alıcıları istekte tekilleştirin. Bu alıcı için işlenen kayıt, istekteki son kayıttır: o kayıt geçerliyse gönderildi, kendisi de reddedildiyse `rejectedItems`'ta kendi nedeniyle görünür. | Hayır (bu kayıt için); son kayıt reddedildiyse onu düzeltip yeni istekte gönderin |
| `NO_INTERNATIONAL_PERMISSION` | Numara yurt dışı (`-` ile başlıyor) ve hesabın yurt dışı gönderim izni yok. Yalnızca başka bir hatası olmayan kayıtlarda bildirilir. | İzin için destek ekibiyle iletişime geçin (çağrı merkezi ya da abonelik işlemleri). | İzin açıldıktan sonra |

Bir kayıt birden fazla nedenle hatalıysa tek neden bildirilir. Öncelik: `DUPLICATE_RECIPIENT`,
`MALFORMED_ENTRY`, `MESSAGE_TOO_LONG`, `INVALID_RECIPIENT`, `INVALID_MESSAGE`,
`NO_INTERNATIONAL_PERMISSION`.

Numaranın gerçekte var olup olmadığı ya da operatörü gönderimde denetlenmez; bunun sonucu iletim
raporunda görülür.

## İletim hata nedenleri

Kabul edilen bir kayıt operatöre iletildikten sonra başarısız olabilir. Sonuç `GET /report` satırında
`status` `NOT_DELIVERED` ve `failReason` ile görülür. Rapor webhook'u aynı bilgiyi **sayısal kodla** taşır:
kendi durum kodu olan nedenler `status`'ta (`3` `INVALID_NUMBER`, `15` `BLACKLISTED` gibi), diğerleri
`status` `2` ile birlikte `errorCode`'da (`111` `TIMEOUT` … `119` `SYSTEM_ERROR`; `0` ya da `null`
`UNKNOWN`). Kod → ad tablosu: [endpoints/webhooks.md](endpoints/webhooks.md#kodlar-ve-get-report-karşılıkları).
`GET /stats` bu listenin bir alt kümesini (`INVALID_NUMBER`, `NOT_SENT_TO_OPERATOR`,
`OPERATOR_REJECTED`, `OPERATOR_ERROR`, `SEND_ERROR`, `DUPLICATE`, `INSUFFICIENT_CREDIT`,
`BLACKLISTED`, `IYS_REJECTED`, `MESSAGE_NOT_CREATED`, `TIMEOUT`, `UNKNOWN`) kullanır; tanınmayan
nedenler orada `UNKNOWN` olur ve aynı neden birden fazla satırda görülebilir (toplam için
`messageCount`'lar toplanır). Ücretlendirme durumu `/stats`'taki `charging` alanındadır.

"Anlamı" sütunu spec'teki tanımdır. Yeniden göndermek yeni bir gönderimdir: yeni görev, yeni ücret.
"Yeniden gönderim" sütunu: **Hayır** = aynı numaraya aynı şekilde göndermek sonucu değiştirmez.
**Koşullu** = geçici olabilecek bir neden; yeniden gönderim sizin kararınızdır, otomatik ve sık tekrar
önerilmez.

| `failReason` | Anlamı | Ne yapılır | Yeniden gönderim |
|---|---|---|---|
| `INVALID_NUMBER` | Hatalı numara. Yurt dışı bir numarada, kayıt kabul edildikten sonra hesabın yurt dışı izni kaldırıldığı anlamına da gelebilir. | Numarayı doğrulayıp listenizde işaretleyin. Yurt dışı numarada izni kontrol edin. | Hayır |
| `NOT_SENT_TO_OPERATOR` | Operatöre gönderilemedi. | Tekrarlıyorsa `jobId` ile teknik destek. | Koşullu |
| `OPERATOR_REJECTED` | Operatör kabul etmedi. | Tekrarlıyorsa `jobId` ile teknik destek. | Koşullu |
| `OPERATOR_ERROR` | Operatör hatası. | Tekrarlıyorsa `jobId` ile teknik destek. | Koşullu |
| `SEND_ERROR` | Gönderim hatası. | Tekrarlıyorsa `jobId` ile teknik destek. | Koşullu |
| `DUPLICATE` | Mükerrer gönderim. | Akışınızda aynı mesajın iki kez gönderilip gönderilmediğini (örneğin `503` ya da `504` sonrası körlemesine tekrar) kontrol edin. | Hayır |
| `INSUFFICIENT_CREDIT` | Kredi yetersiz. | Paket tanımlayın ya da bakiye yükleyin. | Koşullu (bakiye sonrası) |
| `BLACKLISTED` | Numara kara listede. | `GET /blacklist?number=...` ile kontrol edin; bu numaraya göndermeyin. | Hayır |
| `IYS_REJECTED` | İYS reddi. | Spec yalnızca "İYS reddi" der, nedeni ayrıntılandırmaz. Olası kontrol: alıcının, gönderimde kullanılan `iysFilter` (marka/bayi) için İYS izni var mı. Netleşmezse `jobId` ile teknik destek. | Hayır (izin durumu netleşmeden) |
| `IYS_ERROR` | İYS kontrolü yapılamadı. | Tekrarlıyorsa `jobId` ile teknik destek. | Koşullu |
| `MESSAGE_NOT_CREATED` | Mesaj oluşturulamadı. | `jobId` ile teknik destek. | Koşullu |
| `INVALID_NUMBER_FORMAT` | Hatalı numara biçimi. | Numara biçimini düzeltin. | Hayır (düzeltilmeden) |
| `NTS_NOT_APPROVED` | NTS onayı alınamadı. | Dokümanda ayrıntı yok: `jobId` ile teknik destek. | Hayır (nedeni netleşmeden) |
| `REPORT_NOT_FORWARDED` | Rapor iletilemedi. | Bu satır mesajın alıcıya ulaşıp ulaşmadığını göstermeyebilir; körlemesine yeniden göndermek alıcıya iki mesaj ulaştırabilir. Gerekirse `jobId` ile teknik destek. | Hayır (körlemesine) |
| `NO_INTERNATIONAL_PERMISSION` | Hesabın yurt dışı gönderim izni yok. | İzin için destek ekibiyle iletişime geçin. | İzin açıldıktan sonra |
| `TIMEOUT` | Zaman aşımı. | Gerekirse daha sonra yeniden gönderin. | Koşullu |
| `SMS_DISABLED_ON_DEVICE` | Mobil cihaz SMS almaya kapalı. | Alıcı tarafında çözülür. | Hayır (alıcı cihazında SMS alımını açana kadar) |
| `DEVICE_NOT_SUPPORTED` | Mobil cihaz desteklemiyor. | Alıcı tarafında çözülür. | Hayır |
| `ROUTING_FAILED` | Yönlendirme başarısız. | Tekrarlıyorsa `jobId` ile teknik destek. | Koşullu |
| `OPERATOR_TIMEOUT` | Hedef operatörde zaman aşımı oluştu. | Gerekirse daha sonra yeniden gönderin. | Koşullu |
| `UNKNOWN_SUBSCRIBER` | Tanımlanamayan abone. | Numarayı doğrulayın. | Hayır |
| `ILLEGAL_SUBSCRIBER` | Uyumsuz abone. | Numarayı doğrulayın. | Hayır |
| `SYSTEM_ERROR` | Sistemsel hata. | Tekrarlıyorsa `jobId` ile teknik destek. | Koşullu |
| `UNKNOWN` | Tanımlı olmayan bir neden. | `jobId` ile teknik destek. | Hayır (nedeni öğrenilmeden) |

## Webhook teslim hataları

- Rapor webhook'u: bağlantının 60 saniyede kurulması, yanıtın 10 dakikada gelmesi gerekir. Gelen SMS
  webhook'u: adresin 4 saniyede yanıt vermesi gerekir.
- Herhangi bir `2xx` yanıt teslim alındı demektir; gövde okunmaz.
- Zaman aşımı, `2xx` dışı yanıt ya da bağlantı hatasında o istekteki raporlar ya da mesaj **yeniden
  gönderilmez**. Kaçanlar `GET /report` ve `GET /inbox` ile alınır. Bu yüzden alıcı adres işi önce
  kaydedip hemen `2xx` dönmelidir.
- Kayıtta `headers` verildiyse o başlık her istekte gönderilir; isteğin Netgsm'den geldiği bununla
  doğrulanır. Gelen SMS isteklerindeki `X-Correlation-Id` destek talebinde paylaşılır.

## Hataları mock'ta denemek

Mock'ta hata işleme kodu gerçek hesap olmadan test edilir (mock adresi `http://127.0.0.1:4010`):

```bash
# Sıradaki /send isteğinde görev oluşsun ama 503 dönsün ("kuyruğa alınmış olabilir"; görev raporda görünür)
curl -s -X POST http://127.0.0.1:4010/__mock/scenario \
  -H 'Content-Type: application/json' \
  -d '{"code":"QUEUE_UNCONFIRMED","path":"/sms/v3/send"}'
```

- SMS senaryo kodları: `SERVICE_UNAVAILABLE`, `QUEUE_UNCONFIRMED`, `INTERNAL_ERROR`, `RATE_LIMITED`
  (`retryAfter` ile), `SENDING_SUSPENDED`, `INSUFFICIENT_CREDIT`, `REJECTED_HEADER`, `REJECTED_IYS`,
  `FORBIDDEN`, `E_SIGNATURE_REQUIRED`. `QUEUE_UNCONFIRMED` yola göre davranır: `/directory/send`'de görev
  oluşur ve `504`, `/send` ile `/send/template`'te görev oluşur ve `503`, `/send/otp`'de hiçbir şey
  gönderilmeden `503`, `/cancel`'da `504` döner (bkz. [testing.md](testing.md#hata-senaryoları)). Identity: `service_unavailable`, `service_misconfigured`, `internal_error`,
  `login_not_permitted`, `rate_limited`, `too_many_failed_attempts`. `times` ile birden fazla isteğe uygulanır.
- Kimlik ve yetki hataları test hesaplarıyla tetiklenir: `8500000001` → `service_not_activated`,
  `8500000002` → `ip_not_allowed`, `8500000003` → `sub_user_not_permitted`, `8500000004` →
  `api_access_denied`, `8500000005` → `account_inactive` (bu beşi sandbox'ta da aynı
  sonucu verir; `8500000001` ve `8500000003` `profile` token ile SMS API'de `403 FORBIDDEN` alır, bkz.
  [sandbox.md](sandbox.md#demo-hesaplar)); yalnızca mock'ta: `8500000006` → token alınır ama
  `/send` `403 FORBIDDEN`, `8500000007` → `country_not_allowed`, `8500000008` → İYS modu, yurt dışı
  izni ve OTP kredisi yok, `8500000010` → kurumsal OTP hesabı (`/send/otp` `x-client: enterprise`
  ister; göndermezse `403`). Şifreler testing.md'deki tabloda.
- `00` ile biten alıcılar raporda `NOT_DELIVERED` / `UNKNOWN_SUBSCRIBER` döner.
- `GET /__mock/advice` kuyruğa alınmış olabilecek bir gönderimin körlemesine tekrarı, tekrar denenmemesi gereken hatadan sonra aynı isteği
  göndermek ve `Retry-After`'ı yok saymak gibi kalıpları bildirir.

## Destek kanalları

| Kanal | Bilgi | Ne zaman |
|---|---|---|
| Çağrı merkezi (SMS) | `+90 850 303 0 303` · `+90 312 911 0 911` | Hizmet aktivasyonu, 403'ler (`E_SIGNATURE_REQUIRED` dahil), acil durumlar |
| Teknik destek | `teknikdestek@netgsm.com.tr` | API hataları, `requestId` / `request_id` ile bildirimler, belirsiz gönderimler (`503` / `504`), `E_SIGNATURE_REQUIRED` |
| Abonelik işlemleri | `abone.islemleri@netgsm.com.tr` | Hizmet aktivasyonu, alt kullanıcı ve hesap işlemleri |

Destek talebine şunları ekleyin: `requestId` (SMS) ya da `request_id` (Identity), varsa `jobId`, isteğin
zamanı, uç nokta ve hata yanıtının gövdesi. Şifre ve token paylaşılmaz.
