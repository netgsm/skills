# `POST /send/otp`: OTP SMS gönderme

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/send-otp/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister (bkz.
[auth.md](../auth.md)). Sözleşmenin tamamı: [openapi.yaml](../openapi.yaml) (`/send/otp:`).

## Ne işe yarar

Tek bir alıcıya OTP (tek kullanımlık şifre) SMS'i gönderir. OTP, toplu SMS'ten ayrı bir kanaldan
anında gönderilir; her istek **tek mesaj ve tek alıcıdır**. `202` döndüğünde mesaj operatöre
iletilmiştir; teslim sonradan olur.

## İstek

| Başlık | Zorunlu | Açıklama |
|---|---|---|
| `x-client` | hayır | Yalnızca **kurumsal OTP hizmeti** tanımlı hesaplar gönderir; değeri `enterprise` (küçük harfle, yazıldığı gibi). Diğer hesaplar bu başlığı göndermez. Uyuşmazlık iki yönde de `403 FORBIDDEN` (`account operator is not served for this operation`) alır. |

| Alan | Tür ve sınır | Zorunlu | Açıklama |
|---|---|---|---|
| `sender` | string, en az 1 | evet | Hesaba kayıtlı alfanümerik başlık (örn. `NETGSM`) ya da hesabın abone numarası. **Büyük/küçük harf fark etmez.** Abone numarası `5XXXXXXXXX`, `05XXXXXXXXX` ya da `905XXXXXXXXX` yazılabilir. Kayıtlı başlıklar: [senders.md](senders.md). |
| `text` | string, en az 1 | evet | OTP metni. Kırpılır ve karakterleri çevrilir (aşağıda). |
| `recipient` | string, en az 1 | evet | Türkiye cep numarası: `5XXXXXXXXX`, `05XXXXXXXXX` ya da `905XXXXXXXXX`; başına `+` eklenebilir (`+905XXXXXXXXX`). Boşluk ya da yurt dışı numarası kabul edilmez (`400 recipient is not a valid number`). |
| `appName` | string | hayır | Gönderimi yapan uygulamanın adı. Yalnızca kayıt amaçlıdır. |

**Metnin işlenmesi.** Baştaki ve sondaki boşluklar kırpılır, karakterler gönderimden önce çevrilir:

| Metinde | Gönderilen |
|---|---|
| `ç ğ ı ö ş ü Ç Ğ İ Ö Ş Ü` | `c g i o s u C G I O S U` |
| `{ [` / `} ]` | `(` / `)` |
| `“` `”` `` ` `` | `"` |
| `‘ ’` | `'` |
| `~` | `?` |
| `€` | `;EO;` |
| sekme, `\|` | boşluk |
| `^` | silinir |
| satır sonu | `\n` (iki karakter) |
| diğer desteklenmeyen karakterler (emoji gibi) | `?` |

OTP her zaman tek SMS'tir. Uzunluk **çevrilmiş metin** üzerinden sayılır:

| Gönderici | En fazla uzunluk |
|---|---|
| Alfanümerik başlık | 155 |
| Abone numarası | 160 |

Alfanümerik başlıkta sınır daha kısadır, çünkü operatör kodu metnin sonuna eklenir. Çeviri uzunluğu
değiştirebilir: `€` dört, satır sonu iki karakter olur.

## Örnek istek

`<onaylı başlığınız>` yerine hesabınıza kayıtlı başlığı yazın (mock'ta `MOCKTEST` ya da `TESTHEADER`, sandbox'ta `TESTHEADER`).

```http
POST /sms/v3/send/otp
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "sender": "<onaylı başlığınız>",
  "text": "Dogrulama kodunuz: 123456",
  "recipient": "905xxxxxxxxx",
  "appName": "shop"
}
```

Kurumsal OTP hizmeti tanımlı bir hesapta aynı istek `x-client: enterprise` başlığıyla gönderilir.

## Örnek yanıt

`202 Accepted`:

```json
{ "jobId": "175518151237512050610525430" }
```

`jobId` OTP gönderiminin kimliğidir; bir sorun bildirirken paylaşmalısınız.

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `message` aşağıdaki tabloda. | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 403 | `FORBIDDEN` | `/send`'deki üç `message`. `account operator is not served for this operation` burada `x-client` uyuşmazlığıdır: kurumsal OTP hesabı başlığı göndermedi ya da diğer bir hesap başlıkla istek yaptı. | [errors.md](../errors.md#forbidden-403) |
| 422 | `REJECTED_HEADER` | `NO_HEADERS_REGISTERED`, `NOT_REGISTERED`, `ROUTING_CODE_MISSING`, `SUBSCRIBER_NUMBER_RESTRICTED`. `CASE_MISMATCH` yoktur ve abone numarası eki eklenmez. | [errors.md](../errors.md#rejected_header-422) |
| 422 | `INSUFFICIENT_CREDIT` | `no credit, package or campaign to pay for the otp`. Hiçbir şey gönderilmedi; bakiye yükledikten sonra yeniden deneyebilirsiniz. | [errors.md](../errors.md#sms-api-kodları) |
| 503 | `SERVICE_UNAVAILABLE` | Servis ya da OTP kanalı geçici olarak kullanılamıyor; hiçbir şey gönderilmedi, tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. OTP gönderilmiş olabilir: otomatik tekrar göndermeyin. | [errors.md](../errors.md#hızlı-karar-tablosu) |

`400 INVALID_REQUEST` için `message`:

| `message` | Ne zaman |
|---|---|
| `N field(s) rejected` | `sender`, `text` ya da `recipient` eksik veya boş. `violations` belirtir. Metin yerine nesne ya da dizi `1 field(s) rejected` ile tek ihlal alır: `must be a string`. |
| `request body could not be read as json` | Gövde geçerli bir JSON değil. |
| `recipient is not a valid number` | `recipient` bir Türkiye cep numarası değil (boşluk içeriyor ya da yurt dışı numarası gibi). |
| `text is longer than 155 characters for this sender` | Çevrilmiş metin alfanümerik başlıkta 155, abone numarasında 160 karakteri aşıyor (abone numarasında `message` `160` yazar). |

## Dikkat edilecekler

- **İstek sınırı yoktur.** Spec bu uç nokta için `429` tanımlamaz.
- **`503`'te tekrar güvenlidir.** Hiçbir şey gönderilmemiştir; artan beklemeyle (örneğin 1, 2, 4 sn)
  tekrar deneyin. OTP ucunda `504` yoktur.
- **`500`'de otomatik tekrar yok.** OTP gönderilmiş olabilir; tekrar alıcıya iki farklı şifre ulaştırabilir.
  Kullanıcıya "kod gelmediyse yeniden isteyin" seçeneği sunun.
- **OTP `jobId`'si `GET /report` ile sorgulanamaz.** OTP iletim raporları toplu gönderim raporlarından
  ayrı tutulur. Mock, OTP görevleri için `GET /stats` ve `POST /cancel`'da da `404` döner.
- **Türkçe harfler çevrilir, reddedilmez.** "Doğrulama" "Dogrulama" olarak gider. Metni kendiniz ASCII
  yazarsanız ne gideceğini tam bilirsiniz; uzunluğu çevrilmiş metne göre hesaplayın.
- **`sender` ve `recipient` `/send`'den farklıdır.** Burada gönderici büyük/küçük harf ayırmaz ve
  numara `5…`, `05…` ya da `905…` yazılabilir, başına `+` eklenebilir; `/send`'deki alıcı biçimi (`90` + 10
  rakam, `+` yok) ile karıştırmayın.
- **Toplu gönderim için değildir.** Çok alıcıya aynı anda bilgilendirme gönderilecekse `/send`
  kullanılır.
- **Mock:** `8500000008` hesabında OTP kredisi yoktur ve `/send/otp` `422 INSUFFICIENT_CREDIT` döner.
  `8500000010` kurumsal OTP hesabıdır: `x-client: enterprise` göndermelidir, diğer hesaplar bu başlıkla
  `403` alır (bkz. [testing.md](../testing.md#test-hesapları)).
