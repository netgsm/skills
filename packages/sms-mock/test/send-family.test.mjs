import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createClock } from '../src/clock.mjs';
import { createSchemaValidator } from '../src/sms/schema.mjs';
import { smsSpec } from '../src/generated/specs.mjs';

const validator = createSchemaValidator(smsSpec);
const conforms = (name, body) => assert.deepEqual(validator.validate(name, body), [], `${name} şemaya uymuyor`);

// Kullanılan test hesaplarının şifreleri (src/accounts.mjs).
const PASSWORDS = { '8500000000': 'password001', '8500000006': 'password007', '8500000008': 'password009' };

async function withServer(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const clock = createClock();
  const s = createMockServer({ port: 0, log: () => {}, clock, ...opts });
  try {
    const base = await s.listen();
    const cache = new Map();
    const tok = async (u = '8500000000') => cache.get(u) ?? (cache.set(u, await fresh(u)), cache.get(u));
    const fresh = async (u) => (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PASSWORDS[u], scope: 'sms' }) })).json()).access_token;
    const call = async (method, path, body, u) => fetch(`${base}/sms/v3${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${await tok(u)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await fn({ s, clock, base, tok, call });
  } finally { await s.close(); }
}
const tpl = (recipient = '905061234567', params = { otpCode: '123456' }, templateId = 3) => ({ templateId, recipient, params });

test('send-template: 21 kayıt → 400 INVALID_REQUEST', () => withServer(async ({ call }) => {
  const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: Array.from({ length: 21 }, () => tpl()) });
  const b = await r.json();
  assert.equal(r.status, 400);
  assert.equal(b.code, 'INVALID_REQUEST');
  assert.ok(b.violations.some(v => v.field === 'templates'));
}));

test('send-template: boş ya da 17 karakterden uzun alıcı 400, violations templates[0].recipient', () => withServer(async ({ call }) => {
  for (const rcp of ['', '9'.repeat(18)]) {
    const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [tpl(rcp)] });
    const b = await r.json();
    assert.equal(r.status, 400);
    assert.equal(b.violations[0].field, 'templates[0].recipient');
  }
}));

test('send-template: var olmayan templateId tüm isteği 400 yapar', () => withServer(async ({ call }) => {
  const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [tpl(), tpl('905061234568', {}, 99)] });
  const b = await r.json();
  assert.equal(r.status, 400);
  assert.equal(b.message, 'templates not found: [99]');
}));

test('send-template: parametre hataları', () => withServer(async ({ call }) => {
  const cases = [
    [{}, 'Invalid params for templateId 3. Missing params: [otpCode]'],
    [{ otpCode: '' }, 'Invalid params for templateId 3. Missing params: [otpCode]'],
    [{ otpCode: '1', code: 'x' }, 'Invalid params for templateId 3. Unexpected params: [code]'],
    [{ otpCode: 'abc' }, "param 'otpCode' is not a valid BIGINT"],
  ];
  for (const [params, message] of cases) {
    const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [tpl('905061234567', params)] });
    const b = await r.json();
    assert.equal(r.status, 400, message);
    assert.equal(b.message, message);
  }
  const date = await (await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [tpl('905061234567', { date: '31.02.2026', note: 'x' }, 5)] })).json();
  assert.equal(date.message, "param 'date' is not a valid DATE");
  const text = await (await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [tpl('905061234567', { date: '01/02/2026', note: 'x'.repeat(31) }, 5)] })).json();
  assert.equal(text.message, "param 'note' is not a valid TEXT");
}));

test('send-template: geçersiz biçimli alıcı rejectedItems içinde, templates konumuyla', () => withServer(async ({ call }) => {
  const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [tpl('905061234567'), tpl('05061234567')] });
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.equal(b.accepted, 1);
  assert.equal(b.rejected, 1);
  assert.deepEqual(b.rejectedItems.map(x => [x.index, x.reason]), [[1, 'INVALID_RECIPIENT']]);
  conforms('SmsSendResponse', b);
}));

test('send-template: hepsi reddedilirse 422 NO_DELIVERABLE_MESSAGES', () => withServer(async ({ call }) => {
  const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [tpl('05061234567')] });
  const b = await r.json();
  assert.equal(r.status, 422);
  assert.equal(b.code, 'NO_DELIVERABLE_MESSAGES');
  assert.equal(b.message, 'all 1 messages rejected');
}));

test('send-template: geçerli 2 kayıt → 202, accepted 2, metinler doldurulur', () => withServer(async ({ call, s }) => {
  const r = await call('POST', '/send/template', {
    sender: 'MOCKTEST', referenceId: 'order-4711',
    templates: [tpl('905061234567'), tpl('905061234568', { date: '01.02.2026', note: 'Kat 2' }, 5)],
  });
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.equal(b.accepted, 2);
  assert.equal(b.rejected, 0);
  assert.equal(b.referenceId, 'order-4711');
  conforms('SmsSendResponse', b);
  const job = s.ctx.jobs.get('8500000000', b.jobId);
  assert.equal(job.kind, 'TEMPLATE');
  assert.deepEqual(job.records.map(x => x.text), ['Dogrulama kodunuz: 123456', 'Randevunuz 01.02.2026 tarihinde. Not: Kat 2']);
}));

test('send-template: spec örneği (şablon 3 + parametresiz herkese açık şablon 4) → 202, accepted 2', () => withServer(async ({ call }) => {
  const r = await call('POST', '/send/template', { sender: 'MOCKTEST', encoding: 'TURKISH', referenceId: 'order-4711', templates: [
    { templateId: 3, recipient: '905061234567', params: { otpCode: '123456' } }, { templateId: 4, recipient: '905061234568' }] });
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.equal(b.accepted, 2);
}));

test('send-template: templateId eksik ya da geçersizse violations alanı templates[0].templateId', () => withServer(async ({ call }) => {
  for (const item of [{ recipient: '905061234567' }, { templateId: 0, recipient: '905061234567' }, { templateId: 'x', recipient: '905061234567' }]) {
    const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [item] });
    const b = await r.json();
    assert.equal(r.status, 400);
    assert.deepEqual(b.violations.map(v => v.field), ['templates[0].templateId']);
  }
}));

test('send-directory: spec örneği groupIds [7, 8] (8 bilinmez) → 202, bilinmeyen grup atlanır', () => withServer(async ({ call, s }) => {
  const r = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'Merhaba', encoding: 'TURKISH', groupIds: [7, 8],
    contacts: [{ number: '905061234567', name: 'Ali', surname: 'Veli' }] });
  const b = await r.json();
  assert.equal(r.status, 202);
  conforms('DirectorySendResponse', b);
  assert.equal(s.ctx.jobs.get('8500000000', b.jobId).records.length, 4);
  const only = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'Merhaba', groupIds: [99] });
  assert.equal(only.status, 202);
}));

test('send-template: başlık ve İYS kontrolleri', () => withServer(async ({ call }) => {
  const h = await (await call('POST', '/send/template', { sender: 'YOKBASLIK', templates: [tpl()] })).json();
  assert.equal(h.code, 'REJECTED_HEADER');
  assert.equal(h.message, 'NOT_REGISTERED');
  const y = await (await call('POST', '/send/template', { sender: 'MOCKTEST', iysFilter: 'BRAND', templates: [tpl()] }, '8500000008')).json();
  assert.equal(y.code, 'REJECTED_IYS');
}));

test('send-template: 429 template send rate limit exceeded, reddedilen istekler de sayılır', () => withServer({ rateScale: 0.003 }, async ({ call }) => {
  // 1000 * 0.003 → 3 istek
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/send/template', { sender: 'YOKBASLIK', templates: [tpl()] })).status, 422);
  const r = await call('POST', '/send/template', { sender: 'YOKBASLIK', templates: [tpl()] });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await r.json()).message, 'template send rate limit exceeded');
}));

test('templates: 200 TemplateListResponse, en yenisi önce; 21. istekte 429', () => withServer(async ({ call }) => {
  const r = await call('GET', '/templates');
  const b = await r.json();
  assert.equal(r.status, 200);
  conforms('TemplateListResponse', b);
  assert.deepEqual(b.templates.map(t => [t.templateId, t.public]), [[3, false], [4, true], [5, false], [1, true]]);
  assert.equal(b.total, 4);
  // SMS sandbox'ının şablonu birebir
  assert.deepEqual(b.templates[3], {
    templateId: 1, content: 'Merhaba ${name}, kodunuz ${code}', type: 'AUTH_OTP', description: 'Sandbox template', public: true,
    parameters: [{ name: 'name', type: 'TEXT', maxLength: 50 }, { name: 'code', type: 'TEXT', maxLength: 10 }],
    createdAt: '2026-01-01T12:00:00+03:00',
  });
  assert.equal(b.totalPages, 1);
  assert.equal(b.templates[0].parameters[0].maxLength, null);
  for (let i = 0; i < 19; i++) assert.equal((await call('GET', '/templates')).status, 200);
  const limited = await call('GET', '/templates');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).message, 'template list rate limit exceeded');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
}));

test('templates: includePublic, type, search, content, sayfalama', () => withServer({ rateScale: 10 }, async ({ call }) => {
  const get = async (q) => (await call('GET', `/templates${q}`)).json();
  assert.deepEqual((await get('?includePublic=false')).templates.map(t => t.templateId), [3, 5]);
  assert.deepEqual((await get('?type=SERVICE_ALERT')).templates.map(t => t.templateId), [4, 5]);
  assert.deepEqual((await get('?search=RANDEVU')).templates.map(t => t.templateId), [5]);
  assert.deepEqual((await get('?content=otpcode')).templates.map(t => t.templateId), [3]);
  const p = await get('?size=1&page=1');
  assert.deepEqual([p.count, p.page, p.total, p.totalPages, p.templates[0].templateId], [1, 1, 4, 4, 4]);
  assert.deepEqual((await get('?type=AUTH_OTP')).templates.map(t => t.templateId), [3, 1]);
  const empty = await get('?page=5');
  assert.deepEqual([empty.count, empty.templates.length], [0, 0]);
}));

test('templates: 400 mesajları', () => withServer({ rateScale: 10 }, async ({ call }) => {
  const msgOf = async (q) => { const r = await call('GET', `/templates${q}`); assert.equal(r.status, 400); return (await r.json()).message; };
  assert.equal(await msgOf('?page=-1'), 'page must not be negative');
  assert.equal(await msgOf('?size=0'), 'size must be between 1 and 100');
  assert.equal(await msgOf('?size=101'), 'size must be between 1 and 100');
  assert.equal(await msgOf(`?type=${'x'.repeat(101)}`), 'type must be at most 100 characters');
  assert.equal(await msgOf(`?search=${'x'.repeat(101)}`), 'search must be at most 100 characters');
}));

test('templates: kimlik doğrulama gerekir', () => withServer(async ({ base }) => {
  const r = await fetch(`${base}/sms/v3/templates`);
  assert.equal(r.status, 401);
}));

test('send-otp: 8500000000 → 202 OtpSendResponse; 8500000008 → 422 INSUFFICIENT_CREDIT', () => withServer(async ({ call, s }) => {
  const body = { sender: 'MOCKTEST', text: 'Dogrulama kodunuz: 123456', recipient: '905061234567', appName: 'shop' };
  const r = await call('POST', '/send/otp', body);
  const b = await r.json();
  assert.equal(r.status, 202);
  conforms('OtpSendResponse', b);
  const job = s.ctx.jobs.get('8500000000', b.jobId);
  assert.equal(job.kind, 'OTP');
  assert.equal(job.records[0].recipient, '905061234567');
  const no = await call('POST', '/send/otp', body, '8500000008');
  const nb = await no.json();
  assert.equal(no.status, 422);
  assert.equal(nb.code, 'INSUFFICIENT_CREDIT');
  assert.equal(nb.message, 'no credit, package or campaign to pay for the otp');
}));

test('send-otp: alfanümerik başlıkta 156 karakter 400, abone numarasında 160 kabul', () => withServer(async ({ call }) => {
  const text = 'a'.repeat(156);
  const r = await call('POST', '/send/otp', { sender: 'MOCKTEST', text, recipient: '905061234567' });
  const b = await r.json();
  assert.equal(r.status, 400);
  assert.equal(b.code, 'INVALID_REQUEST');
  assert.equal(b.message, 'text is longer than 155 characters for this sender');
  const ok = await call('POST', '/send/otp', { sender: '8500000000', text, recipient: '905061234567' });
  assert.equal(ok.status, 202);
  const over = await call('POST', '/send/otp', { sender: '8500000000', text: 'a'.repeat(161), recipient: '905061234567' });
  assert.equal(over.status, 400);
}));

test('send-otp: eksik ya da boş alan 400 N field(s) rejected, violations ile', () => withServer(async ({ call }) => {
  const r = await call('POST', '/send/otp', { sender: '  ', recipient: '905061234567' });
  const b = await r.json();
  assert.equal(r.status, 400);
  assert.equal(b.code, 'INVALID_REQUEST');
  assert.equal(b.message, '2 field(s) rejected');
  assert.deepEqual(b.violations.map(v => v.field), ['sender', 'text']);
  conforms('ApiError', b);
}));

test('send-otp: alıcı 5XXXXXXXXX, 05XXXXXXXXX ya da 905XXXXXXXXX, başına + eklenebilir; diğerleri 400 recipient is not a valid number', () => withServer(async ({ call, s }) => {
  for (const recipient of ['5061234567', '05061234567', '905061234567', '+905061234567', '+05061234567', '+5061234567']) {
    const r = await call('POST', '/send/otp', { sender: 'MOCKTEST', text: 'kod 1', recipient });
    assert.equal(r.status, 202, recipient);
    assert.equal(s.ctx.jobs.get('8500000000', (await r.json()).jobId).records[0].recipient, '905061234567');
  }
  for (const recipient of ['+90 506 123 45 67', '0 506 123 45 67', '++905061234567', '4061234567', '-4915112345678', '+4915112345678', '9050612345678', '50612345']) {
    const r = await call('POST', '/send/otp', { sender: 'MOCKTEST', text: 'kod 1', recipient });
    const b = await r.json();
    assert.equal(r.status, 400, recipient);
    assert.equal(b.message, 'recipient is not a valid number', recipient);
    assert.equal(b.violations, null);
  }
}));

test('send-otp: kontrol sırası gövde JSON → token var → alanlar → token geçerli', () => withServer(async ({ base }) => {
  const post = (headers, body) => fetch(`${base}/sms/v3/send/otp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const unreadable = await post({}, '{bozuk');
  assert.equal(unreadable.status, 400);
  assert.equal((await unreadable.json()).message, 'request body could not be read as json');
  const noToken = await post({}, JSON.stringify({ sender: '' }));
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).message, 'no bearer token');
  const badToken = { authorization: 'Bearer gecersiz' };
  const fieldsFirst = await post(badToken, JSON.stringify({ sender: 'MOCKTEST', text: 'kod', recipient: '+4915112345678' }));
  assert.equal(fieldsFirst.status, 400);
  assert.equal((await fieldsFirst.json()).message, 'recipient is not a valid number');
  const invalid = await post(badToken, JSON.stringify({ sender: 'MOCKTEST', text: 'kod', recipient: '905061234567' }));
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).message, 'invalid or expired token');
}));

test('send-otp: gönderici büyük/küçük harf duyarsız, abone numarası 0 ya da 90 ile yazılabilir; CASE_MISMATCH yok', () => withServer(async ({ call }) => {
  for (const sender of ['mocktest', 'MockTest', '8500000000', '08500000000', '908500000000']) {
    const r = await call('POST', '/send/otp', { sender, text: 'kod 1', recipient: '905061234567' });
    assert.equal(r.status, 202, sender);
  }
  for (const [sender, message] of [['YOKBASLIK', 'NOT_REGISTERED'], ['5000000000', 'NOT_REGISTERED'], ['mockkapali', 'ROUTING_CODE_MISSING']]) {
    const r = await call('POST', '/send/otp', { sender, text: 'kod 1', recipient: '905061234567' });
    const b = await r.json();
    assert.equal(r.status, 422, sender);
    assert.equal(b.code, 'REJECTED_HEADER');
    assert.equal(b.message, message, sender);
  }
}));

test('send-otp: metin kırpılır ve çevrilir; uzunluk çevrilmiş metinden sayılır', () => withServer(async ({ call, s }) => {
  const textOf = async (text, sender = 'MOCKTEST') => {
    const r = await call('POST', '/send/otp', { sender, text, recipient: '905061234567' });
    assert.equal(r.status, 202, text);
    return s.ctx.jobs.get('8500000000', (await r.json()).jobId).records[0].text;
  };
  assert.equal(await textOf('  Şifreniz: 1234\t '), 'Sifreniz: 1234');
  assert.equal(await textOf('çğıöşü ÇĞİÖŞÜ'), 'cgiosu CGIOSU');
  assert.equal(await textOf('{a} [b]'), '(a) (b)');
  assert.equal(await textOf('“a” `b` ‘c’'), '"a" "b" \'c\'');
  assert.equal(await textOf('~1 2€ a|b\tc ^d'), '?1 2;EO; a b c d');
  assert.equal(await textOf('satır1\nsatır2\r\nson'), 'satir1\\nsatir2\\nson');
  assert.equal(await textOf('kod 😀 é Ж'), 'kod ? ? ?');
  // € dört karakter olur: 152 + 4 = 156 > 155
  const long = await call('POST', '/send/otp', { sender: 'MOCKTEST', text: `${'a'.repeat(152)}€`, recipient: '905061234567' });
  assert.equal(long.status, 400);
  assert.equal((await long.json()).message, 'text is longer than 155 characters for this sender');
  // kırpılan boşluklar sayılmaz
  assert.equal((await call('POST', '/send/otp', { sender: 'MOCKTEST', text: `  ${'a'.repeat(155)}  `, recipient: '905061234567' })).status, 202);
  // satır sonu iki karakter: 159 + 2 = 161 > 160
  const sub = await call('POST', '/send/otp', { sender: '8500000000', text: `${'a'.repeat(80)}\n${'a'.repeat(79)}`, recipient: '905061234567' });
  assert.equal(sub.status, 400);
  assert.equal((await sub.json()).message, 'text is longer than 160 characters for this sender');
}));

test('send-otp: istek sınırı yok; appName sınırı yok, bilinmeyen alanlar yok sayılır', () => withServer({ rateScale: 0.0001 }, async ({ call }) => {
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/send/otp', { sender: 'MOCKTEST', text: 'kod 1', recipient: '905061234567', appName: 'x'.repeat(200), extra: true });
    assert.equal(r.status, 202);
  }
}));

test('send-otp: x-client kuralı; kurumsal OTP hesabı enterprise gönderir, diğerleri göndermez', () => withServer(async ({ base }) => {
  const token = async (username, password) => (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, scope: 'sms' }) })).json()).access_token;
  const otp = async (t, xClient) => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${t}` };
    if (xClient !== undefined) headers['x-client'] = xClient;
    return fetch(`${base}/sms/v3/send/otp`, { method: 'POST', headers, body: JSON.stringify({ sender: 'MOCKTEST', text: 'kod 1', recipient: '905061234567' }) });
  };
  const enterprise = await token('8500000010', 'password012');
  assert.equal((await otp(enterprise, 'enterprise')).status, 202);
  for (const xClient of [undefined, 'Enterprise', 'ENTERPRISE', 'enterprise-otp']) {
    const r = await otp(enterprise, xClient);
    const b = await r.json();
    assert.equal(r.status, 403, String(xClient));
    assert.equal(b.code, 'FORBIDDEN');
    assert.equal(b.message, 'account operator is not served for this operation');
  }
  const normal = await token('8500000000', 'password001');
  assert.equal((await otp(normal)).status, 202);
  const r = await otp(normal, 'enterprise');
  assert.equal(r.status, 403);
  assert.equal((await r.json()).message, 'account operator is not served for this operation');
}));

test('send-otp: kurumsal OTP hesabı /send ile x-client olmadan gönderebilir', () => withServer(async ({ base }) => {
  const t = (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '8500000010', password: 'password012', scope: 'sms' }) })).json()).access_token;
  const r = await fetch(`${base}/sms/v3/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ sender: 'MOCKTEST', messages: [{ text: 'a', recipient: '905061234567' }] }) });
  assert.equal(r.status, 202);
}));

test('send-directory: geçerli grup ve kişi → 202 DirectorySendResponse', () => withServer(async ({ call, s }) => {
  const r = await call('POST', '/directory/send', {
    sender: 'MOCKTEST', text: 'siparişiniz yolda.', encoding: 'TURKISH', groupIds: [7], addressType: 2, address1: 'Sayın',
    contacts: [{ number: '905061234567', name: 'Zeynep', surname: 'Kaya' }], recipients: ['905061234999'],
  });
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.deepEqual([b.status, b.review], ['QUEUED', 'NONE']);
  conforms('DirectorySendResponse', b);
  const job = s.ctx.jobs.get('8500000000', b.jobId);
  assert.equal(job.kind, 'DIRECTORY');
  assert.equal(job.records.length, 5);
  assert.equal(job.records[0].text, 'Sayın Ali Veli siparişiniz yolda.');
  assert.equal(job.records[3].text, 'Sayın Zeynep Kaya siparişiniz yolda.');
  assert.equal(job.records[4].text, 'siparişiniz yolda.');
}));

test('send-directory: bilinmeyen grup, grup/kişi yok, UNICODE, addressType, uzun metin → 400', () => withServer(async ({ call }) => {
  const base = { sender: 'MOCKTEST', text: 'Merhaba' };
  const cases = [
    [{ ...base, recipients: ['905061234567'] }, 'a directory send names at least one group or contact; for numbers alone use /sms/v3/send'],
    [{ ...base, groupIds: [7], encoding: 'UNICODE' }, 'encoding UNICODE is not supported for directory sends'],
  ];
  for (const [body, message] of cases) {
    const r = await call('POST', '/directory/send', body);
    const b = await r.json();
    assert.equal(r.status, 400, message);
    assert.equal(b.code, 'INVALID_REQUEST');
    assert.equal(b.message, message);
  }
  const bad = await call('POST', '/directory/send', { ...base, groupIds: [7], addressType: 18 });
  assert.equal(bad.status, 400);
  const long = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a'.repeat(913), groupIds: [7] });
  assert.equal(long.status, 400);
  assert.equal((await long.json()).message, 'text exceeds 912 characters for this encoding and sender');
}));

test('send-directory: başlık 422, aralık 400, 60/dk sınırı', () => withServer(async ({ call }) => {
  const h = await (await call('POST', '/directory/send', { sender: 'YOK', text: 'a', groupIds: [7] })).json();
  assert.equal(h.code, 'REJECTED_HEADER');
  const w = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7], startAt: '2099-01-01T00:00:00+03:00', stopAt: '2099-01-01T00:30:00+03:00' });
  assert.equal(w.status, 400);
  const wb = await w.json();
  assert.equal(wb.code, 'INVALID_SEND_WINDOW');
  assert.equal(wb.message, 'the send window was rejected');
  // limiti geçen istekler sayılır, limit tarafından reddedilenler sayılmaz (countRejected:false); 2 istek yapıldı, 58 daha
  for (let i = 0; i < 58; i++) assert.equal((await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7] })).status, 202);
  const r = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7] });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).message, 'directory send rate limit exceeded');
}));

test('send-family: gönderim yetkisi olmayan hesap 403', () => withServer(async ({ call }) => {
  for (const [path, body] of [
    ['/send/template', { sender: 'MOCKTEST', templates: [tpl()] }],
    ['/send/otp', { sender: 'MOCKTEST', text: 'k', recipient: '905061234567' }],
    ['/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7] }],
  ]) {
    const r = await call('POST', path, body, '8500000006');
    assert.equal(r.status, 403, path);
  }
}));

test('send-directory: eski yol /send/directory yoktur (404)', () => withServer(async ({ call }) => {
  const r = await call('POST', '/send/directory', { sender: 'MOCKTEST', text: 'a', groupIds: [7] });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, 'NOT_FOUND');
}));

test('send-directory: ileri startAt ile de status QUEUED; görev POST /cancel ile iptal edilemez (404)', () => withServer(async ({ call, clock, s }) => {
  const startAt = new Date(clock.now() + 2 * 3_600_000).toISOString();
  const r = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'Merhaba', groupIds: [7], startAt });
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.deepEqual([b.status, b.review], ['QUEUED', 'NONE']);
  conforms('DirectorySendResponse', b);
  const job = s.ctx.jobs.get('8500000000', b.jobId);
  assert.equal(job.startMs, Math.floor(Date.parse(startAt) / 60_000) * 60_000, 'dakikaya yuvarlanır');
  const c = await call('POST', '/cancel', { jobId: b.jobId });
  assert.equal(c.status, 404);
  assert.equal((await c.json()).message, 'job not found for this account, or no longer waiting to be sent');
}));

test('send-directory: sender birebir (CASE_MISMATCH); iysFilter büyük/küçük harf duyarsız, bilinmeyen değer NONE', () => withServer(async ({ call }) => {
  const h = await (await call('POST', '/directory/send', { sender: 'mocktest', text: 'a', groupIds: [7] })).json();
  assert.deepEqual([h.code, h.message], ['REJECTED_HEADER', 'CASE_MISMATCH']);
  // 8500000008 İYS modunda değil: tanınan bir filtre reddedilir, bilinmeyen değer NONE sayılır
  const iys = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7], iysFilter: 'brand' }, '8500000008');
  const ib = await iys.json();
  assert.equal(iys.status, 422);
  assert.deepEqual([ib.code, ib.message], ['REJECTED_IYS', 'consent filtering cannot be applied to this sender or account']);
  assert.equal((await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7], iysFilter: 'bogus' }, '8500000008')).status, 202);
  assert.equal((await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7], iysFilter: 'Brand' })).status, 202);
}));

test('send-directory: metin sınırı DEFAULT 917 / TURKISH 888 (çğışĞİŞ iki karakter), alfanümerik başlıkta 5 eksik', () => withServer(async ({ call }) => {
  const send = (text, encoding, sender = 'MOCKTEST') => call('POST', '/directory/send', { sender, text, encoding, groupIds: [7] });
  assert.equal((await send('a'.repeat(917), 'DEFAULT', '8500000000')).status, 202);
  assert.equal((await send('a'.repeat(912), 'DEFAULT')).status, 202);
  assert.equal((await send('ş'.repeat(444), 'TURKISH', '8500000000')).status, 202);
  const over = await send('ş'.repeat(445), 'TURKISH', '8500000000');
  assert.equal(over.status, 400);
  assert.equal((await over.json()).message, 'text exceeds 888 characters for this encoding and sender');
  const alpha = await send('ö'.repeat(884), 'TURKISH');
  assert.equal(alpha.status, 400);
  assert.equal((await alpha.json()).message, 'text exceeds 883 characters for this encoding and sender');
  const schema = await send('a'.repeat(918), 'DEFAULT');
  assert.equal(schema.status, 400);
  assert.equal((await schema.json()).message, '1 field(s) rejected');
}));

test('send-directory: 400 mesajları (N field(s) rejected, okunamayan gövde)', () => withServer(async ({ call }) => {
  const msgOf = async (body) => { const r = await call('POST', '/directory/send', body); assert.equal(r.status, 400, JSON.stringify(body)); return r.json(); };
  const missing = await msgOf({ groupIds: [7] });
  assert.equal(missing.message, '2 field(s) rejected');
  assert.deepEqual(missing.violations.map(v => v.field).sort(), ['sender', 'text']);
  const contact = await msgOf({ sender: 'MOCKTEST', text: 'a', contacts: [{ number: '' }] });
  assert.equal(contact.message, '1 field(s) rejected');
  assert.equal(contact.violations[0].field, 'contacts[0].number');
  // Türü uymayan değer: tek ihlal, diğer ihlallerin yerine geçer (eksik text burada bildirilmez).
  for (const [body, field, message] of [
    [{ sender: 'MOCKTEST', text: 'a', groupIds: [7], encoding: 'turkish' }, 'encoding', 'must be one of DEFAULT, TURKISH, UNICODE (case sensitive)'],
    [{ sender: 'MOCKTEST', text: 'a', groupIds: [7], startAt: '2026-09-10T09:00:00' }, 'startAt', 'must be an ISO-8601 date-time with an offset, e.g. 2026-09-10T09:00:00+03:00'],
    [{ sender: 'MOCKTEST', text: 'a', groupIds: [7, 'x'] }, 'groupIds[1]', 'must be a number'],
    [{ sender: 'MOCKTEST', groupIds: [7], contacts: [{ number: { n: 5 } }] }, 'contacts[0].number', 'must be a string'],
    [{ sender: 'MOCKTEST', text: 'a', groupIds: [7], addressType: 'abc' }, 'addressType', 'must be a number'],
    [{ sender: 'MOCKTEST', text: 'a', groupIds: 7 }, 'groupIds', 'must be an array'],
    [{ sender: 'MOCKTEST', text: 'a', groupIds: [true] }, 'groupIds[0]', 'must be a number'],
  ]) {
    const b = await msgOf(body);
    assert.equal(b.message, '1 field(s) rejected', JSON.stringify(body));
    assert.deepEqual(b.violations, [{ field, message }], JSON.stringify(body));
  }
  // UNICODE bağlamadan geçer, kendi mesajıyla reddedilir.
  const unicode = await msgOf({ sender: 'MOCKTEST', text: 'a', groupIds: [7], encoding: 'UNICODE' });
  assert.equal(unicode.message, 'encoding UNICODE is not supported for directory sends');
}));

test('send-directory: stopAt başlangıçtan 1 ile 21 saat sonra olmalı', () => withServer(async ({ call, clock }) => {
  const at = (h) => new Date(clock.now() + h * 3_600_000).toISOString();
  const send = (startAt, stopAt) => call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7], startAt, stopAt });
  assert.equal((await send(at(1), at(2))).status, 202);
  assert.equal((await send(at(1), at(22))).status, 202);
  assert.equal((await send(undefined, at(5))).status, 202);
  for (const [a, b] of [[at(1), at(1.5)], [at(1), at(22.5)], [at(2), at(1)]]) {
    const r = await send(a, b);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'INVALID_SEND_WINDOW');
  }
}));

test('send-template: 400 mesajları N field(s) rejected ve okunamayan gövde; boşluktan oluşan sender 400', () => withServer(async ({ call }) => {
  const blank = await (await call('POST', '/send/template', { sender: '   ', templates: [tpl()] })).json();
  assert.equal(blank.message, '1 field(s) rejected');
  assert.deepEqual(blank.violations, [{ field: 'sender', message: 'must not be blank' }]);
  for (const [extra, field, message] of [
    [{ encoding: 'turkish' }, 'encoding', 'must be one of DEFAULT, TURKISH, UNICODE (case sensitive)'],
    [{ startAt: '2026-09-10T09:00:00' }, 'startAt', 'must be an ISO-8601 date-time with an offset, e.g. 2026-09-10T09:00:00+03:00'],
    [{ templates: [tpl(), { ...tpl(), templateId: 'abc' }] }, 'templates[1].templateId', 'must be a number'],
    [{ templates: [{ ...tpl(), params: { otpCode: [1234] } }] }, 'templates[0].params.otpCode', 'must be a string'],
    [{ templates: 'x' }, 'templates', 'must be an array'],
  ]) {
    const r = await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [tpl()], ...extra });
    assert.equal(r.status, 400);
    const b = await r.json();
    assert.equal(b.message, '1 field(s) rejected', JSON.stringify(extra));
    assert.deepEqual(b.violations, [{ field, message }], JSON.stringify(extra));
  }
}));

test('tür bağlama diğer JSON gövdeli uçlarda da: otp, length, cancel, senders/default, webhooks', () => withServer(async ({ call }) => {
  for (const [method, path, body, field, message] of [
    ['POST', '/send/otp', { sender: 'MOCKTEST', text: 'kod', recipient: { n: 5061234567 } }, 'recipient', 'must be a string'],
    ['POST', '/length', { text: 'a', alphanumericSender: 'evet' }, 'alphanumericSender', 'must be true or false'],
    ['POST', '/length', { text: 'a', encoding: 'turkish' }, 'encoding', 'must be one of DEFAULT, TURKISH, UNICODE (case sensitive)'],
    ['POST', '/cancel', { jobId: [123] }, 'jobId', 'must be a string'],
    ['PUT', '/senders/default', { name: ['MOCKTEST'] }, 'name', 'must be a string'],
    ['POST', '/webhooks/report', { url: { href: 'https://example.com' } }, 'url', 'must be a string'],
  ]) {
    const r = await call(method, path, body);
    assert.equal(r.status, 400, path);
    const b = await r.json();
    assert.equal(b.message, '1 field(s) rejected', path);
    assert.deepEqual(b.violations, [{ field, message }], path);
  }
}));

test('gevşek bağlama: skaler değerler dönüştürülür, normal doğrulama dönüştürülmüş değerle sürer', () => withServer(async ({ call }) => {
  // tam sayı alanında sayısal metin ve kesirli sayı
  assert.equal((await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [{ ...tpl(), templateId: '3' }] })).status, 202);
  assert.equal((await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [{ ...tpl(), templateId: 3.7 }] })).status, 202);
  assert.equal((await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: ['7'], addressType: '1' })).status, 202);
  // metin alanında sayı
  assert.equal((await call('POST', '/send/template', { sender: 'MOCKTEST', templates: [{ ...tpl(), params: { otpCode: 123456 } }] })).status, 202);
  assert.equal((await call('POST', '/send/otp', { sender: 'MOCKTEST', text: 'kod', recipient: 5061234567 })).status, 202);
  assert.equal((await call('POST', '/cancel', { jobId: 123 })).status, 404, 'jobId "123" olarak aranır');
  // boolean: true/false ve "true"/"false"
  assert.equal((await (await call('POST', '/length', { text: 'a', alphanumericSender: 'true' })).json()).length, 6);
  // enum sıra numarası: 1 TURKISH; UNICODE (2) rehberde kendi mesajını alır
  assert.equal((await (await call('POST', '/length', { text: 'a', encoding: 1 })).json()).encoding, 'TURKISH');
  const uni = await call('POST', '/directory/send', { sender: 'MOCKTEST', text: 'a', groupIds: [7], encoding: 2 });
  assert.equal((await uni.json()).message, 'encoding UNICODE is not supported for directory sends');
}));
