// GET /sms/v3/balance: stip ve service, hesap başına sabit veri, 10 sn önbellek, dakikada 60 istek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createManualClock } from '../src/clock.mjs';
import { createSchemaValidator } from '../src/sms/schema.mjs';
import { smsSpec } from '../src/generated/specs.mjs';
import { parseStip, formatCredit, BALANCE_SERVICES } from '../src/sms/balance-routes.mjs';

const validator = createSchemaValidator(smsSpec);
const PASSWORDS = {
  '8500000000': 'password001', '8500000001': 'password002', '8500000003': 'password004',
  '8500000008': 'password009', '8500000009': 'password010', '8500000010': 'password012',
};

async function withServer(fn, { rateScale = 1 } = {}) {
  const clock = createManualClock(Date.UTC(2026, 10, 4, 9));
  const logs = [];
  const s = createMockServer({ port: 0, clock, rateScale, log: l => logs.push(l) });
  const base = await s.listen();
  try {
    const token = async (username = '8500000000', scope = 'sms') => (await (await fetch(`${base}/auth/v3/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORDS[username], scope }),
    })).json()).access_token;
    const tokens = {};
    const get = async (query = '', username = '8500000000', tok) => {
      tokens[username] ??= await token(username);
      const r = await fetch(`${base}/sms/v3/balance${query}`, { headers: { authorization: `Bearer ${tok ?? tokens[username]}` } });
      return { status: r.status, headers: r.headers, body: await r.json() };
    };
    await fn({ s, clock, get, token, base, logs });
  } finally { await s.close(); }
}

const listOk = (body) => assert.deepEqual(validator.validate('BalanceListResponse', body), []);

test('stip=3 spec örneğiyle aynı: tek kayıt metin, toplanan kayıt sayı, Kredi Bakiye sonda virgüllü metin', () => withServer(async ({ get }) => {
  const r = await get('?stip=3');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    balance: [
      { amount: 277, balance_name: 'Adet SMS' },
      { amount: '767', balance_name: 'Adet OTP SMS' },
      { amount: '242', balance_name: 'Dakika' },
      { amount: '92,150', balance_name: 'Kredi Bakiye' },
    ],
  });
  listOk(r.body);
}));

test('service verilmemesi service=sms ile aynı değildir: varsayılan liste OTP SMS paketini de içerir', () => withServer(async ({ get }) => {
  const names = async (q) => (await get(q)).body.balance.map(e => e.balance_name);
  assert.deepEqual(await names(''), ['Adet SMS', 'Adet OTP SMS', 'Dakika']);
  assert.deepEqual(await names('?service='), ['Adet SMS', 'Adet OTP SMS', 'Dakika'], 'boş service verilmemiş sayılır');
  assert.deepEqual(await names('?service=sms'), ['Adet SMS']);
  assert.deepEqual(await names('?service=otp'), ['Adet OTP SMS']);
  assert.deepEqual(await names('?service=SES'), ['Dakika']);
}));

test('stip verilmezse ya da geçersizse 1: Kredi Bakiye listede yok, hata dönmez', () => withServer(async ({ get }) => {
  for (const q of ['', '?stip=1', '?stip=9', '?stip=abc', '?stip=']) {
    const r = await get(q);
    assert.equal(r.status, 200, q);
    assert.deepEqual(r.body.balance.map(e => e.balance_name), ['Adet SMS', 'Adet OTP SMS', 'Dakika'], q);
  }
  assert.equal(parseStip(null), 1);
  assert.equal(parseStip('2'), 2);
  assert.equal(parseStip('4'), 1);
}));

test('service: grubu sınırlar, büyük/küçük harf fark etmez; geçersiz değer 400', () => withServer(async ({ get }) => {
  assert.deepEqual((await get('?service=SMS')).body, { balance: [{ amount: 277, balance_name: 'Adet SMS' }] });
  assert.deepEqual((await get('?service=otp&stip=3')).body, {
    balance: [{ amount: '767', balance_name: 'Adet OTP SMS' }, { amount: '92,150', balance_name: 'Kredi Bakiye' }],
  });
  assert.deepEqual((await get('?service=fax')).body, { balance: [] }, 'varlık yoksa boş liste');
  const bad = await get('?service=email');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_REQUEST');
  assert.equal(bad.body.message, `service must be one of ${BALANCE_SERVICES.join(', ')}`);
  assert.equal(bad.body.message, 'service must be one of sms, otp, ses, fax, whatsapp, santral, netsipp, gsm, internet, numara, ai, ucret');
  assert.deepEqual(validator.validate('ApiError', bad.body), []);
}));

test('stip=2 özeti: kredi, AdetSMS, faturalı "0" ve alanları olmayan özet', () => withServer(async ({ get }) => {
  const cases = [
    ['8500000000', { code: '00', balance: '92,150' }],
    ['8500000008', { code: '00', balance: '1500', type: 'AdetSMS' }],
    ['8500000010', { code: '00', balance: '0' }],
    ['8500000009', { code: '00' }],
  ];
  for (const [user, expected] of cases) {
    const r = await get('?stip=2', user);
    assert.equal(r.status, 200, user);
    assert.deepEqual(r.body, expected, user);
    assert.deepEqual(validator.validate('BalanceSummaryResponse', r.body), [], user);
  }
  // özet service'ten etkilenmez
  assert.deepEqual((await get('?stip=2&service=ses')).body, { code: '00', balance: '92,150' });
  // faturasız, ne kredi ne paket: boş liste, stip=3 yalnızca Kredi Bakiye
  assert.deepEqual((await get('', '8500000009')).body, { balance: [] });
  assert.deepEqual((await get('?stip=3', '8500000009')).body, { balance: [{ amount: '0,000', balance_name: 'Kredi Bakiye' }] });
}));

test('geçerli bir token yeterli: profile kapsamlı token ve SMS yetkisi olmayan alt kullanıcı da sorgular', () => withServer(async ({ get, token }) => {
  for (const user of ['8500000001', '8500000003']) {
    const r = await get('?stip=2', user, await token(user, 'profile'));
    assert.equal(r.status, 200, user);
  }
}));

test('401: token yok ya da geçersiz', () => withServer(async ({ base, get }) => {
  const none = await fetch(`${base}/sms/v3/balance`);
  assert.equal(none.status, 401);
  assert.equal((await none.json()).code, 'UNAUTHENTICATED');
  assert.equal((await get('', '8500000000', 'gecersiz')).status, 401);
}));

test('önbellek: aynı hesap + stip + service için 10 sn aynı yanıt; süre dolunca güncel değer', () => withServer(async ({ s, clock, get }) => {
  assert.equal((await get('?stip=2')).body.balance, '92,150');
  s.ctx.accounts.get('8500000000').balance.credit = 50; // gönderim sonrası değişen bakiye
  clock.advance(9_000);
  assert.equal((await get('?stip=2')).body.balance, '92,150', '10 sn içinde önbellekten');
  assert.equal((await get('?stip=3')).body.balance.at(-1).amount, '50,000', 'farklı stip ayrı önbellek');
  clock.advance(1_000);
  assert.equal((await get('?stip=2')).body.balance, '50,000');
}));

test('dakikada 60 istek; 61. istek 429 RATE_LIMITED + Retry-After, pencere sabit, önbellekten dönen istek de sayılır', () => withServer(async ({ clock, get }) => {
  for (let i = 0; i < 60; i++) assert.equal((await get('?stip=2')).status, 200, `istek ${i + 1}`);
  clock.advance(20_000);
  const r = await get('?stip=2');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RATE_LIMITED');
  assert.equal(r.body.message, 'balance rate limit exceeded');
  assert.equal(r.headers.get('retry-after'), '40');
  assert.equal((await get('?service=bogus')).status, 429, 'her istek sayılır');
  assert.equal((await get('', '8500000008')).status, 200, 'sınır hesap başınadır');
  clock.advance(40_000);
  assert.equal((await get('?stip=2')).status, 200, 'yeni pencere');
}));

test('advisor: bakiye döngüde sorgulanırsa BALANCE_POLLING; açıklama Retry-After ve önbelleği anlatır', () => withServer(async ({ base, get, logs }) => {
  for (let i = 0; i < 10; i++) await get('?stip=2');
  const findings = (await (await fetch(`${base}/__mock/advice`)).json()).findings.map(f => f.rule);
  assert.deepEqual(findings, ['BALANCE_POLLING']);
  assert.ok(logs.some(l => l.includes('⚠') && l.includes('GET /sms/v3/balance')));
}, { rateScale: 1 }));

test('formatCredit: üç ondalık, virgül', () => {
  assert.equal(formatCredit(92.15), '92,150');
  assert.equal(formatCredit(0), '0,000');
  assert.equal(formatCredit(1234.5), '1234,500');
});
