# `POST /send`: SMS gönderme

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/send-sms/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/send:`).

## Ne işe yarar

Bir ya da daha fazla alıcıya SMS gönderen bir **görev** oluşturur. Görev kabul edilince `202` döner;
iletim sonradan yapılır. Her alıcı `messages` dizisinde ayrı bir kayıttır ve her kaydın kendi metni
olabilir. Tek istek 1.000.000 kayda kadar taşır: çok alıcı, alıcı başına ayrı istekle değil tek istekte
gönderilir (bkz. [limits-and-batching.md](../limits-and-batching.md)). Yüz binlerce kayıtlık listeleri
isteğe bağlı olarak on binlerce kayıtlık parçalara bölmek pratik avantaj sağlayabilir (bkz.
[Büyük listeleri bölmek](../limits-and-batching.md#büyük-listeleri-bölmek)).

Hatalı kayıtlar toplu gönderimi başarısız kılmaz. Geçerli kayıtlar gönderilir, hatalılar yanıttaki
`rejectedItems` içinde bildirilir. Kayıtların hepsi hatalıysa görev oluşturulmaz ve
`422 NO_DELIVERABLE_MESSAGES` döner.

## İstek alanları

Gövde JSON'dur (`Content-Type: application/json`), sıkıştırılmaz ve 500 MB'ı aşmaz. Bilinmeyen alanlar
yok sayılır; `null` verilen alan hiç verilmemiş sayılır.

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `sender` | string, 1–35 karakter | evet | Gönderici başlığı. Hesaba kayıtlı bir başlıkla **birebir** eşleşir (büyük/küçük harf dahil, kırpma yok). Alfanümerik başlık ya da hesabın abone numarası olabilir; abone numarası başında `0` ya da `90` olmadan yazılır (`5xxxxxxxxx`). Kayıtlı başlıklar: [senders.md](senders.md). Eşleşmezse `422 REJECTED_HEADER`; boş ya da yalnızca boşluktan oluşan değer `400`. |
| `messages` | dizi, 1–1.000.000 kayıt | evet | Her alıcı için bir kayıt. 1.000.000'dan fazlası `400` ile reddedilir. |
| `messages[].text` | string | evet | Mesaj metni. Boş olamaz (`INVALID_MESSAGE`). En fazla uzunluk `encoding`'e ve gönderici türüne bağlıdır (`MESSAGE_TOO_LONG`). |
| `messages[].recipient` | string, `^(90\d{10}\|-\d{9,17})$` | evet | Alıcı numarası (aşağıdaki tablo). Uymazsa kayıt `INVALID_RECIPIENT` ile reddedilir. |
| `encoding` | `DEFAULT` · `TURKISH` · `UNICODE` (varsayılan `DEFAULT`) | hayır | Karakter kodlaması; bütün kayıtlara uygulanır (aşağıdaki tablo). **Büyük/küçük harfe duyarlıdır:** listede olmayan değer (`turkish`, `GSM` dahil) isteği `400` `1 field(s) rejected` ile reddeder; `violations` `encoding` alanını ve geçerli değerleri gösterir. |
| `iysFilter` | `NONE` · `BRAND` · `RETAILER` · `BRAND_AND_RETAILER` (varsayılan `NONE`) | hayır | İYS izin filtresi. Büyük/küçük harf fark etmez; bu değerlerin dışındaki her değer `NONE` sayılır. |
| `startAt` | ISO-8601, saat dilimiyle | hayır | En erken gönderim zamanı. Verilmezse ya da geçmişteyse gönderim hemen başlar. 18 aydan daha ilerisi `400 INVALID_SEND_WINDOW`. Saat dilimi farkı olmayan ya da okunamayan tarih `400` `1 field(s) rejected`. |
| `stopAt` | ISO-8601, saat dilimiyle | hayır | En geç gönderim zamanı. Verilmezse ya da geçmişteyse `startAt` + 21 saat kabul edilir. |
| `partnerCode` | string, en fazla 32 | hayır | İş ortağı (bayi) kodu. Yalnızca kayıt amaçlıdır; gönderimi etkilemez. |
| `referenceId` | string, en fazla 50 | hayır | Yanıtta aynen geri döner. |
| `appName` | string, en fazla 50 | hayır | Gönderimi yapan uygulamanın adı. Yalnızca kayıt amaçlıdır. |

**Alıcı biçimi.** Yalnızca rakamlar ve yurt dışı için baştaki tek `-` kullanılır; boşluk, parantez ya da
tire ayracı olmaz.

| Tür | Biçim | Örnek |
|---|---|---|
| Türkiye | `90` ve 10 rakam; `+` ya da baştaki `0` olmadan | `+90 5xx xxx xx xx` için `905xxxxxxxxx` |
| Yurt dışı | `-` ve ülke koduyla 9–17 rakam; `+` ya da `00` olmadan | `+49 151 12345678` için `-4915112345678` |

Yanlış yazımlar: `+905…`, `05…`, `5…` (10 rakam), `0049151…`, `-+49151…`. Numaranın gerçekte var olup
olmadığı ya da operatörü burada denetlenmez; sonuç [report.md](report.md) ile görülür. Hesabın yurt dışı
gönderim izni yoksa yurt dışı kayıtlar `NO_INTERNATIONAL_PERMISSION` ile reddedilir.

**Kodlama ve uzunluk.**

| `encoding` | Ne zaman | En fazla uzunluk |
|---|---|---|
| `DEFAULT` | Standart GSM alfabesi. Türkçe karakterler Latin karşılıklarına çevrilir (ç→c, ş→s gibi). | 917 |
| `TURKISH` | Türkçe karakterler (`çğıöşüÇĞİÖŞÜ`) korunacaksa. `çğışĞİŞ` iki karakter sayılır. | 888 |
| `UNICODE` | Emoji ya da Arapça, Kiril gibi GSM alfabesinde olmayan karakterler için. | 396 |

Alfanümerik başlıkta her sınır 5 karakter azdır. Parça sayısı ve sayım kuralları: [length.md](length.md).

**İYS filtresi.**

| `iysFilter` | Anlamı |
|---|---|
| `NONE` | Filtre yok. Yalnızca bilgilendirme (ticari olmayan) iletiler için. |
| `BRAND` | Marka adına alınmış izinlere göre filtrelenir. |
| `RETAILER` | Bayi adına alınmış izinlere göre filtrelenir. |
| `BRAND_AND_RETAILER` | Her ikisine göre filtrelenir. |

Hesap ticari gönderim (marka ya da bayi) tipinde tanımlıysa istekteki değer yok sayılır ve hesabın tipi
uygulanır. `BRAND` ya da `RETAILER` uygulanacaksa başlığın İYS marka kodu olmalıdır (`GET /senders`'ta
`brandCode`); hesap İYS modunda değilse bu iki değer `422 REJECTED_IYS` alır. `BRAND_AND_RETAILER` için
bu iki kontrol yapılmaz.

**Gönderim aralığı.** Aralık, 1000 ve üzeri mesajda 10 dakikadan, daha azında 5 dakikadan kısaysa bu
süreye uzatılır; 21 saatten uzunsa 21 saate kısaltılır. Bu düzeltmeler hata döndürmez ve belirlenen
aralık yanıtta yer almaz.

## Örnek istek

`<onaylı başlığınız>` yerine hesabınıza kayıtlı başlığı yazın (mock'ta `MOCKTEST` ya da `TESTHEADER`, sandbox'ta `TESTHEADER`). Spec örneklerindeki
`NETGSM` sizin hesabınızda kayıtlı değildir.

Birden fazla alıcı, tek istekte; ikinci kayıt hatalı (`+` ile başlıyor):

```http
POST /sms/v3/send
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "sender": "<onaylı başlığınız>",
  "messages": [
    { "text": "Merhaba", "recipient": "905xxxxxxxxx" },
    { "text": "Merhaba", "recipient": "+905xxxxxxxxx" }
  ],
  "referenceId": "order-4711"
}
```

Zamanlanmış, Türkçe kodlamalı:

```json
{
  "sender": "<onaylı başlığınız>",
  "encoding": "TURKISH",
  "startAt": "2026-09-10T09:00:00+03:00",
  "stopAt": "2026-09-10T12:00:00+03:00",
  "messages": [{ "text": "Şubemiz bugün açık.", "recipient": "905xxxxxxxxx" }]
}
```

Ticari ileti, marka izinlerine göre İYS filtresiyle:

```json
{
  "sender": "<onaylı başlığınız>",
  "iysFilter": "BRAND",
  "messages": [{ "text": "Kampanya", "recipient": "905xxxxxxxxx" }]
}
```

Yurt içi ve yurt dışı alıcıya farklı metinlerle:

```json
{
  "sender": "<onaylı başlığınız>",
  "messages": [
    { "text": "Siparişiniz kargoya verildi.", "recipient": "905xxxxxxxxx" },
    { "text": "Your order has been shipped.", "recipient": "-4915112345678" }
  ]
}
```

## Örnek yanıt

`202 Accepted` (ilk örnek isteğin yanıtı):

```json
{
  "jobId": "179309912974612345062827",
  "status": "QUEUED",
  "accepted": 1,
  "rejected": 1,
  "rejectedItems": [
    { "index": 1, "recipient": "+905xxxxxxxxx", "reason": "INVALID_RECIPIENT" }
  ],
  "rejectedItemsTruncated": false,
  "referenceId": "order-4711"
}
```

| Alan | Açıklama |
|---|---|
| `jobId` | Görev numarası (string). Rapor, istatistik ve iptal için kullanılır; destek taleplerinde belirtilir. |
| `status` | `SCHEDULED`: görev `startAt`'a kadar bekletiliyor ve hâlâ iptal edilebilir. `QUEUED`: gönderim hemen başladı, iptal edilemez. |
| `accepted` | Gönderime alınan kayıt sayısı. `accepted + rejected` istekteki kayıt sayısına eşittir. |
| `rejected` | Reddedilen kayıt sayısı; liste kesilse de kesindir. |
| `rejectedItems` | Reddedilen kayıtlar `{ index, recipient, reason }`, `index` sırasıyla ilk 100 tanesi. Hiçbiri reddedilmediyse `[]`. `index` `messages` dizisindeki sıfırdan başlayan konumdur. |
| `rejectedItemsTruncated` | 100'den fazla kayıt reddedildiyse `true`. |
| `referenceId` | İstekteki `referenceId`; verilmediyse `null`. |

Kayıtların hepsi reddedilirse görev oluşmaz (`422`):

```json
{
  "code": "NO_DELIVERABLE_MESSAGES",
  "message": "all 1 messages rejected",
  "requestId": "5d1f0c2a7b3e4f6a9c8d7e6f5a4b3c2d",
  "timestamp": "2026-09-07T16:42:31.123+03:00",
  "violations": null,
  "rejectedItems": [
    { "index": 0, "recipient": "-4915112345678", "reason": "NO_INTERNATIONAL_PERMISSION" }
  ],
  "rejectedItemsTruncated": false
}
```

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `message` aşağıdaki tabloda. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 400 | `INVALID_SEND_WINDOW` | `startAt` 18 aydan daha ileride. | [errors.md](../errors.md#sms-api-kodları) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | `account is not activated for this operation`, `sub user may not use the sms api`, `account operator is not served for this operation`. | [errors.md](../errors.md#forbidden-403) |
| 413 | `INVALID_REQUEST` | Gövde 500 MB'tan büyük ya da toplu gönderim kuyruğa alınamayacak kadar büyük (`message` hangisi olduğunu söyler). Gönderimi birden fazla isteğe bölün. | [limits-and-batching.md](../limits-and-batching.md) |
| 422 | `REJECTED_HEADER` | `message`: `NO_HEADERS_REGISTERED`, `NOT_REGISTERED`, `CASE_MISMATCH`, `ROUTING_CODE_MISSING`, `SUBSCRIBER_NUMBER_RESTRICTED`. | [errors.md](../errors.md#rejected_header-422) |
| 422 | `REJECTED_IYS` | `sender header has no iys brand code` ya da `account is not in iys mode, filtering cannot be applied` (yalnızca `BRAND` ve `RETAILER`). | [errors.md](../errors.md#rejected_iys-422) |
| 422 | `NO_DELIVERABLE_MESSAGES` | Kayıtların hepsi reddedildi; `rejectedItems` nedenleri taşır. | [errors.md](../errors.md#kayıt-red-nedenleri) |
| 429 | `RATE_LIMITED` | `send rate limit exceeded` (`Retry-After` ile) ya da `sending is suspended for this account` (`Retry-After` yok). | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | Servis geçici olarak kullanılamıyor. Görev çoğunlukla kuyruğa alınmamıştır; toplu gönderimi körlemesine yeniden göndermeden önce `GET /report` ile kontrol edin. | [errors.md](../errors.md#503-ve-504-sonrası-kontrol) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. Gönderim ucunda kuyruğa alınmış olabilir gibi ele alınır. | [errors.md](../errors.md#hızlı-karar-tablosu) |

Bu uçta `504` yoktur.

`400 INVALID_REQUEST` için `message`:

| `message` | Ne zaman |
|---|---|
| `N field(s) rejected` | Alanlar doğrulamadan geçmedi: `sender` eksik, boş ya da 35 karakterden uzun, `messages` eksik ya da boş, ya da bir alan uzunluk sınırını aşıyor; ya da bir alanın değeri türüne uymuyor (aşağıda). `violations` hangi alanın neden reddedildiğini söyler (örn. `sender`: `must not be blank`). |
| `request body could not be read as json` | Gövde geçerli bir JSON değil (sözdizimi hatası). `violations` `null`'dır. |
| `N messages exceeds the limit of 1000000` | 1.000.000'dan fazla mesaj. |

**Türü uymayan değer.** Alanları dokümandaki türleriyle gönderin (numaralar ve metinler tırnak içinde).
Gövde geçerli JSON olduğu hâlde bir değer yapısal olarak türüne uymuyorsa istek `1 field(s) rejected`
ile reddedilir ve `violations` **tek** ihlal taşır: okuma gövdedeki sırayla ilk hatalı alanda durur ve diğer
ihlaller (eksik `sender` gibi) o yanıtta bildirilmez. Reddedilen değer yanıtta yer almaz.

```json
{
  "code": "INVALID_REQUEST",
  "message": "1 field(s) rejected",
  "requestId": "3b9e2f1a6c4d48e7a05f9d2c1b8e7a64",
  "timestamp": "2026-09-07T16:42:31.123+03:00",
  "violations": [
    { "field": "encoding", "message": "must be one of DEFAULT, TURKISH, UNICODE (case sensitive)" }
  ]
}
```

| Gönderilen | `violations[0]` |
|---|---|
| `"encoding": "turkish"` (ya da `GSM`, `Unicode`) | `encoding`: `must be one of DEFAULT, TURKISH, UNICODE (case sensitive)` |
| `"startAt": "2026-09-10T09:00:00"` (saat dilimi farkı yok) | `startAt`: `must be an ISO-8601 date-time with an offset, e.g. 2026-09-10T09:00:00+03:00` |
| `"messages": "x"` | `messages`: `must be an array` |
| `"recipient": ["905061234567"]` (üçüncü kayıtta, dizi) | `messages[2].recipient`: `must be a string` |
| Kayıt nesne değil (`"messages": [7]`) | `messages[0]`: `has an invalid value` |

Bütün mesaj metinleri ve kural tablosu: [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri).

## Dikkat edilecekler

- **İstekler tekilleştirilmez.** Aynı istek iki kez gönderilirse iki görev, yani iki gönderim olur. `503`
  ya da `500` sonrası aynı isteği göndermeden önce `GET /report` ile kontrol edin (tarif:
  [errors.md](../errors.md#503-ve-504-sonrası-kontrol)).
- **`rejectedItems` her zaman işlenir.** Kısmi başarı normaldir. Liste en fazla 100 kayıt taşır; daha
  fazla hatalı kayıt varsa `rejectedItemsTruncated` `true` olur ve geri kalanların hangileri olduğu
  yanıtta yoktur. Alıcıları göndermeden önce kendi tarafınızda doğrulamak bu yüzden işe yarar.
- **Aynı alıcı istekte iki kez geçerse** yalnızca son geçen kayıt işlenir; öncekiler
  `DUPLICATE_RECIPIENT` ile reddedilir. Numaralar yazıldığı gibi karşılaştırılır.
- **`SCHEDULED` ya da `QUEUED`.** Spec'e göre görev, başlangıç "dakikaya göre sayıldığında bir dakikadan
  daha ileri" ise `SCHEDULED` olur. Mock bunu şöyle yorumlar: `startAt` en az 120 saniye ilerideyse
  `SCHEDULED`, 61–119 saniye ilerideyse `QUEUED`. Spec'in ifadesi bu ayrıntıda kesin değildir. İptal
  edebilmeniz gereken bir gönderimde başlangıcı birkaç dakika ileri verin ve yanıttaki `status`'a bakın:
  yalnızca `SCHEDULED` bir görev, başlangıç zamanına kadar [`POST /cancel`](cancel.md) ile iptal edilir.
- **İstek sınırı mesaj değil istek sayar:** hesap başına dakikada 50.000 istek; pencere ilk istekle
  başlar ve sabittir; reddedilen istekler sayılmaz. Alıcı başına ayrı istek atmayın.
- **Sonrası:** `jobId` ile iletim raporları [`GET /report`](report.md), toplamlar
  [`GET /stats`](stats.md) ile sorgulanır. Sürekli takip için [rapor webhook'u](webhooks.md)
  kullanılır.
- **Mock:** `MOCKTEST` ya da `TESTHEADER` başlığını kullanın (sandbox'ta `TESTHEADER`). Kayıtlar başlangıçtan 5 saniye sonra `DELIVERED` olur; `00`
  ile biten alıcılar `NOT_DELIVERED` döner (bkz. [testing.md](../testing.md)).
