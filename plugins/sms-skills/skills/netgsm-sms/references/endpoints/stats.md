# `GET /stats`: gönderim istatistiklerini sorgulama

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/read-stats/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/stats:`).

## Ne işe yarar

Hesabın bir görevi için, gönderildiği ay üzerinden toplanmış sonuçları döndürür: her farklı sonuç için
bir satır (kaç alıcı, kaç parça, yurt içi mi, ücretlendirme durumu). Alıcı bazlı sonuç için
[`GET /report`](report.md) kullanılır.

## İstek alanları (sorgu parametreleri)

| Parametre | Tür | Zorunlu | Açıklama |
|---|---|---|---|
| `jobId` | string | evet | Görev numarası. |
| `month` | string, `yyyy-MM` | hayır | Görevin gönderildiği ay. Varsayılan, içinde bulunulan ay. |

## Örnek istek

```http
GET /sms/v3/stats?jobId=179309912974612345062827&month=2026-09
Authorization: Bearer <access_token>
```

## Örnek yanıt

`200 OK` (her zaman en az bir satır):

```json
{
  "jobId": "179309912974612345062827",
  "month": "2026-09",
  "count": 2,
  "stats": [
    {
      "status": "DELIVERED",
      "failReason": null,
      "messageCount": 4,
      "totalParts": 4,
      "domestic": true,
      "charging": "charged",
      "chargeDescription": "1.26 TL from: credit balance"
    },
    {
      "status": "NOT_DELIVERED",
      "failReason": "INVALID_NUMBER",
      "messageCount": 1,
      "totalParts": 0,
      "domestic": true,
      "charging": "uncharged",
      "chargeDescription": null
    }
  ]
}
```

| Alan | Açıklama |
|---|---|
| `jobId`, `month` | Sorgulanan görev ve ay (`yyyy-MM`). |
| `count` | Satır sayısı. |
| `stats[].status` | `PENDING`, `DELIVERED`, `NOT_DELIVERED`; `GET /report`'taki `status` ile aynı. |
| `stats[].failReason` | Yalnızca `NOT_DELIVERED`'da dolu. Burada yalnızca şu değerler görülür: `INVALID_NUMBER`, `NOT_SENT_TO_OPERATOR`, `OPERATOR_REJECTED`, `OPERATOR_ERROR`, `SEND_ERROR`, `DUPLICATE`, `INSUFFICIENT_CREDIT`, `BLACKLISTED`, `IYS_REJECTED`, `MESSAGE_NOT_CREATED`, `TIMEOUT`, `UNKNOWN`. Tanınmayan bir neden `UNKNOWN` döner. |
| `stats[].messageCount` | Bu şekilde sonuçlanan alıcı sayısı. |
| `stats[].totalParts` | Bu alıcıların kapladığı SMS parçalarının toplamı. |
| `stats[].domestic` | Yurt içi gönderim mi. |
| `stats[].charging` | Ücretlendirme durumu: `charged`, `refunded` ya da `uncharged`. |
| `stats[].chargeDescription` | Ücretlendirme hakkında bir cümle. Hiç ücret alınmadıysa `null`. |

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `jobId` eksik ya da boş, `month` `yyyy-MM` değil; `message` parametreyi söyler. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | SMS menüsü olmayan bir alt kullanıcı. | [errors.md](../errors.md#forbidden-403) |
| 404 | `NOT_FOUND` | `message` `job not found`: bu görev için o ayda satır yok. Bilinmeyen kimlik, başka hesabın görevi ve yanlış ay birbirinden ayrılmaz. | [errors.md](../errors.md#diğer-uç-nokta-notları) |
| 429 | `RATE_LIMITED` | Hesap için dakikada 60 istek aşıldı ya da bu görev numarası son 10 dakika içinde sorulmuş; `message` hangisi olduğunu söyler. `Retry-After`: engelleyen sayacın dolmasına kalan saniye. | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | Hiçbir şey yapılmadı; tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **Aynı görev 10 dakikada bir sorulabilir** ve iki sayaç da okuma `404` ya da `503` ile bitse bile
  işler. Yanlış ayla yapılan sorgu da görevin 10 dakikalık hakkını kullanır. Bu yüzden görevin
  gönderildiği ayı (`yyyy-MM`) `jobId` ile birlikte saklayın; zamanlanmış görevde bu
  genellikle `startAt`'ın ayıdır.
- **Neden başına toplam için** aynı `failReason`'ı taşıyan satırların `messageCount`'larını toplayın:
  satırlar ücretlendirmenin yanı sıra iç sonuç koduna göre de ayrılır, aynı neden birden fazla satırda
  görülebilir (örneğin iki ayrı `INVALID_NUMBER` satırı, ikisi de `charged`).
- **İptal edilen görev** `404` döner. OTP görevleri için mock da `404` döner.
- **Mock:** `00` ile biten alıcıların `UNKNOWN_SUBSCRIBER` nedeni `/stats`'ın listesinde olmadığı için
  burada `UNKNOWN` görünür. Ücret açıklaması mock'ta temsilidir.
