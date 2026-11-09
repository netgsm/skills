import http from 'node:http';
import { createHash } from 'node:crypto';
import { createAdvisor } from './advisor.mjs';
import { explain } from './explain.mjs';
import { createClock } from './clock.mjs';
import { smsRequestId, identityRequestId } from './ids.mjs';
import { smsError, UNREADABLE_BODY } from './sms/api-error.mjs';
import { problem } from './identity/problem.mjs';
import { registerIdentityRoutes } from './identity/routes.mjs';
import { registerLengthRoutes } from './sms/length.mjs';
import { registerSendRoutes } from './sms/send.mjs';
import { registerSendFamilyRoutes } from './sms/send-family.mjs';
import { registerJobsRoutes } from './sms/jobs-routes.mjs';
import { registerAccountRoutes, createInboxStore } from './sms/account-routes.mjs';
import { registerWebhookRoutes } from './sms/webhook-routes.mjs';
import { registerBalanceRoutes } from './sms/balance-routes.mjs';
import { createWebhookDispatcher } from './webhooks.mjs';
import { createScenarioQueue, scenarioResponse, validateScenario, JOB_CREATING_PATHS, SEND_OTP } from './scenarios.mjs';
import { authenticate } from './sms/auth.mjs';
import { createJobStore } from './jobs.mjs';
import { createSessionStore } from './identity/sessions.mjs';
import { createAccountStore, SEED_ACCOUNTS } from './accounts.mjs';
import {
  createRoutes, envelopeFor, acceptsJson, istanbulTimestamp, readBody, BodyTooLarge, stripBom,
  SMS_BODY_LIMIT, AUTH_BODY_LIMIT,
} from './http.mjs';

const SMS_ERRORS = {
  not_found: [404, 'NOT_FOUND'],
  method_not_allowed: [405, 'INVALID_REQUEST'],
  payload_too_large: [413, 'INVALID_REQUEST'],
  invalid_request: [400, 'INVALID_REQUEST'],
  unsupported: [415, 'INVALID_REQUEST'],
  internal: [500, 'INTERNAL_ERROR'],
};
const PLAIN_STATUS = { not_found: 404, method_not_allowed: 405, payload_too_large: 413, invalid_request: 400, unsupported: 415, internal: 500 };

/** 127.0.0.0/8, ::1 ve localhost yerel (loopback) adreslerdir. */
export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::ffff:127.0.0.1';
}

/** URL'de kullanılacak host: IPv6 köşeli parantez içine alınır. */
const urlHost = (host) => (String(host).includes(':') && !String(host).startsWith('[') ? `[${host}]` : String(host));

/** Yola göre uygun zarfla çerçeve hatası üretir. */
function frameworkError(env, kind, message) {
  if (env === 'sms') {
    const [status, code] = SMS_ERRORS[kind];
    return smsError(status, code, message);
  }
  if (env === 'auth') {
    return problem(kind === 'unsupported' ? 'invalid_request' : kind === 'internal' ? 'internal_error' : kind);
  }
  return { status: PLAIN_STATUS[kind], body: { error: message } };
}

/**
 * @param {{ port?: number, host?: string, clock?: import('./clock.mjs').Clock, tokenTtlSec?: number,
 *           rateScale?: number, log?: (line: string) => void, fetchImpl?: typeof fetch,
 *           quiet?: boolean, bodyLimits?: { sms?: number, auth?: number } }} [options]
 * `quiet`: true iken konsola yalnızca hatalar (✘) ve bulgular (⚠) yazılır.
 * `bodyLimits`: istek gövdesi sınırları (bayt).
 */
export function createMockServer(options = {}) {
  const {
    port = 4010, host = '127.0.0.1', clock = createClock(), tokenTtlSec = 86400, rateScale = 1,
    bodyLimits = {}, quiet = false,
    log = line => console.log(line), fetchImpl = globalThis.fetch,
  } = options;

  // Sonraki task'lar durumlarını (accounts, sessions, jobs, ...) bu nesneye asar.
  const ctx = {
    routes: createRoutes(),
    clock,
    // Gerçek API loopback webhook adresini reddeder; mock yalnızca yerelde dinlerken buna izin verir.
    opts: { tokenTtlSec, rateScale, fetchImpl, allowLoopbackWebhooks: isLoopbackHost(host) },
    log,
    // reset() çağrılan sayaçlar ve işaretleyiciler (sınırlayıcılar, başarısız giriş sayaçları, ...).
    // Route modülleri kendi durumlarını kayıt sırasında buraya ekler.
    resettables: [],
  };

  // Durum depoları. POST /__mock/reset bunları yeniden kurar; handler'lar ctx.<depo> üzerinden okur.
  function initState() {
    ctx.accounts = createAccountStore(SEED_ACCOUNTS);
    ctx.sessions = createSessionStore({ clock, tokenTtlSec });
    ctx.jobs = createJobStore({ clock });
    ctx.inbox = createInboxStore({ clock });
    ctx.webhooks = createWebhookDispatcher({ fetchImpl, clock, log, jobs: ctx.jobs, accounts: ctx.accounts });
    ctx.inbox.onAdd((accountId, message) => { ctx.webhooks.onInbound(accountId, message); });
    ctx.scenarios = createScenarioQueue();
    ctx.advisor = createAdvisor({ clock });
  }
  initState();

  function resetAll() {
    initState();
    for (const r of ctx.resettables) r.reset();
    clock.reset?.();
  }

  // --- ROUTE KAYDI: yeni route modülleri buraya eklenir -------------------
  registerIdentityRoutes(ctx);
  registerLengthRoutes(ctx);
  registerSendRoutes(ctx);
  registerSendFamilyRoutes(ctx);
  registerJobsRoutes(ctx);
  registerAccountRoutes(ctx);
  registerWebhookRoutes(ctx);
  registerBalanceRoutes(ctx);
  registerControlRoutes();
  // ör. registerSmsRoutes(ctx);
  // ------------------------------------------------------------------------

  // Kontrol uçları: kimlik doğrulaması yok, düz JSON zarfı.
  function registerControlRoutes() {
    const bad = (message) => ({ status: 400, body: { error: message } });
    ctx.routes.add('POST', '/__mock/scenario', (req) => {
      const invalid = validateScenario(req.json);
      if (invalid) return bad(invalid);
      ctx.scenarios.push(req.json);
      return { status: 201, body: ctx.scenarios.list().at(-1) };
    });
    ctx.routes.add('GET', '/__mock/scenario', () => ({ status: 200, body: { scenarios: ctx.scenarios.list() } }));
    ctx.routes.add('DELETE', '/__mock/scenario', () => { ctx.scenarios.clear(); return { status: 204 }; });
    ctx.routes.add('GET', '/__mock/advice', () => ({ status: 200, body: { findings: ctx.advisor.findings() } }));
    ctx.routes.add('POST', '/__mock/reset', () => { resetAll(); return { status: 200, body: { reset: true } }; });
    ctx.routes.add('POST', '/__mock/clock', (req) => {
      const s = req.json?.advanceSeconds;
      if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return bad('advanceSeconds must be a positive number');
      clock.advance(s * 1000);
      return { status: 200, body: { now: new Date(clock.now()).toISOString() } };
    });
  }

  /** Sıradaki senaryo bu isteğe uyuyorsa yanıtını döner; QUEUE_UNCONFIRMED görev oluşturan gönderimde işaret bırakır. */
  function applyScenario(env, parsed) {
    if (env === 'sms') {
      const auth = authenticate(parsed, ctx);
      if ('status' in auth) return null; // kötü token: işleyici kendi 401'ini üretir, senaryo tüketilmez
    } else if (env !== 'auth') return null;
    const next = ctx.scenarios.peek(parsed.path);
    if (!next) return null;
    if (next.code === 'QUEUE_UNCONFIRMED' && JOB_CREATING_PATHS.has(parsed.path)) {
      // Gönderim işleyicisi görevi oluşturup 504 (/directory/send) ya da 503 (/send, /send/template)
      // döner ve senaryoyu o an tüketir; işleyici önce 4xx dönerse senaryo kuyrukta kalır.
      parsed.queueUnconfirmed = true;
      return null;
    }
    const scenario = ctx.scenarios.take(parsed.path);
    return scenarioResponse(scenario, parsed.path, ctx);
  }

  const PREFIX = '[netgsm-sms-mock]';

  /** Yanıttan sonra tavsiyeciyi besler ve konsol satırı yazar. Hiçbir zaman istisna fırlatmaz. */
  function observeExchange(meta, status, out) {
    try {
      const { method, path, requestId, parsed } = meta;
      if (path.startsWith('/__mock/') || path.startsWith('/health')) return;
      const body = out?.body && typeof out.body === 'object' ? out.body : null;
      const code = body && typeof body.code === 'string' ? body.code : null;
      const json = parsed?.json && typeof parsed.json === 'object' ? parsed.json : null;
      const arr = json ? (Array.isArray(json.messages) ? json.messages : Array.isArray(json.templates) ? json.templates : null) : null;
      const messageCount = arr ? arr.length : (path === SEND_OTP && json ? 1 : null);
      const username = path === '/auth/v3/token' && typeof json?.username === 'string' ? json.username : null;
      const raw = parsed?.rawBody;
      const retryHeader = Object.entries(out?.headers || {}).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
      const retryAfterSec = retryHeader !== undefined && Number.isFinite(Number(retryHeader)) ? Number(retryHeader) : null;
      const hasRetryAfter = retryHeader !== undefined;
      const findings = ctx.advisor.observe({
        method, path, status, code, accountId: parsed?.accountId ?? null, username, ip: parsed?.ip ?? '',
        bodyHash: raw && raw.length > 0 ? createHash('sha256').update(raw).digest('hex') : null,
        messageCount, tokenState: parsed?.tokenState ?? 'none', requestId, at: clock.now(), retryAfterSec,
        query: parsed?.query ? parsed.query.toString() : null,
        perJob: status === 429 && typeof body?.message === 'string' && body.message.includes('queried too recently'),
        mayHaveBeenQueued: parsed?.mayHaveBeenQueued === true,
      });
      if (status >= 400) {
        const errCode = code ?? (status === 404 ? 'not_found' : status === 406 ? 'not_acceptable' : String(status));
        log(`${PREFIX} ✘ ${status} ${method} ${path} ${errCode} — ${explain(errCode, { path, hasRetryAfter })} (requestId ${requestId})`);
      } else if (!quiet) {
        const counts = status === 202 && body && typeof body.accepted === 'number'
          ? ` — ${body.accepted} kabul, ${body.rejected ?? 0} red` : '';
        log(`${PREFIX} ✔ ${status} ${method} ${path}${counts} (requestId ${requestId})`);
      }
      for (const f of findings) log(`${PREFIX} ⚠ ${f.message}`);
    } catch (err) {
      try { log(`${PREFIX} advisor error: ${err?.message ?? err}`); } catch { /* günlük hatası yutulur */ }
    }
  }

  function write(res, env, path, requestId, out) {
    const headers = { ...(out.headers || {}) };
    let payload;
    if (out.body !== undefined) {
      let body = out.body;
      if (env === 'sms' && body && typeof body === 'object' && 'requestId' in body) {
        body = { ...body, requestId: body.requestId ?? requestId, timestamp: body.timestamp ?? istanbulTimestamp(clock.now()) };
      } else if (env === 'auth' && body && typeof body === 'object' && 'request_id' in body) {
        body = { ...body, request_id: body.request_id ?? requestId, instance: body.instance ?? path };
      }
      payload = JSON.stringify(body);
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    if (env !== 'plain') headers['X-Request-Id'] = requestId;
    if (env === 'auth') { headers['Cache-Control'] = 'no-store'; headers.Pragma = 'no-cache'; }
    res.writeHead(out.status, headers);
    res.end(payload);
  }

  async function handle(req, res) {
    const method = String(req.method).toUpperCase();
    let url;
    try {
      // '//' ile başlayan hedefler URL ayrıştırıcıda host sayılır; reddet.
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error('bad target');
      url = new URL(req.url, 'http://mock.local');
    } catch {
      req.resume();
      return write(res, 'plain', '/', '', frameworkError('plain', 'invalid_request', 'malformed request target'));
    }
    const path = url.pathname;
    const env = envelopeFor(path);
    const requestId = env === 'auth' ? identityRequestId() : smsRequestId();
    const meta = { method, path, requestId, parsed: null };
    const send = out => { write(res, env, path, requestId, out); observeExchange(meta, out.status, out); };
    try {
      const { handler, options, allow } = ctx.routes.match(method, path);
      if (!handler && allow.length === 0) return send(frameworkError(env, 'not_found', env === 'sms' ? 'no such endpoint' : 'not found'));
      if (!handler) {
        const out = frameworkError(env, 'method_not_allowed', 'method not allowed');
        return send({ ...out, headers: { ...out.headers, Allow: allow.join(', ') } });
      }
      if (!acceptsJson(req.headers.accept)) {
        res.writeHead(406, env !== 'plain' ? { 'X-Request-Id': requestId } : {});
        res.end();
        return observeExchange(meta, 406, { status: 406 });
      }

      const parsed = {
        method, path, query: url.searchParams, headers: req.headers,
        ip: req.socket.remoteAddress || '', rawBody: Buffer.alloc(0), json: undefined, requestId,
      };

      meta.parsed = parsed;

      if (['POST', 'PUT', 'PATCH'].includes(method) && options.body !== false) {
        // SMS API'de her uç Bearer ister (spec: global security) ve gerçek API önce kimliği doğrular:
        // token yoksa ya da geçersizse gövde okunmadan, ayrıştırılmadan ve doğrulanmadan 401 döner
        // (bozuk JSON, içerik türü, sıkıştırma ve boyut hataları dahil). Gövdesiz metotlarda işleyici
        // zaten ilk iş olarak kimliği doğrular. `authFirst: false` olan uç (/send/otp) kendi sırasını uygular.
        if (env === 'sms' && options.authFirst !== false) {
          const auth = authenticate(parsed, ctx);
          if ('status' in auth) { req.resume(); return send(auth); }
        }
        const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
        if (encoding && encoding !== 'identity') {
          return send(frameworkError(env, 'unsupported', 'compressed request bodies are not supported'));
        }
        let raw;
        try {
          raw = await readBody(req, env === 'auth' ? (bodyLimits.auth ?? AUTH_BODY_LIMIT) : (bodyLimits.sms ?? SMS_BODY_LIMIT));
        } catch (e) {
          if (!(e instanceof BodyTooLarge)) throw e;
          req.resume(); // kalan gövdeyi atarak oku; bağlantıyı kesme (istemci yanıtı görebilsin)
          return send(frameworkError(env, 'payload_too_large', 'request body too large'));
        }
        parsed.rawBody = raw;
        const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const isJson = ctype === 'application/json' || ctype.endsWith('+json');
        const isForm = env === 'auth' && ctype === 'application/x-www-form-urlencoded';
        // SMS API'de gövde alan her uçta gövde zorunludur (spec: requestBody.required): Content-Type
        // olmasa da boş gövde, boş JSON gövdeyle aynı cümleyle reddedilir.
        if (env === 'sms' && raw.length === 0) return send(frameworkError(env, 'invalid_request', UNREADABLE_BODY));
        // Kontrol uçları (/__mock/*) her zaman JSON ister: tarayıcının ön kontrolsüz (text/plain, form)
        // istekleri mock durumunu değiştiremez. Gövdesiz JSON isteği boş nesne sayılır.
        const control = path.startsWith('/__mock/');
        if ((control && !isJson) || (raw.length > 0 && !isJson && !isForm)) {
          return send(frameworkError(env, 'unsupported', 'content type must be application/json'));
        }
        if (control && raw.length === 0) parsed.json = {};
        if (isForm) {
          parsed.json = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
        } else if (isJson && !(control && raw.length === 0)) {
          // SMS API: boş, bozuk ya da nesne olmayan gövde aynı cümleyle reddedilir.
          const unreadable = env === 'sms' ? UNREADABLE_BODY : null;
          // Baştaki UTF-8 BOM atılır; yalnızca BOM'dan oluşan gövde boş sayılır.
          const text = stripBom(raw.toString('utf8'));
          if (text.length === 0) return send(frameworkError(env, 'invalid_request', unreadable ?? 'request body is empty'));
          try { parsed.json = JSON.parse(text); }
          catch { return send(frameworkError(env, 'invalid_request', unreadable ?? 'malformed JSON')); }
          if (env === 'sms' && (parsed.json === null || typeof parsed.json !== 'object' || Array.isArray(parsed.json))) {
            return send(frameworkError(env, 'invalid_request', unreadable));
          }
        }
      } else {
        req.resume();
      }

      const injected = applyScenario(env, parsed);
      send(injected ?? await handler(parsed, ctx));
    } catch (err) {
      log(`internal error: ${(err && err.stack) || err}`);
      if (res.headersSent) return res.destroy();
      send(frameworkError(env, 'internal', 'internal error'));
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      try { log(`unhandled error: ${(err && err.stack) || err}`); } catch {}
      res.destroy();
    });
  });

  let timer;
  return {
    ctx,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          clearInterval(timer);
          timer = setInterval(() => { ctx.webhooks.tick().catch(err => log(`webhook tick failed: ${err?.message ?? err}`)); }, 1000);
          timer.unref();
          if (!ctx.opts.allowLoopbackWebhooks) {
            log(`${PREFIX} Uyarı: mock ${host} adresinde dinliyor; ağdaki diğer makineler de erişebilir. Kontrol uçlarında (/__mock/*) kimlik doğrulaması yoktur, yalnızca güvendiğiniz bir ağda kullanın. Bu modda loopback webhook adresleri (localhost, 127.0.0.1, ::1) gerçek API'deki gibi reddedilir.`);
          }
          resolve(`http://${urlHost(host)}:${server.address().port}`);
        });
      });
    },
    close() {
      clearInterval(timer);
      return new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
