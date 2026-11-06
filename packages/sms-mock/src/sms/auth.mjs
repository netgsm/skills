import { smsError } from './api-error.mjs';

const MSG = {
  activation: 'account is not activated for this operation',
  subUser: 'sub user may not use the sms api',
  operator: 'account operator is not served for this operation',
};

/**
 * Bearer token'ı çözer. Başarıda `{ login, account }`, aksi halde 401 yanıtı döner.
 * @returns {{ login: object, account: object } | import('../http.mjs').MockResponse}
 */
export function authenticate(req, ctx) {
  const raw = req.headers?.authorization;
  const m = typeof raw === 'string' ? /^bearer[ \t]+(\S+)[ \t]*$/i.exec(raw.trim()) : null;
  if (!m) { req.tokenState = 'none'; return smsError(401, 'UNAUTHENTICATED', 'no bearer token'); }
  const r = ctx.sessions.resolve(m[1]);
  // Tavsiyeci (advisor) için token durumu isteğe yazılır: ok | expired | revoked | superseded | invalid | none
  if (r.error) { req.tokenState = r.error; return smsError(401, 'UNAUTHENTICATED', 'invalid or expired token'); }
  const account = ctx.accounts.get(r.login.accountId);
  if (!account) { req.tokenState = 'invalid'; return smsError(401, 'UNAUTHENTICATED', 'invalid or expired token'); }
  req.tokenState = 'ok';
  req.accountId = account.id;
  return { login: r.login, account };
}

/**
 * @param {'SEND'|'RECEIVE'|'REPORT'|'USER'} operation
 * @returns {import('../http.mjs').MockResponse | null}
 */
export function authorize(account, login, operation) {
  if ((operation === 'SEND' && !account.activations.send) || (operation === 'RECEIVE' && !account.activations.receive)) {
    return smsError(403, 'FORBIDDEN', MSG.activation);
  }
  if (!login.smsPermission) return smsError(403, 'FORBIDDEN', MSG.subUser);
  if (operation === 'SEND' && !account.operatorOk) return smsError(403, 'FORBIDDEN', MSG.operator);
  return null;
}
