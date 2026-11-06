import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createManualClock } from '../src/clock.mjs';
import { createScenarioQueue } from '../src/scenarios.mjs';

const A = '8500000000';

async function withServer(fn, opts = {}) {
  const clock = createManualClock();
  const s = createMockServer({ port: 0, log: () => {}, clock, ...opts });
  try {
    const base = await s.listen();
    const tok = async () => (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: A, password: 'password001', scope: 'sms' }) })).json()).access_token;
    const raw = async (method, path, { body, token } = {}) => {
      const headers = { accept: 'application/json' };
      if (token !== null && token !== undefined) headers.authorization = `Bearer ${token}`;
      // kontrol uçlarına POST her zaman JSON olarak gönderilir (gövdesiz reset dahil)
      if (body !== undefined || (method === 'POST' && path.startsWith('/__mock/'))) headers['content-type'] = 'application/json';
      const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
    };
    const token = await tok();
    const call = (method, path, body) => raw(method, `/sms/v3${path}`, { body, token });
    const send = () => call('POST', '/send', { sender: 'MOCKTEST', messages: [{ text: 'Merhaba', recipient: '905061234567' }] });
    const push = (sc) => raw('POST', '/__mock/scenario', { body: sc });
    return await fn({ s, clock, base, raw, call, send, push, token, tok });
  } finally { await s.close(); }
}

const hourAround = (clock) => {
  const now = clock.now();
  return `startAt=${encodeURIComponent(new Date(now - 3_600_000).toISOString())}&stopAt=${encodeURIComponent(new Date(now + 3_600_000).toISOString())}`;
};

test('QUEUE_UNCONFIRMED /send: görev oluşur, yanıt 503 SERVICE_UNAVAILABLE (504 yok), raporda görülür, sonraki istek normal', () => withServer(async ({ send, push, call, clock }) => {
  assert.equal((await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send' })).status, 201);
  const first = await send();
  assert.equal(first.status, 503);
  assert.equal(first.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(first.body.message, 'the send could not be confirmed; it may or may not have been queued');
  const rep = await call('GET', `/report?${hourAround(clock)}`);
  assert.equal(rep.status, 200);
  assert.equal(rep.body.reports.length, 1);
  assert.equal(rep.body.reports[0].number, '5061234567');
  assert.equal((await send()).status, 202);
}));

test('QUEUE_UNCONFIRMED /send/template: görev oluşur, yanıt 503', () => withServer(async ({ call, push, s }) => {
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send/template' });
  const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [{ templateId: 4, recipient: '905061234567' }] });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'SERVICE_UNAVAILABLE');
  assert.deepEqual(s.ctx.jobs.all(A).map(j => j.kind), ['TEMPLATE']);
}));

test('QUEUE_UNCONFIRMED /directory/send: görev oluşur, yanıt 504 QUEUE_UNCONFIRMED', () => withServer(async ({ call, push, s }) => {
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/directory/send' });
  const body = { sender: 'MOCKTEST', text: 'Merhaba', groupIds: [7] };
  const r = await call('POST', '/directory/send', body);
  assert.equal(r.status, 504);
  assert.equal(r.body.code, 'QUEUE_UNCONFIRMED');
  assert.deepEqual(s.ctx.jobs.all(A).map(j => j.kind), ['DIRECTORY']);
  assert.equal((await call('POST', '/directory/send', body)).status, 202);
}));

test('QUEUE_UNCONFIRMED /send/otp: 503 SERVICE_UNAVAILABLE, hiçbir şey gönderilmez', () => withServer(async ({ call, push, s }) => {
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send/otp' });
  const r = await call('POST', '/send/otp', { sender: 'MOCKTEST', recipient: '905061234567', text: '1234' });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(s.ctx.jobs.all(A).length, 0);
}));

test('SERVICE_UNAVAILABLE gönderim uçlarında hiçbir şey kuyruğa almaz', () => withServer(async ({ call, push, s }) => {
  const cases = [
    ['/send', { sender: 'MOCKTEST', messages: [{ text: 'a', recipient: '905061234567' }] }],
    ['/send/template', { sender: 'MOCKTEST', templates: [{ templateId: 4, recipient: '905061234567' }] }],
    ['/directory/send', { sender: 'MOCKTEST', text: 'Merhaba', groupIds: [7] }],
    ['/send/otp', { sender: 'MOCKTEST', recipient: '905061234567', text: '1234' }],
  ];
  for (const [path, body] of cases) {
    await push({ code: 'SERVICE_UNAVAILABLE', path: `/sms/v3${path}` });
    const r = await call('POST', path, body);
    assert.equal(r.status, 503, path);
    assert.equal(r.body.message, 'service is temporarily unavailable', path);
  }
  assert.equal(s.ctx.jobs.all(A).length, 0);
}));

test('QUEUE_UNCONFIRMED /cancel: 504, yan etkisiz', () => withServer(async ({ call, push, clock, s }) => {
  const later = new Date(clock.now() + 3_600_000).toISOString();
  const sent = await call('POST', '/send', { sender: 'MOCKTEST', startAt: later, messages: [{ text: 'a', recipient: '905061234567' }] });
  assert.equal(sent.body.status, 'SCHEDULED');
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/cancel' });
  const r = await call('POST', '/cancel', { jobId: sent.body.jobId });
  assert.equal(r.status, 504);
  assert.equal(r.body.code, 'QUEUE_UNCONFIRMED');
  assert.equal(s.ctx.jobs.get(A, sent.body.jobId).status, 'SCHEDULED');
}));

test('E_SIGNATURE_REQUIRED senaryosu: 403 ve spec mesajı', () => withServer(async ({ call, push, s }) => {
  assert.equal((await push({ code: 'E_SIGNATURE_REQUIRED', path: '/sms/v3/directory/send' })).status, 201);
  const r = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'Merhaba', groupIds: [7] });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'E_SIGNATURE_REQUIRED');
  assert.equal(r.body.message, 'the requested menu requires an e-signature login on the account');
  assert.equal(s.ctx.jobs.all(A).length, 0);
}));

test('QUEUE_UNCONFIRMED: gönderim dışı yolda yan etkisiz 504', () => withServer(async ({ call, push, s }) => {
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/templates' });
  const r = await call('GET', '/templates');
  assert.equal(r.status, 504);
  assert.equal(r.body.code, 'QUEUE_UNCONFIRMED');
  assert.equal(s.ctx.jobs.all(A).length, 0);
}));

test('times: 2 → iki istek etkilenir', () => withServer(async ({ send, push }) => {
  await push({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/send', times: 2 });
  const r1 = await send();
  assert.equal(r1.status, 503);
  assert.equal(r1.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal((await send()).status, 503);
  assert.equal((await send()).status, 202);
}));

test('path verilmezse ilk /sms/v3 isteği etkilenir', () => withServer(async ({ call, push }) => {
  await push({ code: 'INTERNAL_ERROR' });
  const r1 = await call('GET', '/templates');
  assert.equal(r1.status, 500);
  assert.equal(r1.body.code, 'INTERNAL_ERROR');
  assert.equal((await call('GET', '/templates')).status, 200);
}));

test('path başka bir yol ise etkilenmez', () => withServer(async ({ call, push }) => {
  await push({ code: 'INTERNAL_ERROR', path: '/sms/v3/send' });
  assert.equal((await call('GET', '/templates')).status, 200);
}));

test('kimlik doğrulaması senaryodan önce gelir: kötü token 401, senaryo tüketilmez', () => withServer(async ({ raw, push, send }) => {
  await push({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/send' });
  const r = await raw('POST', '/sms/v3/send', { token: 'bad-token', body: { sender: 'MOCKTEST', messages: [] } });
  assert.equal(r.status, 401);
  assert.equal((await send()).status, 503);
}));

test('SENDING_SUSPENDED: 429 ve Retry-After başlığı yok', () => withServer(async ({ send, push }) => {
  await push({ code: 'SENDING_SUSPENDED', path: '/sms/v3/send' });
  const r = await send();
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RATE_LIMITED');
  assert.equal(r.body.message, 'sending is suspended for this account');
  assert.equal(r.headers.get('retry-after'), null);
}));

test('RATE_LIMITED retryAfter: 1 → Retry-After: 1; varsayılan 30', () => withServer(async ({ send, push }) => {
  await push({ code: 'RATE_LIMITED', path: '/sms/v3/send', retryAfter: 1 });
  const r = await send();
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RATE_LIMITED');
  assert.equal(r.headers.get('retry-after'), '1');
  await push({ code: 'RATE_LIMITED', path: '/sms/v3/send' });
  assert.equal((await send()).headers.get('retry-after'), '30');
}));

test('422 ve 403 kodları', () => withServer(async ({ send, push }) => {
  for (const [code, status] of [['INSUFFICIENT_CREDIT', 422], ['REJECTED_HEADER', 422], ['REJECTED_IYS', 422], ['FORBIDDEN', 403]]) {
    await push({ code, path: '/sms/v3/send' });
    const r = await send();
    assert.equal(r.status, status, code);
    assert.equal(r.body.code, code);
    assert.equal(typeof r.body.requestId, 'string');
  }
}));

test('identity service_unavailable: /auth/v3/token → 503 problem+json', () => withServer(async ({ raw, push }) => {
  assert.equal((await push({ code: 'service_unavailable' })).status, 201);
  const cred = { body: { username: A, password: 'password001', scope: 'sms' } };
  const r = await raw('POST', '/auth/v3/token', cred);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('content-type'), 'application/problem+json');
  assert.equal(r.body.code, 'service_unavailable');
  assert.equal((await raw('POST', '/auth/v3/token', cred)).status, 200);
}));

test('identity rate_limited retryAfter, too_many_failed_attempts, 502, 500', () => withServer(async ({ raw, push }) => {
  await push({ code: 'rate_limited', path: '/auth/v3/token', retryAfter: 7 });
  const r = await raw('POST', '/auth/v3/token', { body: {} });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '7');
  await push({ code: 'too_many_failed_attempts' });
  assert.equal((await raw('POST', '/auth/v3/token', { body: {} })).status, 429);
  await push({ code: 'service_misconfigured' });
  assert.equal((await raw('POST', '/auth/v3/token', { body: {} })).status, 502);
  await push({ code: 'internal_error' });
  assert.equal((await raw('POST', '/auth/v3/token', { body: {} })).status, 500);
}));

test('SMS kodu /auth/v3 yoluyla (ve tersi) kuyruğa alınamaz: 400', () => withServer(async ({ push }) => {
  const a = await push({ code: 'SERVICE_UNAVAILABLE', path: '/auth/v3/token' });
  assert.equal(a.status, 400);
  assert.match(a.body.error, /\/sms\/v3/);
  const b = await push({ code: 'service_unavailable', path: '/sms/v3/send' });
  assert.equal(b.status, 400);
  assert.match(b.body.error, /\/auth\/v3/);
}));

test('bilinmeyen kod → 400 ve desteklenen kodlar listesi', () => withServer(async ({ push }) => {
  const r = await push({ code: 'NOPE' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /SERVICE_UNAVAILABLE/);
  assert.match(r.body.error, /too_many_failed_attempts/);
  assert.equal((await push({ code: 'FORBIDDEN', times: 0 })).status, 400);
  assert.equal((await push({ code: 'FORBIDDEN', times: 'x' })).status, 400);
}));

test('GET listeler, DELETE temizler', () => withServer(async ({ raw, push, send }) => {
  await push({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/send', times: 3 });
  const l = await raw('GET', '/__mock/scenario');
  assert.equal(l.status, 200);
  assert.deepEqual(l.body.scenarios.map(x => [x.code, x.times]), [['SERVICE_UNAVAILABLE', 3]]);
  assert.equal((await raw('DELETE', '/__mock/scenario')).status, 204);
  assert.deepEqual((await raw('GET', '/__mock/scenario')).body.scenarios, []);
  assert.equal((await send()).status, 202);
}));

test('createScenarioQueue: take sırayla tüketir', () => {
  const q = createScenarioQueue();
  q.push({ code: 'INTERNAL_ERROR', times: 2 });
  assert.equal(q.take('/sms/v3/x').code, 'INTERNAL_ERROR');
  assert.equal(q.list()[0].times, 1);
  assert.equal(q.take('/auth/v3/token'), null);
  q.take('/sms/v3/x');
  assert.equal(q.take('/sms/v3/x'), null);
  q.push({ code: 'FORBIDDEN' });
  q.clear();
  assert.deepEqual(q.list(), []);
});

test('reset sonrası eski token 401', () => withServer(async ({ raw, call, push }) => {
  assert.equal((await call('GET', '/templates')).status, 200);
  await push({ code: 'SERVICE_UNAVAILABLE' });
  assert.equal((await raw('POST', '/__mock/reset')).status, 200);
  assert.equal((await call('GET', '/templates')).status, 401);
  assert.deepEqual((await raw('GET', '/__mock/scenario')).body.scenarios, []);
}));

test('reset: tükenmiş sınırlayıcı sonra istek kabul eder; görevler, gelen kutusu, webhook sıfırlanır', () => withServer(async ({ raw, s, tok, token }) => {
  // liste sınırı 20/dk; rateScale 0.15 ile 3'e iner
  const hits = [];
  for (let i = 0; i < 4; i++) hits.push((await raw('GET', '/sms/v3/templates', { token })).status);
  assert.deepEqual(hits, [200, 200, 200, 429]);
  s.ctx.jobs.create({ accountId: A, kind: 'SEND', status: 'QUEUED', startMs: 0, stopMs: 1, sender: 'MOCKTEST', records: [], referenceId: null });
  s.ctx.inbox.add(A, { from: '905061234567', text: 'x' });
  s.ctx.webhooks.register(A, 'report', 'https://example.org/h');
  assert.equal((await raw('POST', '/__mock/reset')).status, 200);
  assert.equal(s.ctx.jobs.all(A).length, 0);
  assert.equal(s.ctx.inbox.all(A).length, 0);
  assert.equal(s.ctx.webhooks.has(A, 'report'), false);
  assert.equal((await raw('GET', '/sms/v3/templates', { token: await tok() })).status, 200);
}, { rateScale: 0.15 }));

test('reset: saat ofseti sıfırlanır; gelen SMS yeniden bağlanan dispatcher ile eklenir', () => withServer(async ({ raw, s }) => {
  s.ctx.clock.advance(3_600_000);
  const t0 = s.ctx.clock.now();
  await raw('POST', '/__mock/reset');
  assert.equal(s.ctx.clock.now(), t0 - 3_600_000);
  const hooked = [];
  s.ctx.webhooks.onInbound = (id, m) => { hooked.push([id, m.text]); return Promise.resolve(); };
  const r = await raw('POST', '/__mock/inbound', { body: { username: A, from: '905061234567', text: 'hi' } });
  assert.equal(r.status, 201);
  assert.deepEqual(hooked, [[A, 'hi']]);
}));

test('POST /__mock/clock: advanceSeconds ilerletir; geçersiz değer 400', () => withServer(async ({ raw, s }) => {
  const t0 = s.ctx.clock.now();
  const r = await raw('POST', '/__mock/clock', { body: { advanceSeconds: 90 } });
  assert.equal(r.status, 200);
  assert.equal(s.ctx.clock.now() - t0, 90_000);
  for (const bad of [0, -5, '10', null, undefined]) {
    assert.equal((await raw('POST', '/__mock/clock', { body: { advanceSeconds: bad } })).status, 400, String(bad));
  }
  assert.equal((await raw('POST', '/__mock/clock', { body: [] })).status, 400);
}));

test('kontrol uçları kimlik doğrulaması istemez ve düz JSON zarfı kullanır', () => withServer(async ({ raw }) => {
  const r = await raw('GET', '/__mock/scenario', { token: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-request-id'), null);
}));

test('QUEUE_UNCONFIRMED yalnızca görev oluşunca tüketilir: önce 422, sonra 503 ve rapor kaydı', () => withServer(async ({ call, push, clock }) => {
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send' });
  const bad = await call('POST', '/send', { sender: 'NOSUCHHDR', messages: [{ text: 'a', recipient: '905061234567' }] });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'REJECTED_HEADER');
  const ok = await call('POST', '/send', { sender: 'MOCKTEST', messages: [{ text: 'a', recipient: '905061234567' }] });
  assert.equal(ok.status, 503);
  assert.equal((await call('GET', `/report?${hourAround(clock)}`)).body.reports.length, 1);
  assert.equal((await call('POST', '/send', { sender: 'MOCKTEST', messages: [{ text: 'b', recipient: '905061234568' }] })).status, 202);
}));

test('reset: /stats ve /report işaretleyicileri temizlenir', () => withServer(async ({ call, raw, tok }) => {
  assert.equal((await call('GET', '/stats?jobId=123')).status, 404);
  assert.equal((await call('GET', '/stats?jobId=123')).status, 429);
  await raw('POST', '/__mock/reset');
  const token = await tok();
  assert.equal((await raw('GET', '/sms/v3/stats?jobId=123', { token })).status, 404);
}));

test('login_not_permitted senaryosu: sıradaki /token 403 access_denied', () => withServer(async ({ push, base }) => {
  assert.equal((await push({ code: 'login_not_permitted' })).status, 201);
  const r = await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: A, password: 'password001', scope: 'sms' }) });
  assert.equal(r.status, 403);
  const b = await r.json();
  assert.equal(b.code, 'login_not_permitted');
  assert.equal(b.error, 'access_denied');
}));

test('kontrol POST uçları Content-Type: application/json ister (yoksa 415); gövdesiz JSON reset kabul edilir', () => withServer(async ({ base }) => {
  const post = (path, headers, body) => fetch(`${base}${path}`, { method: 'POST', headers, body });
  for (const path of ['/__mock/reset', '/__mock/scenario', '/__mock/clock', '/__mock/inbound']) {
    assert.equal((await post(path, {}, undefined)).status, 415, `${path} başlıksız`);
    assert.equal((await post(path, { 'content-type': 'text/plain' }, '{}')).status, 415, `${path} text/plain`);
    assert.equal((await post(path, { 'content-type': 'application/x-www-form-urlencoded' }, 'a=b')).status, 415, `${path} form`);
  }
  assert.equal((await post('/__mock/reset', { 'content-type': 'application/json' }, undefined)).status, 200);
  assert.equal((await post('/__mock/reset', { 'content-type': 'application/json' }, '{}')).status, 200);
  assert.equal((await post('/__mock/clock', { 'content-type': 'application/json' }, JSON.stringify({ advanceSeconds: 5 }))).status, 200);
}));
