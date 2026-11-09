// Örnek TypeScript istemcileri kullanıcının projesinde `tsc --strict` ile derlenmelidir. Diğer testler onları
// --experimental-strip-types ile çalıştırır; bu tür denetimi yapmaz. Bu test tür hatalarını yakalar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { typecheck } from './ts-typecheck.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('örnek istemciler strict tsc ile hatasız derlenir', () => {
  const files = [
    'plugins/sms-skills/skills/netgsm-sms/references/examples/netgsm-client.ts',
    'plugins/sms-skills/skills/netgsm-iys/references/examples/iys-client.ts',
  ].map((f) => root + f);
  assert.equal(typecheck(files), '');
});
