# curl örneği (bash)

Tek seferlik denemeler için [testing.md](../testing.md) ve uç nokta dosyalarındaki curl satırları
yeterlidir. Bu sayfa, cron işi ya da operasyon betiği olarak çalışabilecek tam akışı gösterir: token
önbelleği → tek `/send` → `rejectedItems` → hata dalları (401 / 429 / 5xx).

Gerekenler: `bash`, `curl` (7.55+), `jq`. Kimlik bilgileri ortam değişkenlerinden okunur (`export` edilmiş
olmalı). `NETGSM_BASE_URL` verilmezse betik mock'a gider.

Şifre ve Bearer token `ps` çıktısında görünmesin diye süreç argümanlarına konmaz: şifre `jq`'ya `env` ile
verilir ve gövde `curl`'e stdin'den gider; token ise yalnızca sahibinin okuyabildiği geçici bir
başlık dosyasına yazılıp `-H @dosya` ile verilir (`printf` kabuğun yerleşik komutudur, süreç oluşturmaz).

```bash
#!/usr/bin/env bash
# Kullanım: NETGSM_USERNAME=8500000000 NETGSM_PASSWORD=password001 NETGSM_SENDER=MOCKTEST \
#           ./netgsm-send.sh recipients.txt "Mesaj metni"     # recipients.txt: satır başına 905xxxxxxxxx
set -euo pipefail
: "${NETGSM_USERNAME:?}" "${NETGSM_PASSWORD:?}" "${NETGSM_SENDER:?}"
BASE=${NETGSM_BASE_URL:-'http://127.0.0.1:4010'}   # canlı: https://ext-api.netgsm.com.tr (gerçek, ücretli SMS)
# Token çalıştırmalar arasında saklanır. Önbellek kullanıcı adı + base URL'ye göre ayrılır: mock ve canlı
# ya da iki hesap aynı dosyayı paylaşmaz.
KEY=$(printf '%s|%s' "$NETGSM_USERNAME" "$BASE" | cksum | cut -d' ' -f1)
CACHE="${NETGSM_TOKEN_CACHE:-$HOME/.cache/netgsm-token-$KEY.json}"
RECIPIENTS="$1"; TEXT="$2"
umask 077; mkdir -p "$(dirname "$CACHE")"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# POST + JSON gövde stdin'den, token başlık dosyasından (ikisi de komut satırında görünmez).
# Yanıt $TMP/resp.json, başlıklar $TMP/headers.txt.
post() {  # $1 = yol, $2 = Bearer token (boş olabilir); stdout'a HTTP durum kodu yazar
  local auth=()
  if [ -n "${2:-}" ]; then
    printf 'Authorization: Bearer %s\n' "$2" > "$TMP/auth.hdr"; auth=(-H "@$TMP/auth.hdr")
  fi
  curl -s -o "$TMP/resp.json" -D "$TMP/headers.txt" -w '%{http_code}' -X POST "$BASE$1" ${auth[@]+"${auth[@]}"} \
    -H 'Content-Type: application/json' -H 'Accept: application/json' --data-binary @-
}

store_token() {  # başarılı token yanıtını önbelleğe yazar; yenileme payı min(300 sn, ömrün %10'u)
  jq --argjson now "$(date +%s)" '{access_token, refresh_token, expires_at: ($now + .expires_in),
      refresh_at: ($now + .expires_in - ([300, .expires_in / 10] | min) | floor)}' "$TMP/resp.json" > "$CACHE"
}

# Aynı önbelleği kullanan çakışan çalıştırmalar (ör. üst üste binen cron işleri) token'ı aynı anda
# yenilemesin: aynı refresh token koordinasyonsuz kullanılmaz. flock yoksa (ör. macOS) mkdir kilidi.
with_lock() {
  if command -v flock >/dev/null 2>&1; then
    ( flock -w 60 9 || { echo "token kilidi alınamadı" >&2; exit 1; }; "$@" ) 9>"$CACHE.lock"
  else
    local i=0 rc=0
    until mkdir "$CACHE.lock.d" 2>/dev/null; do
      i=$((i + 1)); [ "$i" -lt 600 ] || { echo "token kilidi alınamadı ($CACHE.lock.d)" >&2; return 1; }
      sleep 0.1
    done
    "$@" || rc=$?
    rmdir "$CACHE.lock.d"; return "$rc"
  fi
}

token() {
  local now; now=$(date +%s)
  if [ -s "$CACHE" ] && [ "$now" -lt "$(jq -r .refresh_at "$CACHE")" ]; then jq -r .access_token "$CACHE"; return; fi
  with_lock renew
}

renew() {  # kilit altında çalışır; başka bir çalıştırma az önce yenilediyse onun token'ını kullanır
  local now; now=$(date +%s)
  if [ -s "$CACHE" ]; then
    [ "$now" -lt "$(jq -r .refresh_at "$CACHE")" ] && { jq -r .access_token "$CACHE"; return; }
    if [ "$(jq -c '{refresh_token}' "$CACHE" | post /auth/v3/token/refresh)" = 200 ]; then
      store_token; jq -r .access_token "$CACHE"; return
    fi
    # Geçici refresh hatasında eski token hâlâ geçerliyse onunla devam edilir.
    [ "$now" -lt "$(jq -r .expires_at "$CACHE")" ] && { jq -r .access_token "$CACHE"; return; }
  fi
  local status
  status=$(jq -n '{username: env.NETGSM_USERNAME, password: env.NETGSM_PASSWORD, scope: "sms"}' |
    post /auth/v3/token)
  if [ "$status" != 200 ]; then
    echo "token hatası: $status $(jq -r '"\(.code) request_id=\(.request_id)"' "$TMP/resp.json")" >&2; return 1
  fi
  store_token; jq -r .access_token "$CACHE"
}

# Bütün alıcılar tek istekte. Alıcı başına istek atılmaz.
jq -R -s --arg s "$NETGSM_SENDER" --arg t "$TEXT" \
  '{sender: $s, encoding: "TURKISH", messages: [split("\n")[] | select(length > 0) | {recipient: ., text: $t}]}' \
  "$RECIPIENTS" > "$TMP/body.json"

relogged=0; rate_retried=0
while :; do
  TOKEN=$(token)
  STATUS=$(post /sms/v3/send "$TOKEN" < "$TMP/body.json")
  CODE=$(jq -r '.code // empty' "$TMP/resp.json" 2>/dev/null || true)
  RID=$(jq -r '.requestId // empty' "$TMP/resp.json" 2>/dev/null || true)
  case "$STATUS" in
    202)
      jq -r '"jobId=\(.jobId) status=\(.status) accepted=\(.accepted) rejected=\(.rejected)"' "$TMP/resp.json"
      jq -r '.rejectedItems[] | "red: index=\(.index) recipient=\(.recipient) reason=\(.reason)"' "$TMP/resp.json" >&2
      exit 0 ;;
    401)  # token geçersiz: bir kez yeniden giriş, bir kez tekrar
      if [ "$relogged" = 0 ]; then relogged=1; rm -f "$CACHE"; continue; fi ;;
    429)
      RA=$(awk -F': *' 'tolower($1) == "retry-after" { gsub(/\r/, "", $2); print $2 }' "$TMP/headers.txt")
      if [ -z "$RA" ]; then
        echo "gönderim askıya alınmış (Retry-After yok): tekrar denenmez, destek ekibine başvurun. requestId=$RID" >&2; exit 2
      fi
      case "$RA" in *[!0-9]*) echo "okunamayan Retry-After ($RA): daha sonra tekrar deneyin. requestId=$RID" >&2; exit 1 ;; esac
      if [ "$rate_retried" = 0 ] && [ "$RA" -le 60 ]; then rate_retried=1; sleep "$RA"; continue; fi ;;
    5??)  # 503 dahil her 5xx: /send'de görev kuyruğa alınmış olabilir (503'te çoğunlukla alınmamıştır, kesin değil), TEKRAR YOK
      echo "$STATUS $CODE: gönderilmiş olabilir. Tekrar göndermeyin; GET /sms/v3/report ile kontrol edin. requestId=$RID" >&2
      exit 3 ;;
  esac
  # 400 / 403 / 413 / 422 ve tükenen tekrarlar: aynı istek aynı sonucu verir.
  echo "hata: $STATUS $CODE $(jq -r '.message // empty' "$TMP/resp.json" 2>/dev/null || true) requestId=$RID" >&2
  jq -r '.rejectedItems[]? | "red: index=\(.index) recipient=\(.recipient) reason=\(.reason)"' "$TMP/resp.json" >&2 2>/dev/null || true
  exit 1
done
```

Notlar:

- Token dosyası (`~/.cache/netgsm-token-<anahtar>.json`; anahtar kullanıcı adı ve base URL'den üretilir)
  yalnızca sizin okuyabileceğiniz izinlerle (`umask 077`) yazılır ve betik her çalıştığında yeniden
  kullanılır. Her çalıştırmada token almak `/token` sınırına (IP başına dakikada 30) takılır.
- Yenileme ve giriş bir kilit altında yapılır (`flock`, yoksa `mkdir` kilidi): üst üste binen cron
  çalıştırmaları aynı refresh token'ı aynı anda kullanmaz (bkz. [auth.md](../auth.md#oturum-modeli)).
  `mkdir` kilidi, betik `kill -9` ile öldürülürse `$CACHE.lock.d` dizini olarak kalır; elle silin.
  Kilidi paylaşamayan ortamlarda (ör. farklı makineler) her işe ayrı önbellek dosyası verin
  (`NETGSM_TOKEN_CACHE`).
- Çıkış kodları: `0` kabul edildi, `1` düzeltilmesi gereken hata, `2` gönderim askıya alınmış, `3` sonuç
  belirsiz (`503` / `500` gibi 5xx). `3`'te betiği otomatik yeniden çalıştırmayın: çift gönderim olur; önce
  `GET /sms/v3/report` ile istekteki alıcıları kontrol edin ([errors.md](../errors.md#503-ve-504-sonrası-kontrol)).
- `curl`'ün zaman aşımı ya da bağlantı hatası (`set -e` betiği durdurur) gönderimde belirsiz bir 5xx gibidir;
  istek ulaşmış olabilir.
- Mock'ta denemek: mock'u başlatın, `printf '905061234567\n905061234568\n' > recipients.txt`, betiği
  çalıştırın, sonra `curl -s http://127.0.0.1:4010/__mock/advice`. Hata dalları için
  `POST /__mock/scenario` örnekleri: [testing.md](../testing.md).

## Bakiye (`GET /sms/v3/balance`)

Kampanya betiğinden önce bir kez çalıştırılacak bakiye kontrolü
([balance.md](../endpoints/balance.md), https://api-docs.netgsm.com.tr/get-balance/). Yukarıdaki betiğin
`token` fonksiyonunu ve değişkenlerini kullanır. Döngüde ya da her gönderimden önce çalıştırmayın (hesap
başına dakikada 60 istek; yanıt 10 sn önbellekte).

```bash
printf 'Authorization: Bearer %s\n' "$(token)" > "$TMP/auth.hdr"   # token komut satırında görünmesin
STATUS=$(curl -s -o "$TMP/bal.json" -D "$TMP/headers.txt" -w '%{http_code}' \
  -H "@$TMP/auth.hdr" -H 'Accept: application/json' "$BASE/sms/v3/balance?stip=3")
case "$STATUS" in
  200)
    # Varlıklar sıraya göre değil adıyla (büyük/küçük harfe duyarsız) bulunur. amount metin ya da sayı olabilir;
    # kredi "92,150" = 92,15 TL.
    SMS=$(jq -r '[.balance[] | select(.balance_name | ascii_downcase == "adet sms") | .amount | tostring][0] // "0"' "$TMP/bal.json")
    CREDIT=$(jq -r '[.balance[] | select(.balance_name | ascii_downcase == "kredi bakiye") | .amount | tostring | sub(","; ".")][0] // "0"' "$TMP/bal.json")
    echo "kalan SMS=$SMS kredi=$CREDIT TL" ;;
  429)  # tekrar denenmez: Retry-After saniye sonra yeniden planlayın
    RA=$(awk -F': *' 'tolower($1) == "retry-after" { gsub(/\r/, "", $2); print $2 }' "$TMP/headers.txt")
    echo "bakiye sorgu sınırı: ${RA:-?} sn sonra deneyin" >&2; exit 1 ;;
  *)
    echo "bakiye hatası: $STATUS $(jq -r '"\(.code) requestId=\(.requestId)"' "$TMP/bal.json" 2>/dev/null || true)" >&2; exit 1 ;;
esac
```
