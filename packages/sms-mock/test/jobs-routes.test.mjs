import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createManualClock } from '../src/clock.mjs';
import { createSchemaValidator } from '../src/sms/schema.mjs';
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
    const send = async (messages, extra = {}, user = A) => (await call('POST', '/send', { user, body: { sender: 'MOCKTEST', messages, ...extra } })).body;
    const noSms = () => s.ctx.sessions.open({ accountId: A, identity: 'sub:1', subUserId: 1, smsPermission: false }, 'sms').accessToken;
    return await fn({ s, clock, call, send, noSms });
  } finally { await s.close(); }
}
const msg = (recipient, text = 'Merhaba') => ({ text, recipient });
const valid = (name, body) => assert.deepEqual(validator.validate(name, body), [], `${name} şemaya uymuyor`);
const inMinutes = (clock, m) => new Date(clock.now() + m * 60_000).toISOString();

test('report: gönderimden hemen sonra PENDING, 6 sn sonra DELIVERED; 00 ile biten NOT_DELIVERED/UNKNOWN_SUBSCRIBER', () => withServer(async ({ call, send, clock }) => {
  const sent = await send([msg('905061234567'), msg('905061234500')], { referenceId: 'ref-1' });
  let r = await call('GET', '/report');
  assert.equal(r.status, 200);
  valid('ReportResponse', r.body);
  assert.equal(r.body.count, 2);
  assert.deepEqual(r.body.reports.map(x => x.status), ['PENDING', 'PENDING']);
  assert.equal(r.body.reports[0].jobId, sent.jobId);
  assert.equal(r.body.reports[0].number, '5061234567');
  assert.equal(r.body.reports[0].referenceId, 'ref-1');
  assert.equal(r.body.reports[0].operator, 'TURK_TELEKOM');
  clock.advance(6000);
  r = await call('GET', '/report');
  valid('ReportResponse', r.body);
  const [ok, bad] = r.body.reports;
  assert.equal(ok.status, 'DELIVERED');
  assert.match(ok.deliveredAt, /\+03:00$/);
  assert.equal(ok.failReason, null);
  assert.equal(bad.status, 'NOT_DELIVERED');
  assert.equal(bad.failReason, 'UNKNOWN_SUBSCRIBER');
  assert.equal(bad.deliveredAt, null);
}));

test('report: aynı jobId 60 sn içinde ikinci kez 429, 60 sn sonra 200; hesap sayacı ayrı', () => withServer(async ({ call, send, clock }) => {
  const { jobId } = await send([msg('905061234567')]);
  assert.equal((await call('GET', `/report?jobIds=${jobId}`)).status, 200);
  const r = await call('GET', `/report?jobIds=${jobId}`);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RATE_LIMITED');
  assert.equal(r.body.message, 'a jobId in this request was queried too recently');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  clock.advance(60_000);
  assert.equal((await call('GET', `/report?jobIds=${jobId}`)).status, 200);
}));

test('report: hesap başına dakikada 60 istek, ardından 429 hesap mesajı', () => withServer(async ({ call }) => {
  for (let i = 0; i < 60; i++) assert.equal((await call('GET', '/report')).status, 200);
  const r = await call('GET', '/report');
  assert.equal(r.status, 429);
  assert.equal(r.body.message, 'report rate limit exceeded');
}));

test('report: jobIds virgüllü/tekrarlı, başka hesabın görevi görünmez; sayfalama 100', () => withServer(async ({ call, send }) => {
  const mine = await send(Array.from({ length: 120 }, (_, i) => msg(`90506${String(10000000 + i).slice(1)}`)));
  const other = await send([msg('905061234567')], {}, B);
  let r = await call('GET', `/report?jobIds=${other.jobId}`);
  assert.deepEqual(r.body, { count: 0, page: 0, reports: [] });
  r = await call('GET', '/report?page=0');
  assert.equal(r.body.count, 100);
  valid('ReportResponse', r.body);
  r = await call('GET', '/report?page=1');
  assert.equal(r.body.count, mine.accepted - 100);
  assert.equal(r.body.page, 1);
  r = await call('GET', `/report?jobIds=${mine.jobId},${mine.jobId}&jobIds=${mine.jobId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 100);
}));

test('report: 400 doğrulamaları', () => withServer(async ({ call, clock }) => {
  const cases = [
    ['?page=-1', 'page must not be negative'],
    ['?page=abc', 'page must be an integer'],
    ['?startAt=2026-08-01T00:00:00%2B03:00', 'startAt and stopAt must be sent together, or neither'],
    ['?startAt=dün&stopAt=2026-08-01T00:00:00%2B03:00', 'startAt is not ISO-8601'],
    ['?startAt=2026-08-02T00:00:00%2B03:00&stopAt=2026-08-01T00:00:00%2B03:00', 'stopAt is before startAt'],
    ['?startAt=2026-06-01T00:00:00%2B03:00&stopAt=2026-08-01T00:00:00%2B03:00', 'the window is wider than one month'],
  ];
  for (const [q, message] of cases) {
    const r = await call('GET', `/report${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.code, 'INVALID_REQUEST');
    assert.match(r.body.message, new RegExp(message.split(' ')[0]));
  }
  // stopAt, startAt'tan önce değilse dar pencere geçerli
  const now = clock.now();
  const q = `?startAt=${encodeURIComponent(new Date(now - 60_000).toISOString())}&stopAt=${encodeURIComponent(new Date(now).toISOString())}`;
  assert.equal((await call('GET', `/report${q}`)).status, 200);
}));

test('report: pencere gönderim zamanına uygulanır', () => withServer(async ({ call, send, clock }) => {
  await send([msg('905061234567')]);
  const t = clock.now();
  const win = (a, b) => `?startAt=${encodeURIComponent(new Date(a).toISOString())}&stopAt=${encodeURIComponent(new Date(b).toISOString())}`;
  assert.equal((await call('GET', `/report${win(t - 3_600_000, t + 1000)}`)).body.count, 1);
  assert.equal((await call('GET', `/report${win(t - 7_200_000, t - 3_600_000)}`)).body.count, 0);
}));

test('report: 401 ve 403 (SMS menüsü olmayan alt kullanıcı)', () => withServer(async ({ call, noSms }) => {
  assert.equal((await call('GET', '/report', { auth: false })).status, 401);
  const r = await call('GET', '/report', { token: noSms() });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'FORBIDDEN');
}));

test('report/stats: Türkçe karakterli TURKISH metnin parçası /length ile aynı', () => withServer(async ({ call, send, clock }) => {
  const text = 'ş'.repeat(80); // TURKISH: 160 ağırlıklı karakter, 2 parça (DEFAULT 1, UNICODE 3 verirdi)
  const want = (await call('POST', '/length', { body: { text, encoding: 'TURKISH', alphanumericSender: true } })).body.parts;
  const { jobId } = await send([msg('905061234567', text)], { encoding: 'TURKISH' });
  const rep = await call('GET', `/report?jobIds=${jobId}`);
  assert.equal(rep.body.reports[0].messageLength, want);
  assert.equal(want, 2);
  clock.advance(6000);
  const st = await call('GET', `/stats?jobId=${jobId}`);
  assert.equal(st.body.stats[0].totalParts, want);
}));

test('stats: DELIVERED/NOT_DELIVERED satırları şemaya uyar; UNKNOWN_SUBSCRIBER istatistikte UNKNOWN', () => withServer(async ({ call, send, clock }) => {
  const { jobId } = await send([msg('905061234567'), msg('905061234568'), msg('905061234500')]);
  clock.advance(6000);
  const r = await call('GET', `/stats?jobId=${jobId}`);
  assert.equal(r.status, 200);
  valid('StatsResponse', r.body);
  assert.equal(r.body.jobId, jobId);
  assert.match(r.body.month, /^\d{4}-\d{2}$/);
  const d = r.body.stats.find(x => x.status === 'DELIVERED');
  assert.equal(d.messageCount, 2);
  assert.equal(d.totalParts, 2);
  assert.equal(d.charging, 'charged');
  const n = r.body.stats.find(x => x.status === 'NOT_DELIVERED');
  assert.equal(n.failReason, 'UNKNOWN');
  assert.equal(n.charging, 'uncharged');
  assert.equal(n.chargeDescription, null);
}));

test('stats: aynı jobId 10 dk içinde ikinci kez 429; 404 de sayılır; 10 dk sonra serbest', () => withServer(async ({ call, send, clock }) => {
  const { jobId } = await send([msg('905061234567')]);
  assert.equal((await call('GET', `/stats?jobId=${jobId}`)).status, 200);
  let r = await call('GET', `/stats?jobId=${jobId}`);
  assert.equal(r.status, 429);
  assert.equal(r.body.message, 'this jobId was queried too recently');
  clock.advance(9 * 60_000);
  assert.equal((await call('GET', `/stats?jobId=${jobId}`)).status, 429);
  clock.advance(60_000);
  assert.equal((await call('GET', `/stats?jobId=${jobId}`)).status, 200);

  r = await call('GET', '/stats?jobId=1234567890');
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'NOT_FOUND');
  assert.equal(r.body.message, 'job not found');
  r = await call('GET', '/stats?jobId=1234567890');
  assert.equal(r.status, 429);
}));

test('stats: hesapta dakikada 60 okuma; 400 doğrulamaları; yanlış ay 404', () => withServer(async ({ call, send }) => {
  assert.equal((await call('GET', '/stats')).status, 400);
  assert.equal((await call('GET', '/stats?jobId=%20')).status, 400);
  assert.equal((await call('GET', '/stats?jobId=1&month=2026-13')).status, 400);
  const { jobId } = await send([msg('905061234567')]);
  assert.equal((await call('GET', `/stats?jobId=${jobId}&month=2001-01`)).status, 404);
  for (let i = 0; i < 59; i++) await call('GET', `/stats?jobId=x${i}`);
  const r = await call('GET', '/stats?jobId=y');
  assert.equal(r.status, 429);
  assert.equal(r.body.message, 'stats rate limit exceeded');
}));

test('başka hesabın jobId si: stats 404, cancel 404', () => withServer(async ({ call, send, clock }) => {
  const { jobId } = await send([msg('905061234567')], { startAt: inMinutes(clock, 30) }, B);
  assert.equal((await call('GET', `/stats?jobId=${jobId}`)).status, 404);
  assert.equal((await call('POST', '/cancel', { body: { jobId } })).status, 404);
}));

test('cancel: SCHEDULED başarılı; iptal edilen görev raporda yok, DELIVERED görünmez; ikinci iptal 404', () => withServer(async ({ call, send, clock }) => {
  const { jobId, status } = await send([msg('905061234567')], { startAt: inMinutes(clock, 30) });
  assert.equal(status, 'SCHEDULED');
  const r = await call('POST', '/cancel', { body: { jobId } });
  assert.equal(r.status, 200);
  valid('CancelResponse', r.body);
  assert.equal(r.body.jobId, jobId);
  assert.match(r.body.cancelledAt, /\+03:00$/);
  assert.equal((await call('POST', '/cancel', { body: { jobId } })).status, 404);

  clock.advance(31 * 60_000 + 6000); // başlangıç geçse de iptal edilen teslim edilmez
  const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
  const rep = await call('GET', `/report?jobIds=${jobId}&startAt=${iso(clock.now() - 3_600_000)}&stopAt=${iso(clock.now())}`);
  assert.deepEqual(rep.body, { count: 0, page: 0, reports: [] });
  assert.equal((await call('GET', `/stats?jobId=${jobId}`)).status, 404);
}));

test('cancel: QUEUED, başlangıcı gelmiş SCHEDULED ve OTP görevi 404 (spec mesajı)', () => withServer(async ({ call, send, s, clock }) => {
  const queued = await send([msg('905061234567')]);
  const r = await call('POST', '/cancel', { body: { jobId: queued.jobId } });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'NOT_FOUND');
  assert.equal(r.body.message, 'job not found for this account, or no longer waiting to be sent');

  const sched = await send([msg('905061234568')], { startAt: inMinutes(clock, 5) });
  clock.advance(6 * 60_000);
  assert.equal((await call('POST', '/cancel', { body: { jobId: sched.jobId } })).status, 404);

  const otp = s.ctx.jobs.create({ accountId: A, kind: 'OTP', status: 'QUEUED', startMs: clock.now(), stopMs: clock.now() + 60_000, sender: 'MOCKTEST', records: [{ index: 0, recipient: '905061234567', text: 'kod 1234' }], referenceId: null });
  assert.equal((await call('POST', '/cancel', { body: { jobId: otp.jobId } })).status, 404);
}));

test('cancel: 400, 401, 403', () => withServer(async ({ call, noSms }) => {
  for (const body of [{}, { jobId: '' }, { jobId: 'x'.repeat(65) }]) {
    const r = await call('POST', '/cancel', { body });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_REQUEST');
    assert.ok(r.body.violations.length > 0);
  }
  assert.equal((await call('POST', '/cancel', { body: { jobId: '1' }, auth: false })).status, 401);
  const forbidden = await call('POST', '/cancel', { body: { jobId: '1' }, token: noSms() });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.message, 'sub user may not use the sms api');
}));

test('cancel: 400 mesajları; yalnızca boşluktan oluşan jobId reddedilir, jobId kırpılmaz', () => withServer(async ({ call, send, clock }) => {
  for (const body of [{}, { jobId: '' }, { jobId: '   ' }, { jobId: 'x'.repeat(65) }]) {
    const r = await call('POST', '/cancel', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.message, '1 field(s) rejected');
    assert.equal(r.body.violations[0].field, 'jobId');
  }
  const { jobId } = await send([msg('905061234567')], { startAt: inMinutes(clock, 30) });
  // boşlukla yazılan kimlik başka bir kimliktir: kırpılmadığı için bulunamaz
  assert.equal((await call('POST', '/cancel', { body: { jobId: ` ${jobId} ` } })).status, 404);
  const r = await call('POST', '/cancel', { body: { jobId } });
  assert.equal(r.status, 200);
  assert.equal(r.body.jobId, jobId);
}));

test('cancel: /send/template SCHEDULED görevi iptal edilir; /directory/send görevi edilemez', () => withServer(async ({ call, clock }) => {
  const startAt = inMinutes(clock, 30);
  const t = await call('POST', '/send/template', { body: { sender: 'MOCKTEST', startAt, templates: [{ templateId: 4, recipient: '905061234567' }] } });
  assert.equal(t.body.status, 'SCHEDULED');
  assert.equal((await call('POST', '/cancel', { body: { jobId: t.body.jobId } })).status, 200);
  const d = await call('POST', '/directory/send', { body: { sender: 'MOCKTEST', text: 'Merhaba', groupIds: [7], startAt } });
  assert.equal(d.status, 202);
  assert.equal(d.body.status, 'QUEUED');
  const c = await call('POST', '/cancel', { body: { jobId: d.body.jobId } });
  assert.equal(c.status, 404);
  assert.equal(c.body.code, 'NOT_FOUND');
}));

test('cancel: dakikada 25.000 istekten sonra 429 cancel rate limit exceeded', () => withServer(async ({ call, s }) => {
  const token = s.ctx.sessions.open({ accountId: A, identity: 'main', subUserId: 0, subUser: null, smsPermission: true }, 'sms').accessToken;
  const { handler } = s.ctx.routes.match('POST', '/sms/v3/cancel');
  const req = () => ({ path: '/sms/v3/cancel', headers: { authorization: `Bearer ${token}` }, json: { jobId: 'yok' } });
  for (let i = 0; i < 25_000; i++) assert.equal(handler(req(), s.ctx).status, 404);
  const r = await call('POST', '/cancel', { body: { jobId: 'yok' }, token });
  assert.equal(r.status, 429);
  assert.equal(r.body.message, 'cancel rate limit exceeded');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
}));

test('OTP görevi GET /report ve /stats ile sorgulanamaz', () => withServer(async ({ call, s, clock }) => {
  const otp = s.ctx.jobs.create({ accountId: A, kind: 'OTP', status: 'QUEUED', startMs: clock.now(), stopMs: clock.now() + 60_000, sender: 'MOCKTEST', records: [{ index: 0, recipient: '905061234567', text: 'kod 1234' }], referenceId: null });
  const r = await call('GET', `/report?jobIds=${otp.jobId}`);
  assert.deepEqual(r.body, { count: 0, page: 0, reports: [] });
  assert.equal((await call('GET', '/report')).body.count, 0);
  assert.equal((await call('GET', `/stats?jobId=${otp.jobId}`)).status, 404);
}));

test('kayıtsız rehber görevi: report boş, stats 404, hata yok', () => withServer(async ({ call, s, clock }) => {
  const job = s.ctx.jobs.create({ accountId: A, kind: 'DIRECTORY', status: 'QUEUED', startMs: clock.now(), stopMs: clock.now() + 600_000, sender: 'MOCKTEST', records: [], referenceId: null });
  const r = await call('GET', `/report?jobIds=${job.jobId}`);
  assert.equal(r.status, 200);
  valid('ReportResponse', r.body);
  assert.equal(r.body.count, 0);
  assert.equal((await call('GET', `/stats?jobId=${job.jobId}`)).status, 404);
}));
