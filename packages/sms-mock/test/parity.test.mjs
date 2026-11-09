// İstek işleme sırasının ve gövde okumanın gerçek API ile eşliği: kimlik doğrulama gövdeden önce,
// gövdesiz revoke, UTF-8 BOM'lu JSON, gövdesi zorunlu uçta boş gövde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { UNREADABLE_BODY } from '../src/sms/api-error.mjs';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SEND = { sender: 'MOCKTEST', messages: [{ text: 'a', recipient: '905061234567' }] };

async function withServer(fn, opts = {}) {
  const s = createMockServer({ port: 0, log: () => {}, rateScale: 100, ...opts });
  try {
    const base = await s.listen();
    const login = async () => (await (await fetch(`${base}/auth/v3/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '8500000000', password: 'password001', scope: 'sms' }),
    })).json());
    await fn({ base, login });
  } finally { await s.close(); }
}

const req = (base, method, path, { auth, headers = {}, body } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(auth ? { authorization: auth } : {}), ...headers }, body });

test('SMS API: token yok ya da geçersizse gövde hiç okunmadan 401 döner', () => withServer(async ({ base }) => {
  const J = { 'content-type': 'application/json' };
  const bodies = [
    [J, '{bozuk'], [J, ''], [J, '[1]'], [J, 'null'], [J, '{}'],
    [{ 'content-type': 'text/plain' }, 'merhaba'],
    [{ ...J, 'content-encoding': 'gzip' }, '{}'],
    [{}, ''],
  ];
  const paths = [['POST', '/sms/v3/send'], ['POST', '/sms/v3/length'], ['POST', '/sms/v3/cancel'], ['PUT', '/sms/v3/senders/default']];
  for (const [method, path] of paths) {
    for (const [headers, body] of bodies) {
      for (const [auth, message] of [[undefined, 'no bearer token'], ['Bearer bozuk', 'invalid or expired token']]) {
        const r = await req(base, method, path, { auth, headers, body });
        const b = await r.json();
        const label = `${method} ${path} ${JSON.stringify(headers)} ${JSON.stringify(body)} ${auth}`;
        assert.equal(r.status, 401, label);
        assert.deepEqual([b.code, b.message], ['UNAUTHENTICATED', message], label);
      }
    }
  }
}));

test('SMS API: token yoksa sınırı aşan gövde de 413 değil 401 alır', () => withServer(async ({ base }) => {
  const r = await req(base, 'POST', '/sms/v3/send', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(200) }) });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'UNAUTHENTICATED');
}, { bodyLimits: { sms: 100 } }));

test('SMS API: geçerli token ile gövde hataları değişmez (bozuk JSON 400, text/plain 415)', () => withServer(async ({ base, login }) => {
  const auth = `Bearer ${(await login()).access_token}`;
  const bad = await req(base, 'POST', '/sms/v3/send', { auth, headers: { 'content-type': 'application/json' }, body: '{bozuk' });
  assert.deepEqual([bad.status, (await bad.json()).message], [400, UNREADABLE_BODY]);
  const plain = await req(base, 'POST', '/sms/v3/send', { auth, headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(plain.status, 415);
}));

test('SMS API: gövdesi zorunlu uçta Content-Type olmadan boş gövde de okunamayan gövdedir', () => withServer(async ({ base, login }) => {
  const auth = `Bearer ${(await login()).access_token}`;
  for (const [method, path] of [['POST', '/sms/v3/send'], ['POST', '/sms/v3/length'], ['POST', '/sms/v3/cancel'], ['PUT', '/sms/v3/senders/default']]) {
    const r = await req(base, method, path, { auth });
    const b = await r.json();
    assert.deepEqual([r.status, b.code, b.message, b.violations], [400, 'INVALID_REQUEST', UNREADABLE_BODY, null], path);
  }
}));

test('Identity: revoke gövde istemez; boş JSON gövdeyle de 204', () => withServer(async ({ base, login }) => {
  for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/x-www-form-urlencoded' }, {}]) {
    const t = await login();
    const r = await req(base, 'POST', '/auth/v3/token/revoke', { auth: `Bearer ${t.access_token}`, headers, body: '' });
    assert.equal(r.status, 204, JSON.stringify(headers));
    // oturum gerçekten kapandı
    const me = await req(base, 'GET', '/auth/v3/me', { auth: `Bearer ${t.access_token}` });
    assert.equal(me.status, 401);
  }
}));

test('Identity: revoke gövdeyi okumaz; geçersiz token bozuk gövdeyle de 401 invalid_token alır', () => withServer(async ({ base, login }) => {
  for (const auth of [undefined, 'Bearer bozuk']) {
    const r = await req(base, 'POST', '/auth/v3/token/revoke', { auth, headers: { 'content-type': 'application/json' }, body: '{bozuk' });
    assert.equal(r.status, 401, String(auth));
    assert.equal((await r.json()).code, 'invalid_token');
  }
  const t = await login();
  const ok = await req(base, 'POST', '/auth/v3/token/revoke', { auth: `Bearer ${t.access_token}`, headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(ok.status, 204);
}));

test('UTF-8 BOM ile başlayan JSON gövde kabul edilir (SMS, Identity, kontrol uçları)', () => withServer(async ({ base, login }) => {
  const tok = await req(base, 'POST', '/auth/v3/token', {
    headers: { 'content-type': 'application/json' },
    body: Buffer.concat([BOM, Buffer.from(JSON.stringify({ username: '8500000000', password: 'password001', scope: 'sms' }))]),
  });
  assert.equal(tok.status, 200);
  const auth = `Bearer ${(await tok.json()).access_token}`;
  const send = await req(base, 'POST', '/sms/v3/send', {
    auth, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.concat([BOM, Buffer.from(JSON.stringify(SEND))]),
  });
  assert.equal(send.status, 202);
  const len = await req(base, 'POST', '/sms/v3/length', { auth, headers: { 'content-type': 'application/json' }, body: Buffer.concat([BOM, Buffer.from('{"text":"a"}')]) });
  assert.equal(len.status, 200);
  const clock = await req(base, 'POST', '/__mock/clock', { headers: { 'content-type': 'application/json' }, body: Buffer.concat([BOM, Buffer.from('{"advanceSeconds":1}')]) });
  assert.equal(clock.status, 200);
  // Yalnızca BOM'dan oluşan gövde boş gövdedir.
  const only = await req(base, 'POST', '/sms/v3/length', { auth, headers: { 'content-type': 'application/json' }, body: BOM });
  assert.deepEqual([only.status, (await only.json()).message], [400, UNREADABLE_BODY]);
}));

test('Content-Type parametresi ve harf büyüklüğü önemsizdir', () => withServer(async ({ base, login }) => {
  const auth = `Bearer ${(await login()).access_token}`;
  for (const ct of ['application/json; charset=utf-8', 'Application/JSON', 'application/json;charset=UTF-8']) {
    const r = await req(base, 'POST', '/sms/v3/length', { auth, headers: { 'content-type': ct }, body: '{"text":"a"}' });
    assert.equal(r.status, 200, ct);
  }
}));
