// netgsm-sms references/auth.md "Önerilen istemci deseni" TypeScript taslağı kullanıcıların kopyaladığı koddur.
// Taslak dokümandan çıkarılır, strict tsc ile denetlenir, esbuild ile JavaScript'e çevrilip sahte fetch ve
// sahte saatle çalıştırılır. Ağa istek atılmaz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { typecheck } from './ts-typecheck.mjs';

const AUTH_MD = new URL('../../plugins/sms-skills/skills/netgsm-sms/references/auth.md', import.meta.url);

function snippet() {
  const md = readFileSync(AUTH_MD, 'utf8').replace(/\r\n/g, '\n');
  const section = md.slice(md.indexOf('## Önerilen istemci deseni'));
  const m = section.match(/```ts\n([\s\S]*?)\n```/);
  assert.ok(m, 'auth.md "Önerilen istemci deseni" altında ```ts bloğu bulunmalı');
  assert.match(m[1], /class NetgsmTokenManager/);
  return m[1];
}

/** Taslağı modül olarak yükler; `fetch` ve `Date.now` çağrı anında globalden okunur, test bunları değiştirir. */
async function loadManager() {
  const { code } = await transform(`${snippet()}\nexport { NetgsmTokenManager };\n`, { loader: 'ts', format: 'esm', target: 'es2022' });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  return mod.NetgsmTokenManager;
}

/** Testin süresince global fetch ve Date.now'u değiştirir. */
async function withFakes(fakeFetch, clock, fn) {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = fakeFetch;
  Date.now = () => clock.t;
  try { return await fn(); } finally { globalThis.fetch = realFetch; Date.now = realNow; }
}

const tokenRes = (n) => Response.json({ access_token: `a${n}`, refresh_token: '00000000-0000-4000-8000-000000000000', expires_in: 3600 });

test('auth.md taslağı strict tsc ile hatasız derlenir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-snippet-'));
  try {
    const file = join(dir, 'token-manager.ts');
    writeFileSync(file, `${snippet()}\nexport { NetgsmTokenManager };\n`);
    assert.equal(typecheck([file]), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth.md taslağı: refresh beklenirken invalidate() çağrılırsa çökmez, yeniden giriş yapar', async () => {
  const NetgsmTokenManager = await loadManager();
  const clock = { t: 0 };
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fakeFetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (calls.length === 1) return tokenRes(1);
    if (path.endsWith('/refresh')) { await gate; return Response.json({}, { status: 503 }); }
    return tokenRes(2);
  };
  await withFakes(fakeFetch, clock, async () => {
    const manager = new NetgsmTokenManager('https://example.com', 'u', 'p');
    assert.equal(await manager.get(), 'a1');
    clock.t = 3600_000 - 60_000; // yenileme payının içinde
    const pending = manager.get();
    await new Promise((r) => setImmediate(r));
    manager.invalidate('a1'); // ör. başka bir istek 401 aldı
    release();
    assert.equal(await pending, 'a2');
  });
  assert.deepEqual(calls, ['/auth/v3/token', '/auth/v3/token/refresh', '/auth/v3/token']);
});

test('auth.md taslağı: refresh\'te ağ hatası geçici hata gibidir; eski token süresi dolmuş ya da geçersiz kılınmışsa hata fırlar', async () => {
  const NetgsmTokenManager = await loadManager();
  const clock = { t: 0 };
  let calls = [];
  let gate = Promise.resolve();
  let release = () => {};
  const fakeFetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path.endsWith('/refresh')) { await gate; throw new TypeError('fetch failed'); }
    return tokenRes(1);
  };
  await withFakes(fakeFetch, clock, async () => {
    let manager = new NetgsmTokenManager('https://example.com', 'u', 'p');
    assert.equal(await manager.get(), 'a1');
    clock.t = 3600_000 - 120_000;
    for (let i = 0; i < 10; i++) assert.equal(await manager.get(), 'a1');
    assert.equal(calls.filter((p) => p.endsWith('/refresh')).length, 1);
    clock.t = 4000_000; // süresi doldu
    await assert.rejects(manager.get(), /fetch failed/);

    clock.t = 0; calls = [];
    gate = new Promise((r) => { release = r; });
    manager = new NetgsmTokenManager('https://example.com', 'u', 'p');
    assert.equal(await manager.get(), 'a1');
    clock.t = 3600_000 - 60_000;
    const pending = manager.get();
    await new Promise((r) => setImmediate(r));
    manager.invalidate('a1');
    release();
    await assert.rejects(pending, /fetch failed/);
    assert.deepEqual(calls, ['/auth/v3/token', '/auth/v3/token/refresh']);
  });
});

test('auth.md taslağı: başarısız refresh sonrası 30 sn eski token kullanılır, refresh tekrarlanmaz', async () => {
  const NetgsmTokenManager = await loadManager();
  const clock = { t: 0 };
  const calls = [];
  const fakeFetch = async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    return path.endsWith('/refresh') ? Response.json({ code: 'service_unavailable' }, { status: 503 }) : tokenRes(1);
  };
  await withFakes(fakeFetch, clock, async () => {
    const manager = new NetgsmTokenManager('https://example.com', 'u', 'p');
    assert.equal(await manager.get(), 'a1');
    clock.t = 3600_000 - 120_000;
    for (let i = 0; i < 10; i++) assert.equal(await manager.get(), 'a1');
    assert.equal(calls.filter((p) => p.endsWith('/refresh')).length, 1);
    clock.t += 30_001;
    assert.equal(await manager.get(), 'a1');
    assert.equal(calls.filter((p) => p.endsWith('/refresh')).length, 2);
  });
});
