// Her hata kodu ve red nedeni için tek satırlık "ne oldu → ne yapmalı" açıklaması (Türkçe).
// Metinler skill'in references/errors.md ve auth.md dosyalarındaki ifadeleri izler; orada olmayan
// bir neden uydurulmaz. Panel yolları ve destek bilgileri reponun ortak sabitleridir.

const CALL_CENTER = 'çağrı merkezi +90 850 303 0 303';
const TEKNIK = 'teknikdestek@netgsm.com.tr';
const ABONE = 'abone.islemleri@netgsm.com.tr';
const DESTEK = `${CALL_CENTER} ya da ${ABONE}`;
const SENDER_URL = 'https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi';
const PRICES_URL = 'https://www.netgsm.com.tr/fiyatlar/toplu-sms';
const SUB_USERS = 'Online İşlemler → Abonelik İşlemleri → Alt Kullanıcı Hesapları';
const API_PERMS = 'Abonelik İşlemleri → API İşlemleri → API Erişim İzinleri';
const API_ACTIVATE = 'Abonelik İşlemleri → API İşlemleri → Aktifleştir';

const SEND = '/sms/v3/send';
const TEMPLATE = '/sms/v3/send/template';
const DIRECTORY = '/sms/v3/directory/send';
const OTP = '/sms/v3/send/otp';
const CANCEL = '/sms/v3/cancel';
const BALANCE = '/sms/v3/balance';
const SEND_PATHS = new Set([SEND, DIRECTORY, TEMPLATE, OTP]);
const REPEAT = (id = 'jobId') => `tekrarlıyorsa ${id} ile ${TEKNIK} adresine yazın`;

const TEXTS = {
  // --- SMS API (ApiError.code)
  UNAUTHENTICATED: "Bearer token yok, geçersiz ya da süresi dolmuş (refresh sonrası eski token, revoke ya da aynı hesapta başka kimlikle giriş de bu sonucu verir) → POST /auth/v3/token ile yeniden giriş yapıp isteği yeni token'la bir kez tekrarlayın; yine 401 ise kimlik bilgilerini ve hesabı kontrol edin. Token'ı önbellekte tutun, her istekte yeni token almayın.",
  SERVICE_UNAVAILABLE: `Servis geçici olarak kullanılamıyor → okuma, /send/otp ve /cancel isteklerini artan beklemeyle (1, 2, 4 sn) güvenle tekrar deneyebilirsiniz; /send ve /send/template'te görev kuyruğa alınmış olabilir (toplu gönderimi körlemesine yeniden göndermeden önce GET /report ile kontrol edin), /directory/send'de yeniden göndermeden önce GET /report ile kontrol etmelisiniz; uzun sürerse requestId ile ${TEKNIK} adresine yazın.`,
  E_SIGNATURE_REQUIRED: `Bu gönderim (/directory/send) için hesapta e-imza ile giriş gerekiyor; kodla çözülmez → Netgsm web paneline e-imza ile giriş yapın; sürerse requestId ile ${DESTEK} ile görüşün. Tekrar denemek sonucu değiştirmez.`,
  FORBIDDEN: `Hesap ya da alt kullanıcı bu işlemi yapamaz (alt kullanıcının SMS yetkisi yok, hesapta SMS gönderim/alım hizmeti açık değil ya da hedef operatöre gönderim yapılamıyor, ya da /send/otp'ta x-client başlığı hesabın OTP hizmetine uymuyor: kurumsal OTP hesabı x-client: enterprise gönderir, diğer hesaplar bu başlığı göndermez; message nedeni söyler) → alt kullanıcıysa önce ${SUB_USERS} bölümünde SMS yetkisini kontrol edin; değilse ya da sürüyorsa requestId ile ${DESTEK} ile görüşün. Tekrar denemek sonucu değiştirmez.`,
  ALREADY_EXISTS: 'Hesapta bu türde bir webhook kaydı zaten var (var olanın üzerine yazılmaz) ya da hesap için başka bir kayıt sürüyor → adres değişecekse önce DELETE, sonra yeniden POST gönderin; başka bir kayıt sürüyorsa o tamamlanınca tekrar deneyin.',
  NOT_FOUND: "Adres ya da kayıt yok → yolu (/sms/v3 öneki dahil) ve jobId'yi kontrol edin; /stats'ta month'u görevin gönderildiği aya (yyyy-MM) ayarlayın; /cancel'da 404 bekleyen görev kalmadığı anlamına gelir.",
  INVALID_REQUEST: "İstek biçimi geçersiz → violations ve message'a göre isteği düzeltin (413'te gönderimi birden fazla isteğe bölün); aynı isteği değiştirmeden tekrar göndermek işe yaramaz.",
  INVALID_SEND_WINDOW: "Gönderim aralığı geçersiz → /send ve /send/template'te startAt en fazla 18 ay ileride olabilir; /directory/send'de stopAt, startAt'tan 1 ile 21 saat sonra olmalıdır. startAt / stopAt düzeltilmeden tekrar denemeyin.",
  REJECTED_HEADER: `Gönderici başlığı bu hesapta kullanılamıyor (message ret adını söyler) → GET /senders ile kayıtlı başlıkları ve usable / reason değerlerini görün, sender'ı kayıtlı hâliyle birebir (büyük/küçük harf dahil; /send/otp'ta harf farkı önemsizdir) yazın; gerekirse başlık talebi açın: ${SENDER_URL}`,
  REJECTED_IYS: `İstenen İYS filtresi uygulanamıyor (hesap İYS modunda değil ya da başlığın İYS marka kodu yok) → iysFilter kullanımını kontrol edin: ticari (marka/bayi) iletilerde doğru filtre kullanılır ve filtre kaldırılmaz, NONE yalnızca bilgilendirme iletileri içindir. Hesabı İYS moduna almak ya da başlığa marka kodu tanımlamak için requestId ile ${DESTEK} ile görüşün.`,
  NO_DELIVERABLE_MESSAGES: "Kayıtların hepsi reddedildi, görev oluşturulmadı → rejectedItems[].reason değerlerine göre kayıtları düzeltip yeni bir istekte gönderin; aynı gövdeyi tekrar göndermek işe yaramaz.",
  INSUFFICIENT_CREDIT: `Kredi, paket ya da kampanya yetersiz (OTP isteğinde hiçbir şey gönderilmedi; raporda failReason olarak görülürse o kayıt gönderilmedi) → paket tanımlayın ya da bakiye yükleyin (${PRICES_URL}), sonra tekrar deneyin.`,
  QUEUE_UNCONFIRMED: `İstek iletildi ama yanıtı alınamadı (/directory/send'de görev kuyruğa alınmış, /cancel'da görev iptal edilmiş olabilir) → gönderimi körlemesine tekrar göndermeyin (istekler tekilleştirilmez, gruplara iki kez SMS gider); önce GET /report ile kontrol edin, belirsizse requestId ile ${TEKNIK} adresine yazın. İptali yeniden göndermek güvenlidir: görev iptal edildiyse 404 döner.`,
  INTERNAL_ERROR: `Sunucuda beklenmeyen bir hata oluştu → okuma isteğiyse kısa süre sonra tekrar deneyin; gönderim isteğiyse gönderilmiş olabilir, körlemesine tekrar denemeyin, önce GET /report ile kontrol edin. Her durumda requestId ile ${TEKNIK} adresine bildirin.`,

  // --- Kayıt red nedenleri (RejectedMessage.reason)
  INVALID_RECIPIENT: "Numara eksik ya da biçimi yanlış → Türkiye için 90 ve 10 rakam (905061234567), yurt dışı için - ve ülke koduyla 9–17 rakam (-4915112345678) yazın; +, baştaki 0, 00, boşluk, parantez ya da ayraç tire kullanmayın.",
  INVALID_MESSAGE: 'Metin eksik ya da boş → metni doldurup kaydı yeni bir istekte gönderin.',
  MESSAGE_TOO_LONG: "Metin, encoding ve gönderici türüne göre sınırı aşıyor (en fazla DEFAULT 917, TURKISH 888, UNICODE 396 karakter; alfanümerik başlıkta her sınır 5 eksik) → POST /length ile ölçün, metni kısaltın ya da uygun encoding'i seçin.",
  MALFORMED_ENTRY: 'Kayıt null → messages (şablonda templates) dizisine null eleman eklemeyin.',
  DUPLICATE_RECIPIENT: 'Aynı alıcı istekte daha sonra yeniden geçiyor; yalnızca son kayıt işlenir, öncekiler bu nedenle reddedilir → alıcıları istekte tekilleştirin.',
  NO_INTERNATIONAL_PERMISSION: `Numara yurt dışı ve hesabın yurt dışı gönderim izni yok → izin için destek ekibiyle iletişime geçin: ${CALL_CENTER} (+90 312 911 0 911) veya ${ABONE}.`,

  // --- Başlık (REJECTED_HEADER message / GET /senders reason) ayrıntıları
  NO_HEADERS_REGISTERED: `Hesapta kayıtlı gönderici başlığı yok → başlık talebi açın: ${SENDER_URL}`,
  CASE_MISMATCH: "Başlık kayıtlı ama büyük/küçük harfi farklı yazılmış → GET /senders'taki name değerini birebir kullanın.",
  NOT_REGISTERED: "sender hesaba kayıtlı değil → GET /senders ile kayıtlı başlıkları görün; abone numarası başında 0 ya da 90 olmadan yazılır (/send/otp'ta 0 ya da 90 ile de yazılabilir).",
  ROUTING_CODE_MISSING: `Alfanümerik başlık için hesapta yönlendirme kodu tanımlı değil → kodla çözülmez; requestId ile ${DESTEK} ile görüşün.`,
  SUBSCRIBER_NUMBER_RESTRICTED: `Hesapta abone numarasından gönderim kısıtlı → onaylı bir alfanümerik başlık kullanın ya da ${DESTEK} ile görüşün.`,

  // --- Identity (Problem.code)
  validation_failed: 'Girdi doğrulanamadı → errors alanındaki her alanı düzeltin; scope olarak "sms" gönderin (boş ya da tanınmayan kapsamda errors.scope izin verilen değerleri listeler); kimlik bilgilerini query string\'de değil gövdede gönderin.',
  invalid_request: `İstek işlenemedi → gövdenin geçerli JSON ya da form olduğunu ve Content-Type başlığını kontrol edin; sürerse request_id ile ${TEKNIK} adresine yazın.`,
  invalid_credentials: "Kullanıcı adı ya da şifre hatalı (username abone numarasıdır; şifre giriş yapılan kimliğin, tercihen API alt kullanıcısının şifresidir) → bilgileri kontrol edin; aynı yanlış bilgiyle tekrar denemeyin: aynı kullanıcı adı ve IP'den dakikada 5 hatalı deneme too_many_failed_attempts getirir.",
  invalid_refresh_token: 'Refresh token geçersiz, süresi dolmuş ya da oturum sonlandırılmış → POST /auth/v3/token ile yeniden giriş yapın.',
  invalid_token: "Access token eksik, geçersiz, süresi dolmuş ya da oturumu sonlandırılmış → refresh yerine POST /auth/v3/token ile yeniden giriş yapın ve isteği bir kez tekrarlayın; aynı hesapta API için tek kimlik kullanın.",
  login_not_permitted: `Bu hesapla giriş yapılamıyor → request_id ile destek ekibine başvurun: ${DESTEK}.`,
  api_access_denied: `Hesabın API erişimi yok → panelde ${API_ACTIVATE} yolundan API erişimini açın.`,
  ip_not_allowed: `Bu IP adresinden erişim izni yok → ${API_PERMS} bölümünde isteğin çıktığı (sunucunun dış) IP adresini yetkilendirin.`,
  country_not_allowed: `Yurt dışından erişim izni yok → ${API_PERMS} bölümünde ülke erişimini yetkilendirin.`,
  account_inactive: `Hesap aktif değil → request_id ile destek ekibine başvurun: ${DESTEK}.`,
  service_not_activated: `İstenen hizmet (SMS gönderim/alım) hesapta aktif değil; aktivasyon Netgsm'in sürecine bağlıdır, kod ya da panel çözümü yoktur → request_id ile ${DESTEK} ile görüşün.`,
  sub_user_not_permitted: `Alt kullanıcının SMS yetkisi yok → ${SUB_USERS} bölümünde kullanıcının yetkilerinde SMS hizmetini işaretleyin ya da aynı yerden Yeni Kayıt ile yeni bir API alt kullanıcısı oluşturun.`,
  too_many_failed_attempts: "Aynı kullanıcı adı ve IP'den dakikada 5 hatalı giriş → retry_after / Retry-After kadar bekleyin ve kimlik bilgisini düzeltin; başarılı giriş sayacı sıfırlar.",
  rate_limited: "İstek limiti aşıldı (örneğin her istekte token alınması) → Retry-After kadar bekleyin; token'ı önbellekte tutup süresi dolmadan yeniden kullanın.",
  not_found: 'Adres bulunamadı → yolu (/auth/v3 öneki dahil) düzeltin.',
  method_not_allowed: 'Bu HTTP metodu bu adreste desteklenmiyor → uç nokta tablosundaki (Allow başlığındaki) metodu kullanın.',
  payload_too_large: "İstek gövdesi çok büyük (1 MB'ı aşıyor) → gövdeyi küçültün.",
  internal_error: `Sunucuda beklenmeyen bir hata oluştu → bir süre sonra tekrar deneyin; sürerse request_id ile ${TEKNIK} adresine yazın.`,
  service_misconfigured: `Sunucu tarafı yapılandırma hatası → bir süre sonra tekrar deneyin; sürerse request_id ile ${TEKNIK} adresine yazın.`,
  service_unavailable: 'Kimlik doğrulama altyapısına ulaşılamıyor → Retry-After varsa o kadar, yoksa bir süre bekleyip isteği güvenle tekrar deneyebilirsiniz.',
  https_required: "Gerçek API yalnızca HTTPS kabul eder → adresi https://ext-api.netgsm.com.tr/auth/v3 olarak kullanın (mock'ta http://127.0.0.1:4010 kullanılabilir).",

  // --- Gövdesiz yanıtlar
  not_acceptable: "406: Accept başlığı JSON'u kabul etmiyor (yanıtın gövdesi yok) → Accept: application/json gönderin ya da Accept başlığını kaldırın.",

  // --- İletim hata nedenleri (failReason); "Anlamı" spec'teki tanımdır
  INVALID_NUMBER: 'Hatalı numara (yurt dışı numarada, kayıt kabul edildikten sonra hesabın yurt dışı izninin kaldırıldığı anlamına da gelebilir) → numarayı doğrulayıp listenizde işaretleyin; yurt dışı numarada izni kontrol edin.',
  NOT_SENT_TO_OPERATOR: `Operatöre gönderilemedi → ${REPEAT()}; yeniden gönderim sizin kararınızdır (yeni görev, yeni ücret).`,
  OPERATOR_REJECTED: `Operatör kabul etmedi → ${REPEAT()}.`,
  OPERATOR_ERROR: `Operatör hatası → ${REPEAT()}.`,
  SEND_ERROR: `Gönderim hatası → ${REPEAT()}.`,
  DUPLICATE: 'Mükerrer gönderim → akışınızda aynı mesajın iki kez gönderilip gönderilmediğini (örneğin 503 ya da 504 sonrası körlemesine tekrar) kontrol edin.',
  BLACKLISTED: 'Numara kara listede → GET /blacklist?number=... ile kontrol edin; bu numaraya göndermeyin.',
  IYS_REJECTED: `İYS reddi (spec nedeni ayrıntılandırmaz) → alıcının, gönderimde kullanılan iysFilter (marka/bayi) için İYS izni olup olmadığını kontrol edin; netleşmezse jobId ile ${TEKNIK} adresine yazın.`,
  IYS_ERROR: `İYS kontrolü yapılamadı → ${REPEAT()}.`,
  MESSAGE_NOT_CREATED: `Mesaj oluşturulamadı → jobId ile ${TEKNIK} adresine yazın.`,
  INVALID_NUMBER_FORMAT: 'Hatalı numara biçimi → numara biçimini düzeltin.',
  NTS_NOT_APPROVED: `NTS onayı alınamadı (dokümanda ayrıntı yok) → jobId ile ${TEKNIK} adresine yazın.`,
  REPORT_NOT_FORWARDED: `Rapor iletilemedi; bu satır mesajın alıcıya ulaşıp ulaşmadığını göstermeyebilir → körlemesine yeniden göndermeyin (alıcıya iki mesaj ulaşabilir); gerekirse jobId ile ${TEKNIK} adresine yazın.`,
  SMS_DISABLED_ON_DEVICE: 'Mobil cihaz SMS almaya kapalı → alıcı tarafında çözülür.',
  DEVICE_NOT_SUPPORTED: 'Mobil cihaz desteklemiyor → alıcı tarafında çözülür.',
  ROUTING_FAILED: `Yönlendirme başarısız → ${REPEAT()}.`,
  OPERATOR_TIMEOUT: 'Hedef operatörde zaman aşımı oluştu → gerekirse daha sonra yeniden gönderin.',
  UNKNOWN_SUBSCRIBER: 'Tanımlanamayan abone → numarayı doğrulayın.',
  ILLEGAL_SUBSCRIBER: 'Uyumsuz abone → numarayı doğrulayın.',
  SYSTEM_ERROR: `Sistemsel hata → ${REPEAT()}.`,
  TIMEOUT: 'Zaman aşımı → gerekirse daha sonra yeniden gönderin.',
  UNKNOWN: `Tanımlı olmayan bir neden → jobId ile ${TEKNIK} adresine yazın.`,
};

/** Bağlama (yol, Retry-After) göre değişen açıklamalar; bağlam yoksa TEXTS'teki genel metin kullanılır. */
function contextual(code, { path, hasRetryAfter } = {}) {
  const isSend = typeof path === 'string' && SEND_PATHS.has(path);
  if (code === 'INTERNAL_ERROR' && typeof path === 'string') {
    if (path === OTP) return `Sunucuda beklenmeyen bir hata oluştu; OTP gönderilmiş olabilir → otomatik tekrar göndermeyin (alıcıya iki farklı şifre ulaşabilir); OTP iletimleri GET /report ile sorgulanamaz, durum için requestId ile ${TEKNIK} adresine yazın.`;
    if (isSend) return `Sunucuda beklenmeyen bir hata oluştu; doküman kuyruk durumunu söylemez, gönderim kuyruğa alınmış ya da gönderilmiş olabilir → körlemesine tekrar denemeyin (çift SMS riski); önce GET /report ile kontrol edin, belirsizse requestId ile ${TEKNIK} adresine yazın.`;
    return `Sunucuda beklenmeyen bir hata oluştu → okuma isteğini kısa süre sonra tekrar deneyebilirsiniz; sürerse requestId ile ${TEKNIK} adresine yazın.`;
  }
  if (code === 'QUEUE_UNCONFIRMED' && path === DIRECTORY) {
    return `Gönderim platforma iletildi ama yanıtı alınamadı; görev kuyruğa alınmış olabilir → aynı isteği körlemesine tekrar göndermeyin (gruplara iki kez SMS gider); yeniden göndermeden önce GET /report ile kontrol etmelisiniz, belirsizse requestId ile ${TEKNIK} adresine yazın.`;
  }
  if (code === 'QUEUE_UNCONFIRMED' && path === CANCEL) {
    return `İptal iletildi ama yanıtı alınamadı; görev iptal edilmiş olabilir → iptali yeniden gönderebilirsiniz, iptal isteğini tekrarlamak SMS göndermez: görev iptal edildiyse 404 döner; emin olamıyorsanız requestId ile ${TEKNIK} adresine yazın.`;
  }
  if (code === 'SERVICE_UNAVAILABLE' && typeof path === 'string') {
    if (path === SEND || path === TEMPLATE) return `Servis geçici olarak kullanılamıyor; görev çoğunlukla kuyruğa alınmamıştır, ama bu kesin değildir → toplu gönderimi körlemesine yeniden göndermeden önce GET /report ile kontrol edin (istekler tekilleştirilmez, çift SMS riski); kayıt yoksa artan beklemeyle (1, 2, 4 sn) tekrar deneyebilirsiniz; sürerse requestId ile ${TEKNIK} adresine yazın.`;
    if (path === DIRECTORY) return `Platforma ulaşılamadı, platform bir hata döndü ya da görev numarası vermedi; görev kuyruğa alınmış olabilir → yeniden göndermeden önce GET /report ile kontrol etmelisiniz (aynı istek iki kez gönderilirse gruplara iki kez SMS gider); sürerse requestId ile ${TEKNIK} adresine yazın.`;
    if (path === OTP) return `Servis ya da OTP kanalı geçici olarak kullanılamıyor; hiçbir şey gönderilmedi → aynı isteği artan beklemeyle (1, 2, 4 sn) güvenle tekrar deneyebilirsiniz; sürerse requestId ile ${TEKNIK} adresine yazın.`;
    if (path === CANCEL) return `İptal servisine ulaşılamadı; görev büyük olasılıkla iptal edilmedi → iptali artan beklemeyle güvenle tekrar deneyebilirsiniz (görev bu arada iptal edildiyse 404 döner); sürerse requestId ile ${TEKNIK} adresine yazın.`;
    return `Servis geçici olarak kullanılamıyor; hiçbir şey yapılmadı → aynı isteği artan beklemeyle (1, 2, 4 sn) güvenle tekrar deneyebilirsiniz; uzun sürerse requestId ile ${TEKNIK} adresine yazın.`;
  }
  if (code === 'RATE_LIMITED' && path === BALANCE) {
    return 'Bakiye sorgu sınırı (hesap başına dakikada 60 istek) aşıldı → Retry-After kadar bekleyip yeniden deneyin; bakiyeyi döngüde ya da her gönderimden önce sorgulamayın, büyük bir kampanyadan önce bir kez bakın (yanıt zaten 10 sn önbellekte tutulur).';
  }
  if (code === 'RATE_LIMITED') {
    if (hasRetryAfter === false) return `Hesabın gönderimi askıya alınmış (sending is suspended, Retry-After yok) → beklemeyin ve tekrar denemeyin, beklemek işe yaramaz; requestId ile ${DESTEK} ile görüşün.`;
    if (hasRetryAfter === true) return "Uç noktanın istek sınırı aşıldı → Retry-After başlığındaki saniye kadar bekleyip yeniden deneyin; alıcıları toplu gönderin, rapor için sık sorgulama yerine webhook kullanın.";
    return `İstek sınırı aşıldı ya da gönderim askıya alındı (message hangisi olduğunu söyler) → Retry-After varsa o kadar bekleyip yeniden deneyin; Retry-After yoksa gönderim askıya alınmıştır, tekrar denemeyin ve ${DESTEK} ile görüşün.`;
  }
  return null;
}

/**
 * Kod için tek satırlık "ne oldu → ne yapmalı" açıklaması. Bilinmeyen kod için genel bir cümle döner.
 * @param {string} code
 * @param {{ path?: string, hasRetryAfter?: boolean }} [context] isteğin yolu ve yanıtta Retry-After olup olmadığı
 */
export function explain(code, context = {}) {
  const c = contextual(code, context);
  if (c) return c;
  const t = TEXTS[code];
  if (t) return t;
  return `Tanınmayan kod (${String(code)}) → yanıt gövdesindeki message alanını okuyun; sürerse requestId ile ${TEKNIK} adresine yazın.`;
}
