import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createClock } from '../src/clock.mjs';
import { createJobStore, deliveryOf, isReportable } from '../src/jobs.mjs';
import { resolveSendWindow, checkSender, checkIys } from '../src/sms/send.mjs';

// Kullanılan test hesaplarının şifreleri (src/accounts.mjs).
const PASSWORDS = { '8500000000': 'password001', '8500000006': 'password007', '8500000008': 'password009' };

async function withServer(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const clock = createClock();
  const s = createMockServer({ port: 0, log: () => {}, clock, ...opts });
  try {
    const base = await s.listen();
    const tok = async (u = '8500000000') => (await (await fetch(`${base}/auth/v3/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PASSWORDS[u], scope: 'sms' }) })).json()).access_token;
    const send = async (body, t) => fetch(`${base}/sms/v3/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t ?? await tok()}` }, body: JSON.stringify(body) });
    return await fn({ s, clock, base, tok, send });
  } finally { await s.close(); }
}
const msg = (recipient, text = 'Merhaba') => ({ text, recipient });

test('202: kısmi başarı, accepted + rejected = kayıt sayısı', () => withServer(async ({ send, s }) => {
  const r = await send({ sender: 'MOCKTEST', messages: [msg('905061234567'), msg('05061234567'), null, msg('905061234568', '')], referenceId: 'order-4711' });
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.equal(b.status, 'QUEUED');
  assert.equal(b.accepted, 1);
  assert.equal(b.rejected, 3);
  assert.deepEqual(b.rejectedItems.map(x => [x.index, x.reason]), [[1, 'INVALID_RECIPIENT'], [2, 'MALFORMED_ENTRY'], [3, 'INVALID_MESSAGE']]);
  assert.equal(b.rejectedItems[1].recipient, null);
  assert.equal(b.referenceId, 'order-4711');
  assert.match(b.jobId, /^\d{10}$/);
  const job = s.ctx.jobs.get('8500000000', b.jobId);
  assert.equal(job.kind, 'SEND');
  assert.equal(job.records.length, 1);
}));

test('DUPLICATE_RECIPIENT: son kayıt gönderilir', () => withServer(async ({ send }) => {
  const b = await (await send({ sender: 'MOCKTEST', messages: [msg('905061234567', 'a'), msg('905061234567', 'b')] })).json();
  assert.deepEqual(b.rejectedItems.map(x => [x.index, x.reason]), [[0, 'DUPLICATE_RECIPIENT']]);
}));

test('hepsi hatalıysa 422 NO_DELIVERABLE_MESSAGES ve rejectedItems', () => withServer(async ({ send }) => {
  const r = await send({ sender: 'MOCKTEST', messages: [msg('123')] });
  const b = await r.json();
  assert.equal(r.status, 422);
  assert.equal(b.code, 'NO_DELIVERABLE_MESSAGES');
  assert.equal(b.message, 'all 1 messages rejected');
  assert.equal(b.rejectedItems[0].reason, 'INVALID_RECIPIENT');
  assert.equal(b.rejectedItemsTruncated, false);
}));

test('rejectedItems 100 ile kesilir', () => withServer(async ({ send }) => {
  const b = await (await send({ sender: 'MOCKTEST', messages: [msg('905061234567'), ...Array.from({ length: 150 }, () => msg('bozuk'))] })).json();
  assert.equal(b.rejected, 150);
  assert.equal(b.rejectedItems.length, 100);
  assert.equal(b.rejectedItemsTruncated, true);
}));

test('kayıtsız ve kullanılamaz başlık 422 REJECTED_HEADER', () => withServer(async ({ send }) => {
  const want = { YOKBASLIK: 'NOT_REGISTERED', MOCKKAPALI: 'ROUTING_CODE_MISSING', mocktest: 'CASE_MISMATCH' };
  for (const sender of Object.keys(want)) {
    const r = await send({ sender, messages: [msg('905061234567')] });
    assert.equal(r.status, 422, sender);
    const b = await r.json();
    assert.equal(b.code, 'REJECTED_HEADER');
    assert.equal(b.message, want[sender]);
  }
}));

test('İYS modunda olmayan hesapta BRAND filtresi 422 REJECTED_IYS, yurt dışı kayıt NO_INTERNATIONAL_PERMISSION', () => withServer(async ({ send, tok }) => {
  const t = await tok('8500000008');
  const iys = await (await send({ sender: 'MOCKTEST', iysFilter: 'BRAND', messages: [msg('905061234567')] }, t)).json();
  assert.equal(iys.code, 'REJECTED_IYS');
  assert.equal(iys.message, 'account is not in iys mode, filtering cannot be applied');
  const b = await (await send({ sender: 'MOCKTEST', messages: [msg('905061234567'), msg('-4915112345678')] }, t)).json();
  assert.equal(b.rejectedItems[0].reason, 'NO_INTERNATIONAL_PERMISSION');
}));

test('operatörü uygun olmayan hesap 403 FORBIDDEN', () => withServer(async ({ send, tok }) => {
  assert.equal((await send({ sender: 'MOCKTEST', messages: [msg('905061234567')] }, await tok('8500000006'))).status, 403);
}));

test('mesaj sayısı 0 → 400', () => withServer(async ({ send }) => {
  assert.equal((await send({ sender: 'MOCKTEST', messages: [] })).status, 400);
}));

test('gönderim penceresi saat diliminden bağımsız', () => withServer(async ({ send, clock }) => {
  const now = clock.now();
  const at = (ms) => new Date(ms).toISOString();
  const plus0530 = (ms) => new Date(ms + 5.5 * 3600_000).toISOString().replace('Z', '+05:30');
  assert.equal((await (await send({ sender: 'MOCKTEST', startAt: at(now - 3600_000), messages: [msg('905061234567')] })).json()).status, 'QUEUED');
  assert.equal((await (await send({ sender: 'MOCKTEST', startAt: plus0530(now + 3600_000), messages: [msg('905061234567')] })).json()).status, 'SCHEDULED');
  const months = (n, days) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() + n); d.setUTCDate(d.getUTCDate() + days); return d.toISOString(); };
  assert.equal((await send({ sender: 'MOCKTEST', startAt: months(18, -1), messages: [msg('905061234567')] })).status, 202);
  const r = await send({ sender: 'MOCKTEST', startAt: months(18, 1), messages: [msg('905061234567')] });
  assert.equal((await r.json()).code, 'INVALID_SEND_WINDOW');
}));

test('100.000 kayıt 2 saniyenin altında', () => withServer(async ({ send, tok }) => {
  const t = await tok();
  const messages = Array.from({ length: 100_000 }, (_, i) => msg('90506' + String(i).padStart(7, '0')));
  const t0 = performance.now();
  const r = await send({ sender: 'MOCKTEST', messages }, t);
  assert.equal(r.status, 202);
  assert.equal((await r.json()).accepted, 100_000);
  const ms = performance.now() - t0;
  console.log(`100k send: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 2000);
}));

test('limit aşımı 429 Retry-After (rateScale ile)', () => withServer({ rateScale: 0.00002 }, async ({ send, tok }) => {
  const t = await tok();
  await send({ sender: 'MOCKTEST', messages: [msg('905061234567')] }, t);
  const r = await send({ sender: 'MOCKTEST', messages: [msg('905061234567')] }, t);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'RATE_LIMITED');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
}));

test('gövde hatası (400) kotayı harcamaz', () => withServer({ rateScale: 0.00002 }, async ({ send, tok }) => {
  const t = await tok();
  assert.equal((await send({ messages: [msg('905061234567')] }, t)).status, 400);
  assert.equal((await send({ sender: 'MOCKTEST', messages: 'x' }, t)).status, 400);
  assert.equal((await send({ sender: 'MOCKTEST', messages: [msg('905061234567')] }, t)).status, 202);
}));

test('pencere uzatma ve kısaltma', () => {
  const now = Date.UTC(2026, 0, 1);
  const iso = (ms) => new Date(ms).toISOString();
  const w1 = resolveSendWindow({ count: 1, nowMs: now });
  assert.deepEqual([w1.status, w1.startMs, w1.stopMs], ['QUEUED', now, now + 21 * 3600_000]);
  const w2 = resolveSendWindow({ startAt: iso(now), stopAt: iso(now + 60_000), count: 5, nowMs: now });
  assert.equal(w2.stopMs - w2.startMs, 5 * 60_000);
  const w3 = resolveSendWindow({ startAt: iso(now), stopAt: iso(now + 60_000), count: 1000, nowMs: now });
  assert.equal(w3.stopMs - w3.startMs, 10 * 60_000);
  const w4 = resolveSendWindow({ startAt: iso(now), stopAt: iso(now + 30 * 3600_000), count: 5, nowMs: now });
  assert.equal(w4.stopMs - w4.startMs, 21 * 3600_000);
});

test('job store ve deliveryOf', () => {
  const store = createJobStore({ clock: createClock() });
  const base = { accountId: 'A', kind: 'SEND', status: 'QUEUED', startMs: 1000, stopMs: 2000, sender: 'X', records: [], referenceId: null };
  const a = store.create(base);
  const b = store.create(base);
  assert.match(a.jobId, /^\d{10}$/);
  assert.notEqual(a.jobId, b.jobId);
  assert.equal(store.get('B', a.jobId), null);
  assert.equal(store.all('A').length, 2);
  const job = { startMs: 1000 };
  assert.equal(deliveryOf(job, { recipient: '905061234567' }, 5999).status, 'PENDING');
  assert.deepEqual(deliveryOf(job, { recipient: '905061234567' }, 6000), { status: 'DELIVERED', failReason: null, deliveredAt: 6000 });
  assert.deepEqual(deliveryOf(job, { recipient: '905061234500' }, 6000), { status: 'NOT_DELIVERED', failReason: 'UNKNOWN_SUBSCRIBER', deliveredAt: null });
});

test('deliveryOf: iptal edilen görev başlangıçtan sonra da teslim edilmiş görünmez; isReportable', () => {
  const job = { startMs: 1000, status: 'CANCELLED', kind: 'SEND' };
  assert.deepEqual(deliveryOf(job, { recipient: '905061234567' }, 60_000), { status: 'PENDING', failReason: null, deliveredAt: null });
  assert.equal(isReportable(job), false);
  assert.equal(isReportable({ kind: 'OTP', status: 'QUEUED' }), false);
  assert.equal(isReportable({ kind: 'DIRECTORY', status: 'SCHEDULED' }), true);
});

test('checkSender / checkIys yardımcıları', () => {
  const acc = { senders: [{ name: 'A', usable: true, brandCode: 0 }], iysMode: true };
  assert.equal(checkSender(acc, 'A'), null);
  assert.equal(checkSender({ senders: [] }, 'A').body.message, 'NO_HEADERS_REGISTERED');
  assert.equal(checkIys(acc, 'NONE'), null);
  assert.equal(checkIys(acc, 'BRAND', 'A').body.message, 'sender header has no iys brand code');
  assert.equal(checkIys({ iysMode: false }, 'brand').status, 422);
  assert.equal(checkIys({ iysMode: false }, 'bogus'), null);
});

test('boş ya da eksik messages: gövde doğrulamasında 400 must not be empty (sandbox ile aynı)', () => withServer(async ({ send }) => {
  for (const body of [{ sender: 'YOKBASLIK', messages: [] }, { sender: 'MOCKTEST', messages: [] }, { sender: 'MOCKTEST' }]) {
    const r = await send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    const b = await r.json();
    assert.equal(b.code, 'INVALID_REQUEST');
    assert.equal(b.message, '1 field(s) rejected');
    assert.deepEqual(b.violations, [{ field: 'messages', message: 'must not be empty' }]);
  }
}));

test('İYS modundaki hesapta MOCKTEST + BRAND → 202; İYS modu dışında REJECTED_IYS', () => withServer(async ({ send, tok }) => {
  const r = await send({ sender: 'MOCKTEST', iysFilter: 'BRAND', messages: [msg('905061234567')] });
  assert.equal(r.status, 202);
  const r2 = await send({ sender: 'MOCKTEST', iysFilter: 'BRAND', messages: [msg('905061234567')] }, await tok('8500000008'));
  assert.equal(r2.status, 422);
}));

test('SCHEDULED eşiği dakikaya göre sayılır (elle saat)', () => {
  const now = Date.UTC(2026, 0, 1);
  const iso = (ms) => new Date(ms).toISOString();
  const st = (ms) => resolveSendWindow({ startAt: iso(now + ms), count: 1, nowMs: now }).status;
  assert.equal(st(60_500), 'QUEUED');
  assert.equal(st(119_000), 'QUEUED');
  assert.equal(st(120_000), 'SCHEDULED');
});

test('400 N field(s) rejected: eksik, boş ya da yalnızca boşluktan oluşan sender; uzun referenceId', () => withServer(async ({ send }) => {
  for (const [body, fields] of [
    [{ messages: [msg('905061234567')] }, ['sender']],
    [{ sender: '', messages: [msg('905061234567')] }, ['sender', 'sender']],
    [{ sender: '   ', messages: [msg('905061234567')] }, ['sender']],
    [{ sender: 'A'.repeat(36), messages: [msg('905061234567')] }, ['sender']],
    [{ sender: '  ', referenceId: 'x'.repeat(51), messages: [msg('905061234567')] }, ['sender', 'referenceId']],
    [{}, ['sender', 'messages']],
  ]) {
    const r = await send(body);
    const b = await r.json();
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(b.code, 'INVALID_REQUEST');
    assert.equal(b.message, `${fields.length} field(s) rejected`);
    assert.deepEqual(b.violations.map(v => v.field), fields);
  }
  const blank = await (await send({ sender: ' ', messages: [msg('905061234567')] })).json();
  assert.deepEqual(blank.violations, [{ field: 'sender', message: 'must not be blank' }]);
  // N ihlal sayısıdır: boş sender iki kuralı birden çiğner (sandbox: 3 field(s) rejected)
  const empty = await (await send({ sender: '', messages: [] })).json();
  assert.equal(empty.message, '3 field(s) rejected');
  assert.deepEqual(empty.violations, [
    { field: 'sender', message: 'must not be blank' },
    { field: 'sender', message: 'size must be between 1 and 35' },
    { field: 'messages', message: 'must not be empty' },
  ]);
  const missing = await (await send({})).json();
  assert.deepEqual(missing.violations, [
    { field: 'sender', message: 'must not be blank' },
    { field: 'messages', message: 'must not be empty' },
  ]);
  const long = await (await send({ sender: 'A'.repeat(36), messages: [msg('905061234567')] })).json();
  assert.deepEqual(long.violations, [{ field: 'sender', message: 'size must be between 1 and 35' }]);
}));

test('400 1 field(s) rejected: türü uymayan değer (bilinmeyen encoding, saat dilimsiz tarih, dizi olmayan messages) tek ihlal, değer yansıtılmaz', () => withServer(async ({ send }) => {
  const ENUM = 'must be one of DEFAULT, TURKISH, UNICODE (case sensitive)';
  const DATE = 'must be an ISO-8601 date-time with an offset, e.g. 2026-09-10T09:00:00+03:00';
  const cases = [
    [{ encoding: 'turkish' }, 'encoding', ENUM],
    [{ encoding: 'GSM' }, 'encoding', ENUM],
    [{ encoding: 'Unicode' }, 'encoding', ENUM],
    [{ startAt: '2026-09-10T09:00:00' }, 'startAt', DATE],
    [{ stopAt: 'yarın' }, 'stopAt', DATE],
    [{ messages: 'x' }, 'messages', 'must be an array'],
    [{ messages: { text: 'a' } }, 'messages', 'must be an array'],
    [{ messages: [msg('905061234567'), msg('905061234568'), { text: 'a', recipient: ['905061234569'] }] }, 'messages[2].recipient', 'must be a string'],
    [{ messages: [msg('905061234567'), 7] }, 'messages[1]', 'has an invalid value'],
    [{ sender: { name: 'MOCKTEST' } }, 'sender', 'must be a string'],
    [{ iysFilter: ['BRAND'] }, 'iysFilter', 'must be a string'],
    [{ encoding: 3 }, 'encoding', ENUM],
    [{ encoding: true }, 'encoding', ENUM],
    [{ startAt: true }, 'startAt', DATE],
    [{ messages: [{ text: { t: 'a' }, recipient: '905061234567' }] }, 'messages[0].text', 'must be a string'],
  ];
  for (const [extra, field, message] of cases) {
    const r = await send({ sender: 'MOCKTEST', messages: [msg('905061234567')], ...extra });
    const b = await r.json();
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(b.code, 'INVALID_REQUEST');
    assert.equal(b.message, '1 field(s) rejected', JSON.stringify(extra));
    assert.deepEqual(b.violations, [{ field, message }], JSON.stringify(extra));
    assert.ok(!JSON.stringify(b).includes('turkish') && !JSON.stringify(b).includes('yarın'), 'reddedilen değer yanıtta yok');
  }
  // Okuma ilk hatalı alanda durur (gövdedeki sırayla) ve diğer ihlallerin yerine geçer.
  const first = await (await send({ sender: '', stopAt: 'x', encoding: 'turkish', messages: [] })).json();
  assert.deepEqual(first.violations, [{ field: 'stopAt', message: DATE }]);
  const order = await (await send({ encoding: 'x', startAt: 'x', sender: 'MOCKTEST', messages: [msg('905061234567')] })).json();
  assert.deepEqual(order.violations, [{ field: 'encoding', message: ENUM }]);
  // Skaler değerler gerçek API'deki gibi dönüştürülür; ardından normal doğrulama çalışır.
  assert.equal((await send({ sender: 'MOCKTEST', messages: [{ text: 'a', recipient: 905061234567 }] })).status, 202, 'tırnaksız numara metne çevrilir');
  const bool = await (await send({ sender: 'MOCKTEST', messages: [{ text: 'a', recipient: true }] })).json();
  assert.equal(bool.code, 'NO_DELIVERABLE_MESSAGES');
  assert.equal(bool.rejectedItems[0].reason, 'INVALID_RECIPIENT');
  const sender = await (await send({ sender: 123, messages: [msg('905061234567')] })).json();
  assert.deepEqual([sender.code, sender.message], ['REJECTED_HEADER', 'NOT_REGISTERED']);
  assert.equal((await send({ sender: 'MOCKTEST', encoding: 1, messages: [msg('905061234567')] })).status, 202, 'enum sıra numarası');
  const epoch = await (await send({ sender: 'MOCKTEST', startAt: 1800000000, messages: [msg('905061234567')] })).json();
  assert.equal(epoch.status, 'SCHEDULED', 'sayı epoch saniyesi');
  // null değer türden bağımsızdır: alan verilmemiş sayılır.
  assert.equal((await send({ sender: 'MOCKTEST', encoding: null, startAt: null, messages: [msg('905061234567')] })).status, 202);
}));

test('400 request body could not be read as json yalnızca JSON sözdizimi hatasında; violations null', () => withServer(async ({ send, base, tok }) => {
  const bad = await fetch(`${base}/sms/v3/send`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await tok()}` }, body: '{bozuk' });
  assert.equal(bad.status, 400);
  const b = await bad.json();
  assert.equal(b.message, 'request body could not be read as json');
  assert.equal(b.violations, null);
  // saat dilimi farkı olan tarih okunur; saniye isteğe bağlıdır
  assert.equal((await send({ sender: 'MOCKTEST', startAt: '2026-01-01T09:00+03:00', messages: [msg('905061234567')] })).status, 202);
}));

test('1.000.000 üstü mesaj: 400 N messages exceeds the limit of 1000000', () => withServer(async ({ s, tok }) => {
  const { handler } = s.ctx.routes.match('POST', '/sms/v3/send');
  const req = { path: '/sms/v3/send', headers: { authorization: `Bearer ${await tok()}` }, json: { sender: 'MOCKTEST', messages: new Array(1_000_001).fill(null) } };
  const r = await handler(req, s.ctx);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_REQUEST');
  assert.equal(r.body.message, '1000001 messages exceeds the limit of 1000000');
}));

test('İYS: BRAND_AND_RETAILER marka kodu ve İYS modu kontrollerini atlar; RETAILER denetlenir', () => withServer(async ({ send, tok }) => {
  const t = await tok('8500000008');
  assert.equal((await send({ sender: 'MOCKTEST', iysFilter: 'BRAND_AND_RETAILER', messages: [msg('905061234567')] }, t)).status, 202);
  assert.equal((await send({ sender: 'MOCKTEST', iysFilter: 'retailer', messages: [msg('905061234567')] }, t)).status, 422);
  // abone numarası başlığının marka kodu yok: BRAND reddedilir, BRAND_AND_RETAILER geçer
  const brand = await (await send({ sender: '8500000000', iysFilter: 'BRAND', messages: [msg('905061234567')] })).json();
  assert.equal(brand.message, 'sender header has no iys brand code');
  assert.equal((await send({ sender: '8500000000', iysFilter: 'BRAND_AND_RETAILER', messages: [msg('905061234567')] })).status, 202);
  assert.equal(checkIys({ iysMode: false }, 'BRAND_AND_RETAILER', 'X'), null);
}));

test('stopAt verilmezse ya da geçmişteyse startAt + 21 saat', () => {
  const now = Date.UTC(2026, 0, 1);
  const iso = (ms) => new Date(ms).toISOString();
  const start = now + 3_600_000;
  const past = resolveSendWindow({ startAt: iso(start), stopAt: iso(now - 60_000), count: 1, nowMs: now });
  assert.equal(past.stopMs, start + 21 * 3600_000);
  const missing = resolveSendWindow({ startAt: iso(start), count: 1, nowMs: now });
  assert.equal(missing.stopMs, start + 21 * 3600_000);
});
