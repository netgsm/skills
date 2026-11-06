import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createClock } from '../src/clock.mjs';

const json = (b) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
async function start(opts = {}) { const clock = createClock(); const s = createMockServer({ port: 0, log: () => {}, clock, ...opts }); return { s, clock, base: await s.listen() }; }
// Test hesaplarının şifreleri (src/accounts.mjs); 8500000009 için ana hesap şifresi.
const PASSWORDS = {
  '8500000000': 'password001', '8500000001': 'password002', '8500000002': 'password003', '8500000003': 'password004',
  '8500000004': 'password005', '8500000005': 'password006', '8500000006': 'password007', '8500000007': 'password008',
  '8500000008': 'password009', '8500000009': 'password010',
};
const SUB_PASSWORD = 'password011'; // 8500000009 hesabının API alt kullanıcısı (sub_user_id 1)
const U = '8500000000'; // her şey açık, ana hesap
const login = (base, username, password = PASSWORDS[username], scope = 'sms') => fetch(`${base}/auth/v3/token`, json({ username, password, scope }));

test('alt kullanıcıyla token: RFC 6749 yanıtı', async () => {
  const { s, base } = await start();
  const r = await login(base, '8500000009', SUB_PASSWORD);
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.token_type, 'Bearer');
  assert.equal(b.expires_in, 86400);
  assert.equal(b.scope, 'sms');
  assert.equal(b.sub_user_id, 1);
  assert.match(b.refresh_token, /^[0-9a-f-]{36}$/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('ratelimit-policy'), '30;w=60');
  await s.close();
});

test('ana hesap da token alır (sub_user_id 0)', async () => {
  const { s, base } = await start();
  assert.equal((await (await login(base, '8500000009')).json()).sub_user_id, 0);
  await s.close();
});

test('hesap kaynaklı 403 kodları', async () => {
  const { s, base } = await start();
  const cases = [['8500000004', 'api_access_denied'], ['8500000001', 'service_not_activated'],
    ['8500000002', 'ip_not_allowed'], ['8500000007', 'country_not_allowed'], ['8500000005', 'account_inactive']];
  for (const [u, code] of cases) {
    const r = await login(base, u);
    assert.equal(r.status, 403, u);
    assert.equal((await r.json()).code, code);
  }
  const sub = await (await login(base, '8500000003')).json();
  assert.equal(sub.code, 'sub_user_not_permitted');
  assert.deepEqual(sub.denied_scopes, ['sms']);
  // 8500000003'te ana hesap şifresi yok (sandbox ile aynı); ana hesap girişi 8500000009 ile sınanır.
  await s.close();
});

test('sandbox eşliği: 8500000000–8500000005 Identity sandbox demo hesaplarıyla aynı davranır', async () => {
  const { s, base } = await start();
  const me = async a => (await fetch(`${base}/auth/v3/me`, { headers: { authorization: `Bearer ${a.access_token}` } })).json();
  try {
    const expected = [['8500000000', 200, undefined], ['8500000001', 403, 'service_not_activated'],
      ['8500000002', 403, 'ip_not_allowed'], ['8500000003', 403, 'sub_user_not_permitted'],
      ['8500000004', 403, 'api_access_denied'], ['8500000005', 403, 'account_inactive']];
    for (const [u, status, code] of expected) {
      const r = await login(base, u);
      assert.equal(r.status, status, u);
      assert.equal((await r.json()).code, code, u);
    }
    // Aktivasyonsuz hesap: aktivasyon gerektirmeyen kapsamlar açık, diğer hizmetler kapalı.
    assert.equal((await login(base, '8500000001', PASSWORDS['8500000001'], 'profile')).status, 200);
    assert.equal((await login(base, '8500000001', PASSWORDS['8500000001'], 'financial')).status, 200);
    assert.equal((await login(base, '8500000001', PASSWORDS['8500000001'], 'voice')).status, 403);
    // Yetkisiz alt kullanıcı hizmet dışı kapsamla token alır; /me alt kullanıcıyı gösterir.
    const p = await login(base, '8500000003', PASSWORDS['8500000003'], 'profile');
    assert.equal(p.status, 200);
    const pb = await p.json();
    assert.equal(pb.sub_user_id, 4001);
    assert.equal((await me(pb)).user_id, 900004);
    const ok = await (await login(base, '8500000000')).json();
    assert.equal(ok.user_id, 900001);
    assert.equal(ok.sub_user_id, 0);
  } finally { await s.close(); }
});

test('hatalı şifre 401, 5 hatadan sonra 429 too_many_failed_attempts', async () => {
  const { s, base } = await start();
  for (let i = 0; i < 5; i++) assert.equal((await login(base, U, 'yanlis')).status, 401);
  const r = await login(base, U, 'yanlis');
  assert.equal(r.status, 429);
  const b = await r.json();
  assert.equal(b.code, 'too_many_failed_attempts');
  assert.ok(b.retry_after > 0);
  await s.close();
});

test('geçersiz scope 422 validation_failed, errors.scope dolu', async () => {
  const { s, base } = await start();
  const b = await (await login(base, U, PASSWORDS[U], 'all')).json();
  assert.equal(b.code, 'validation_failed');
  assert.ok(Array.isArray(b.errors.scope));
  await s.close();
});

test('sms sms:send istenirse sms:send verilir', async () => {
  const { s, base } = await start();
  assert.equal((await (await login(base, U, PASSWORDS[U], 'sms sms:send')).json()).scope, 'sms:send');
  await s.close();
});

test('refresh yalnızca o oturumun eski access token ını geçersiz kılar', async () => {
  const { s, base } = await start();
  const a = await (await login(base, U)).json();
  const b = await (await login(base, U)).json();
  const r = await (await fetch(`${base}/auth/v3/token/refresh`, json({ refresh_token: a.refresh_token }))).json();
  const me = t => fetch(`${base}/auth/v3/me`, { headers: { authorization: `Bearer ${t}` } });
  assert.equal((await me(a.access_token)).status, 401);
  assert.equal((await me(r.access_token)).status, 200);
  assert.equal((await me(b.access_token)).status, 200);
  await s.close();
});

test('revoke sonrası refresh 401 invalid_refresh_token', async () => {
  const { s, base } = await start();
  const a = await (await login(base, U)).json();
  const rv = await fetch(`${base}/auth/v3/token/revoke`, { method: 'POST', headers: { authorization: `Bearer ${a.access_token}` } });
  assert.equal(rv.status, 204);
  const r = await fetch(`${base}/auth/v3/token/refresh`, json({ refresh_token: a.refresh_token }));
  assert.equal((await r.json()).code, 'invalid_refresh_token');
  await s.close();
});

test('token süresi dolunca invalid_token', async () => {
  const { s, base, clock } = await start({ tokenTtlSec: 60 });
  const a = await (await login(base, U)).json();
  assert.equal(a.expires_in, 60);
  clock.advance(61_000);
  const r = await fetch(`${base}/auth/v3/me`, { headers: { authorization: `Bearer ${a.access_token}` } });
  assert.equal((await r.json()).code, 'invalid_token');
  await s.close();
});

test('ana hesap ve alt kullanıcı birbirinin önceki oturumunu düşürür', async () => {
  const { s, base } = await start();
  const me = t => fetch(`${base}/auth/v3/me`, { headers: { authorization: `Bearer ${t}` } });
  const s1 = await (await login(base, '8500000009', SUB_PASSWORD)).json();
  const m1 = await (await login(base, '8500000009')).json();
  assert.equal((await me(s1.access_token)).status, 200);
  const s2 = await (await login(base, '8500000009', SUB_PASSWORD)).json();
  assert.equal((await me(s1.access_token)).status, 401);
  assert.equal((await me(m1.access_token)).status, 200);
  assert.equal((await me(s2.access_token)).status, 200);
  await s.close();
});

test('/me scope=sms alanları', async () => {
  const { s, base } = await start();
  const a = await (await login(base, U)).json();
  const b = await (await fetch(`${base}/auth/v3/me`, { headers: { authorization: `Bearer ${a.access_token}` } })).json();
  assert.deepEqual(Object.keys(b).sort(), ['contract_accepted', 'sub_user', 'sub_user_id', 'user_code', 'user_id', 'username']);
  await s.close();
});

// --- Ek doğrulama ve uç durum testleri ----------------------------------

const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('JSON kökü nesne değilse (dizi, null) 422 validation_failed', async () => {
  const { s, base } = await start();
  for (const raw of ['[]', 'null', '5']) {
    const r = await post(base, '/auth/v3/token', raw);
    const b = await r.json();
    assert.equal(r.status, 422, raw);
    assert.equal(b.code, 'validation_failed');
    assert.deepEqual(Object.keys(b.errors).sort(), ['password', 'scope', 'username']);
  }
  const r = await post(base, '/auth/v3/token/refresh', '[]');
  assert.equal(r.status, 422);
  assert.ok((await r.json()).errors.refresh_token);
  await s.close();
});

test('query string ile kimlik bilgisi 422', async () => {
  const { s, base } = await start();
  const r = await fetch(`${base}/auth/v3/token?password=x`, json({ username: U, password: PASSWORDS[U], scope: 'sms' }));
  const b = await r.json();
  assert.equal(r.status, 422);
  assert.ok(b.errors.password);
  const r2 = await fetch(`${base}/auth/v3/token/refresh?refresh_token=abc`, json({ refresh_token: 'abc' }));
  assert.equal(r2.status, 422);
  await s.close();
});

test('form gövdesi kabul edilir; eksik alanlar errors ile döner', async () => {
  const { s, base } = await start();
  const form = body => fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal((await form(`username=${U}&password=${PASSWORDS[U]}&scope=sms`)).status, 200);
  const r = await form(`username=${U}`);
  const b = await r.json();
  assert.equal(r.status, 422);
  assert.deepEqual(Object.keys(b.errors).sort(), ['password', 'scope']);
  await s.close();
});

test('8500000006 ve 8500000008 token alır', async () => {
  const { s, base } = await start();
  assert.equal((await login(base, '8500000006')).status, 200);
  assert.equal((await login(base, '8500000008')).status, 200);
  await s.close();
});

test('service_not_activated denied_scopes taşır', async () => {
  const { s, base } = await start();
  const b = await (await login(base, '8500000001')).json();
  assert.deepEqual(b.denied_scopes, ['sms']);
  await s.close();
});

test('başarılı giriş hatalı giriş sayacını sıfırlar', async () => {
  const { s, base } = await start();
  for (let i = 0; i < 4; i++) await login(base, U, 'yanlis');
  assert.equal((await login(base, U)).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await login(base, U, 'yanlis')).status, 401);
  await s.close();
});

test('hatalı giriş kilidi pencere dolunca açılır', async () => {
  const { s, base, clock } = await start();
  for (let i = 0; i < 5; i++) await login(base, U, 'yanlis');
  assert.equal((await login(base, U)).status, 429);
  clock.advance(61_000);
  assert.equal((await login(base, U)).status, 200);
  await s.close();
});

test('rate_limited: Retry-After, retry_after ve RateLimit-* başlıkları (rateScale)', async () => {
  const { s, base } = await start({ rateScale: 0.1 });
  for (let i = 0; i < 3; i++) {
    const r = await login(base, U);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('ratelimit-limit'), '3');
    assert.equal(r.headers.get('ratelimit-remaining'), String(2 - i));
    assert.equal(r.headers.get('ratelimit-policy'), '3;w=60');
  }
  const r = await login(base, U);
  const b = await r.json();
  assert.equal(r.status, 429);
  assert.equal(b.code, 'rate_limited');
  assert.ok(b.retry_after > 0);
  assert.equal(r.headers.get('retry-after'), String(b.retry_after));
  assert.equal(r.headers.get('ratelimit-remaining'), '0');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('pragma'), 'no-cache');
  await s.close();
});

test('/me: token başına 60/dk, başlıklar 401 yanıtlarında da bulunur', async () => {
  const { s, base } = await start({ rateScale: 0.1 });
  const a = await (await login(base, U)).json();
  const me = t => fetch(`${base}/auth/v3/me`, { headers: { authorization: `Bearer ${t}` } });
  for (let i = 0; i < 6; i++) assert.equal((await me(a.access_token)).status, 200);
  const r = await me(a.access_token);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'rate_limited');
  const bad = await me('yok');
  assert.equal(bad.status, 401);
  assert.ok(bad.headers.get('ratelimit-limit'));
  assert.equal(bad.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  await s.close();
});

test('Bearer yoksa 401 invalid_token; refresh UUID değilse 401 invalid_refresh_token', async () => {
  const { s, base } = await start();
  assert.equal((await (await fetch(`${base}/auth/v3/me`)).json()).code, 'invalid_token');
  assert.equal((await fetch(`${base}/auth/v3/token/revoke`, { method: 'POST' })).status, 401);
  const r = await post(base, '/auth/v3/token/refresh', JSON.stringify({ refresh_token: 'abc' }));
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'invalid_refresh_token');
  await s.close();
});

test('access token imzasız JWT: exp çözülebilir', async () => {
  const { s, base, clock } = await start();
  const a = await (await login(base, U)).json();
  const [h, p, sig] = a.access_token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'none', typ: 'JWT' });
  const c = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(c.scope, 'sms');
  assert.equal(c.exp - c.iat, 86400);
  assert.ok(Math.abs(c.iat * 1000 - clock.now()) < 5000);
  assert.ok(sig.length > 10);
  await s.close();
});

test('ctx.sessions.resolve hata durumları ve ctx.accounts', async () => {
  const { s, base, clock } = await start({ tokenTtlSec: 60 });
  const { sessions, accounts } = s.ctx;
  assert.deepEqual(sessions.resolve('x'), { error: 'invalid' });
  const a = await (await login(base, U)).json();
  const ok = sessions.resolve(a.access_token);
  assert.equal(ok.login.subUserId, 0);
  assert.equal(accounts.get(ok.login.accountId).username, U);
  await post(base, '/auth/v3/token/refresh', JSON.stringify({ refresh_token: a.refresh_token }));
  assert.deepEqual(sessions.resolve(a.access_token), { error: 'superseded' });
  const b = await (await login(base, U)).json();
  clock.advance(61_000);
  assert.deepEqual(sessions.resolve(b.access_token), { error: 'expired' });
  const c = await (await login(base, U)).json();
  await fetch(`${base}/auth/v3/token/revoke`, { method: 'POST', headers: { authorization: `Bearer ${c.access_token}` } });
  assert.deepEqual(sessions.resolve(c.access_token), { error: 'revoked' });
  const acc = accounts.get(ok.login.accountId);
  assert.deepEqual(acc.senders.map(x => x.name), ['MOCKTEST', 'TESTHEADER', 'MOCKKAPALI', U]);
  assert.equal(acc.defaultSender, 'MOCKTEST');
  await s.close();
});

test('scope tablosu: /me alanları kapsamlara göre', async () => {
  const { s, base } = await start();
  const me = async scope => {
    const a = await (await login(base, U, PASSWORDS[U], scope)).json();
    return (await fetch(`${base}/auth/v3/me`, { headers: { authorization: `Bearer ${a.access_token}` } })).json();
  };
  assert.deepEqual(Object.keys(await me('email')).sort(), ['email', 'user_id']);
  assert.deepEqual(Object.keys(await me('profile')).sort(), ['contract_accepted', 'email', 'first_name', 'last_name', 'user_code', 'user_id', 'username']);
  assert.equal((await me('sms')).sub_user, null);
  await s.close();
});

test('boş, eksik ya da tanınmayan scope: 422 errors.scope izin verilen değerleri listeler', async () => {
  const { s, base } = await start();
  try {
    for (const scope of ['', '   ', undefined, 'all']) {
      const r = await fetch(`${base}/auth/v3/token`, json({ username: U, password: PASSWORDS[U], scope }));
      assert.equal(r.status, 422, String(scope));
      const b = await r.json();
      assert.equal(b.code, 'validation_failed');
      const msg = b.errors.scope.join(' ');
      assert.match(msg, /İzin verilen değerler: .*\bsms\b/, String(scope));
      assert.match(msg, /sms:send/, String(scope));
    }
  } finally { await s.close(); }
});
