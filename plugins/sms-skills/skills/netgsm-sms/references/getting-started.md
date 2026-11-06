# Başlangıç: hesap, kimlik bilgileri ve ilk istek

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/ (SMS API v3 ve Identity; başlangıç:
https://api-docs.netgsm.com.tr/introduction/). Hesap ve panel adımları: Netgsm Bilgi Bankası,
https://bilgibankasi.netgsm.com.tr/

Bu dosya "API key'i nereden alırım?", "API erişimini nasıl açarım?" ve "ilk SMS'i nasıl gönderirim?"
sorularını yanıtlar. Adımlar Netgsm Bilgi Bankası'ndaki API ile SMS rehberine dayanır:
https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/api-ile-sms. Burada olmayan bir hesap ya da panel
sorusunun yanıtı önce Bilgi Bankası'nda aranır, orada da yoksa destek kanallarına başvurulur.

API v3'te ayrı bir API anahtarı kullanılmaz. Uygulama, **abone numarası** ve **API alt kullanıcısının
şifresiyle** Identity API'den token alır ve SMS isteklerinde bu token'ı kullanır (bkz. [auth.md](auth.md)).

## Ön koşullar

SMS gönderebilmek için hesapta şunlar olmalıdır:

- **Onaylı bir gönderici adı (başlık).** Talep adımları:
  https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi
- **SMS paketi.** Paketler ve fiyatlar: https://www.netgsm.com.tr/fiyatlar/toplu-sms
- **API alt kullanıcısı** ve **açık API erişimi** (aşağıdaki 1. ve 2. adım).

Bunlar hazır olmadan da geliştirmeye başlanabilir: yerel mock API ve Netgsm sandbox'ı aboneliğe ihtiyaç
duymaz (bkz. 6. ve 7. adım).

## 1. API alt kullanıcısı oluşturma

İşlemler portalda (Online İşlemler) yapılır: https://portal.netgsm.com.tr

1. **Online İşlemler → Abonelik İşlemleri → Alt Kullanıcı Hesapları** menüsüne girip **Yeni Kayıt**'a tıklayın.
2. Alt kullanıcı türü olarak mutlaka **API Kullanıcısı** seçeneğini işaretleyip **İleri**'ye tıklayın.
3. Bilgileri eksiksiz doldurun. Kimlik doğrulama nedeniyle bilgiler kimlik belgesindekilerle birebir
   aynı olmalıdır. **İleri** ile devam edin.
4. Yetkilendirme ekranında alt kullanıcının erişeceği API servislerini seçin. SMS gönderimi için
   **SMS** hizmetini işaretleyip **Kaydet**'e tıklayın. Bu yetki verilmezse giriş
   `403 sub_user_not_permitted` ile reddedilir.
5. **API Kullanacak Uygulama** ekranında uygulamanızın adını aratıp seçebilir, listede yoksa elle
   ekleyebilir ya da uygulama seçmeden devam edebilirsiniz.
6. Sistemde kayıtlı GSM numaranıza gelen doğrulama kodunu girip **Devam Et**'e tıklayın. API alt
   kullanıcınız oluşturulur.

## 2. API erişimini aktifleştirme

API servislerini kullanabilmek için hesabın API erişim izni açık olmalıdır.

1. Doğrulama kodundan sonra açılan ekranda **"API ile hesap erişimini onaylıyorum"** kutucuğunu
   işaretleyip **Devam Et**'e tıklayın.
2. **API İşlemleri** ekranında gerekli bilgileri doldurup **Aktifleştir**'e tıklayın.

API erişimi kapalıysa giriş `403 api_access_denied` ile reddedilir.

## 3. IP ve ülke izinleri

Giriş `403 ip_not_allowed` dönüyorsa isteğin geldiği IP adresine API erişim izni verilmemiştir.
`403 country_not_allowed` dönüyorsa hesabın yurt dışından erişim izni yoktur. İkisi de portalda
**Abonelik İşlemleri → API İşlemleri → API Erişim İzinleri** altından yetkilendirilir.

İzin verilecek adres, isteğin internete çıktığı (sunucunun dış) IP adresidir. NAT arkasındaki ya da
bulut ortamındaki bir sunucuda bu, makinenin kendi yerel IP'sinden farklı olabilir.

## 4. Koda girecek bilgiler

| Bilgi | Alan | Değer |
|---|---|---|
| Kullanıcı adı | `username` | Netgsm abone numarası |
| Şifre | `password` | Oluşturulan API alt kullanıcısının şifresi |
| Gönderici adı | `sender` | Onaylı gönderici adı, kayıtlı hâliyle birebir (büyük/küçük harf dahil) |

Token isteğinde bunlara ek olarak her zaman `scope: "sms"` gönderilir (gerekçesi [auth.md](auth.md)'de).

- `username`, API alt kullanıcısıyla girişte de hesabın abone numarasıdır. Şifre ise giriş yapan
  kimliğin, yani API alt kullanıcısının şifresidir.
- Hesabın API erişimi açıksa ana hesap da token alabilir (yanıtta `sub_user_id: 0`). Bu bir hata
  değildir, ama API için ayrı bir API alt kullanıcısı önerilir.
- **Aynı hesapta API için tek bir kimlik kullanın.** Ana hesap ile alt kullanıcı aynı hesapta sırayla
  giriş yaptığında birbirlerinin önceki oturumları düşebilir (`401 invalid_token`). `401 invalid_token`
  alınırsa refresh yerine yeniden giriş yapılır.
- Hangi başlıkların kullanılabildiğini `GET /sms/v3/senders` gösterir (`usable`, `reason`). Abone
  numarası başlık olarak başında `0` ya da `90` olmadan yazılır (`5061234567`).
- **Şifre unutulursa:** Alt kullanıcı listesinde ilgili alt kullanıcının yanındaki **Düzenle**
  butonundan yeni şifre oluşturulur.

## 5. Kimlik bilgilerini kodda tutmayın

Kimlik bilgileri koda ve depoya yazılmaz; ortam değişkenlerinden okunur. Örnek `.env`:

```bash
# Mock ile geliştirme. Canlıda: NETGSM_BASE_URL=https://ext-api.netgsm.com.tr
NETGSM_BASE_URL=http://127.0.0.1:4010
NETGSM_USERNAME=8500000000
NETGSM_PASSWORD=password001
NETGSM_SENDER=MOCKTEST
```

- `.env` dosyasını `.gitignore`'a ekleyin. Üretimde bilgileri platformun gizli değişken (secret)
  yönetiminde tutun.
- Şifreyi, access token'ı ve refresh token'ı loglamayın.
- Base URL'yi tek bir değişkenden okuyun: mock'tan canlıya geçiş tek bir değer değişikliği olur.
  Identity yolları `<base>/auth/v3/...`, SMS yolları `<base>/sms/v3/...` biçimindedir.

## 6. İlk istek (mock ile)

Mock'u başlatın (Node ≥ 20, kurulum gerekmez). Yol, skill dizinine göredir:

```bash
node <skill dizini>/scripts/netgsm-sms-mock.mjs
```

Token alın:

```bash
curl -s http://127.0.0.1:4010/auth/v3/token \
  -H 'Content-Type: application/json' \
  -d '{"username":"8500000000","password":"password001","scope":"sms"}'
```

Yanıttaki `access_token` değerini `TOKEN` olarak saklayıp iki alıcıya **tek istekte** gönderin:

```bash
curl -s http://127.0.0.1:4010/sms/v3/send \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sender":"MOCKTEST","referenceId":"siparis-4711","messages":[
        {"recipient":"905061234567","text":"Merhaba"},
        {"recipient":"905061234568","text":"Merhaba"}]}'
```

`202` yanıtı `jobId`, `status`, `accepted`, `rejected` ve `rejectedItems` taşır. Birkaç saniye sonra
raporu sorun:

```bash
curl -s "http://127.0.0.1:4010/sms/v3/report?jobIds=<jobId>" -H "Authorization: Bearer $TOKEN"
```

Mock'ta kayıtlar başlangıçtan 5 saniye sonrasına kadar `PENDING`, sonra `DELIVERED` olur; `00` ile
biten alıcılar `NOT_DELIVERED` / `UNKNOWN_SUBSCRIBER` döner. Aynı görevin raporu dakikada bir
sorgulanabilir; daha sık sorgu `429 RATE_LIMITED` alır. Sürekli takip için rapor webhook'u kullanılır.

## 7. Mock → sandbox → canlı

1. **Mock:** Bütün geliştirme ve otomatik testler; sandbox'ın gösteremediği durumlar da mock'ta denenir:
   istenen anda hata (`503`, `504`, `500`, `429`), istek sınırları, İYS ve kredi hataları, webhook'lar,
   değişen iletim raporları ve tavsiyeler (bkz. [testing.md](testing.md), [errors.md](errors.md)).
2. **Sandbox:** `https://ext-sandbox.netgsm.com.tr` (`/auth/v3` ve `/sms/v3`). Gerçek ağ, TLS ve token
   akışını; istek doğrulamasının ve hata gövdelerinin canlıyla aynı olduğunu demo hesaplar ve sabit
   veriyle (başlık `TESTHEADER`, şablon `1`) doğrulayın. SMS göndermez, ücretsizdir (bkz. [sandbox.md](sandbox.md)).
   Base URL'yi değiştirip başlığı `TESTHEADER` yapmanız yeterlidir; mock'ta da `TESTHEADER` kayıtlıdır.
3. **Canlı:** Yalnızca base URL (`https://ext-api.netgsm.com.tr`) ve kimlik bilgileri değişir. Canlıda
   gönderim uçları **gerçek, ücretli SMS** gönderir. Asistan canlı adrese istek atan bir komutu ya da
   kodu çalıştırmadan önce bunu söyler ve açık onay alır.

Canlıya geçmeden önce kontrol listesi:

- [ ] Token önbelleğe alınıyor, süresi dolmadan yenileniyor; `401`'de bir kez yeniden giriş yapılıyor.
- [ ] Çok alıcı tek `/send` isteğinde gönderiliyor; alıcı başına istek yok.
- [ ] `429`'da `Retry-After` kadar bekleniyor; `Retry-After` yoksa tekrar denenmiyor.
- [ ] Gönderimde (`/send`, `/send/template`, `/directory/send`) `503`, `504` ve `500` körlemesine tekrar
  denenmiyor; önce `GET /report` ile kontrol ediliyor. `/send/otp`'de `503` ve okuma uçlarında `503`
  artan beklemeyle tekrar deneniyor.
- [ ] `400`, `403`, `413`, `422` tekrar denenmiyor.
- [ ] `202` yanıtındaki `rejectedItems` işleniyor.
- [ ] Hata mantığı `code` alanına göre kurulu; `requestId` / `request_id` ve `jobId` loglanıyor.
- [ ] Raporlar webhook ile ya da sınırlara uyan aralıklarla alınıyor. Rapor webhook'u sayısal kodlarla
  (`status` `1` / `2` / …, `errorCode`, `operator`) okunuyor; `failReason` beklenmiyor
  ([endpoints/webhooks.md](endpoints/webhooks.md)).
- [ ] Bakiye (`GET /sms/v3/balance`) gerekiyorsa büyük kampanyadan önce bir kez sorgulanıyor; döngüde ya da
  her gönderimden önce değil ([endpoints/balance.md](endpoints/balance.md)).
- [ ] Kimlik bilgileri ortam değişkeninde ya da gizli değişken yönetiminde.
- [ ] Sunucunun dış IP adresi (gerekiyorsa) API Erişim İzinleri'nde yetkili.

## Bağlantılar

| Ne | Adres |
|---|---|
| API v3 dokümantasyonu (birincil kaynak) | https://api-docs.netgsm.com.tr/ |
| SMS API sandbox'ı | https://api-docs.netgsm.com.tr/sandbox/sms-api-v-3-sandbox/ |
| Bilgi Bankası (hesap, panel, süreç) | https://bilgibankasi.netgsm.com.tr/ |
| Portal (Online İşlemler) | https://portal.netgsm.com.tr |
| API ile SMS rehberi | https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/api-ile-sms |
| Gönderici adı (başlık) talebi | https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi |
| SMS paket fiyatları | https://www.netgsm.com.tr/fiyatlar/toplu-sms |
| Genel API dokümanları | https://www.netgsm.com.tr/dokuman/#api-dokumani |
