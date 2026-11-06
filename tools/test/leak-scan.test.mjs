import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForLeaks, hashTerm, hashPrefix, loadDigests } from '../leak-scan.mjs';

// Yalnızca sentetik terimler: gerçek terim listesi depoda düz metin olarak bulunmaz.
const SYN = { terms: ['gizliservis', 'ozel kuyruk', 'gizlidepo', 'ozel_alan'], codePrefixes: ['abc'] };
const SCANNER = fileURLToPath(new URL('../leak-scan.mjs', import.meta.url));
const DIGESTS = fileURLToPath(new URL('../forbidden-terms.sha256', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'leak-'));

test('terimleri satır numarasıyla bulur, büyük/küçük harf fark etmez', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'a.md'), 'temiz satır\nToken GizliServis üzerinden\n');
  await writeFile(join(dir, 'b.md'), 'hata kodu ABC100 döner');
  const found = await scanForLeaks(dir, SYN);
  assert.deepEqual(found.map(f => [f.file.endsWith('a.md') ? 'a' : 'b', f.line, f.term.toLowerCase()]).sort(),
    [['a', 2, 'gizliservis'], ['b', 1, 'abc100']]);
});

test('iki kelimelik terimler ayraçtan bağımsız yakalanır (boşluk, nokta, tire, alt çizgi)', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'c.md'), 'ozel kuyruk\nozel.kuyruk.example\nOzel-Kuyruk\nozel_kuyruk\nozelkuyruk değil\n');
  const found = await scanForLeaks(dir, SYN);
  assert.deepEqual(found.map(f => f.line), [1, 2, 3, 4]);
});

test('snake_case: parçalar ayrı kelime sayılır, birleşik hâl de yakalanır', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'd.md'), 'error_ABC100\ngizliservis_id\nABC1000\nozel_alan\nGIZLIDEPO\nozel_alan_id\n');
  const found = await scanForLeaks(dir, SYN);
  assert.deepEqual(found.map(f => [f.line, f.term.toLowerCase()]),
    [[1, 'abc100'], [2, 'gizliservis'], [3, 'abc1000'], [4, 'ozel_alan'], [5, 'gizlidepo'], [6, 'ozel_alan']]);
});

test('kelime içinde geçen masum metinleri yakalamaz', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'e.md'), 'ABCD12 değil, gizliservisler; abc1; xabc12; ozel ve kuyruk');
  assert.deepEqual(await scanForLeaks(dir, SYN), []);
});

test('node_modules, .git, dist ve .superpowers/sdd taranmaz; .superpowers altındaki diğer yerler taranır', async () => {
  const dir = await tmp();
  for (const d of ['node_modules', '.git', 'dist', '.superpowers/sdd', '.superpowers/notes']) {
    await mkdir(join(dir, d), { recursive: true });
    await writeFile(join(dir, d, 'x.md'), 'gizliservis');
  }
  const found = await scanForLeaks(dir, SYN);
  assert.deepEqual(found.map(f => f.file.replace(/\\/g, '/').split('/').slice(-2).join('/')), ['notes/x.md']);
});

test('uzantısı ne olursa olsun metin dosyaları taranır; ikili dosyalar (NUL bayt) atlanır', async () => {
  const dir = await tmp();
  const names = ['LICENSE', 'README', '.gitattributes', 'run.sh', 'app.py', 'App.cs', 'App.java', 'app.php', 'x.xml'];
  for (const n of names) await writeFile(join(dir, n), `satır\ngizliservis burada\n`);
  await writeFile(join(dir, 'blob.bin'), Buffer.from([0x67, 0x00, ...Buffer.from(' gizliservis ')]));
  const found = await scanForLeaks(dir, SYN);
  assert.deepEqual(found.map(f => f.file.replace(/\\/g, '/').split('/').at(-1)).sort(), [...names].sort());
  assert.ok(found.every(f => f.line === 2));
});

test('özet dosyası: yalnızca t/p + 64 onaltılık satırlar, düz metin terim yok; varsayılan tarama onu kullanır', async () => {
  const text = await readFile(DIGESTS, 'utf8');
  for (const line of text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'))) {
    assert.match(line, /^[tp] [0-9a-f]{64}$/);
  }
  const { terms, prefixes } = await loadDigests();
  assert.ok(terms.size >= 20 && prefixes.size >= 10);
  // özet dosyası sentetik terimleri içermez
  assert.equal(terms.has(hashTerm('gizliservis')), false);
  const dir = await tmp();
  await writeFile(join(dir, 'f.md'), 'gizliservis');
  assert.deepEqual(await scanForLeaks(dir), []);
});

test('özel özet dosyası ve --hash / --hash-prefix çıktısı birbirini tutar', async () => {
  const run = (...args) => spawnSync(process.execPath, [SCANNER, ...args], { encoding: 'utf8' });
  const t = run('--hash', 'Ozel Kuyruk');
  const p = run('--hash-prefix', 'ABC');
  assert.equal(t.status, 0);
  assert.equal(t.stdout.trim(), `t ${hashTerm('ozel kuyruk')}`);
  assert.equal(p.stdout.trim(), `p ${hashPrefix('abc')}`);
  assert.equal(run('--hash-prefix', 'ab1').status, 1);
  const dir = await tmp();
  const file = join(dir, 'digests.sha256');
  await writeFile(file, `# yorum\n${t.stdout}${p.stdout}`);
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'g.md'), 'ozel-kuyruk ve abc99');
  const found = await scanForLeaks(join(dir, 'src'), { digestFile: file });
  assert.deepEqual(found.map(f => f.term), ['ozel kuyruk', 'abc99']);
});
