# `POST /cancel`: zamanlanmış gönderimi iptal etme

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/cancel-job/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/cancel:`).

## Ne işe yarar

Hesabınızın henüz gönderilmemiş bir görevini geri çeker. Görev numarasını istek gövdesinde gönderirsiniz.

**Hangi görevler.** Yalnızca hesabınıza ait ve hâlâ bekleyen bir görev iptal edilebilir; başka bir
hesabın görevini iptal etmenin yolu yoktur. Bekleyen görev, `POST /send` ya da `POST /send/template`
yanıtında `status` `SCHEDULED` almış görevdir ve başlangıç zamanına kadar iptal edilebilir. `QUEUED`
yanıtı alan bir görev zaten gönderilmektedir; iptal etmek `404` döner. `POST /directory/send` her zaman
`QUEUED` döndüğü için rehber gönderimleri bu uçla iptal edilemez.

## İstek alanları

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `jobId` | string, 1–64 | evet | `POST /send` ya da `POST /send/template` yanıtındaki `jobId`, **yazıldığı gibi**: kırpma yapılmaz, değeri yanıttaki hâliyle gönderin. Boş ya da yalnızca boşluktan oluşan değer `400` alır. |

## Örnek istek

```http
POST /sms/v3/cancel
Authorization: Bearer <access_token>
Content-Type: application/json

{ "jobId": "179309912974612345062827" }
```

## Örnek yanıt

`200 OK`: görev bekliyordu ve artık iptal edildi.

```json
{ "jobId": "179309912974612345062827", "cancelledAt": "2026-09-10T12:00:00+03:00" }
```

| Alan | Açıklama |
|---|---|
| `jobId` | İptal edilen görev; istekteki `jobId`, aynen. |
| `cancelledAt` | İptalin onaylandığı zaman, saat dilimi farkıyla. |

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `message` aşağıdaki tabloda. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | `sub user may not use the sms api`: SMS menüsü olmayan bir alt kullanıcı. Ana hesap için ayrıca bir etkinleştirme gerekmez. | [errors.md](../errors.md#forbidden-403) |
| 404 | `NOT_FOUND` | `job not found for this account, or no longer waiting to be sent`: bu kimlikle hesabınıza ait bekleyen görev yok. Hiç var olmadı, başka bir hesaba ait, zaten gönderildi (`QUEUED` görevler dahil) ya da daha önce iptal edildi; bu durumlar birbirinden ayrılmaz. | [errors.md](../errors.md#sms-api-kodları) |
| 429 | `RATE_LIMITED` | `cancel rate limit exceeded`: hesap başına dakikada 25.000 istek aşıldı; `Retry-After` kadar bekleyin. | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | İptal servisine ulaşılamadı, servis bir hata döndü ya da tanınmayan bir yanıt verdi. Görev büyük olasılıkla iptal edilmedi; isteği yeniden gönderin. Görev bu arada iptal edildiyse `404` döner. | [errors.md](../errors.md#503-ve-504-sonrası-kontrol) |
| 504 | `QUEUE_UNCONFIRMED` | İptal iletildi ama yanıtı alınamadı; görev iptal edilmiş olabilir. İptali yeniden gönderin: iptal edildiyse `404` döner. | [errors.md](../errors.md#503-ve-504-sonrası-kontrol) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. İptali yeniden göndermek SMS göndermez. | [errors.md](../errors.md#sms-api-kodları) |

`400 INVALID_REQUEST` için `message`:

| `message` | Ne zaman |
|---|---|
| `1 field(s) rejected` | `jobId` eksik, boş, yalnızca boşluktan oluşuyor, 64 karakterden uzun ya da nesne veya dizi (`must be a string`). `violations` belirtir. |
| `request body could not be read as json` | Gövde geçerli bir JSON değil. |

## Dikkat edilecekler

- **İptal edilebilir mi, `status` söyler.** Gönderim yanıtındaki `status` `QUEUED` ise görev iptal
  edilemez (`404`). Bir gönderimi iptal edebilmeniz gerekiyorsa `/send` ya da `/send/template`'te
  başlangıcı birkaç dakika ileri verin (`SCHEDULED` kuralı: [send.md](send.md#dikkat-edilecekler)).
  `/directory/send` görevleri her zaman `QUEUED` döner ve iptal edilemez.
- **İptali yeniden göndermek her zaman güvenlidir.** `503`, `504` ya da `500` sonrası tekrar SMS
  göndermez; görev ilk istekte iptal edildiyse ikinci istek `404` döner. `404`, bekleyen görev
  kalmadığını gösterir (iptal edildi ya da gönderildi); hangisi olduğunu `GET /report` satırlarından
  anlayabilirsiniz.
- **`404` durumları ayırmaz:** görev hiç olmadı, başka hesaba ait, zaten gönderildi ya da daha önce
  iptal edildi.
- **İptal edilen görev** `GET /report`'ta satır üretmez ve `GET /stats` için `404` döner.
- **İstek sınırı:** hesap başına dakikada 25.000 istek; pencere ilk istekle başlar ve sabittir.
- **OTP:** OTP gönderimleri anında yapılır; mock OTP görevleri için `/cancel`'da `404` döner.
