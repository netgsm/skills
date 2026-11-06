---
description: Netgsm SMS API yerel mock sunucusunu arka planda başlatır (abonelik ve gerçek SMS gerekmez)
argument-hint: [port]
allowed-tools: Bash
---

Netgsm SMS API mock sunucusunu başlat. Port: `$1` verilmediyse `4010`. Mock, `netgsm-sms` skill'iyle gelir, Node ≥ 20 yeterlidir ve `npm install` gerekmez. Ayrıntılar için skill'in `references/testing.md` dosyasına bak.

1. `<port>` yerine kullanıcının verdiği portu (verilmediyse `4010`) yazarak şu komutu **arka planda** çalıştır (Bash aracında `run_in_background: true`; Windows, macOS ve Linux'ta aynı komut çalışır):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/netgsm-sms/scripts/netgsm-sms-mock.mjs" --port <port>
   ```

2. Başladığını doğrulamak için arka plan çıktısını oku. Açılış çıktısında base URL'ler ve test hesapları yazılıdır.
3. Kullanıcıya şunları ilet: açılış çıktısındaki **base URL'ler** (`http://127.0.0.1:<port>/auth/v3` ve `http://127.0.0.1:<port>/sms/v3`) ve **test hesapları** (örneğin `8500000000` / `password001` / gönderici `MOCKTEST`), banner'da yazdığı hâliyle. Hesap listesini kendin uydurma.
4. Projedeki Netgsm base URL'sinin koda gömülü olmaması gerektiğini söyle ve bir ortam değişkeniyle değiştirmeyi öner (örneğin `NETGSM_BASE_URL=http://127.0.0.1:<port>`). Sonraki adım olarak SMS göndermeyen Netgsm sandbox'ı (`https://ext-sandbox.netgsm.com.tr`, başlık `TESTHEADER`; bkz. skill'in `references/sandbox.md`) kullanılabilir. Canlıya geçerken yalnızca base URL (`https://ext-api.netgsm.com.tr`), kimlik bilgileri ve başlık değişir. Canlı API'de gönderim uçları gerçek, ücretli SMS gönderir; canlıya istek atmadan önce kullanıcıdan açık onay al.
5. Port kullanımdaysa (`EADDRINUSE` ya da benzeri bir hata) başka bir portla (`<port>+1`) bir kez daha dene ya da kullanıcıya durumu bildir. Hangi portta çalıştığını açıkça söyle.
6. Durdurmak için: arka plan görevini sonlandır (Claude Code'da `/tasks` ile görevi seçip durdur). Elle çalıştırıldıysa terminalde `Ctrl+C`.

Mock'a yapılan isteklerdeki yanlış kalıpları görmek için `GET http://127.0.0.1:<port>/__mock/advice` adresine bakılabilir.
