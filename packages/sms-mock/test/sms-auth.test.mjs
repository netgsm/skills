import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSchemaValidator, stripNulls } from '../src/sms/schema.mjs';
import { authenticate, authorize } from '../src/sms/auth.mjs';
import { createMockServer } from '../src/server.mjs';
import { smsSpec } from '../src/generated/specs.mjs';

const v = createSchemaValidator(smsSpec);

test('eksik zorunlu alan violation üretir', () => {
  assert.deepEqual(v.validate('SmsSendRequest', { messages: [{ text: 'a', recipient: '905061234567' }] }).map(x => x.field), ['sender']);
});

test('skipProperties ile messages öğeleri doğrulanmaz', () => {
  assert.deepEqual(v.validate('SmsSendRequest', { sender: 'X', messages: [{ recipient: 'bozuk' }] }, { skipProperties: ['messages.items'] }), []);
  assert.notDeepEqual(v.validate('SmsSendRequest', { sender: 'X', messages: [{ recipient: 'bozuk' }] }), []);
});

test('skipProperties spec nesnesini değiştirmez', () => {
  const before = JSON.stringify(smsSpec.components.schemas.SmsSendRequest);
  v.validate('SmsSendRequest', { sender: 'X', messages: [{}] }, { skipProperties: ['messages.items'] });
  assert.equal(JSON.stringify(smsSpec.components.schemas.SmsSendRequest), before);
});

test('iç içe alan yolu nokta notasyonudur', () => {
  const f = v.validate('SmsSendRequest', { sender: 'X', messages: [{ text: 5, recipient: '905061234567' }] }).map(x => x.field);
  assert.ok(f.some(x => x.startsWith('messages.0')), JSON.stringify(f));
});

test('null alan verilmemiş sayılır, bilinmeyen alan yok sayılır', () => {
  assert.deepEqual(v.validate('SmsSendRequest', stripNulls({ sender: 'X', messages: [{ text: 'a', recipient: '905061234567' }], encoding: null, extra: 1 })), []);
});

test('nullable enum null kabul eder, enum dışı değeri reddeder; spec değişmez', () => {
  const ok = { status: 'DELIVERED', failReason: null, messageCount: 1, totalParts: 1, domestic: true, charging: null, chargeDescription: null };
  assert.deepEqual(v.validate('StatEntry', ok), []);
  assert.deepEqual(v.validate('StatEntry', { ...ok, status: null }), []);
  assert.deepEqual(v.validate('StatEntry', { ...ok, failReason: 'NOPE' }).map(x => x.field), ['failReason']);
  assert.equal(smsSpec.components.schemas.StatEntry.properties.status.enum.includes(null), false);
});

test('stripNulls dizideki null elemanı korur', () => {
  assert.deepEqual(stripNulls({ a: null, m: [null, { b: null, c: 1 }] }), { m: [null, { c: 1 }] });
});

async function withServer(fn) {
  const s = createMockServer({ port: 0, log: () => {} });
  try {
    s.ctx.routes.add('GET', '/sms/v3/probe', (req) => {
      const a = authenticate(req, s.ctx);
      if ('status' in a) return a;
      return authorize(a.account, a.login, req.query.get('op') ?? 'SEND') ?? { status: 200, body: { ok: true } };
    });
    const base = await s.listen();
    await fn(base);
  } finally { await s.close(); }
}
const tokenFor = async (base, username, password) =>
  (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, scope: 'sms' }) })).json()).access_token;
const probe = (base, op, auth) => fetch(`${base}/sms/v3/probe?op=${op}`, { headers: auth ? { authorization: auth } : {} });

test('token yok / bozuk token', async () => {
  await withServer(async (base) => {
    let r = await probe(base, 'SEND');
    assert.equal(r.status, 401);
    let b = await r.json();
    assert.equal(b.code, 'UNAUTHENTICATED'); assert.equal(b.message, 'no bearer token');
    r = await probe(base, 'SEND', 'Basic abc');
    assert.equal((await r.json()).message, 'no bearer token');
    r = await probe(base, 'SEND', 'Bearer bozuk');
    b = await r.json();
    assert.equal(r.status, 401); assert.equal(b.message, 'invalid or expired token');
    r = await probe(base, 'SEND', 'bearer a b');
    assert.equal((await r.json()).message, 'no bearer token');
  });
});

test('Bearer şeması büyük/küçük harfe duyarsız', async () => {
  await withServer(async (base) => {
    const t = await tokenFor(base, '8500000000', 'password001');
    assert.equal((await probe(base, 'SEND', `bEaReR ${t}`)).status, 200);
  });
});

test('operatör kapalı hesap SEND 403, REPORT 200', async () => {
  await withServer(async (base) => {
    const t = await tokenFor(base, '8500000006', 'password007');
    const r = await probe(base, 'SEND', `Bearer ${t}`);
    const b = await r.json();
    assert.equal(r.status, 403); assert.equal(b.code, 'FORBIDDEN'); assert.equal(b.message, 'account operator is not served for this operation');
    assert.equal((await probe(base, 'REPORT', `Bearer ${t}`)).status, 200);
  });
});

test('alt kullanıcısı olan hesapta ana hesap 8500000009 SEND 200', async () => {
  await withServer(async (base) => {
    assert.equal((await probe(base, 'SEND', `Bearer ${await tokenFor(base, '8500000009', 'password010')}`)).status, 200);
  });
});

test('authorize: sıra ve sabit mesajlar', () => {
  const acc = (o = {}) => ({ activations: { send: true, receive: true }, operatorOk: true, ...o });
  const main = { smsPermission: true }, sub = { smsPermission: false };
  assert.equal(authorize(acc(), main, 'SEND'), null);
  const a = authorize(acc({ activations: { send: false, receive: true } }), main, 'SEND');
  assert.equal(a.status, 403); assert.equal(a.body.code, 'FORBIDDEN'); assert.equal(a.body.message, 'account is not activated for this operation');
  assert.equal(authorize(acc({ activations: { send: false, receive: true } }), main, 'RECEIVE'), null);
  assert.equal(authorize(acc({ activations: { send: true, receive: false } }), main, 'RECEIVE').status, 403);
  assert.equal(authorize(acc({ activations: { send: false, receive: false } }), main, 'REPORT'), null);
  for (const op of ['SEND', 'RECEIVE', 'REPORT', 'USER']) assert.equal(authorize(acc(), sub, op).body.message, 'sub user may not use the sms api');
  assert.equal(authorize(acc({ operatorOk: false }), sub, 'SEND').body.message, 'sub user may not use the sms api');
  assert.equal(authorize(acc({ operatorOk: false }), main, 'USER'), null);
});
