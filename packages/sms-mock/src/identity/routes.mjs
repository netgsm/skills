import { problem } from './problem.mjs';
import { createFixedWindowLimiter } from '../ratelimit.mjs';

const WINDOW_MS = 60_000;
const FAILED_LIMIT = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVICES = ['sms', 'voice', 'voice-sms', 'voicemail', 'fax', 'netsantral', 'netasistan', 'digital-services', 'financial'];
const SUB_SCOPES = [
  'sms:send', 'sms:receive', 'sms:send:gsm', 'sms:receive:gsm',
  'voice:outgoing', 'voice:incoming', 'voice:outgoing:gsm', 'voice:incoming:gsm',
  'fax:send', 'fax:receive',
];
const ALLOWED_SCOPES = ['profile', 'contact', 'email', ...SERVICES, ...SUB_SCOPES];

const SERVICE_FIELDS = ['username', 'user_code', 'contract_accepted', 'sub_user_id', 'sub_user'];
const PROFILE_FIELDS = ['username', 'user_code', 'first_name', 'last_name', 'email', 'contract_accepted'];
const ALL_FIELDS = [...PROFILE_FIELDS, 'sub_user_id', 'sub_user'];
const FIELDS_BY_SCOPE = {
  profile: PROFILE_FIELDS,
  contact: ['first_name', 'last_name', 'email'],
  email: ['email'],
  financial: ALL_FIELDS,
};

const serviceOf = scope => scope.split(':')[0];
const actionOf = scope => scope.split(':')[1]; // 'send' | 'receive' | 'outgoing' | ...

function validationFailed(errors) {
  return problem('validation_failed', { extras: { errors } });
}

/** Gövde nesne değilse alan bulunamaz; form ve JSON aynı yoldan geçer. */
function bodyFields(req) {
  const j = req.json;
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}

function credentialsInQuery(req, names) {
  const errors = {};
  for (const n of names) {
    if (req.query.has(n)) errors[n] = [`${n} alanı query string ile gönderilemez; istek gövdesinde gönderin.`];
  }
  return Object.keys(errors).length ? errors : null;
}

/** Boşlukla ayrılmış scope listesini doğrular; alt kapsamı olan hizmet kapsamını eler. */
function parseScope(raw) {
  // Boş, eksik ya da tanınmayan kapsamda errors.scope izin verilen değerleri listeler (auth.md, errors.md).
  const allowed = `İzin verilen değerler: ${ALLOWED_SCOPES.join(', ')}.`;
  if (typeof raw !== 'string' || raw.trim() === '') return { errors: [`Kapsam alanı zorunludur. ${allowed}`] };
  if (raw.length > 255) return { errors: ['Kapsam en fazla 255 karakter olabilir.'] };
  const list = [...new Set(raw.trim().split(/\s+/))];
  const bad = list.filter(s => !ALLOWED_SCOPES.includes(s));
  if (bad.length) return { errors: [`Geçersiz kapsam: ${bad.join(' ')}. ${allowed}`] };
  const scopes = list.filter(s => !(SERVICES.includes(s) && list.some(o => o !== s && o.startsWith(`${s}:`))));
  return { scopes };
}

/** Aktivasyon koşulu olmayan hizmetler (Identity sandbox ile aynı). */
const NO_ACTIVATION = ['financial', 'digital-services', 'voice-sms'];

/** Hizmet kapsamı için hesapta aktivasyon gerekir; SMS gönderim/alım ayrı, diğerleri tek bayrakla modellenir. */
function activationOk(account, scope) {
  const service = serviceOf(scope);
  if (NO_ACTIVATION.includes(service)) return true;
  if (service !== 'sms') return account.activations.other;
  const action = actionOf(scope);
  if (action === 'send') return account.activations.send;
  if (action === 'receive') return account.activations.receive;
  return account.activations.send || account.activations.receive;
}

function meBody(account, login, scopeStr) {
  const scopes = scopeStr.split(' ');
  let fields;
  if (scopes.length >= 5) fields = ALL_FIELDS;
  else {
    const first = scopes[0];
    fields = FIELDS_BY_SCOPE[first] ?? SERVICE_FIELDS;
  }
  const values = {
    username: account.username, user_code: account.subscriberCode, first_name: account.firstName,
    last_name: account.lastName, email: account.email, contract_accepted: true,
    sub_user_id: login.subUserId,
    sub_user: login.subUser,
  };
  const body = { user_id: account.userId };
  for (const f of fields) body[f] = values[f];
  return body;
}

function tokenBody(session, account) {
  return {
    access_token: session.accessToken,
    token_type: 'Bearer',
    expires_in: session.expiresIn,
    refresh_token: session.refreshToken,
    scope: session.scope,
    user_id: account.userId,
    sub_user_id: session.login.subUserId,
  };
}

export function registerIdentityRoutes(ctx) {
  const { clock } = ctx;
  const rateScale = ctx.opts.rateScale;
  const mk = limit => createFixedWindowLimiter({ limit, windowMs: WINDOW_MS, countRejected: false, clock, rateScale, registry: ctx.resettables });
  const tokenIp = mk(30);
  const refreshIp = mk(60);
  const meToken = mk(60);
  const meIp = mk(300);

  const failedLimit = Math.max(1, Math.ceil(FAILED_LIMIT * rateScale));
  const failed = new Map(); // username|ip -> { start, count }
  ctx.resettables.push({ reset: () => failed.clear() });
  const failedWindow = key => {
    const w = failed.get(key);
    if (w && clock.now() >= w.start + WINDOW_MS) { failed.delete(key); return undefined; }
    return w;
  };

  /** Sınırlayıcıları vurur; RateLimit-* başlıklarını ve (varsa) 429'u döner. */
  function limit(limiters) {
    const results = limiters.map(([l, key]) => l.hit(key));
    const rejected = results.find(r => !r.allowed);
    const r = rejected ?? results.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    const headers = {
      'RateLimit-Limit': String(r.limit),
      'RateLimit-Remaining': String(r.remaining),
      'RateLimit-Reset': String(r.resetSec),
      'RateLimit-Policy': `${r.limit};w=${WINDOW_MS / 1000}`,
    };
    const blocked = rejected
      ? problem('rate_limited', { retryAfterSec: rejected.retryAfterSec, extras: { retry_after: rejected.retryAfterSec } })
      : null;
    return { headers, blocked };
  }

  const withHeaders = (out, headers) => ({ ...out, headers: { ...out.headers, ...headers } });

  function bearer(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    return m && m[1].length <= 4096 ? m[1] : null;
  }

  ctx.routes.add('POST', '/auth/v3/token', req => {
    const { headers, blocked } = limit([[tokenIp, req.ip]]);
    if (blocked) return withHeaders(blocked, headers);
    const reply = out => withHeaders(out, headers);

    const queryErrors = credentialsInQuery(req, ['username', 'password']);
    if (queryErrors) return reply(validationFailed(queryErrors));

    const f = bodyFields(req);
    const errors = {};
    if (typeof f.username !== 'string' || f.username === '') errors.username = ['Kullanıcı adı alanı zorunludur.'];
    else if (f.username.length > 255) errors.username = ['Kullanıcı adı en fazla 255 karakter olabilir.'];
    if (typeof f.password !== 'string' || f.password === '') errors.password = ['Şifre alanı zorunludur.'];
    else if (f.password.length > 255) errors.password = ['Şifre en fazla 255 karakter olabilir.'];
    const parsed = parseScope(f.scope);
    if (parsed.errors) errors.scope = parsed.errors;
    if (Object.keys(errors).length) return reply(validationFailed(errors));

    const failKey = `${f.username}|${req.ip}`;
    const w = failedWindow(failKey);
    if (w && w.count >= failedLimit) {
      const retry = Math.max(1, Math.ceil((w.start + WINDOW_MS - clock.now()) / 1000));
      return reply(problem('too_many_failed_attempts', { retryAfterSec: retry, extras: { retry_after: retry } }));
    }

    const login = ctx.accounts.login(f.username, f.password);
    if (!login) {
      const cur = failedWindow(failKey) ?? { start: clock.now(), count: 0 };
      cur.count++;
      failed.set(failKey, cur);
      return reply(problem('invalid_credentials'));
    }
    failed.delete(failKey);

    const account = ctx.accounts.get(login.accountId);
    if (!account.active) return reply(problem('account_inactive'));
    if (!account.apiAccess) return reply(problem('api_access_denied'));
    if (!account.ipAllowed) return reply(problem('ip_not_allowed'));
    if (!account.countryAllowed) return reply(problem('country_not_allowed'));

    const serviceScopes = parsed.scopes.filter(s => SERVICES.includes(serviceOf(s)));
    if (login.subUserId !== 0) {
      // Hizmet menü yetkisi olmayan alt kullanıcı hiçbir hizmet kapsamı alamaz.
      const denied = login.smsPermission ? [] : serviceScopes;
      if (denied.length) return reply(problem('sub_user_not_permitted', { extras: { denied_scopes: denied } }));
    }
    const notActive = serviceScopes.filter(s => !activationOk(account, s));
    if (notActive.length) return reply(problem('service_not_activated', { extras: { denied_scopes: notActive } }));

    const session = ctx.sessions.open(login, parsed.scopes.join(' '));
    return reply({ status: 200, body: tokenBody(session, ctx.accounts.get(session.login.accountId)) });
  });

  ctx.routes.add('POST', '/auth/v3/token/refresh', req => {
    const { headers, blocked } = limit([[refreshIp, req.ip]]);
    if (blocked) return withHeaders(blocked, headers);
    const reply = out => withHeaders(out, headers);

    const queryErrors = credentialsInQuery(req, ['refresh_token']);
    if (queryErrors) return reply(validationFailed(queryErrors));
    const f = bodyFields(req);
    if (typeof f.refresh_token !== 'string' || f.refresh_token === '') {
      return reply(validationFailed({ refresh_token: ['Refresh token alanı zorunludur.'] }));
    }
    if (!UUID_RE.test(f.refresh_token)) return reply(problem('invalid_refresh_token'));
    const session = ctx.sessions.refresh(f.refresh_token.toLowerCase());
    if (!session) return reply(problem('invalid_refresh_token'));
    return reply({ status: 200, body: tokenBody(session, ctx.accounts.get(session.login.accountId)) });
  });

  /** /me ve /token/revoke: token başına ve IP başına sınır, ardından Bearer çözümü. */
  function authed(req, run) {
    const token = bearer(req);
    const { headers, blocked } = limit([[meToken, token ?? `-${req.ip}`], [meIp, req.ip]]);
    if (blocked) return withHeaders(blocked, headers);
    const resolved = token ? ctx.sessions.resolve(token) : { error: 'invalid' };
    if (resolved.error) return withHeaders(problem('invalid_token'), headers);
    return withHeaders(run(token, resolved), headers);
  }

  ctx.routes.add('GET', '/auth/v3/me', req => authed(req, (_token, { session, login }) => ({
    status: 200,
    body: meBody(ctx.accounts.get(login.accountId), login, session.scope),
  })));

  ctx.routes.add('POST', '/auth/v3/token/revoke', req => authed(req, token => {
    ctx.sessions.revoke(token);
    return { status: 204 };
  }));
}
