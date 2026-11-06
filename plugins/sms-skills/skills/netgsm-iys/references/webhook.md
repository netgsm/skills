# `POST /webhooks`: izin sonuçlarının bildirileceği adres

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/iys/save-webhook/ · bölüm:
https://api-docs.netgsm.com.tr/iys/webhook/. NetİYS webhook hizmeti:
https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/net-iys-hizmetleri

Yol İYS API base URL'sine göredir: `https://ext-api.netgsm.com.tr/iys/v1` (yalnızca canlı). İstek
`Authorization: Bearer <access_token>` ister (`scope: "sms"`). Sözleşmenin tamamı:
[openapi.yaml](openapi.yaml) (`/webhooks:`).

## Ne işe yarar

İYS'ye yüklediğiniz izinlerin **işlenme sonuçlarının** ve **izin değişikliklerinin** bildirileceği
adresi tanımlar. Marka için daha önce bir adres tanımlandıysa **yenisiyle değiştirilir**: marka başına
tek adres vardır. Sözleşmede adresi silen ya da okuyan bir uç nokta yoktur.

| Alan | Tür | Zorunlu | Açıklama |
|---|---|---|---|
| `brandCode` | tam sayı, 1–2147483647 | evet | İYS marka kodu. |
| `path` | `SANTRAL` · `SMSAPI` · `WEBPORTAL`, null olabilir | hayır | Gönderilmezse `SMSAPI`. |
| `webhookUrl` | URI | evet | Bildirimlerin gönderileceği adres. |

## Örnek

```http
POST /iys/v1/webhooks
Authorization: Bearer <access_token>
Content-Type: application/json
X-Request-Id: iys-webhook-setup-0001

{ "brandCode": <marka kodunuz>, "webhookUrl": "https://example.com/iys/webhook" }
```

`200`:

```json
{ "success": true, "errorCode": 0, "message": "success",
  "data": { "uid": "ee5c7e61-3940-432a-af30-13b0c9944371" } }
```

Hatalar: `400` (120), `401` (50–53), `403` (60, 61, 63), `422` (70; örneğin geçersiz adres),
`424` (112), `429` (150), `500` (110). Ayrıntı: [errors.md](errors.md). Marka başına tek adres
tutulduğu ve yeni kayıt eskisinin yerine geçtiği için `424`, `429`, `5xx` ya da ağ hatasından sonra
aynı adresi artan beklemeyle yeniden göndermek güvenlidir.

Bu istek de canlı hesabın ayarını değiştirir; asistan çalıştırmadan önce kullanıcıdan açık onay alır.

## Sözleşmede tanımlı olmayanlar

İYS API v1 sözleşmesi ve api-docs sayfası **bildirim isteğinin gövdesini, başlıklarını, zaman
aşımını ve yeniden deneme davranışını tanımlamaz.** Bilgi Bankası'ndaki NetİYS hizmetleri sayfası,
bildirimin marka kodu, izin durumu, işlem sonucu, hata kodu ve mesajı gibi bilgiler taşıdığını söyler;
alan adları ve biçim için resmî dokümana bakılır, orada yoksa teknik destekten
(`teknikdestek@netgsm.com.tr`) istenir. Alan adları ya da gövde biçimi **uydurulmaz**; örnek gövde
yazılmaz.

## Alıcı adres nasıl tasarlanır

Aşağıdakiler sözleşmeden bağımsız, savunmacı önerilerdir:

- **HTTPS** bir adres kullanın.
- Sözleşmede imza ya da özel başlık olmadığı için adresi tahmin edilemez yapın: yolda rastgele, gizli
  bir parça (`https://example.com/iys/webhook/<rastgele-gizli-değer>`). Bu değeri loglamayın.
- Gövdeyi **ham hâliyle kaydedip hemen `2xx` dönün**; işlemeyi sonra yapın. Gövdeyi esnek okuyun
  (bilinmeyen alanları yok sayın).
- Bildirimleri **tekrar gelebilir** kabul edip tekilleştirerek işleyin.
- Bildirimin kaybolabileceğini varsayın: kritik durumlarda izin durumunu `GET /consents` ile doğrulayın
  ([consents.md](consents.md#get-consents-izin-sorgulama)).
- Bildirimdeki numara ve e-posta adresleri kişisel veridir; loglarda maskeleyin.
- Adresi değiştirmek için `POST /webhooks`'u yeni adresle yeniden çağırın.
