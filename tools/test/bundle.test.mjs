import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = join(ROOT, 'plugins/sms-skills/skills/netgsm-sms/scripts/netgsm-sms-mock.mjs');

// Bundle yoksa (taze klonda `npm test` dışı çalıştırma) önce üretilir.
if (!existsSync(BUNDLE)) {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/build-specs.mjs')], { cwd: ROOT });
  assert.equal(r.status, 0, String(r.stderr));
  const b = spawnSync(process.execPath, [join(ROOT, 'tools/build-mock.mjs')], { cwd: ROOT });
  assert.equal(b.status, 0, String(b.stderr));
}

/** Bundle'ı node_modules içermeyen, verilen adlı geçici dizine kopyalar. */
function stage(dirName) {
  const root = mkdtempSync(join(tmpdir(), 'netgsm-bundle-'));
  const dir = join(root, dirName);
  mkdirSync(dir);
  const file = join(dir, 'netgsm-sms-mock.mjs');
  copyFileSync(BUNDLE, file);
  return { root, file };
}

function run(file, args) {
  const child = spawn(process.execPath, [file, ...args], { cwd: join(file, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  return { child, exited, out: () => out, err: () => err };
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('zaman aşımı');
}

test('bundle ASCII dışı ve boşluklu bir dizinden çalışır', async () => {
  const { root, file } = stage('Çağrı Ölçüm test');
  const p = run(file, ['--port', '0']);
  try {
    const base = await waitFor(() => p.out().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
    const res = await fetch(`${base}/auth/v3/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '8500000000', password: 'password001', scope: 'sms' }),
    });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).access_token);
    assert.match(p.out(), /Mock gerçek başlık onayını, gerçek İYS izinlerini, gerçek bakiye tüketimini ve gerçek operatör iletimini taklit etmez\./);
  } finally {
    p.child.kill();
    await p.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test('port doluysa Türkçe mesaj ve çıkış kodu 1', async () => {
  const blocker = net.createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  const { root, file } = stage('port');
  try {
    const p = run(file, ['--port', String(port)]);
    const code = await p.exited;
    assert.equal(code, 1);
    assert.match(p.err(), /--port/);
    assert.match(p.err(), /kullanımda/);
    assert.doesNotMatch(p.err(), /\n\s+at /);
  } finally {
    blocker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundle node_modules olmadan çalışır', async () => {
  const { root, file } = stage('bos');
  try {
    const p = run(file, ['--help']);
    assert.equal(await p.exited, 0);
    assert.match(p.out(), /--port/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SIGTERM ile temiz kapanır (çıkış kodu 0)', { skip: process.platform === 'win32' && 'Windows SIGTERM süreci doğrudan sonlandırır' }, async () => {
  const { root, file } = stage('kapanis');
  const p = run(file, ['--port', '0', '--quiet']);
  try {
    await waitFor(() => p.out().includes('çalışıyor'));
    p.child.kill('SIGTERM');
    assert.equal(await p.exited, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
