# TypeScript / Node.js örneği

Referans istemci: [netgsm-client.ts](netgsm-client.ts). Bağımlılığı yoktur, Node ≥ 20'nin global
`fetch`'ini kullanır. Dosyayı projenize kopyalayın. Bu reponun testleri onu gerçek mock'a karşı çalıştırır
(token paylaşımı, 401, 429, uç noktaya göre 5xx, `rejectedItems`, bakiye, rapor webhook kodları).

İstemcinin uyguladığı kurallar ([SKILL.md](../../SKILL.md) "Değişmez kurallar" ile aynı):

| Durum | Davranış |
|---|---|
| Token | Bellekte tutulur. Süresinin son min(5 dk, ömrün %10'u) kısmında `POST /auth/v3/token/refresh` ile yenilenir. Aynı anda gelen çağrılar tek token isteğini bekler. Başarısız refresh'te eski token geçerliyse 30 sn onunla devam edilir ([auth.md](../auth.md#önerilen-istemci-deseni)). |
| `401 UNAUTHENTICATED` | O istekte kullanılan token atılır, yeniden giriş yapılır, istek **bir kez** tekrarlanır. |
| `429` + `Retry-After` | `Retry-After` (en fazla `maxRetryAfterSec`, varsayılan 60) kadar beklenir, bir kez tekrarlanır. Daha uzunsa `retryable: true` hata. |
| `429`, `Retry-After` yok | Gönderim askıya alınmış: beklemeden `retryable: false` hata. |
| `429`, `Retry-After` okunamıyor (sayı ya da HTTP tarihi değil) | Tekrar yok, beklemeden `retryable: true` hata. |
| `429`, `GET /balance`'ta | Beklemez, tekrar etmez: `retryable: true` ve `retryAfterSec` ile hata. Ne zaman yeniden okunacağına çağıran karar verir. |
| 5xx (`503` dahil), toplu gönderimde (`/send`, `/send/template`, `/directory/send`) | Tekrar **yok**. `mayHaveBeenQueued: true`, `retryable: false` hata. `/send` ve `/send/template`'te `503` sonrası görev çoğunlukla kuyruğa alınmamıştır ama bu kesin değildir; `/directory/send`'de `503` ve `504` görevin kuyruğa alınmış olabileceğini gösterir. Yeniden göndermeden önce `GET /report` ([errors.md](../errors.md#503-ve-504-sonrası-kontrol)). |
| `503`, `POST /send/otp`'de | Hiçbir şey gönderilmemiştir: 1, 2, 4 sn arayla en fazla 3 tekrar. |
| `503` dışındaki 5xx (`500`, `502`), `POST /send/otp`'de | Tekrar **yok**. `mayHaveBeenQueued: true` hata: OTP gönderilmiş olabilir. |
| `503`, diğer GET olmayan isteklerde (`/length`, `/webhooks/*`, `PUT /senders/default`) | 1, 2, 4 sn arayla en fazla 3 tekrar; `503` dışındaki 5xx'te tekrar yok, `mayHaveBeenQueued: true`. |
| 5xx, `POST /cancel`'da | İptali tekrarlamak her zaman güvenlidir ([errors.md](../errors.md#503-ve-504-sonrası-kontrol)): 1, 2, 4 sn arayla tekrar; tükenirse `retryable: true`, `mayHaveBeenQueued: false`. Tekrardan sonra `404` bekleyen görev kalmadığını gösterir. |
| 5xx, okuma (GET) isteklerinde | `503` gibi 1, 2, 4 sn arayla tekrar. **İstisna:** `/stats` ve `jobIds`'li `/report` otomatik tekrar edilmez. Bu sorguların görev başına sayacı vardır ve hatayla biten okuma da sayılır (`/stats`'ta `404` ve `503` dahil); hemen tekrar `429` (stats'ta ~10 dk) ve mock'ta `REPORT_POLLING` getirir. Hata `retryable: true` döner; görev penceresi dolunca (report 1 dk, stats 10 dk) yeniden deneyin. |
| `400`, `403`, `413`, `422` | Tekrar yok, `retryable: false`. `NO_DELIVERABLE_MESSAGES`'ta hata `rejectedItems` taşır. |
| `202` | Yanıt olduğu gibi döner; `rejectedItems` çağıranın işidir. |

`baseUrl` **zorunludur**, varsayılanı yoktur: istemci hangi ortama gittiğini her zaman koddan değil
yapılandırmadan alır. Örnekler `NETGSM_BASE_URL`'yi okur, verilmezse mock'a (`http://127.0.0.1:4010`)
gider; canlı adres `https://ext-api.netgsm.com.tr`'dir.

Her API hatası bir `NetgsmApiError`'dır: `status`, `code`, `requestId`, `retryAfterSec`, `retryable`,
`mayHaveBeenQueued`, `rejectedItems`. Mesajı `requestId`'yi içerir; şifre ve token hiçbir mesaja girmez.
Ağ hatası ya da zaman aşımı (`fetch`'in fırlattığı hata) tekrar denenmez: gönderimde yanıt alınamaması
`mayHaveBeenQueued` gibidir, istek ulaşmış olabilir.

## Kimlik bilgileri yalnızca sunucuda

- Kullanıcı adı ve şifre **ortam değişkenlerinden** okunur (`NETGSM_USERNAME`, `NETGSM_PASSWORD`),
  kaynak koda ve repoya yazılmaz.
- İstemci **yalnızca sunucu tarafında** çalışır. Tarayıcıya, mobil uygulamaya ya da istemci paketine
  giden hiçbir koda konmaz. Next.js'te `NEXT_PUBLIC_` önekli değişken tarayıcı paketine gömülür:
  Netgsm bilgileri **asla** `NEXT_PUBLIC_*` olmaz. Vite'ta `VITE_*`, Create React App'te `REACT_APP_*`
  için de aynısı geçerlidir.
- Tarayıcı kendi sunucunuzdaki bir uç noktayı çağırır; o uç nokta Netgsm'e gider. Bu uç noktayı oturum
  açmış kullanıcıyla sınırlayın ve kullanıcı başına hız sınırı koyun: kimliksiz bir "SMS gönder" uç noktası
  başkalarının sizin hesabınızdan SMS göndermesine açık kapıdır.
- Süreç başına **tek** `NetgsmClient` örneği kullanılır. İstek başına yeni örnek, istek başına yeni
  token demektir (mock bunu `TOKEN_CHURN` ile bildirir).

```bash
# .env (repoya eklemeyin). NETGSM_BASE_URL verilmezse örnekler mock'a gider.
NETGSM_USERNAME=8500000000          # canlıda abone numaranız
NETGSM_PASSWORD=password001         # canlıda API alt kullanıcısının şifresi
NETGSM_SENDER=MOCKTEST              # canlıda onaylı başlığınız
# NETGSM_BASE_URL=https://ext-api.netgsm.com.tr   # canlı: gerçek, ücretli SMS
```

## Kullanım

```ts
// netgsm.ts: süreç başına tek örnek
import { NetgsmClient, NetgsmApiError, type SmsSendRequest } from './netgsm-client';

export const netgsm = new NetgsmClient({
  username: process.env.NETGSM_USERNAME!,
  password: process.env.NETGSM_PASSWORD!,
  // Zorunlu. Verilmezse mock; canlı: https://ext-api.netgsm.com.tr (gerçek, ücretli SMS)
  baseUrl: process.env.NETGSM_BASE_URL ?? 'http://127.0.0.1:4010',
});

export async function notifyCustomers(customers: { phone: string; name: string }[]) {
  // Bütün alıcılar tek istekte, her kayıt kendi metniyle. Alıcı başına istek atılmaz.
  const req: SmsSendRequest = {
    sender: process.env.NETGSM_SENDER!,
    encoding: 'TURKISH',
    messages: customers.map(c => ({ recipient: c.phone, text: `Merhaba ${c.name}, siparişiniz yola çıktı.` })),
  };
  try {
    const res = await netgsm.send(req);
    console.info('sms queued', { jobId: res.jobId, status: res.status, accepted: res.accepted, rejected: res.rejected });
    for (const item of res.rejectedItems) {
      // index, messages dizisindeki konumdur.
      console.warn('sms rejected', { jobId: res.jobId, index: item.index, recipient: item.recipient, reason: item.reason });
    }
    if (res.rejectedItemsTruncated) console.warn('100+ kayıt reddedildi; alıcıları göndermeden önce doğrulayın', { jobId: res.jobId });
    return res.jobId;
  } catch (err) {
    if (!(err instanceof NetgsmApiError)) throw err;
    console.error('sms failed', { code: err.code, status: err.status, requestId: err.requestId });
    if (err.mayHaveBeenQueued) {
      // 503 / 500 (ve /directory/send'de 504): gönderilmiş olabilir. Tekrar GÖNDERMEYİN: çift SMS riski.
      // GET /report ile kontrol edin; belirsizse requestId ile teknikdestek@netgsm.com.tr.
    } else if (err.retryable) {
      // Geçici (uzun Retry-After, okuma ya da OTP'de süren 503): işi err.retryAfterSec sonra kendi iş kuyruğunuzda yeniden planlayın.
    } else {
      // 400/403/413/422 ve askıya alınmış gönderim: aynı istek aynı sonucu verir. code'a göre düzeltin (errors.md).
      for (const item of err.rejectedItems ?? []) console.warn('sms rejected', item);
    }
    throw err;
  }
}
```

Diğer uç noktalar için `request<T>(method, path, body?)`; `path` `/sms/v3`'e göredir:

```ts
const senders = await netgsm.request<{ count: number; senders: { name: string; usable: boolean }[] }>('GET', '/senders');
const report = await netgsm.report({ jobIds: jobId }); // aynı jobId dakikada bir; sürekli takip için webhook
```

OTP için `sendOtp`: tek alıcı (`5…`, `05…` ya da `905…`, başına `+` eklenebilir); metin kırpılır ve ASCII'ye çevrilir. `503`'ü
istemci kendisi tekrarlar. `mayHaveBeenQueued` ise (`500`) **yeni şifre göndermeyin**; kullanıcıya "kod
gelmediyse tekrar isteyin" seçeneği sunun. Hesabınızda kurumsal OTP hizmeti tanımlıysa istemciyi
`enterpriseOtp: true` ile oluşturun: `sendOtp` `x-client: enterprise` başlığını ekler. Diğer hesaplarda
bu seçeneği açmayın; uyuşmazlık iki yönde de `403 FORBIDDEN` alır.

```ts
await netgsm.sendOtp({ sender: process.env.NETGSM_SENDER!, recipient: '905xxxxxxxxx', text: `Dogrulama kodunuz: ${code}` });
```

## Bakiye

`getBalance({ stip, service })` `GET /sms/v3/balance`'ı çağırır
([balance.md](../endpoints/balance.md), https://api-docs.netgsm.com.tr/get-balance/). Bakiyeyi büyük bir
kampanyadan önce **bir kez** okuyun; her mesajdan önce okumayın, döngüde sorgulamayın (hesap başına
dakikada 60 istek). Yanıt 10 sn önbellektedir: gönderimden hemen sonra okunan değer en fazla 10 sn eski
olabilir. Yetersizliğin kesin bildirimi yine gönderimin kendisidir (`INSUFFICIENT_CREDIT`).

```ts
import { NetgsmApiError, findBalance, parseCredit } from './netgsm-client';

/** Kampanya öncesi kontrol: kalan SMS adedi ve TL kredi. Varlıklar sıraya göre değil adıyla bulunur. */
export async function canStartCampaign(neededSms: number): Promise<boolean> {
  try {
    const { balance } = await netgsm.getBalance({ stip: 3 });
    const sms = findBalance(balance, 'Adet SMS') ?? 0;          // "Adet SMS" yoksa 0
    const creditTl = findBalance(balance, 'Kredi Bakiye') ?? 0;  // "92,150" → 92.15
    console.info('balance', { sms, creditTl });
    return sms >= neededSms || creditTl > 0; // kredinin kaç SMS'e yettiği bu yanıttan hesaplanamaz
  } catch (err) {
    if (err instanceof NetgsmApiError && err.status === 429) {
      // Beklemeyin, döngüye girmeyin: kontrolü err.retryAfterSec sonra yeniden planlayın.
      console.warn('balance rate limited', { retryAfterSec: err.retryAfterSec, requestId: err.requestId });
    }
    throw err;
  }
}

// stip=2: tek satır özet. Faturalı hesapta her zaman "0"; faturasızda kredi, yoksa SMS adedi (type: 'AdetSMS').
const s = await netgsm.getBalance({ stip: 2 });
const value = parseCredit(s.balance); // alan yoksa ya da okunamazsa null
```

## Rapor webhook'u

Rapor webhook'u (`POST /sms/v3/webhooks/report` ile kaydedilir) iletim sonuçlarını sayısal kodlarla
gönderir: `status` (`1` iletildi, `2` iletilmedi ve nedeni `errorCode`'da, `3`, `4`, `8`, `11`–`20`, `22`
nedeni kendisi söyler), `operator` ve `errorCode` (yalnızca `status` `2` iken anlamlı). `failReason` alanı
yoktur; `referansID` referans verilmediyse `null`'dır. Bekleyen sonuçlar gelmez. `webhookToReport` kodları
`GET /report`'taki adlara çevirir ([webhooks.md](../endpoints/webhooks.md)).

```ts
import { timingSafeEqual } from 'node:crypto';
import { webhookToReport, type ReportWebhookPayload } from './netgsm-client';

// Kayıtta verdiğiniz başlıkla (ör. 'X-Webhook-Token: <gizli>') isteğin sizden geldiğini doğrulayın.
// Token tanımsız ya da boşsa uygulama başlamaz (fail-closed): aksi hâlde başlıksız istek de kabul edilirdi.
const expectedToken = process.env.NETGSM_WEBHOOK_TOKEN;
if (!expectedToken) throw new Error('NETGSM_WEBHOOK_TOKEN tanımlı olmalı');
const tokenOk = (got?: string): boolean => {
  const a = Buffer.from(got ?? ''), b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b); // sabit zamanlı karşılaştırma
};
app.post('/netgsm/report', express.json(), async (req, res) => { // Express uygulamanızda (aşağıya bakın)
  if (!tokenOk(req.get('X-Webhook-Token'))) return res.sendStatus(401);
  const { numbers } = req.body as ReportWebhookPayload;
  for (const n of numbers ?? []) {
    const r = webhookToReport(n); // { status: 'DELIVERED' | 'NOT_DELIVERED', failReason, operator }
    await deliveries.upsert({ jobId: n.jobid, number: n.number, referenceId: n.referansID, ...r, parts: n.msglen });
  }
  res.sendStatus(200); // herhangi bir 2xx teslim alındı demektir
});
```

## Express

```ts
import express from 'express';
import { netgsm } from './netgsm';
import { NetgsmApiError } from './netgsm-client';

const app = express();
app.use(express.json());

// requireAuth ve rateLimitPerUser sizin oturum ve hız sınırı ara katmanlarınızdır.
app.post('/api/sms/shipment', requireAuth, rateLimitPerUser, async (req, res, next) => {
  try {
    const order = await orders.findForUser(req.body.orderId, req.user.id); // alıcı ve metin sunucuda belirlenir
    const r = await netgsm.send({
      sender: process.env.NETGSM_SENDER!,
      messages: [{ recipient: order.phone, text: `Siparişiniz ${order.no} kargoya verildi.` }],
    });
    for (const item of r.rejectedItems) req.log?.warn({ jobId: r.jobId, ...item }, 'sms rejected');
    res.status(202).json({ jobId: r.jobId, accepted: r.accepted, rejected: r.rejected });
  } catch (err) {
    if (!(err instanceof NetgsmApiError)) return next(err); // Express 4 async hatayı kendisi yakalamaz
    console.error('sms failed', { code: err.code, requestId: err.requestId });
    if (err.mayHaveBeenQueued) return res.status(202).json({ status: 'UNCONFIRMED', requestId: err.requestId });
    if (err.retryable) return res.status(503).set('Retry-After', String(err.retryAfterSec ?? 30)).json({ code: err.code });
    res.status(502).json({ code: err.code, requestId: err.requestId });
  }
});
```

`UNCONFIRMED` yanıtı, tarayıcının isteği tekrar göndermesini önlemek içindir: gönderim yapılmış olabilir.

## Next.js (App Router)

İstemciyi yalnızca sunucuda yüklenen bir modüle koyun. `import 'server-only'` (aynı adlı paket), bu
modül yanlışlıkla bir istemci bileşenine import edilirse derlemeyi durdurur. Geliştirme sunucusu modülleri
yeniden yüklediğinde yeni token alınmaması için örnek `globalThis`'te tutulur.

```ts
// lib/netgsm.ts
import 'server-only';
import { NetgsmClient } from './netgsm-client';

const g = globalThis as unknown as { netgsm?: NetgsmClient };
export const netgsm = (g.netgsm ??= new NetgsmClient({
  username: process.env.NETGSM_USERNAME!,   // NEXT_PUBLIC_ değil
  password: process.env.NETGSM_PASSWORD!,
  baseUrl: process.env.NETGSM_BASE_URL ?? 'http://127.0.0.1:4010',
}));
```

```ts
// app/api/sms/route.ts
import { NextResponse } from 'next/server';
import { netgsm } from '@/lib/netgsm';
import { NetgsmApiError } from '@/lib/netgsm-client';
import { auth } from '@/lib/auth'; // sizin oturum kontrolünüz

// Node.js runtime: modül düzeyindeki tek istemci (ve token önbelleği) süreç boyunca yaşar. Edge de sunucu
// tarafıdır, ama izole örnekler kısa ömürlüdür; orada token önbelleği sık sık sıfırlanır.
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { orderId } = await request.json();
  const order = await getOrderForUser(orderId, session.user.id);
  try {
    const r = await netgsm.send({
      sender: process.env.NETGSM_SENDER!,
      messages: [{ recipient: order.phone, text: `Siparişiniz ${order.no} kargoya verildi.` }],
    });
    for (const item of r.rejectedItems) console.warn('sms rejected', { jobId: r.jobId, ...item });
    return NextResponse.json({ jobId: r.jobId }, { status: 202 });
  } catch (err) {
    if (!(err instanceof NetgsmApiError)) throw err;
    console.error('sms failed', { code: err.code, requestId: err.requestId });
    if (err.mayHaveBeenQueued) return NextResponse.json({ status: 'UNCONFIRMED', requestId: err.requestId }, { status: 202 });
    return NextResponse.json({ code: err.code, requestId: err.requestId }, { status: err.retryable ? 503 : 502 });
  }
}
```

Server Action'larda ve Server Component'lerde de aynı `netgsm` örneği kullanılır. Koruma
`lib/netgsm.ts`'teki `import 'server-only'` satırıdır: modül bir istemci bileşeninin paketine girerse
derleme durur.

## NestJS

İstemciyi bir servise sarın. Nest servisleri varsayılan olarak tekildir (singleton); bu servisi
`Scope.REQUEST` yapmayın, aksi halde her istek yeni token alır.

```ts
// sms.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NetgsmClient, NetgsmApiError, type SmsMessage } from './netgsm-client';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly client: NetgsmClient;

  constructor(config: ConfigService) {
    this.client = new NetgsmClient({
      username: config.getOrThrow<string>('NETGSM_USERNAME'),
      password: config.getOrThrow<string>('NETGSM_PASSWORD'),
      baseUrl: config.get<string>('NETGSM_BASE_URL') ?? 'http://127.0.0.1:4010',
    });
  }

  async send(sender: string, messages: SmsMessage[]) {
    try {
      const r = await this.client.send({ sender, messages });
      this.logger.log(`sms queued jobId=${r.jobId} accepted=${r.accepted} rejected=${r.rejected}`);
      for (const item of r.rejectedItems) this.logger.warn(`sms rejected jobId=${r.jobId} index=${item.index} reason=${item.reason}`);
      return r;
    } catch (err) {
      if (err instanceof NetgsmApiError) this.logger.error(`sms failed code=${err.code} requestId=${err.requestId} mayHaveBeenQueued=${err.mayHaveBeenQueued}`);
      throw err;
    }
  }
}
```

Uzun süren toplu gönderimleri bir iş kuyruğundan (BullMQ gibi) çalıştırıyorsanız, kuyruğun kendi
otomatik tekrarını `NetgsmApiError.mayHaveBeenQueued` ve `retryable: false` hatalarında kapatın: istemci
güvenli tekrarları zaten yapar, kuyruğun körlemesine tekrarı `503` / `504` sonrası çift gönderim demektir.

## Mock'ta denemek

```bash
node <skill dizini>/scripts/netgsm-sms-mock.mjs        # http://127.0.0.1:4010
# Başka bir terminalde, NETGSM_BASE_URL verilmeden uygulamanızı çalıştırın; sonra:
curl -s http://127.0.0.1:4010/__mock/advice             # { "findings": [] } beklenir
```

Hata dallarını denemek için `POST /__mock/scenario` (`SERVICE_UNAVAILABLE`, `QUEUE_UNCONFIRMED`,
`RATE_LIMITED`, `SENDING_SUSPENDED`, ...) ve kısa token ömrü için `--token-ttl 60`: bkz.
[testing.md](../testing.md).

Canlıya geçerken yalnızca `NETGSM_BASE_URL=https://ext-api.netgsm.com.tr` ve kimlik bilgileri değişir.
Canlı adres **gerçek, ücretli SMS** gönderir.
