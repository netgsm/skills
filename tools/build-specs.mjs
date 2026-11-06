import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REFERENCES = new URL('../plugins/sms-skills/skills/netgsm-sms/references/', import.meta.url);
const OUT = new URL('../packages/sms-mock/src/generated/specs.mjs', import.meta.url);

const smsSpec = parse(await readFile(new URL('openapi.yaml', REFERENCES), 'utf8'));
const identitySpec = JSON.parse(await readFile(new URL('identity-openapi.json', REFERENCES), 'utf8'));

await mkdir(new URL('./', OUT), { recursive: true });
await writeFile(OUT,
  '// Otomatik üretilir: npm run build:specs\n' +
  `export const smsSpec = ${JSON.stringify(smsSpec, null, 2)};\n` +
  `export const identitySpec = ${JSON.stringify(identitySpec, null, 2)};\n`);
console.log(`Yazıldı: ${fileURLToPath(OUT)}`);
