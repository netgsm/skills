// Skill içeriği kontrolü. `plugins/sms-skills/skills/` altındaki her skill dizini için:
// - genel kontroller (her skill): frontmatter (name = dizin adı), göreli bağlantılar, alan adları,
//   resmî kaynak gösterimi (api-docs ve Bilgi Bankası bağlantıları);
// - skill'e özgü kontroller (SKILL_RULES): hata kodu ve enum kapsamı, uç nokta dosyaları, limit
//   dosyasındaki yol adları. Kod ve yol listeleri her zaman skill'in kendi spec'inden okunur.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, relative, extname, sep, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const ALL_CHECKS = ['frontmatter', 'errors', 'links', 'endpoints', 'limits', 'domains', 'sources'];

export const SKILLS_ROOT = fileURLToPath(new URL('../plugins/sms-skills/skills/', import.meta.url));

/** netgsm-sms: spec yolu → references/endpoints/ altındaki dosya. */
export const ENDPOINT_FILES = {
  '/send': 'send.md',
  '/directory/send': 'send-directory.md',
  '/send/template': 'send-template.md',
  '/send/otp': 'send-otp.md',
  '/length': 'length.md',
  '/cancel': 'cancel.md',
  '/report': 'report.md',
  '/stats': 'stats.md',
  '/inbox': 'inbox.md',
  '/senders': 'senders.md',
  '/senders/default': 'senders.md',
  '/templates': 'templates.md',
  '/blacklist': 'blacklist.md',
  '/webhooks/report': 'webhooks.md',
  '/webhooks/inbox': 'webhooks.md',
  '/balance': 'balance.md',
};

/** netgsm-iys: spec yolu → references/ altındaki dosya. */
export const IYS_ENDPOINT_FILES = {
  '/consents': 'consents.md',
  '/webhooks': 'webhook.md',
};

const OFFICIAL_DOCS = 'https://api-docs.netgsm.com.tr/';
const KNOWLEDGE_BASE = 'https://bilgibankasi.netgsm.com.tr/';

const NETGSM_HOSTS = new Set(['ext-api', 'ext-sandbox', 'portal', 'api-docs', 'bilgibankasi', 'www'].map(h => `${h}.netgsm.com.tr`));
const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.yaml', '.yml', '.txt']);
// Spec kopyaları ve bundle yazılmış içerik değildir; URL izin listesi yalnızca yazılan içeriğe uygulanır.
const AUTHORED_EXTENSIONS = new Set(['.md', '.ts']);

const exists = (p) => stat(p).then(() => true, () => false);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const relPath = (root, file) => relative(root, file).split(sep).join('/');
const readSpec = async (skillDir, name) => {
  const text = await readFile(join(skillDir, 'references', name), 'utf8');
  return name.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
};

// --- Skill'e özgü kurallar ----------------------------------------------------------------------

/** netgsm-sms: references/errors.md'de bulunması gereken kodlar. */
async function smsRequiredCodes(skillDir) {
  const sms = await readSpec(skillDir, 'openapi.yaml');
  const identity = await readSpec(skillDir, 'identity-openapi.json');
  const schemas = sms.components.schemas;
  const failReasons = new Set();
  for (const schema of Object.values(schemas)) {
    for (const v of schema?.properties?.failReason?.enum ?? []) failReasons.add(v);
  }
  const file = 'references/errors.md';
  return [
    [file, 'SMS ApiError.code', schemas.ApiError.properties.code.enum],
    [file, 'Identity code', [...identity.components.schemas.Problem.properties.code.enum, 'https_required']],
    [file, 'RejectedMessage.reason', schemas.RejectedMessage.properties.reason.enum],
    [file, 'iletim hata nedeni (failReason)', [...failReasons]],
  ];
}

/**
 * netgsm-iys: spec açıklamasındaki hata tablosunun (`| 50 | \`UNAUTHENTICATED\` | 401 | ...`) her
 * satırı errors.md'de, izin şemalarının enum değerleri consents.md'de bulunmalıdır.
 */
async function iysRequiredCodes(skillDir) {
  const spec = await readSpec(skillDir, 'openapi.yaml');
  const numbers = [];
  const names = [];
  for (const [, num, name] of String(spec.info?.description ?? '').matchAll(/^\|\s*(\d+)\s*\|\s*`([A-Z_]+)`\s*\|/gm)) {
    numbers.push(num);
    names.push(name);
  }
  if (!numbers.length) throw new Error('netgsm-iys openapi.yaml: hata kodu tablosu bulunamadı');
  const s = spec.components.schemas;
  const enums = ['IysPath', 'RecipientType', 'ConsentType', 'ConsentStatus', 'ConsentSource'].flatMap(n => s[n].enum);
  return [
    ['references/errors.md', 'İYS errorCode', numbers],
    ['references/errors.md', 'İYS hata adı', names],
    ['references/consents.md', 'İYS enum değeri', enums],
  ];
}

/**
 * Skill'e özgü kurallar; anahtar skill dizininin adıdır. Burada olmayan bir skill'de yalnızca genel
 * kontroller çalışır.
 * - requiredCodes(skillDir) → [dosya, grup, kodlar][]: kodlar dosyada `KOD` biçiminde aranır.
 * - endpoints: spec'teki her yolun dosyası `dir` altında bulunmalıdır.
 * - limitsFile: spec'teki her yol bu dosyada geçmelidir.
 * - sourcesExempt: api-docs bağlantısı aranmayan referans dosyaları (references/examples/ her zaman muaf).
 */
export const SKILL_RULES = {
  'netgsm-sms': {
    requiredCodes: smsRequiredCodes,
    endpoints: { spec: 'openapi.yaml', dir: 'references/endpoints', files: ENDPOINT_FILES },
    limitsFile: 'references/limits-and-batching.md',
    sourcesExempt: ['references/testing.md'],
  },
  'netgsm-iys': {
    requiredCodes: iysRequiredCodes,
    endpoints: { spec: 'openapi.yaml', dir: 'references', files: IYS_ENDPOINT_FILES },
  },
};

// --- Genel kontroller ---------------------------------------------------------------------------

function checkFrontmatter(text, expectedName) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  if (lines.length > 500) errors.push(`SKILL.md: ${lines.length} satır, en fazla 500 olmalı`);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return [...errors, 'SKILL.md: frontmatter (--- ... ---) yok'];
  let fm;
  try {
    fm = parseYaml(m[1]) ?? {};
  } catch (err) {
    return [...errors, `SKILL.md: frontmatter YAML olarak okunamadı: ${err.message}`];
  }
  if (fm.name !== expectedName) {
    errors.push(`SKILL.md: frontmatter name dizin adıyla aynı olmalı: "${expectedName}" (bulunan: ${JSON.stringify(fm.name)})`);
  }
  if (typeof fm.description !== 'string' || !fm.description.trim()) {
    errors.push('SKILL.md: frontmatter description yok ya da boş');
  } else if (fm.description.length > 1024) {
    errors.push(`SKILL.md: description ${fm.description.length} karakter, en fazla 1024 olmalı`);
  }
  return errors;
}

/** Çitli kod bloklarını boşaltır (satır sayısını korur); bağlantı taraması bunları atlar. */
const stripFences = (text) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (b) => b.replace(/[^\n]/g, ''));

async function checkLinks(skillDir, mdFiles) {
  const errors = [];
  const linkRe = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const file of mdFiles) {
    const text = stripFences(await readFile(file, 'utf8'));
    for (const [, target] of text.matchAll(linkRe)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const path = decodeURI(target.split('#')[0].split('?')[0]);
      if (!path) continue;
      const abs = resolve(dirname(file), path);
      // Zip'te her skill tek başına yüklenir: bağlantı skill dizininin dışına çıkamaz.
      if (relative(skillDir, abs).startsWith('..')) {
        errors.push(`${relPath(skillDir, file)}: skill dizini dışına bağlantı ${target} (başka skill'i adıyla anın)`);
      } else if (!(await exists(abs))) {
        errors.push(`${relPath(skillDir, file)}: kırık bağlantı ${target}`);
      }
    }
  }
  return errors;
}

function urlAllowed(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (NETGSM_HOSTS.has(host)) return true;
  if (host === '127.0.0.1' || host === 'localhost') return true;
  if (host === 'github.com') return /^\/netgsm\/skills(\/|$)/.test(url.pathname);
  if (host === 'rfc-editor.org' || host.endsWith('.rfc-editor.org')) return true;
  // İleti Yönetim Sistemi'nin resmî sitesi (İYS üyeliği).
  if (host === 'iys.org.tr' || host === 'www.iys.org.tr') return true;
  // RFC 2606 belge alan adı; spec'in webhook örnekleri bunu kullanır, gerçek bir adres olamaz.
  if (host === 'example.com' || host.endsWith('.example.com')) return true;
  return false;
}

async function checkDomains(skillDir, files) {
  const errors = [];
  const subdomainRe = /(?<![a-z0-9.@-])((?:[a-z0-9-]+\.)+netgsm\.com\.tr)(?![a-z0-9-])/gi;
  const urlRe = /https?:\/\/[^\s)<>"'`\]|]+/gi;
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const rel = relPath(skillDir, file);
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [, host] of line.matchAll(subdomainRe)) {
        if (!NETGSM_HOSTS.has(host.toLowerCase())) errors.push(`${rel}:${i + 1}: izin verilmeyen alan adı ${host}`);
      }
      if (!AUTHORED_EXTENSIONS.has(ext)) return;
      for (const [match] of line.matchAll(urlRe)) {
        const url = match.replace(/[.,;:!?]+$/, '');
        let host = '';
        try { host = new URL(url).hostname.toLowerCase(); } catch { /* geçersiz URL aşağıda bildirilir */ }
        if (host.endsWith('.netgsm.com.tr')) continue; // alt alan adı yukarıda denetlendi
        if (!urlAllowed(url)) errors.push(`${rel}:${i + 1}: izin listesinde olmayan URL ${url}`);
      }
    });
  }
  return errors;
}

/**
 * Resmî kaynak gösterimi (SKILL.md kural: her yanıt api-docs sayfasını gösterir, takılınca Bilgi
 * Bankası). SKILL.md iki bağlantıyı da, her referans dosyası (references/examples/ ve muaflar hariç)
 * en az bir api-docs bağlantısını içermelidir.
 */
async function checkSources(skillDir, mdFiles, exempt = []) {
  const errors = [];
  for (const file of mdFiles) {
    const rel = relPath(skillDir, file);
    const text = await readFile(file, 'utf8');
    if (rel === 'SKILL.md') {
      if (!text.includes(OFFICIAL_DOCS)) errors.push(`SKILL.md: resmî doküman bağlantısı (${OFFICIAL_DOCS}) yok`);
      if (!text.includes(KNOWLEDGE_BASE)) errors.push(`SKILL.md: Bilgi Bankası bağlantısı (${KNOWLEDGE_BASE}) yok`);
      continue;
    }
    if (rel.startsWith('references/examples/') || exempt.includes(rel)) continue;
    if (!text.includes(OFFICIAL_DOCS)) errors.push(`${rel}: resmî doküman bağlantısı (${OFFICIAL_DOCS}...) yok`);
  }
  return errors;
}

async function checkRequiredCodes(skillDir, groups) {
  const errors = [];
  const cache = new Map();
  for (const [file, group, codes] of groups) {
    if (!cache.has(file)) {
      const p = join(skillDir, file);
      cache.set(file, (await exists(p)) ? await readFile(p, 'utf8') : null);
    }
    const text = cache.get(file);
    if (text === null) {
      errors.push(`${file} yok`);
      continue;
    }
    for (const code of codes) {
      if (!text.includes(`\`${code}\``)) errors.push(`${file}: eksik kod \`${code}\` (${group})`);
    }
  }
  return [...new Set(errors)];
}

async function checkEndpoints(skillDir, { spec, dir, files }) {
  const errors = [];
  const doc = await readSpec(skillDir, spec);
  for (const path of Object.keys(doc.paths)) {
    const file = files[path];
    if (!file) {
      errors.push(`spec yolu ${path} için ${dir}/ eşlemesi yok`);
    } else if (!(await exists(join(skillDir, dir, file)))) {
      errors.push(`${dir}/${file} yok (${path})`);
    }
  }
  return errors;
}

async function checkLimits(skillDir, limitsFile, specName) {
  const file = join(skillDir, limitsFile);
  if (!(await exists(file))) return [`${limitsFile} yok`];
  const sms = await readSpec(skillDir, specName);
  const text = await readFile(file, 'utf8');
  const errors = [];
  for (const path of Object.keys(sms.paths)) {
    const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^A-Za-z0-9_/]|/sms/v3)${esc}(?![A-Za-z0-9_/-])`);
    if (!re.test(text)) errors.push(`${limitsFile} yolu içermiyor: ${path}`);
  }
  return errors;
}

/**
 * Tek bir skill dizinini denetler. Skill'e özgü kurallar dizin adına göre seçilir (SKILL_RULES).
 * @param {string} skillDir
 * @param {{ only?: string[] }} [opts] yalnızca bu kontrolleri çalıştırır
 * @returns {Promise<string[]>} hata mesajları; boşsa içerik temiz
 */
export async function checkContent(skillDir, opts = {}) {
  const run = new Set(opts.only ?? ALL_CHECKS);
  for (const c of run) if (!ALL_CHECKS.includes(c)) throw new Error(`bilinmeyen kontrol: ${c}`);
  const name = basename(resolve(skillDir));
  const rules = SKILL_RULES[name] ?? {};
  const files = [];
  for await (const f of walk(skillDir)) files.push(f);
  const mdFiles = files.filter(f => {
    const rel = relPath(skillDir, f);
    return rel === 'SKILL.md' || (rel.startsWith('references/') && rel.endsWith('.md'));
  });

  const errors = [];
  if (run.has('frontmatter')) {
    const skillMd = join(skillDir, 'SKILL.md');
    if (await exists(skillMd)) errors.push(...checkFrontmatter(await readFile(skillMd, 'utf8'), name));
    else errors.push('SKILL.md yok');
  }
  if (run.has('errors') && rules.requiredCodes) errors.push(...await checkRequiredCodes(skillDir, await rules.requiredCodes(skillDir)));
  if (run.has('links')) errors.push(...await checkLinks(skillDir, mdFiles));
  if (run.has('endpoints') && rules.endpoints) errors.push(...await checkEndpoints(skillDir, rules.endpoints));
  if (run.has('limits') && rules.limitsFile) errors.push(...await checkLimits(skillDir, rules.limitsFile, rules.endpoints.spec));
  if (run.has('domains')) errors.push(...await checkDomains(skillDir, files));
  if (run.has('sources')) errors.push(...await checkSources(skillDir, mdFiles, rules.sourcesExempt));
  return errors;
}

/** `root` altındaki skill dizinlerinin adları (sıralı). */
export async function listSkills(root = SKILLS_ROOT) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
}

/**
 * Bütün skill dizinlerini denetler. Hata mesajlarının başında skill adı bulunur.
 * @returns {Promise<{ skills: string[], errors: string[] }>}
 */
export async function checkAllSkills(root = SKILLS_ROOT, opts = {}) {
  const skills = await listSkills(root);
  const errors = [];
  if (!skills.length) errors.push(`${root}: skill dizini yok`);
  for (const s of skills) {
    for (const e of await checkContent(join(root, s), opts)) errors.push(`${s}/${e}`);
  }
  return { skills, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  const { skills, errors } = target
    ? { skills: [basename(resolve(target))], errors: await checkContent(target) }
    : await checkAllSkills();
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`${errors.length} içerik sorunu bulundu`);
    process.exit(1);
  }
  console.log(`İçerik temiz (${skills.join(', ')}: ${ALL_CHECKS.join(', ')})`);
}
