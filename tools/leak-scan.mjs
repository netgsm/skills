import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Yasaklı terimler düz metin olarak tutulmaz: `forbidden-terms.sha256` yalnızca tuzlu SHA-256
// özetlerini taşır. Tuz herkese açık sabit bir değerdir; amaç terim listesinin okunamamasıdır,
// kaba kuvvete karşı gizlilik değildir. Yeni terim eklemek için:
//   node tools/leak-scan.mjs --hash "terim"          (tek kelime ya da "iki kelime")
//   node tools/leak-scan.mjs --hash-prefix "abc"     (abc123 gibi kod aileleri için 3 harfli önek)
// ve çıktıdaki satırı forbidden-terms.sha256 dosyasına ekleyin.
export const SALT = 'netgsm-skills/leak-scan/v1:';
const DIGEST_FILE = fileURLToPath(new URL('./forbidden-terms.sha256', import.meta.url));
const DIGEST_REL = 'tools/forbidden-terms.sha256';
const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'dist']);
const IGNORED_DIR_PATHS = new Set(['.superpowers/sdd']);
const CODE_WORD = /^[a-z]{3}\d{2,}$/;

/** Terimi (küçük harfe çevrilmiş, kelimeler tek boşlukla ayrılmış) tuzlu SHA-256 özetine çevirir. */
export function hashTerm(term) {
  const norm = String(term).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean).join(' ');
  return createHash('sha256').update(SALT + norm).digest('hex');
}

/** 3 harfli hata kodu önekinin özeti (ör. "abc" → abc12, abc1234 yakalanır). */
export function hashPrefix(prefix) {
  return createHash('sha256').update(SALT + 'prefix:' + String(prefix).toLowerCase()).digest('hex');
}

/** Özet dosyasını okur: `t <hex>` (terim) ve `p <hex>` (kod öneki) satırları; `#` yorumdur. */
export async function loadDigests(file = DIGEST_FILE) {
  const text = await readFile(file, 'utf8');
  const terms = new Set();
  const prefixes = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([tp]) ([0-9a-f]{64})$/.exec(line);
    if (!m) throw new Error(`forbidden-terms.sha256: geçersiz satır: ${line}`);
    (m[1] === 't' ? terms : prefixes).add(m[2]);
  }
  return { terms, prefixes };
}

/**
 * Bir satırdaki yasaklı terimleri bulur. Kelimeler `[^A-Za-z0-9]+` ile ayrılır ve küçük harfe çevrilir;
 * her kelime, ardışık her kelime çifti ("iki kelime") ve alt çizgili tam belirteç (`a_b`) özetlerle
 * karşılaştırılır. `abc123` biçimindeki kelimeler 3 harfli
 * önek özetiyle karşılaştırılır.
 * @returns {string[]} satırda bulunan (metindeki hâliyle) terimler
 */
export function scanLine(text, digests) {
  const hits = [];
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const lower = words.map(w => w.toLowerCase());
  lower.forEach((w, i) => {
    if (digests.terms.has(hashTerm(w))) hits.push(words[i]);
    else if (CODE_WORD.test(w) && digests.prefixes.has(hashPrefix(w.slice(0, 3)))) hits.push(words[i]);
    if (i + 1 < lower.length && digests.terms.has(hashTerm(`${w} ${lower[i + 1]}`))) hits.push(`${words[i]} ${words[i + 1]}`);
  });
  for (const tok of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    if (!tok.includes('_')) continue;
    // alt çizgiyle birleşmiş ardışık parçalar (a_b, a_b_c, ...); tek parçalar kelime olarak zaten bakıldı
    const parts = tok.split('_').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 2; j <= parts.length; j++) {
        const sub = parts.slice(i, j).join('_');
        if (digests.terms.has(hashTerm(sub))) hits.push(sub);
      }
    }
  }
  return hits;
}

async function* walk(dir, root) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name) || IGNORED_DIR_PATHS.has(rel)) continue;
      yield* walk(full, root);
    } else if (entry.isFile()) {
      if (rel === DIGEST_REL) continue;
      yield full;
    }
  }
}

/**
 * Metin dosyalarını (uzantıya bakmadan; NUL bayt içeren ikili dosyalar atlanır) yasaklı terimler için tarar.
 * `node_modules`, `.git`, `dist` ve `.superpowers/sdd` taranmaz.
 * @param {string} rootDir
 * @param {{ terms?: string[], codePrefixes?: string[], digestFile?: string }} [opts]
 *   `terms` / `codePrefixes` verilirse özet dosyası yerine bu (düz metin) terimler kullanılır (testler için).
 * @returns {Promise<Array<{ file: string, line: number, term: string }>>}
 */
export async function scanForLeaks(rootDir, opts = {}) {
  const digests = opts.terms || opts.codePrefixes
    ? { terms: new Set((opts.terms ?? []).map(hashTerm)), prefixes: new Set((opts.codePrefixes ?? []).map(hashPrefix)) }
    : await loadDigests(opts.digestFile);
  const found = [];
  for await (const file of walk(rootDir, rootDir)) {
    const buf = await readFile(file);
    if (buf.includes(0)) continue; // ikili dosya
    buf.toString('utf8').split(/\r?\n/).forEach((text, i) => {
      for (const term of scanLine(text, digests)) found.push({ file, line: i + 1, term });
    });
  }
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, value] = process.argv.slice(2);
  if (flag === '--hash' || flag === '--hash-prefix') {
    if (!value) { console.error(`Kullanım: node tools/leak-scan.mjs ${flag} "<terim>"`); process.exit(1); }
    if (flag === '--hash-prefix' && !/^[A-Za-z]{3}$/.test(value)) { console.error('Önek 3 harf olmalı'); process.exit(1); }
    console.log(flag === '--hash' ? `t ${hashTerm(value)}` : `p ${hashPrefix(value)}`);
    process.exit(0);
  }
  const found = await scanForLeaks(flag ?? '.');
  if (found.length) {
    for (const f of found) console.error(`${f.file}:${f.line}: ${f.term}`);
    console.error(`${found.length} sızıntı bulundu`);
    process.exit(1);
  }
  console.log('Sızıntı yok');
}
