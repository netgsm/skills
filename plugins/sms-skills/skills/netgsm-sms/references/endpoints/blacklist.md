# `GET /blacklist`: kara listeyi öğrenme

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/read-blacklist/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/blacklist:`).

## Ne işe yarar

Hesabın kara listesindeki numaraları döndürür. İki kullanımı vardır:

- **Liste:** `number` verilmezse kara liste sayfa sayfa döner. Her sayfada en fazla 200 numara bulunur,
  en son eklenen önce gelir. İlk sayfa 0'dır.
- **Tek numara sorgusu:** `number` verilirse yalnızca o numaraya bakılır. Numara kara listedeyse
  `count` 0'dan büyüktür ve numara `numbers` içindedir; değilse `count` 0 ve `numbers` boştur.

Kara listede numara olmaması ya da listenin sonunu geçen bir sayfanın istenmesi hata değildir: `count` 0
ve boş `numbers` ile `200` döner.

## İstek alanları (sorgu parametreleri)

| Parametre | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `page` | tam sayı, en az 0 (varsayılan 0) | hayır | İstenen sayfa. Tek numara sorgusunda yanıtı etkilemez. |
| `number` | string, `^[0-9]{1,15}$` | hayır | Sorgulanacak tek numara; bir alıcı için `90` ve on rakam (`905xxxxxxxxx`). Yalnızca rakam, en fazla 15; başka her şey `400` alır. Baştaki ve sondaki boşluklar kırpılır; boş değer `number` hiç verilmemiş sayılır. |

## Örnek istek

```http
GET /sms/v3/blacklist?page=0
Authorization: Bearer <access_token>
```

```http
GET /sms/v3/blacklist?number=905xxxxxxxxx
Authorization: Bearer <access_token>
```

## Örnek yanıt

Liste (`200 OK`):

```json
{ "count": 1, "page": 0, "number": null, "numbers": ["905xxxxxxxxx"] }
```

Tek numara sorgusu (`200 OK`):

```json
{ "count": 1, "page": null, "number": "905xxxxxxxxx", "numbers": ["905xxxxxxxxx"] }
```

| Alan | Açıklama |
|---|---|
| `count` | `numbers` içindeki numara sayısı. Tek numara sorgusunda `0`, numaranın kara listede olmadığını gösterir. |
| `page` | Döndürülen, sıfırdan başlayan sayfa. Tek numara sorgusunda `null`. |
| `number` | Sorgulanan numara, aynen geri döner. Sayfa isteğinde `null`. |
| `numbers` | Engellenen numaralar saklandığı biçimde, en yenisi önce. |

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `page` sayı değil ya da negatif, `number` 1 ile 15 rakam arasında değil; `message` parametreyi söyler. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 429 | `RATE_LIMITED` | Hesap dakikada 60 istek sınırını aştı ya da aynı sorgu (aynı `page` ve `number`) son 10 dakika içinde yanıtlandı; `message` hangisi olduğunu söyler. `Retry-After`: engelleyen sayacın dolmasına kalan saniye. | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | Hiçbir şey yapılmadı; tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **Aynı sorgu 10 dakikada bir yanıtlanır.** Hatayla sonuçlanan bir sorgu beklemeden tekrar
  gönderilebilir. Sonucu kendi tarafınızda saklayın; aynı numarayı her gönderimden önce sormayın.
- **Kara listedeki numaraya giden mesaj** iletim raporunda `failReason` `BLACKLISTED` ile görülür
  (bkz. [errors.md](../errors.md), "İletim hata nedenleri" bölümü).
- **Kara listeye ekleme ya da çıkarma** için spec'te uç nokta yoktur; yalnızca okuma vardır.
- **Mock ve sandbox:** kara listede `5000000001` ve `5000000002` bulunur (sandbox'ınkiyle aynı).
