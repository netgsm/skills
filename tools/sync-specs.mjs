import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REFERENCES = fileURLToPath(new URL('../plugins/sms-skills/skills/netgsm-sms/references/', import.meta.url));
// Yayımlanan Identity spec'iyle (api-docs) aynı ortamlar: canlı ve sandbox. Yollar /auth/v3 önekini taşır.
const SERVERS = [
  { url: 'https://ext-api.netgsm.com.tr', description: 'Canlı ortam' },
  { url: 'https://ext-sandbox.netgsm.com.tr', description: 'Sandbox' },
];
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Identity spec'inden /health/* yollarını, kullanılmayan etiketleri ve iç sunucu bilgisini çıkarır; sunucular canlı ve sandbox'tır. */
export function cleanIdentitySpec(spec) {
  const out = { ...spec, paths: {} };
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!path.startsWith('/health/') && path !== '/health') out.paths[path] = item;
  }
  out.servers = SERVERS;
  if (Array.isArray(out.tags)) {
    const used = new Set();
    for (const item of Object.values(out.paths)) {
      for (const m of HTTP_METHODS) for (const t of item[m]?.tags ?? []) used.add(t);
    }
    out.tags = out.tags.filter(t => used.has(t.name));
    if (!out.tags.length) delete out.tags;
  }
  return out;
}

export async function syncSpecs(smsYamlPath, identityJsonPath) {
  await mkdir(REFERENCES, { recursive: true });
  await copyFile(resolve(smsYamlPath), `${REFERENCES}openapi.yaml`);
  const identity = JSON.parse(await readFile(resolve(identityJsonPath), 'utf8'));
  await writeFile(`${REFERENCES}identity-openapi.json`, JSON.stringify(cleanIdentitySpec(identity), null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sms, identity] = process.argv.slice(2);
  if (!sms || !identity) {
    console.error('Usage: node tools/sync-specs.mjs <smsYamlPath> <identityJsonPath>');
    process.exit(2);
  }
  await syncSpecs(sms, identity);
  console.log('Spec copies updated');
}
