# `POST /send/template`: şablonla SMS gönderme

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/send-from-template/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/send/template:`).

## Ne işe yarar

Kayıtlı şablonları verilen parametrelerle doldurup gönderen bir görev oluşturur. Her kayıt bir şablon,
şablonun parametreleri ve bir alıcıdır. Kullanılabilecek şablonlar hesabın kendi şablonları ve herkese
açık şablonlardır; kimlikleri ve parametreleri [`GET /templates`](templates.md) ile listelenir.
Doldurulan metinler `/send`'e verilmiş gibi işlenir ve yanıt `/send` yanıtıyla aynıdır.

## İstek alanları

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `sender` | string, 1–35 | evet | Gönderici başlığı, `/send`'deki gibi birebir eşleşir. |
| `templates` | dizi, 1–20 kayıt | evet | Her alıcı için bir şablon kaydı. Bir kayıt hatalıysa (eksik alan, kullanılamayan şablon, uymayan parametre) istek `400` alır. |
| `templates[].templateId` | tam sayı, en az 1 | evet | Şablonun kimliği. Hesabın kendi şablonu ya da herkese açık bir şablon olmalıdır. |
| `templates[].recipient` | string, en fazla 17, `/send` ile aynı desen | evet | Türkiye için `90` ve 10 rakam, yurt dışı için `-` ve 9–17 rakam. Boş ya da 17 karakterden uzunsa istek `400`; biçime uymayan kayıt şablon doldurulduktan sonra `INVALID_RECIPIENT` ile reddedilir. |
| `templates[].params` | nesne, ad → string değer | koşullu | Şablondaki yer tutucuların değerleri. Şablonun bütün parametreleri verilir ve boş olmaz; şablonda olmayan ad verilmez. Yer tutucusu olmayan şablonda alan verilmez. |
| `encoding` | `DEFAULT` · `TURKISH` · `UNICODE` | hayır | `/send` ile aynı; büyük/küçük harfe duyarlıdır, listede olmayan değer `400`. |
| `iysFilter` | `NONE` · `BRAND` · `RETAILER` · `BRAND_AND_RETAILER` | hayır | `/send` ile aynı (`REJECTED_IYS` kontrolleri yalnızca `BRAND` ve `RETAILER` için). |
| `startAt`, `stopAt` | ISO-8601, saat dilimiyle | hayır | `/send` ile aynı kurallar: saat dilimi farkı zorunlu, `stopAt` verilmezse ya da geçmişteyse `startAt` + 21 saat (bkz. [send.md](send.md)). |
| `partnerCode` | string, en fazla 32 | hayır | Yalnızca kayıt amaçlıdır. |
| `referenceId` | string, en fazla 50 | hayır | Yanıtta aynen geri döner. |
| `appName` | string, en fazla 50 | hayır | Yalnızca kayıt amaçlıdır. |

**Parametre değerleri** her zaman string olarak yazılır ve parametrenin tanımlı türüne uyar:

| Tür | Kabul edilen |
|---|---|
| `BIGINT` | Tam sayı, örn. `"123456"` |
| `FLOAT` | En fazla 4 ondalık basamaklı sayı, örn. `"12.50"` |
| `TEXT` | Şablonda tanımlı uzunluğu (`maxLength`) aşmayan metin |
| `DATE` | `dd.MM.yyyy` ya da `dd/MM/yyyy` |
| `DATETIME` | `dd.MM.yyyy HH:mm[:ss]` ya da `dd/MM/yyyy HH:mm[:ss]` |

## Örnek istek

`<onaylı başlığınız>` yerine hesabınıza kayıtlı başlığı yazın (mock'ta `MOCKTEST` ya da `TESTHEADER`, sandbox'ta `TESTHEADER`). Şablon 3'ün bir
`otpCode` parametresi vardır, şablon 4'ün parametresi yoktur.

```http
POST /sms/v3/send/template
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "sender": "<onaylı başlığınız>",
  "templates": [
    { "templateId": 3, "recipient": "905xxxxxxxx1", "params": { "otpCode": "123456" } },
    { "templateId": 4, "recipient": "905xxxxxxxx2" }
  ],
  "encoding": "TURKISH",
  "referenceId": "order-4711"
}
```

## Örnek yanıt

`202 Accepted` (alanlar [send.md](send.md#örnek-yanıt) ile aynı; `rejectedItems[].index` burada
`templates` dizisindeki konumdur):

```json
{
  "jobId": "179309912974612345078627",
  "status": "QUEUED",
  "accepted": 2,
  "rejected": 0,
  "rejectedItems": [],
  "rejectedItemsTruncated": false,
  "referenceId": "order-4711"
}
```

Şablon hatası isteğin tamamını reddeder (`400`):

```json
{
  "code": "INVALID_REQUEST",
  "message": "templates not found: [4]",
  "requestId": "3b9e0c1d2f4a4b6c8d0e1f2a3b4c5d6e",
  "timestamp": "2026-10-30T14:05:12.481+03:00",
  "violations": null
}
```

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | Gövde doğrulaması (`violations`, örn. `templates[0].recipient`), `templates not found: [4]`, `Invalid params for templateId 3. Missing params: [otpCode]`, `Invalid params for templateId 3. Unexpected params: [code]`, `param 'otpCode' is not a valid BIGINT`. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 400 | `INVALID_SEND_WINDOW` | `startAt` 18 aydan daha ileride. | [errors.md](../errors.md#sms-api-kodları) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | `/send` ile aynı üç `message`. | [errors.md](../errors.md#forbidden-403) |
| 422 | `REJECTED_HEADER` | `/send` ile aynı beş ret adı. | [errors.md](../errors.md#rejected_header-422) |
| 422 | `REJECTED_IYS` | `sender header has no iys brand code` ya da `account is not in iys mode, filtering cannot be applied`. | [errors.md](../errors.md#rejected_iys-422) |
| 422 | `NO_DELIVERABLE_MESSAGES` | Doldurulan kayıtların hepsi reddedildi; görev oluşmadı. | [errors.md](../errors.md#kayıt-red-nedenleri) |
| 429 | `RATE_LIMITED` | `template send rate limit exceeded`: hesap başına dakikada 1000 istek aşıldı. | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | Servis geçici olarak kullanılamıyor. Görev çoğunlukla kuyruğa alınmamıştır; toplu gönderimi körlemesine yeniden göndermeden önce `GET /report` ile kontrol edin. | [errors.md](../errors.md#503-ve-504-sonrası-kontrol) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. Gönderim ucunda kuyruğa alınmış olabilir gibi ele alınır. | [errors.md](../errors.md#hızlı-karar-tablosu) |

Bu uçta `504` yoktur. Türü uymayan bir değer (listede olmayan `encoding`, saat dilimi farkı olmayan
tarih, sayı olmayan `templateId`, nesne ya da dizi verilmiş `params` değeri gibi) `/send`'deki gibi `400`
`1 field(s) rejected` ile tek ihlal alır (`templates[0].params.code` gibi bir yolla); yalnızca bozuk JSON
`request body could not be read as json` alır (bkz. [send.md](send.md#hatalar)).

## Dikkat edilecekler

- **Yurt dışı alıcıda uzunluk sınırı çelişkisi.** Yayımlanan spec `templates[].recipient` için iki sınır
  taşır ve bunlar uyuşmaz: `maxLength: 17` ile `^(90\d{10}|-\d{9,17})$` deseni (yurt dışı: `-` ve 17
  rakam = 18 karakter). Daha kısıtlayıcı olana güvenin: alıcı en fazla **17 karakter** olmalıdır, yani
  yurt dışında `-` ve en fazla 16 rakam. Mock da böyle davranır: 17 karakterden uzun alıcıyı deseni
  denemeden `400` ile reddeder. Spec'i bu yüzden düzeltmeyin; 18 karakterlik bir numarayı göndermeyin.
- **Şablon hataları isteğin tamamını reddeder.** `/send`'den farklı olarak eksik ya da geçersiz
  `templateId` veya `recipient`, hesabın kullanamadığı şablon ya da uymayan parametre `400` döndürür ve
  hiçbir şey gönderilmez. Şablonlar doldurulduktan sonra kayıtlar `/send`'deki gibi tek tek
  değerlendirilir (alıcı biçimi, metin uzunluğu, mükerrer alıcı) ve `rejectedItems`'ta bildirilir.
- **`templates not found` nedenini ayırmaz:** şablon yok, silinmiş ya da başka hesaba ait olabilir.
  `GET /templates` ile kullanılabilir şablonlara bakın.
- **İstek başına en fazla 20 kayıt; dakikada 1000 istek** (`/send` sınırından ayrı; pencere ilk istekle
  başlar ve sabittir; reddedilen istekler de sayılır). Çok sayıda alıcıda istekleri 20'şerli bölün ya da
  metni kendiniz doldurup tek `/send` isteğiyle gönderin (bkz.
  [limits-and-batching.md](../limits-and-batching.md)).
- **Şablon listesini önbelleğe alın.** `GET /templates` dakikada 20 istekle sınırlıdır; her gönderimden
  önce listelemek gerekmez (öneri).
- **İstekler tekilleştirilmez:** `503` ya da `500` sonrası körlemesine tekrar iki görev oluşturabilir.
  Önce `GET /report` ile kontrol edin; `referenceId` ile ilgili ipucu:
  [errors.md](../errors.md#503-ve-504-sonrası-kontrol).
- **Mock:** her test hesabında şablon 1 (sandbox'taki tek şablonla aynı: herkese açık `AUTH_OTP`,
  `Merhaba ${name}, kodunuz ${code}`, ikisi de `TEXT`, en fazla 50 ve 10), şablon 3 (`AUTH_OTP`,
  `${otpCode}` `BIGINT`), şablon 4 (herkese açık, parametresiz) ve şablon 5 (`${date}` `DATE`,
  `${note}` `TEXT` en fazla 30) bulunur. Sandbox'ta yalnızca şablon 1 vardır (bkz. [sandbox.md](../sandbox.md)).
