# `GET /senders`, `GET /senders/default`, `PUT /senders/default`: gönderici başlıkları

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/list-senders/ · https://api-docs.netgsm.com.tr/read-default-sender/ · https://api-docs.netgsm.com.tr/change-default-sender/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/senders:`,
`/senders/default:`).

## Ne işe yarar

| Metot | Yol | Görevi |
|---|---|---|
| GET | `/senders` | Hesaba kayıtlı gönderici başlıklarını ve her birinin gönderimde kullanılıp kullanılamayacağını listeler. |
| GET | `/senders/default` | Hesabın varsayılan başlığını döndürür. |
| PUT | `/senders/default` | Kayıtlı bir başlığı varsayılan yapar. |

Gönderim isteklerindeki `sender` değeri buradaki `name` ile **birebir** aynı olmalıdır.

## İstek alanları

`GET /senders` ve `GET /senders/default` parametre almaz.

`PUT /senders/default` gövdesi:

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `name` | string, en az 1 | evet | Varsayılan yapılacak başlık, birebir kayıtlı hâliyle: büyük/küçük harf dahil, kırpma yok, `0` ya da `90` öneki yok. |

## Örnek istek

```http
GET /sms/v3/senders
Authorization: Bearer <access_token>
```

```http
PUT /sms/v3/senders/default
Authorization: Bearer <access_token>
Content-Type: application/json

{ "name": "<onaylı başlığınız>" }
```

## Örnek yanıt

`GET /senders`, `200 OK` (spec örneğinden; `<onaylı başlığınız>` yerine hesabınızın kayıtlı başlıkları
görünür, mock'ta `MOCKTEST`, `TESTHEADER`, `MOCKKAPALI` ve hesabın abone numarası):

```json
{
  "count": 2,
  "senders": [
    { "name": "<onaylı başlığınız>", "type": "ALPHANUMERIC", "brandCode": 4567, "usable": true, "reason": null },
    { "name": "5xxxxxxxxx", "type": "SUBSCRIBER_NUMBER", "brandCode": 0, "usable": false, "reason": "SUBSCRIBER_NUMBER_RESTRICTED" }
  ]
}
```

`GET /senders/default` ve `PUT /senders/default`, `200 OK`:

```json
{
  "sender": { "name": "<onaylı başlığınız>", "type": "ALPHANUMERIC", "brandCode": 4567, "usable": true, "reason": null }
}
```

Varsayılan ayarlanmamışsa `GET /senders/default` `{ "sender": null }` döner.

| Alan | Açıklama |
|---|---|
| `name` | Kayıtlı hâliyle başlık; gönderimde `sender` için kullanılacak değer. Abone numaraları yalın numaradır. |
| `type` | `ALPHANUMERIC`, `SUBSCRIBER_NUMBER` ya da `UNKNOWN`. |
| `brandCode` | Kayıtlı İYS marka kodu; yoksa `0`. Her zaman bulunur. |
| `usable` | Bu başlıktan yapılacak bir gönderimin bu hesap için kabul edilip edilmeyeceği. |
| `reason` | Yalnızca `usable` `false` olduğunda dolu: `ROUTING_CODE_MISSING` (hesapta yönlendirme kodu yok; alfanümerik başlıklar bunu gerektirir) ya da `SUBSCRIBER_NUMBER_RESTRICTED` (hesapta abone numarasından gönderim kısıtlı). Gönderim reddinde kullanılan adın aynısıdır. |

## Hatalar

| HTTP | `code` | Uç nokta | Ne zaman | Ayrıntı |
|---|---|---|---|---|
| 400 | `INVALID_REQUEST` | `PUT` | `name` eksik, boş ya da nesne veya dizi (`violations` belirtir; nesne ya da diziyse `1 field(s) rejected`, `must be a string`) ya da gövde JSON değil. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | hepsi | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | hepsi | SMS menüsü olmayan bir alt kullanıcı. | [errors.md](../errors.md#forbidden-403) |
| 422 | `REJECTED_HEADER` | `PUT` | `message`: `NO_HEADERS_REGISTERED`, `NOT_REGISTERED` ya da `CASE_MISMATCH`. | [errors.md](../errors.md#rejected_header-422) |
| 429 | `RATE_LIMITED` | hepsi | Uç noktanın sınırı aşıldı; `Retry-After` kadar bekleyin. | [limits-and-batching.md](../limits-and-batching.md) |
| 503 | `SERVICE_UNAVAILABLE` | hepsi | Tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | hepsi | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **Kullanılamayan başlık da varsayılan yapılabilir.** `PUT /senders/default` bu durumda hata değil,
  `200` ile `usable: false` ve `reason` döner. Yanıttaki `usable`'ı kontrol edin.
- **`sender` her gönderim isteğinde zorunludur.** Varsayılan başlığı ayarlamak bu alanı göndermeyi
  gereksiz kılmaz.
- **İYS filtresi** (`iysFilter` `NONE` dışında) başlığın `brandCode`'unun dolu olmasını gerektirir;
  `0` ise gönderim `422 REJECTED_IYS` alır.
- **Abone numaraları** yalnızca abone numarasından gönderime onaylı hesaplarda listelenir. Başlığı
  olmayan hesap `count` 0 ile `200` alır.
- **Değişikliklerin yansıması:** eklenen, değiştirilen ya da silinen başlık hemen görünür. Hesabın abone
  numarası onayındaki değişikliğin listeye yansıması 15 dakikayı, hesap ayarlarındaki bir değişikliğin
  (örneğin yönlendirme kodu) `usable` ve `reason`'a yansıması kısa bir süreyi bulabilir.
  `GET /senders/default` anlık okunur.
- **İstek sınırları:** spec sayı vermez; `429` ve `Retry-After`'a göre davranın. Başlık listesini her
  gönderimden önce okumak yerine kısa süre önbelleğe almak yeterlidir (öneri).
- **Yeni başlık** API ile eklenmez; başlık talebi:
  https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi
- **Mock:** `MOCKTEST` (varsayılan) ve `TESTHEADER` kullanılabilir (İYS modundaki hesaplarda `brandCode`
  4567), `MOCKKAPALI` kayıtlı ama kullanılamaz (`ROUTING_CODE_MISSING`), hesabın abone numarası
  (`username`) da başlık olarak kullanılabilir.
- **Sandbox:** `TESTHEADER` (varsayılan, kullanılabilir) ve `8500000000` (abone numarası, kullanılamaz:
  `SUBSCRIBER_NUMBER_RESTRICTED`). `PUT /senders/default` sandbox'ta kaydedilmez (bkz. [sandbox.md](../sandbox.md)).
