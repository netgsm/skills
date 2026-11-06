import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smsSpec, identitySpec } from '../../packages/sms-mock/src/generated/specs.mjs';
import { loadDigests, scanLine } from '../leak-scan.mjs';

test('SMS spec 16 yolu (/balance dahil) ve ApiError kodlarını içerir', () => {
  assert.equal(Object.keys(smsSpec.paths).length, 16);
  assert.ok(smsSpec.paths['/balance'].get);
  assert.ok(smsSpec.components.schemas.ApiError.properties.code.enum.includes('QUEUE_UNCONFIRMED'));
});

test('Identity spec yalnızca /auth/v3 yollarını, canlı ve sandbox sunucularını içerir', () => {
  assert.deepEqual(Object.keys(identitySpec.paths).sort(),
    ['/auth/v3/me', '/auth/v3/token', '/auth/v3/token/refresh', '/auth/v3/token/revoke']);
  assert.deepEqual(identitySpec.servers.map(s => s.url), ['https://ext-api.netgsm.com.tr', 'https://ext-sandbox.netgsm.com.tr']);
  assert.equal(identitySpec.components.schemas.Token.properties.user_id.example, 100001, 'örnek hesap kimliği yayımlanan spec ile aynı');
});

test('Identity spec kullanılmayan etiket ve iç altyapı ifadesi içermez', async () => {
  const used = new Set();
  for (const item of Object.values(identitySpec.paths)) {
    for (const op of Object.values(item)) {
      if (op && typeof op === 'object') for (const t of op.tags ?? []) used.add(t);
    }
  }
  const unused = (identitySpec.tags ?? []).map(t => t.name).filter(n => !used.has(n));
  assert.deepEqual(unused, []);
  const digests = await loadDigests();
  assert.deepEqual(JSON.stringify(identitySpec, null, 1).split('\n').flatMap(l => scanLine(l, digests)), []);
});
