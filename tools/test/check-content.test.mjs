import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContent, checkAllSkills, SKILLS_ROOT } from '../check-content.mjs';

const REAL_SKILL = fileURLToPath(new URL('../../plugins/sms-skills/skills/netgsm-sms/', import.meta.url));
const REAL_IYS = join(SKILLS_ROOT, 'netgsm-iys');

const SKILL_MD = `---
name: netgsm-sms
description: Netgsm SMS API sorularında kullan.
---

# Netgsm SMS

[Hatalar](references/errors.md)
`;

/**
 * Gerçek spec kopyalarıyla geçici bir netgsm-sms dizini kurar (kurallar dizin adına göre seçilir);
 * files: { 'göreli/yol': 'içerik' }
 */
async function makeSkill(files = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), 'skill-')), 'netgsm-sms');
  await mkdir(join(dir, 'references', 'endpoints'), { recursive: true });
  for (const f of ['openapi.yaml', 'identity-openapi.json']) {
    await copyFile(join(REAL_SKILL, 'references', f), join(dir, 'references', f));
  }
  const all = { 'SKILL.md': SKILL_MD, 'references/errors.md': '# Hatalar\n', ...files };
  for (const [rel, text] of Object.entries(all)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

test('eksik hata kodunu bildirir', async () => {
  const dir = await makeSkill({ 'references/errors.md': '# Hatalar\n`INVALID_REQUEST` var ama diğerleri yok.\n' });
  const errors = await checkContent(dir, { only: ['errors'] });
  assert.ok(errors.some(e => e.includes('QUEUE_UNCONFIRMED')), errors.join('\n'));
  assert.ok(errors.some(e => e.includes('https_required')), 'identity ek kodu da aranır');
  assert.ok(errors.some(e => e.includes('NO_INTERNATIONAL_PERMISSION')), 'red nedenleri de aranır');
  assert.ok(errors.some(e => e.includes('SMS_DISABLED_ON_DEVICE')), 'iletim hata nedenleri de aranır');
  assert.ok(!errors.some(e => e.includes('`INVALID_REQUEST`')), 'var olan kod bildirilmez');
});

test('kodu yalnızca `KOD` biçiminde kabul eder', async () => {
  const dir = await makeSkill({ 'references/errors.md': 'QUEUE_UNCONFIRMED düz metin olarak geçiyor\n' });
  const errors = await checkContent(dir, { only: ['errors'] });
  assert.ok(errors.some(e => e.includes('QUEUE_UNCONFIRMED')));
});

test('kırık göreli bağlantıyı bildirir', async () => {
  const dir = await makeSkill({
    'SKILL.md': SKILL_MD + '\n[x](references/yok.md) [y](references/errors.md#bolum) [z](https://portal.netgsm.com.tr)\n',
    'references/auth.md': '[geri](../SKILL.md) [kırık](endpoints/send.md)\n```\n[kod içinde](yok-sayilir.md)\n```\n',
  });
  const errors = await checkContent(dir, { only: ['links'] });
  assert.ok(errors.some(e => e.includes('references/yok.md')), errors.join('\n'));
  assert.ok(errors.some(e => e.includes('endpoints/send.md')), errors.join('\n'));
  assert.equal(errors.length, 2, errors.join('\n'));
});

test('uydurma alt alan adını bildirir', async () => {
  const dir = await makeSkill({ 'references/auth.md': 'Test için https://sandbox.netgsm.com.tr kullanın.\n' });
  const errors = await checkContent(dir, { only: ['domains'] });
  assert.ok(errors.some(e => e.includes('sandbox.netgsm.com.tr')), errors.join('\n'));
});

test('izin listesi dışındaki URL\'yi bildirir, izinlileri geçirir', async () => {
  const dir = await makeSkill({
    'references/auth.md': [
      'https://ext-api.netgsm.com.tr/sms/v3 https://portal.netgsm.com.tr https://api-docs.netgsm.com.tr/',
      'https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/api-ile-sms https://www.netgsm.com.tr/fiyatlar/toplu-sms',
      'http://127.0.0.1:4010/auth/v3 http://localhost:4010 https://github.com/netgsm/skills',
      'https://www.rfc-editor.org/rfc/rfc9457 https://example.com/report',
      'teknikdestek@netgsm.com.tr',
      'https://api.netgsm.example.org/x https://github.com/baskasi/repo',
    ].join('\n'),
  });
  const errors = await checkContent(dir, { only: ['domains'] });
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.ok(errors.some(e => e.includes('api.netgsm.example.org')));
  assert.ok(errors.some(e => e.includes('github.com/baskasi/repo')));
});

test('frontmatter: ad, açıklama uzunluğu ve satır sınırı', async () => {
  const long = 'a'.repeat(1025);
  const dir = await makeSkill({ 'SKILL.md': `---\nname: baska\ndescription: ${long}\n---\n` + 'satır\n'.repeat(501) });
  const errors = await checkContent(dir, { only: ['frontmatter'] });
  assert.ok(errors.some(e => e.includes('name')), errors.join('\n'));
  assert.ok(errors.some(e => e.includes('1024')), errors.join('\n'));
  assert.ok(errors.some(e => e.includes('500')), errors.join('\n'));

  const ok = await makeSkill();
  assert.deepEqual(await checkContent(ok, { only: ['frontmatter'] }), []);
});

test('uç nokta dosyaları ve limit dosyasındaki yol adları', async () => {
  const dir = await makeSkill({
    'references/endpoints/send.md': '# send\n',
    'references/limits-and-batching.md': '`/send` ve `/sms/v3/length`\n',
  });
  const errors = await checkContent(dir, { only: ['endpoints', 'limits'] });
  assert.ok(errors.some(e => e.includes('send-directory.md')), errors.join('\n'));
  assert.ok(!errors.some(e => e.includes('endpoints/send.md')), errors.join('\n'));
  const limitErrors = errors.filter(e => e.startsWith('references/limits-and-batching.md'));
  assert.ok(limitErrors.some(e => e.endsWith(': /send/otp')), errors.join('\n'));
  assert.ok(!limitErrors.some(e => e.endsWith(': /send')), 'tek başına `/send` bulunur');
  assert.ok(!limitErrors.some(e => e.endsWith(': /length')), '/sms/v3/length biçimi de kabul edilir');
});

test('gerçek skill dizini bütün kontrollerden temiz geçer', async () => {
  assert.deepEqual(await checkContent(REAL_SKILL), []);
});

/** Geçici bir dizinde verilen adla skill kurar; İYS için gerçek spec kopyalanır. */
async function makeNamedSkill(name, files) {
  const dir = join(await mkdtemp(join(tmpdir(), 'skill-')), name);
  if (name === 'netgsm-iys') {
    await mkdir(join(dir, 'references'), { recursive: true });
    await copyFile(join(REAL_IYS, 'references', 'openapi.yaml'), join(dir, 'references', 'openapi.yaml'));
  }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const fm = (name) => `---\nname: ${name}\ndescription: Deneme.\n---\n\n# ${name}\n`;

test('frontmatter name dizin adıyla aynı olmalı', async () => {
  const dir = await makeNamedSkill('netgsm-yeni', { 'SKILL.md': fm('netgsm-sms') });
  const errors = await checkContent(dir, { only: ['frontmatter'] });
  assert.ok(errors.some(e => e.includes('"netgsm-yeni"')), errors.join('\n'));
  const ok = await makeNamedSkill('netgsm-yeni', { 'SKILL.md': fm('netgsm-yeni') });
  assert.deepEqual(await checkContent(ok, { only: ['frontmatter'] }), []);
});

test('kaynak gösterimi: SKILL.md api-docs ve Bilgi Bankası, referanslar api-docs bağlantısı taşır', async () => {
  const dir = await makeNamedSkill('netgsm-yeni', {
    'SKILL.md': fm('netgsm-yeni'),
    'references/errors.md': '# Hatalar\nKaynak yok.\n',
    'references/usage.md': '**Kaynak:** https://api-docs.netgsm.com.tr/get-balance/\n',
    'references/examples/curl.md': '# örnek, muaf\n',
  });
  const errors = await checkContent(dir, { only: ['sources'] });
  assert.ok(errors.some(e => e.startsWith('SKILL.md') && e.includes('api-docs')), errors.join('\n'));
  assert.ok(errors.some(e => e.startsWith('SKILL.md') && e.includes('bilgibankasi')), errors.join('\n'));
  assert.ok(errors.some(e => e.startsWith('references/errors.md')), errors.join('\n'));
  assert.equal(errors.length, 3, errors.join('\n'));
});

test('netgsm-iys: hata tablosu, enum değerleri ve uç nokta dosyaları spec\'ten okunur', async () => {
  const dir = await makeNamedSkill('netgsm-iys', {
    'SKILL.md': fm('netgsm-iys'),
    'references/errors.md': '`50` `UNAUTHENTICATED` `63` `IYS_MODULE_INACTIVE`\n',
    'references/consents.md': '`ONAY` `RET` `HS_WEB`\n',
  });
  const errors = await checkContent(dir, { only: ['errors', 'endpoints'] });
  assert.ok(errors.some(e => e.includes('errors.md: eksik kod `141`')), errors.join('\n'));
  assert.ok(errors.some(e => e.includes('errors.md: eksik kod `INTEGRATION_ERROR`')), errors.join('\n'));
  assert.ok(!errors.some(e => e.includes('`63`')), 'var olan kod bildirilmez');
  assert.ok(errors.some(e => e.includes('consents.md: eksik kod `HS_KARAR`')), errors.join('\n'));
  assert.ok(errors.some(e => e.includes('webhook.md yok (/webhooks)')), errors.join('\n'));
  assert.ok(!errors.some(e => e.includes('consents.md yok')), errors.join('\n'));
});

test('kuralı olmayan skill\'de yalnızca genel kontroller çalışır', async () => {
  const dir = await makeNamedSkill('netgsm-yeni', { 'SKILL.md': fm('netgsm-yeni') });
  assert.deepEqual(await checkContent(dir, { only: ['errors', 'endpoints', 'limits', 'frontmatter'] }), []);
});

test('skill dizini dışına göreli bağlantı bildirilir (zip\'te skill tek başına yüklenir)', async () => {
  const dir = await makeNamedSkill('netgsm-iys', {
    'SKILL.md': fm('netgsm-iys') + '[sms](../netgsm-sms/SKILL.md)\n',
  });
  const errors = await checkContent(dir, { only: ['links'] });
  assert.ok(errors.some(e => e.includes('skill dizini dışına')), errors.join('\n'));
});

test('izinli adresler: iys.org.tr; eski kredi sorgu adresi (api.netgsm.com.tr) ve paket sayfaları izinli değil', async () => {
  const dir = await makeNamedSkill('netgsm-yeni', {
    'references/x.md': [
      'https://iys.org.tr https://www.iys.org.tr/',
      'https://api.netgsm.com.tr/balance',
      'https://pypi.org/project/netgsm-sms/ https://www.npmjs.com/package/@netgsm/sms',
    ].join('\n'),
  });
  const errors = await checkContent(dir, { only: ['domains'] });
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.ok(errors.some(e => e.includes('izin verilmeyen alan adı api.netgsm.com.tr')), errors.join('\n'));
  assert.ok(errors.some(e => e.includes('pypi.org/project/netgsm-sms')));
  assert.ok(errors.some(e => e.includes('npmjs.com/package/@netgsm/sms')));
});

test('bütün gerçek skill dizinleri temiz geçer', async () => {
  const { skills, errors } = await checkAllSkills();
  assert.deepEqual(skills, ['netgsm-iys', 'netgsm-sms']);
  assert.deepEqual(errors, []);
});
