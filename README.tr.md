# Netgsm Agent Skills

[English](README.md) · **Türkçe**

Netgsm olarak, API'lerimizle entegrasyon geliştiren müşterilerimizin yapay zekâ kodlama asistanlarıyla
daha hızlı ve daha güvenli çalışabilmesi için bu skill paketini sunuyoruz. Paket; SMS gönderimi, bakiye
sorgulama ve İleti Yönetim Sistemi (İYS) izin yönetimi konularında asistana Netgsm API'lerinin doğru
kullanım kurallarını, hata kodlarını ve resmî dokümantasyon bağlantılarını kazandırır.

Skill'ler açık [Agent Skills](https://agentskills.io/) biçimindedir (bir `SKILL.md` dosyası ve
referanslardan oluşan dizin); bu yüzden skill destekleyen her asistanla çalışır: örneğin Claude Code,
claude.ai, OpenAI Codex, GitHub Copilot, Cursor, Gemini CLI, Kiro ve Goose. Bu depo aynı zamanda
Claude Code için `netgsm-agent-skills` adlı bir plugin marketplace'idir ve `sms-skills` plugin'ini
içerir.

Skill içerikleri Türkçedir; kod örnekleri, alan adları ve hata kodları özgün hâliyle yer alır.

## Paketin içeriği

### Skill'ler

| Skill | Kapsam | Test ortamı |
|---|---|---|
| `netgsm-sms` | SMS API v3 ve Identity (token) API: toplu SMS, OTP, şablonla gönderim, iletim raporu, gelen SMS, webhook, gönderici adı, `iysFilter`, bakiye / kalan paket sorgulama (`GET /sms/v3/balance`), hata kodları ve tekrar deneme kuralları | Yerel mock sunucusu ve Netgsm sandbox'ı |
| `netgsm-iys` | İYS API v1: izin (ONAY / RET) kaydetme ve sorgulama, marka kodu, izin sonuç webhook'u, hata kodları, SMS gönderimiyle birlikte kullanım | Yoktur; her istek canlı İYS'ye gider |

Skill'ler, ilgili konuda bir soru sorulduğunda ya da entegrasyon kodu yazılırken asistan tarafından
kendiliğinden kullanılır.

### Yerel mock sunucusu

`netgsm-sms` skill'i, SMS ve Identity API'lerinin bağımlılıksız bir Node.js mock'unu içerir
(`scripts/netgsm-sms-mock.mjs`). Mock gerçek API ile aynı yolları ve sözleşmeyi konuşur, Netgsm
aboneliği gerektirmez ve hiçbir zaman SMS göndermez. İstenen anda hata (`503`, `504`, `500`, `429`)
üretebilir, webhook gönderir ve entegrasyondaki yanlış kalıpları `GET /__mock/advice` ile bildirir.

### Komutlar (yalnızca Claude Code)

| Komut | İşlevi |
|---|---|
| `/sms-mock [port]` | SMS API yerel mock sunucusunu arka planda başlatır (port belirtilmezse `4010`). |
| `/sms-review [yol]` | Koddaki Netgsm SMS API entegrasyonunu skill kurallarına göre inceler ve bulguları önem sırasıyla raporlar; kodu onayınız olmadan değiştirmez. |

## Kimler için

- Netgsm SMS API'si ile toplu SMS, OTP ya da bildirim gönderimi entegrasyonu geliştiren yazılım ekipleri,
- Ticari elektronik ileti izinlerini İYS'ye kaydetmesi ve gönderimlerinde İYS filtresi uygulaması
  gereken işletmeler,
- Hesap bakiyesini ve paket durumunu uygulamalarından izlemek isteyen müşterilerimiz.

Netgsm aboneliği bulunmayan geliştiriciler de SMS entegrasyonunu yerel mock sunucusu ve sandbox ile
geliştirip test edebilir.

## Kurulum

### 1. Claude Code (plugin marketplace)

```
/plugin marketplace add netgsm/skills
/plugin install sms-skills@netgsm-agent-skills
```

Kurulumdan sonra iki skill ile `/sms-mock` ve `/sms-review` komutları kullanıma hazırdır.

### 2. claude.ai (skill yükleme)

1. Depomuzun GitHub **Releases** sayfasından ihtiyaç duyduğunuz skill'in zip dosyasını indirin:
   `netgsm-sms.zip`, `netgsm-iys.zip`. Her zip tek bir skill içerir.
2. claude.ai'da **Ayarlar → Capabilities → Skills** bölümünden zip dosyasını yükleyin.

Zip dosyaları, sürüm yayımlanana kadar depo klonlanıp `npm install && npm run zip` komutuyla da
üretilebilir (çıktılar `dist/` dizinindedir). claude.ai ortamında mock sunucusu çalışmaz; mock'u kendi
bilgisayarınızda ayrıca çalıştırabilirsiniz.

### 3. Agent Skills destekleyen diğer asistanlar

Skill dizinlerini asistanınızın skill dizinine kopyalayın:

- `plugins/sms-skills/skills/netgsm-sms`
- `plugins/sms-skills/skills/netgsm-iys`

Pek çok araç proje düzeyindeki skill'leri deponuzdaki `.agents/skills/` dizininden okur; tam konum
(proje ya da kullanıcı düzeyi) araçtan araca değişir ve zamanla güncellenir, bu yüzden aracınızın
dokümantasyonuna bakın. Her dizini bütün olarak kopyalayın (`SKILL.md`, `references/` ve `netgsm-sms`
için `scripts/`).

`/sms-mock` ve `/sms-review` komutları Claude Code'a özgüdür. Karşılıkları:

- **Mock sunucusu:** Node.js 20 veya üstüyle, kurulum gerektirmeden doğrudan çalıştırın:

  ```bash
  node <skill dizini>/scripts/netgsm-sms-mock.mjs [seçenekler]
  ```

  | Seçenek | Anlamı |
  |---|---|
  | `--port <n>` | Dinlenecek port (varsayılan `4010`) |
  | `--host <h>` | Dinlenecek adres (varsayılan `127.0.0.1`). Loopback dışı bir adreste uyarı yazılır ve loopback webhook adresleri gerçek API'deki gibi reddedilir. |
  | `--token-ttl <sn>` | Token ömrü, saniye (varsayılan `86400`) |
  | `--rate-scale <oran>` | Hız sınırı çarpanı (varsayılan `1`; `10` = sınırlar on kat gevşek, `1`'den küçük = daha sıkı) |
  | `--quiet` | Başarılı istekleri yazma; yalnızca hata (✘) ve bulguları (⚠) göster |
  | `--help` | Yardımı göster |

- **Entegrasyon incelemesi:** asistanınızdan Netgsm entegrasyonunuzu `netgsm-sms` skill'ine (kurallarına,
  `references/errors.md` ve `references/limits-and-batching.md` dosyalarına) göre incelemesini isteyin.

### 4. Skill desteği olmayan herhangi bir dil modeli ya da sohbet

Modele ilgili dosyaları bağlam olarak verin: API sözleşmesi `references/openapi.yaml` (token için
`references/identity-openapi.json`) ve konunuza ait referans dosyaları; örneğin `references/errors.md`,
`references/limits-and-batching.md` ya da `references/endpoints/` altındaki uç nokta dosyası. Kuralları
ve hangi sorunun hangi dosyada yanıtlandığını listeleyen `SKILL.md` ile başlayın.

### Claude'a özgü olanlar

Yalnızca paketleme: plugin marketplace dosyaları (`.claude-plugin/`), `/sms-mock` ve `/sms-review`
komutları ve claude.ai zip yüklemesi. Skill'lerin kendisi (`SKILL.md`, referanslar, örnekler ve mock
sunucusu) araçtan bağımsızdır.

## Hızlı başlangıç

Kurulumdan sonra örneğin şu talepler doğrudan karşılanır:

- "Netgsm ile 10.000 alıcıya tek istekte SMS gönderen bir Node.js servisi yaz; önce mock'ta test edelim."
- "Web formundan aldığımız SMS iznini İYS'ye kaydeden kodu yaz; ticari gönderimde `iysFilter` nasıl
  kullanılmalı?"
- "Kampanyadan önce kalan kredimizi kontrol eden bir fonksiyon yaz."
- "`src/` altındaki mevcut Netgsm entegrasyonumuzu incele."

Yerel mock sunucusu Node.js 20 veya üstüyle, ek kurulum gerektirmeden çalışır:

```bash
node plugins/sms-skills/skills/netgsm-sms/scripts/netgsm-sms-mock.mjs --port 4010
```

Mock, `http://127.0.0.1:4010` adresinde gerçek API ile aynı yolları (`/auth/v3/*`, `/sms/v3/*`) sunar
ve açılışta test hesaplarını listeler (örneğin `8500000000` / `password001`, gönderici `MOCKTEST`).
Ayrıntılar `netgsm-sms` skill'inin `references/testing.md` dosyasındadır.

## Ortamlar

SMS entegrasyonu için önerdiğimiz geçiş sırası:

| Aşama | Adres | Açıklama |
|---|---|---|
| 1. Yerel mock | `http://127.0.0.1:4010` | Abonelik gerektirmez, SMS göndermez. Geliştirme, otomatik testler ve hata senaryoları içindir. |
| 2. Sandbox | `https://ext-sandbox.netgsm.com.tr` | Demo hesaplarla gerçek ağ ve token akışı; SMS göndermez, ücretsizdir. |
| 3. Canlı | `https://ext-api.netgsm.com.tr` | Kendi kimlik bilgilerinizle gerçek ve ücretli gönderim. |

İYS API'si (`https://ext-api.netgsm.com.tr/iys/v1`) için mock ya da sandbox bulunmamaktadır. Bakiye
sorgusu (`GET /sms/v3/balance`) yerel mock'ta örnek veriyle denenebilir. İYS'ye kaydedilen izinler
hukuki kayıt niteliğindedir; skill'ler gerçek numaralarla test ya da örnek kayıt yapılmaması konusunda
uyarır ve bu istekler için açık onayınızı ister.

## Resmî dokümantasyon ve Bilgi Bankası

Skill'ler resmî dokümantasyonumuzun özetidir ve her yanıtta ilgili sayfayı gösterir. Birincil kaynak
her zaman resmî dokümantasyondur:

- **API dokümantasyonu:** https://api-docs.netgsm.com.tr/ (SMS API v3, Identity, İYS API, bakiye
  sorgulama)
- **Bilgi Bankası:** https://bilgibankasi.netgsm.com.tr/ (API alt kullanıcısı, API erişimi, IP izni,
  gönderici adı talebi, NetİYS kaydı, bakiye yükleme gibi hesap ve süreç konuları)
- **Portal (Online İşlemler):** https://portal.netgsm.com.tr

Dokümantasyonda yer almayan bir konuda skill'ler tahmin yürütmez; sizi Bilgi Bankası'na ve destek
kanallarımıza yönlendirir.

## Güvenlik ve gizlilik

- **Kimlik bilgileriniz asistanla paylaşılmaz.** Kullanıcı adı, şifre ve marka kodu gibi bilgilerin
  ortam değişkenlerinde ya da gizli değişken yönetiminde tutulması önerilir; skill'ler bu bilgilerin
  koda, depoya, loglara ya da tarayıcıya giden pakete yazılmamasını kural olarak uygular.
- **Skill'ler kendiliğinden SMS göndermez.** Skill'ler bilgi ve kod örneği sunar. Canlı bir Netgsm
  adresine istek atan bir komut ya da kod, ancak sizin açık onayınızla ve sizin kimlik
  bilgilerinizle çalıştırılır; asistan bu isteğin gerçek hesapta çalışacağını ve gönderimlerin ücretli
  olduğunu önceden belirtir.
- **Testler ve örnekler canlı API'ye gitmez.** Paketteki testler ve araçlar yalnızca yerel mock
  sunucusu ya da sahte istemcilerle çalışır.
- **Kişisel veri:** Alıcı numaraları ve e-posta adresleri kişisel veridir; örnek kodlar loglarda bu
  bilgilerin maskelenmesini önerir.

## Destek

Resmî dokümantasyon ve Bilgi Bankası'nda yanıt bulamadığınız konularda destek ekiplerimize
ulaşabilirsiniz:

| Kanal | Bilgi |
|---|---|
| Çağrı merkezi | `+90 850 303 0 303` · `+90 312 911 0 911` |
| Teknik destek | `teknikdestek@netgsm.com.tr` |
| Abonelik işlemleri | `abone.islemleri@netgsm.com.tr` |

Teknik destek taleplerinizde SMS API için `requestId` (Identity için `request_id`), gönderimlerde
`jobId`, İYS API için `X-Thread-Id` değerini paylaşmanız talebinizin hızla incelenmesini sağlar.
Şifre ve token bilgisi hiçbir kanalda paylaşılmamalıdır.

## Katkı

Geliştirme ortamı, testler, içerik kontrolleri ve spec güncelleme adımları
[CONTRIBUTING.md](CONTRIBUTING.md) dosyasında (İngilizce) açıklanmıştır.

## Lisans

Bu paket [MIT lisansı](LICENSE) ile sunulmaktadır. Mock sunucusu dosyasına gömülü üçüncü taraf
paketlerin lisans metinleri dosyanın sonunda yer alır.
