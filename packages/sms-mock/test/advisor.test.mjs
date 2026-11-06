import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createManualClock } from '../src/clock.mjs';
import { createAdvisor } from '../src/advisor.mjs';
import { explain } from '../src/explain.mjs';
import { smsSpec, identitySpec } from '../src/generated/specs.mjs';

const A = '8500000000';

async function withServer(fn, opts = {}) {
  const clock = createManualClock();
  const lines = [];
  const s = createMockServer({ port: 0, log: l => lines.push(l), clock, ...opts });
  try {
    const base = await s.listen();
    const raw = async (method, path, { body, token } = {}) => {
      const headers = { accept: 'application/json' };
      if (token !== null && token !== undefined) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
    };
    const tok = async () => (await raw('POST', '/auth/v3/token', { body: { username: A, password: 'password001', scope: 'sms' } })).body.access_token;
    const token = await tok();
    const call = (method, path, body, t = token) => raw(method, `/sms/v3${path}`, { body, token: t });
    const send = (n = 1, extra = {}) => call('POST', '/send', {
      sender: 'MOCKTEST', messages: Array.from({ length: n }, (_, i) => ({ text: 'Merhaba', recipient: `90506123${String(4567 + i).padStart(4, '0')}` })), ...extra,
    });
    const push = (sc) => raw('POST', '/__mock/scenario', { body: sc });
    const advice = async () => (await raw('GET', '/__mock/advice')).body.findings;
    return await fn({ s, clock, base, raw, call, send, push, token, tok, advice, lines });
  } finally { await s.close(); }
}

const rules = (findings) => findings.map(f => f.rule);

test('SINGLE_RECIPIENT_BURST: 10 sn içinde 5 tek kayıtlı send, bulgu bir kez', () => withServer(async ({ send, advice, clock }) => {
  for (let i = 0; i < 4; i++) await send(1);
  assert.deepEqual(rules(await advice()), []);
  await send(1);
  let f = await advice();
  assert.deepEqual(rules(f), ['SINGLE_RECIPIENT_BURST']);
  assert.equal(f[0].severity, 'warn');
  assert.match(f[0].message, /toplu|messages|tek istek/i);
  await send(1); await send(1);
  assert.equal((await advice()).length, 1, 'aynı kural 60 sn içinde yeniden bulgu üretmez');
  clock.advance(61_000);
  for (let i = 0; i < 5; i++) await send(1);
  assert.equal((await advice()).length, 2, '60 sn sonra yeniden üretilebilir');
}));

test('SINGLE_RECIPIENT_BURST: seyrek gönderim ya da çok kayıtlı gönderim bulgu üretmez', () => withServer(async ({ send, advice, clock }) => {
  for (let i = 0; i < 6; i++) { await send(1); clock.advance(3_000); }
  for (let i = 0; i < 6; i++) await send(2);
  assert.deepEqual(rules(await advice()), []);
}));

test('TOKEN_CHURN: 60 sn içinde aynı kullanıcı için 3 başarılı token', () => withServer(async ({ tok, advice }) => {
  // withServer zaten bir token aldı
  await tok();
  assert.deepEqual(rules(await advice()), []);
  await tok();
  const f = await advice();
  assert.deepEqual(rules(f), ['TOKEN_CHURN']);
  assert.match(f[0].message, /önbellekte tutun/);
  await tok();
  assert.equal((await advice()).length, 1);
}));

test('RETRY_AFTER_QUEUE_UNCONFIRMED: /send kuyruğa alınmış 503 sonrası aynı gövde warn', () => withServer(async ({ send, push, advice }) => {
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send' });
  const first = await send(2);
  assert.equal(first.status, 503);
  assert.equal(first.body.code, 'SERVICE_UNAVAILABLE');
  assert.deepEqual(rules(await advice()), []);
  assert.equal((await send(2)).status, 202);
  const f = await advice();
  assert.deepEqual(rules(f), ['RETRY_AFTER_QUEUE_UNCONFIRMED']);
  assert.equal(f[0].severity, 'warn');
  assert.match(f[0].message, /GET \/report/);
  assert.match(f[0].message, /çift/);
  assert.doesNotMatch(f[0].message, /504/);
}));

test('RETRY_AFTER_QUEUE_UNCONFIRMED: /send/template kuyruğa alınmış 503 sonrası aynı gövde warn', () => withServer(async ({ call, push, advice }) => {
  const body = { sender: 'MOCKTEST', templates: [{ templateId: 4, recipient: '905061234567' }] };
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send/template' });
  assert.equal((await call('POST', '/send/template', body)).status, 503);
  assert.equal((await call('POST', '/send/template', body)).status, 202);
  const f = await advice();
  assert.deepEqual(rules(f), ['RETRY_AFTER_QUEUE_UNCONFIRMED']);
  assert.equal(f[0].severity, 'warn');
}));

test('RETRY_AFTER_QUEUE_UNCONFIRMED: /directory/send 504 ve 503 sonrası aynı gövde error', () => withServer(async ({ call, push, advice, clock }) => {
  const body = { sender: 'MOCKTEST', text: 'Merhaba', groupIds: [7] };
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/directory/send' });
  assert.equal((await call('POST', '/directory/send', body)).status, 504);
  assert.equal((await call('POST', '/directory/send', body)).status, 202);
  let f = await advice();
  assert.deepEqual(rules(f), ['RETRY_AFTER_QUEUE_UNCONFIRMED']);
  assert.equal(f[0].severity, 'error');
  assert.match(f[0].message, /GET \/report ile kontrol etmelisiniz/);
  clock.advance(61_000);
  const other = { ...body, text: 'Merhaba 2' };
  await push({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/directory/send' });
  assert.equal((await call('POST', '/directory/send', other)).status, 503);
  assert.equal((await call('POST', '/directory/send', other)).status, 202);
  f = await advice();
  assert.deepEqual(rules(f), ['RETRY_AFTER_QUEUE_UNCONFIRMED', 'RETRY_AFTER_QUEUE_UNCONFIRMED']);
  assert.equal(f[1].severity, 'error');
  assert.match(f[1].message, /503 SERVICE_UNAVAILABLE/);
}));

test('RETRY_AFTER_QUEUE_UNCONFIRMED: arada GET /report yapılırsa bulgu yok', () => withServer(async ({ send, push, call, advice }) => {
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send' });
  assert.equal((await send(2)).status, 503);
  assert.equal((await call('GET', '/report')).status, 200);
  assert.equal((await send(2)).status, 202);
  assert.deepEqual(rules(await advice()), []);
}));

test('RETRY_AFTER_QUEUE_UNCONFIRMED: hiçbir şey kuyruğa alınmayan 503 (SERVICE_UNAVAILABLE /send, /send/otp) sonrası tekrar bulgu üretmez', () => withServer(async ({ send, push, call, advice }) => {
  await push({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/send' });
  assert.equal((await send(2)).status, 503);
  assert.equal((await send(2)).status, 202);
  const otp = { sender: 'MOCKTEST', text: 'kod 1234', recipient: '905061234567' };
  for (const code of ['QUEUE_UNCONFIRMED', 'SERVICE_UNAVAILABLE']) {
    await push({ code, path: '/sms/v3/send/otp' });
    assert.equal((await call('POST', '/send/otp', otp)).status, 503, code);
    assert.equal((await call('POST', '/send/otp', otp)).status, 202, code);
  }
  assert.deepEqual(rules(await advice()), []);
}));

test('RETRY_AFTER_QUEUE_UNCONFIRMED: farklı gövde bulgu üretmez', () => withServer(async ({ send, push, advice }) => {
  await push({ code: 'QUEUE_UNCONFIRMED', path: '/sms/v3/send' });
  await send(2);
  await send(3);
  assert.deepEqual(rules(await advice()), []);
}));

test('RETRY_NON_RETRYABLE: gövde kaynaklı 400 aynı gövdeyle tekrar gönderilince warn, bir kez', () => withServer(async ({ call, advice }) => {
  assert.equal((await call('POST', '/send', { messages: 'x' })).status, 400);
  assert.deepEqual(rules(await advice()), []);
  assert.equal((await call('POST', '/send', { messages: 'x' })).status, 400);
  const f = await advice();
  assert.deepEqual(rules(f), ['RETRY_NON_RETRYABLE']);
  assert.equal(f[0].severity, 'warn');
  await call('POST', '/send', { messages: 'x' });
  assert.equal((await advice()).length, 1);
}));

test('RETRY_NON_RETRYABLE: NO_DELIVERABLE_MESSAGES (tüm kayıtlar geçersiz) tekrarında warn', () => withServer(async ({ call, advice }) => {
  const body = { sender: 'MOCKTEST', messages: [{ text: 'a', recipient: 'abc' }] };
  assert.equal((await call('POST', '/send', body)).status, 422);
  assert.equal((await call('POST', '/send', body)).status, 422);
  assert.deepEqual(rules(await advice()), ['RETRY_NON_RETRYABLE']);
}));

test('RETRY_NON_RETRYABLE: dışarıda düzeltilebilen hatalar (REJECTED_HEADER, INSUFFICIENT_CREDIT) sonrası aynı gövde bulgu üretmez', () => withServer(async ({ send, advice, raw }) => {
  assert.equal((await send(1, { sender: 'YOKBASLIK' })).status, 422);
  assert.equal((await send(1, { sender: 'YOKBASLIK' })).status, 422);
  await raw('POST', '/__mock/scenario', { body: { code: 'INSUFFICIENT_CREDIT', path: '/sms/v3/send', times: 2 } });
  assert.equal((await send(2)).status, 422);
  assert.equal((await send(2)).status, 422);
  assert.deepEqual(rules(await advice()), []);
}));

test('RETRY_NON_RETRYABLE: 60 sn sonra tekrar gelen gövde bulgu üretmez', () => withServer(async ({ call, advice, clock }) => {
  await call('POST', '/send', { messages: 'x' });
  clock.advance(61_000);
  await call('POST', '/send', { messages: 'x' });
  assert.deepEqual(rules(await advice()), []);
}));
test('IGNORED_RETRY_AFTER: Retry-After dolmadan aynı yola istek', () => withServer(async ({ send, push, advice, clock }) => {
  await push({ code: 'RATE_LIMITED', path: '/sms/v3/send', retryAfter: 30, times: 2 });
  const first = await send(2);
  assert.equal(first.status, 429);
  assert.equal(first.headers.get('retry-after'), '30');
  assert.deepEqual(rules(await advice()), []);
  clock.advance(5_000);
  assert.equal((await send(3)).status, 429);
  const f = await advice();
  assert.deepEqual(rules(f), ['IGNORED_RETRY_AFTER']);
  assert.match(f[0].message, /Retry-After/);
}));

test('IGNORED_RETRY_AFTER: süre dolduktan sonra gelen istek bulgu üretmez', () => withServer(async ({ send, push, advice, clock }) => {
  await push({ code: 'RATE_LIMITED', path: '/sms/v3/send', retryAfter: 30 });
  assert.equal((await send(2)).status, 429);
  clock.advance(31_000);
  assert.equal((await send(2)).status, 202);
  assert.deepEqual(rules(await advice()), []);
}));

test('STALE_TOKEN: iptal edilmiş token kullanılınca warn, nedeni açıklamada', () => withServer(async ({ raw, token, tok, send, advice }) => {
  assert.equal((await raw('POST', '/auth/v3/token/revoke', { token })).status, 204);
  const fresh = await tok(); // eskisini kullanmaya devam eden istemci
  assert.ok(fresh);
  assert.equal((await send(2)).status, 401);
  const f = await advice();
  assert.ok(rules(f).includes('STALE_TOKEN'));
  const stale = f.find(x => x.rule === 'STALE_TOKEN');
  assert.match(stale.message, /iptal|revoke/);
  assert.equal(stale.severity, 'warn');
}));

test('REPORT_POLLING: /stats görev kuralı nedeniyle 429 → webhook önerisi', () => withServer(async ({ call, advice }) => {
  await call('GET', '/stats?jobId=abc');
  const second = await call('GET', '/stats?jobId=abc');
  assert.equal(second.status, 429);
  const f = await advice();
  assert.deepEqual(rules(f), ['REPORT_POLLING']);
  assert.match(f[0].message, /webhook/i);
}));

test('mutlu yol (token → 1 send → report) hiç bulgu üretmez', () => withServer(async ({ send, call, advice, clock }) => {
  const r = await send(1);
  assert.equal(r.status, 202);
  const now = clock.now();
  const q = `startAt=${encodeURIComponent(new Date(now - 3_600_000).toISOString())}&stopAt=${encodeURIComponent(new Date(now + 3_600_000).toISOString())}`;
  assert.equal((await call('GET', `/report?${q}`)).status, 200);
  assert.deepEqual(await advice(), []);
}));

test('doğru istemci: token yeniden kullanımı, 503 sonrası bekleyip tekrar, 429 sonrası Retry-After bekleme, farklı görevlerin raporu → bulgu yok', () => withServer(async ({ send, push, call, advice, clock }) => {
  for (let i = 0; i < 3; i++) assert.equal((await send(1)).status, 202);
  await push({ code: 'SERVICE_UNAVAILABLE', path: '/sms/v3/send' });
  assert.equal((await send(2)).status, 503);
  clock.advance(1_000);
  assert.equal((await send(2)).status, 202);
  await push({ code: 'RATE_LIMITED', path: '/sms/v3/send', retryAfter: 1 });
  assert.equal((await send(3)).status, 429);
  clock.advance(1_000);
  assert.equal((await send(3)).status, 202);
  assert.notEqual((await call('GET', '/stats?jobId=job-a')).status, 429);
  assert.notEqual((await call('GET', '/stats?jobId=job-b')).status, 429);
  assert.notEqual((await call('GET', '/report?jobIds=job-a')).status, 429);
  assert.notEqual((await call('GET', '/report?jobIds=job-b')).status, 429);
  assert.deepEqual(await advice(), []);
}));

test('IGNORED_RETRY_AFTER: görev düzeyi 429 başka görevin sorgusunu işaretlemez', () => withServer(async ({ call, advice }) => {
  await call('GET', '/stats?jobId=job-a');
  assert.equal((await call('GET', '/stats?jobId=job-a')).status, 429);
  assert.notEqual((await call('GET', '/stats?jobId=job-b')).status, 429);
  assert.deepEqual(rules(await advice()), ['REPORT_POLLING']);
}));

test('IGNORED_RETRY_AFTER: aynı görev işaretlenir, hesap düzeyi 429 tüm yolu bloklar', () => {
  const clock = createManualClock(1_000_000);
  const adv = createAdvisor({ clock });
  const ex = (over = {}) => ({
    method: 'GET', path: '/sms/v3/stats', status: 429, code: 'RATE_LIMITED', accountId: 'a1', username: null, ip: '::1',
    bodyHash: null, messageCount: null, tokenState: 'ok', requestId: 'r', at: clock.now(), retryAfterSec: 30,
    query: 'jobId=job-a', perJob: true, ...over,
  });
  const ignored = (list) => list.map(f => f.rule).filter(r => r === 'IGNORED_RETRY_AFTER');
  adv.observe(ex());
  assert.deepEqual(ignored(adv.observe(ex({ query: 'jobId=job-b', status: 200, retryAfterSec: null }))), []);
  assert.deepEqual(ignored(adv.observe(ex({ status: 200, retryAfterSec: null }))), ['IGNORED_RETRY_AFTER']);
  const adv2 = createAdvisor({ clock });
  adv2.observe(ex({ perJob: false, query: null }));
  assert.deepEqual(ignored(adv2.observe(ex({ query: 'jobId=job-z', status: 200, retryAfterSec: null, perJob: false }))), ['IGNORED_RETRY_AFTER']);
});

test('POST /__mock/reset bulguları temizler', () => withServer(async ({ raw, send, advice }) => {
  for (let i = 0; i < 5; i++) await send(1);
  assert.equal((await advice()).length, 1);
  await raw('POST', '/__mock/reset', { body: {} });
  assert.deepEqual(await advice(), []);
}));

test('advisor.clear() bulguları ve izleme durumunu temizler', () => {
  const clock = createManualClock(1_000_000);
  const adv = createAdvisor({ clock });
  const ex = (over = {}) => ({
    method: 'POST', path: '/sms/v3/send', status: 202, code: null, accountId: 'a1', username: 'u1', ip: '::1',
    bodyHash: null, messageCount: 1, tokenState: 'ok', requestId: 'r1', at: clock.now(), ...over,
  });
  let emitted = [];
  for (let i = 0; i < 5; i++) emitted = adv.observe(ex());
  assert.equal(emitted[0].rule, 'SINGLE_RECIPIENT_BURST');
  assert.equal(adv.findings().length, 1);
  adv.clear();
  assert.equal(adv.findings().length, 0);
  for (let i = 0; i < 4; i++) assert.deepEqual(adv.observe(ex()), []);
});

test('advisor: kural hesap başına 60 sn içinde bir kez, farklı hesap ayrı sayılır', () => {
  const clock = createManualClock(1_000_000);
  const adv = createAdvisor({ clock });
  const ex = (over = {}) => ({
    method: 'POST', path: '/sms/v3/send', status: 202, code: null, accountId: 'a1', username: 'u1', ip: '::1',
    bodyHash: null, messageCount: 1, tokenState: 'ok', requestId: 'r1', at: clock.now(), ...over,
  });
  for (let i = 0; i < 5; i++) adv.observe(ex());
  for (let i = 0; i < 5; i++) adv.observe(ex({ accountId: 'a2' }));
  assert.equal(adv.findings().length, 2);
  clock.advance(30_000);
  for (let i = 0; i < 5; i++) adv.observe(ex());
  assert.equal(adv.findings().length, 2);
  clock.advance(31_000);
  for (let i = 0; i < 5; i++) adv.observe(ex());
  assert.equal(adv.findings().length, 3);
});

test('konsol satırları: başarı, hata ve bulgu biçimi', () => withServer(async ({ send, call, lines, push }) => {
  await send(3);
  const ok = lines.find(l => l.includes('POST /sms/v3/send'));
  assert.match(ok, /^\[netgsm-sms-mock\] ✔ 202 POST \/sms\/v3\/send — 3 kabul, 0 red \(requestId \S+\)$/);
  await send(1, { sender: 'YOKBASLIK' });
  const bad = lines.find(l => l.includes('✘ 422'));
  assert.match(bad, /^\[netgsm-sms-mock\] ✘ 422 POST \/sms\/v3\/send REJECTED_HEADER — .+ \(requestId \S+\)$/);
  assert.ok(bad.includes(explain('REJECTED_HEADER')));
  await call('POST', '/send', { messages: 'x' });
  await call('POST', '/send', { messages: 'x' });
  assert.ok(lines.some(l => l.startsWith('[netgsm-sms-mock] ⚠ ')), 'bulgu ⚠ ile yazılır');
  assert.ok(!lines.some(l => l.includes('/__mock/')), 'kontrol uçları satır üretmez');
  void push;
}));

test('konsol satırı: 202 kısmi red sayısını yazar', () => withServer(async ({ call, lines }) => {
  const r = await call('POST', '/send', { sender: 'MOCKTEST', messages: [{ text: 'a', recipient: '905061234567' }, { text: 'b', recipient: 'abc' }] });
  assert.equal(r.status, 202);
  assert.ok(lines.some(l => l.includes('✔ 202 POST /sms/v3/send — 1 kabul, 1 red')));
}));

test('quiet: yalnızca hata ve bulgular yazılır', () => withServer(async ({ send, lines }) => {
  await send(2);
  assert.ok(!lines.some(l => l.includes('✔')));
  await send(1, { sender: 'YOKBASLIK' });
  assert.ok(lines.some(l => l.includes('✘ 422')));
}, { quiet: true }));

test('GET /__mock/advice düz JSON zarfı döner', () => withServer(async ({ raw }) => {
  const r = await raw('GET', '/__mock/advice');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { findings: [] });
}));

// ---- explain

function identityCodes() {
  const out = [];
  const walk = (o) => {
    if (o && typeof o === 'object') {
      if (o.code && o.code.enum) out.push(...o.code.enum);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(identitySpec.components?.schemas?.Problem ?? identitySpec);
  return out;
}

test('explain: her ApiError kodu, kayıt red nedeni, Identity kodu ve rapor nedeni için açıklama var', () => {
  const schemas = smsSpec.components.schemas;
  const codes = [
    ...schemas.ApiError.properties.code.enum,
    ...schemas.RejectedMessage.properties.reason.enum,
    ...schemas.ReportEntry.properties.failReason.enum,
    ...schemas.StatEntry.properties.failReason.enum,
    // Rapor webhook'u nedeni sayısal kodla (status / errorCode) taşır; adları GET /report'unkilerle aynıdır.
    ...identityCodes(),
    'https_required',
  ];
  assert.ok(codes.length > 40);
  for (const c of codes) {
    const t = explain(c);
    assert.equal(typeof t, 'string');
    assert.ok(t.length > 10, c);
    assert.ok(!t.startsWith('Tanınmayan kod'), `${c} için özel açıklama yok`);
    assert.ok(!t.includes('\n'), `${c} tek satır olmalı`);
  }
});

test('explain: panel yolları ve destek bilgileri', () => {
  assert.doesNotMatch(explain('NO_INTERNATIONAL_PERMISSION'), /API Erişim İzinleri/);
  assert.match(explain('NO_INTERNATIONAL_PERMISSION'), /\+90 312 911 0 911/);
  assert.match(explain('NO_INTERNATIONAL_PERMISSION'), /abone.islemleri@netgsm.com.tr/);
  assert.match(explain('FORBIDDEN'), /operatör/);
  assert.match(explain('ip_not_allowed'), /Abonelik İşlemleri → API İşlemleri → API Erişim İzinleri/);
  assert.match(explain('service_not_activated'), /\+90 850 303 0 303/);
  assert.match(explain('service_not_activated'), /abone\.islemleri@netgsm\.com\.tr/);
  assert.match(explain('QUEUE_UNCONFIRMED'), /GET \/report/);
  assert.match(explain('QUEUE_UNCONFIRMED'), /körlemesine|tekrar göndermeyin/);
  assert.match(explain('SERVICE_UNAVAILABLE'), /tekrar deneyebilirsiniz/);
  assert.ok(explain('NOPE_UNKNOWN').length > 0);
});

// ---- bağlama duyarlı açıklamalar ve tutarlı tavsiye metinleri

const TOKEN_ADVICE = /önbellekte tutun.*süresi dolmadan.*refresh.*401 .*yeniden giriş/;

test('TOKEN_CHURN ve STALE_TOKEN metni auth.md ile tutarlı: önbellek, süresi dolmadan refresh, 401de yeniden giriş', () => withServer(async ({ raw, token, tok, send, advice }) => {
  await tok(); await tok();
  assert.match((await advice()).find(f => f.rule === 'TOKEN_CHURN').message, TOKEN_ADVICE);
  assert.equal((await raw('POST', '/auth/v3/token/revoke', { token })).status, 204);
  await send(2);
  const stale = (await advice()).find(f => f.rule === 'STALE_TOKEN').message;
  assert.match(stale, TOKEN_ADVICE);
  assert.doesNotMatch(stale, /yalnızca 401 alınca yenileyin/);
}));

test('STALE_TOKEN: süresi dolmuş token da bildirilir, 60 sn içinde bir kez', () => withServer(async ({ send, advice, clock }) => {
  clock.advance(61_000);
  assert.equal((await send(2)).status, 401);
  let f = (await advice()).filter(x => x.rule === 'STALE_TOKEN');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /süresi dolmuş/);
  assert.match(f[0].message, TOKEN_ADVICE);
  await send(2);
  assert.equal((await advice()).filter(x => x.rule === 'STALE_TOKEN').length, 1);
}, { tokenTtlSec: 60 }));

test('explain bağlamı: INTERNAL_ERROR gönderimde körlemesine tekrar yok, okumada kısa süre sonra tekrar', () => {
  for (const path of ['/sms/v3/send', '/sms/v3/send/template', '/sms/v3/directory/send']) {
    const t = explain('INTERNAL_ERROR', { path });
    assert.match(t, /gönderilmiş olabilir/, path);
    assert.match(t, /körlemesine tekrar denemeyin/, path);
    assert.match(t, /GET \/report/, path);
    assert.match(t, /requestId ile teknikdestek@netgsm\.com\.tr/, path);
    assert.doesNotMatch(t, /kısa süre sonra tekrar/, path);
  }
  const otp = explain('INTERNAL_ERROR', { path: '/sms/v3/send/otp' });
  assert.match(otp, /otomatik tekrar göndermeyin/);
  assert.doesNotMatch(otp, /kısa süre sonra tekrar/);
  assert.match(explain('INTERNAL_ERROR', { path: '/sms/v3/report' }), /kısa süre sonra tekrar/);
  assert.match(explain('QUEUE_UNCONFIRMED', { path: '/sms/v3/cancel' }), /SMS göndermez/);
  assert.match(explain('QUEUE_UNCONFIRMED', { path: '/sms/v3/cancel' }), /404/);
});

test('explain bağlamı: SERVICE_UNAVAILABLE yola göre; QUEUE_UNCONFIRMED yalnızca /directory/send ve /cancel; E_SIGNATURE_REQUIRED', () => {
  for (const path of ['/sms/v3/send', '/sms/v3/send/template']) {
    const t = explain('SERVICE_UNAVAILABLE', { path });
    assert.match(t, /çoğunlukla kuyruğa alınmamıştır/, path);
    assert.doesNotMatch(t, /doğrulanamadı/, path);
    assert.match(t, /körlemesine yeniden göndermeden önce GET \/report ile kontrol edin/, path);
  }
  const dir = explain('SERVICE_UNAVAILABLE', { path: '/sms/v3/directory/send' });
  assert.match(dir, /kuyruğa alınmış olabilir/);
  assert.match(dir, /GET \/report ile kontrol etmelisiniz/);
  for (const path of ['/sms/v3/send/otp', '/sms/v3/cancel', '/sms/v3/report']) {
    const t = explain('SERVICE_UNAVAILABLE', { path });
    assert.match(t, /güvenle tekrar deneyebilirsiniz/, path);
    assert.doesNotMatch(t, /kuyruğa alınmış olabilir/, path);
  }
  assert.match(explain('SERVICE_UNAVAILABLE', { path: '/sms/v3/send/otp' }), /hiçbir şey gönderilmedi/);
  assert.match(explain('QUEUE_UNCONFIRMED', { path: '/sms/v3/directory/send' }), /GET \/report ile kontrol etmelisiniz/);
  assert.doesNotMatch(explain('QUEUE_UNCONFIRMED'), /OTP/);
  const esig = explain('E_SIGNATURE_REQUIRED');
  assert.match(esig, /e-imza/);
  assert.match(esig, /web paneline/);
  assert.match(esig, /abone\.islemleri@netgsm\.com\.tr/);
});

test('explain bağlamı: Retry-After olmayan RATE_LIMITED askıya alma demektir', () => {
  const suspended = explain('RATE_LIMITED', { hasRetryAfter: false });
  assert.match(suspended, /askıya/);
  assert.match(suspended, /beklemeyin/);
  assert.match(suspended, /tekrar denemeyin/);
  assert.match(suspended, /\+90 850 303 0 303|abone\.islemleri/);
  assert.doesNotMatch(suspended, /bekleyip yeniden deneyin/);
  assert.match(explain('RATE_LIMITED', { hasRetryAfter: true }), /Retry-After.*bekleyip yeniden deneyin/);
});

test('explain metinleri errors.md ile çelişmez', () => {
  const iys = explain('REJECTED_IYS');
  assert.doesNotMatch(iys, /kaldırın/);
  assert.match(iys, /NONE yalnızca bilgilendirme/);
  assert.match(iys, /ticari/);
  assert.match(explain('ALREADY_EXISTS'), /önce DELETE, sonra yeniden POST/);
  assert.match(explain('MALFORMED_ENTRY'), /null/);
  assert.doesNotMatch(explain('MALFORMED_ENTRY'), /recipient, text/);
  const cred = explain('invalid_credentials');
  assert.doesNotMatch(cred, /kilit/);
  assert.match(cred, /kullanıcı adı ve IP/);
  assert.match(explain('api_access_denied'), /Abonelik İşlemleri → API İşlemleri → Aktifleştir/);
  assert.doesNotMatch(explain('api_access_denied'), /Online İşlemler → API İşlemleri/);
  assert.match(explain('INVALID_SEND_WINDOW'), /stopAt/);
  assert.match(explain('INVALID_SEND_WINDOW'), /18 ay/);
  // failReason metinleri neden uydurmaz
  assert.doesNotMatch(explain('TIMEOUT'), /kapsama|kapalı/);
  assert.doesNotMatch(explain('DEVICE_NOT_SUPPORTED'), /karakter seti/);
  assert.doesNotMatch(explain('NTS_NOT_APPROVED'), /şablon|başlık/);
});

test('konsol: gönderimde 500 ve askıya alınmış gönderim bağlama uygun açıklanır; 406 anlamlı yazılır', () => withServer(async ({ base, send, push, lines }) => {
  await push({ code: 'INTERNAL_ERROR', path: '/sms/v3/send' });
  assert.equal((await send(2)).status, 500);
  assert.match(lines.find(l => l.includes('✘ 500')), /gönderilmiş olabilir/);
  await push({ code: 'SENDING_SUSPENDED', path: '/sms/v3/send' });
  assert.equal((await send(2)).status, 429);
  assert.match(lines.find(l => l.includes('✘ 429')), /askıya/);
  const r = await fetch(`${base}/sms/v3/templates`, { headers: { accept: 'text/html' } });
  assert.equal(r.status, 406);
  const l406 = lines.find(l => l.includes('✘ 406'));
  assert.ok(l406);
  assert.doesNotMatch(l406, /Tanınmayan kod/);
  assert.match(l406, /Accept/);
}));
