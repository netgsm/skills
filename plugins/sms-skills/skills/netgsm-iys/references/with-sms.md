# SMS gönderimiyle birlikte kullanım

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/iys/ (İYS API) ·
https://api-docs.netgsm.com.tr/send-sms/ (`iysFilter`) · https://api-docs.netgsm.com.tr/list-senders/
(başlığın `brandCode`'u) · https://api-docs.netgsm.com.tr/netgsm-sms-api/ (SMS API v3 genel bakış).
Süreç: https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/sikca-sorulan-sorular-netiys

Ticari SMS gönderen bir Netgsm müşterisi İYS ile iki yerde karşılaşır: izinleri **kaydederken** (İYS
API) ve **gönderirken** (SMS API v3'ün `iysFilter` parametresi). Gönderim tarafının ayrıntısı
`netgsm-sms` skill'indedir; bu dosya ikisinin nasıl birlikte çalıştığını anlatır.

## İki iş, iki API

| | İzin kaydı | Gönderimde filtre |
|---|---|---|
| API | İYS API v1, `https://ext-api.netgsm.com.tr/iys/v1` | SMS API v3, `https://ext-api.netgsm.com.tr/sms/v3` |
| Uç nokta | `POST /consents` | `POST /send`, `/send/template`, `/directory/send` |
| Ne zaman | Alıcı izin verdiğinde ya da reddettiğinde, en geç 3 iş günü içinde | Her ticari gönderimde |
| Numara biçimi | `+905321234567` | `905321234567` |
| Marka | `brandCode` (İYS marka kodu) istekte | Başlığa tanımlı marka kodu (`GET /senders` → `brandCode`) |
| Token | `scope: "sms"` | `scope: "sms"` |
| Test ortamı | Yok (yalnızca canlı) | Yerel mock ve sandbox var (ikisi de İYS denetimi yapmaz) |

## `iysFilter` değerleri

SMS API v3 gönderim uçlarındaki `iysFilter` (ayrıntı: https://api-docs.netgsm.com.tr/send-sms/):

| `iysFilter` | Anlamı |
|---|---|
| `NONE` | Filtre yok. Yalnızca bilgilendirme (ticari olmayan) iletiler için. Varsayılan. |
| `BRAND` | Marka adına alınmış izinlere göre filtrelenir. |
| `RETAILER` | Bayi adına alınmış izinlere göre filtrelenir. |
| `BRAND_AND_RETAILER` | Her ikisine göre filtrelenir. |

- Büyük/küçük harf fark etmez; listede olmayan değer `NONE` sayılır.
- Hesap ticari gönderim (marka ya da bayi) tipinde tanımlıysa istekteki değer yok sayılır ve hesabın
  tipi uygulanır.
- `BRAND` ya da `RETAILER` için başlığın İYS marka kodu olmalıdır (`GET /sms/v3/senders` yanıtında
  `brandCode` `0` değil) ve hesap İYS modunda olmalıdır; aksi halde `422 REJECTED_IYS`
  (`sender header has no iys brand code` ya da `account is not in iys mode, filtering cannot be applied`).
- İzni olmadığı için elenen alıcı iletim raporunda `NOT_DELIVERED` ve `failReason` `IYS_REJECTED`
  olarak görülür; İYS kontrolü yapılamadıysa `IYS_ERROR`.
- Bilgi Bankası SSS'deki `filter` değerleri (`11`, `12`) eski SMS API'sine aittir; SMS API v3'te İYS
  filtresi `iysFilter` ile verilir.

`REJECTED_IYS`, `IYS_REJECTED` ve `IYS_ERROR`'ın tamamı `netgsm-sms` skill'inin `references/errors.md`
dosyasında.

## Önerilen akış

1. **İzin toplanır** (web formu, mobil uygulama, mağaza, çağrı merkezi). Kendi sisteminizde alıcı,
   izin tipi (`MESAJ`), durum, kaynak (`HS_WEB` gibi) ve iznin alındığı an saklanır.
2. **İYS'ye kaydedilir:** `POST /iys/v1/consents`, 500'lük partilerle, en geç 3 iş günü içinde.
   `erroritem` işlenir; sonuçlar webhook ile izlenir.
3. **Ret de kaydedilir:** alıcı izni geri aldığında (`RET`) aynı yolla bildirilir.
4. **Ticari gönderim** `POST /sms/v3/send` ile, `iysFilter` `BRAND` (ya da hesabınıza uygun değer) ve
   marka kodu tanımlı bir başlıkla yapılır. İzni olmayan alıcıyı platform eler; gönderimden önce her
   alıcı için `GET /consents` çağırmak gerekmez.
5. **Bilgilendirme iletileri** (OTP, sipariş, kargo, randevu) `iysFilter: NONE` ile gönderilir. Bir
   iletinin ticari mi bilgilendirme mi olduğuna hizmet sağlayıcı karar verir (NetİYS SSS); skill bu
   konuda hukuki yorum yapmaz.
6. **Mutabakat:** Kendi kayıtlarınızla İYS'yi zaman zaman `GET /consents` (çoklu sorgu) ile
   karşılaştırın; izin değişiklikleri webhook ile de gelir.

## Örnek: aynı numara iki API'de

```text
SMS API v3  recipient:  905321234567
İYS API v1  recipient: +905321234567
```

```ts
/** SMS API v3 biçiminden (90 + 10 rakam) İYS biçimine (+90 + 10 rakam). */
const toIysRecipient = (sms: string) => {
  if (!/^90\d{10}$/.test(sms)) throw new Error('beklenen biçim 90XXXXXXXXXX');
  return `+${sms}`;
};
/** İYS biçiminden SMS API v3 biçimine. */
const toSmsRecipient = (iys: string) => {
  if (!/^\+90\d{10}$/.test(iys)) throw new Error('beklenen biçim +90XXXXXXXXXX');
  return iys.slice(1);
};
```

## Test

- SMS gönderimi mock'ta (`netgsm-sms` skill'i) ve sandbox'ta denenebilir; ikisi de İYS izinlerini
  denetlemez. Mock'ta `REJECTED_IYS` senaryosu ve İYS modundaki test hesabı vardır.
- İYS API'nin test ortamı yoktur. İzin kaydı kodu sahte `fetch` ile test edilir; gerçek numarayla
  deneme kaydı yapılmaz ([getting-started.md](getting-started.md#canlıya-geçiş)).
