# `GET /report`: iletim raporlarını sorgulama

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/read-reports/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/report:`).

## Ne işe yarar

Hesabın iletim raporlarından bir sayfa döndürür: her alıcı için mesajın iletilip iletilmediği,
operatörü, parça sayısı ve iletilmediyse nedeni. Sürekli takip için sorgulamak yerine
[rapor webhook'u](webhooks.md) tercih edilir; `/report` webhook'un kaçırdıklarını tamamlamak ve tek
seferlik kontroller içindir.

## İstek alanları (sorgu parametreleri)

| Parametre | Tür | Zorunlu | Açıklama |
|---|---|---|---|
| `jobIds` | string dizisi | hayır | Tekrarlanabilir (`jobIds=a&jobIds=b`) ya da virgülle ayrılmış (`jobIds=a,b`). Verilmezse aralıktaki bütün görevler döner. |
| `startAt` | ISO-8601, saat dilimiyle | hayır | Yalnızca `stopAt` ile birlikte. |
| `stopAt` | ISO-8601, saat dilimiyle | hayır | Yalnızca `startAt` ile birlikte. `startAt`'tan önce ya da ondan 1 aydan fazla sonra olamaz. |
| `page` | tam sayı, en az 0 (varsayılan 0) | hayır | Sayfa numarası. |

- `startAt` ve `stopAt` **mesajın gönderildiği zamana** uygulanır. Birlikte gönderilir ya da ikisi de
  gönderilmez. Hiçbiri yoksa içinde bulunulan ayın 1'i 00:00'dan (Europe/Istanbul) şimdiye kadar
  kullanılır. Aralık 1 ayı aşamaz.
- Aralık dakika hassasiyetindedir: `startAt`'ın bulunduğu dakikanın başından `stopAt`'ın bulunduğu
  dakikanın sonuna kadar gönderilen mesajlar döner.
- Saat dilimi farkındaki `+` URL'de `%2B` olarak kodlanır.

## Örnek istek

```http
GET /sms/v3/report?jobIds=179309912974612345062827&startAt=2026-08-01T00:00:00%2B03:00&stopAt=2026-08-31T23:59:59%2B03:00&page=0
Authorization: Bearer <access_token>
```

## Örnek yanıt

`200 OK`:

```json
{
  "count": 2,
  "page": 0,
  "reports": [
    {
      "jobId": "179309912974612345062827",
      "number": "5xxxxxxxxx",
      "status": "DELIVERED",
      "operator": "VODAFONE",
      "messageLength": 1,
      "deliveredAt": "2026-08-31T12:34:56+03:00",
      "failReason": null,
      "referenceId": "8f3a1c"
    },
    {
      "jobId": "179309912974612345062827",
      "number": "5xxxxxxxxx",
      "status": "NOT_DELIVERED",
      "operator": "VODAFONE",
      "messageLength": 1,
      "deliveredAt": null,
      "failReason": "TIMEOUT",
      "referenceId": null
    }
  ]
}
```

Her satırda sekiz alanın tamamı bulunur; değeri olmayan alan `null` gelir.

| Alan | Açıklama |
|---|---|
| `count` | Bu sayfadaki rapor sayısı. |
| `page` | Döndürülen sayfa. |
| `reports[].jobId` | Görev numarası. |
| `reports[].number` | Alıcı numarası; yurt içi numaralar `90` öneki olmadan yazılır. |
| `reports[].status` | `PENDING` (bekliyor), `DELIVERED` (iletildi), `NOT_DELIVERED` (iletilmedi, nedeni `failReason`'da). Durum bilgisi yoksa `null`. |
| `reports[].operator` | `VODAFONE`, `TURK_TELEKOM`, `TURKCELL`, `NETGSM`, `AKONTEL`, yurt dışı için `INTERNATIONAL`, tanınmayan operatör için `UNKNOWN`. Bilgi yoksa `null`. |
| `reports[].messageLength` | Mesajın kapladığı SMS parça sayısı. |
| `reports[].deliveredAt` | İletildiği zaman. Yalnızca `DELIVERED`'da dolu. |
| `reports[].failReason` | İletilmeme nedeni. Yalnızca `NOT_DELIVERED`'da dolu. 24 değerin anlamı: [errors.md](../errors.md), "İletim hata nedenleri" bölümü. |
| `reports[].referenceId` | İletim raporunun referansı. Yoksa `null`. |

## Sayfalama ve sıra

- Bir sayfada en fazla 100 rapor bulunur. Bütün raporlar için `count` 100'ün altında dönene kadar
  sonraki sayfalar istenir. Boş sayfa `count` 0 ile `200` döner.
- Raporlar kaydedildikleri sırayla döner. Sayfalar gezilirken yeni raporlar eklenebilir; aynı sorgunun
  sayfaları farklı zamanlarda farklı sonuç verebilir.

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | Sınırlardan biri ISO-8601 değil ya da `page` sayı değil (`message` parametreyi söyler); `page` negatif; `startAt` ve `stopAt`'tan yalnızca biri var; `stopAt` `startAt`'tan önce; aralık 1 aydan geniş. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | SMS menüsü olmayan bir alt kullanıcı. | [errors.md](../errors.md#forbidden-403) |
| 429 | `RATE_LIMITED` | Hesap için dakikada 60 istek aşıldı ya da istekteki bir görev numarası son bir dakika içinde sorulmuş; `message` hangisi olduğunu söyler. `Retry-After`: engelleyen sayacın dolmasına kalan saniye. | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | İstek daha sonra tekrar gönderilebilir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **Raporda olmayan alıcı, iletim raporu henüz gelmemiş demektir:** mesaj hâlâ bekliyordur. Bu bir
  hata değildir; rapor daha sonra yeniden sorgulanır. Yeni gelen bir raporun yanıta yansıması 5 dakikayı
  bulabilir.
- **Aynı görev dakikada bir sorulabilir.** Daha sık sorgu `429` alır. Görev bazlı `429` alıyorsanız
  sorgulamak yerine [rapor webhook'u](webhooks.md) kullanın (bkz.
  [limits-and-batching.md](../limits-and-batching.md)).
- **Bir görevin 100'den fazla satırı varsa** sonraki sayfa da aynı görev numarasını sorduğu için görev
  bazlı sınıra takılır. Sınır istekteki `jobIds`'e uygulandığından, büyük bir görevin sayfalarını
  `jobIds` vermeden, gönderim zamanını kapsayan dar bir `startAt`/`stopAt` aralığıyla gezmek bu sınıra
  takılmaz (spec'teki sınır tanımından çıkan sonuç; hesap başına dakikada 60 istek yine geçerlidir).
- **OTP `jobId`'leri sorgulanamaz** (bkz. [send-otp.md](send-otp.md)). İptal edilen görev satır
  üretmez.
- **Gönderimde `503` / `504` sonrası kontrol:** istekteki alıcıları `number` alanında arayın (yurt içi
  numaralar `90` öneki olmadan). Tarif: [errors.md](../errors.md#503-ve-504-sonrası-kontrol).
- **Webhook gövdesinin alan adları farklıdır** (`jobid`, `msglen`, `deliveredDate`, `referansID`); bkz.
  [webhooks.md](webhooks.md).
- **Mock:** kayıtlar başlangıçtan 5 saniye sonrasına kadar `PENDING`, sonra `DELIVERED` olur; `00` ile
  biten alıcılar `NOT_DELIVERED` / `UNKNOWN_SUBSCRIBER` döner. Saati `POST /__mock/clock` ile ileri
  alabilirsiniz (bkz. [testing.md](../testing.md)).
