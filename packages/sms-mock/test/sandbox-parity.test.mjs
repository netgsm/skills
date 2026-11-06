// SMS sandbox'ıyla ortak davranış: sabit veri (TESTHEADER, şablon 1, kara liste), `profile` kapsamlı
// token ile 8500000001 / 8500000003'ün SMS API yanıtları ve doğrulama ihlallerinin sayımı.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';

const PASSWORDS = { '8500000000': 'password001', '8500000001': 'password002', '8500000003': 'password004' };
const MSG = [{ text: 'a', recipient: '905061234567' }];

async function withServer(fn) {
  const s = createMockServer({ port: 0, log: () => {}, rateScale: 100 });
  try {
    const base = await s.listen();
    const token = async (username, scope) => {
      const r = await fetch(`${base}/auth/v3/token`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORDS[username], scope }),
      });
      return { status: r.status, body: await r.json() };
    };
    const call = async (tok, method, path, body) => {
      const headers = { authorization: `Bearer ${tok}` };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(`${base}/sms/v3${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : undefined };
    };
    await fn({ token, call });
  } finally { await s.close(); }
}

// Sandbox'taki uç noktalar (webhook'lar hariç) ve her birine geçerli bir istek.
const ENDPOINTS = [
  ['POST', '/send', { sender: 'TESTHEADER', messages: MSG }],
  ['POST', '/send/template', { sender: 'TESTHEADER', templates: [{ templateId: 1, params: { name: 'Ali', code: '1234' }, recipient: '905061234567' }] }],
  ['POST', '/send/otp', { sender: 'TESTHEADER', text: 'Kod: 1234', recipient: '5061234567' }],
  ['POST', '/directory/send', { sender: 'TESTHEADER', text: 'Merhaba', groupIds: [7] }],
  ['GET', '/inbox'],
  ['POST', '/length', { text: 'a' }],
  ['GET', '/report'],
  ['GET', '/senders'],
  ['GET', '/senders/default'],
  ['GET', '/templates'],
  ['GET', '/blacklist'],
  ['GET', '/balance'],
];
const ok = (status) => status >= 200 && status < 300;

test('8500000001 ve 8500000003: sms kapsamı 403, profile kapsamı token alır', () => withServer(async ({ token }) => {
  assert.equal((await token('8500000001', 'sms')).body.code, 'service_not_activated');
  assert.equal((await token('8500000003', 'sms')).body.code, 'sub_user_not_permitted');
  assert.equal((await token('8500000001', 'profile')).status, 200);
  assert.equal((await token('8500000003', 'profile')).status, 200);
}));

test('profile token, 8500000001: gönderim ve gelen kutusu 403 account is not activated, diğerleri başarılı', () => withServer(async ({ token, call }) => {
  const t = (await token('8500000001', 'profile')).body.access_token;
  const denied = new Set(['/send', '/send/template', '/send/otp', '/directory/send', '/inbox']);
  for (const [method, path, body] of ENDPOINTS) {
    const r = await call(t, method, path, body);
    if (denied.has(path)) {
      assert.equal(r.status, 403, path);
      assert.deepEqual([r.body.code, r.body.message], ['FORBIDDEN', 'account is not activated for this operation'], path);
    } else {
      assert.ok(ok(r.status), `${path}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  // iptal ve istatistik de hesap yetkisi ister ama aktivasyon istemez: bilinmeyen görev 404 (403 değil)
  assert.equal((await call(t, 'POST', '/cancel', { jobId: '123' })).status, 404);
  assert.equal((await call(t, 'GET', '/stats?jobId=123')).status, 404);
}));

test('profile token, 8500000003: /length, /blacklist ve /balance dışında 403 sub user may not use the sms api', () => withServer(async ({ token, call }) => {
  const t = (await token('8500000003', 'profile')).body.access_token;
  const allowed = new Set(['/length', '/blacklist', '/balance']);
  for (const [method, path, body] of [...ENDPOINTS, ['POST', '/cancel', { jobId: '123' }], ['GET', '/stats?jobId=123'], ['PUT', '/senders/default', { name: 'TESTHEADER' }]]) {
    const r = await call(t, method, path, body);
    if (allowed.has(path)) {
      assert.ok(ok(r.status), `${path}: ${r.status}`);
    } else {
      assert.equal(r.status, 403, path);
      assert.deepEqual([r.body.code, r.body.message], ['FORBIDDEN', 'sub user may not use the sms api'], path);
    }
  }
}));

test('sabit veri: TESTHEADER ile gönderim, şablon 1 ile gönderim, kara liste numaraları', () => withServer(async ({ token, call }) => {
  const t = (await token('8500000000', 'sms')).body.access_token;
  assert.equal((await call(t, 'POST', '/send', { sender: 'TESTHEADER', messages: MSG })).status, 202);
  assert.equal((await call(t, 'POST', '/send', { sender: 'testheader', messages: MSG })).body.message, 'CASE_MISMATCH');
  const tpl = await call(t, 'POST', '/send/template', ENDPOINTS[1][2]);
  assert.equal(tpl.status, 202);
  assert.equal(tpl.body.accepted, 1);
  const tooLong = await call(t, 'POST', '/send/template', { sender: 'TESTHEADER', templates: [{ templateId: 1, params: { name: 'Ali', code: '12345678901' }, recipient: '905061234567' }] });
  assert.deepEqual([tooLong.status, tooLong.body.message], [400, "param 'code' is not a valid TEXT"]);
  assert.equal((await call(t, 'POST', '/send/otp', ENDPOINTS[2][2])).status, 202);
  const bl = await call(t, 'GET', '/blacklist?number=5000000002');
  assert.deepEqual(bl.body, { count: 1, page: null, number: '5000000002', numbers: ['5000000002'] });
}));

test('doğrulama ihlalleri: N ihlal sayısıdır; boş sender iki ihlal, eksik ad must not be blank', () => withServer(async ({ token, call }) => {
  const t = (await token('8500000000', 'sms')).body.access_token;
  const viol = async (method, path, body) => {
    const r = await call(t, method, path, body);
    assert.equal(r.status, 400, path);
    return [r.body.message, r.body.violations];
  };
  const SIZE = { field: 'sender', message: 'size must be between 1 and 35' };
  const BLANK = { field: 'sender', message: 'must not be blank' };
  assert.deepEqual(await viol('POST', '/send', { sender: '', messages: [] }),
    ['3 field(s) rejected', [BLANK, SIZE, { field: 'messages', message: 'must not be empty' }]]);
  assert.deepEqual(await viol('POST', '/send/template', { sender: '', templates: ENDPOINTS[1][2].templates }),
    ['2 field(s) rejected', [BLANK, SIZE]]);
  assert.deepEqual(await viol('POST', '/directory/send', { sender: '', text: 'a', groupIds: [7] }), ['1 field(s) rejected', [BLANK]]);
  assert.deepEqual(await viol('POST', '/send/otp', { sender: '', text: '', recipient: '5061234567' }),
    ['2 field(s) rejected', [BLANK, { field: 'text', message: 'must not be blank' }]]);
  assert.deepEqual(await viol('PUT', '/senders/default', { name: '' }), ['1 field(s) rejected', [{ field: 'name', message: 'must not be blank' }]]);
  assert.deepEqual(await viol('POST', '/cancel', { jobId: '' }), ['1 field(s) rejected', [{ field: 'jobId', message: 'must not be blank' }]]);
  assert.deepEqual(await viol('POST', '/send', { sender: 'TESTHEADER', encoding: 'turkish', messages: MSG }),
    ['1 field(s) rejected', [{ field: 'encoding', message: 'must be one of DEFAULT, TURKISH, UNICODE (case sensitive)' }]]);
}));

test('bilinmeyen SMS yolu 404 NOT_FOUND no such endpoint (eski /send/directory dahil)', () => withServer(async ({ token, call }) => {
  const t = (await token('8500000000', 'sms')).body.access_token;
  const r = await call(t, 'POST', '/send/directory', { sender: 'TESTHEADER', text: 'a', groupIds: [7] });
  assert.deepEqual([r.status, r.body.code, r.body.message], [404, 'NOT_FOUND', 'no such endpoint']);
}));
