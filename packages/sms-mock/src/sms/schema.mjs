import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/** `null` değerli nesne alanlarını (özyinelemeli) siler; dizi elemanlarındaki `null` kalır. */
export function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
    return out;
  }
  return value;
}

/** Yolu (`a.items.b`) izleyip o alt şemayı `{}` ile değiştirir. Çözümlenemeyen yol yok sayılır. */
function blank(schema, path) {
  const parts = path.split('.');
  let node = schema;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const last = i === parts.length - 1;
    let holder, key;
    if (p === 'items') { holder = node; key = 'items'; }
    else { holder = node?.properties; key = p; }
    if (!holder || typeof holder !== 'object' || !(key in holder)) return;
    if (last) { holder[key] = {}; return; }
    node = holder[key];
  }
}

const toField = (err) => {
  let path = err.instancePath.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')).join('.');
  if (err.keyword === 'required') path = path ? `${path}.${err.params.missingProperty}` : err.params.missingProperty;
  return path;
};

/** OpenAPI 3.0 `nullable: true` + `enum`: Ajv enum'u null'a izin vermez; null açıkça eklenir. */
function allowNullEnums(node) {
  if (Array.isArray(node)) { node.forEach(allowNullEnums); return; }
  if (node && typeof node === 'object') {
    if (node.nullable === true && Array.isArray(node.enum) && !node.enum.includes(null)) node.enum.push(null);
    // allOf + nullable (3.0'da "şema ya da null"): Ajv tür olmadan nullable kabul etmez
    if (node.nullable === true && node.type === undefined && Array.isArray(node.allOf)) {
      node.anyOf = [{ allOf: node.allOf }, { type: 'null' }];
      delete node.allOf;
      delete node.nullable;
    }
    Object.values(node).forEach(allowNullEnums);
  }
}

export function createSchemaValidator(inputSpec) {
  // Girdi spec'e dokunulmaz; normalleştirme kopya üzerinde yapılır.
  const spec = { ...inputSpec, components: structuredClone(inputSpec.components) };
  allowNullEnums(spec.components);
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'sms', components: spec.components });
  const cache = new Map();

  function compile(name, skip) {
    const key = `${name}|${[...skip].sort().join(',')}`;
    let fn = cache.get(key);
    if (!fn) {
      if (skip.length === 0) {
        fn = ajv.compile({ $ref: `sms#/components/schemas/${name}` });
      } else {
        const base = spec.components?.schemas?.[name];
        if (!base) throw new Error(`unknown schema: ${name}`);
        const clone = structuredClone(base);
        for (const p of skip) blank(clone, p);
        fn = ajv.compile({ components: spec.components, ...clone });
      }
      cache.set(key, fn);
    }
    return fn;
  }

  return {
    /** `opts.keywords` true ise her ihlal Ajv anahtar sözcüğünü de (`keyword`) taşır; yanıta konmadan önce atılmalıdır. */
    validate(name, value, opts = {}) {
      const fn = compile(name, opts.skipProperties ?? []);
      if (fn(value)) return [];
      return (fn.errors ?? []).map(e => (opts.keywords
        ? { field: toField(e), message: e.message ?? 'invalid', keyword: e.keyword }
        : { field: toField(e), message: e.message ?? 'invalid' }));
    },
  };
}
