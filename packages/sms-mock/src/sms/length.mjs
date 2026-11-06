import { smsError, fieldsRejected } from './api-error.mjs';
import { bindBody } from './bind.mjs';
import { authenticate } from './auth.mjs';
import { createSchemaValidator, stripNulls } from './schema.mjs';
import { smsSpec } from '../generated/specs.mjs';

// Tek parça kapasitesi, birleştirilmiş parça başına kapasite ve toplam sınır (6 parça).
const PROFILES = {
  DEFAULT: { single: 160, perPart: 153, limit: 917 },
  TURKISH: { single: 155, perPart: 148, limit: 888 },
  UNICODE: { single: 70, perPart: 66, limit: 396 },
};
const MAX_PARTS = 6;
const ALPHANUMERIC_SENDER_COST = 5;
// TURKISH altında kaçış gerektiren harfler: her biri iki karakter sayılır (ö ve ü hariç).
const TURKISH_ESCAPED = new Set([...'çğışĞİŞ']);

/** Metnin ağırlıklı uzunluğu. UTF-16 kod birimi sayılır (JS `length`, send ile aynı). */
function weightedLength(text, encoding) {
  if (encoding !== 'TURKISH') return text.length;
  let escaped = 0;
  for (let i = 0; i < text.length; i++) if (TURKISH_ESCAPED.has(text[i])) escaped++;
  return text.length + escaped;
}

/**
 * Metni send'in saydığı şekilde ölçer. Alfanümerik gönderici `length`'e +5 ekler; `limit` değişmez.
 * @param {string} text
 * @param {'DEFAULT'|'TURKISH'|'UNICODE'} [encoding]
 * @param {boolean} [alphanumericSender]
 */
export function measure(text, encoding = 'DEFAULT', alphanumericSender = false) {
  const { single, perPart, limit } = PROFILES[encoding];
  const length = weightedLength(text, encoding) + (alphanumericSender ? ALPHANUMERIC_SENDER_COST : 0);
  const parts = length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / perPart);
  const fits = length <= limit && parts <= MAX_PARTS;
  const remaining = limit - length;
  const remainingUntilNextPart = !fits ? 0 : (parts <= 1 ? single : parts * perPart) - length;
  return { encoding, length, parts, limit, fits, remaining, remainingUntilNextPart };
}

/** send'in metni kabul edip etmeyeceği. */
export function fitsSend(text, encoding = 'DEFAULT', alphanumericSender = false) {
  return measure(text, encoding, alphanumericSender).fits;
}

const validator = createSchemaValidator(smsSpec);

/** `POST /sms/v3/length`: yalnızca kimlik doğrulama gerekir. */
export function registerLengthRoutes(ctx) {
  ctx.routes.add('POST', '/sms/v3/length', (req) => {
    const auth = authenticate(req, ctx);
    if ('status' in auth) return auth;
    const unbound = bindBody('LengthRequest', req.json ?? {});
    if (unbound) return unbound;
    const body = stripNulls(req.json ?? {});
    const violations = validator.validate('LengthRequest', body);
    if (violations.length > 0) {
      return fieldsRejected(violations);
    }
    return { status: 200, body: measure(body.text, body.encoding ?? 'DEFAULT', body.alphanumericSender ?? false) };
  });
}
