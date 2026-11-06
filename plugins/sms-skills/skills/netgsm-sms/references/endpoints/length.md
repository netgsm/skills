# `POST /length`: SMS uzunluğunu hesaplama

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/measure-length/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/length:`).

## Ne işe yarar

Bir metnin kaç SMS parçası tuttuğunu ve sınıra ne kadar uzak olduğunu, `/send`'in saydığı şekilde
birebir hesaplar. Yalnızca bir hesaplamadır: hiçbir şey gönderilmez ya da saklanmaz. `/send`'deki
`MESSAGE_TOO_LONG` reddiyle aynı kuralı kullanır.

## İstek alanları

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `text` | string, en fazla 10000 | evet | Mesaj metni. Boş olabilir. |
| `encoding` | `DEFAULT` · `TURKISH` · `UNICODE` (varsayılan `DEFAULT`) | hayır | Gönderimde kullanılacak kodlama. |
| `alphanumericSender` | boolean (varsayılan `false`) | hayır | Metin bir alfanümerik başlıktan gönderilecekse `true`; bu başlık 5 karakter tutar. Gönderici alfanümerikse her zaman `true` verin: `false` bırakılırsa yanıt, `/send`'in kabul ettiğinden 5 karakter fazlasına izin verir. |

## Örnek istek

```http
POST /sms/v3/length
Authorization: Bearer <access_token>
Content-Type: application/json

{ "text": "Merhaba, şifreniz 123456", "encoding": "TURKISH", "alphanumericSender": true }
```

## Örnek yanıt

`200 OK`:

```json
{
  "encoding": "TURKISH",
  "length": 30,
  "parts": 1,
  "limit": 888,
  "fits": true,
  "remaining": 858,
  "remainingUntilNextPart": 125
}
```

Metin 24 karakterdir; `ş` `TURKISH`'te iki sayılır (25), alfanümerik başlık 5 ekler (30).

| Alan | Açıklama |
|---|---|
| `encoding` | Kullanılan kodlama. |
| `length` | `/send`'in saydığı uzunluk: `TURKISH`'te kaçışlı her Türkçe harf için iki, alfanümerik gönderici için artı beş. |
| `parts` | Metnin kapladığı SMS sayısı. Boş metin için `0`. |
| `limit` | Gönderici maliyeti dahil `length`'in alabileceği en büyük değer. En uzun metin değildir: alfanümerik başlıkta metin en fazla `limit - 5` olur. |
| `fits` | `/send`'in bu uzunlukta bir metni kabul edip etmeyeceği. |
| `remaining` | Sınıra kadar kalan karakter. Metin sınırı aşıyorsa aştığı kadar negatif. |
| `remainingUntilNextPart` | Bir SMS parçası daha gerekmeden önce kalan karakter. Metin sığmıyorsa `0`. |

Fazla uzun bir metin hata değildir: `200` ile `fits: false` ve negatif `remaining` döner.

## Sayım kuralları

| `encoding` | Tek parça en fazla | Çok parçada parça başına | En fazla (6 parça) |
|---|---|---|---|
| `DEFAULT` | 160 | 153 | 917 |
| `TURKISH` | 155 | 148 | 888 |
| `UNICODE` | 70 | 66 | 396 |

- En fazla 6 parça. Değerler `length` içindir; alfanümerik başlığın 5 karakteri `length`'e eklenir.
- `DEFAULT`: her karakter 1 sayılır. Türkçe karakterler gönderimde Latin karşılıklarına çevrilir
  (ç→c, ş→s gibi).
- `TURKISH`: yalnızca `çğışĞİŞ` iki karakter sayılır; `ö`, `ü`, `Ç`, `Ö`, `Ü` bir sayılır.
- `UNICODE`: UTF-16 kod birimleri sayılır; bir emoji 2 sayılır.

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `text` yok ya da 10000 karakterden uzun, `encoding` bilinmiyor ya da gövde JSON değil. Türü uymayan değer `1 field(s) rejected` ile tek ihlal alır: listede olmayan `encoding` `must be one of DEFAULT, TURKISH, UNICODE (case sensitive)`, `alphanumericSender` için `"evet"` gibi bir değer `must be true or false`. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 503 | `SERVICE_UNAVAILABLE` | Hiçbir şey yapılmadı; tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **Parça sayısı maliyeti belirler.** Uzun ya da kişiselleştirilmiş metinlerde gönderimden önce
  ölçmek, beklenmedik parça artışını gösterir. `TURKISH`'te tek bir `ş` metni bir sonraki parçaya
  taşıyabilir.
- **`alphanumericSender`'ı doğru verin.** Yanlış `false` değeri, `/send`'de `MESSAGE_TOO_LONG` ile
  reddedilecek bir metni sığıyor gösterir.
- **OTP farklıdır:** `/send/otp` her zaman tek SMS'tir; metni kırpıp ASCII'ye çevirir ve uzunluğu
  çevrilmiş metne göre sayar (alfanümerik başlıkta 155, abone numarasında 160 karakter). `/length` bu
  çeviriyi yapmaz. Bkz. [send-otp.md](send-otp.md).
- Spec bu uç nokta için `429` yanıtı tanımlamaz.
