# Python örneği

Python ≥ 3.9 ve `requests` (`pip install requests`). Akış: token önbelleği → tek `/send` →
`rejectedItems` → hata dalları (401 / 429 / 5xx). Yalnızca sunucu tarafında çalışır;
kimlik bilgileri ortam değişkenlerinden okunur. `NETGSM_BASE_URL` verilmezse mock'a gider.

İstemciyi süreç başına bir kez oluşturun (modül düzeyinde ya da uygulama başlarken). Django/Flask'ta her
istekte yeni `NetgsmClient` oluşturmak her istekte yeni token demektir.

```python
"""Netgsm SMS API v3: token -> send -> rejectedItems -> 401/429/5xx."""
import logging
import os
import re
import threading
import time

import requests

log = logging.getLogger("netgsm")


class NetgsmApiError(Exception):
    def __init__(self, status, code, request_id, retryable, may_have_been_queued=False, rejected_items=None,
                 retry_after_sec=None):
        super().__init__(f"Netgsm {status} {code} (requestId {request_id or '-'})")
        self.status = status
        self.retry_after_sec = retry_after_sec  # 429'da Retry-After (sn)
        self.code = code                  # mantık buna göre kurulur (REJECTED_HEADER, ...)
        self.request_id = request_id      # loglayın; destek talebinde paylaşın
        self.retryable = retryable
        self.may_have_been_queued = may_have_been_queued
        self.rejected_items = rejected_items or []


def _json(r):
    try:
        return r.json()
    except ValueError:
        return {}


class NetgsmClient:
    def __init__(self, username, password, base_url="http://127.0.0.1:4010", max_retry_after_sec=60):
        self._username, self._password = username, password
        self._base = base_url.rstrip("/")  # canlı: https://ext-api.netgsm.com.tr
        self._max_retry_after = max_retry_after_sec
        self._http = requests.Session()
        self._http.headers["Accept"] = "application/json"
        self._lock = threading.Lock()      # aynı anda tek token isteği
        self._token = None

    def _get_token(self):
        with self._lock:
            t, now = self._token, time.monotonic()
            if t and now < t["expires_at"] and (now < t["refresh_at"] or now < t["retry_refresh_at"]):
                return t["access"]
            if t:
                r = self._http.post(f"{self._base}/auth/v3/token/refresh", json={"refresh_token": t["refresh"]}, timeout=30)
                if r.status_code == 200:
                    return self._store(r.json())
                if _json(r).get("code") != "invalid_refresh_token" and now < t["expires_at"]:
                    t["retry_refresh_at"] = now + 30  # geçici hata: eski token 30 sn daha
                    return t["access"]
            r = self._http.post(f"{self._base}/auth/v3/token", timeout=30,
                                json={"username": self._username, "password": self._password, "scope": "sms"})
            if r.status_code != 200:
                p = _json(r)
                code = p.get("code", f"HTTP_{r.status_code}")
                raise NetgsmApiError(r.status_code, code, p.get("request_id"), r.status_code >= 500 or code == "rate_limited")
            return self._store(r.json())

    def _store(self, j):
        now, life = time.monotonic(), j["expires_in"]
        self._token = {"access": j["access_token"], "refresh": j["refresh_token"], "expires_at": now + life,
                       "refresh_at": now + life - min(300, life / 10), "retry_refresh_at": 0}
        return j["access_token"]

    def _invalidate(self, stale):
        with self._lock:  # başka bir thread token'ı zaten yenilediyse yenisi silinmez
            if self._token and self._token["access"] == stale:
                self._token = None

    def send(self, body):
        """POST /sms/v3/send. Bütün alıcılar tek istekte; dönen rejectedItems işlenir."""
        relogged = rate_retried = False
        while True:
            token = self._get_token()
            # Zaman aşımı (requests.Timeout) gönderimde belirsiz bir 5xx gibidir: istek ulaşmış olabilir, otomatik tekrar etmeyin.
            r = self._http.post(f"{self._base}/sms/v3/send", json=body, timeout=60,
                                headers={"Authorization": f"Bearer {token}"})
            if r.status_code == 202:
                return r.json()
            p = _json(r)
            code, rid = p.get("code", f"HTTP_{r.status_code}"), p.get("requestId")
            raw_retry_after = r.headers.get("Retry-After")
            retry_after = int(raw_retry_after) if raw_retry_after and raw_retry_after.strip().isdigit() else None
            if r.status_code == 401 and not relogged:  # bir kez yeniden giriş, bir kez tekrar
                relogged = True
                self._invalidate(token)
                continue
            if r.status_code == 429:
                if raw_retry_after is None:  # gönderim askıya alınmış: beklemek işe yaramaz
                    raise NetgsmApiError(429, code, rid, False)
                # Okunamayan Retry-After (HTTP tarihi vb.): hemen tekrar denenmez, daha sonra denenir.
                if retry_after is None or rate_retried or retry_after > self._max_retry_after:
                    raise NetgsmApiError(429, code, rid, True)
                rate_retried = True
                time.sleep(retry_after)
                continue
            if r.status_code >= 500:  # 503 dahil: /send'de görev kuyruğa alınmış olabilir, TEKRAR YOK; önce GET /report
                raise NetgsmApiError(r.status_code, code, rid, False, may_have_been_queued=True)
            # 400 / 403 / 413 / 422: aynı istek aynı sonucu verir.
            raise NetgsmApiError(r.status_code, code, rid, False, rejected_items=p.get("rejectedItems"))

    def balance(self, stip=3, service=None):
        """GET /sms/v3/balance. Kampanyadan önce bir kez; döngüde ya da her mesajdan önce çağırmayın.
        429'da beklemez ve tekrar etmez: retryable=True ve retry_after_sec ile hata fırlatır."""
        params = {"stip": stip, **({"service": service} if service else {})}
        relogged = False
        while True:
            token = self._get_token()
            r = self._http.get(f"{self._base}/sms/v3/balance", params=params, timeout=30,
                               headers={"Authorization": f"Bearer {token}"})
            if r.status_code == 200:
                return r.json()
            p = _json(r)
            code, rid = p.get("code", f"HTTP_{r.status_code}"), p.get("requestId")
            if r.status_code == 401 and not relogged:
                relogged = True
                self._invalidate(token)
                continue
            ra = r.headers.get("Retry-After", "")
            raise NetgsmApiError(r.status_code, code, rid, r.status_code == 429 or r.status_code >= 500,
                                 retry_after_sec=int(ra) if ra.strip().isdigit() else None)


def parse_credit(value):
    """Kredi metnini TL sayıya çevirir: '92,150' -> 92.15, '0' -> 0.0, 277 -> 277.0. Okunamazsa None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if not isinstance(value, str) or not re.fullmatch(r"-?\d+([.,]\d+)?", value.strip()):
        return None
    return float(value.strip().replace(",", "."))


def find_balance(entries, name):
    """Varlığı adıyla bulur; liste sabit değildir, sıraya güvenilmez; ad büyük/küçük harfe duyarsız. Yoksa None."""
    want = name.strip().casefold()
    return next((parse_credit(e.get("amount")) for e in entries
                 if str(e.get("balance_name", "")).strip().casefold() == want), None)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    client = NetgsmClient(os.environ["NETGSM_USERNAME"], os.environ["NETGSM_PASSWORD"],
                          os.environ.get("NETGSM_BASE_URL", "http://127.0.0.1:4010"))
    customers = [{"phone": "905061234567", "name": "Ayşe"}, {"phone": "905061234568", "name": "Mehmet"}]
    try:
        res = client.send({
            "sender": os.environ.get("NETGSM_SENDER", "MOCKTEST"),
            "encoding": "TURKISH",
            "messages": [{"recipient": c["phone"], "text": f"Merhaba {c['name']}"} for c in customers],
        })
        log.info("sms queued jobId=%s status=%s accepted=%s rejected=%s",
                 res["jobId"], res["status"], res["accepted"], res["rejected"])
        for item in res["rejectedItems"]:
            log.warning("sms rejected jobId=%s index=%s recipient=%s reason=%s",
                        res["jobId"], item["index"], item["recipient"], item["reason"])
    except NetgsmApiError as e:
        log.error("sms failed status=%s code=%s requestId=%s", e.status, e.code, e.request_id)
        if e.may_have_been_queued:
            pass  # 503 / 500: gönderilmiş olabilir. Tekrar GÖNDERMEYİN; GET /sms/v3/report ile kontrol edin.
        elif e.retryable:
            pass  # geçici: işi daha sonra yeniden planlayın
        else:
            pass  # code'a göre düzeltin (errors.md); NO_DELIVERABLE_MESSAGES'ta e.rejected_items nedenleri taşır
```

Bakiye kontrolü ([balance.md](../endpoints/balance.md), https://api-docs.netgsm.com.tr/get-balance/).
Yanıt 10 sn önbellektedir; gönderimden hemen sonra okunan değer en fazla 10 sn eski olabilir:

```python
try:
    entries = client.balance(stip=3)["balance"]
    sms = find_balance(entries, "Adet SMS") or 0           # amount metin ya da sayı olabilir
    credit_tl = find_balance(entries, "Kredi Bakiye") or 0  # "92,150" -> 92.15
except NetgsmApiError as e:
    if e.status == 429:
        pass  # beklemeyin, döngüye girmeyin: kontrolü e.retry_after_sec sonra yeniden planlayın
    raise
```

Rapor webhook'u (Flask). Gövde sayısal kodlar taşır: `status` `1` iletildi, `2` iletilmedi ve nedeni
`errorCode`'da (yalnızca `status` `2` iken anlamlı), diğer kodlar nedeni kendisi söyler; `operator`
sayısaldır, `failReason` alanı yoktur, `referansID` `null` olabilir. Kod tabloları ve `GET /report`
karşılıkları: [webhooks.md](../endpoints/webhooks.md).

```python
from flask import Flask, abort, request

app = Flask(__name__)
STATUS_REASON = {3: "INVALID_NUMBER", 4: "NOT_SENT_TO_OPERATOR", 8: "OPERATOR_REJECTED", 11: "OPERATOR_ERROR",
                 12: "SEND_ERROR", 13: "DUPLICATE", 14: "INSUFFICIENT_CREDIT", 15: "BLACKLISTED", 16: "IYS_REJECTED",
                 17: "IYS_ERROR", 18: "MESSAGE_NOT_CREATED", 19: "INVALID_NUMBER_FORMAT", 20: "NTS_NOT_APPROVED",
                 22: "NO_INTERNATIONAL_PERMISSION"}
ERROR_REASON = {111: "TIMEOUT", 112: "SMS_DISABLED_ON_DEVICE", 113: "DEVICE_NOT_SUPPORTED", 114: "ROUTING_FAILED",
                115: "OPERATOR_TIMEOUT", 116: "UNKNOWN_SUBSCRIBER", 117: "ILLEGAL_SUBSCRIBER", 119: "SYSTEM_ERROR"}


@app.post("/netgsm/report")
def netgsm_report():
    # Kayıtta verdiğiniz başlıkla isteğin sizden geldiğini doğrulayın.
    if request.headers.get("X-Webhook-Token") != os.environ["NETGSM_WEBHOOK_TOKEN"]:
        abort(401)
    for n in (request.get_json(silent=True) or {}).get("numbers", []):
        if n["status"] == 1:
            status, reason = "DELIVERED", None
        elif n["status"] == 2:  # errorCode yalnızca burada okunur; 0 ya da null: bilinmiyor
            status, reason = "NOT_DELIVERED", ERROR_REASON.get(n.get("errorCode") or 0, "UNKNOWN")
        else:
            status, reason = "NOT_DELIVERED", STATUS_REASON.get(n["status"], "UNKNOWN")
        save_delivery(n["jobid"], n["number"], status, reason, n.get("referansID"))  # sizin kaydınız
    return "", 200  # herhangi bir 2xx teslim alındı demektir
```

Notlar:

- Celery gibi bir iş kuyruğunda `autoretry_for`'u `NetgsmApiError`'ın `may_have_been_queued` ve
  `retryable=False` durumlarında kullanmayın: istemci güvenli tekrarları zaten yapar.
- Gunicorn/uWSGI'de her worker kendi token'ını tutar; bu doğrudur (her süreç kendi oturumu, bkz.
  [auth.md](../auth.md#oturum-modeli)).
- Mock'ta denemek: mock'u başlatın, `python netgsm.py`, sonra `curl -s http://127.0.0.1:4010/__mock/advice`.
  Hata dalları için [testing.md](../testing.md).
