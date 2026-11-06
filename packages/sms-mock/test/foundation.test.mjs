import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createMockServer } from '../src/server.mjs';

async function start() { const s = createMockServer({ port: 0, log: () => {} }); return { s, base: await s.listen() }; }

test('bilinmeyen /sms/v3 yolu 404 NOT_FOUND ApiError döner', async () => {
  const { s, base } = await start();
  const r = await fetch(`${base}/sms/v3/yok`, { headers: { authorization: 'Bearer x' } });
  const b = await r.json();
  assert.equal(r.status, 404);
  assert.equal(b.code, 'NOT_FOUND');
  assert.match(b.requestId, /^[0-9a-f]{32}$/);
  assert.equal(r.headers.get('x-request-id'), b.requestId);
  assert.match(b.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+03:00$/);
  assert.equal(b.violations, null);
  await s.close();
});

test('bozuk gövdeler çökertmez', async () => {
  const { s, base } = await start();
  s.ctx.routes.add('POST', '/sms/v3/echo', req => ({ status: 200, body: req.json }));
  const cases = [
    [{ 'content-type': 'application/json' }, '{bozuk', 400],
    [{ 'content-type': 'text/plain' }, 'merhaba', 415],
    [{ 'content-type': 'application/json', 'content-encoding': 'gzip' }, '{}', 415],
    [{ 'content-type': 'application/json' }, '', 400],
    [{ 'content-type': 'application/json' }, '[1]', 400],
    [{ 'content-type': 'application/json' }, 'null', 400],
  ];
  for (const [headers, body, status] of cases) {
    const r = await fetch(`${base}/sms/v3/echo`, { method: 'POST', headers, body });
    assert.equal(r.status, status, JSON.stringify(headers) + body);
    assert.equal((await r.json()).code, 'INVALID_REQUEST');
  }
  const ok = await fetch(`${base}/sms/v3/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.deepEqual(await ok.json(), { a: 1 });
  await s.close();
});

test('Accept JSON kabul etmiyorsa 406 ve boş gövde döner', async () => {
  const { s, base } = await start();
  s.ctx.routes.add('GET', '/sms/v3/echo', () => ({ status: 200, body: {} }));
  const r = await fetch(`${base}/sms/v3/echo`, { headers: { accept: 'text/html' } });
  assert.equal(r.status, 406);
  assert.equal(await r.text(), '');
  const ok = await fetch(`${base}/sms/v3/echo`, { headers: { accept: 'text/html, */*;q=0.1' } });
  assert.equal(ok.status, 200);
  await s.close();
});

test('desteklenmeyen metot 405 ve Allow başlığı döner', async () => {
  const { s, base } = await start();
  s.ctx.routes.add('GET', '/sms/v3/echo', () => ({ status: 200, body: {} }));
  const r = await fetch(`${base}/sms/v3/echo`, { method: 'DELETE' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'GET');
  assert.equal((await r.json()).code, 'INVALID_REQUEST');
  await s.close();
});

test('yakalanmayan handler hatası 500 INTERNAL_ERROR döner ve log a yazılır', async () => {
  const lines = [];
  const s = createMockServer({ port: 0, log: l => lines.push(l) });
  const base = await s.listen();
  s.ctx.routes.add('GET', '/sms/v3/boom', () => { throw new Error('patladi'); });
  const r = await fetch(`${base}/sms/v3/boom`);
  const b = await r.json();
  assert.equal(r.status, 500);
  assert.equal(b.code, 'INTERNAL_ERROR');
  assert.equal(b.message, 'internal error');
  assert.match(lines.join('\n'), /patladi/);
  await s.close();
});

test('/auth/v3 hataları RFC 9457 problem gövdesiyle döner', async () => {
  const { s, base } = await start();
  s.ctx.routes.add('POST', '/auth/v3/echo', req => ({ status: 200, body: req.json }));
  const nf = await fetch(`${base}/auth/v3/yok`);
  const b = await nf.json();
  assert.equal(nf.status, 404);
  assert.equal(nf.headers.get('content-type'), 'application/problem+json');
  assert.equal(b.type, 'urn:problem-type:identity:not-found');
  assert.equal(b.code, 'not_found');
  assert.equal(b.error, 'invalid_request');
  assert.equal(b.instance, '/auth/v3/yok');
  assert.match(b.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const mna = await fetch(`${base}/auth/v3/echo`);
  assert.equal(mna.status, 405);
  assert.equal(mna.headers.get('allow'), 'POST');
  const bad = await fetch(`${base}/auth/v3/echo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'invalid_request');
  const form = await fetch(`${base}/auth/v3/echo`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2',
  });
  assert.deepEqual(await form.json(), { a: '1', b: '2' });
  await s.close();
});

test('/auth/v3 gövde sınırı 1 MB: aşılırsa 413 payload_too_large', async () => {
  const { s, base } = await start();
  s.ctx.routes.add('POST', '/auth/v3/echo', req => ({ status: 200, body: req.json }));
  const r = await fetch(`${base}/auth/v3/echo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(1024 * 1024) }),
  });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).code, 'payload_too_large');
  await s.close();
});

test('diğer yollarda düz JSON hata gövdesi döner', async () => {
  const { s, base } = await start();
  const r = await fetch(`${base}/__mock/yok`);
  assert.equal(r.status, 404);
  assert.equal(typeof (await r.json()).error, 'string');
  await s.close();
});

function rawRequest(base, text) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), '127.0.0.1', () => sock.write(text));
    let data = '';
    sock.on('data', d => { data += d; });
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
}

test('bozuk istek hedefi 400 döner ve sunucu çalışmaya devam eder', async () => {
  const { s, base } = await start();
  s.ctx.routes.add('GET', '/sms/v3/x', () => ({ status: 200, body: { ok: true } }));
  for (const target of ['//', '//evil/sms/v3/x', '//x:y/z']) {
    const out = await rawRequest(base, `GET ${target} HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 400 /, target);
    assert.match(out, /malformed request target/);
    const r = await fetch(`${base}/sms/v3/x`);
    assert.equal(r.status, 200);
  }
  await s.close();
});

function chunkedPost(base, path, chunks) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body), headers: res.headers }));
    });
    req.on('error', reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

test('Content-Length olmadan akışla gelen gövde sınırı aşarsa 413 (sms ve auth)', async () => {
  const s = createMockServer({ port: 0, log: () => {}, bodyLimits: { sms: 100, auth: 50 } });
  const base = await s.listen();
  s.ctx.routes.add('POST', '/sms/v3/echo', req => ({ status: 200, body: req.json }));
  s.ctx.routes.add('POST', '/auth/v3/echo', req => ({ status: 200, body: req.json }));
  const chunks = ['{"a":"', 'x'.repeat(60), 'y'.repeat(60), '"}'];
  const sms = await chunkedPost(base, '/sms/v3/echo', chunks);
  assert.equal(sms.status, 413);
  assert.equal(sms.body.code, 'INVALID_REQUEST');
  assert.match(sms.body.requestId, /^[0-9a-f]{32}$/);
  const auth = await chunkedPost(base, '/auth/v3/echo', chunks);
  assert.equal(auth.status, 413);
  assert.equal(auth.body.code, 'payload_too_large');
  assert.equal(auth.headers['content-type'], 'application/problem+json');
  const ok = await chunkedPost(base, '/sms/v3/echo', ['{"a"', ':1}']);
  assert.deepEqual(ok.body, { a: 1 });
  await s.close();
});
