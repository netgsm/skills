import { smsError } from './sms/api-error.mjs';
import { problem } from './identity/problem.mjs';

const SMS_PREFIX = '/sms/v3';
const AUTH_PREFIX = '/auth/v3';
const DEFAULT_RETRY_AFTER = 30;

export const SEND = '/sms/v3/send';
export const SEND_TEMPLATE = '/sms/v3/send/template';
export const SEND_OTP = '/sms/v3/send/otp';
export const DIRECTORY_SEND = '/sms/v3/directory/send';
export const BALANCE = '/sms/v3/balance';
// Gönderim uçları.
export const SEND_PATHS = new Set([SEND, DIRECTORY_SEND, SEND_TEMPLATE, SEND_OTP]);
// QUEUE_UNCONFIRMED'da görevi önce oluşturan uçlar. /directory/send görevi oluşturup 504 döner;
// /send ve /send/template 504 döndürmez: görevi oluşturup 503 döner (kuyruğa alınmış olabilir).
// /send/otp'ta 504 yoktur: senaryo 503 döner ve hiçbir şey gönderilmez.
export const JOB_CREATING_PATHS = new Set([SEND, SEND_TEMPLATE, DIRECTORY_SEND]);

const SMS_CODES = {
  SERVICE_UNAVAILABLE: () => smsError(503, 'SERVICE_UNAVAILABLE', 'service is temporarily unavailable'),
  QUEUE_UNCONFIRMED: () => smsError(504, 'QUEUE_UNCONFIRMED', 'the request could not be confirmed and may have been queued'),
  E_SIGNATURE_REQUIRED: () => smsError(403, 'E_SIGNATURE_REQUIRED', 'the requested menu requires an e-signature login on the account'),
  INTERNAL_ERROR: () => smsError(500, 'INTERNAL_ERROR', 'internal error'),
  RATE_LIMITED: (s) => smsError(429, 'RATE_LIMITED', 'send rate limit exceeded', {}, { 'Retry-After': String(s.retryAfter ?? DEFAULT_RETRY_AFTER) }),
  SENDING_SUSPENDED: () => smsError(429, 'RATE_LIMITED', 'sending is suspended for this account'),
  INSUFFICIENT_CREDIT: () => smsError(422, 'INSUFFICIENT_CREDIT', 'no credit, package or campaign to pay for the otp'),
  REJECTED_HEADER: () => smsError(422, 'REJECTED_HEADER', 'NOT_REGISTERED'),
  REJECTED_IYS: () => smsError(422, 'REJECTED_IYS', 'account is not in iys mode, filtering cannot be applied'),
  FORBIDDEN: () => smsError(403, 'FORBIDDEN', 'account is not activated for this operation'),
};

const retryProblem = (code) => (s) => {
  const retry = s.retryAfter ?? DEFAULT_RETRY_AFTER;
  return problem(code, { retryAfterSec: retry, extras: { retry_after: retry } });
};

const IDENTITY_CODES = {
  service_unavailable: () => problem('service_unavailable'),
  service_misconfigured: () => problem('service_misconfigured'),
  internal_error: () => problem('internal_error'),
  login_not_permitted: () => problem('login_not_permitted'),
  rate_limited: retryProblem('rate_limited'),
  too_many_failed_attempts: retryProblem('too_many_failed_attempts'),
};

export const SUPPORTED_CODES = [...Object.keys(SMS_CODES), ...Object.keys(IDENTITY_CODES)];

const familyOfCode = (code) => (code in SMS_CODES ? 'sms' : code in IDENTITY_CODES ? 'auth' : null);
const familyOfPath = (path) => {
  if (path === SMS_PREFIX || path.startsWith(`${SMS_PREFIX}/`)) return 'sms';
  if (path === AUTH_PREFIX || path.startsWith(`${AUTH_PREFIX}/`)) return 'auth';
  return null;
};

/** Senaryoyu doğrular. Hata varsa istemciye gösterilecek cümleyi, yoksa null döner. */
export function validateScenario(s) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return 'scenario must be a JSON object';
  const family = typeof s.code === 'string' ? familyOfCode(s.code) : null;
  if (!family) return `unknown scenario code; supported codes: ${SUPPORTED_CODES.join(', ')}`;
  if (s.times !== undefined && !(Number.isInteger(s.times) && s.times >= 1)) return 'times must be a positive integer';
  if (s.retryAfter !== undefined && !(Number.isInteger(s.retryAfter) && s.retryAfter >= 0)) return 'retryAfter must be a non-negative integer';
  if (s.path !== undefined) {
    if (typeof s.path !== 'string') return 'path must be a string';
    const pathFamily = familyOfPath(s.path);
    if (pathFamily === null) return 'path must start with /sms/v3 or /auth/v3';
    if (pathFamily !== family) {
      return family === 'sms'
        ? `code ${s.code} is an sms code and needs a path under /sms/v3, but path is ${s.path}`
        : `code ${s.code} is an identity code and needs a path under /auth/v3, but path is ${s.path}`;
    }
  }
  return null;
}

/** Sıradaki senaryolar. Her `take` bir kullanımı tüketir. */
export function createScenarioQueue() {
  let items = [];
  return {
    push(s) {
      const invalid = validateScenario(s);
      if (invalid) throw new Error(invalid);
      const item = { code: s.code, times: s.times ?? 1 };
      if (s.path !== undefined) item.path = s.path;
      if (s.retryAfter !== undefined) item.retryAfter = s.retryAfter;
      items.push(item);
    },
    take(path) {
      const family = familyOfPath(path);
      const i = items.findIndex(s => (s.path !== undefined ? s.path === path : familyOfCode(s.code) === family));
      if (i < 0) return null;
      const hit = { ...items[i] };
      if (--items[i].times <= 0) items.splice(i, 1);
      return hit;
    },
    /** Tüketmeden bakar. */
    peek(path) {
      const family = familyOfPath(path);
      const s = items.find(x => (x.path !== undefined ? x.path === path : familyOfCode(x.code) === family));
      return s ? { ...s } : null;
    },
    list() { return items.map(s => ({ ...s })); },
    clear() { items = []; },
  };
}

/** Senaryonun yanıtı. QUEUE_UNCONFIRMED /send/otp'ta 503'tür (OTP'de 504 yoktur, hiçbir şey gönderilmez). */
export function scenarioResponse(scenario, path, ctx) {
  void ctx;
  if (scenario.code === 'QUEUE_UNCONFIRMED' && path === SEND_OTP) return SMS_CODES.SERVICE_UNAVAILABLE(scenario);
  if (scenario.code === 'RATE_LIMITED' && path === BALANCE) {
    return smsError(429, 'RATE_LIMITED', 'balance rate limit exceeded', {}, { 'Retry-After': String(scenario.retryAfter ?? DEFAULT_RETRY_AFTER) });
  }
  const make = SMS_CODES[scenario.code] ?? IDENTITY_CODES[scenario.code];
  return make(scenario);
}

/**
 * Gönderim işleyicilerinin görev oluşturduktan sonra çağırdığı kanca. QUEUE_UNCONFIRMED bekliyorsa
 * gerçek 202 yerine /directory/send'de 504, /send ve /send/template'te 503 döner; görev yine de
 * oluşmuştur. `req.mayHaveBeenQueued` tavsiyeci içindir: 503'ün görevi kuyruğa almış olduğunu bildirir.
 */
export function afterJobCreated(req, ctx, response) {
  if (!req.queueUnconfirmed) return response;
  ctx.scenarios.take(req.path); // senaryo yalnızca görev gerçekten oluşunca tüketilir
  req.mayHaveBeenQueued = true;
  if (req.path === DIRECTORY_SEND) return scenarioResponse({ code: 'QUEUE_UNCONFIRMED' }, req.path, ctx);
  return smsError(503, 'SERVICE_UNAVAILABLE', 'the send could not be confirmed; it may or may not have been queued');
}
