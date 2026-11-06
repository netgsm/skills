# `GET /inbox`: gelen SMS'leri listeleme

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/read-inbox/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/inbox:`).

## Ne işe yarar

Hesaba gelen SMS'leri, isteğe bağlı olarak bir zaman aralığıyla sınırlayıp döndürür. Gelen SMS'leri
anında almak için [gelen SMS webhook'u](webhooks.md) tercih edilir; `/inbox` webhook'un kaçırdıklarını
tamamlamak içindir.

## İstek alanları (sorgu parametreleri)

| Parametre | Tür | Zorunlu | Açıklama |
|---|---|---|---|
| `startAt` | ISO-8601, saat dilimiyle | hayır | Yalnızca `stopAt` ile birlikte. |
| `stopAt` | ISO-8601, saat dilimiyle | hayır | Yalnızca `startAt` ile birlikte. `startAt`'tan önce ya da ondan 2 aydan fazla sonra olamaz. |

- `startAt` ve `stopAt` birlikte gönderilir ya da ikisi de gönderilmez. Hiçbiri yoksa içinde bulunulan
  ayın 1'i 00:00'dan (Europe/Istanbul) şimdiye kadar kullanılır. Aralık 2 ayı aşamaz.
- Saat dilimi farkındaki `+` URL'de `%2B` olarak kodlanır.

## Örnek istek

```http
GET /sms/v3/inbox?startAt=2026-08-31T00:00:00%2B03:00&stopAt=2026-08-31T23:59:59%2B03:00
Authorization: Bearer <access_token>
```

## Örnek yanıt

`200 OK`:

```json
{
  "count": 1,
  "messages": [
    {
      "id": "1",
      "jobId": "179309912974612345062827",
      "sender": "5xxxxxxxxx",
      "text": "Merhaba",
      "operator": "NETGSM MOBIL",
      "receivedAt": "2026-08-31T12:00:00+03:00"
    }
  ],
  "truncated": false
}
```

| Alan | Açıklama |
|---|---|
| `count` | Dönen mesaj sayısı. Boş gelen kutusu `count` 0 ile `200` döner. |
| `messages[].id` | Mesajın kimliği. |
| `messages[].jobId` | Mesajın ait olduğu görev, atanmışsa; aksi halde `null`. |
| `messages[].sender` | Mesajın geldiği numara; yurt içi numaralar `90` öneki olmadan yazılır. |
| `messages[].text` | Mesaj metni. |
| `messages[].operator` | Mesajın geldiği operatörün adı (örn. `NETGSM MOBIL`). Bir ad, kod değil. |
| `messages[].receivedAt` | Alındığı zaman, saat dilimiyle. Bilgi yoksa `null`. |
| `truncated` | 500 mesaj sınırına ulaşıldıysa ve aralıkta daha fazlası olabilirse `true`. `count` 500'ün altındayken de `true` olabilir. |

Mesaj alanlarının hepsi `null` olabilir.

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | Sınırlardan biri ISO-8601 değil (`message` parametreyi söyler); yalnızca biri var; `stopAt` `startAt`'tan önce; aralık 2 aydan geniş. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | Hesapta gelen SMS etkin değil ya da SMS menüsü olmayan bir alt kullanıcı. | [errors.md](../errors.md#forbidden-403) |
| 429 | `RATE_LIMITED` | Uç noktanın sınırı aşıldı; `Retry-After` kadar bekleyin. | [limits-and-batching.md](../limits-and-batching.md) |
| 503 | `SERVICE_UNAVAILABLE` | Hiçbir şey yapılmadı; tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **`truncated` `true` ise** geri kalanlar için daha dar bir aralık sorgulanır. Aralığı ikiye bölüp
  `truncated` `false` olana kadar daraltmak bir yöntemdir (öneri).
- **Webhook'la birlikte kullanım:** gelen SMS webhook'u başarısız teslimi tekrar göndermez; kaçanlar
  `/inbox` ile alınır.
- **İstek sınırı:** spec sayı vermez; `429` ve `Retry-After`'a göre davranın.
- **Mock:** gelen SMS'i `POST /__mock/inbound` ile eklersiniz; kayıtlı bir gelen SMS webhook'u varsa
  mesaj ona da gönderilir (bkz. [testing.md](../testing.md)).
