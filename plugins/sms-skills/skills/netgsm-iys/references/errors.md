# Hata kodları ve yapılacaklar

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/iys/netgsm-iys-api/ (hata kodları tablosu);
uç nokta hataları: https://api-docs.netgsm.com.tr/iys/save-consents/ ·
https://api-docs.netgsm.com.tr/iys/search-consents/ · https://api-docs.netgsm.com.tr/iys/save-webhook/.
Token hataları: https://api-docs.netgsm.com.tr/auth/token/. Hesap ve panel adımları (İYS aktivasyonu,
alt kullanıcı yetkisi, IP izni): https://bilgibankasi.netgsm.com.tr/entegrasyonlar/api-entegrasyonu-hazirlik-rehberi

Bu dosya İYS API v1'in bütün `errorCode` değerlerini anlatır. Kaynak: [openapi.yaml](openapi.yaml).
Burada olmayan bir kod ya da davranış için tahmin yürütülmez; yazılımcı önce resmî dokümana ve Bilgi
Bankası'na (https://bilgibankasi.netgsm.com.tr/), orada da yoksa `X-Thread-Id` ile teknik desteğe
yönlendirilir.

**Üç temel kural**

1. Hata mantığı HTTP durum koduna değil `errorCode` alanına göre kurulur.
2. Her hata `X-Thread-Id` ile loglanır (isteğe kendi `X-Request-Id`'nizi verdiyseniz o değer döner);
   `POST` yanıtlarında `data.uid` de.
3. `400`, `403`, `404`, `405`, `409` ve `422` tekrar denenmez: aynı istek aynı sonucu verir.

## Hata yapısı

```json
{ "success": false, "errorCode": 70, "message": "Validation failed",
  "data": { "errors": { "brandCode": "The brand code field is required." } } }
```

| Alan | Açıklama |
|---|---|
| `success` | Hatada `false`. |
| `errorCode` | Hata kodu (aşağıdaki tablo). Mantık buna göre kurulur. |
| `message` | Okunabilir ayrıntı (İngilizce). Mantık buna göre kurulmaz. |
| `data` | Çoğu hatada boş dizi (`[]`); doğrulama hatasında (`70`) alan bazlı mesajları taşıyan `errors` nesnesi. |

## Kodlar

"Tekrar" sütunu: **Evet** = aynı istek değiştirilmeden, artan beklemeyle tekrar denenebilir. **Hayır**
= istek ya da hesap düzeltilmeden tekrar denenmez. **Koşullu** = yalnızca belirtilen koşulla.

| `errorCode` | Hata | HTTP | Anlamı | Ne yapılır | Tekrar |
|---|---|---|---|---|---|
| `0` | — | 200 | Başarılı. | `POST /consents`'te yine de `data.erroritem` işlenir. | — |
| `50` | `UNAUTHENTICATED` | 401 | Kimlik doğrulama yapılmadı. | `Authorization: Bearer <access_token>` başlığını ekleyin. Token varsa yeniden giriş yapıp **bir kez** tekrarlayın. | Koşullu |
| `51` | `TOKEN_NOT_FOUND` | 401 | Token bulunamadı. | Yeniden giriş (`POST /auth/v3/token`, `scope: "sms"`), istek bir kez tekrarlanır. | Koşullu |
| `52` | `INVALID_TOKEN` | 401 | Geçersiz token. | Yeniden giriş, istek bir kez tekrarlanır. Yine `401` ise kimlik bilgileri ve hesap kontrol edilir. | Koşullu |
| `53` | `SESSION_EXPIRED` | 401 | Token'ın süresi dolmuş. | Token süresi dolmadan yenilenmeli (`POST /auth/v3/token/refresh`). Şimdi yeniden giriş yapılır, istek bir kez tekrarlanır. | Koşullu |
| `60` | `UNAUTHORIZED` | 403 | Yetkisiz erişim. | Alt kullanıcının İYS (dijital servis) yetkisini ve hesabın API erişimini kontrol edin (Bilgi Bankası, API entegrasyonu hazırlık rehberi). | Hayır |
| `61` | `FORBIDDEN` | 403 | Erişim engellendi. | Hesap, yetki ve (varsa) IP kısıtlamasını kontrol edin; netleşmezse `X-Thread-Id` ile teknik destek. | Hayır |
| `63` | `IYS_MODULE_INACTIVE` | 403 | Hesapta İYS hizmeti aktif değil. | NetİYS kaydı, NetİYS paketi ve İYS kredisi tamamlanmalı ([getting-started.md](getting-started.md#ön-koşullar)); aktivasyon için çağrı merkezi ya da abonelik işlemleri. | Hayır |
| `70` | `VALIDATION_ERROR` | 422 | İstekteki bir alan kurallara uymuyor. | `data.errors`'taki alanları düzeltin (numara `+90XXXXXXXXXX`, tarih `YYYY-MM-DD HH:mm:ss`, enum değerleri, `brandCode`, 500 / 1000 sınırı). | Hayır |
| `80` | `METHOD_NOT_ALLOWED` | 405 | Adres bu metodu desteklemiyor. | Metodu ve yolu düzeltin (`/consents` GET ve POST, `/webhooks` yalnızca POST). | Hayır |
| `81` | `NOT_FOUND` | 404 | Kayıt bulunamadı. | Çoklu sorguda kayıt bazında da gelir: o alıcı için İYS'de kayıt yok, yani **izin yok**. Yol hatalıysa yolu düzeltin. | Hayır |
| `112` | `DEPENDENCY_ERROR` | 424 | İYS'den geçerli bir yanıt alınamadı. | `GET` ve `POST /webhooks`: artan beklemeyle tekrar. `POST /consents`: kaydın işlenip işlenmediği bilinmez; körlemesine tekrar yok (aşağıya bakın). Çoklu sorguda kayıt bazında gelirse o kayıt daha sonra yeniden sorgulanır. | Koşullu |
| `120` | `BAD_REQUEST` | 400 | Hatalı istek. | İsteği düzeltin. Çoklu sorguda isteğin tamamını etkileyen hata (örneğin geçersiz `brandCode`) `400` ile sonlanır; kayıt bazında gelirse o kayıt düzeltilir. | Hayır |
| `130` | `CONFLICT` | 409 | Kayıt zaten mevcut. | Aynı kayıt yeniden oluşturulmaz; mevcut kayıt geçerlidir. Durumu `GET /consents` ile doğrulayın. | Hayır |
| `141` | `INTEGRATION_ERROR` | 503 | Servis şu anda isteği işleyemiyor. | Sözleşmeye göre istek biraz sonra tekrar gönderilebilir: artan beklemeyle (örneğin 1, 2, 4 sn) tekrar. | Evet |
| `150` | `TOO_MANY_REQUESTS` | 429 | Çok fazla istek gönderildi. | İstek hızını düşürün; artan beklemeyle tekrar. Sözleşme sayısal limit ve `Retry-After` tanımlamaz; yanıtta `Retry-After` varsa ona uyun. Kayıt başına istek yerine 500'lük `POST` ve çoklu `GET` kullanın. | Evet |
| `110` | `SERVER_ERROR` | 500 | Beklenmeyen bir hata oluştu. | `GET` ve `POST /webhooks`: kısa süre sonra tekrar. `POST /consents`: körlemesine tekrar yok (aşağıya bakın). `X-Thread-Id` ile teknik desteğe bildirin. | Koşullu |

## `POST /consents`'te belirsiz sonuç

`424` (112), `500` (110), zaman aşımı ya da bağlantı hatasından sonra kaydın İYS'ye ulaşıp ulaşmadığını
doküman söylemez. İzin kayıtları hukuki kayıttır; aynı partiyi körlemesine yeniden göndermek yerine:

1. İsteğin `X-Request-Id` değerini ve gönderilen kayıtları saklayın.
2. Webhook bildirimlerini ve bir süre sonra `GET /consents` ile o alıcıların durumunu kontrol edin.
   İşleme zaman alabileceği için kayıt hemen görünmeyebilir.
3. Görünmeyen kayıtları yeniden gönderin. Belirsizlik sürerse `X-Thread-Id` ile teknik desteğe
   (`teknikdestek@netgsm.com.tr`) danışın.

`503` (141) ve `429` (150) bu kuralın dışındadır: istek işlenmemiştir, artan beklemeyle tekrar gönderilir.

## Kısmi red (`erroritem`)

`POST /consents` `200` ve `errorCode` `0` dönse bile `data.erroritem[]` İYS'nin reddettiği kayıtları
taşıyabilir: `index` (`permissions` içindeki sıfırdan başlayan sıra), `field`, `message`. Bu kayıtlar
kaydedilmemiştir; düzeltilip yeni istekte gönderilir. `message` değerleri İYS'den gelir ve sözleşmede
listelenmez; mantık `field`'a göre kurulur, `message` loglanır.

## Destek kanalları

| Kanal | Bilgi | Ne zaman |
|---|---|---|
| Çağrı merkezi | `+90 850 303 0 303` · `+90 312 911 0 911` | İYS hizmeti aktivasyonu (`63`), `403`'ler, acil durumlar |
| Teknik destek | `teknikdestek@netgsm.com.tr` | API hataları, `X-Thread-Id` ile bildirimler, belirsiz kayıtlar (`424` / `500`), webhook biçimi |
| Abonelik işlemleri | `abone.islemleri@netgsm.com.tr` | NetİYS kaydı, alt kullanıcı ve hesap işlemleri |

Destek talebine şunları ekleyin: `X-Thread-Id`, varsa `data.uid`, isteğin zamanı, uç nokta ve hata
yanıtının gövdesi. Şifre ve token paylaşılmaz.
