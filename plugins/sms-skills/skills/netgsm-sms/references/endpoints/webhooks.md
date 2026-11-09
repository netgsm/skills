# `/webhooks/report` ve `/webhooks/inbox`: webhook kaydı

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/register-report-webhook/ · https://api-docs.netgsm.com.tr/delete-report-webhook/ · https://api-docs.netgsm.com.tr/register-inbox-webhook/ · https://api-docs.netgsm.com.tr/delete-inbox-webhook/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/webhooks/report:`,
`/webhooks/inbox:`).

## Ne işe yarar

Netgsm'in iletim raporlarını ve hesaba gelen SMS'leri sizin adresinize `POST` etmesini sağlar. Rapor
için sorgulama (polling) yerine tercih edilen yol budur.

| Metot | Yol | Görevi | Başarılı yanıt |
|---|---|---|---|
| POST | `/webhooks/report` | İletim raporu webhook'unu kaydeder | `201` |
| DELETE | `/webhooks/report` | İletim raporu webhook'unu siler | `204` (gövde yok) |
| POST | `/webhooks/inbox` | Gelen SMS webhook'unu kaydeder | `201` |
| DELETE | `/webhooks/inbox` | Gelen SMS webhook'unu siler | `204` (gövde yok) |

Hesap başına bir rapor ve bir gelen SMS webhook'u olur. Var olanın üzerine kayıt `409` alır: adres
değişecekse önce `DELETE`, sonra `POST`. Etkinleştirme gerekmez; alt kullanıcı için SMS menüsü gerekir.

## İstek alanları

`POST` gövdesi (iki yol için aynı):

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `url` | string, en fazla 1024 | evet | Host'u yalnızca genel (public) adreslere çözümlenen mutlak bir `http` ya da `https` URL. Loopback, özel, link-local ya da başka bir iç adres olamaz. Port verilirse 1–65535. |
| `headers` | string, en fazla 500 | hayır | Netgsm'in adresinize her istekte aynen göndereceği tek bir başlık satırı, `Name: value` biçiminde (örn. `Authorization: Bearer <token>`). Yalnızca yazdırılabilir ASCII, satır sonu yok; değer virgül (`,`) ya da iki nokta üst üste (`:`) içeremez. Boş bırakılırsa ek başlık gönderilmez. |

`DELETE` gövde almaz.

## Örnek istek

```http
POST /sms/v3/webhooks/report
Authorization: Bearer <access_token>
Content-Type: application/json

{ "url": "https://example.com/report", "headers": "Authorization: Bearer token123" }
```

```http
DELETE /sms/v3/webhooks/report
Authorization: Bearer <access_token>
```

## Örnek yanıt

`201 Created` (alanlar spec'teki `WebhookResponse` şemasından; değerler örnektir):

```json
{
  "url": "https://example.com/report",
  "headers": "Authorization: Bearer token123",
  "registeredAt": "2026-10-27T14:00:00+03:00"
}
```

| Alan | Açıklama |
|---|---|
| `url` | Kayıtlı adres. |
| `headers` | Kayıtta verilen başlık satırı; verilmediyse `null`. |
| `registeredAt` | Webhook'un kaydedildiği zaman. |

## Adresinize gelen istekler

### İletim raporu

Raporlar kayıtlı adrese periyodik olarak ve toplu hâlde `POST` edilir. Bir istek, hesabın bekleyen
raporlarından bir grubu `numbers` dizisinde taşır; rapor sayısı fazlaysa aynı periyotta birden fazla
isteğe bölünebilir. Kayıttan sonra sonuçlanmış ve daha önce gönderilmemiş her iletim raporu bir kez
gönderilir. **Bekleyen (henüz sonuçlanmamış) gönderimler webhook ile bildirilmez;** yalnızca sonuçlananlar
gelir.

`status`, `operator` ve `errorCode` **sayısal kodlardır**; `GET /report` aynı bilgiyi ad olarak
döndürür (`DELIVERED`, `VODAFONE`, `TIMEOUT` gibi). Karşılıklar aşağıdaki tablolardadır.

```json
{
  "numbers": [
    {
      "jobid": "179309912974612345062827",
      "number": "5xxxxxxxxx",
      "status": 1,
      "operator": 10,
      "msglen": 1,
      "deliveredDate": "2026-10-27 14:06:12",
      "errorCode": 0,
      "referansID": "8f3a1c"
    },
    {
      "jobid": "179309912974612345062827",
      "number": "5xxxxxxxxx",
      "status": 2,
      "operator": 30,
      "msglen": 1,
      "deliveredDate": "2026-10-27 14:09:40",
      "errorCode": 115,
      "referansID": null
    }
  ]
}
```

| Alan | Tür | `GET /report` karşılığı | Açıklama |
|---|---|---|---|
| `jobid` | string | `jobId` | Gönderim ucunun döndürdüğü görev numarası. |
| `number` | string | `number` | Alıcı numarası. |
| `status` | tam sayı | `status` (+ `failReason`) | İletim sonucu; aşağıdaki tablo. |
| `operator` | tam sayı | `operator` | Alıcının operatörü; aşağıdaki tablo. Belirlenemiyorsa (örneğin numara hatalıysa) `0`. |
| `msglen` | tam sayı | `messageLength` | Mesajın kapladığı SMS parça sayısı. |
| `deliveredDate` | string | `deliveredAt` | İletildiği zaman, `yyyy-MM-dd HH:mm:ss`, Türkiye saatiyle (UTC+3), saat dilimi bilgisi olmadan. Tarih yoksa boş string (`""`). |
| `errorCode` | tam sayı, `null` olabilir | `failReason` | İletilmeme nedeni. **Yalnızca `status` `2` olduğunda anlamlıdır**; diğer durumlarda nedeni `status` belirtir ve bu alan dikkate alınmaz. |
| `referansID` | string, `null` olabilir | `referenceId` | Gönderimde verilen referans; verilmediyse `null`. |

Alan adları ve değer türleri `GET /report` yanıtındakilerden **farklıdır**; ikisini aynı tiple
ayrıştırmayın. Webhook gövdesinde `failReason` alanı yoktur: nedeni `status` ya da `errorCode` verir.

#### Kodlar ve `GET /report` karşılıkları

`status`:

| Kod | Anlamı | `GET /report` karşılığı |
|---|---|---|
| `1` | İletildi | `DELIVERED` |
| `2` | Ulaştırılamadı; nedeni `errorCode` alanındadır | `NOT_DELIVERED` (`failReason` `errorCode`'dan) |
| `3` | Hatalı numara | `NOT_DELIVERED`, `INVALID_NUMBER` |
| `4` | Operatöre gönderilemedi | `NOT_DELIVERED`, `NOT_SENT_TO_OPERATOR` |
| `8` | Operatör kabul etmedi | `NOT_DELIVERED`, `OPERATOR_REJECTED` |
| `11` | Operatör hatası | `NOT_DELIVERED`, `OPERATOR_ERROR` |
| `12` | Gönderim hatası | `NOT_DELIVERED`, `SEND_ERROR` |
| `13` | Mükerrer | `NOT_DELIVERED`, `DUPLICATE` |
| `14` | Kredisi yetmedi | `NOT_DELIVERED`, `INSUFFICIENT_CREDIT` |
| `15` | Kara liste | `NOT_DELIVERED`, `BLACKLISTED` |
| `16` | İYS ret | `NOT_DELIVERED`, `IYS_REJECTED` |
| `17` | İYS hata | `NOT_DELIVERED`, `IYS_ERROR` |
| `18` | Mesaj oluşturulamadı | `NOT_DELIVERED`, `MESSAGE_NOT_CREATED` |
| `19` | Hatalı numara formatı | `NOT_DELIVERED`, `INVALID_NUMBER_FORMAT` |
| `20` | NTS'den onay alınamadı | `NOT_DELIVERED`, `NTS_NOT_APPROVED` |
| `22` | Yurt dışı gönderim izni yok | `NOT_DELIVERED`, `NO_INTERNATIONAL_PERMISSION` |

`errorCode` (yalnızca `status` `2` iken):

| Kod | Anlamı | `GET /report` `failReason` |
|---|---|---|
| `111` | Zaman aşımı | `TIMEOUT` |
| `112` | Mobil cihaz SMS gönderimine kapalı | `SMS_DISABLED_ON_DEVICE` |
| `113` | Mobil cihaz desteklemiyor | `DEVICE_NOT_SUPPORTED` |
| `114` | Yönlendirme başarısız | `ROUTING_FAILED` |
| `115` | Hedef operatörden zaman aşımı | `OPERATOR_TIMEOUT` |
| `116` | Tanımlanamayan abone | `UNKNOWN_SUBSCRIBER` |
| `117` | Yasadışı abone | `ILLEGAL_SUBSCRIBER` |
| `119` | Sistemsel hata | `SYSTEM_ERROR` |
| `0` ya da `null` | Neden bilinmiyor | `UNKNOWN` |

`operator`:

| Kod | Operatör | `GET /report` karşılığı |
|---|---|---|
| `10` | Vodafone | `VODAFONE` |
| `20` | Türk Telekom | `TURK_TELEKOM` |
| `30` | Turkcell | `TURKCELL` |
| `40`, `41`, `43` | Netgsm | `NETGSM` |
| `45` | Akontel | `AKONTEL` |
| `210`–`218` | Yurt dışı | `INTERNATIONAL` |
| `0` | Belirlenemedi | `UNKNOWN` |

Raporları `GET /report` satırlarıyla aynı yerde saklıyorsanız bu tablolarla ada çevirin. Tabloda
olmayan bir kod gelirse bir ad uydurmayın: ham kodu da saklayın, `UNKNOWN` sayın ve gerekirse `jobid`
ile teknik desteğe sorun. Nedenlerin anlamı ve yapılacaklar: [errors.md](../errors.md), "İletim hata
nedenleri" bölümü.

```ts
// Webhook kodu → GET /report adı (spec tabloları). Bilinmeyen kod UNKNOWN olur.
const STATUS_FAIL: Record<number, string> = {
  3: 'INVALID_NUMBER', 4: 'NOT_SENT_TO_OPERATOR', 8: 'OPERATOR_REJECTED', 11: 'OPERATOR_ERROR',
  12: 'SEND_ERROR', 13: 'DUPLICATE', 14: 'INSUFFICIENT_CREDIT', 15: 'BLACKLISTED', 16: 'IYS_REJECTED',
  17: 'IYS_ERROR', 18: 'MESSAGE_NOT_CREATED', 19: 'INVALID_NUMBER_FORMAT', 20: 'NTS_NOT_APPROVED',
  22: 'NO_INTERNATIONAL_PERMISSION',
};
const ERROR_CODE: Record<number, string> = {
  111: 'TIMEOUT', 112: 'SMS_DISABLED_ON_DEVICE', 113: 'DEVICE_NOT_SUPPORTED', 114: 'ROUTING_FAILED',
  115: 'OPERATOR_TIMEOUT', 116: 'UNKNOWN_SUBSCRIBER', 117: 'ILLEGAL_SUBSCRIBER', 119: 'SYSTEM_ERROR',
};
function toReport(e: { status: number; errorCode: number | null }) {
  if (e.status === 1) return { status: 'DELIVERED', failReason: null };
  if (e.status === 2) return { status: 'NOT_DELIVERED', failReason: ERROR_CODE[e.errorCode ?? 0] ?? 'UNKNOWN' };
  return { status: 'NOT_DELIVERED', failReason: STATUS_FAIL[e.status] ?? 'UNKNOWN' };
}
function operatorName(code: number): string {
  if (code === 10) return 'VODAFONE';
  if (code === 20) return 'TURK_TELEKOM';
  if (code === 30) return 'TURKCELL';
  if (code === 40 || code === 41 || code === 43) return 'NETGSM';
  if (code === 45) return 'AKONTEL';
  if (code >= 210 && code <= 218) return 'INTERNATIONAL';
  return 'UNKNOWN';
}
```

### Gelen SMS

Hesaba gelen her SMS, geldiği anda kayıtlı adrese **tek tek** `POST` edilir. Her istekte isteğe özgü bir
`X-Correlation-Id` (UUID) başlığı bulunur; destek talebinde bu değer paylaşılır.

```json
{
  "messageId": "4815162342",
  "messageDateTime": "2026-10-27 14:06:12",
  "sourceNumber": "5xxxxxxxxx",
  "content": "Merhaba",
  "subscriberNumber": "850xxxxxxx"
}
```

| Alan | Açıklama |
|---|---|
| `messageId` | Gelen mesajın kimliği. |
| `messageDateTime` | Alındığı zaman, `yyyy-MM-dd HH:mm:ss`, Türkiye saatiyle, saat dilimi bilgisi olmadan. |
| `sourceNumber` | Mesajı gönderen numaranın son 10 hanesi (`90` öneki olmadan). |
| `content` | Mesaj metni. |
| `subscriberNumber` | Mesajın geldiği, hesaba ait numara. |

Değeri olmayan alanlar boş string olarak gönderilir.

### Teslim kuralları

| | İletim raporu | Gelen SMS |
|---|---|---|
| Süre | Bağlantı 60 saniyede kurulmalı, yanıt 10 dakikada gelmeli | Adres 4 saniyede yanıt vermeli |
| Başarı | Herhangi bir `2xx`; yanıt gövdesi okunmaz | Herhangi bir `2xx`; yanıt gövdesi dikkate alınmaz |
| Başarısızlık (zaman aşımı, `2xx` dışı yanıt, bağlantı hatası) | O istekteki raporlar **yeniden gönderilmez**; `GET /report` ile alınır | Mesaj **yeniden gönderilmez**; `GET /inbox` ile alınır |

Kayıtta `headers` verildiyse o başlık her istekte gönderilir; isteğin Netgsm'den geldiğini bununla
doğrulayın.

## Hatalar

| HTTP | `code` | Metot | Ne zaman | Ayrıntı |
|---|---|---|---|---|
| 400 | `INVALID_REQUEST` | `POST` | `url` eksik, çok uzun ya da host içeren mutlak bir http(s) URL değil; host çözümlenmiyor ya da yalnızca genel adreslere çözümlenmiyor; `headers` çok uzun, tek bir `Name: value` satırı değil ya da değerinde virgül veya iki nokta üst üste var; `url` ya da `headers` nesne veya dizi (`1 field(s) rejected`, tek ihlal); gövde JSON değil. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | hepsi | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | hepsi | SMS menüsü olmayan bir alt kullanıcı. | [errors.md](../errors.md#forbidden-403) |
| 404 | `NOT_FOUND` | `DELETE` | Kayıtlı webhook yok. | [errors.md](../errors.md#sms-api-kodları) |
| 409 | `ALREADY_EXISTS` | `POST` | Kayıtlı webhook var (önce silin) ya da hesap için başka bir kayıt sürüyor (o tamamlanınca tekrar gönderin). | [errors.md](../errors.md#sms-api-kodları) |
| 429 | `RATE_LIMITED` | hepsi | Uç noktanın sınırı aşıldı; `Retry-After` kadar bekleyin. | [limits-and-batching.md](../limits-and-batching.md) |
| 503 | `SERVICE_UNAVAILABLE` | hepsi | Tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | hepsi | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **Hemen `2xx` dönün.** Teslim tekrarlanmadığı için alıcı adres gelen gövdeyi önce kalıcı olarak
  kaydedip hemen `2xx` dönmeli, işi sonra yapmalıdır. Gelen SMS'te süre yalnızca 4 saniyedir.
- **Kodları ada çevirin.** Rapor webhook'unda `status`, `operator` ve `errorCode` sayıdır; `status`'u
  `DELIVERED` gibi bir adla karşılaştıran kod hiçbir raporu iletildi saymaz. `errorCode`'u yalnızca
  `status` `2` iken okuyun.
- **Kaçanları tamamlayın.** Adresiniz bir süre erişilemezse o süredeki raporları `GET /report`, gelen
  SMS'leri `GET /inbox` ile alın.
- **`headers` değerini doğrulayın** ve bu değeri gizli tutun. Değerde `,` ve `:` olamayacağı için
  token'ı buna göre üretin. Alıcı, beklenen token tanımsız ya da boşsa **her isteği reddetmeli**
  (fail-closed), başlığı zorunlu tutmalı ve sabit zamanlı karşılaştırma kullanmalıdır
  (bkz. [examples](../examples/)).
- **Adres genel (public) olmalıdır.** Canlı API `localhost`, `127.0.0.1` ya da özel ağ adreslerini
  kabul etmez. Geliştirme makinenizde canlı webhook almak için dışarıdan erişilebilen bir adres (örneğin
  bir tünel) gerekir.
- **İstek sınırı:** spec sayı vermez; `429` ve `Retry-After`'a göre davranın.
- **Sandbox:** webhook uçları sandbox'ta yoktur (`404`); webhook'ları mock'ta deneyin.
- **Mock'ta sapma:** mock, `localhost`, `127.0.0.1` ve `::1` adreslerini kabul eder ki yerel bir alıcıyla
  test edebilesiniz. Gelen SMS'i `POST /__mock/inbound` ile tetiklersiniz (bkz.
  [testing.md](../testing.md)).
