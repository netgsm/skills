import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { scanForLeaks } from '../leak-scan.mjs';
import { listSkills } from '../build-zip.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = ['netgsm-iys', 'netgsm-sms'];

function build() {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/build-zip.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(SKILLS.map(s => [s, readFileSync(join(ROOT, `dist/${s}.zip`))]));
}

test('her skill için bir zip üretilir', () => {
  assert.deepEqual(listSkills(), SKILLS);
});

test('zip yapısı claude.ai için doğru (kendi kök dizini, SKILL.md, references, LICENSE)', async () => {
  const zips = build();
  for (const skill of SKILLS) {
    const files = unzipSync(new Uint8Array(zips[skill]));
    const keys = Object.keys(files).filter(k => !k.endsWith('/'));
    assert.ok(keys.includes(`${skill}/SKILL.md`), skill);
    assert.ok(keys.includes(`${skill}/LICENSE`), skill);
    assert.ok(keys.some(k => k.startsWith(`${skill}/references/`)), skill);
    for (const k of keys) {
      assert.ok(k.startsWith(`${skill}/`), `beklenmeyen kök: ${k}`);
      assert.ok(/^[^/]+\/(SKILL\.md|LICENSE|references\/.+|scripts\/.+)$/.test(k), `fazladan dosya: ${k}`);
    }
    // Sızıntı taraması: her dosya geçici dizine açılıp taranır.
    const tmp = mkdtempSync(join(tmpdir(), 'netgsm-zipscan-'));
    try {
      for (const k of keys) {
        const p = join(tmp, k);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, files[k]);
      }
      assert.deepEqual(await scanForLeaks(tmp), [], skill);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('yalnızca SMS zip\'i mock\'u taşır; İYS zip\'inde mock yoktur', () => {
  const zips = build();
  const keysOf = (s) => Object.keys(unzipSync(new Uint8Array(zips[s])));
  assert.ok(keysOf('netgsm-sms').includes('netgsm-sms/scripts/netgsm-sms-mock.mjs'));
  for (const s of ['netgsm-iys']) {
    assert.ok(!keysOf(s).some(k => k.includes('/scripts/')), `${s} zip'inde scripts/ olmamalı`);
  }
  assert.ok(keysOf('netgsm-iys').includes('netgsm-iys/references/openapi.yaml'));
});

test('zip deterministiktir (iki üretim aynı baytlar)', () => {
  const a = build();
  const b = build();
  for (const s of SKILLS) assert.ok(a[s].equals(b[s]), s);
});
