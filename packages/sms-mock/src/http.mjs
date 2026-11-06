/** @typedef {{ status: number, headers?: Record<string,string>, body?: unknown }} MockResponse */

export const SMS_BODY_LIMIT = 500 * 1024 * 1024;
export const AUTH_BODY_LIMIT = 1024 * 1024;

/** Yol + metot tablosu. Yollar tam eşleşir (parametre yok). */
export function createRoutes() {
  const table = new Map(); // path -> Map(method -> handler)
  return {
    add(method, path, handler) {
      if (!table.has(path)) table.set(path, new Map());
      table.get(path).set(method.toUpperCase(), handler);
    },
    /** @returns {{ handler?: Function, allow: string[] }} */
    match(method, path) {
      const byMethod = table.get(path);
      if (!byMethod) return { allow: [] };
      return { handler: byMethod.get(method), allow: [...byMethod.keys()] };
    },
  };
}

/** Hangi hata zarfı kullanılacak: 'sms', 'auth' ya da 'plain'. */
export function envelopeFor(path) {
  if (path === '/sms/v3' || path.startsWith('/sms/v3/')) return 'sms';
  if (path === '/auth/v3' || path.startsWith('/auth/v3/')) return 'auth';
  return 'plain';
}

/** Accept başlığı yoksa ya da JSON kabul ediliyorsa true. */
export function acceptsJson(accept) {
  if (!accept) return true;
  return accept.split(',').some(part => {
    const type = part.split(';')[0].trim().toLowerCase();
    const q = /;\s*q=([\d.]+)/i.exec(part);
    if (q && Number(q[1]) === 0) return false;
    return type === '*/*' || type === 'application/*' || type === 'application/json' || type === 'application/problem+json';
  });
}

/** "+03:00" offsetli ISO-8601 (Europe/Istanbul'da DST yoktur). */
export function istanbulTimestamp(ms) {
  return new Date(ms + 3 * 3600_000).toISOString().replace('Z', '+03:00');
}

export class BodyTooLarge extends Error {}

/** Gövdeyi akışla okur; sınır aşılırsa BodyTooLarge ile reddeder. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return reject(new BodyTooLarge());
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; chunks.length = 0; return reject(new BodyTooLarge()); }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
