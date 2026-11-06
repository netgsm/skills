import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createManualClock } from '../src/clock.mjs';
import { createSchemaValidator } from '../src/sms/schema.mjs';
import { authorize } from '../src/sms/auth.mjs';
import { smsSpec } from '../src/generated/specs.mjs';

const validator = createSchemaValidator(smsSpec);
const A = '8500000000';
const B = '8500000008';
const PASSWORDS = { [A]: 'password001', [B]: 'password009' };

async function withServer(fn) {
  const clock = createManualClock();
  const s = createMockServer({ port: 0, log: () => {}, clock });
  try {
    const base = await s.listen();
    const tokens = {};
    const tok = async (u = A) => (tokens[u] ??= (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PASSWORDS[u], scope: 'sms' }) })).json()).access_token);
    const call = async (method, path, { body, user = A, auth = true, token } = {}) => {
      const headers = { accept: 'application/json' };
      if (auth) headers.authorization = `Bearer ${token ?? await tok(user)}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(`${base}/sms/v3${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
    };
    const inbound = async (body) => {
      const r = await fetch(`${base}/__mock/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const noSms = () => s.ctx.sessions.open({ accountId: A, identity: 'sub:1', subUserId: 1, smsPermission: false }, 'sms').accessToken;
    return await fn({ s, clock, call, inbound, noSms });
  } finally { await s.close(); }
}
const valid = (name, body) => assert.deepEqual(validator.validate(name, body), [], `${name} şemaya uymuyor`);

test('senders: 4 kayıt; TESTHEADER (sandbox başlığı) kullanılabilir; MOCKKAPALI kullanılamaz olarak işaretli', () => withServer(async ({ call }) => {
  const r = await call('GET', '/senders');
  assert.equal(r.status, 200);
  valid('SendersResponse', r.body);
  assert.equal(r.body.count, 4);
  const byName = Object.fromEntries(r.body.senders.map(x => [x.name, x]));
  assert.equal(byName.MOCKTEST.usable, true);
  assert.equal(byName.MOCKTEST.reason, null);
  assert.deepEqual(byName.TESTHEADER, { name: 'TESTHEADER', type: 'ALPHANUMERIC', brandCode: 4567, usable: true, reason: null });
  assert.equal(byName.MOCKKAPALI.usable, false);
  assert.equal(byName.MOCKKAPALI.reason, 'ROUTING_CODE_MISSING');
  assert.equal(byName[A].type, 'SUBSCRIBER_NUMBER');
}));

test('senders: SMS menüsü olmayan alt kullanıcı 403, token yoksa 401', () => withServer(async ({ call, noSms }) => {
  assert.equal((await call('GET', '/senders', { token: noSms() })).status, 403);
  assert.equal((await call('GET', '/senders/default', { token: noSms() })).status, 403);
  assert.equal((await call('GET', '/senders', { auth: false })).status, 401);
}));

test('senders: okuma sayacı /senders ve /senders/default için ortak, dakikada 60', () => withServer(async ({ call, clock }) => {
  for (let i = 0; i < 30; i++) assert.equal((await call('GET', '/senders')).status, 200);
  for (let i = 0; i < 30; i++) assert.equal((await call('GET', '/senders/default')).status, 200);
  const r = await call('GET', '/senders');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RATE_LIMITED');
  assert.equal(r.body.message, 'sender read rate limit exceeded');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  clock.advance(60_000);
  assert.equal((await call('GET', '/senders')).status, 200);
}));

test('senders/default: GET varsayılanı döner; PUT abone numarası → 200, GET yeni değeri döner', () => withServer(async ({ call }) => {
  let r = await call('GET', '/senders/default');
  assert.equal(r.status, 200);
  valid('DefaultSenderResponse', r.body);
  assert.equal(r.body.sender.name, 'MOCKTEST');
  r = await call('PUT', '/senders/default', { body: { name: A } });
  assert.equal(r.status, 200);
  valid('DefaultSenderResponse', r.body);
  assert.equal(r.body.sender.name, A);
  assert.equal(r.body.sender.type, 'SUBSCRIBER_NUMBER');
  r = await call('GET', '/senders/default');
  assert.equal(r.body.sender.name, A);
}));

test('senders/default: kullanılamayan başlık da varsayılan yapılabilir (spec); 200, usable false ve reason dolu', () => withServer(async ({ call }) => {
  const r = await call('PUT', '/senders/default', { body: { name: 'MOCKKAPALI' } });
  assert.equal(r.status, 200);
  valid('DefaultSenderResponse', r.body);
  assert.equal(r.body.sender.usable, false);
  assert.equal(r.body.sender.reason, 'ROUTING_CODE_MISSING');
}));

test('senders/default: varsayılan ayarlanmamışsa sender açıkça null', () => withServer(async ({ call, s }) => {
  s.ctx.accounts.get(A).defaultSender = null;
  const r = await call('GET', '/senders/default');
  assert.equal(r.status, 200);
  valid('DefaultSenderResponse', r.body);
  assert.equal(r.body.sender, null);
}));

test('senders/default: PUT kayıtsız ad 422 NOT_REGISTERED, harf farkı CASE_MISMATCH, boş ad 400', () => withServer(async ({ call }) => {
  let r = await call('PUT', '/senders/default', { body: { name: 'YOKBOYLE' } });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'REJECTED_HEADER');
  assert.equal(r.body.message, 'NOT_REGISTERED');
  r = await call('PUT', '/senders/default', { body: { name: 'mocktest' } });
  assert.equal(r.body.message, 'CASE_MISMATCH');
  r = await call('PUT', '/senders/default', { body: { name: '90' + A } });
  assert.equal(r.body.message, 'NOT_REGISTERED');
  r = await call('PUT', '/senders/default', { body: { name: '' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_REQUEST');
  assert.ok(r.body.violations.some(v => v.field === 'name'));
  r = await call('PUT', '/senders/default', { body: {} });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/senders/default')).body.sender.name, 'MOCKTEST');
}));

test('senders/default: PUT saatte 4 deneme (reddedilenler dahil), 5.si 429; 1 saat sonra açılır', () => withServer(async ({ call, clock }) => {
  for (let i = 0; i < 2; i++) assert.equal((await call('PUT', '/senders/default', { body: { name: 'MOCKTEST' } })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await call('PUT', '/senders/default', { body: { name: 'YOK' } })).status, 422);
  const r = await call('PUT', '/senders/default', { body: { name: 'MOCKTEST' } });
  assert.equal(r.status, 429);
  assert.equal(r.body.message, 'default sender change rate limit exceeded');
  clock.advance(3_600_000);
  assert.equal((await call('PUT', '/senders/default', { body: { name: 'MOCKTEST' } })).status, 200);
}));

test('inbox: /__mock/inbound sonrası mesaj listede, alanlar InboxMessage şemasına uyar', () => withServer(async ({ call, inbound, clock }) => {
  let r = await call('GET', '/inbox');
  assert.equal(r.status, 200);
  valid('InboxResponse', r.body);
  assert.deepEqual(r.body, { count: 0, messages: [], truncated: false });

  const created = await inbound({ username: A, from: '905061234567', text: 'Merhaba' });
  assert.equal(created.status, 201);
  assert.equal(created.body.text, 'Merhaba');
  clock.advance(1000);
  r = await call('GET', '/inbox');
  valid('InboxResponse', r.body);
  assert.equal(r.body.count, 1);
  const m = r.body.messages[0];
  assert.equal(m.sender, '5061234567');
  assert.equal(m.text, 'Merhaba');
  assert.equal(m.jobId, null);
  assert.equal(m.operator, 'NETGSM MOBIL');
  assert.match(m.receivedAt, /\+03:00$/);
  assert.equal(typeof m.id, 'string');
  // başka hesabın kutusunda görünmez
  assert.equal((await call('GET', '/inbox', { user: B })).body.count, 0);
}));

test('inbox: startAt/stopAt aralığı filtreler; tek sınır, ters aralık, 2 aydan geniş ve bozuk tarih 400', () => withServer(async ({ call, s, clock }) => {
  const now = clock.now();
  s.ctx.inbox.add(A, { from: '905061234567', text: 'eski', receivedAt: now - 40 * 86_400_000 });
  s.ctx.inbox.add(A, { from: '905061234567', text: 'yeni', receivedAt: now });
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  let r = await call('GET', `/inbox?startAt=${iso(now - 41 * 86_400_000)}&stopAt=${iso(now - 39 * 86_400_000)}`);
  assert.equal(r.status, 200);
  valid('InboxResponse', r.body);
  assert.deepEqual(r.body.messages.map(x => x.text), ['eski']);

  const bad = async (qs, msg) => {
    const x = await call('GET', `/inbox${qs}`);
    assert.equal(x.status, 400, qs);
    assert.equal(x.body.code, 'INVALID_REQUEST');
    if (msg) assert.equal(x.body.message, msg);
  };
  await bad(`?startAt=${iso(now)}`, 'startAt and stopAt must be sent together, or neither');
  await bad(`?startAt=${iso(now)}&stopAt=${iso(now - 1000)}`, 'stopAt must not be before startAt');
  await bad(`?startAt=${iso(now - 70 * 86_400_000)}&stopAt=${iso(now)}`);
  await bad('?startAt=dun&stopAt=bugun', 'startAt is not an ISO-8601 date-time');
}));

test('inbox: alım hizmeti kapalı hesap → 403 FORBIDDEN (authorize birim testi)', () => withServer(async ({ s }) => {
  const account = s.ctx.accounts.get(A);
  const login = { accountId: A, identity: 'main', subUserId: 0, smsPermission: true };
  const denied = authorize({ ...account, activations: { send: true, receive: false } }, login, 'RECEIVE');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'FORBIDDEN');
  assert.equal(authorize(account, login, 'RECEIVE'), null);
}));

test('inbox: SMS menüsü olmayan alt kullanıcı 403; dakikada 60 istek, 61. istek 429', () => withServer(async ({ call, noSms }) => {
  assert.equal((await call('GET', '/inbox', { token: noSms() })).status, 403);
  for (let i = 0; i < 60; i++) assert.equal((await call('GET', '/inbox')).status, 200);
  const r = await call('GET', '/inbox');
  assert.equal(r.status, 429);
  assert.equal(r.body.message, 'inbox rate limit exceeded');
}));

test('inbox: 500 mesaj sınırı truncated=true döner', () => withServer(async ({ call, s }) => {
  for (let i = 0; i < 501; i++) s.ctx.inbox.add(A, { from: '905061234567', text: `m${i}` });
  const r = await call('GET', '/inbox');
  assert.equal(r.body.count, 500);
  assert.equal(r.body.truncated, true);
  valid('InboxResponse', r.body);
}));

test('__mock/inbound: bilinmeyen kullanıcı 404, eksik alan 400; onAdd dinleyicisi çağrılır', () => withServer(async ({ inbound, s }) => {
  const seen = [];
  s.ctx.inbox.onAdd((accountId, m) => seen.push([accountId, m.text]));
  let r = await inbound({ username: '0000', from: '905061234567', text: 'x' });
  assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string');
  r = await inbound({ username: A, from: '905061234567' });
  assert.equal(r.status, 400);
  assert.equal(seen.length, 0);
  r = await inbound({ username: A, from: '905061234567', text: 'selam' });
  assert.equal(r.status, 201);
  assert.deepEqual(seen, [[A, 'selam']]);
  assert.equal(s.ctx.inbox.all(A).length, 1);
}));

test('blacklist: aynı sorgu 10 dk içinde 429; farklı page 200; 10 dk sonra yeniden 200', () => withServer(async ({ call, clock }) => {
  let r = await call('GET', '/blacklist?page=0');
  assert.equal(r.status, 200);
  valid('BlacklistResponse', r.body);
  assert.deepEqual(r.body, { count: 2, page: 0, number: null, numbers: ['5000000001', '5000000002'] });
  r = await call('GET', '/blacklist?page=0');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RATE_LIMITED');
  assert.equal(r.body.message, 'the same blacklist query was made too recently');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await call('GET', '/blacklist?page=1')).status, 200);
  clock.advance(10 * 60_000 - 1);
  assert.equal((await call('GET', '/blacklist?page=0')).status, 429);
  clock.advance(1);
  assert.equal((await call('GET', '/blacklist?page=0')).status, 200);
}));

test('blacklist: liste en yeniden eskiye, 200lük sayfalar; tek numara sorgusu', () => withServer(async ({ call, s }) => {
  const list = s.ctx.accounts.get(A).blacklist;
  list.length = 0; // sandbox'la ortak iki numara bu sınamada yok sayılır
  for (let i = 0; i < 250; i++) list.push(`90506${String(1000000 + i).padStart(7, '0')}`);
  let r = await call('GET', '/blacklist');
  assert.equal(r.status, 200);
  valid('BlacklistResponse', r.body);
  assert.equal(r.body.count, 200);
  assert.equal(r.body.page, 0);
  assert.equal(r.body.numbers[0], list[249]);
  r = await call('GET', '/blacklist?page=1');
  assert.equal(r.body.count, 50);
  assert.equal(r.body.numbers[49], list[0]);
  r = await call('GET', '/blacklist?page=9');
  assert.deepEqual([r.body.count, r.body.numbers], [0, []]);

  r = await call('GET', `/blacklist?number=${list[3]}`);
  valid('BlacklistResponse', r.body);
  assert.deepEqual(r.body, { count: 1, page: null, number: list[3], numbers: [list[3]] });
  r = await call('GET', '/blacklist?number=905000000000');
  assert.deepEqual(r.body, { count: 0, page: null, number: '905000000000', numbers: [] });
  r = await call('GET', '/blacklist?number=&page=2'); // boş number: sayfa isteği
  assert.equal(r.status, 200);
  assert.equal(r.body.page, 2);
  assert.equal(r.body.number, null);
}));

test('blacklist: hatalı girdi 400 ve sayaca yazılmaz; hesap sayacı dakikada 60, mesajı ayrı', () => withServer(async ({ call }) => {
  for (const qs of ['?page=-1', '?page=abc', '?number=12ab', '?number=1234567890123456']) {
    const r = await call('GET', `/blacklist${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.code, 'INVALID_REQUEST');
  }
  for (let i = 0; i < 60; i++) assert.equal((await call('GET', `/blacklist?page=${i}`)).status, 200);
  const r = await call('GET', '/blacklist?page=100');
  assert.equal(r.status, 429);
  assert.equal(r.body.message, 'blacklist rate limit exceeded');
}));

test('blacklist: SMS menüsü olmayan alt kullanıcı da okuyabilir (işlem yetkisi aranmaz); token yoksa 401', () => withServer(async ({ call, noSms }) => {
  assert.equal((await call('GET', '/blacklist', { token: noSms() })).status, 200);
  assert.equal((await call('GET', '/blacklist', { auth: false })).status, 401);
}));
