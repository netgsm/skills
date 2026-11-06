# `POST /consents` ve `GET /consents`: izin kaydetme ve sorgulama

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/iys/save-consents/ ·
https://api-docs.netgsm.com.tr/iys/search-consents/ · bölüm: https://api-docs.netgsm.com.tr/iys/izinler/.
İzin yöntemleri ve kaynakların anlamı: https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/iys-izin-yontemleri

Yollar İYS API base URL'sine göredir: `https://ext-api.netgsm.com.tr/iys/v1` (yalnızca canlı; sandbox
ve mock yoktur). Her istek `Authorization: Bearer <access_token>` ister (`scope: "sms"`, bkz.
[getting-started.md](getting-started.md#token)). Sözleşmenin tamamı: [openapi.yaml](openapi.yaml)
(`/consents:`).

> **Uyarı.** `POST /consents` canlı İleti Yönetim Sistemi'ne hukuki kayıt yazar; yüklenen adresler
> silinemez ve düzenlenemez. Yalnızca alıcıdan gerçekten alınmış izinler (ya da retler) gönderilir.
> Test, örnek ya da demo amacıyla gerçek numara veya e-posta adresiyle kayıt yapılmaz.

## Ortak değerler

| Alan | Değerler | Açıklama |
|---|---|---|
| `recipient` | `+90XXXXXXXXXX` ya da e-posta adresi (en fazla 255 karakter) | SMS API v3'teki `905…` biçimi değil, başında `+` ile. |
| `recipientType` | `BIREYSEL` · `TACIR` | Bireysel ya da tacir alıcı. |
| `type` | `MESAJ` · `ARAMA` · `EPOSTA` | İzin tipi: SMS için `MESAJ`, sesli arama için `ARAMA`, e-posta için `EPOSTA`. |
| `status` | `ONAY` · `RET` | İzin verildi ya da reddedildi (ret bildirimi de kayıttır). |
| `brandCode` | tam sayı, 1–2147483647 | İYS marka kodu. Her istekte zorunlu. |
| `path` | `SANTRAL` · `SMSAPI` · `WEBPORTAL` | İsteğe bağlı; gönderilmezse `SMSAPI`. |
| `refId` | string, 1–255 karakter | İsteğe eklediğiniz referans değeri (kendi kayıt numaranız gibi). |

`source` (iznin alındığı kaynak) değerleri; açıklamalar Bilgi Bankası'ndaki izin yöntemleri
sayfasındandır:

| `source` | İznin alındığı yer |
|---|---|
| `HS_FIZIKSEL_ORTAM` | Hizmet sağlayıcı tarafından fiziksel ortamda |
| `HS_ISLAK_IMZA` | Alıcının imzaladığı form ya da anketle |
| `HS_ETKINLIK` | Hizmet sağlayıcının düzenlediği bir etkinlikte |
| `HS_ATM` | Hizmet sağlayıcının kendi ATM'sinde |
| `HS_EORTAM` | Hizmet sağlayıcıya ait elektronik bir ortamda |
| `HS_WEB` | Hizmet sağlayıcının web sitesinde |
| `HS_MOBIL` | Hizmet sağlayıcının mobil uygulamasında |
| `HS_MESAJ` | Hizmet sağlayıcının kısa mesaj numarası üzerinden |
| `HS_EPOSTA` | Hizmet sağlayıcıdan gelen e-postayla |
| `HS_CAGRI_MERKEZI` | Hizmet sağlayıcının çağrı merkezinde (sesli ya da tuşlamayla) |
| `HS_SOSYAL_MEDYA` | Hizmet sağlayıcının sosyal medya aracıyla |
| `HS_2015` | Sözleşmede açıklaması yok |
| `HS_KARAR` | Sözleşmede açıklaması yok |

`HS_2015` ve `HS_KARAR` için anlam uydurulmaz; kullanılması gerekiyorsa resmî doküman ve İYS
kaynaklarına bakılır, netleşmezse teknik desteğe danışılır.

## `POST /consents`: izin kaydetme

İzinleri İYS'ye kaydeder. Bir istekte **en fazla 500 izin** gönderilir. Kayıt başına ayrı istek
atılmaz.

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `brandCode` | tam sayı | evet | İYS marka kodu. |
| `path` | `IysPath`, null olabilir | hayır | Gönderilmezse `SMSAPI`. |
| `refId` | string, 1–255, null olabilir | hayır | Referans değeri. |
| `permissions` | dizi, 1–500 | evet | Kaydedilecek izinler (aşağıda). |
| `permissions[].recipient` | string, en fazla 255 | evet | `+90XXXXXXXXXX` ya da e-posta. |
| `permissions[].recipientType` | `BIREYSEL` · `TACIR` | evet | |
| `permissions[].type` | `MESAJ` · `ARAMA` · `EPOSTA` | evet | |
| `permissions[].source` | yukarıdaki tablo | evet | İznin gerçekte alındığı yöntem. |
| `permissions[].status` | `ONAY` · `RET` | evet | |
| `permissions[].consentDate` | `YYYY-MM-DD HH:mm:ss` | evet | İznin alındığı an (isteğin gönderildiği an değil). |
| `permissions[].retailerCode` | tam sayı ≥ 0, null olabilir | hayır | Bayi ile ilgili alan; sözleşme ayrıntı vermez. |
| `permissions[].retailerAccess` | tam sayı dizisi, null olabilir | hayır | Bayi ile ilgili alan; sözleşme ayrıntı vermez. |

`retailerCode` ve `retailerAccess` için anlam uydurulmaz. Bayi yapınız yoksa göndermeyin; varsa resmî
dokümana ve teknik desteğe danışın.

### Örnek istek

Numara ve marka kodu yer tutucudur; gerçek bir izin kaydı olmadan gönderilmez.

```http
POST /iys/v1/consents
Authorization: Bearer <access_token>
Content-Type: application/json
X-Request-Id: consent-sync-2026-02-20-0001

{
  "brandCode": <marka kodunuz>,
  "refId": "musteri-4711",
  "permissions": [
    {
      "recipient": "+90XXXXXXXXXX",
      "recipientType": "BIREYSEL",
      "type": "MESAJ",
      "source": "HS_WEB",
      "status": "ONAY",
      "consentDate": "2026-02-20 16:46:00"
    }
  ]
}
```

### Yanıt

`200`, bütün kayıtlar kabul edildi:

```json
{ "success": true, "errorCode": 0, "message": "success",
  "data": { "uid": "ee5c7e61-3940-432a-af30-13b0c9944371" } }
```

`200`, bazı kayıtlar İYS tarafından reddedildi:

```json
{ "success": true, "errorCode": 0, "message": "success",
  "data": {
    "uid": "ee5c7e61-3940-432a-af30-13b0c9944371",
    "erroritem": [ { "index": 1, "field": "recipient", "message": "Geçersiz telefon numarası formatı" } ]
  } }
```

| Alan | Açıklama |
|---|---|
| `data.uid` | İşlemin kimliği. Loglanır ve destek talebinde paylaşılır. |
| `data.erroritem[]` | İYS'nin reddettiği kayıtlar; yalnızca reddedilen kayıt varsa bulunur. |
| `data.erroritem[].index` | Kaydın `permissions` içindeki sırası (**0'dan başlar**). |
| `data.erroritem[].field` | Hatalı alan. |
| `data.erroritem[].message` | Hata mesajı. |

- **Kısmi red normaldir.** İYS bazı kayıtları reddederse işlem yine başarılı sayılır: kabul edilenler
  işlenir, reddedilenler `erroritem` ile döner. `erroritem` her zaman işlenir: reddedilen kayıt
  düzeltilip yeni istekte gönderilir; düzeltilemiyorsa izin kaydedilmemiş sayılır.
- İşlenme sonuçları ve sonraki izin değişiklikleri webhook adresine bildirilir ([webhook.md](webhook.md)).
- Hatalar: `400` (120), `401` (50–53), `403` (60, 61, 63), `422` (70, ayrıntı `data.errors`), `424`
  (112), `429` (150), `500` (110); sözleşme genel hata tablosunda `503` (141) de vardır. Hangisinin
  tekrar denenebileceği: [errors.md](errors.md).

### Ne zaman kaydedilir

- Alıcı izin verdiğinde `status: ONAY`, izni geri aldığında ya da reddettiğinde `status: RET`.
- Bilgi Bankası'na (NetİYS SSS) göre alınan izinler **3 iş günü içinde** İYS'ye bildirilir.
- Aynı alıcının birden fazla izin tipi (`MESAJ`, `ARAMA`, `EPOSTA`) ayrı kayıtlar olarak, aynı istekte
  gönderilebilir.
- Çok sayıda izin 500'lük parçalarla gönderilir. Parçalar arasında yanıt beklenir; `429` alınırsa
  artan beklemeyle devam edilir.

## `GET /consents`: izin sorgulama

Bir ya da birden fazla alıcının İYS'deki izin durumunu sorgular. Kayıtlar sorgu parametresi olarak
(adres satırında) taşınır.

| Parametre | Zorunlu | Açıklama |
|---|---|---|
| `brandCode` | evet | İYS marka kodu. |
| `path` | hayır | Gönderilmezse `SMSAPI`. |
| `refId` | hayır | Referans değeri. Çoklu sorguda `data[i][refId]` gönderilmeyen kayıtlar için kullanılır. |
| `recipient`, `recipientType`, `type` | `data` yoksa evet | Tekil sorgu. |
| `data[i][recipient]`, `data[i][recipientType]`, `data[i][type]` | çoklu sorguda evet | Çoklu sorgu, 1–1000 kayıt. |
| `data[i][refId]` | hayır | Kayda özel referans. |

**Tekil sorgu:**

```http
GET /iys/v1/consents?brandCode=<marka kodunuz>&recipient=%2B90XXXXXXXXXX&recipientType=BIREYSEL&type=MESAJ
Authorization: Bearer <access_token>
```

**Çoklu sorgu** (`deepObject` biçimi):

```http
GET /iys/v1/consents?brandCode=<marka kodunuz>&data[0][recipient]=%2B90XXXXXXXXXX&data[0][recipientType]=BIREYSEL&data[0][type]=MESAJ&data[1][recipient]=ornek@example.com&data[1][recipientType]=BIREYSEL&data[1][type]=EPOSTA
Authorization: Bearer <access_token>
```

- `+` adres satırında `%2B` olarak kodlanır; kodlanmazsa boşluğa dönüşür ve numara geçersiz olur.
  Spec örneği köşeli parantezleri (`[`, `]`) kodlamadan yazar; HTTP kütüphanelerinin bunları `%5B`,
  `%5D` olarak kodlaması standart URL kodlamasıdır.
- `data` içinde tek kayıt varsa tekil sorgu yapılır; yanıt tekil sorguyla aynıdır.
- Kayıtlar adres satırında taşındığı için çok sayıda kayıtta URL uzunluk sınırına dikkat edilir.
  1000 sınırı sözleşmenindir; adres satırı için daha küçük parçalar (örneğin 100–200 kayıt) kullanmak
  güvenlidir.
- İsteğin tamamını etkileyen bir hata (örneğin geçersiz `brandCode`) isteği `400` ile sonlandırır.

### Yanıt

```json
{
  "success": true, "errorCode": 0, "message": "success",
  "data": [
    { "type": "MESAJ", "source": "HS_WEB", "recipient": "+90XXXXXXXXXX", "status": "ONAY",
      "consentDate": "2026-01-01 10:00:00", "recipientType": "BIREYSEL", "creationDate": null,
      "queryStatus": null, "retailerAccessCount": null, "errorCode": 0, "message": null },
    { "type": "EPOSTA", "source": null, "recipient": "ornek@example.com", "status": null,
      "consentDate": null, "recipientType": "BIREYSEL", "creationDate": null,
      "queryStatus": null, "retailerAccessCount": null, "errorCode": 81, "message": "Resource not found" }
  ]
}
```

| Alan | Açıklama |
|---|---|
| `data[]` | Sonuçlar, **gönderilen kayıtlarla aynı sırada**. |
| `status` | `ONAY`, `RET` ya da `null`. |
| `source`, `consentDate` | İznin kaynağı ve tarihi; kayıt yoksa `null`. |
| `type`, `recipient`, `recipientType` | Sorgulanan değerler; hatalı kayıtta da korunur. |
| `creationDate`, `queryStatus` | Sözleşmede tanımı yok; izin kararı bunlara göre verilmez. |
| `retailerAccessCount` | Yalnızca çoklu sorguda. |
| `errorCode`, `message` | Yalnızca çoklu sorguda, kayıt bazında: `0` başarılı, `81` kayıt bulunamadı, `120` hatalı istek, `112` İYS'den geçerli yanıt alınamadı. |

**İzin kararı:** Ticari ileti için yalnızca `status: "ONAY"` izin demektir. `RET`, `null` ya da
`errorCode` `81` izin yok demektir. Kayıt bazlı `112` ya da `120` "bilinmiyor" demektir; izin varmış
gibi davranılmaz, kayıt daha sonra yeniden sorgulanır ya da düzeltilir.

Hatalar: `400` (120), `401` (50–53), `403` (60, 61, 63), `422` (70), `424` (112), `429` (150),
`500` (110). Ayrıntı: [errors.md](errors.md).

### Sorgu ne için kullanılır

- Kendi müşteri kayıtlarınızdaki izin durumunu İYS ile karşılaştırmak (mutabakat), müşteri ekranında
  izin durumunu göstermek, bir kaydın işlenip işlenmediğini doğrulamak.
- **Her SMS gönderiminden önce alıcı alıcı sorgulamak gerekmez:** ticari gönderimde SMS API'nin
  `iysFilter` parametresi izni olmayan alıcıları eler ([with-sms.md](with-sms.md)).
