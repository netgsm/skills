// [status, oauth error, title (tr), detail (tr), error_description (en)]
const TYPES = {
  validation_failed: [422, 'invalid_request', 'Doğrulama hatası', 'Girilen bilgiler eksik veya hatalı.', 'The given data is missing or invalid.'],
  invalid_request: [400, 'invalid_request', 'Geçersiz istek', 'İstek işlenemedi.', 'The request could not be processed.'],
  invalid_credentials: [401, 'invalid_grant', 'Kimlik doğrulanamadı', 'Kullanıcı adı veya şifre hatalı.', 'Username or password is incorrect.'],
  invalid_refresh_token: [401, 'invalid_grant', 'Geçersiz refresh token', 'Oturum süresi dolmuş veya sonlandırılmış. Lütfen yeniden giriş yapın.', 'The session has expired or been terminated. Please sign in again.'],
  invalid_token: [401, 'invalid_token', 'Geçersiz access token', 'Oturum bulunamadı veya süresi dolmuş.', 'Session not found or expired.'],
  login_not_permitted: [403, 'access_denied', 'Giriş izni yok', 'Bu hesapla giriş yapılamıyor.', 'This account cannot sign in.'],
  api_access_denied: [403, 'access_denied', 'API erişimi kapalı', 'Hesabınızın API erişimi bulunmuyor.', 'This account does not have API access.'],
  ip_not_allowed: [403, 'access_denied', 'IP adresine izin verilmiyor', 'Bu IP adresinden erişim izni bulunmuyor.', 'Access from this IP address is not permitted.'],
  country_not_allowed: [403, 'access_denied', 'Yurt dışı erişim izni yok', 'Hesabınızın yurt dışından erişim izni bulunmuyor.', 'This account is not permitted to sign in from abroad.'],
  account_inactive: [403, 'access_denied', 'Hesap aktif değil', 'Hesabınız aktif değil.', 'This account is not active.'],
  service_not_activated: [403, 'invalid_scope', 'Hizmet aktif değil', 'Hesabınızda istenen hizmet aktif değil.', 'The requested service is not active on this account.'],
  sub_user_not_permitted: [403, 'invalid_scope', 'Alt kullanıcı yetkisi yok', 'Alt kullanıcınızın istenen hizmete yetkisi bulunmuyor.', 'The sub-user is not permitted to use the requested service.'],
  too_many_failed_attempts: [429, 'invalid_grant', 'Çok fazla hatalı deneme', 'Çok fazla hatalı deneme yapıldı. Lütfen daha sonra tekrar deneyin.', 'Too many failed attempts. Please try again later.'],
  rate_limited: [429, 'temporarily_unavailable', 'İstek limiti aşıldı', 'Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.', 'Too many requests. Please try again later.'],
  not_found: [404, 'invalid_request', 'Bulunamadı', 'İstenen adres bulunamadı.', 'The requested resource was not found.'],
  method_not_allowed: [405, 'invalid_request', 'Metot desteklenmiyor', 'Bu HTTP metodu bu adres için desteklenmiyor.', 'This HTTP method is not supported for this resource.'],
  payload_too_large: [413, 'invalid_request', 'İstek çok büyük', 'İstek gövdesi izin verilen boyutu aşıyor.', 'The request body exceeds the allowed size.'],
  internal_error: [500, 'server_error', 'Sunucu hatası', 'Beklenmeyen bir hata oluştu.', 'An unexpected error occurred.'],
  service_misconfigured: [502, 'temporarily_unavailable', 'Servis yapılandırma hatası', 'Kimlik doğrulama servisi şu an isteği işleyemiyor.', 'The authentication service cannot process the request right now.'],
  service_unavailable: [503, 'temporarily_unavailable', 'Servis kullanılamıyor', 'Kimlik doğrulama servisine şu an ulaşılamıyor. Lütfen daha sonra tekrar deneyin.', 'The authentication service is currently unavailable. Please try again later.'],
};

/**
 * Identity RFC 9457 hata yanıtı. `instance` verilmezse ve `request_id`
 * sunucu tarafından yanıt yazılırken doldurulur.
 * @returns {import('../http.mjs').MockResponse}
 */
export function problem(code, opts = {}) {
  const t = TYPES[code];
  if (!t) throw new Error(`unknown problem code: ${code}`);
  const [status, error, title, detail, description] = t;
  const headers = { 'Content-Type': 'application/problem+json' };
  if (status === 401) headers['WWW-Authenticate'] = error === 'invalid_token' ? 'Bearer error="invalid_token"' : 'Bearer';
  if (opts.retryAfterSec !== undefined) headers['Retry-After'] = String(opts.retryAfterSec);
  return {
    status,
    headers,
    body: {
      type: `urn:problem-type:identity:${code.replaceAll('_', '-')}`,
      title,
      status,
      detail,
      instance: opts.instance,
      code,
      request_id: undefined,
      error,
      error_description: description,
      ...opts.extras,
    },
  };
}
