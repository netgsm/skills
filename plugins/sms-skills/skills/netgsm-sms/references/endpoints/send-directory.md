# `POST /directory/send`: rehbere SMS gönderme

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/send-to-directory/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Tam adres `POST /sms/v3/directory/send`. Her istek
`Authorization: Bearer <access_token>` ister (bkz. [auth.md](../auth.md)). Sözleşmenin tamamı:
[openapi.yaml](../openapi.yaml) (`/directory/send:`).

## Ne işe yarar

Hesabın rehberindeki kişi gruplarına, istekte verilen kişilere ya da her ikisine **tek bir
metinle** gönderimi kuyruğa alır. Metnin başına alıcının adı, soyadı ve hitabı eklenebilir
(`addressType`). Gruplar ve kişiselleştirme, yanıt döndükten sonra işlenir.

En az bir grup ya da kişi vermelisiniz. Yalnızca numaralara göndermek için `/send`'i kullanın (bkz.
[send.md](send.md)). `UNICODE` bu uç noktada desteklenmez.

## İstek alanları

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `sender` | string, 1–35 | evet | Gönderici başlığı, `/send`'deki gibi: kayıtlı başlıkla **birebir**, büyük/küçük harf dahil eşleşir. Eşleşmezse `422 REJECTED_HEADER`. |
| `text` | string, 1–917 | evet | Bütün alıcılara giden metin. En fazla `DEFAULT` 917, `TURKISH` 888 karakter (`çğışĞİŞ` iki karakter sayılır); alfanümerik başlıkta her sınır 5 eksik. Aşan metin `400`. |
| `encoding` | `DEFAULT` · `TURKISH` (varsayılan `DEFAULT`) | hayır | Büyük/küçük harfe duyarlıdır. `UNICODE` `400` alır (`encoding UNICODE is not supported for directory sends`); listede olmayan değer (`turkish` gibi) `400` `1 field(s) rejected`, `violations` `encoding`: `must be one of DEFAULT, TURKISH, UNICODE (case sensitive)`. |
| `iysFilter` | `NONE` · `BRAND` · `RETAILER` · `BRAND_AND_RETAILER` (varsayılan `NONE`) | hayır | Değerler `/send`'deki gibi; **büyük/küçük harf fark etmez**, listede olmayan değer `NONE` sayılır. Filtreyi platform uygular; uygulanamazsa `422 REJECTED_IYS`. |
| `groupIds` | tam sayı dizisi | koşullu | Hesabın rehberindeki kişi grupları. |
| `contacts` | dizi | koşullu | Bilgileriyle birlikte doğrudan verilen alıcılar (aşağıda). |
| `recipients` | string dizisi | hayır | Kişiselleştirme uygulanmayan düz numaralar; yalnızca `groupIds` ya da `contacts` ile birlikte kullanılır. Numaranın biçimini platform denetler. |
| `address1` | string, en fazla 500 | hayır | Bütün alıcılar için aynı ön hitap, örneğin "Sayın". Kullanımını `addressType` belirler. |
| `address2` | string, en fazla 500 | hayır | Bütün alıcılar için aynı son hitap, örneğin "Bey/Hanım,". Kullanımını `addressType` belirler. |
| `addressType` | tam sayı, 0–17 (varsayılan 0) | hayır | Metnin başına eklenecek kişisel bilgiler (aşağıdaki tablo). Aralık dışı değer `400 INVALID_REQUEST`. |
| `startAt` | ISO-8601, saat dilimiyle | hayır | Gönderim başlangıcı. Europe/Istanbul saatine çevrilir ve dakikaya yuvarlanır; saniyeler dikkate alınmaz. |
| `stopAt` | ISO-8601, saat dilimiyle | hayır | `startAt` gibi dakikaya yuvarlanır. `startAt`'tan 1 ile 21 saat sonra olmalıdır; platform kabul etmezse `400 INVALID_SEND_WINDOW`. |

"Koşullu": `groupIds` ve `contacts`'tan en az biri dolu olmalıdır.

`contacts[]` kaydı:

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `number` | string, 1–20 | evet | Alıcının numarası. Biçimini platform denetler. |
| `name` | string, en fazla 100 | hayır | Alıcının adı. |
| `surname` | string, en fazla 100 | hayır | Alıcının soyadı. |
| `address` | string, en fazla 500 | hayır | Kişiye özel hitap, örneğin "Sayın". Kullanımını `addressType` belirler. |

**`addressType`.** Seçilen parçalar şu sırayla ve aralarında birer boşlukla metnin başına eklenir;
alıcıda boş olan parça atlanır. Ad ve soyad rehberdeki kişi kaydından ya da `contacts` içindeki `name`
ve `surname`'den gelir. **Kişi hitabı** rehberdeki kişinin hitap bilgisi ya da `contacts` içindeki
`address`'tir ve her alıcı için ayrıdır.

| Değer | Metnin başına eklenen | Değer | Metnin başına eklenen |
|---|---|---|---|
| `0` | Hiçbir şey (varsayılan) | `9` | ad + soyad |
| `1` | address1 + ad | `10` | kişi hitabı |
| `2` | address1 + ad + soyad | `11` | kişi hitabı + ad |
| `3` | address1 + soyad | `12` | kişi hitabı + ad + soyad |
| `4` | address1 + ad + address2 | `13` | kişi hitabı + soyad |
| `5` | address1 + ad + soyad + address2 | `14` | kişi hitabı + address2 |
| `6` | address1 + soyad + address2 | `15` | kişi hitabı + ad + address2 |
| `7` | ad | `16` | kişi hitabı + ad + soyad + address2 |
| `8` | soyad | `17` | kişi hitabı + soyad + address2 |

Örnek: `addressType` 5, `address1` "Sayın", `address2` "Bey," ve metin "siparişiniz kargoya verildi."
ise Ahmet Yılmaz'a giden mesaj "Sayın Ahmet Yılmaz Bey, siparişiniz kargoya verildi." olur.

## Örnek istek

`<onaylı başlığınız>` yerine hesabınıza kayıtlı başlığı yazın (mock'ta `MOCKTEST` ya da `TESTHEADER`, sandbox'ta `TESTHEADER`).

```http
POST /sms/v3/directory/send
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "sender": "<onaylı başlığınız>",
  "text": "Merhaba",
  "encoding": "TURKISH",
  "groupIds": [7, 8],
  "contacts": [
    { "number": "905xxxxxxxxx", "name": "Ali", "surname": "Veli" }
  ]
}
```

## Örnek yanıt

`202 Accepted`. Gönderim, gönderim aralığı içinde yapılır.

```json
{ "jobId": "179309912974612345062827", "status": "QUEUED", "review": "NONE" }
```

| Alan | Açıklama |
|---|---|
| `jobId` | Görev numarası (string). Rapor ve istatistik için kullanılır; destek taleplerinde belirtmelisiniz. |
| `status` | **Her zaman `QUEUED`**, `startAt` ileride olsa da. |
| `review` | Görevin gönderilmeden önce bekletilip bekletilmediği (aşağıdaki tablo). |

| `review` | Anlamı |
|---|---|
| `NONE` | Bekletilmedi; gönderim aralığında gönderilir. |
| `ADMIN_APPROVAL` | Yönetici onayı bekliyor: hesap onay kontrolünde ya da gönderim hesabın sınırından büyük. |
| `FORBIDDEN_WORD` | Metin yasaklı bir kelime içerdiği için bekletiliyor. |
| `UNKNOWN` | Görev kuyruğa alındı ama bekletme nedeni bilinmiyor. |

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `message` aşağıdaki tabloda. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 400 | `INVALID_SEND_WINDOW` | `the send window was rejected`: platform `startAt` / `stopAt` aralığını kabul etmedi (`stopAt`, `startAt`'tan 1 ile 21 saat sonra olmalıdır). | [errors.md](../errors.md#sms-api-kodları) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | `/send`'deki üç `message`'a ek olarak `account is not permitted to send` (platform, hesabın gönderim yetkisi olmadığını bildirdi). | [errors.md](../errors.md#forbidden-403) |
| 403 | `E_SIGNATURE_REQUIRED` | `the requested menu requires an e-signature login on the account`: bu gönderim için hesapta e-imza ile giriş gerekiyor. | [errors.md](../errors.md#e_signature_required-403) |
| 422 | `REJECTED_HEADER` | `/send`'deki beş ret adı (`CASE_MISMATCH` dahil). | [errors.md](../errors.md#rejected_header-422) |
| 422 | `REJECTED_IYS` | `consent filtering cannot be applied to this sender or account`: platform, istenen İYS filtresini bu başlık ya da hesap için uygulayamadı. | [errors.md](../errors.md#rejected_iys-422) |
| 429 | `RATE_LIMITED` | `directory send rate limit exceeded`: hesap başına dakikada 60 istek aşıldı; `Retry-After` kadar bekleyin. | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | Platforma ulaşılamadı, platform bir hata döndü ya da görev numarası vermedi. Görev **kuyruğa alınmış olabilir**: yeniden göndermeden önce `GET /report` ile kontrol edin. | [errors.md](../errors.md#503-ve-504-sonrası-kontrol) |
| 504 | `QUEUE_UNCONFIRMED` | Gönderim platforma iletildi ama yanıtı alınamadı; görev kuyruğa alınmış olabilir. **Körlemesine tekrar denenmez**: önce `GET /report`. | [errors.md](../errors.md#503-ve-504-sonrası-kontrol) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. Gönderim ucunda kuyruğa alınmış olabilir gibi ele alınır. | [errors.md](../errors.md#hızlı-karar-tablosu) |

`400 INVALID_REQUEST` için `message`:

| `message` | Ne zaman |
|---|---|
| `N field(s) rejected` | Alanlar doğrulamadan geçmedi (eksik `sender` ya da `text`, uzunluk sınırları, `addressType` 0–17 dışında, `contacts[].number` boş) ya da bir değer türüne uymuyor (`encoding` listede yok, tarih saat dilimi farkı olmadan yazılmış, `groupIds` içinde metin gibi). `violations` belirtir; tür ihlalinde tek ihlal döner (`groupIds[1]`: `must be a number` gibi). |
| `request body could not be read as json` | Gövde geçerli bir JSON değil. |
| `encoding UNICODE is not supported for directory sends` | `encoding` `UNICODE`. |
| `a directory send names at least one group or contact; for numbers alone use /sms/v3/send` | `groupIds` ve `contacts` ikisi de boş. |
| `text exceeds N characters for this encoding and sender` | Metin, `encoding` ve gönderici türüne göre sınırı aşıyor. |
| `a required field is missing` | Platform eksik bir alan bildirdi. |

## Dikkat edilecekler

- **İstekler tekilleştirilmez.** Aynı istek iki kez gönderilirse iki görev oluşur ve gruplara iki kez
  mesaj gider. `503`, `504` ya da `500` sonrası yeniden göndermeden önce `GET /report` ile kontrol edin
  (tarif: [errors.md](../errors.md#503-ve-504-sonrası-kontrol)). Bu uçta güvenle tekrar denenebilecek bir
  `5xx` yoktur.
- **İptal edilemez.** `status` her zaman `QUEUED`'dur; `startAt` ileride olsa da görev
  [`POST /cancel`](cancel.md) ile iptal edilemez (`/cancel` yalnızca `SCHEDULED` görevleri iptal eder).
- **`202` grupların geçerli olduğunu göstermez.** Gruplar yanıttan sonra işlenir: bilinmeyen grup
  kimlikleri hata vermez, atlanır ve istek yine `202` alır. `400` yalnızca hiç grup ve hiç kişi
  verilmediğinde döner. Gönderilecek grupların kimliklerini kendi tarafınızda doğrulayın.
- **Bekletilen görev de `202` alır.** `review` `NONE` değilse görev önce bekletilir; gönderimin
  zamanında başlaması gerekiyorsa bu alanı kontrol edin.
- **Yanıtta `accepted`, `rejected`, `rejectedItems` ve `referenceId` yoktur.** Kayıt bazlı sonuç
  iletim raporundan izlenir ([report.md](report.md)).
- **`stopAt` kuralı `/send`'den farklıdır:** burada `startAt`'tan 1 ile 21 saat sonra olmalıdır, aksi
  halde `400 INVALID_SEND_WINDOW`. `/send` ise aralığı kendisi düzeltir.
- **`sender` birebir, `iysFilter` serbest.** Başlık büyük/küçük harf dahil eşleşmelidir; `iysFilter`
  ise büyük/küçük harf ayırmaz ve bilinmeyen değer sessizce `NONE` olur. Ticari iletide değeri
  yazıldığı gibi kontrol edin.
- **`UNICODE` yok.** Emoji ya da GSM alfabesinde olmayan karakter gerekiyorsa `/send` kullanın.
- **İstek sınırı:** hesap başına dakikada 60 istek, `/send` sınırından ayrı; pencere ilk istekle başlar
  ve sabittir. Çok sayıda gönderim için grupları tek istekte toplayın.
- **Mock:** her test hesabında `groupId` 7 ("Müşteriler", üç kişi) bulunur. `E_SIGNATURE_REQUIRED`
  senaryosu `403`'ü dener (bkz. [testing.md](../testing.md#hata-senaryoları)).
