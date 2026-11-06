// TypeScript referans istemcisinin (references/examples/netgsm-client.ts) gerçek mock'a karşı testi.
// `node --experimental-strip-types --test` ile çalışır (npm test bunu yapar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../../packages/sms-mock/src/server.mjs';
import { createClock } from '../../packages/sms-mock/src/clock.mjs';
import {
  NetgsmClient, NetgsmApiError, NetgsmTokenManager, parseCredit, findBalance, webhookToReport, webhookOperator,
} from '../../plugins/sms-skills/skills/netgsm-sms/references/examples/netgsm-client.ts';

const USERNAME = '8500000000';
const PASSWORD = 'password001';
const SEND_BODY = {
  sender: 'MOCKTEST',
  messages: [
    { text: 'Merhaba', recipient: '905061234567' },
    { text: 'Merhaba', recipient: '905061234568' },
  ],
};

/**
 * Her test kendi mock'unu açar. İstemcinin fetch'i sayaçla sarılır: hangi yola kaç istek gittiği
 * görülür. `shareClock` true ise istemci saatini mock'un saatinden okur (POST /__mock/clock ikisini
 * birlikte ilerletir).
 */
async function withMock(fn, { tokenTtlSec = 86400, shareClock = false, clientOpts = {} } = {}) {
  const clock = createClock();
  const server = createMockServer({ port: 0, log: () => {}, clock, tokenTtlSec });
  const baseUrl = await server.listen();
  try {
    const calls = [];
    const countingFetch = (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return fetch(input, init);
    };
    const client = new NetgsmClient({
      username: USERNAME, password: PASSWORD, baseUrl, fetch: countingFetch,
      ...(shareClock ? { now: () => clock.now() } : {}), ...clientOpts,
    });
    const control = async (method, path, body) => {
      const r = await fetch(`${baseUrl}${path}`, {
        method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return text ? JSON.parse(text) : undefined;
    };
    const scenario = (s) => control('POST', '/__mock/scenario', s);
    const advance = (advanceSeconds) => control('POST', '/__mock/clock', { advanceSeconds });
    const findings = async () => (await control('GET', '/__mock/advice')).findings.map(f => f.rule);
    const count = (key) => calls.filter(c => c === key).length;
    return await fn({ client, calls, count, scenario, advance, findings });
  } finally {
    await server.close();
  }
}

test('3 eş zamanlı gönderimde tek token isteği ve hiç bulgu yok', () => withMock(async ({ client, count, findings }) => {
  const results = await Promise.all([client.send(SEND_BODY), client.send(SEND_BODY), client.send(SEND_BODY)]);
  for (const r of results) {
    assert.match(r.jobId, /^\d+$/);
    assert.equal(r.accepted, 2);
    assert.deepEqual(r.rejectedItems, []);
  }
  assert.equal(count('POST /auth/v3/token'), 1, 'paylaşılan token isteği');
  assert.equal(count('POST /sms/v3/send'), 3);
  // Sonraki çağrı da önbellekteki token'ı kullanır.
  await client.send(SEND_BODY);
  assert.equal(count('POST /auth/v3/token'), 1);
  assert.deepEqual(await findings(), []);
}));

test('kuyruğa alınmış 503 (/send QUEUE_UNCONFIRMED senaryosu): tekrar denemez, mayHaveBeenQueued true, advisor bulgu üretmez', () => withMock(async ({ client, count, scenario, findings }) => {
  await scenario({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send' });
  const err = await client.send(SEND_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 503);
  assert.equal(err.code, 'SERVICE_UNAVAILABLE');
  assert.equal(err.mayHaveBeenQueued, true);
  assert.equal(err.retryable, false);
  assert.match(err.requestId, /^[0-9a-f]{32}$/);
  assert.equal(count('POST /sms/v3/send'), 1, 'tek deneme');
  assert.deepEqual(await findings(), []);
}));

test('500 gönderim ucunda: 504 gibi, tekrar denemez ve mayHaveBeenQueued true', () => withMock(async ({ client, count, scenario, findings }) => {
  await scenario({ code: 'INTERNAL_ERROR', path: '/sms/v3/send' });
  const err = await client.send(SEND_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 500);
  assert.equal(err.code, 'INTERNAL_ERROR');
  assert.equal(err.mayHaveBeenQueued, true);
  assert.equal(err.retryable, false);
  assert.equal(count('POST /sms/v3/send'), 1);
  assert.deepEqual(await findings(), []);
}));

test('OTP 503 x2 sonra 202: artan beklemeyle tekrar dener ve başarılı döner', () => withMock(async ({ client, count, scenario, findings }) => {
  await scenario({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/send/otp', times: 2 });
  const started = Date.now();
  const r = await client.sendOtp({ sender: 'MOCKTEST', text: 'Dogrulama kodunuz: 123456', recipient: '905061234567' });
  const elapsed = Date.now() - started;
  assert.match(r.jobId, /^\d+$/);
  assert.equal(count('POST /sms/v3/send/otp'), 3);
  assert.ok(elapsed >= 2900, `1 + 2 sn beklemeli (geçen ${elapsed} ms)`);
  assert.deepEqual(await findings(), []);
}));

test('/send 503 (SERVICE_UNAVAILABLE): toplu gönderimde tekrar yok, mayHaveBeenQueued true', () => withMock(async ({ client, count, scenario, findings }) => {
  await scenario({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/send' });
  const err = await client.send(SEND_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.equal(err.status, 503);
  assert.equal(err.mayHaveBeenQueued, true);
  assert.equal(err.retryable, false);
  assert.equal(count('POST /sms/v3/send'), 1);
  assert.deepEqual(await findings(), []);
}));

const OTP_BODY = { sender: 'MOCKTEST', text: 'Dogrulama kodunuz: 123456', recipient: '905061234567' };

test('enterpriseOtp: kurumsal OTP hesabı (8500000010) x-client: enterprise ile 202 alır', () => withMock(async ({ client, count }) => {
  const r = await client.sendOtp(OTP_BODY);
  assert.match(r.jobId, /^\d+$/);
  assert.equal(count('POST /sms/v3/send/otp'), 1);
}, { clientOpts: { username: '8500000010', password: 'password012', enterpriseOtp: true } }));

test('enterpriseOtp verilmezse kurumsal OTP hesabı 403 FORBIDDEN alır; diğer hesap enterpriseOtp ile 403 alır', async () => {
  for (const clientOpts of [
    { username: '8500000010', password: 'password012' },
    { enterpriseOtp: true },
  ]) {
    await withMock(async ({ client }) => {
      const err = await client.sendOtp(OTP_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
      assert.ok(err instanceof NetgsmApiError);
      assert.equal(err.status, 403);
      assert.equal(err.code, 'FORBIDDEN');
      assert.match(err.message, /account operator is not served for this operation/);
    }, { clientOpts });
  }
});

test('RATE_LIMITED retryAfter 1: Retry-After kadar bekleyip başarılı döner', () => withMock(async ({ client, count, scenario, findings }) => {
  await scenario({ code: 'RATE_LIMITED', path: '/sms/v3/send', retryAfter: 1 });
  const started = Date.now();
  const r = await client.send(SEND_BODY);
  const elapsed = Date.now() - started;
  assert.equal(r.accepted, 2);
  assert.equal(count('POST /sms/v3/send'), 2);
  assert.ok(elapsed >= 1000, `Retry-After 1 sn beklenmeli (geçen ${elapsed} ms)`);
  assert.deepEqual(await findings(), [], 'IGNORED_RETRY_AFTER yok');
}));

test('RATE_LIMITED, Retry-After maxRetryAfterSec üstünde: beklemeden retryable hata fırlatır', () => withMock(async ({ client, count, scenario, findings }) => {
  await scenario({ code: 'RATE_LIMITED', path: '/sms/v3/send', retryAfter: 120 });
  const err = await client.send(SEND_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfterSec, 120);
  assert.equal(err.retryable, true);
  assert.equal(count('POST /sms/v3/send'), 1);
  assert.deepEqual(await findings(), []);
}));

test('SENDING_SUSPENDED: bekleme yapmadan NetgsmApiError fırlatır', () => withMock(async ({ client, count, scenario, findings }) => {
  await scenario({ code: 'SENDING_SUSPENDED', path: '/sms/v3/send' });
  const started = Date.now();
  const err = await client.send(SEND_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(Date.now() - started < 900, 'beklememeli');
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.retryAfterSec, null);
  assert.equal(err.retryable, false);
  assert.equal(count('POST /sms/v3/send'), 1);
  assert.deepEqual(await findings(), []);
}));

test('REJECTED_HEADER: retryable false, code REJECTED_HEADER, requestId 32 hex', () => withMock(async ({ client, count, findings }) => {
  const err = await client.send({ ...SEND_BODY, sender: 'MOCKKAPALI' }).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 422);
  assert.equal(err.code, 'REJECTED_HEADER');
  assert.equal(err.retryable, false);
  assert.equal(err.mayHaveBeenQueued, false);
  assert.match(err.requestId, /^[0-9a-f]{32}$/);
  assert.match(err.message, new RegExp(err.requestId), 'mesaj requestId içerir (loglama için)');
  assert.equal(count('POST /sms/v3/send'), 1);
  assert.deepEqual(await findings(), []);
}));

test('202 kısmi başarı: rejectedItems olduğu gibi döner; hepsi reddedilirse hata rejectedItems taşır', () => withMock(async ({ client, findings }) => {
  const r = await client.send({ sender: 'MOCKTEST', messages: [
    { text: 'Merhaba', recipient: '905061234567' },
    { text: 'Merhaba', recipient: '+905061234567' },
  ] });
  assert.equal(r.accepted, 1);
  assert.equal(r.rejected, 1);
  assert.deepEqual(r.rejectedItems, [{ index: 1, recipient: '+905061234567', reason: 'INVALID_RECIPIENT' }]);
  const err = await client.send({ sender: 'MOCKTEST', messages: [{ text: 'Merhaba', recipient: '05061234567' }] })
    .then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.equal(err.code, 'NO_DELIVERABLE_MESSAGES');
  assert.equal(err.retryable, false);
  assert.deepEqual(err.rejectedItems, [{ index: 0, recipient: '05061234567', reason: 'INVALID_RECIPIENT' }]);
  assert.deepEqual(await findings(), []);
}));

test('token yenileme payına girilince refresh eder ve STALE_TOKEN üretmez', () => withMock(async ({ client, count, advance, findings }) => {
  await client.send(SEND_BODY);
  // Ömür 61 sn; yenileme payı min(300 sn, ömrün %10'u) = 6,1 sn. 2 sn sonra yenileme gerekmez.
  await advance(2);
  await client.send(SEND_BODY);
  assert.equal(count('POST /auth/v3/token/refresh'), 0);
  // 56. saniye yenileme payının içindedir (54,9 sn'den sonra).
  await advance(54);
  await client.send(SEND_BODY);
  assert.equal(count('POST /auth/v3/token'), 1);
  assert.equal(count('POST /auth/v3/token/refresh'), 1);
  // Süre tamamen dolduktan sonra da 401 almadan önce yeniler.
  await advance(62);
  await client.send(SEND_BODY);
  assert.equal(count('POST /auth/v3/token/refresh'), 2);
  assert.equal(count('POST /sms/v3/send'), 4, '401 ile tekrar yok');
  assert.deepEqual(await findings(), [], 'STALE_TOKEN yok');
}, { tokenTtlSec: 61, shareClock: true }));

test('401 UNAUTHENTICATED: bir kez yeniden giriş yapar ve isteği bir kez tekrarlar', () => withMock(async ({ client, count, advance, findings }) => {
  // İstemcinin saati gerçek saat; mock'un saati ilerletilince token sunucu tarafında süresi dolmuş olur.
  await client.send(SEND_BODY);
  await advance(62);
  const r = await client.send(SEND_BODY);
  assert.equal(r.accepted, 2);
  assert.equal(count('POST /auth/v3/token'), 2, 'yeniden giriş (refresh değil)');
  assert.equal(count('POST /auth/v3/token/refresh'), 0);
  assert.equal(count('POST /sms/v3/send'), 3);
  // Saatler ayrıldığı için istemci süresi dolmuş token'ı bir kez kullandı: mock bunu STALE_TOKEN olarak bildirir.
  assert.deepEqual(await findings(), ['STALE_TOKEN']);
}, { tokenTtlSec: 61 }));

test('sendOtp ve report: token paylaşılır, yanıtlar döner', () => withMock(async ({ client, count, findings }) => {
  const otp = await client.sendOtp({ sender: 'MOCKTEST', text: 'Dogrulama kodunuz: 123456', recipient: '905061234567' });
  assert.match(otp.jobId, /^\d+$/);
  const sent = await client.send(SEND_BODY);
  const report = await client.report({ jobIds: sent.jobId });
  assert.equal(typeof report.count, 'number');
  assert.ok(Array.isArray(report.reports));
  assert.equal(count('POST /auth/v3/token'), 1);
  assert.deepEqual(await findings(), []);
}));

test('yanlış şifre: token hatası NetgsmApiError olarak, request_id ile fırlatılır', () => withMock(async ({ client, count }) => {
  const err = await client.send(SEND_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'invalid_credentials');
  assert.equal(err.retryable, false);
  assert.ok(err.requestId, 'request_id taşınır');
  assert.ok(!err.message.includes('yanlis-sifre'), 'şifre mesaja girmez');
  assert.equal(count('POST /sms/v3/send'), 0);
}, { clientOpts: { password: 'yanlis-sifre' } }));

test('503 /stats: görev sayacı nedeniyle otomatik tekrar yok, tek istek, retryable true', () => withMock(async ({ client, count, scenario, findings }) => {
  const sent = await client.send(SEND_BODY);
  await scenario({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/stats' });
  const err = await client.request('GET', `/stats?jobId=${sent.jobId}`).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 503);
  assert.equal(err.retryable, true);
  assert.equal(err.mayHaveBeenQueued, false);
  assert.match(err.message, /stats 10 dk/);
  assert.equal(count('GET /sms/v3/stats'), 1, 'tek istek');
  assert.deepEqual(await findings(), [], 'REPORT_POLLING yok');
}));

test('503 jobIds\'li /report: otomatik tekrar yok; jobIds\'siz okuma (/senders) tekrar edilir', () => withMock(async ({ client, count, scenario, findings }) => {
  const sent = await client.send(SEND_BODY);
  await scenario({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/report' });
  const err = await client.report({ jobIds: sent.jobId }).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.equal(err.status, 503);
  assert.equal(err.retryable, true);
  assert.equal(count('GET /sms/v3/report'), 1);
  await scenario({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/senders' });
  const senders = await client.request('GET', '/senders');
  assert.ok(Array.isArray(senders.senders));
  assert.equal(count('GET /sms/v3/senders'), 2, '1 sn sonra bir tekrar');
  assert.deepEqual(await findings(), []);
}));

test('gönderimde 502: tekrar yok, mayHaveBeenQueued true; okunamayan Retry-After: beklemeden retryable hata', async () => {
  const calls = [];
  const fake = (status, headers = {}) => async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/auth/v3/token') {
      return new Response(JSON.stringify({ access_token: 't', refresh_token: '00000000-0000-4000-8000-000000000000', expires_in: 86400 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', message: 'x', requestId: 'a'.repeat(32) }), { status, headers });
  };
  const c502 = new NetgsmClient({ username: USERNAME, password: PASSWORD, baseUrl: 'http://127.0.0.1:9', fetch: fake(502) });
  const e502 = await c502.send(SEND_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.equal(e502.mayHaveBeenQueued, true);
  assert.equal(e502.retryable, false);
  assert.equal(calls.filter(c => c === 'POST /sms/v3/send').length, 1);

  calls.length = 0;
  const cBad = new NetgsmClient({ username: USERNAME, password: PASSWORD, baseUrl: 'http://127.0.0.1:9', fetch: fake(429, { 'Retry-After': 'soon' }) });
  const started = Date.now();
  const eBad = await cBad.send(SEND_BODY).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(Date.now() - started < 500, 'beklememeli');
  assert.equal(eBad.status, 429);
  assert.equal(eBad.retryable, true, 'askıya alınma değil: başlık var ama okunamıyor');
  assert.equal(calls.filter(c => c === 'POST /sms/v3/send').length, 1);
});

test('baseUrl zorunludur: verilmezse ya da boşsa kurucu hata fırlatır (varsayılan yok)', () => {
  assert.throws(() => new NetgsmClient({ username: USERNAME, password: PASSWORD }), /baseUrl/);
  assert.throws(() => new NetgsmClient({ username: USERNAME, password: PASSWORD, baseUrl: '' }), /baseUrl/);
  assert.doesNotThrow(() => new NetgsmClient({ username: USERNAME, password: PASSWORD, baseUrl: 'http://127.0.0.1:4010/' }));
});

test('POST /cancel 500: tekrar denenir (iptali tekrarlamak SMS göndermez), mayHaveBeenQueued işaretlenmez', () => withMock(async ({ client, count, scenario }) => {
  const startAt = new Date(Date.now() + 3_600_000).toISOString();
  const sent = await client.send({ ...SEND_BODY, startAt });
  await scenario({ code: 'INTERNAL_ERROR', path: '/sms/v3/cancel' });
  await client.request('POST', '/cancel', { jobId: sent.jobId });
  assert.equal(count('POST /sms/v3/cancel'), 2, 'bir kez tekrar');
}));

test('POST /cancel 5xx tekrarları tükenince: retryable true, mayHaveBeenQueued false', async () => {
  const fake = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/auth/v3/token') {
      return new Response(JSON.stringify({ access_token: 't', refresh_token: '00000000-0000-4000-8000-000000000000', expires_in: 86400 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 'QUEUE_UNCONFIRMED', message: 'x', requestId: 'b'.repeat(32) }), { status: 504 });
  };
  const c = new NetgsmClient({ username: USERNAME, password: PASSWORD, baseUrl: 'http://127.0.0.1:9', fetch: fake, maxRetryAfterSec: 0 });
  const err = await c.request('POST', '/cancel', { jobId: '123' }).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 504);
  assert.equal(err.mayHaveBeenQueued, false);
  assert.equal(err.retryable, true);
});

// ---- GET /balance ve rapor webhook'u yardımcıları

test('getBalance: varsayılan (stip 1) ve stip 3 listesi; kayıtlar ada göre bulunur, miktarlar sayıya çevrilir', () => withMock(async ({ client, count, findings }) => {
  const list = await client.getBalance();
  // service verilmezse SMS gönderim hizmetinin varlıkları (OTP SMS paketi dahil; service=sms'ten farklı)
  assert.deepEqual(list.balance.map(e => e.balance_name), ['Adet SMS', 'Adet OTP SMS', 'Dakika']);
  const full = await client.getBalance({ stip: 3 });
  assert.equal(full.balance.at(-1).balance_name, 'Kredi Bakiye');
  // amount metin ya da sayı olabilir; findBalance ikisini de sayıya çevirir
  assert.equal(typeof full.balance.find(e => e.balance_name === 'Adet SMS').amount, 'number');
  assert.equal(typeof full.balance.find(e => e.balance_name === 'Dakika').amount, 'string');
  assert.equal(findBalance(full.balance, 'adet otp sms'), 767);
  assert.equal(findBalance(full.balance, 'Adet SMS'), 277);
  // ad büyük/küçük harfe duyarsız eşleşir
  assert.equal(findBalance(full.balance, 'adet sms'), 277);
  assert.equal(findBalance(full.balance, 'KREDİ BAKİYE'), 92.15);
  assert.equal(findBalance([{ amount: '300', balance_name: 'Adet OTP Sms' }], 'Adet OTP SMS'), 300);
  assert.equal(findBalance(full.balance, 'Kredi Bakiye'), 92.15);
  assert.equal(findBalance(full.balance, 'Yok'), null);
  assert.equal(count('GET /sms/v3/balance'), 2);
  assert.equal(count('POST /auth/v3/token'), 1);
  assert.deepEqual(await findings(), []);
}));

test('getBalance: service listeyi sınırlar; stip 2 özeti kredi metni döner', () => withMock(async ({ client }) => {
  assert.deepEqual(await client.getBalance({ service: 'OTP' }), { balance: [{ amount: '767', balance_name: 'Adet OTP SMS' }] });
  const s = await client.getBalance({ stip: 2 });
  assert.deepEqual(s, { code: '00', balance: '92,150' });
  assert.equal(parseCredit(s.balance), 92.15);
}));

test('getBalance stip 2: AdetSMS, faturalı "0" ve alanı olmayan özet', async () => {
  for (const [username, password, expected, credit] of [
    ['8500000008', 'password009', { code: '00', balance: '1500', type: 'AdetSMS' }, 1500],
    ['8500000010', 'password012', { code: '00', balance: '0' }, 0],
    ['8500000009', 'password010', { code: '00' }, null],
  ]) {
    await withMock(async ({ client }) => {
      const s = await client.getBalance({ stip: 2 });
      assert.deepEqual(s, expected, username);
      // alan yoksa parseCredit null döner, hata fırlatmaz
      assert.equal(parseCredit(s.balance), credit, username);
    }, { clientOpts: { username, password } });
  }
});

test('getBalance: geçersiz service 400, retryable false', () => withMock(async ({ client, count }) => {
  const err = await client.getBalance({ service: 'email' }).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 400);
  assert.equal(err.code, 'INVALID_REQUEST');
  assert.equal(err.retryable, false);
  assert.match(err.message, /service must be one of sms, otp/);
  assert.equal(count('GET /sms/v3/balance'), 1);
}));

test('getBalance 429: beklemez ve tekrar etmez; retryable true, retryAfterSec ile tek istek', () => withMock(async ({ client, count, scenario }) => {
  await scenario({ code: 'RATE_LIMITED', path: '/sms/v3/balance', retryAfter: 1 });
  const started = Date.now();
  const err = await client.getBalance({ stip: 3 }).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.ok(err instanceof NetgsmApiError);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.equal(err.retryable, true);
  assert.equal(err.retryAfterSec, 1);
  assert.match(err.message, /balance rate limit exceeded/);
  assert.equal(count('GET /sms/v3/balance'), 1, 'döngü yok');
  assert.ok(Date.now() - started < 900, 'Retry-After kadar beklenmedi');
}));

test('getBalance 429 (gerçek sınır, dakikada 60): 61. çağrı tek istekle hata döner', () => withMock(async ({ client, count }) => {
  for (let i = 0; i < 60; i++) await client.getBalance({ stip: 2 });
  const err = await client.getBalance({ stip: 2 }).then(() => assert.fail('hata bekleniyordu'), e => e);
  assert.equal(err.status, 429);
  assert.equal(err.retryable, true);
  assert.ok(err.retryAfterSec > 0 && err.retryAfterSec <= 60);
  assert.equal(count('GET /sms/v3/balance'), 61);
}));

test('parseCredit: virgüllü TL metni, sayı ve okunamayan değer', () => {
  assert.equal(parseCredit('92,150'), 92.15);
  assert.equal(parseCredit('0,000'), 0);
  assert.equal(parseCredit('0'), 0);
  assert.equal(parseCredit('277'), 277);
  assert.equal(parseCredit(242.5), 242.5);
  assert.equal(parseCredit(' 15 '), 15);
  for (const bad of ['', 'abc', '1.234,5', '12,3,4', null, undefined, Number.NaN]) assert.equal(parseCredit(bad), null, String(bad));
});

test('webhookToReport: sayısal webhook kodları GET /report adlarına çevrilir', () => {
  assert.deepEqual(webhookToReport({ status: 1, operator: 10, errorCode: 0 }), { status: 'DELIVERED', failReason: null, operator: 'VODAFONE' });
  assert.deepEqual(webhookToReport({ status: 2, operator: 30, errorCode: 115 }), { status: 'NOT_DELIVERED', failReason: 'OPERATOR_TIMEOUT', operator: 'TURKCELL' });
  assert.deepEqual(webhookToReport({ status: 2, operator: 20, errorCode: null }), { status: 'NOT_DELIVERED', failReason: 'UNKNOWN', operator: 'TURK_TELEKOM' });
  assert.deepEqual(webhookToReport({ status: 2, operator: 0, errorCode: 0 }), { status: 'NOT_DELIVERED', failReason: 'UNKNOWN', operator: 'UNKNOWN' });
  // status 2 dışında errorCode dikkate alınmaz
  assert.deepEqual(webhookToReport({ status: 15, operator: 41, errorCode: 116 }), { status: 'NOT_DELIVERED', failReason: 'BLACKLISTED', operator: 'NETGSM' });
  assert.equal(webhookToReport({ status: 22, operator: 214, errorCode: 0 }).failReason, 'NO_INTERNATIONAL_PERMISSION');
  assert.equal(webhookOperator(214), 'INTERNATIONAL');
  assert.equal(webhookOperator(43), 'NETGSM');
  assert.equal(webhookOperator(45), 'AKONTEL');
  assert.equal(webhookOperator(219), 'UNKNOWN');
});

test('webhookToReport: mock\'un gönderdiği rapor webhook gövdesini çevirir', async () => {
  const clock = createClock();
  const received = [];
  const server = createMockServer({
    port: 0, log: () => {}, clock,
    fetchImpl: async (url, init) => { received.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); },
  });
  const baseUrl = await server.listen();
  try {
    const client = new NetgsmClient({ username: USERNAME, password: PASSWORD, baseUrl, now: () => clock.now() });
    await client.request('POST', '/webhooks/report', { url: 'http://127.0.0.1:9/rapor' });
    await client.send({ sender: 'MOCKTEST', messages: [{ text: 'a', recipient: '905061234567' }, { text: 'a', recipient: '905321234500' }] });
    await fetch(`${baseUrl}/__mock/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advanceSeconds: 6 }) });
    await server.ctx.webhooks.tick();
    const rows = received.flatMap(b => b.numbers);
    assert.equal(rows.length, 2);
    const byNum = Object.fromEntries(rows.map(r => [r.number, { ...webhookToReport(r), referansID: r.referansID }]));
    assert.deepEqual(byNum['5061234567'], { status: 'DELIVERED', failReason: null, operator: 'TURK_TELEKOM', referansID: null });
    assert.deepEqual(byNum['5321234500'], { status: 'NOT_DELIVERED', failReason: 'UNKNOWN_SUBSCRIBER', operator: 'TURKCELL', referansID: null });
  } finally {
    await server.close();
  }
});

test('refresh beklenirken invalidate() çağrılırsa çökmez, yeniden giriş yapar', async () => {
  let t = 0;
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const token = (n) => Response.json({ access_token: `a${n}`, refresh_token: '00000000-0000-4000-8000-000000000000', expires_in: 3600 });
  const fakeFetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (calls.length === 1) return token(1);
    if (path.endsWith('/refresh')) { await gate; return Response.json({}, { status: 503 }); }
    return token(2);
  };
  const manager = new NetgsmTokenManager({
    baseUrl: 'https://example.com', username: 'u', password: 'p', scope: 'sms', fetch: fakeFetch, now: () => t,
  });
  assert.equal(await manager.get(), 'a1');
  t = 3600_000 - 60_000; // yenileme payının içinde
  const pending = manager.get();
  await new Promise((r) => setImmediate(r));
  manager.invalidate('a1'); // ör. başka bir istek 401 aldı
  release();
  assert.equal(await pending, 'a2');
  assert.deepEqual(calls, ['/auth/v3/token', '/auth/v3/token/refresh', '/auth/v3/token']);
});
