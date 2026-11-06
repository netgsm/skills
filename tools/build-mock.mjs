import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = new URL('../plugins/sms-skills/skills/netgsm-sms/scripts/netgsm-sms-mock.mjs', import.meta.url);

const BANNER = [
  '#!/usr/bin/env node',
  "// Netgsm SMS API v3 yerel mock'u — kaynak: github.com/netgsm/skills",
  '// Bu dosya packages/sms-mock/src/cli.mjs dosyasından `npm run build` ile üretilir; elle değiştirmeyin.',
].join('\n');

// Çıktı bayt düzeyinde belirleyicidir: zaman damgası ve mutlak yol içermez.
const result = await build({
  entryPoints: ['packages/sms-mock/src/cli.mjs'],
  absWorkingDir: ROOT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: BANNER },
  legalComments: 'none',
  charset: 'utf8',
  write: false,
  metafile: true,
  logLevel: 'warning',
  // ESM paketine gömülen CJS bağımlılıkları (ajv) require kullanır.
  define: {},
});

let text = result.outputFiles[0].text;
// CJS bağımlılıkları için require köprüsü: banner'dan sonra, ilk import'lardan önce.
const bridge = "import { createRequire as __netgsmCreateRequire } from 'node:module';\nconst require = __netgsmCreateRequire(import.meta.url);\n";
const at = text.indexOf('\n', text.indexOf("// Bu dosya")) + 1;
text = text.slice(0, at) + bridge + text.slice(at);

// Gömülen üçüncü taraf paketlerin lisans metinleri dosyanın sonuna eklenir (MIT/ISC/BSD bildirim şartı).
const packages = [...new Set(Object.keys(result.metafile.inputs)
  .map(p => p.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1])
  .filter(Boolean))].sort();
const notices = [];
for (const name of packages) {
  const dir = new URL(`../node_modules/${name}/`, import.meta.url);
  const { version, license } = JSON.parse(await readFile(new URL('package.json', dir), 'utf8'));
  const file = (await readdir(dir)).find(f => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`${name} paketinde lisans dosyası bulunamadı`);
  const body = (await readFile(new URL(file, dir), 'utf8')).replace(/\r\n/g, '\n').trim().replaceAll('*/', '* /');
  notices.push(`${name}@${version} (${license})\n\n${body}`);
}
text += `\n/*\n * Bu dosyaya gömülen üçüncü taraf paketler ve lisansları\n * Third-party packages bundled into this file and their licenses\n\n${notices.join('\n\n-----\n\n')}\n*/\n`;

await mkdir(new URL('./', OUT), { recursive: true });
await writeFile(OUT, text);
console.log(`Yazıldı: ${fileURLToPath(OUT)} (${Buffer.byteLength(text)} bayt)`);
