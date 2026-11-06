---
name: netgsm-iys
description: >-
  Netgsm İYS API v1 (İleti Yönetim Sistemi) uzmanı. İYS izin (consent) kaydetme ve sorgulama, ONAY / RET,
  ticari ileti onayı, ticari elektronik ileti izni, NetİYS, İYS marka kodu (brandCode), izin kaynağı
  (HS_WEB, HS_FIZIKSEL_ORTAM vb.), alıcı tipi (BIREYSEL, TACIR), izin tipi (MESAJ, ARAMA, EPOSTA), İYS
  webhook'u, ext-api.netgsm.com.tr/iys/v1, İYS hata kodları (errorCode 63 IYS_MODULE_INACTIVE,
  DEPENDENCY_ERROR, VALIDATION_ERROR vb.), X-Thread-Id sorularında kullan. SMS gönderiminde `iysFilter`
  (BRAND, RETAILER, BRAND_AND_RETAILER, NONE), başlığın İYS marka kodu, REJECTED_IYS ve IYS_REJECTED
  sorularında, "izni ne zaman kaydetmeliyim, gönderimde nasıl filtrelerim?" sorusunda da kullan. İYS
  entegrasyon kodu yazarken ya da incelerken kullan. Resmî doküman: api-docs.netgsm.com.tr/iys.
  English triggers: Netgsm IYS API, consent management, commercial message consent, opt-in/opt-out,
  brand code, Turkey.
---

# Netgsm İYS API v1

Bu skill, Netgsm İYS API'siyle ticari elektronik ileti izinlerini İleti Yönetim Sistemi'ne (İYS)
kaydeden, sorgulayan ve izin sonuçlarını webhook ile alan yazılımcıya yardım eder. Bu dosya kuralları
ve yönlendirmeyi içerir; ayrıntılar `references/` altındadır. Yalnızca sorunun gerektirdiği referans
dosyasını oku.

**Resmî doküman:** https://api-docs.netgsm.com.tr/iys/ (İYS API v1). Bu skill onun özetidir; yazılımcı
her zaman oraya yönlendirilir (kural 10).

## Adresler ve akış

| API | Canlı | Sandbox | Yerel mock |
|---|---|---|---|
| Identity (token) | `https://ext-api.netgsm.com.tr/auth/v3` | — | — |
| İYS | `https://ext-api.netgsm.com.tr/iys/v1` | **Yok** | **Yok** |

1. `POST /auth/v3/token` gövdesi `{ "username": "<abone numarası>", "password": "<API alt kullanıcısı şifresi>", "scope": "sms" }`.
   İYS API'si için token da **`scope: "sms"`** ile alınır (sözleşme scope'u belirtmez; Netgsm'in
   kuralı budur).
2. Yanıttaki `access_token` önbelleğe alınır ve her İYS isteğine `Authorization: Bearer <access_token>`
   olarak eklenir.
3. İzin kaydetme `POST /iys/v1/consents`, sorgulama `GET /iys/v1/consents`, sonuç bildirim adresi
   `POST /iys/v1/webhooks`.

## İYS'nin sandbox'ı ve mock'u yoktur

**İYS API'sine yapılan her istek canlı, ulusal İleti Yönetim Sistemi'ne gider.** Kaydedilen izinler
alıcı adına tutulan hukuki kayıtlardır; İYS'ye yüklenen adresler sonradan silinemez ve ayrıntıları
düzenlenemez (Bilgi Bankası, NetİYS SSS). NetİYS'in demo paketi de yoktur. Netgsm SMS sandbox'ı
(`ext-sandbox.netgsm.com.tr`) ve `netgsm-sms` skill'inin yerel mock'u İYS'yi **taklit etmez**.

- Bir İYS sandbox'ı, test hesabı ya da test adresi **uydurma**; böyle bir ortam yoktur.
- Kendi kodunu test etmek için kendi test ikizini (sahte `fetch`, sahte HTTP istemcisi) kullan;
  bu skill'in örnek istemcisi bunun için `fetch` enjeksiyonu alır ([typescript.md](references/examples/typescript.md)).
- Canlıya ilk deneme salt okunur bir sorgu (`GET /consents`) ile, gerçek bir müşterinin kendi
  numarasıyla ve kullanıcının açık onayıyla yapılır.

## Değişmez kurallar

Kod yazarken, incelerken ya da öneride bulunurken bu kurallar hiçbir zaman çiğnenmez.

1. **Gerçek numarayla test ya da sahte izin kaydı yapılmaz.** `POST /consents` yalnızca alıcıdan
   gerçekten alınmış bir iznin (ya da reddin) kaydı için çağrılır. Örnek, test ya da demo amacıyla
   gerçek bir telefon numarası ya da e-posta adresiyle izin kaydedilmez; spec örneklerindeki numaralar
   da gönderilmez. Kod örneklerinde ve testlerde gerçek istek atılmaz, sahte `fetch` kullanılır.
2. **Canlı isteklerden önce açık onay alınır.** `ext-api.netgsm.com.tr/iys/v1` adresine istek atan bir
   komutu ya da kodu çalıştırmadan önce kullanıcıya bunun gerçek hesapla ve canlı İYS'de çalışacağını
   söyle. `POST /consents` ve `POST /webhooks` için ayrıca **kalıcı, hukuki kayıt** oluşturacağını
   ve geri alınamayacağını açıkça belirt; açık onay yoksa çalıştırma.
3. **Telefon numarası `+90XXXXXXXXXX` biçimindedir.** SMS API v3 ise `90XXXXXXXXXX` (başında `+` yok)
   ister. İki API arasında numara taşınırken biçim çevrilir. Tarih ve saatler `YYYY-MM-DD HH:mm:ss`
   biçimindedir (`2026-02-20 16:46:00`).
4. **Token önbelleğe alınır, her istekte yeniden alınmaz.** `POST /auth/v3/token` IP başına dakikada 30
   istekle sınırlıdır. Token süresi dolmadan `POST /auth/v3/token/refresh` ile yenilenir. İYS API'den
   `401` (`errorCode` 50–53) alınırsa yeniden giriş yapılır ve istek **bir kez** tekrarlanır.
5. **Hata mantığı HTTP durum koduna değil `errorCode` alanına göre kurulur.** Her yanıt
   `{ success, errorCode, message, data }` zarfıyla döner; başarıda `errorCode` `0`'dır.
6. **Kısmi red her zaman işlenir.** `POST /consents` `200` dönse bile İYS'nin reddettiği kayıtlar
   `data.erroritem[]` altında `index` (sıfırdan başlar), `field` ve `message` ile gelir. Çoklu
   sorguda her sonuç kaydının kendi `errorCode`'u vardır (`81` kayıt bulunamadı).
7. **Kaydetmede belirsiz hata körlemesine tekrarlanmaz.** `POST /consents`'te `503`
   (`INTEGRATION_ERROR`, 141) ve `429` (150) sonrası artan beklemeyle tekrar denenir. `424`
   (`DEPENDENCY_ERROR`, 112), `500` (`SERVER_ERROR`, 110) ve ağ hatası sonrası kaydın işlenip
   işlenmediğini doküman söylemez: önce `GET /consents` ve webhook bildirimleriyle kontrol edilir,
   belirsizlik sürerse `X-Thread-Id` ile teknik desteğe danışılır. `400`, `403`, `404`, `405`, `409`
   ve `422` tekrar denenmez.
8. **Her istek izlenebilir olur.** İsteğe kendi `X-Request-Id` değerini (8–64 karakter,
   `A-Z a-z 0-9 . _ -`) ekle; yanıttaki `X-Thread-Id` ve `POST` yanıtlarındaki `data.uid` loglanır.
   Şifre, access token ve refresh token loglanmaz. Alıcı numaraları ve e-posta adresleri kişisel
   veridir; loglarda maskelenir.
9. **Dokümanda yoksa uydurma.** Spec'te ve bu referanslarda olmayan bir davranış, limit, alan, hata
   kodu, webhook gövdesi ya da panel adımı hakkında tahmin yürütme. "Bu dokümanda yok" de;
   yazılımcıyı önce resmî dokümana ve Bilgi Bankası'na (kural 10), orada da yoksa `X-Thread-Id` ile
   teknik desteğe (`teknikdestek@netgsm.com.tr`) yönlendir. Hukuki yorum yapma (hangi iletinin ticari
   sayıldığı, iznin ispatı): kullanıcıyı İYS'nin ve kendi hukuk danışmanının kaynaklarına yönlendir.
10. **Her yanıt resmî kaynağı gösterir.** Bir uç nokta, alan ya da hata kodu hakkındaki her yanıtta
    [Resmî doküman sayfaları](#resmî-doküman-sayfaları) tablosundaki ilgili api-docs adresini ver.
    Hesap, panel ve süreç konuları (NetİYS kaydı, İYS kodu, marka kodu, İYS kredisi, izin yöntemleri,
    API alt kullanıcısı, API erişimi, IP izni) API dokümanında değil Bilgi Bankası'ndadır
    ([Bilgi Bankası sayfaları](#bilgi-bankası-sayfaları)). Orada da yanıt yoksa [Destek](#destek) kanalları.

## SMS gönderimiyle ilişkisi

Ticari SMS gönderen bir müşterinin iki ayrı işi vardır. Ayrıntı: [with-sms.md](references/with-sms.md).

| İş | Ne zaman | Nasıl |
|---|---|---|
| **İzni kaydetmek** | Alıcı izin verdiğinde ya da reddettiğinde (ret dahil), en geç 3 iş günü içinde | İYS API `POST /iys/v1/consents` (`type: MESAJ`, `status: ONAY` ya da `RET`) |
| **Gönderimde filtrelemek** | Her ticari SMS gönderiminde | SMS API `POST /sms/v3/send` içinde `iysFilter` (`BRAND`, `RETAILER`, `BRAND_AND_RETAILER`); izni olmayan alıcıyı platform eler |

- Bilgilendirme iletileri (OTP, sipariş ve randevu bildirimi gibi) için `iysFilter: NONE` kullanılır;
  iletinin ticari mi bilgilendirme mi olduğuna hizmet sağlayıcı karar verir.
- `BRAND` ya da `RETAILER` filtresi, gönderici başlığına İYS marka kodu tanımlı olmasını ister
  (`GET /sms/v3/senders` yanıtında `brandCode` `0` değil). Aksi halde `422 REJECTED_IYS`.
- Gönderimden önce her alıcı için `GET /consents` çağırmak gerekmez; filtreyi gönderim yapar. Sorgu,
  kendi müşteri kayıtlarınızı İYS ile karşılaştırmak ve izin durumunu göstermek içindir.
- `iysFilter`, `REJECTED_IYS`, `IYS_REJECTED` ve gönderim kodunun ayrıntısı `netgsm-sms` skill'indedir
  (resmî doküman: https://api-docs.netgsm.com.tr/send-sms/).

## Sık yapılan hatalar

- **Numara biçimi:** `905321234567` ya da `05321234567` değil, `+905321234567`. Sorguda `+` adres
  satırında `%2B` olarak kodlanır; kodlanmazsa boşluğa dönüşür.
- **Marka kodu:** `brandCode` her istekte zorunludur ve İYS'deki marka kodunuzdur (tam sayı). İYS
  kodu ile marka kodu aynı şey değildir; marka kodu İYS panelinden öğrenilir.
- **Tek istekte çok kayıt:** `POST /consents` istek başına en fazla 500 izin, çoklu `GET /consents`
  en fazla 1000 kayıt alır. Kayıt başına ayrı istek atılmaz; çoklu sorguda adres satırı uzunluğu
  için kayıtlar parçalara bölünür.
- **İzin kararı `status`'a göre verilir:** yalnızca `ONAY` izin demektir. `RET`, `null` ya da kayıt
  bulunamadı (`errorCode` `81`) ticari ileti için izin yok demektir.
- **`consentDate` iznin alındığı andır,** isteğin gönderildiği an değil.
- **Kaynak (`source`) iznin gerçekte alındığı yöntemi gösterir** (`HS_WEB`, `HS_FIZIKSEL_ORTAM` vb.);
  ispat yükümlülüğü hizmet sağlayıcıdadır. Değerler: [consents.md](references/consents.md).

## Soruya göre nereye bakılır

- İlk kurulum, ön koşullar (NetİYS kaydı, İYS kodu, marka kodu, İYS kredisi, alt kullanıcı yetkisi),
  token, istek biçimi, `X-Request-Id` → [getting-started.md](references/getting-started.md).
- İzin kaydetme ve sorgulama, alanlar, enum değerleri, `erroritem`, çoklu sorgu →
  [consents.md](references/consents.md).
- İzin sonuçlarının bildirileceği adres → [webhook.md](references/webhook.md).
- Herhangi bir `errorCode`, `401`/`403`/`424`/`429`/`503`, tekrar deneme → [errors.md](references/errors.md).
- SMS gönderimiyle birlikte kullanım, `iysFilter`, `brandCode`, `REJECTED_IYS` → [with-sms.md](references/with-sms.md).
- Entegrasyon kodu → [examples/typescript.md](references/examples/typescript.md) (istemci:
  [iys-client.ts](references/examples/iys-client.ts)), [examples/curl.md](references/examples/curl.md).
- Orada olmayan bir sözleşme ayrıntısı → [openapi.yaml](references/openapi.yaml).

## Referans haritası

| Dosya | İçerik |
|---|---|
| [references/getting-started.md](references/getting-started.md) | Ön koşullar, NetİYS kaydı, marka kodu, API alt kullanıcısı, token (`scope: "sms"`), istek biçimi, zarf, `X-Request-Id` / `X-Thread-Id`, canlıya geçiş kontrol listesi |
| [references/consents.md](references/consents.md) | `POST /consents` ve `GET /consents`: alanlar, enum değerleri, tekil ve çoklu sorgu, `erroritem`, örnekler |
| [references/webhook.md](references/webhook.md) | `POST /webhooks`: kayıt ve güncelleme, alıcı adresin tasarımı, sözleşmede tanımlı olmayanlar |
| [references/errors.md](references/errors.md) | Bütün `errorCode` değerleri, anlamları, yapılacaklar ve tekrar kuralı |
| [references/with-sms.md](references/with-sms.md) | SMS API v3 ile birlikte kullanım: `iysFilter`, başlık marka kodu, izin kaydı ve filtre akışı |
| [references/examples/typescript.md](references/examples/typescript.md) | TypeScript istemcisinin kullanımı ve test ikiziyle test |
| [references/examples/iys-client.ts](references/examples/iys-client.ts) | Bağımlılıksız TypeScript istemcisi: token önbelleği, 401, `erroritem`, uç noktaya göre tekrar kuralı |
| [references/examples/curl.md](references/examples/curl.md) | bash + curl + jq ile salt okunur sorgu ve kayıt istekleri |
| [references/openapi.yaml](references/openapi.yaml) | İYS API v1 sözleşmesi (tek doğruluk kaynağı) |

## Resmî doküman sayfaları

| Konu | Sayfa |
|---|---|
| İYS API ana sayfası | https://api-docs.netgsm.com.tr/iys/ · https://api-docs.netgsm.com.tr/iys/netgsm-iys-api/ |
| İzinler bölümü | https://api-docs.netgsm.com.tr/iys/izinler/ |
| `POST /consents` (izin kaydetme) | https://api-docs.netgsm.com.tr/iys/save-consents/ |
| `GET /consents` (izin sorgulama) | https://api-docs.netgsm.com.tr/iys/search-consents/ |
| `POST /webhooks` | https://api-docs.netgsm.com.tr/iys/save-webhook/ · bölüm: https://api-docs.netgsm.com.tr/iys/webhook/ |
| Identity: token alma · yenileme | https://api-docs.netgsm.com.tr/auth/token/ · https://api-docs.netgsm.com.tr/auth/refresh-token/ |
| SMS gönderimi ve `iysFilter` | https://api-docs.netgsm.com.tr/send-sms/ · başlıklar: https://api-docs.netgsm.com.tr/list-senders/ |

## Bilgi Bankası sayfaları

| Konu | Sayfa |
|---|---|
| İYS nedir | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/ileti-yoenetim-sistemi-iys-nedir |
| İzin yöntemleri ve kaynaklar | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/iys-izin-yontemleri |
| NetİYS kaydı, İYS kodu, marka | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/net-iys-kayit-net-iys-kullanicisi-olmak |
| NetİYS hizmetleri (API, webhook) | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/net-iys-hizmetleri |
| NetİYS sıkça sorulan sorular | https://bilgibankasi.netgsm.com.tr/ileti-yonetim-sistemi/sikca-sorulan-sorular-netiys |
| API entegrasyonu hazırlığı (alt kullanıcı, yetkiler, IP, marka kodu, İYS kredisi) | https://bilgibankasi.netgsm.com.tr/entegrasyonlar/api-entegrasyonu-hazirlik-rehberi |
| API alt kullanıcısı oluşturma | https://bilgibankasi.netgsm.com.tr/abonelik-islemleri/diger-islemler/alt-kullanici-olusturma |
| Genel | https://bilgibankasi.netgsm.com.tr/ |

## Destek

Önce resmî doküman ve Bilgi Bankası (yukarıda); yanıt orada yoksa:

| Kanal | Bilgi | Ne zaman |
|---|---|---|
| Çağrı merkezi | `+90 850 303 0 303` · `+90 312 911 0 911` | İYS hizmeti aktivasyonu, `403`'ler, acil durumlar |
| Teknik destek | `teknikdestek@netgsm.com.tr` | API hataları, `X-Thread-Id` ile bildirimler, belirsiz kayıtlar (`424` / `500`) |
| Abonelik işlemleri | `abone.islemleri@netgsm.com.tr` | NetİYS kaydı, alt kullanıcı ve hesap işlemleri |

Destek talebine `X-Thread-Id`, varsa `data.uid`, isteğin zamanı, uç nokta ve hata yanıtının gövdesi
eklenir. Şifre ve token paylaşılmaz; alıcı listesi gerekmedikçe paylaşılmaz.

Resmî doküman (birincil kaynak): https://api-docs.netgsm.com.tr/iys/ · Bilgi Bankası:
https://bilgibankasi.netgsm.com.tr/ · Portal: https://portal.netgsm.com.tr
