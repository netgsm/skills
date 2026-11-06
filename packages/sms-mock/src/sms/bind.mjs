// Gövdenin türlere bağlanması (binding). Değerler gerçek API'deki gibi gevşek bağlanır: metin alanına
// sayı ya da true/false, tam sayı alanına sayısal metin ya da kesirli sayı, listeye (enum) sıra numarası,
// tarihe epoch saniyesi verilebilir; değer dönüştürülür ve normal doğrulama dönüştürülmüş değerle sürer.
// Yalnızca yapısal uyumsuzluk reddedilir (metin alanında nesne ya da dizi, dizi beklenen yerde tek değer,
// listede olmayan ad gibi): istek alan doğrulamasına geçmeden 400 `1 field(s) rejected` ile reddedilir
// ve `violations` tek ihlal taşır; okuma ilk hatalı alanda durur (gövdedeki sırayla). Reddedilen değer
// yanıtta yer almaz. Yalnızca JSON sözdizimi hatası `request body could not be read as json` döner
// (bkz. server.mjs).
import { fieldsRejected } from './api-error.mjs';
import { smsSpec } from '../generated/specs.mjs';

export const DATE_TIME_MESSAGE = 'must be an ISO-8601 date-time with an offset, e.g. 2026-09-10T09:00:00+03:00';
export const enumMessage = (values) => `must be one of ${values.join(', ')} (case sensitive)`;
const MESSAGES = {
  array: 'must be an array',
  number: 'must be a number',
  boolean: 'must be true or false',
  string: 'must be a string',
  other: 'has an invalid value',
};

// Saat dilimi farkı zorunlu, saniye isteğe bağlı (`2026-09-10T09:00+03:00` de okunur).
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;
export const isOffsetDateTime = (v) => typeof v === 'string' && OFFSET_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v));
const NUMERIC = /^\s*[+-]?\d+(\.\d+)?\s*$/;

function resolve(node) {
  while (node && node.$ref) node = node.$ref.replace(/^#\//, '').split('/').reduce((n, p) => n?.[p], smsSpec);
  return node ?? {};
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Bağlanan değer buraya yazılır (her kayıt için dizi/nesne ayırmamak için).
let bound;

/**
 * Bir değeri şemaya bağlar. Sorun yoksa null döner ve dönüştürülmüş değer `bound`'a yazılır;
 * varsa `{ field, message }` döner. Diziler ve nesneler yerinde güncellenir.
 * `opts.enums`: alan yolu → kabul edilen değerler (spec'teki listeden farklıysa).
 * `opts.loose`: listesi gevşek eşlenen alanlar (`iysFilter`); yalnızca metin olarak bağlanır.
 */
function bindValue(schemaRef, value, path, opts) {
  bound = value;
  if (value === null) return null; // null her türe bağlanır: alan verilmemiş sayılır
  const schema = resolve(schemaRef);
  const fail = (message) => ({ field: path, message });
  const values = opts.enums?.[path] ?? (opts.loose?.includes(path) ? undefined : schema.enum);
  if (Array.isArray(values)) {
    // Ad birebir (büyük/küçük harf dahil) ya da sıra numarası (0, 1, 2 ...).
    if (typeof value === 'string' && values.includes(value)) return null;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < values.length) {
      bound = values[value];
      return null;
    }
    return fail(enumMessage(values));
  }
  if (schema.format === 'date-time') {
    if (isOffsetDateTime(value)) return null;
    // Sayı epoch saniyesi olarak okunur.
    if (typeof value === 'number' && Number.isFinite(value)) {
      const d = new Date(value * 1000);
      if (!Number.isNaN(d.getTime())) { bound = d.toISOString(); return null; }
    }
    return fail(DATE_TIME_MESSAGE);
  }
  switch (schema.type) {
    case 'string':
      if (typeof value === 'string') return null;
      if (typeof value === 'number' || typeof value === 'boolean') { bound = String(value); return null; }
      return fail(MESSAGES.string);
    case 'boolean':
      if (typeof value === 'boolean') return null;
      if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) { bound = value.trim().toLowerCase() === 'true'; return null; }
      return fail(MESSAGES.boolean);
    case 'integer':
    case 'number': {
      let n;
      if (typeof value === 'number') n = value;
      else if (typeof value === 'string' && NUMERIC.test(value)) n = Number(value);
      else return fail(MESSAGES.number);
      if (!Number.isFinite(n)) return fail(MESSAGES.number);
      bound = schema.type === 'integer' ? Math.trunc(n) : n;
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return fail(MESSAGES.array); // tek değer diziye sarılmaz
      for (let i = 0; i < value.length; i++) {
        const bad = bindValue(schema.items, value[i], `${path}[${i}]`, opts);
        if (bad) return bad;
        if (bound !== value[i]) value[i] = bound;
      }
      bound = value;
      return null;
    }
    case 'object': {
      if (!isPlainObject(value)) return fail(MESSAGES.other);
      const bad = bindObject(schema, value, path, opts);
      bound = value;
      return bad;
    }
    default: return null;
  }
}

function bindObject(schema, value, prefix, opts) {
  const props = schema.properties ?? {};
  const extra = schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null;
  for (const key of Object.keys(value)) {
    const sub = Object.hasOwn(props, key) ? props[key] : extra;
    if (!sub) continue; // bilinmeyen alan yok sayılır
    const bad = bindValue(sub, value[key], prefix ? `${prefix}.${key}` : key, opts);
    if (bad) return bad;
    if (bound !== value[key]) value[key] = bound;
  }
  return null;
}

/**
 * Gövdeyi spec'teki istek şemasına (`schemaName`) bağlar ve dönüştürülen değerleri gövdeye **yerinde**
 * yazar. İlk yapısal uyumsuzluk için 400 `1 field(s) rejected` yanıtı, sorun yoksa null döner.
 * Gövdenin kendisi nesnedir (server.mjs denetler).
 * @param {string} schemaName
 * @param {object} body
 * @param {{ enums?: Record<string, string[]>, loose?: string[] }} [opts]
 */
export function bindBody(schemaName, body, opts = {}) {
  const schema = smsSpec.components.schemas[schemaName];
  if (!schema) throw new Error(`unknown schema: ${schemaName}`);
  const bad = bindObject(schema, body ?? {}, '', opts);
  bound = undefined;
  return bad ? fieldsRejected([bad]) : null;
}
