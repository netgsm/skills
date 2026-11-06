// Sözleşme testi: spec'in kendi örnekleri mock'a gönderilir; durum belgelenmiş olmalı ve
// gövde o durumun şemasına uymalıdır. Sapma bulunursa mock düzeltilir, test gevşetilmez.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../src/server.mjs';
import { createSchemaValidator } from '../src/sms/schema.mjs';
import { smsSpec, identitySpec } from '../src/generated/specs.mjs';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const SPEC_JOB_ID = '179309912974612345062827';
const ACCOUNT = { username: '8500000000', password: 'password001', scope: 'sms' };

// R11: spec örneklerindeki yer tutucular seed verisiyle değiştirilir. Spec'teki örnek jobId
// hiç oluşturulmadığı için gerçek bir görevin kimliğiyle değiştirilir.
const substitute = (value, jobId, month) => JSON.parse(JSON.stringify(value)
  .replaceAll('"NETGSM"', '"MOCKTEST"')
  .replaceAll('905xxxxxxxxx', '905061234567')
  .replaceAll(SPEC_JOB_ID, jobId)
  .replaceAll('"2026-09"', `"${month}"`)); // /stats month örneği: gerçek görevin ayı

// Spec örneği bir hatayı göstermek için yazılmışsa beklenen durum açıkça burada belirtilir.
// Varsayılan: operasyonun belgelenmiş en küçük 2xx durumu.
const EXPECTED = {
  'POST /auth/v3/token/refresh [spec example uuid]': 401, // örnek UUID hiç verilmemiş bir token'dır
};
// Spec örneklerinde kendi içinde çelişki bulunursa subtest `todo` olur: etiket -> tek satır neden.
const TODO = {};

function resolveRef(spec, node) {
  while (node && node.$ref) node = node.$ref.replace(/^#\//, '').split('/').reduce((n, p) => n[p], spec);
  return node;
}

/** Bir yanıtın (varsa) içerik türünü ve JSON şemasını döner. */
function responseSchema(spec, op, status) {
  const res = resolveRef(spec, op.responses[String(status)]);
  const content = res?.content ?? {};
  const ct = Object.keys(content)[0];
  return ct ? { ct, schema: content[ct].schema } : null;
}

/** Satır içi ya da $ref'li şemayı createSchemaValidator ile doğrular. */
function validateAgainst(spec, schema, value) {
  const name = '__ContractTarget';
  const patched = { ...spec, components: { ...spec.components, schemas: { ...spec.components.schemas, [name]: schema } } };
  return createSchemaValidator(patched).validate(name, value);
}

/** Şema property örneklerinden gövde kurar (spec'te gövde örneği olmayan operasyonlar için). */
function bodyFromSchemaExamples(spec, schemaRef) {
  const schema = resolveRef(spec, schemaRef);
  return Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([, v]) => v.example !== undefined).map(([k, v]) => [k, v.example]));
}

function* operations(spec) {
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) if (item[method]) yield { method, path, op: item[method] };
  }
}

/** Her operasyon için { label, ct?, body?, query } örnekleri üretir. */
function* cases(spec, { method, path, op }, label0) {
  const label = `${method.toUpperCase()} ${label0}`;
  const query = {};
  for (const p of (op.parameters ?? []).map(x => resolveRef(spec, x))) {
    if (p.in === 'query' && p.example !== undefined) query[p.name] = p.example;
  }
  const content = op.requestBody?.content;
  if (!content) { yield { label, query }; return; }
  for (const [ct, media] of Object.entries(content)) {
    const examples = [];
    if (media.example !== undefined) examples.push([null, media.example]);
    for (const [k, e] of Object.entries(media.examples ?? {})) examples.push([k, e.value]);
    if (examples.length === 0) {
      yield { label: `${label} [${ct}]`, ct, body: bodyFromSchemaExamples(spec, media.schema), query };
      continue;
    }
    for (const [k, value] of examples) yield { label: k ? `${label} [${k}]` : label, ct, body: value, query };
  }
}

async function exercise({ identity, path, method }, c) {
  const server = createMockServer({ port: 0, log: () => {}, rateScale: 1000 });
  try {
    const base = await server.listen();
    const tokens = await (await fetch(`${base}/auth/v3/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ACCOUNT),
    })).json();
    const auth = { authorization: `Bearer ${tokens.access_token}` };
    const sent = await (await fetch(`${base}/sms/v3/send`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'MOCKTEST', messages: [{ text: 'Merhaba', recipient: '905061234568' }] }),
    })).json();
    let jobId = sent.jobId;
    const month = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);
    const post = (p, b) => fetch(`${base}/sms/v3${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    // Önkoşullar: iptal için bekleyen (zamanlanmış) görev; webhook silme için kayıtlı webhook.
    if (!identity && path === '/cancel') {
      const later = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, '+00:00');
      jobId = (await (await post('/send', { sender: 'MOCKTEST', startAt: later, messages: [{ text: 'Merhaba', recipient: '905061234569' }] })).json()).jobId;
    }
    if (!identity && method === 'delete' && path.startsWith('/webhooks/')) {
      await post(path, { url: `https://example.com${path.slice(9)}` });
    }

    const isTokenCall = identity && /\/token(\/refresh)?$/.test(path);
    const headers = { accept: 'application/json', ...(isTokenCall ? {} : auth) };
    let body = c.body === undefined ? undefined : substitute(c.body, jobId, month);
    if (isTokenCall && path.endsWith('/token')) body = { ...body, username: ACCOUNT.username, password: ACCOUNT.password, scope: ACCOUNT.scope };
    if (isTokenCall && path.endsWith('/refresh') && !c.label.includes('spec example uuid')) body = { refresh_token: tokens.refresh_token };

    const url = new URL(`${base}${identity ? '' : '/sms/v3'}${path}`);
    for (const [k, v] of Object.entries(c.query)) for (const item of [].concat(substitute(v, jobId, month))) url.searchParams.append(k, item);
    let payload;
    if (body !== undefined) {
      payload = c.ct === 'application/x-www-form-urlencoded' ? new URLSearchParams(body).toString() : JSON.stringify(body);
      headers['content-type'] = c.ct;
    }
    const res = await fetch(url, { method: method.toUpperCase(), headers, body: payload });
    return { res, text: await res.text() };
  } finally { await server.close(); }
}

function check(spec, identity, opInfo, c) {
  return async () => {
    const { res, text } = await exercise({ identity, path: opInfo.path, method: opInfo.method }, c);
    const documented = Object.keys(opInfo.op.responses);
    const status = String(res.status);
    assert.ok(documented.includes(status), `durum ${status} belgelenmemiş (${documented.join(',')}): ${text.slice(0, 300)}`);
    const expected = EXPECTED[c.label] ?? Number(documented.filter(s => s.startsWith('2')).sort()[0]);
    assert.equal(res.status, expected, `beklenen ${expected}, gelen ${res.status}: ${text.slice(0, 300)}`);
    const rs = responseSchema(spec, opInfo.op, status);
    if (!rs) { assert.equal(text, '', 'gövdesiz yanıt boş olmalı'); return; }
    assert.ok(res.headers.get('content-type')?.startsWith(rs.ct), `content-type ${res.headers.get('content-type')} != ${rs.ct}`);
    assert.deepEqual(validateAgainst(spec, rs.schema, JSON.parse(text)), [], `şemaya uymayan gövde: ${text.slice(0, 500)}`);
  };
}

for (const [spec, identity] of [[smsSpec, false], [identitySpec, true]]) {
  for (const opInfo of operations(spec)) {
    const shown = identity ? opInfo.path : `/sms/v3${opInfo.path}`;
    for (const c of cases(spec, opInfo, shown)) {
      test(c.label, TODO[c.label] ? { todo: TODO[c.label] } : {}, check(spec, identity, opInfo, c));
    }
  }
}

// Spec'in refresh_token örneği (hiç verilmemiş bir UUID) belgelenmiş 401'i göstermelidir.
{
  const opInfo = { method: 'post', path: '/auth/v3/token/refresh', op: identitySpec.paths['/auth/v3/token/refresh'].post };
  const media = opInfo.op.requestBody.content['application/json'];
  const c = { label: 'POST /auth/v3/token/refresh [spec example uuid]', ct: 'application/json',
    body: bodyFromSchemaExamples(identitySpec, media.schema), query: {} };
  test(c.label, check(identitySpec, true, opInfo, c));
}
