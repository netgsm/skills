import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createManualClock } from '../src/clock.mjs';
import { createSchemaValidator } from '../src/sms/schema.mjs';
import { webhookCodes, WEBHOOK_FAIL_STATUS, WEBHOOK_ERROR_CODE, WEBHOOK_OPERATOR } from '../src/webhooks.mjs';
import { smsSpec } from '../src/generated/specs.mjs';

const validator = createSchemaValidator(smsSpec);
const A = '8500000000';
const msg = (to, text = 'merhaba') => ({ recipient: to, text });

async function withServer(fn, { fetchImpl, rateScale = 100 } = {}) {
  const clock = createManualClock();
  const calls = [];
  const capture = fetchImpl ?? (async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { status: 200 };
  });
  const logs = [];
  const s = createMockServer({ port: 0, log: l => logs.push(l), clock, fetchImpl: capture, rateScale });
  try {
    const base = await s.listen();
    const tokens = {};
    const tok = async (u = A) => (tokens[u] ??= (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password001', scope: 'sms' }) })).json()).access_token);
    const call = async (method, path, { body, user = A, auth = true } = {}) => {
      const headers = { accept: 'application/json' };
      if (auth) headers.authorization = `Bearer ${await tok(user)}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(`${base}/sms/v3${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : undefined };
    };
    const inbound = (body) => fetch(`${base}/__mock/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await fn({ s, clock, call, inbound, calls, logs });
  } finally { await s.close(); }
}

test('report webhook: kayıt 201, ikinci kayıt 409', () => withServer(async ({ call }) => {
  const r = await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r', headers: 'Authorization: Bearer t' } });
  assert.equal(r.status, 201);
  assert.deepEqual(validator.validate('WebhookResponse', r.body), []);
  assert.equal(r.body.headers, 'Authorization: Bearer t');
  const again = await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ALREADY_EXISTS');
  // gelen kutusu kaydı bağımsızdır
  assert.equal((await call('POST', '/webhooks/inbox', { body: { url: 'http://127.0.0.1:9/i' } })).status, 201);
}));

test('url ve başlık kuralları', () => withServer(async ({ call }) => {
  const bad = async (body) => (await call('POST', '/webhooks/report', { body })).status;
  assert.equal(await bad({}), 400);
  assert.equal(await bad({ url: 'ftp://example.com/x' }), 400);
  assert.equal(await bad({ url: 'not a url' }), 400);
  assert.equal(await bad({ url: 'https://example.com/' + 'a'.repeat(1030) }), 400);
  assert.equal(await bad({ url: 'http://10.0.0.5/x' }), 400);
  assert.equal(await bad({ url: 'http://192.168.1.1/x' }), 400);
  assert.equal(await bad({ url: 'http://169.254.169.254/x' }), 400);
  assert.equal(await bad({ url: 'http://intranet-host/x' }), 400);
  assert.equal(await bad({ url: 'http://printer.local/x' }), 400);
  assert.equal(await bad({ url: 'https://example.com:70000/x' }), 400);
  assert.equal(await bad({ url: 'https://example.com/x', headers: 'Authorization: a,b' }), 400);
  assert.equal(await bad({ url: 'https://example.com/x', headers: 'Authorization: a:b' }), 400);
  assert.equal(await bad({ url: 'https://example.com/x', headers: 'no-colon' }), 400);
  assert.equal(await bad({ url: 'http://[::ffff:127.0.0.1]/x' }), 400);
  assert.equal(await bad({ url: 'http://[::ffff:10.0.0.1]/x' }), 400);
  assert.equal(await bad({ url: 'http://printer.local./x' }), 400);
  assert.equal(await bad({ url: 'http://foo.localhost./x' }), 400);
  assert.equal(await bad({ url: 'http://127.0.0.2/x' }), 400);
  for (const url of ['https://bad1.de/x', 'https://b2b.cafe/x', 'http://localhost./x']) {
    assert.equal((await call('POST', '/webhooks/report', { body: { url } })).status, 201, url);
    await call('DELETE', '/webhooks/report');
  }
  const ok = await call('POST', '/webhooks/report', { body: { url: 'https://example.com/x' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.headers, null);
}));

test('send + 6 sn + tick → tek POST, ReportWebhookPayload; ikinci tick göndermez', () => withServer(async ({ s, clock, call, calls }) => {
  await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r', headers: 'X-Token: abc' } });
  const sent = await call('POST', '/send', { body: { sender: 'MOCKTEST', referenceId: 'ref-9', messages: [msg('905061234567'), msg('905061234500')] } });
  assert.equal(sent.status, 202);
  await s.ctx.webhooks.tick();
  assert.equal(calls.length, 0, 'henüz PENDING');
  clock.advance(6000);
  await s.ctx.webhooks.tick();
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.url, 'http://localhost:9999/r');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.equal(c.init.headers['X-Token'], 'abc');
  assert.deepEqual(validator.validate('ReportWebhookPayload', c.body), []);
  assert.equal(c.body.numbers.length, 2);
  const byNum = Object.fromEntries(c.body.numbers.map(n => [n.number, n]));
  // Sayısal kodlar: status 1 iletildi; 2 iletilmedi, nedeni errorCode'da (116 = UNKNOWN_SUBSCRIBER).
  // operator 20 = Türk Telekom (506). failReason alanı yoktur.
  assert.equal(byNum['5061234567'].status, 1);
  assert.equal(byNum['5061234567'].operator, 20);
  assert.equal(byNum['5061234567'].errorCode, 0);
  assert.equal(byNum['5061234567'].jobid, sent.body.jobId);
  assert.equal(byNum['5061234567'].referansID, 'ref-9');
  assert.match(byNum['5061234567'].deliveredDate, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(byNum['5061234500'].status, 2);
  assert.equal(byNum['5061234500'].errorCode, 116);
  assert.equal(byNum['5061234500'].deliveredDate, '');
  for (const n of c.body.numbers) assert.ok(!('failReason' in n), 'failReason webhook gövdesinde yok');
  await s.ctx.webhooks.tick();
  assert.equal(calls.length, 1, 'aynı iletim ikinci kez gönderilmez');
}));

test('iptal edilen ve OTP görevleri raporlanmaz', () => withServer(async ({ s, clock, call, calls }) => {
  await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r' } });
  const rec = [{ index: 0, recipient: '905061234567', text: 'x' }];
  s.ctx.jobs.create({ accountId: A, kind: 'OTP', status: 'SENT', startMs: clock.now() - 6000, records: rec });
  s.ctx.jobs.create({ accountId: A, kind: 'SMS', status: 'CANCELLED', startMs: clock.now() - 6000, records: rec });
  await s.ctx.webhooks.tick();
  assert.equal(calls.length, 0);
}));

test('kayıttan önce sonuçlanan iletim, kayıttan sonra ilk tick ile bir kez gönderilir', () => withServer(async ({ s, clock, call, calls }) => {
  await call('POST', '/send', { body: { sender: 'MOCKTEST', messages: [msg('905061234567')] } });
  clock.advance(6000);
  await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r' } });
  await s.ctx.webhooks.tick();
  await s.ctx.webhooks.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.numbers[0].status, 1);
  assert.equal(calls[0].body.numbers[0].referansID, null, 'referans verilmediyse null');
}));

test('webhookCodes: GET /report adları spec tablolarındaki sayısal kodlara eşlenir', () => {
  assert.deepEqual(webhookCodes({ status: 'DELIVERED', failReason: null }), { status: 1, errorCode: 0 });
  assert.deepEqual(webhookCodes({ status: 'NOT_DELIVERED', failReason: 'OPERATOR_TIMEOUT' }), { status: 2, errorCode: 115 });
  assert.deepEqual(webhookCodes({ status: 'NOT_DELIVERED', failReason: 'BLACKLISTED' }), { status: 15, errorCode: 0 });
  assert.deepEqual(webhookCodes({ status: 'NOT_DELIVERED', failReason: 'UNKNOWN' }), { status: 2, errorCode: 0 });
  // Spec tablolarıyla birebir: satırda hem kod hem GET /report adı geçer.
  const entry = smsSpec.components.schemas.ReportWebhookEntry.properties;
  const row = (table, code, name) => table.split('\n').some(l => l.startsWith(`| \`${code}\``) && l.includes(`\`${name}\``));
  for (const [name, code] of Object.entries(WEBHOOK_FAIL_STATUS)) assert.ok(row(entry.status.description, code, name), name);
  for (const [name, code] of Object.entries(WEBHOOK_ERROR_CODE)) assert.ok(row(entry.errorCode.description, code, name), name);
  for (const [name, code] of Object.entries(WEBHOOK_OPERATOR)) {
    if (name !== 'UNKNOWN') assert.ok(entry.operator.description.split('\n').some(l => l.includes(`\`${code}\``) && l.includes(`\`${name}\``)), name);
  }
});

test('kullanıcı başlığı Content-Type ve X-Correlation-Id değerlerini ezemez', () => withServer(async ({ call, inbound, calls }) => {
  await call('POST', '/webhooks/inbox', { body: { url: 'http://localhost:9999/i', headers: 'content-type: text/plain' } });
  await inbound({ username: A, from: '905321234567', text: 'x' });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['content-type'], undefined);
  await call('DELETE', '/webhooks/inbox');
  await call('POST', '/webhooks/inbox', { body: { url: 'http://localhost:9999/i', headers: 'X-CORRELATION-ID: fixed' } });
  await inbound({ username: A, from: '905321234567', text: 'y' });
  assert.match(calls[1].init.headers['X-Correlation-Id'], /^[0-9a-f-]{36}$/);
  assert.equal(calls[1].init.headers['X-CORRELATION-ID'], undefined);
}));

test('başarısız teslim kaydedilir, tekrarlanmaz ve tick çökmez', async () => {
  let n = 0;
  await withServer(async ({ s, clock, call, logs }) => {
    await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r' } });
    await call('POST', '/send', { body: { sender: 'MOCKTEST', messages: [msg('905061234567')] } });
    clock.advance(6000);
    await s.ctx.webhooks.tick();
    await s.ctx.webhooks.tick();
    assert.equal(n, 1);
    assert.ok(logs.some(l => l.includes('webhook delivery failed')));
  }, { fetchImpl: async () => { n++; throw new Error('boom'); } });
});

test('inbox webhook: /__mock/inbound → InboxWebhookPayload POST', () => withServer(async ({ call, inbound, calls }) => {
  await call('POST', '/webhooks/inbox', { body: { url: 'http://localhost:9999/i', headers: 'X-Key: k1' } });
  const r = await inbound({ username: A, from: '905321234567', text: 'Merhaba' });
  assert.equal(r.status, 201);
  assert.equal(calls.length, 1);
  const { init, body } = calls[0];
  assert.deepEqual(validator.validate('InboxWebhookPayload', body), []);
  assert.equal(body.sourceNumber, '5321234567');
  assert.equal(body.content, 'Merhaba');
  assert.equal(body.subscriberNumber, A);
  assert.match(body.messageDateTime, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(init.headers['X-Correlation-Id'], /^[0-9a-f-]{36}$/);
  assert.equal(init.headers['X-Key'], 'k1');
}));

test('DELETE sonrası tekrar DELETE → 404; silinen webhook artık tetiklenmez', () => withServer(async ({ call, inbound, calls }) => {
  for (const kind of ['report', 'inbox']) {
    assert.equal((await call('DELETE', `/webhooks/${kind}`)).status, 404);
    await call('POST', `/webhooks/${kind}`, { body: { url: 'http://localhost:9999/x' } });
    assert.equal((await call('DELETE', `/webhooks/${kind}`)).status, 204);
    const again = await call('DELETE', `/webhooks/${kind}`);
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'NOT_FOUND');
  }
  await inbound({ username: A, from: '905321234567', text: 'x' });
  assert.equal(calls.length, 0);
}));

test('token yok → 401; hesap başına 10 çağrıdan sonra 429', () => withServer(async ({ call }) => {
  assert.equal((await call('DELETE', '/webhooks/report', { auth: false })).status, 401);
  for (let i = 0; i < 10; i++) await call('DELETE', '/webhooks/report');
  const r = await call('DELETE', '/webhooks/inbox');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RATE_LIMITED');
}, { rateScale: 1 }));

test('1.200 kayıtlı görev: ≤500 kayıtlık 3 POST, aynı anda en fazla 2 istek, sonraki tick yeniden göndermez', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const batches = [];
  const fetchImpl = async (url, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 20));
    batches.push(JSON.parse(init.body).numbers.length);
    inFlight--;
    return { status: 200 };
  };
  await withServer(async ({ s, clock, call }) => {
    await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r' } });
    const records = Array.from({ length: 1200 }, (_, i) => ({ index: i, recipient: `90506${String(1000000 + i).padStart(7, '0')}`, text: 'x' }));
    s.ctx.jobs.create({ accountId: A, kind: 'SMS', status: 'QUEUED', startMs: clock.now() - 6000, records });
    // üst üste binen iki tick de sınırı aşmaz ve aynı kaydı iki kez göndermez
    await Promise.all([s.ctx.webhooks.tick(), s.ctx.webhooks.tick()]);
    assert.deepEqual(batches.slice().sort((a, b) => b - a), [500, 500, 200]);
    assert.ok(maxInFlight <= 2, `aynı anda ${maxInFlight} istek`);
    assert.ok(maxInFlight >= 1);
    await s.ctx.webhooks.tick();
    assert.equal(batches.length, 3, 'tamamı raporlanan görev yeniden gönderilmez');
    const st = s.ctx.webhooks.stats();
    assert.equal(st.sentKeys, 0, 'tamamen raporlanan görevin kayıt anahtarları bırakılır');
    assert.equal(st.reportedJobs, 1);
  }, { fetchImpl });
});

test('kısmen sonuçlanan görev: sonuçlananlar bir kez gönderilir, kalanlar sonuçlanınca gönderilir', () => withServer(async ({ s, clock, call, calls }) => {
  await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r' } });
  const rec = (i) => ({ index: i, recipient: `9050612345${String(10 + i)}`, text: 'x' });
  s.ctx.jobs.create({ accountId: A, kind: 'SMS', status: 'QUEUED', startMs: clock.now() - 6000, records: [rec(0), rec(1)] });
  s.ctx.jobs.create({ accountId: A, kind: 'SMS', status: 'QUEUED', startMs: clock.now() + 60_000, records: [rec(2)] });
  await s.ctx.webhooks.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.numbers.length, 2);
  assert.equal(s.ctx.webhooks.stats().reportedJobs, 1);
  clock.advance(70_000);
  await s.ctx.webhooks.tick();
  await s.ctx.webhooks.tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.numbers.map(n => n.number), ['5061234512']);
  assert.equal(s.ctx.webhooks.stats().reportedJobs, 2);
}));

test('webhook istekleri yönlendirmeyi izlemez (redirect: manual)', () => withServer(async ({ s, clock, call, inbound, calls }) => {
  await call('POST', '/webhooks/report', { body: { url: 'http://localhost:9999/r' } });
  await call('POST', '/webhooks/inbox', { body: { url: 'http://localhost:9999/i' } });
  await call('POST', '/send', { body: { sender: 'MOCKTEST', messages: [msg('905061234567')] } });
  clock.advance(6000);
  await s.ctx.webhooks.tick();
  await inbound({ username: A, from: '905321234567', text: 'x' });
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.init.redirect, 'manual', c.url);
}));

test('loopback dışı --host: loopback webhook adresi gerçek API gibi reddedilir ve uyarı yazılır', async () => {
  const logs = [];
  const s = createMockServer({ port: 0, host: '0.0.0.0', log: l => logs.push(l), clock: createManualClock(), fetchImpl: async () => ({ status: 200 }) });
  try {
    const base = (await s.listen()).replace('0.0.0.0', '127.0.0.1');
    assert.ok(logs.some(l => /Uyarı/.test(l) && l.includes('0.0.0.0')), logs.join('\n'));
    const t = (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: A, password: 'password001', scope: 'sms' }) })).json()).access_token;
    for (const url of ['http://localhost:9/r', 'http://127.0.0.1:9/r', 'http://[::1]:9/r']) {
      const r = await fetch(`${base}/sms/v3/webhooks/report`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ url }) });
      assert.equal(r.status, 400, url);
    }
  } finally { await s.close(); }
});

test('loopback --host: uyarı yazılmaz; IPv6 adresi köşeli parantezle döner', async () => {
  const logs = [];
  const s = createMockServer({ port: 0, host: '::1', log: l => logs.push(l), clock: createManualClock() });
  try {
    const base = await s.listen();
    assert.match(base, /^http:\/\/\[::1\]:\d+$/);
    assert.ok(!logs.some(l => /Uyarı/.test(l)));
    assert.equal((await fetch(`${base}/__mock/advice`)).status, 200);
  } finally { await s.close(); }
});
