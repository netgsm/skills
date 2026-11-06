# curl örneği (bash)

**Kaynak (resmî doküman):** https://api-docs.netgsm.com.tr/iys/search-consents/ ·
https://api-docs.netgsm.com.tr/iys/save-consents/ · token: https://api-docs.netgsm.com.tr/auth/token/

> **Bu komutlar canlıdır.** İYS'nin sandbox'ı ve mock'u yoktur; aşağıdaki her istek gerçek hesapla
> canlı İleti Yönetim Sistemi'ne gider. Asistan bu komutları kullanıcının açık onayı olmadan
> çalıştırmaz. `POST /consents` yalnızca alıcıdan gerçekten alınmış bir izin için ve kalıcı, hukuki
> kayıt oluşturacağı bilinerek çalıştırılır.

Gerekenler: `bash`, `curl`, `jq`. Kimlik bilgileri ve marka kodu ortam değişkenlerinden okunur; şifre
komut satırına yazılmaz (gövde stdin'den gider).

## Token (önbellekli)

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${NETGSM_USERNAME:?}" "${NETGSM_PASSWORD:?}" "${NETGSM_IYS_BRAND_CODE:?}"
BASE=${NETGSM_BASE_URL:-'https://ext-api.netgsm.com.tr'}   # İYS yalnızca canlıdır
CACHE="${NETGSM_IYS_TOKEN_CACHE:-$HOME/.cache/netgsm-iys-token.json}"
umask 077; mkdir -p "$(dirname "$CACHE")"

token() {  # önbellekteki token geçerliyse onu, değilse yenisini yazar (IP başına dakikada 30 token sınırı)
  local now; now=$(date +%s)
  if [ -s "$CACHE" ] && [ "$now" -lt "$(jq -r .refresh_at "$CACHE")" ]; then jq -r .access_token "$CACHE"; return; fi
  local resp
  resp=$(jq -n --arg u "$NETGSM_USERNAME" --arg p "$NETGSM_PASSWORD" '{username: $u, password: $p, scope: "sms"}' |
    curl -s -X POST "$BASE/auth/v3/token" -H 'Content-Type: application/json' --data-binary @-)
  if ! jq -e .access_token >/dev/null <<<"$resp"; then
    echo "token hatası: $(jq -r '"\(.code) request_id=\(.request_id)"' <<<"$resp")" >&2; return 1
  fi
  jq --argjson now "$now" '{access_token, refresh_at: ($now + .expires_in - ([300, .expires_in / 10] | min) | floor)}' \
    <<<"$resp" > "$CACHE"
  jq -r .access_token "$CACHE"
}
TOKEN=$(token)
```

Bu taslak süresi yaklaşan token için yeniden giriş yapar; uzun süre çalışan servislerde refresh ve
eş zamanlılık kilidi için `netgsm-sms` skill'inin curl örneği ya da [typescript.md](typescript.md)
kullanılır.

## Salt okunur sorgu: `GET /consents`

Çoklu sorgu; `+` işareti `%2B` olarak kodlanır (`curl -G --data-urlencode` bunu yapar):

```bash
RID="iys-query-$(date +%s)"
curl -s -G "$BASE/iys/v1/consents" \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' -H "X-Request-Id: $RID" \
  -D headers.txt \
  --data-urlencode "brandCode=$NETGSM_IYS_BRAND_CODE" \
  --data-urlencode "data[0][recipient]=$IYS_RECIPIENT" \
  --data-urlencode 'data[0][recipientType]=BIREYSEL' \
  --data-urlencode 'data[0][type]=MESAJ' |
  jq -r '.data[]? | "\(.type) status=\(.status) errorCode=\(.errorCode // 0)"'
grep -i '^x-thread-id' headers.txt
```

`IYS_RECIPIENT` kendi müşteri kaydınızdaki bir numaradır (`+90XXXXXXXXXX`). Yalnızca `status=ONAY`
izin demektir; `errorCode=81` kayıt yok demektir.

## İzin kaydı: `POST /consents`

`consent.json` yalnızca gerçekten alınmış izinleri taşır (en fazla 500 kayıt):

```json
{
  "brandCode": 0,
  "permissions": [
    { "recipient": "+90XXXXXXXXXX", "recipientType": "BIREYSEL", "type": "MESAJ",
      "source": "HS_WEB", "status": "ONAY", "consentDate": "2026-02-20 16:46:00" }
  ]
}
```

```bash
RID="iys-save-$(date +%s)"
jq --argjson b "$NETGSM_IYS_BRAND_CODE" '.brandCode = $b' consent.json |
  curl -s -o resp.json -w '%{http_code}\n' -D headers.txt -X POST "$BASE/iys/v1/consents" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "X-Request-Id: $RID" \
    --data-binary @-
jq '{success, errorCode, message, uid: .data.uid, erroritem: .data.erroritem}' resp.json
grep -i '^x-thread-id' headers.txt
```

- `erroritem` doluysa o kayıtlar kaydedilmemiştir (`index` sıfırdan başlar); düzeltip yeniden gönderin.
- `424`, `500` ya da `curl` zaman aşımında aynı dosyayı **yeniden göndermeyin**: önce `GET /consents`
  ve webhook ile kontrol edin ([errors.md](../errors.md#post-consentste-belirsiz-sonuç)). `503` ve
  `429`'da biraz bekleyip yeniden gönderebilirsiniz.
- `resp.json` ve `headers.txt` kişisel veri içerebilir; işiniz bitince silin.
