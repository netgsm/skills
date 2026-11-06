import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measure, fitsSend } from '../src/sms/length.mjs';
import { createMockServer } from '../src/server.mjs';

test('spec örneği birebir', () => {
  assert.deepEqual(measure('Merhaba, şifreniz 123456', 'TURKISH', true),
    { encoding: 'TURKISH', length: 30, parts: 1, limit: 888, fits: true, remaining: 858, remainingUntilNextPart: 125 });
});

test('boş metin sıfır parça', () => {
  const m = measure('', 'DEFAULT', false);
  assert.equal(m.parts, 0);
  assert.equal(m.remainingUntilNextPart, 160);
  assert.equal(m.remaining, 917);
});

test('limit sınırında fits, bir fazlasında fits=false ve negatif remaining', () => {
  assert.equal(measure('a'.repeat(917), 'DEFAULT', false).fits, true);
  const over = measure('a'.repeat(918), 'DEFAULT', false);
  assert.equal(over.fits, false);
  assert.equal(over.remaining, -1);
  assert.equal(over.remainingUntilNextPart, 0);
  assert.equal(measure('a'.repeat(913), 'DEFAULT', true).fits, false);
  assert.equal(measure('a'.repeat(912), 'DEFAULT', true).fits, true);
  assert.equal(fitsSend('a'.repeat(918)), false);
  assert.equal(fitsSend('a'.repeat(917)), true);
});

test('UNICODE limiti 396', () => {
  assert.equal(measure('😀'.repeat(1), 'UNICODE', false).limit, 396);
});

test('varsayılanlar: DEFAULT, alfanümerik değil', () => {
  assert.deepEqual(measure('abc'), measure('abc', 'DEFAULT', false));
});

// parça sınırları: tek parça kapasitesi / birleştirilmiş parça başına kapasite
test('DEFAULT: 160 tek parça, 161 iki parça; 306 iki, 307 üç', () => {
  assert.equal(measure('a'.repeat(160), 'DEFAULT').parts, 1);
  assert.equal(measure('a'.repeat(160), 'DEFAULT').remainingUntilNextPart, 0);
  const two = measure('a'.repeat(161), 'DEFAULT');
  assert.equal(two.parts, 2);
  assert.equal(two.remainingUntilNextPart, 306 - 161);
  assert.equal(measure('a'.repeat(306), 'DEFAULT').parts, 2);
  assert.equal(measure('a'.repeat(307), 'DEFAULT').parts, 3);
  assert.equal(measure('a'.repeat(917), 'DEFAULT').parts, 6);
});

test('TURKISH: 155 tek parça, 156 iki parça; 296 iki, 297 üç', () => {
  assert.equal(measure('a'.repeat(155), 'TURKISH').parts, 1);
  assert.equal(measure('a'.repeat(155), 'TURKISH').remainingUntilNextPart, 0);
  const two = measure('a'.repeat(156), 'TURKISH');
  assert.equal(two.parts, 2);
  assert.equal(two.remainingUntilNextPart, 296 - 156);
  assert.equal(measure('a'.repeat(296), 'TURKISH').parts, 2);
  assert.equal(measure('a'.repeat(297), 'TURKISH').parts, 3);
  assert.equal(measure('a'.repeat(888), 'TURKISH').parts, 6);
  assert.equal(measure('a'.repeat(889), 'TURKISH').fits, false);
});

test('UNICODE: 70 tek parça, 71 iki parça; 132 iki, 133 üç', () => {
  assert.equal(measure('a'.repeat(70), 'UNICODE').parts, 1);
  assert.equal(measure('a'.repeat(70), 'UNICODE').remainingUntilNextPart, 0);
  const two = measure('a'.repeat(71), 'UNICODE');
  assert.equal(two.parts, 2);
  assert.equal(two.remainingUntilNextPart, 132 - 71);
  assert.equal(measure('a'.repeat(132), 'UNICODE').parts, 2);
  assert.equal(measure('a'.repeat(133), 'UNICODE').parts, 3);
  assert.equal(measure('a'.repeat(396), 'UNICODE').parts, 6);
  assert.equal(measure('a'.repeat(397), 'UNICODE').fits, false);
});

test('kaçışlı karakterler: yalnız TURKISH altında çğışĞİŞ iki sayılır', () => {
  // TURKISH: 150 düz + çğışİ (5 kaçışlı) = 160 ağırlık -> tek parça kapasitesi (155) aşılır
  const t = measure('a'.repeat(150) + 'çğışİ', 'TURKISH');
  assert.equal(t.length, 160);
  assert.equal(t.parts, 2);
  assert.equal(t.remainingUntilNextPart, 296 - 160);
  assert.equal(measure('ç', 'TURKISH').length, 2);
  assert.equal(measure('ĞİŞ', 'TURKISH').length, 6);
  // ö ve ü GSM'de yerel: bir sayılır
  assert.equal(measure('öüÖÜ', 'TURKISH').length, 4);
  // DEFAULT ve UNICODE'da kaçış yok, UTF-16 birim sayısı
  assert.equal(measure('ç', 'DEFAULT').length, 1);
  assert.equal(measure('€{', 'DEFAULT').length, 2);
  assert.equal(measure('ç', 'UNICODE').length, 1);
});

test('UNICODE UTF-16 kod birimi sayar: emoji iki', () => {
  assert.equal(measure('😀', 'UNICODE').length, 2);
  assert.equal(measure('😀'.repeat(35), 'UNICODE').parts, 1);
  assert.equal(measure('😀'.repeat(36), 'UNICODE').parts, 2);
});

test('alfanümerik gönderici length değerine +5 ekler, limit değişmez', () => {
  const m = measure('a'.repeat(156), 'DEFAULT', true);
  assert.equal(m.length, 161);
  assert.equal(m.parts, 2);
  assert.equal(m.limit, 917);
  assert.equal(m.remaining, 917 - 161);
  assert.equal(measure('', 'DEFAULT', true).parts, 1);
});

async function withServer(fn) {
  const s = createMockServer({ port: 0, log: () => {} });
  try {
    const base = await s.listen();
    const res = await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '8500000000', password: 'password001', scope: 'sms' }) });
    const { access_token } = await res.json();
    await fn(base, access_token);
  } finally { await s.close(); }
}
const post = (base, token, body) => fetch(`${base}/sms/v3/length`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

test('HTTP: spec örneği 200', async () => {
  await withServer(async (base, token) => {
    const r = await post(base, token, { text: 'Merhaba, şifreniz 123456', encoding: 'TURKISH', alphanumericSender: true });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(),
      { encoding: 'TURKISH', length: 30, parts: 1, limit: 888, fits: true, remaining: 858, remainingUntilNextPart: 125 });
  });
});

test('HTTP: varsayılanlar ve aşan metin 200', async () => {
  await withServer(async (base, token) => {
    const r = await post(base, token, { text: 'a'.repeat(920) });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.encoding, 'DEFAULT'); assert.equal(b.fits, false); assert.equal(b.remaining, -3); assert.equal(b.parts, 7);
    const e = await post(base, token, { text: '', encoding: null, alphanumericSender: null });
    assert.equal(e.status, 200);
    assert.equal((await e.json()).parts, 0);
  });
});

test('HTTP: geçersiz istekler 400 INVALID_REQUEST', async () => {
  await withServer(async (base, token) => {
    for (const body of [{ text: 'x'.repeat(10001) }, { text: 'a', encoding: 'XYZ' }, {}, { text: { t: 5 } }, { text: 'a', alphanumericSender: 'evet' }]) {
      const r = await post(base, token, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal((await r.json()).code, 'INVALID_REQUEST');
    }
    assert.equal((await post(base, token, { text: 'x'.repeat(10000) })).status, 200);
  });
});

test('HTTP: token yok 401', async () => {
  await withServer(async (base) => {
    const r = await post(base, null, { text: 'a' });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'UNAUTHENTICATED');
  });
});
