# `GET /templates`: şablonları listeleme

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/list-templates/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/templates:`).

## Ne işe yarar

Hesabın [`POST /send/template`](send-template.md) ile kullanabileceği şablonları, en yenisi önce, sayfa
sayfa listeler: hesabın kendi şablonları ve herkese açık şablonlar. Her şablon, gönderimde `params`
içinde verilmesi gereken parametreleri ve her birinin kabul ettiği değer türünü taşır.

## İstek alanları (sorgu parametreleri)

| Parametre | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `includePublic` | boolean (varsayılan `true`) | hayır | `false` yalnızca hesabın kendi şablonlarını listeler. |
| `type` | string, en fazla 100 | hayır | Şablon tipi, birebir eşleşir (örn. `AUTH_OTP`). |
| `search` | string, en fazla 100 | hayır | Açıklamada geçen metin; büyük/küçük harf fark etmez. |
| `content` | string, en fazla 100 | hayır | Şablon metninde geçen metin; büyük/küçük harf fark etmez. |
| `page` | tam sayı, en az 0 (varsayılan 0) | hayır | Sıfırdan başlayan sayfa numarası. |
| `size` | tam sayı, 1–100 (varsayılan 20) | hayır | Sayfa başına şablon. |

## Örnek istek

```http
GET /sms/v3/templates?type=AUTH_OTP&includePublic=false&page=0&size=20
Authorization: Bearer <access_token>
```

## Örnek yanıt

`200 OK` (boş sayfa da `200` döner):

```json
{
  "count": 1,
  "page": 0,
  "total": 1,
  "totalPages": 1,
  "templates": [
    {
      "templateId": 3,
      "content": "Dogrulama kodunuz: ${otpCode}",
      "type": "AUTH_OTP",
      "description": "Giriş kodu",
      "public": false,
      "parameters": [{ "name": "otpCode", "type": "BIGINT", "maxLength": null }],
      "createdAt": "2026-05-18T11:25:12.502+03:00"
    }
  ]
}
```

| Alan | Açıklama |
|---|---|
| `count` | Bu sayfadaki şablon sayısı. |
| `page` | İstenen sayfa. |
| `total` | Filtreye uyan şablonların bütün sayfalardaki toplamı. |
| `totalPages` | Bu `size` ile toplam sayfa sayısı. |
| `templates[].templateId` | Şablonun kimliği; `POST /send/template` kayıtlarındaki `templateId`. |
| `templates[].content` | Şablon metni. Yer tutucular `${ad}` biçimindedir ve gönderimde `params` ile doldurulur. |
| `templates[].type` | Şablon tipi, örn. `AUTH_OTP`, `SECURITY_ALERT`, `SERVICE_ALERT`. |
| `templates[].description` | Şablonun açıklaması; olmayabilir (`null`). |
| `templates[].public` | Herkese açık şablonsa `true`, hesabın kendi şablonuysa `false`. |
| `templates[].parameters[]` | Yer tutucular: `name` (`params` anahtarı), `type` (`BIGINT`, `FLOAT`, `TEXT`, `DATE`, `DATETIME`), `maxLength` (yalnızca `TEXT` için dolu). Değer biçimleri: [send-template.md](send-template.md). |
| `templates[].createdAt` | Kayıt zamanı, saat dilimiyle; olmayabilir (`null`). |

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `page must not be negative`, `size must be between 1 and 100`, `type must be at most 100 characters` (bir filtre 100 karakterden uzun). | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 429 | `RATE_LIMITED` | `template list rate limit exceeded`: hesap başına dakikada 20 istek aşıldı. | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | Hiçbir şey yapılmadı; tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **Dakikada 20 istek** (hesap başına; pencere ilk istekle başlar ve sabittir; reddedilen istekler de
  sayılır). Listeyi her gönderimden önce okumak yerine önbelleğe alın ve şablon değiştiğinde yenileyin
  (öneri).
- **Şablon API ile oluşturulmaz.** Spec'te yalnızca listeleme ucu vardır.
- **Mock:** her test hesabında şablon 1 (sandbox'ınkiyle aynı: herkese açık `AUTH_OTP`, `name` `TEXT` en
  fazla 50, `code` `TEXT` en fazla 10), şablon 3 (`AUTH_OTP`, `otpCode` `BIGINT`), şablon 4 (herkese açık,
  parametresiz) ve şablon 5 (`date` `DATE`, `note` `TEXT` en fazla 30) bulunur. Sandbox'ta yalnızca şablon 1
  vardır.
