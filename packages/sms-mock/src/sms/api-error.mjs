/**
 * SMS API hata gövdesi. `requestId` ve `timestamp` sunucu tarafından yanıt
 * yazılırken doldurulur (bkz. server.mjs).
 * @returns {import('../http.mjs').MockResponse}
 */
export function smsError(status, code, message, extras = {}, headers = {}) {
  return {
    status,
    headers,
    body: { code, message, requestId: undefined, timestamp: undefined, violations: null, ...extras },
  };
}

/**
 * Gövde okunamadı: geçerli bir JSON değil (sözdizimi hatası), boş ya da JSON nesnesi değil; `violations`
 * null'dır. Geçerli JSON'da türü uymayan bir değer bu cümleyi değil `1 field(s) rejected`'ı alır
 * (bkz. bind.mjs).
 */
export const UNREADABLE_BODY = 'request body could not be read as json';

/**
 * Alan doğrulaması: `N field(s) rejected`. N farklı alan sayısı değil, ihlal sayısıdır: aynı alan iki
 * kuralı birden çiğnerse (boş `sender`: `must not be blank` ve uzunluk) iki kez sayılır. Tür bağlama
 * hatası (bind.mjs) her zaman tek ihlaldir: `1 field(s) rejected`.
 */
export function fieldsRejected(violations) {
  return smsError(400, 'INVALID_REQUEST', `${violations.length} field(s) rejected`, { violations });
}
