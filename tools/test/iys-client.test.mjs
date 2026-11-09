// İYS TypeScript istemcisinin (references/examples/iys-client.ts) testi. İYS'nin sandbox'ı ve mock'u
// yoktur: testler sahte bir fetch ile çalışır, hiçbir istek ağa çıkmaz. Numaralar yer tutucudur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IysClient, IysApiError, formatIysDate, toIysRecipient, maskRecipient, chunk,
} from '../../plugins/sms-skills/skills/netgsm-iys/references/examples/iys-client.ts';

const BASE = 'https://example.com';
const PHONE = '+900000000001';
const RECORD = { recipient: PHONE, recipientType: 'BIREYSEL', type: 'MESAJ', source: 'HS_WEB', status: 'ONAY', consentDate: '2026-01-01 10:00:00' };
const TOKEN = { access_token: 'acc-1', refresh_token: '0b6c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4', expires_in: 86400, token_type: 'Bearer' };
const ok = (data) => ({ success: true, errorCode: 0, message: 'success', data });
const err = (errorCode, message = 'x') => ({ success: false, errorCode, message, data: [] });

/**
 * `routes`: "METOT /yol" → yanıt sırası ({ status, body, headers }); son eleman tekrar kullanılır.
 * Dönüş: istemci, istek kaydı.
 */
function setup(routes, opts = {}) {
  const calls = [];
  let tokenN = 0;
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    calls.push({ key, url, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (key === 'POST /auth/v3/token') {
      tokenN++;
      return Response.json({ ...TOKEN, access_token: `acc-${tokenN}` });
    }
    const list = routes[key];
    if (!list) return Response.json(err(80), { status: 405 });
    const r = list.length > 1 ? list.shift() : list[0];
    return Response.json(r.body, { status: r.status ?? 200, headers: r.headers });
  };
  const sleeps = [];
  const client = new IysClient({
    baseUrl: BASE, username: 'u', password: 'gizli-sifre', brandCode: 123456,
    fetch: fakeFetch, sleep: async (ms) => { sleeps.push(ms); }, ...opts,
  });
  return { client, calls, sleeps, count: (k) => calls.filter(c => c.key === k).length };
}

test('token scope "sms" ile bir kez alınır ve eş zamanlı isteklerde paylaşılır', async () => {
  const { client, calls, count } = setup({ 'GET /iys/v1/consents': [{ body: ok([{ ...RECORD, errorCode: 0 }]) }] });
  await Promise.all([1, 2, 3].map(() => client.searchConsents([{ recipient: PHONE, recipientType: 'BIREYSEL', type: 'MESAJ' }])));
  assert.equal(count('POST /auth/v3/token'), 1);
  assert.equal(calls.find(c => c.key === 'POST /auth/v3/token').body.scope, 'sms');
  const q = calls.find(c => c.key === 'GET /iys/v1/consents');
  assert.equal(q.headers.Authorization, 'Bearer acc-1');
  assert.match(q.headers['X-Request-Id'], /^[A-Za-z0-9._-]{8,64}$/);
});

test('401 → bir kez yeniden giriş, istek bir kez tekrarlanır; ikinci 401 hata', async () => {
  const a = setup({ 'POST /iys/v1/webhooks': [{ status: 401, body: err(53, 'Token has expired') }, { body: ok({ uid: 'w-1' }) }] });
  assert.equal((await a.client.saveWebhook('https://example.com/iys/webhook/gizli')).uid, 'w-1');
  assert.equal(a.count('POST /auth/v3/token'), 2);
  assert.equal(a.count('POST /iys/v1/webhooks'), 2);

  const b = setup({ 'POST /iys/v1/webhooks': [{ status: 401, body: err(52) }] });
  await assert.rejects(b.client.saveWebhook('https://example.com/h'), (e) => e instanceof IysApiError && e.errorCode === 52 && !e.retryable);
  assert.equal(b.count('POST /iys/v1/webhooks'), 2);
});

test('POST /consents: erroritem çağırana döner, gövde brandCode ve kayıtları taşır', async () => {
  const { client, calls } = setup({ 'POST /iys/v1/consents': [{ body: ok({ uid: 'u-1', erroritem: [{ index: 0, field: 'recipient', message: 'Geçersiz' }] }) }] });
  const r = await client.saveConsents([RECORD], { refId: 'musteri-1', requestId: 'consent-test-0001' });
  assert.equal(r.uid, 'u-1');
  assert.deepEqual(r.rejected, [{ index: 0, field: 'recipient', message: 'Geçersiz' }]);
  assert.equal(r.requestId, 'consent-test-0001');
  const sent = calls.find(c => c.key === 'POST /iys/v1/consents');
  assert.equal(sent.body.brandCode, 123456);
  assert.equal(sent.body.refId, 'musteri-1');
  assert.deepEqual(sent.body.permissions, [RECORD]);
  assert.equal(sent.headers['X-Request-Id'], 'consent-test-0001');
});

test('POST /consents: 424 ve 500 tekrar edilmez, mayHaveBeenProcessed true', async () => {
  for (const [status, code] of [[424, 112], [500, 110]]) {
    const { client, count } = setup({ 'POST /iys/v1/consents': [{ status, body: err(code), headers: { 'X-Thread-Id': 'thr-1' } }] });
    await assert.rejects(client.saveConsents([RECORD]), (e) =>
      e instanceof IysApiError && e.errorCode === code && e.mayHaveBeenProcessed && !e.retryable && e.threadId === 'thr-1');
    assert.equal(count('POST /iys/v1/consents'), 1, `${status} tekrar edilmemeli`);
  }
});

test('POST /consents: 503 ve 429 artan beklemeyle tekrar edilir; Retry-After varsa ona uyulur', async () => {
  const { client, count, sleeps } = setup({ 'POST /iys/v1/consents': [
    { status: 503, body: err(141) }, { status: 429, body: err(150), headers: { 'Retry-After': '7' } }, { body: ok({ uid: 'u-2' }) },
  ] });
  assert.equal((await client.saveConsents([RECORD])).uid, 'u-2');
  assert.equal(count('POST /iys/v1/consents'), 3);
  assert.deepEqual(sleeps, [1000, 7000]);
});

test('GET /consents: 424 tekrar edilir, en fazla 3 kez; sonra retryable hata', async () => {
  const { client, count } = setup({ 'GET /iys/v1/consents': [{ status: 424, body: err(112) }] });
  await assert.rejects(client.searchConsents([{ recipient: PHONE, recipientType: 'BIREYSEL', type: 'MESAJ' }]),
    (e) => e instanceof IysApiError && e.errorCode === 112 && e.retryable && !e.mayHaveBeenProcessed);
  assert.equal(count('GET /iys/v1/consents'), 4);
});

test('422 tekrar edilmez; alan hataları data.errors ile gelir', async () => {
  const { client, count } = setup({ 'POST /iys/v1/consents': [{ status: 422, body: { success: false, errorCode: 70, message: 'Validation failed', data: { errors: { brandCode: 'required' } } } }] });
  await assert.rejects(client.saveConsents([RECORD]), (e) => e.errorCode === 70 && !e.retryable && e.data.errors.brandCode === 'required');
  assert.equal(count('POST /iys/v1/consents'), 1);
});

test('çoklu sorgu: deepObject parametreleri, + işareti %2B, parçalara bölme ve sıra korunur', async () => {
  const queries = Array.from({ length: 5 }, (_, i) => ({ recipient: `+90000000000${i}`, recipientType: 'BIREYSEL', type: 'MESAJ' }));
  const routes = { 'GET /iys/v1/consents': [] };
  const { client, calls } = setup(routes);
  // Her istekte gelen kayıtları aynı sırayla, kayıt bazlı errorCode ile geri döndür.
  routes['GET /iys/v1/consents'] = [{ body: ok([0, 1].map(i => ({ ...queries[i], status: 'ONAY', errorCode: 0 }))) },
    { body: ok([2, 3].map(i => ({ ...queries[i], status: null, errorCode: 81, message: 'Resource not found' }))) },
    { body: ok([{ ...queries[4], status: 'RET', errorCode: 0 }]) }];
  const res = await client.searchConsents(queries, { chunkSize: 2 });
  assert.deepEqual(res.map(r => r.recipient), queries.map(q => q.recipient));
  assert.deepEqual(res.map(r => [r.status, r.errorCode]), [['ONAY', 0], ['ONAY', 0], [null, 81], [null, 81], ['RET', 0]]);
  const urls = calls.filter(c => c.key === 'GET /iys/v1/consents').map(c => c.url);
  assert.equal(urls.length, 3);
  assert.equal(urls[0].searchParams.get('brandCode'), '123456');
  assert.equal(urls[0].searchParams.get('data[1][recipient]'), '+900000000001');
  assert.match(urls[0].search, /%2B900000000000/);
  assert.ok(!urls[0].search.includes('+90'), 'ham + işareti adres satırında olmamalı');
});

test('tekil sorguda 404 / 81 kayıt bazlı "kayıt yok" olarak döner', async () => {
  const { client } = setup({ 'GET /iys/v1/consents': [{ status: 404, body: err(81, 'Resource not found') }] });
  const [r] = await client.searchConsents([{ recipient: PHONE, recipientType: 'BIREYSEL', type: 'MESAJ' }]);
  assert.equal(r.errorCode, 81);
  assert.equal(r.status, null);
});

test('İYS biçiminde olmayan numara istek atılmadan reddedilir; 500 sınırı', async () => {
  const { client, calls } = setup({});
  await assert.rejects(client.saveConsents([{ ...RECORD, recipient: '900000000001' }]), TypeError);
  await assert.rejects(client.saveConsents(Array.from({ length: 501 }, () => RECORD)), RangeError);
  assert.equal(calls.length, 0);
});

test('hata mesajları şifre, token ya da alıcı içermez', async () => {
  const { client } = setup({ 'POST /iys/v1/consents': [{ status: 400, body: err(120, 'Bad request') }] });
  const e = await client.saveConsents([RECORD]).catch(x => x);
  assert.ok(e instanceof IysApiError);
  for (const secret of ['gizli-sifre', 'acc-1', TOKEN.refresh_token, PHONE]) assert.ok(!e.message.includes(secret), secret);
});

test('yardımcılar: tarih biçimi, numara çevirisi, maskeleme, parçalama', () => {
  assert.equal(formatIysDate(new Date(Date.UTC(2026, 1, 20, 13, 46, 0))), '2026-02-20 16:46:00');
  assert.equal(formatIysDate(new Date(Date.UTC(2026, 1, 20, 13, 46, 0)), 'UTC'), '2026-02-20 13:46:00');
  assert.equal(toIysRecipient('905321234567'), '+905321234567');
  assert.throws(() => toIysRecipient('05321234567'), TypeError);
  assert.equal(maskRecipient('+905321234567'), '+90532*****67');
  assert.equal(maskRecipient('ornek@example.com'), 'o***@example.com');
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('baseUrl ve brandCode zorunludur', () => {
  assert.throws(() => new IysClient({ baseUrl: '', username: 'u', password: 'p', brandCode: 1 }), /baseUrl/);
  assert.throws(() => new IysClient({ baseUrl: BASE, username: 'u', password: 'p', brandCode: 0 }), /brandCode/);
});

test('refresh beklenirken başka bir istek 401 alırsa çökmez, iki istek de yeni token ile tamamlanır', async () => {
  let t = 0;
  let tokenN = 0;
  let apiCalls = 0;
  const calls = [];
  let releaseApi;
  let releaseRefresh;
  const apiGate = new Promise((r) => { releaseApi = r; });
  const refreshGate = new Promise((r) => { releaseRefresh = r; });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const fakeFetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === '/auth/v3/token') {
      tokenN++;
      return Response.json({ ...TOKEN, access_token: `acc-${tokenN}`, expires_in: 3600 });
    }
    if (path === '/auth/v3/token/refresh') { await refreshGate; return Response.json({}, { status: 503 }); }
    apiCalls++;
    if (apiCalls === 1) { await apiGate; return Response.json(err(53, 'Token has expired'), { status: 401 }); }
    return Response.json(ok({ uid: init.headers.Authorization }));
  };
  const client = new IysClient({
    baseUrl: BASE, username: 'u', password: 'p', brandCode: 123456, fetch: fakeFetch, now: () => t, sleep: async () => {},
  });
  const first = client.saveWebhook('https://example.com/a'); // acc-1 ile gider, yanıtı bekletilir
  while (apiCalls < 1) await tick();
  t = 3600_000 - 60_000; // yenileme payının içinde
  const second = client.saveWebhook('https://example.com/b'); // refresh başlar, bekletilir
  while (!calls.includes('/auth/v3/token/refresh')) await tick();
  releaseApi(); // ilk istek 401 alır → invalidate('acc-1'), bekleyen yenilemeye katılır
  await tick();
  releaseRefresh(); // refresh 503: eski token geçersiz kılındığı için yeniden giriş
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.uid, 'Bearer acc-2');
  assert.equal(b.uid, 'Bearer acc-2');
  assert.deepEqual(calls.filter((p) => p.startsWith('/auth')), ['/auth/v3/token', '/auth/v3/token/refresh', '/auth/v3/token']);
});

test('başarısız refresh sonrası eski token 30 sn kullanılır: 10 istekte tek refresh, süre dolunca yeniden denenir', async () => {
  let t = 0;
  let refreshOk = false;
  const calls = [];
  const fakeFetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === '/auth/v3/token') return Response.json({ ...TOKEN, access_token: 'acc-1', expires_in: 3600 });
    if (path === '/auth/v3/token/refresh') {
      return refreshOk ? Response.json({ ...TOKEN, access_token: 'acc-2', expires_in: 3600 }) : Response.json({}, { status: 503 });
    }
    return Response.json(ok({ uid: init.headers.Authorization }));
  };
  const client = new IysClient({
    baseUrl: BASE, username: 'u', password: 'p', brandCode: 123456, fetch: fakeFetch, now: () => t, sleep: async () => {},
  });
  const refreshes = () => calls.filter((p) => p === '/auth/v3/token/refresh').length;
  assert.equal((await client.saveWebhook('https://example.com/h')).uid, 'Bearer acc-1');
  t = 3600_000 - 120_000; // yenileme payının (son 6 dk) içinde, token hâlâ geçerli
  for (let i = 0; i < 10; i++) assert.equal((await client.saveWebhook('https://example.com/h')).uid, 'Bearer acc-1');
  assert.equal(refreshes(), 1, 'bekleme süresinde yeniden refresh yok');
  t += 29_000;
  await client.saveWebhook('https://example.com/h');
  assert.equal(refreshes(), 1);
  t += 2_000; // 30 sn doldu
  refreshOk = true;
  assert.equal((await client.saveWebhook('https://example.com/h')).uid, 'Bearer acc-2');
  assert.equal(refreshes(), 2);
  assert.equal(calls.filter((p) => p === '/auth/v3/token').length, 1, 'yeniden giriş yok');
});

test('refresh\'te ağ hatası: eski token geçerliyse 30 sn onunla devam; süresi dolmuşsa NETWORK hatası; girişte ağ hatası retryable', async () => {
  let t = 0;
  let loginFails = false;
  const calls = [];
  const fakeFetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === '/auth/v3/token/refresh') throw new TypeError('fetch failed');
    if (path === '/auth/v3/token') {
      if (loginFails) throw new TypeError('fetch failed');
      return Response.json({ ...TOKEN, access_token: 'acc-1', expires_in: 3600 });
    }
    return Response.json(ok({ uid: init.headers.Authorization }));
  };
  const client = new IysClient({
    baseUrl: BASE, username: 'u', password: 'p', brandCode: 123456, fetch: fakeFetch, now: () => t, sleep: async () => {},
  });
  const refreshes = () => calls.filter((p) => p === '/auth/v3/token/refresh').length;
  await client.saveWebhook('https://example.com/h');
  t = 3600_000 - 120_000;
  for (let i = 0; i < 10; i++) assert.equal((await client.saveWebhook('https://example.com/h')).uid, 'Bearer acc-1');
  assert.equal(refreshes(), 1);
  t = 4000_000; // eski token'ın süresi doldu
  await assert.rejects(client.saveWebhook('https://example.com/h'),
    (e) => e instanceof IysApiError && e.errorCode === 'NETWORK' && e.retryable && !e.mayHaveBeenProcessed);
  assert.equal(calls.filter((p) => p === '/iys/v1/webhooks').length, 11, 'İYS isteği gönderilmedi');

  loginFails = true;
  const fresh = new IysClient({ baseUrl: BASE, username: 'u', password: 'p', brandCode: 123456, fetch: fakeFetch, sleep: async () => {} });
  await assert.rejects(fresh.saveWebhook('https://example.com/h'),
    (e) => e instanceof IysApiError && e.errorCode === 'NETWORK' && e.status === 0 && e.retryable);
});
