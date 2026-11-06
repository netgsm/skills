# `GET /balance`: bakiye, paket ve kampanya sorgulama

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/get-balance/ · bölüm sayfası (Hesap):
https://api-docs.netgsm.com.tr/hesap/

Yol, SMS API base URL'sine göredir: canlı `https://ext-api.netgsm.com.tr/sms/v3`, mock
`http://127.0.0.1:4010/sms/v3`. Her istek `Authorization: Bearer <access_token>` ister; SMS API'nin
geri kalanıyla aynı `sms` kapsamlı token kullanılır (bkz. [auth.md](../auth.md)). Sözleşmenin tamamı:
[openapi.yaml](../openapi.yaml) (`/balance:`, `BalanceListResponse`, `BalanceEntry`,
`BalanceSummaryResponse`).

## Ne işe yarar

Hesabın kalan paketlerini, kampanyalarını ve kredi bakiyesini döndürür. Hesap token'dan alınır.
Geçerli bir token yeterlidir; ayrıca bir yetki istenmez.

Resmî dokümandan kaldırılan eski kredi / paket sorgulama sayfasının (`POST /balance`) yerine bu uç
nokta kullanılır; yeni entegrasyonda yalnızca `GET /sms/v3/balance` yazılır.

**Yanıt gövdesi API'nin genel kurallarına uymaz:** `amount` metin ya da sayı olabilir, kredi virgüllü
metindir ve `stip=2` yanıtında bazı alanlar hiç bulunmayabilir. Ayrıştırırken bunlara hazırlıklı olun
(aşağıdaki [Güvenli ayrıştırma](#güvenli-ayrıştırma)).

## İstek alanları (sorgu parametreleri)

| Parametre | Değerler | Zorunlu | Açıklama |
|---|---|---|---|
| `stip` | `1` · `2` · `3` (varsayılan `1`) | hayır | `1`: varlıklar türlerine göre. `2`: tek satırlık özet. `3`: varlıklar ve kredi bakiyesi. **Başka bir değer ya da hiç verilmemesi `1` sayılır; hata dönmez.** |
| `service` | aşağıdaki tablo | hayır | Listeyi bir hizmet grubuyla sınırlar: yalnızca o gruptaki hizmetlerin paket ve kampanyaları döner. Verilmezse (ya da boşsa) liste SMS gönderim hizmetinin varlıklarıdır; bu, `service=sms` ile aynı değildir (aşağıda). Büyük/küçük harf fark etmez. Tabloda olmayan değer `400`. |

`service` grupları:

| Değer | Grup |
|---|---|
| `sms` | SMS (giden, gelen, SMPP, flash, kısa numara, 0800 SMS, GSM ve M2M SMS); OTP SMS paketleri `otp`'dadır |
| `otp` | OTP ve OTP SMS paketleri |
| `ses` | Ses (giden, gelen, sesli mesaj, yönlendirme, telesekreter, 0800 çağrı, otomatik arama) |
| `fax` | Faks (giden, gelen) |
| `whatsapp` | WhatsApp |
| `santral` | Santral, SIP / NGN trunk, IP FCT, THK |
| `netsipp` | Netsipp |
| `gsm` | GSM hat, data, M2M, NetIOT, SIM kart |
| `internet` | İnternet, statik IP, alan adı, sunucu barındırma |
| `numara` | Numara kullanımı, özel numara, numara devri, MSISDN sorgulama |
| `ai` | Yapay zeka entegrasyonları |
| `ucret` | Tek seferlik ücretler ve fatura işlemleri |

- **`service` verilmemesi `service=sms` değildir.** `service` verilmezse liste SMS gönderim hizmetinin
  varlıklarıdır ve OTP SMS paketini (`Adet OTP SMS`) de içerir (yukarıdaki örnek). `service=sms` yalnızca
  `sms` grubunu (`Adet SMS`) döndürür; OTP SMS paketleri yalnızca `service=otp` ile ayrıca alınır.
- Kredi bakiyesi bir hizmete ait değildir: listede yer almaz, `stip=3` onu her zaman sona ekler.
- `stip=2` özeti `service`'ten etkilenmez.

## Örnek istek

```http
GET /sms/v3/balance?stip=3
Authorization: Bearer <access_token>
```

```http
GET /sms/v3/balance?stip=1&service=otp
Authorization: Bearer <access_token>
```

## Örnek yanıt

`stip` `1` ve `3` için `BalanceListResponse` (`200 OK`, `stip=3`):

```json
{
  "balance": [
    { "amount": 277, "balance_name": "Adet SMS" },
    { "amount": "767", "balance_name": "Adet OTP SMS" },
    { "amount": "242", "balance_name": "Dakika" },
    { "amount": "92,150", "balance_name": "Kredi Bakiye" }
  ]
}
```

| Alan | Açıklama |
|---|---|
| `balance` | Her varlık türü için bir kayıt. Hiç varlık yoksa boş liste (`[]`). `stip=3` sonuna her zaman `Kredi Bakiye` kaydını ekler. |
| `balance[].amount` | Kalan miktar. **Metin ya da sayı olabilir:** bir türün tek kaydı varsa metin (`"767"`), birden fazla kaydı toplanmışsa sayı (`277`, `242.5`). `Kredi Bakiye` kaydında TL cinsinden, **virgülle ve üç ondalık basamakla** metin: `"92,150"` = 92,15 TL. |
| `balance[].balance_name` | Varlığın adı, örneğin `Adet SMS`, `Adet OTP SMS`, `Dakika`, `Kredi Bakiye`. **Liste sabit değildir;** hesaptaki ürünlere göre değişir. |

`stip=2` için `BalanceSummaryResponse` (`200 OK`). `code` her zaman `"00"`dır; `balance` ve `type`
yalnızca ilgili durumda bulunur:

| Hesap | Yanıt |
|---|---|
| Faturasız, kredi var | `{ "code": "00", "balance": "92,150" }` (TL kredi) |
| Faturasız, kredi yok, SMS var | `{ "code": "00", "balance": "277", "type": "AdetSMS" }` (kalan SMS adedi) |
| Faturalı | `{ "code": "00", "balance": "0" }` (her zaman `"0"`) |
| Faturasız, ikisi de yok | `{ "code": "00" }` (`balance` alanı yok) |

`type` yalnızca `balance` SMS adedi olduğunda (`AdetSMS`) bulunur. Faturalı hesapta `"0"` "bakiye
bitti" anlamına gelmez; faturalı hesabın kalanı bu özetten okunamaz.

## Güvenli ayrıştırma

- `amount`'u her zaman hem metin hem sayı olarak kabul edin; metinse virgülü noktaya çevirip sayıya
  dönüştürün. Sayıya çevrilemeyen değerde hata fırlatmayın, değeri "bilinmiyor" sayın.
- Kaydı **`balance_name` ile** bulun; sıraya ya da listedeki konuma güvenmeyin, bir türün listede
  olmaması da normaldir (o tür hesapta yoksa kayıt yoktur). **Adları büyük/küçük harfe duyarsız
  eşleştirin.**
- `stip=2`'de `balance` ve `type` alanlarının hiç olmayabileceğini, `"0"`ın faturalı hesapta sabit
  olduğunu hesaba katın.

```ts
/** "92,150" → 92.15, "767" → 767, 277 → 277; okunamazsa null (hata fırlatmaz). */
function parseAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const res = await fetch(`${base}/sms/v3/balance?stip=3`, { headers: { Authorization: `Bearer ${token}` } });
const { balance } = await res.json();
const byName = (name: string) =>
  balance.find((e: any) => String(e.balance_name).trim().toLowerCase() === name.toLowerCase())?.amount;
const credit = parseAmount(byName('Kredi Bakiye')); // TL
const sms = parseAmount(byName('Adet SMS'));        // yoksa null
```

Dillere göre hazır örnekler: `references/examples/` (TypeScript istemcisinde `getBalance`).

## Önbellek ve istek sınırı

- **Önbellek:** Aynı hesap, aynı `stip` ve aynı `service` için yanıt **10 saniye** saklanır. Bir
  gönderimden hemen sonra okunan bakiye en fazla 10 saniye eski olabilir; sık sorgulamak daha güncel
  değer getirmez.
- **İstek sınırı:** Hesap başına **dakikada 60 istek**. Pencere ilk istekle başlar ve sabittir; her istek
  sayılır. Aşıldığında `429 RATE_LIMITED`, `message` `balance rate limit exceeded` ve `Retry-After`
  başlığı döner; `Retry-After` kadar bekleyip yeniden deneyin.

## Hatalar

| HTTP | `code` | Ne zaman | Ayrıntı |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | `service` tabloda olmayan bir değer: `message` `service must be one of sms, otp, ses, fax, whatsapp, santral, netsipp, gsm, internet, numara, ai, ucret`. (`stip`'in geçersiz değeri hata değildir, `1` sayılır.) | [errors.md](../errors.md#invalid_request-400-için-öne-çıkan-message-değerleri) |
| 401 | `UNAUTHENTICATED` | Token yok ya da geçersiz. | [auth.md](../auth.md) |
| 429 | `RATE_LIMITED` | `balance rate limit exceeded`: hesap başına dakikada 60 istek aşıldı. `Retry-After` kadar bekleyin. | [errors.md](../errors.md#rate_limited-429) |
| 503 | `SERVICE_UNAVAILABLE` | Hiçbir şey yapılmadı; sorgu salt okunurdur, artan beklemeyle tekrar denemek güvenlidir. | [errors.md](../errors.md#hızlı-karar-tablosu) |
| 500 | `INTERNAL_ERROR` | Beklenmeyen hata. | [errors.md](../errors.md#sms-api-kodları) |

## Dikkat edilecekler

- **Ne zaman sorgulanır:** Büyük bir kampanyadan (toplu gönderimden) önce **bir kez**; düşük bakiye
  uyarısı için seyrek aralıklı zamanlanmış bir işle; yönetim ekranında göstermek için sunucuda
  sorgulayıp kısa süre önbellekte tutarak.
- **Ne zaman sorgulanmaz:** Her SMS ya da OTP gönderiminden önce, ya da bir döngü içinde. Gönderimin
  kendisi yetersizliği bildirir: `POST /send/otp` `422 INSUFFICIENT_CREDIT` döner, toplu gönderimde
  kredi yetmeyen alıcı raporda `failReason` `INSUFFICIENT_CREDIT` ile görülür (bkz.
  [errors.md](../errors.md)). Bakiye bir ön kontroldür, kesin bildirim gönderimdedir.
- **Asla döngüde sorgulamayın:** Yanıt zaten 10 sn önbellektedir ve sınır dakikada 60 istektir;
  `429`'u döngüyle aşmaya çalışmayın.
- **Gerçek tüketim** gönderimden sonra `GET /stats` ile görülür (`totalParts`, `charging`,
  `chargeDescription`; bkz. [stats.md](stats.md)). Kampanyanın parça sayısını önceden tahmin etmek
  için metni [`POST /length`](length.md) ile ölçüp alıcı sayısıyla çarpın; paketin parça mı mesaj mı
  saydığı bu dokümanda yoktur, tahmin kesin hesap yerine geçmez.
- **Bakiye yükleme ve paket satın alma** için API yoktur; bunlar portaldan yapılır
  (https://portal.netgsm.com.tr). Ayrıntı Bilgi Bankası'ndadır: https://bilgibankasi.netgsm.com.tr/.
- **Mock:** yerel mock bu uç noktayı hesap başına sabit örnek veriyle (faturasız kredili, yalnızca SMS
  paketli, faturalı ve boş hesaplar), önbellek ve istek sınırıyla sunar; hazır hesaplar:
  [testing.md](../testing.md).
