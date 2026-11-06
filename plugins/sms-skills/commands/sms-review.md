---
description: Koddaki Netgsm SMS API entegrasyonunu skill kurallarına göre inceler ve bulguları önem sırasıyla raporlar
argument-hint: [yol]
---

Netgsm SMS API entegrasyon kodunu incele. İncelenecek yol: `$ARGUMENTS` (verilmediyse projenin tamamı).

## Hazırlık

1. `netgsm-sms` skill'inin şu dosyalarını oku: `references/errors.md`, `references/limits-and-batching.md`, `references/auth.md`. Kodda rapor webhook alıcısı varsa `references/endpoints/webhooks.md`, bakiye sorgusu varsa `references/endpoints/balance.md` dosyasını da oku. Kuralları buradan al, tahmin yürütme.
2. Verilen yolda Netgsm entegrasyon kodunu incele. Yol verilmediyse projenin tamamını okuma; hedefli aramalarla (grep) entegrasyon kodunu bul: `ext-api.netgsm.com.tr`, `/sms/v3`, `/auth/v3`, `NETGSM_` ve `netgsm` geçen kaynak, yapılandırma ve `.env*` dosyaları. Yalnızca eşleşen dosyaları oku. **Hiç Netgsm entegrasyon kodu bulamazsan bunu açıkça söyle ve dur**; bulgu uydurma.

## Kontrol listesi

Bulunan her dosya için şunlara bak:

- **Alıcı başına tek `/send`:** Döngü içinde tek alıcılı `POST /send`. Doğrusu: tek istekte çok kayıt (bir istek 1.000.000 kayda kadar; `/send` limiti istek sayısıdır). `/send/template` istek başına en fazla 20 kayıt alır.
- **Elle yazılmış gönderim kuyruğu / hız sınırlayıcı:** `/send` çevresinde alıcıları kendi kuyruğunda bekletip saniyede N istek gönderen bir yapı (kuyruk tablosu, worker, token bucket, `p-limit`/`bottleneck` gibi sınırlayıcılar, istekler arası sabit `sleep`). Döngü olmasa da bu, alıcı başına istek kalıbının aynısıdır. Doğrusu: `202` görevin Netgsm tarafında kuyruğa alındığını gösterir; alıcılar tek `/send` isteğinde toplanır, sınıra takılınca `429` ve `Retry-After`'a göre davranılır (bkz. `limits-and-batching.md` "Kendi kuyruğunu yazma").
- **Token önbelleği yok:** Her gönderimde `POST /auth/v3/token`. Doğrusu: token `expires_in` dolmadan `/token/refresh` ile yenilenir ve saklanır (token limiti IP başına dakikada 30).
- **Paylaşılan refresh token:** Aynı refresh token birden fazla süreçte (pod, worker, cron) koordinasyonsuz kullanılıyor (örneğin token'lar ortak bir önbellekte ya da dosyada tutulup her süreç kendi başına `/token/refresh` çağırıyor). Bir süreç yenilediğinde aynı oturumu kullanan diğer süreçlerin access token'ı geçersiz olur. Doğrusu: her süreç kendi oturumunu tutar (her `/token` çağrısı ayrı oturum açar) ya da yenileme tek bir yerde, kilitle yapılır (bkz. `auth.md` "Oturum modeli").
- **Ana hesap ve alt kullanıcı birlikte (uyarı):** Aynı hesapta API için hem ana hesap hem alt kullanıcı kimliği kullanılıyor (örneğin farklı servislerde farklı şifreler). Sırayla giriş yaptıklarında birbirlerinin önceki oturumları düşebilir (`401 invalid_token`). Doğrusu: hesap başına API için tek kimlik, tercihen API alt kullanıcısı. Ana hesapla API kullanımı tek başına hata değildir; yalnızca ikisinin birlikte kullanılması uyarıdır.
- **401 işleme:** `401 UNAUTHENTICATED` / `invalid_token` alınınca bir kez yeniden giriş yapıp isteği bir kez tekrarlamak; sonsuz döngü ya da hiç işlememek.
- **429 ve `Retry-After`:** `Retry-After` başlığını yok saymak ya da sabit bekleme. Başlık yoksa gönderim askıdadır: tekrar denenmez, destek ekibine yönlendirilir.
- **Toplu gönderimde 5xx sonrası otomatik tekrar:** `/send` ve `/send/template`'te `503`, `/directory/send`'de `503` ve `504 QUEUE_UNCONFIRMED`, bu üç uçta `500` körlemesine (`GET /report` kontrolü olmadan) tekrar denenmemeli: `/send`'de `503` sonrası görev çoğunlukla kuyruğa alınmamıştır ama bu kesin değildir, istekler tekilleştirilmez ve çift gönderim olur. Doğrusu: önce `GET /report` ile istekteki alıcıları kontrol etmek (bkz. `errors.md` "`503` ve `504` sonrası kontrol").
- **OTP ve iptalde 5xx:** `/send/otp`'de `503` artan beklemeyle tekrar denenmeli (hiçbir şey gönderilmemiştir); `500`'de otomatik tekrar iki farklı şifre riskidir. `/cancel`'da `503`/`504`/`500` sonrası tekrar her zaman güvenlidir. Okuma uçlarında `503` tekrar denenmeli; hiç denememek de bulgudur.
- **Eski ya da yanlış yol / başlık (uyarı):** Rehber gönderimi eski `/send/directory` yolunu kullanıyor (doğrusu `POST /sms/v3/directory/send`); `/send/otp`'de `x-client` başlığı hesabın kurumsal OTP hizmetiyle uyuşmuyor (yalnızca kurumsal OTP hesabı `enterprise` gönderir; uyuşmazlık `403`).
- **400, 403, 413, 422:** Tekrar denenmemeli; aynı istek aynı sonucu verir.
- **`rejectedItems`:** 202 yanıtında `rejectedItems` işlenmiyor (kısmi başarı normaldir); `rejectedItemsTruncated` da gözetilmeli.
- **Hata mantığı:** HTTP durum kodu yerine `code` alanına göre kurulmalı (aynı 422 farklı kodlarla gelir; `/directory/send`'de 403 `FORBIDDEN` ya da `E_SIGNATURE_REQUIRED` olabilir).
- **`requestId` loglama:** Hata loglarında SMS API `requestId` / Identity `request_id` ve gönderimlerde `jobId` yok. Ayrıca şifre, access token ve refresh token loglanıyorsa bu da bulgudur.
- **Kimlik bilgileri:** Kullanıcı adı/şifre koda gömülü ya da repoda; ortam değişkeninden okunmalı. **İstemci tarafı sızıntı:** kimlik bilgisinin tarayıcıya giden kodda ya da `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` gibi istemciye açılan ortam değişkenlerinde olması (en yüksek önem). Doğrusu: yalnızca sunucuda, önek (prefix) içermeyen değişken.
- **Polling:** `GET /report` ya da `/stats` için sık aralıklı polling (görev başına dakikada bir, istatistik 10 dakikada bir sınırı). Doğrusu: `POST /webhooks/report` ile rapor webhook'u.
- **Rapor webhook'unu adla okumak:** Webhook alıcısı `status`'u `"DELIVERED"` gibi bir adla karşılaştırıyor, `failReason` alanını okuyor ya da `operator`'ı metin sanıyor. Webhook gövdesinde `status`, `operator` ve `errorCode` **sayıdır** (`1` iletildi, `2` iletilmedi ve nedeni `errorCode`'da, `3`–`22` kendi nedeniyle iletilmedi), `failReason` yoktur ve `referansID` `null` olabilir; böyle bir kod hiçbir raporu iletildi saymaz. Doğrusu: kodları `endpoints/webhooks.md`'deki tablolarla `GET /report` adlarına çevirmek; `errorCode`'u yalnızca `status` `2` iken okumak.
- **Bakiye sorgusu:** `GET /sms/v3/balance` her gönderimden önce ya da döngüde çağrılıyor, `429`'da `Retry-After` beklenmeden tekrar deneniyor, kayıtlar `balance_name` yerine listedeki konumla okunuyor ya da `Kredi Bakiye` (`"92,150"`) virgül dikkate alınmadan sayıya çevriliyor. Eski kredi sorgusu (`POST .../balance`, kullanıcı adı ve şifre gövdede) kullanılıyorsa yeni uca geçilmeli. Doğrusu: büyük kampanyadan önce bir kez `GET /sms/v3/balance`, `balance_name` ile eşleştirme ve güvenli ayrıştırma (bkz. `endpoints/balance.md`).
- **Tür hatası beklentisi:** Kod listede olmayan `encoding` (`turkish`) ya da saat dilimsiz tarih için `request body could not be read as json` bekliyor. Bu değerler `400` `1 field(s) rejected` ve tek `violations` kaydıyla döner; ayrıştırma `violations`'a göre yapılmalı.
- **Sorgu limitleri:** Görev bazlı sorgu sınırlarına (report görev başına dakikada bir, stats 10 dakikada bir) uyulmuyor.

## Çıktı biçimi

Bulguları **önem sırasıyla** (en kritik önce) listele. Her bulgu şu biçimde olsun:

`dosya:satır — sorun → neden önemli → düzeltme`

Düzeltme kısmında kısa, çalışır bir kod parçası ver. Skill'in `references/examples/` altındaki örnekleriyle (özellikle `typescript.md` ve `netgsm-client.ts`) uyumlu kal. Satır numaralarını dosyayı okuyarak doğrula, tahmin etme. Bulgu yoksa bunu açıkça söyle.

## Kurallar

- **Kodu kullanıcıdan onay almadan değiştirme.** Önce raporu sun, sonra hangi düzeltmelerin uygulanmasını istediğini sor.
- Canlı API'ye (`ext-api.netgsm.com.tr`) istek atma. Düzeltmeleri denemek için `/sms-mock` ile yerel mock'u öner.
- Dokümanda olmayan bir davranış hakkında tahmin yürütme; "bu dokümanda yok" de ve `teknikdestek@netgsm.com.tr` adresine yönlendir.
