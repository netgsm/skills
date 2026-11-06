import { randomBytes, randomUUID } from 'node:crypto';

const b64u = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** İmzasız JWT: istemciler `exp` değerini çözebilir. */
function makeAccessToken(login, scope, iatSec, expSec) {
  return `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ sub: login.accountId, scope, iat: iatSec, exp: expSec })}.${randomBytes(16).toString('base64url')}`;
}

/**
 * Oturum deposu. Oturum başına tek geçerli access token vardır; refresh
 * eskisini `superseded` yapar. Bir kimlik giriş yaptığında, aynı hesabın
 * diğer kimliğinin son girişinden önce açılmış kendi oturumları kapanır.
 *
 * @typedef {{ accessToken: string, refreshToken: string, scope: string, expiresIn: number, login: object }} Session
 */
export function createSessionStore({ clock, tokenTtlSec }) {
  const byAccess = new Map();  // access token -> { rec, stale }
  const byRefresh = new Map(); // refresh token -> rec
  const recs = [];
  const lastLoginSeq = new Map(); // `${accountId}|${identity}` -> seq
  let seq = 0;

  function issue(rec) {
    const nowMs = clock.now();
    if (rec.accessToken) byAccess.set(rec.accessToken, { rec, stale: true });
    rec.accessToken = makeAccessToken(rec.login, rec.scope, Math.floor(nowMs / 1000), Math.floor(nowMs / 1000) + tokenTtlSec);
    rec.expiresAt = nowMs + tokenTtlSec * 1000;
    byAccess.set(rec.accessToken, { rec, stale: false });
    return view(rec);
  }
  const view = rec => ({ accessToken: rec.accessToken, refreshToken: rec.refreshToken, scope: rec.scope, expiresIn: tokenTtlSec, login: rec.login });

  return {
    /** @returns {Session} */
    open(login, scope) {
      const mySeq = ++seq;
      let otherLatest = 0;
      for (const [key, v] of lastLoginSeq) {
        const [accountId, identity] = key.split('|');
        if (accountId === login.accountId && identity !== login.identity) otherLatest = Math.max(otherLatest, v);
      }
      for (const r of recs) {
        if (r.login.accountId === login.accountId && r.login.identity === login.identity && r.status === 'active' && r.seq < otherLatest) {
          r.status = 'superseded';
        }
      }
      lastLoginSeq.set(`${login.accountId}|${login.identity}`, mySeq);
      const rec = { login, scope, seq: mySeq, status: 'active', refreshToken: randomUUID(), accessToken: null, expiresAt: 0 };
      recs.push(rec);
      byRefresh.set(rec.refreshToken, rec);
      return issue(rec);
    },
    /** @returns {Session | null} */
    refresh(refreshToken) {
      const rec = byRefresh.get(refreshToken);
      if (!rec || rec.status !== 'active') return null;
      return issue(rec);
    },
    revoke(accessToken) {
      const hit = byAccess.get(accessToken);
      if (!hit || hit.stale || hit.rec.status !== 'active') return false;
      hit.rec.status = 'revoked';
      return true;
    },
    /** @returns {{ session: Session, login: object } | { error: 'invalid' | 'expired' | 'revoked' | 'superseded' }} */
    resolve(accessToken) {
      const hit = byAccess.get(accessToken);
      if (!hit) return { error: 'invalid' };
      const { rec } = hit;
      if (rec.status === 'revoked') return { error: 'revoked' };
      if (rec.status === 'superseded' || hit.stale) return { error: 'superseded' };
      if (clock.now() >= rec.expiresAt) return { error: 'expired' };
      return { session: view(rec), login: rec.login };
    },
  };
}
