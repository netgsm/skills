// claude.ai için her skill'i ayrı bir zip olarak paketler: dist/<skill>.zip. Her zip'in kökünde skill
// adıyla bir dizin bulunur (SKILL.md, references/, varsa scripts/ ve LICENSE). Çıktı deterministiktir:
// dosyalar sıralanır ve sabit mtime kullanılır.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SKILLS_ROOT = join(ROOT, 'plugins/sms-skills/skills');
const DIST = join(ROOT, 'dist');
/** Zip'e giren skill içeriği: SKILL.md ve bu dizinler. */
const INCLUDED_DIRS = ['references', 'scripts'];
const MTIME = new Date(Date.UTC(2020, 0, 1));

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Skill dizinlerinin adları (SKILL.md taşıyanlar), sıralı. */
export function listSkills(root = SKILLS_ROOT) {
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
    .map(e => e.name)
    .sort();
}

/** Bir skill'in zip baytlarını üretir. */
export function buildSkillZip(name, root = SKILLS_ROOT) {
  const skillDir = join(root, name);
  const rels = [
    'SKILL.md',
    ...INCLUDED_DIRS
      .filter(d => existsSync(join(skillDir, d)))
      .flatMap(d => listFiles(join(skillDir, d)).map(f => relative(skillDir, f).split(sep).join('/'))),
  ].sort();
  const entries = {};
  for (const rel of rels) {
    entries[`${name}/${rel}`] = [new Uint8Array(readFileSync(join(skillDir, rel))), { mtime: MTIME, level: 9 }];
  }
  entries[`${name}/LICENSE`] = [new Uint8Array(readFileSync(join(ROOT, 'LICENSE'))), { mtime: MTIME, level: 9 }];
  return { bytes: zipSync(entries), count: rels.length + 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(DIST, { recursive: true });
  for (const name of listSkills()) {
    const out = join(DIST, `${name}.zip`);
    const { bytes, count } = buildSkillZip(name);
    writeFileSync(out, bytes);
    console.log(`${relative(ROOT, out).split(sep).join('/')}: ${count} dosya`);
  }
}
