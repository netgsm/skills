# TypeScript / Node.js örneği

Referans istemci: [iys-client.ts](iys-client.ts). Bağımlılığı yoktur, Node ≥ 20'nin global `fetch` ve
`crypto` nesnelerini kullanır. Dosyayı projenize kopyalayın. Bu reponun testleri onu **sahte bir
`fetch`** ile çalıştırır; İYS'nin sandbox'ı ve mock'u olmadığı için gerçek istek atılmaz.

İstemcinin uyguladığı kurallar ([SKILL.md](../../SKILL.md) "Değişmez kurallar" ile aynı):

| Durum | Davranış |
|---|---|
| Token | `POST /auth/v3/token` ile `scope: "sms"`. Bellekte tutulur; süresinin son min(5 dk, ömrün %10'u) kısmında `POST /auth/v3/token/refresh` ile yenilenir. Aynı anda gelen çağrılar tek token isteğini bekler. |
| `401` (50–53) | O istekte kullanılan token atılır, yeniden giriş yapılır, istek **bir kez** tekrarlanır. |
| `429` (150), `503` (141) | 1, 2, 4 sn arayla en fazla 3 tekrar; yanıtta `Retry-After` varsa ona uyulur (en fazla `maxWaitSec`, varsayılan 60). |
| `424` (112), `500` (110), diğer 5xx, `GET /consents` ve `POST /webhooks` | 429 / 503 gibi tekrar. |
| `424` (112), `500` (110), diğer 5xx, `POST /consents` | Tekrar **yok**. `mayHaveBeenProcessed: true` hata: önce `GET /consents` ve webhook ile kontrol ([errors.md](../errors.md#post-consentste-belirsiz-sonuç)). |
| Ağ hatası, zaman aşımı | Tekrar yok. `POST /consents`'te `mayHaveBeenProcessed: true`. |
| `400`, `403`, `404`, `405`, `409`, `422` | Tekrar yok, `retryable: false`. `422`'de alan hataları `error.data.errors`'ta. |
| `200` ve `erroritem` | `saveConsents` reddedilen kayıtları `rejected` olarak döner; çağıran işler. |
| `X-Request-Id` | Her isteğe eklenir (verilmezse UUID). Hata `threadId` (`X-Thread-Id`) taşır. |
| Numara biçimi | `+90XXXXXXXXXX` olmayan telefon numarası istek atılmadan `TypeError` ile reddedilir. |

Her API hatası bir `IysApiError`'dır: `status`, `errorCode`, `threadId`, `retryable`,
`mayHaveBeenProcessed`, `data`. Mesaj şifre, token ya da alıcı içermez.

## Kullanım

```ts
// iys.ts — yalnızca sunucuda
import { IysClient, IysApiError, formatIysDate, toIysRecipient, maskRecipient } from './iys-client.ts';

export const iys = new IysClient({
  baseUrl: process.env.NETGSM_BASE_URL!,             // https://ext-api.netgsm.com.tr (yalnızca canlı)
  username: process.env.NETGSM_USERNAME!,
  password: process.env.NETGSM_PASSWORD!,
  brandCode: Number(process.env.NETGSM_IYS_BRAND_CODE),
});

/** Kendi formunuzda alınmış GERÇEK bir izni İYS'ye bildirir. */
export async function reportWebConsent(phone905: string, givenAt: Date, customerId: string) {
  try {
    const r = await iys.saveConsents([{
      recipient: toIysRecipient(phone905),            // 905… → +905…
      recipientType: 'BIREYSEL',
      type: 'MESAJ',
      source: 'HS_WEB',
      status: 'ONAY',
      consentDate: formatIysDate(givenAt),            // iznin alındığı an
    }], { refId: customerId });
    for (const x of r.rejected) {
      console.warn('İYS reddetti', { index: x.index, field: x.field, message: x.message, uid: r.uid });
    }
    return r;
  } catch (err) {
    if (err instanceof IysApiError) {
      console.error('İYS hatası', {
        status: err.status, errorCode: err.errorCode, threadId: err.threadId,
        recipient: maskRecipient(toIysRecipient(phone905)),
      });
      if (err.mayHaveBeenProcessed) {
        // Körlemesine tekrar yok: bu kaydı "doğrulanacak" olarak işaretleyin, sonra GET /consents ile bakın.
      }
    }
    throw err;
  }
}
```

Sorgu (mutabakat):

```ts
const results = await iys.searchConsents(customers.map(c => ({
  recipient: toIysRecipient(c.phone), recipientType: 'BIREYSEL', type: 'MESAJ',
})));
results.forEach((r, i) => {
  const allowed = r.errorCode === 0 && r.status === 'ONAY';   // yalnızca ONAY izin demektir
  const unknown = r.errorCode === 112 || r.errorCode === 120; // bilinmiyor: izin varmış gibi davranma
  // customers[i] ile r aynı sıradadır.
});
```

## Sahte `fetch` ile test

İYS'ye gerçek istek atmadan istemciyi ve kendi kodunuzu test edin. Sahte `fetch` istekleri kaydeder
ve hazır yanıtlar döner:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IysClient } from './iys-client.ts';

test('erroritem çağırana döner', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${new URL(url).pathname}`);
    if (url.endsWith('/auth/v3/token')) {
      return Response.json({ access_token: 't', refresh_token: 'r', expires_in: 86400, token_type: 'Bearer' });
    }
    return Response.json({ success: true, errorCode: 0, message: 'success',
      data: { uid: 'u-1', erroritem: [{ index: 0, field: 'recipient', message: 'Geçersiz' }] } });
  }) as typeof fetch;

  const iys = new IysClient({ baseUrl: 'https://example.com', username: 'u', password: 'p', brandCode: 1, fetch: fakeFetch });
  const r = await iys.saveConsents([{ recipient: '+900000000000', recipientType: 'BIREYSEL', type: 'MESAJ',
    source: 'HS_WEB', status: 'ONAY', consentDate: '2026-01-01 10:00:00' }]);
  assert.equal(r.rejected[0].field, 'recipient');
  assert.deepEqual(calls, ['POST /auth/v3/token', 'POST /iys/v1/consents']);
});
```

Testlerde gerçek numara kullanılmaz; `+900000000000` gibi bir yer tutucu yeterlidir, çünkü istek hiçbir
yere gitmez.

## Kimlik bilgileri yalnızca sunucuda

- Kullanıcı adı, şifre ve marka kodu **ortam değişkenlerinden** okunur (`NETGSM_USERNAME`,
  `NETGSM_PASSWORD`, `NETGSM_IYS_BRAND_CODE`); kaynak koda ve repoya yazılmaz.
- İstemci **yalnızca sunucu tarafında** çalışır. Next.js'te `NEXT_PUBLIC_*`, Vite'ta `VITE_*`, Create
  React App'te `REACT_APP_*` önekli değişkenler tarayıcı paketine gömülür; Netgsm bilgileri asla bu
  öneklerle tanımlanmaz.
- İzin formu tarayıcıdan sizin sunucunuza gelir; İYS isteğini sunucu atar.
- Loglarda alıcıyı `maskRecipient` ile maskeleyin; şifre ve token loglanmaz.
