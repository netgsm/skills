# Limitler ve toplu gönderim

**Kaynak (resmî doküman):** her uç noktanın sınırı kendi sayfasındadır (örn. https://api-docs.netgsm.com.tr/send-sms/,
https://api-docs.netgsm.com.tr/read-reports/); sayfa listesi SKILL.md'deki "Resmî doküman sayfaları" tablosunda.

Bu dosya uç nokta başına istek sınırlarını, `429` ile `Retry-After`'ın nasıl işlendiğini ve toplu
gönderimin nasıl yapılacağını anlatır. Hata kodlarının ayrıntısı: [errors.md](errors.md#rate_limited-429).

**Kısa kural:** Sınırlar **istek** sayar, mesaj değil. Çok alıcı tek `/send` isteğinde gönderilir; kendi
gönderim kuyruğunuzu ya da hız sınırlayıcınızı yazmanız gerekmez.

## SMS API sınırları

Sınırların hepsi hesap başınadır. Tablodaki sayılar public spec'teki sözleşme değerleridir. Spec'in
sayı vermediği uç noktalarda bir sayı varsaymayın: `429` ve `Retry-After`'a göre davranın. (Mock bu
uç noktalarda da bir sınır uygular ki `429` işlemeyi deneyebilesiniz; o değerler yalnızca
[testing.md](testing.md#mockun-varsayımları-sözleşme-değildir)'de, sözleşme olmadığı belirtilerek
listelenir.)

| Uç nokta | Sınır | Reddedilen istekler sayılır mı | Ek sınır (aynı görev / aynı sorgu) | Kaynak |
|---|---|---|---|---|
| `POST /send` | Dakikada 50.000 istek | Hayır | — | spec |
| `POST /send/template` | Dakikada 1000 istek, `/send`'den ayrı | Evet | — | spec |
| `POST /directory/send` | Dakikada 60 istek, `/send`'den ayrı | Belirtilmez | — | spec |
| `POST /send/otp` | Sınır yok; spec bu uç nokta için `429` tanımlamaz | — | — | spec |
| `POST /cancel` | Dakikada 25.000 istek | Belirtilmez | — | spec |
| `GET /report` | Dakikada 60 istek | Belirtilmez | İstekteki bir `jobId` son 1 dakikada sorulmuşsa `429` | spec |
| `GET /stats` | Dakikada 60 istek | `404` ya da `503` ile biten okumalar da iki sayaca sayılır | Aynı `jobId` son 10 dakikada sorulmuşsa `429` | spec |
| `GET /blacklist` | Dakikada 60 istek | Belirtilmez | Aynı sorgu (aynı `page` ve `number`) son 10 dakikada yanıtlanmışsa `429`; hatayla biten sorgu beklemeden tekrar gönderilebilir | spec |
| `GET /templates` | Dakikada 20 istek | Evet | — | spec |
| `GET /inbox` | Spec sayı vermez; `429` ve `Retry-After`'a göre davranın | Belirtilmez | — | spec (sayısız) |
| `GET /senders`, `GET /senders/default` | Spec sayı vermez; `429` ve `Retry-After`'a göre davranın | Belirtilmez | — | spec (sayısız) |
| `PUT /senders/default` | Spec sayı vermez; `429` ve `Retry-After`'a göre davranın | Belirtilmez | — | spec (sayısız) |
| `POST`/`DELETE` `/webhooks/report`, `/webhooks/inbox` | Spec sayı vermez; `429` ve `Retry-After`'a göre davranın | Belirtilmez | — | spec (sayısız) |
| `POST /length` | Spec bu uç nokta için `429` tanımlamaz | — | — | spec |
| `GET /balance` | Dakikada 60 istek | Evet (her istek sayılır) | Yanıt aynı `stip` ve `service` için 10 sn önbellekte; sık sorgu daha güncel değer getirmez | spec |

Toplu gönderimle ilgili istek içi sınırlar:

| Uç nokta | Bir istekte | Kaynak |
|---|---|---|
| `POST /send` | 1–1.000.000 kayıt (`messages`), gövde en fazla 500 MB | spec |
| `POST /send/template` | 1–20 kayıt (`templates`) | spec |
| `POST /send/otp` | Tek alıcı, tek mesaj | spec |
| `POST /directory/send` | Tek metin; gruplar, kişiler ve (onlarla birlikte) düz numaralar | spec |

## Identity API sınırları

Tümü dakika bazlıdır ve yaklaşık uygulanır (spec). Ayrıntı: [auth.md](auth.md#limitler).

| Kapsam | Sınır | Anahtar |
|---|---|---|
| `POST /auth/v3/token` | Dakikada 30 istek | IP |
| Hatalı giriş (`invalid_credentials`) | Dakikada 5 deneme; başarılı giriş sayacı sıfırlar | Kullanıcı adı + IP |
| `POST /auth/v3/token/refresh` | Dakikada 60 istek | IP |
| `GET /auth/v3/me`, `POST /auth/v3/token/revoke` | Dakikada 60 istek | Access token |
| `GET /auth/v3/me`, `POST /auth/v3/token/revoke` | Dakikada 300 istek | IP |

Token önbelleğe alınır; her SMS isteğinden önce token almak `/token` sınırına takılır (bkz.
[auth.md](auth.md#önerilen-istemci-deseni)).

## Pencere ve `Retry-After`

- `/send`, `/send/template`, `/directory/send`, `/cancel`, `/templates` ve `/balance` sınırlarında pencere
  **ilk istekle başlar ve sabittir** (kayan pencere değil).
- `429` yanıtındaki `Retry-After`, tekrar denemeden önce beklenecek tam saniyedir. Görev ya da sorgu
  bazlı sınırlarda (`/report`, `/stats`, `/blacklist`) engelleyen sayacın dolmasına kalan süredir.
- **`Retry-After` yoksa** hesabın gönderimi askıya alınmıştır (`message`
  `sending is suspended for this account`). Beklemek işe yaramaz: tekrar denemeyin, destek ekibine
  başvurun.
- Identity `429` yanıtları da `Retry-After` taşır (gövdede `retry_after`) ve limitli uçlar
  `RateLimit-*` başlıklarını döner.

```ts
// 429 işleme: Retry-After varsa bekle ve bir kez daha dene; yoksa durdur.
async function withRetryAfter(doRequest: () => Promise<Response>): Promise<Response> {
  const res = await doRequest();
  if (res.status !== 429) return res;
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter === null) {
    // Gönderim askıya alınmış: beklemek işe yaramaz.
    const err = await res.json();
    throw new Error(`RATE_LIMITED, Retry-After yok (${err.message}); requestId ${err.requestId}`);
  }
  await new Promise(r => setTimeout(r, Number(retryAfter) * 1000));
  return doRequest();
}
```

## Kendi kuyruğunu yazma

`202` yanıtı, görevin Netgsm tarafında kuyruğa alındığını gösterir; iletim sonradan Netgsm tarafından
yapılır. Alıcıları kendi kuyruğunuzda tek tek bekletip saniyede N istek gönderen bir yapı gerekmez.
Bir `/send` isteği 1.000.000 kayda kadar taşır ve her kaydın kendi metni olabilir; dakikada 50.000
**istek** sınırı toplu gönderimde pratikte sorun olmaz.

**Yanlış:** her alıcı için ayrı istek.

```ts
for (const c of customers) {
  await fetch(`${base}/sms/v3/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, messages: [{ recipient: c.phone, text: `Merhaba ${c.name}` }] }),
  });
}
```

Bu döngü 10.000 müşteri için 10.000 istek, 10.000 görev ve 10.000 ayrı `jobId` üretir; raporları takip
etmek zorlaşır, hatalar alıcı başına ayrı ayrı ele alınır. Mock bu kalıbı `SINGLE_RECIPIENT_BURST`
bulgusuyla bildirir.

**Doğru:** bütün alıcılar tek istekte, her kayıt kendi metniyle.

```ts
const res = await fetch(`${base}/sms/v3/send`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sender,
    messages: customers.map(c => ({ recipient: c.phone, text: `Merhaba ${c.name}` })),
  }),
});
const body = await res.json();
if (res.status === 202) {
  // body.jobId saklanır; body.rejectedItems (index, recipient, reason) işlenir.
}
```

Tek istek, tek görev, tek `jobId`. Hatalı kayıtlar gönderimi durdurmaz; `rejectedItems`'ta `index` ile
döner.

### Büyük listeleri bölmek

Spec'in kuralları: bir istek en fazla 1.000.000 kayıt ve 500 MB gövde taşır; daha büyük bir gövde ya da
kuyruğa alınamayacak kadar büyük bir gönderim `413` alır ve birden fazla isteğe bölünür.

Bunun ötesi isteğe bağlı bir öneridir, spec kuralı değildir: yüz binlerce kayıtlık listelerde on binlerce
kayıtlık parçalara (örneğin 10.000–100.000) bölmek pratik avantaj sağlayabilir. Daha küçük listeler
parçalanmadan tek istekte gönderilir.

- **Hata ayrıntısı:** `rejectedItems` istek başına yalnızca ilk 100 hatalı kaydı listeler. Parçalar
  küçüldükçe her hatalı kaydın nedenini görme şansınız artar.
- **Belirsiz yanıtın etkisi:** `/send`'de `503` (ya da `500`) görevin kuyruğa alınıp alınmadığını
  belirsiz bırakabilir; bu yalnızca o parçayı etkiler ve `GET /report` ile kontrol edilecek alıcı kümesi
  küçük olur (bkz. [errors.md](errors.md#503-ve-504-sonrası-kontrol)).
- **Gövde boyutu:** istemci ve ağ katmanlarınızın gövde sınırlarına takılmazsınız.

Parçaları sırayla gönderin; parça sayısı dakikada 50.000 istek sınırının çok altında kalır. Aynı alıcı
iki parçada geçmesin: istekler arası mükerrerlik denetlenmez, iki ayrı gönderim olur.

### `/send/template` ve OTP

- `/send/template` istek başına 20 kayıt alır ve dakikada 1000 istekle sınırlıdır. Aynı şablonu çok
  sayıda alıcıya göndermek için metni kendiniz doldurup tek `/send` isteği kullanmak daha az istek
  demektir (öneri).
- `/send/otp` tek alıcılıktır; her OTP ayrı istektir ve bu doğru kullanımdır. Bu uçta istek sınırı
  yoktur; yine de toplu bilgilendirme için OTP ucu kullanılmaz.
- `/directory/send` dakikada 60 istekle sınırlıdır: aynı metni çok sayıda gruba gönderirken grupları
  tek istekte toplayın (`groupIds`). Görev her zaman `QUEUED` döner ve `/cancel` ile iptal edilemez.

## Raporlar: webhook, polling değil

Gönderim sonuçlarını sık sık sorgulamak yerine rapor webhook'u kaydedin
(`POST /webhooks/report`, bkz. [endpoints/webhooks.md](endpoints/webhooks.md)). Netgsm nihai duruma
geçen raporları adresinize toplu olarak gönderir.

Sorgulama gerekiyorsa sınırlar:

- `GET /report`: aynı `jobId` dakikada bir; hesap başına dakikada 60 istek. Çok sayıda görevi tek tek
  sormak yerine `jobIds` olmadan bir zaman aralığıyla (`startAt`/`stopAt`) tek sorgu yapın.
- `GET /stats`: aynı `jobId` 10 dakikada bir; `404` ve `503` ile biten okumalar da sayılır.
- `GET /blacklist`: aynı sorgu 10 dakikada bir; sonucu saklayın.
- Yeni gelen bir raporun `/report` yanıtına yansıması 5 dakikayı bulabilir; daha sık sorgulamak sonucu
  hızlandırmaz.

Webhook teslimi başarısız olursa raporlar tekrar gönderilmez; kaçanlar `GET /report` ile tamamlanır.
Gelen SMS'ler için de aynı yaklaşım geçerlidir: gelen SMS webhook'u (`POST /webhooks/inbox`), kaçanlar
için `GET /inbox`.

## Bakiye: kampanyadan önce bir kez, döngüde değil

`GET /balance` (bkz. [endpoints/balance.md](endpoints/balance.md)) büyük bir kampanyadan önce **bir kez**
sorgulanır; her mesajdan önce ya da döngüde sorgulanmaz. Yanıt 10 sn önbellektedir (gönderimden hemen
sonra okunan değer 10 sn eski olabilir) ve sınır hesap başına dakikada 60 istektir. Yetersizliğin kesin
bildirimi gönderimin kendisidir (`INSUFFICIENT_CREDIT`). Düşük bakiye uyarısı gerekiyorsa seyrek aralıklı
tek bir zamanlanmış iş sorgular ve sonucu paylaşılan önbellekte tutar.

## Mock'ta denemek

- `--rate-scale <oran>` bütün sınırları çarpanla değiştirir (`1`'den küçük değer sıkılaştırır). Örneğin
  `--rate-scale 0.0001` ile `/send` sınırı dakikada 5 istek olur ve `429` işleme kodunuzu saniyeler içinde
  deneyebilirsiniz.
- `POST /__mock/scenario` ile `RATE_LIMITED` (`retryAfter` ile) ve `SENDING_SUSPENDED` (`Retry-After`
  yok) tek isteğe enjekte edilir.
- `GET /__mock/advice` alıcı başına istek (`SINGLE_RECIPIENT_BURST`), `Retry-After`'ı yok sayma
  (`IGNORED_RETRY_AFTER`), rapor sorgulamada sınıra takılma (`REPORT_POLLING`) ve bakiyeyi döngüde
  sorgulama (`BALANCE_POLLING`) kalıplarını bildirir.

Ayrıntı ve komutlar: [testing.md](testing.md).
