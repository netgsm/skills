# Başlangıç: ön koşullar, token ve istek biçimi

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/iys/netgsm-iys-api/ (kimlik doğrulama, istek
ve yanıt biçimi, hata kodları) · token: https://api-docs.netgsm.com.tr/auth/token/ ·
https://api-docs.netgsm.com.tr/auth/refresh-token/. Hesap ve panel adımları: Netgsm Bilgi Bankası,
https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/net-iys-kayit-net-iys-kullanicisi-olmak ve
https://bilgibankasi.netgsm.com.tr/entegrasyonlar/api-entegrasyonu-hazirlik-rehberi

Bu dosya "İYS API'sini kullanmak için ne gerekir?", "token nasıl alınır?" ve "istek nasıl kurulur?"
sorularını yanıtlar. Burada olmayan bir hesap ya da panel sorusunun yanıtı önce Bilgi Bankası'nda
aranır, orada da yoksa destek kanallarına başvurulur.

## Ön koşullar

İYS API'si, hesabında **İYS hizmeti aktif** olan Netgsm abonelerine açıktır. Aktif değilse her istek
`403` ve `errorCode` `63` (`IYS_MODULE_INACTIVE`) alır.

Bilgi Bankası'ndaki NetİYS kayıt rehberine göre adımlar:

1. İYS'ye (https://iys.org.tr) hizmet sağlayıcı olarak üye olun, hesap oluşturun ve bir İYS paketi seçin.
2. İYS'de Netgsm'i iş ortağınız olarak yetkilendirin.
3. İYS kodunuzla Netgsm'e başvurun.
4. Netgsm portalında **SMS Hizmeti → Netiys** sekmelerinden NetİYS arayüzüne girin. NetİYS kaydınız
   yoksa aynı yoldan kayıt ekranına ulaşıp marka adı, İYS kodu ve NetİYS paketi seçerek kaydınızı
   oluşturun.

Ayrıca:

- **İYS kredisi:** API entegrasyonu hazırlık rehberine göre İYS hesabınızın aktif olması için İYS
  kredisi yüklenir.
- **Marka kodu (`brandCode`):** İYS panelinizden öğrenilir. Her İYS isteğinde zorunludur. İYS kodu
  (hizmet sağlayıcı) ile marka kodu ayrıdır; API marka kodunu ister.
- **NetİYS'in demo paketi yoktur** (NetİYS SSS). İYS API'sinin sandbox'ı ve yerel mock'u da yoktur.

Kayıt, paket, kredi ya da marka kodu ile ilgili bir adım burada yoksa: Bilgi Bankası'ndaki NetİYS
sayfaları (SKILL.md "Bilgi Bankası sayfaları"), sonra abonelik işlemleri
(`abone.islemleri@netgsm.com.tr`).

## API alt kullanıcısı ve API erişimi

Uygulama, **abone numarası** ve **API alt kullanıcısının şifresiyle** token alır. Ayrı bir API anahtarı
yoktur.

- Alt kullanıcı **API Kullanıcısı** türünde oluşturulur:
  https://bilgibankasi.netgsm.com.tr/abonelik-islemleri/diger-islemler/alt-kullanici-olusturma
- API entegrasyonu hazırlık rehberine göre İYS (NetİYS) için alt kullanıcıya **dijital servis
  yetkisi** verilir. SMS de gönderecekse SMS yetkisi de verilir.
- Hesabın API erişimi açık olmalıdır: portalda **Abonelik İşlemleri → API İşlemleri**.
- IP kısıtlaması önerilir; kısıtlama varsa isteğin internete çıktığı (sunucunun dış) IP adresi
  yetkilendirilir.

Giriş hataları (`403 api_access_denied`, `ip_not_allowed`, `sub_user_not_permitted`,
`service_not_activated` gibi) Identity API'ye aittir. Anlamları için resmî doküman
(https://api-docs.netgsm.com.tr/auth/token/) ya da kuruluysa `netgsm-sms` skill'inin `references/errors.md`
dosyası.

## Token

```http
POST https://ext-api.netgsm.com.tr/auth/v3/token
Content-Type: application/json

{ "username": "<abone numarası>", "password": "<API alt kullanıcısı şifresi>", "scope": "sms" }
```

- **İYS için de `scope: "sms"` gönderilir.** İYS sözleşmesi scope belirtmez; Netgsm'in İYS API'si
  için kuralı budur.
- Yanıtta `access_token`, `token_type` (`Bearer`), `expires_in` (saniye; kodda sabit yazılmaz),
  `refresh_token` döner. Her İYS isteğine `Authorization: Bearer <access_token>` eklenir.
- Token **önbelleğe alınır**: `POST /auth/v3/token` IP başına dakikada 30 istekle sınırlıdır. Süre
  dolmadan `POST /auth/v3/token/refresh` (`{ "refresh_token": "..." }`) ile yenilenir ve yanıttaki
  yeni `access_token` ile `refresh_token` saklanır ve hemen yeni token'a geçilir. Eski access token'ın
  hemen reddedileceğine de bir süre daha kabul edileceğine de güvenilmez; aynı refresh token birden fazla
  süreçte koordinasyonsuz kullanılmaz.
- İYS API'den `401` (`errorCode` 50 `UNAUTHENTICATED`, 51 `TOKEN_NOT_FOUND`, 52 `INVALID_TOKEN`, 53
  `SESSION_EXPIRED`) alınırsa yeniden giriş yapılır ve istek bir kez tekrarlanır. Yeni token ile de
  `401` alınıyorsa döngüye girilmez; kimlik bilgileri ve hesap kontrol edilir.

Oturum modelinin ve Identity hata kodlarının tamamı resmî dokümanda; kuruluysa `netgsm-sms` skill'inin
`references/auth.md` dosyasında da anlatılır.

## İstek ve yanıt biçimi

- Base URL: `https://ext-api.netgsm.com.tr/iys/v1` (yalnızca canlı).
- Gövdeler JSON'dur: `Content-Type: application/json`.
- Tarih ve saatler `YYYY-MM-DD HH:mm:ss` biçimindedir (`2026-02-20 16:46:00`). Sözleşme saat dilimi
  belirtmez.
- Telefon numaraları `+90XXXXXXXXXX` (`+905321234567`), e-posta adresleri olduğu gibi gönderilir.
  SMS API v3'ün biçimi (`905321234567`) farklıdır; iki API arasında çevrilir.
- `brandCode` İYS marka kodunuzdur (tam sayı, 1–2147483647).
- `path` isteğe bağlıdır (`SANTRAL`, `SMSAPI`, `WEBPORTAL`); gönderilmezse `SMSAPI` kabul edilir.
  Sözleşme değerlerin anlamını ayrıntılandırmaz; SMS API entegrasyonunda gönderilmeyebilir.

Her yanıt aynı zarfla döner:

```json
{ "success": true, "errorCode": 0, "message": "success", "data": {} }
```

`success` işlemin başarılı olup olmadığını, `errorCode` sonucu gösterir; başarıda `errorCode` `0`'dır.
Hata mantığı `errorCode`'a göre kurulur ([errors.md](errors.md)).

## `X-Request-Id` ve `X-Thread-Id`

- Her yanıtta `X-Thread-Id` başlığı döner. Destek ekibine yazarken bu değer paylaşılır.
- İsteğe kendi `X-Request-Id` değerinizi eklerseniz (8–64 karakter, `A-Z a-z 0-9 . _ -`) `X-Thread-Id`
  olarak bu değer kullanılır. Kendi loglarınızla Netgsm kaydını eşlemek için her isteğe benzersiz bir
  değer (örneğin UUID) verin ve loglayın.
- `POST` yanıtlarındaki `data.uid` de loglanır.

## Kimlik bilgilerini kodda tutmayın

```bash
# İYS'nin sandbox'ı yoktur: bu adres canlıdır.
NETGSM_BASE_URL=https://ext-api.netgsm.com.tr
NETGSM_USERNAME=<abone numarası>
NETGSM_PASSWORD=<API alt kullanıcısı şifresi>
NETGSM_IYS_BRAND_CODE=<İYS marka kodu>
```

- `.env` dosyası `.gitignore`'a eklenir; üretimde platformun gizli değişken yönetimi kullanılır.
- Şifre, access token ve refresh token loglanmaz. Alıcı numarası ve e-posta adresi kişisel veridir;
  loglarda maskelenir (`+90532*****67`).
- İstemci yalnızca sunucu tarafında çalışır; tarayıcıya ya da mobil uygulamaya giden koda konmaz.

## Canlıya geçiş

İYS için "önce test ortamı" adımı yoktur. Bu yüzden:

1. İstemci kodu, gerçek istek atmayan bir test ikiziyle (sahte `fetch`) test edilir
   ([examples/typescript.md](examples/typescript.md)).
2. İlk canlı istek salt okunur bir sorgudur: `GET /consents`, kendi müşteri kaydınızdaki bir numara
   için. Asistan bunu çalıştırmadan önce gerçek hesapla canlı İYS'ye istek atılacağını söyler ve açık
   onay alır.
3. `POST /consents` yalnızca gerçekten alınmış izinler (ya da retler) için çağrılır. İlk kayıt
   tek, gerçek bir izinle yapılır; sonucu yanıt (`erroritem`) ve webhook ile doğrulanır.

Kontrol listesi:

- [ ] Token önbelleğe alınıyor; `401`'de bir kez yeniden giriş yapılıyor.
- [ ] Numaralar `+90XXXXXXXXXX`, tarihler `YYYY-MM-DD HH:mm:ss` biçiminde.
- [ ] İzinler 500'lük, çoklu sorgular en fazla 1000'lik (adres satırı için daha küçük) parçalarla gönderiliyor.
- [ ] `erroritem` ve çoklu sorgudaki kayıt bazlı `errorCode` işleniyor.
- [ ] `424`, `500` ve ağ hatasında `POST /consents` körlemesine tekrarlanmıyor.
- [ ] `X-Request-Id` gönderiliyor; `X-Thread-Id` ve `data.uid` loglanıyor; kişisel veri maskeleniyor.
- [ ] Hiçbir test ya da örnek kod gerçek numarayla izin kaydetmiyor.
- [ ] Kimlik bilgileri ve marka kodu ortam değişkeninde ya da gizli değişken yönetiminde.

## Bağlantılar

| Ne | Adres |
|---|---|
| İYS API dokümanı (birincil kaynak) | https://api-docs.netgsm.com.tr/iys/ |
| İYS nedir | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/ileti-yoenetim-sistemi-iys-nedir |
| NetİYS kaydı | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/net-iys-kayit-net-iys-kullanicisi-olmak |
| NetİYS hizmetleri | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/net-iys-hizmetleri |
| NetİYS SSS | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/sikca-sorulan-sorular-netiys |
| API entegrasyonu hazırlığı | https://bilgibankasi.netgsm.com.tr/entegrasyonlar/api-entegrasyonu-hazirlik-rehberi |
| API alt kullanıcısı | https://bilgibankasi.netgsm.com.tr/abonelik-islemleri/diger-islemler/alt-kullanici-olusturma |
| Portal (Online İşlemler) | https://portal.netgsm.com.tr |
| İleti Yönetim Sistemi | https://iys.org.tr |
