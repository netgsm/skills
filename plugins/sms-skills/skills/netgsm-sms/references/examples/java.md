# Java örneği

Java ≥ 17, HTTP için JDK'nın `java.net.http.HttpClient`'ı, JSON için **Jackson** (`jackson-databind`;
Spring Boot projelerinde zaten vardır). Akış: token önbelleği → tek `/send` → `rejectedItems` → hata
dalları (401 / 429 / 5xx). Yalnızca sunucu tarafında çalışır; kimlik bilgileri ortam
değişkenlerinden okunur. `NETGSM_BASE_URL` verilmezse mock'a gider.

Spring'de `NetgsmClient`'ı tek bir bean olarak (varsayılan singleton scope) tanımlayın; istek başına yeni
örnek, istek başına yeni token demektir.

```java
// NetgsmSms.java
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

public final class NetgsmSms {
    static final ObjectMapper JSON = new ObjectMapper();

    public static final class NetgsmApiException extends RuntimeException {
        public final int status;
        public final String code;            // mantık buna göre kurulur
        public final String requestId;       // loglayın; destek talebinde paylaşın
        public final boolean retryable;
        public final boolean mayHaveBeenQueued;
        public final JsonNode rejectedItems;
        public final Long retryAfterSec;     // 429'da Retry-After (sn); yoksa null

        NetgsmApiException(int status, String code, String requestId, boolean retryable, boolean mayHaveBeenQueued, JsonNode rejectedItems) {
            this(status, code, requestId, retryable, mayHaveBeenQueued, rejectedItems, null);
        }

        NetgsmApiException(int status, String code, String requestId, boolean retryable, boolean mayHaveBeenQueued, JsonNode rejectedItems,
                           Long retryAfterSec) {
            super("Netgsm " + status + " " + code + " (requestId " + (requestId == null ? "-" : requestId) + ")");
            this.status = status; this.code = code; this.requestId = requestId;
            this.retryable = retryable; this.mayHaveBeenQueued = mayHaveBeenQueued; this.rejectedItems = rejectedItems;
            this.retryAfterSec = retryAfterSec;
        }
    }

    public static final class NetgsmClient {
        private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        private final String baseUrl, username, password;
        private final int maxRetryAfterSec = 60;
        private String access, refresh;
        private Instant expiresAt = Instant.MIN, refreshAt = Instant.MIN, retryRefreshAt = Instant.MIN;

        public NetgsmClient(String baseUrl, String username, String password) {
            this.baseUrl = baseUrl.replaceAll("/+$", ""); this.username = username; this.password = password;
        }

        /** POST /sms/v3/send. Bütün alıcılar tek istekte; dönen rejectedItems işlenir. */
        public JsonNode send(Map<String, Object> body) throws Exception {
            boolean relogged = false, rateRetried = false;
            while (true) {
                String token = token();
                // Zaman aşımı (HttpTimeoutException) gönderimde belirsiz bir 5xx gibidir: istek ulaşmış olabilir, otomatik tekrar etmeyin.
                HttpResponse<String> res = post("/sms/v3/send", body, token);
                int status = res.statusCode();
                JsonNode json = parse(res.body());
                if (status == 202) return json;
                String code = json.path("code").asText("HTTP_" + status);
                String rid = json.path("requestId").asText(null);
                Optional<String> retryAfter = res.headers().firstValue("Retry-After");

                if (status == 401 && !relogged) { relogged = true; invalidate(token); continue; } // bir kez
                if (status == 429) {
                    if (retryAfter.isEmpty()) throw new NetgsmApiException(status, code, rid, false, false, null); // askıya alınmış
                    String ra = retryAfter.get().trim();
                    long sec = ra.matches("\\d{1,6}") ? Long.parseLong(ra) : -1; // okunamayan değer (HTTP tarihi vb.): -1
                    if (sec < 0 || rateRetried || sec > maxRetryAfterSec) throw new NetgsmApiException(status, code, rid, true, false, null);
                    rateRetried = true;
                    Thread.sleep(sec * 1000);
                    continue;
                }
                if (status >= 500) throw new NetgsmApiException(status, code, rid, false, true, null); // 503 dahil: kuyruğa alınmış olabilir, TEKRAR YOK
                // 400 / 403 / 413 / 422: aynı istek aynı sonucu verir.
                throw new NetgsmApiException(status, code, rid, false, false, json.get("rejectedItems"));
            }
        }

        /**
         * GET /sms/v3/balance. Kampanyadan önce bir kez; döngüde ya da her mesajdan önce çağırmayın.
         * 429'da beklemez ve tekrar etmez: retryable ve retryAfterSec ile hata fırlatır.
         */
        public JsonNode balance(int stip, String service) throws Exception {
            String path = "/sms/v3/balance?stip=" + stip
                    + (service == null ? "" : "&service=" + java.net.URLEncoder.encode(service, java.nio.charset.StandardCharsets.UTF_8));
            boolean relogged = false;
            while (true) {
                String token = token();
                HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(baseUrl + path)).timeout(Duration.ofSeconds(30))
                        .header("Accept", "application/json").header("Authorization", "Bearer " + token).GET().build(),
                        HttpResponse.BodyHandlers.ofString());
                int status = res.statusCode();
                JsonNode json = parse(res.body());
                if (status == 200) return json;
                if (status == 401 && !relogged) { relogged = true; invalidate(token); continue; }
                String ra = res.headers().firstValue("Retry-After").orElse("").trim();
                throw new NetgsmApiException(status, json.path("code").asText("HTTP_" + status), json.path("requestId").asText(null),
                        status == 429 || status >= 500, false, null, ra.matches("\\d{1,6}") ? Long.valueOf(ra) : null);
            }
        }

        /** Kredi metnini TL sayıya çevirir: "92,150" → 92.15, "0" → 0, 277 → 277. Okunamazsa null. */
        public static java.math.BigDecimal parseCredit(JsonNode value) {
            if (value == null || value.isNull()) return null;
            String text = value.asText().trim(); // amount metin ya da sayı olabilir
            return text.matches("-?\\d+([.,]\\d+)?") ? new java.math.BigDecimal(text.replace(',', '.')) : null;
        }

        /** Varlığı adıyla bulur (liste sabit değildir, sıraya güvenilmez; ad büyük/küçük harfe duyarsız); yoksa null. */
        public static java.math.BigDecimal findBalance(JsonNode response, String name) {
            for (JsonNode e : response.path("balance")) {
                if (name.equalsIgnoreCase(e.path("balance_name").asText().trim())) return parseCredit(e.get("amount"));
            }
            return null;
        }

        /** Aynı anda tek token isteği (synchronized). */
        private synchronized String token() throws Exception {
            Instant now = Instant.now();
            if (access != null && now.isBefore(expiresAt) && (now.isBefore(refreshAt) || now.isBefore(retryRefreshAt))) return access;
            if (access != null) {
                HttpResponse<String> r = post("/auth/v3/token/refresh", Map.of("refresh_token", refresh), null);
                JsonNode j = parse(r.body());
                if (r.statusCode() == 200) return store(j);
                if (!"invalid_refresh_token".equals(j.path("code").asText()) && now.isBefore(expiresAt)) {
                    retryRefreshAt = now.plusSeconds(30); // geçici hata: eski token 30 sn daha
                    return access;
                }
            }
            HttpResponse<String> r = post("/auth/v3/token", Map.of("username", username, "password", password, "scope", "sms"), null);
            JsonNode j = parse(r.body());
            if (r.statusCode() != 200) {
                String code = j.path("code").asText("HTTP_" + r.statusCode());
                throw new NetgsmApiException(r.statusCode(), code, j.path("request_id").asText(null),
                        r.statusCode() >= 500 || code.equals("rate_limited"), false, null);
            }
            return store(j);
        }

        private String store(JsonNode j) {
            long life = j.get("expires_in").asLong();
            Instant now = Instant.now();
            access = j.get("access_token").asText();
            refresh = j.get("refresh_token").asText();
            expiresAt = now.plusSeconds(life);
            refreshAt = now.plusSeconds(life - Math.min(300, life / 10));
            retryRefreshAt = Instant.MIN;
            return access;
        }

        private synchronized void invalidate(String staleToken) {
            if (staleToken.equals(access)) access = null; // başkası yenilediyse yenisi silinmez
        }

        private HttpResponse<String> post(String path, Object body, String token) throws Exception {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + path))
                    .timeout(Duration.ofSeconds(60))
                    .header("Content-Type", "application/json").header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
            if (token != null) b.header("Authorization", "Bearer " + token);
            return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
        }

        private static JsonNode parse(String body) {
            try { return body == null || body.isEmpty() ? JSON.createObjectNode() : JSON.readTree(body); }
            catch (Exception e) { return JSON.createObjectNode(); }
        }
    }

    public static void main(String[] args) throws Exception {
        String base = Optional.ofNullable(System.getenv("NETGSM_BASE_URL")).orElse("http://127.0.0.1:4010"); // canlı: https://ext-api.netgsm.com.tr
        NetgsmClient client = new NetgsmClient(base,
                Objects.requireNonNull(System.getenv("NETGSM_USERNAME"), "NETGSM_USERNAME tanımlı değil"),
                Objects.requireNonNull(System.getenv("NETGSM_PASSWORD"), "NETGSM_PASSWORD tanımlı değil"));
        List<Map<String, String>> customers = List.of(
                Map.of("phone", "905061234567", "name", "Ayşe"), Map.of("phone", "905061234568", "name", "Mehmet"));
        try {
            JsonNode res = client.send(Map.of(
                    "sender", Optional.ofNullable(System.getenv("NETGSM_SENDER")).orElse("MOCKTEST"),
                    "encoding", "TURKISH",
                    "messages", customers.stream().map(c -> Map.of("recipient", c.get("phone"), "text", "Merhaba " + c.get("name"))).toList()));
            System.out.printf("sms queued jobId=%s status=%s accepted=%d rejected=%d%n", res.get("jobId").asText(),
                    res.get("status").asText(), res.get("accepted").asInt(), res.get("rejected").asInt());
            for (JsonNode item : res.get("rejectedItems")) {
                System.err.printf("sms rejected jobId=%s index=%d recipient=%s reason=%s%n", res.get("jobId").asText(),
                        item.get("index").asInt(), item.get("recipient").asText(), item.get("reason").asText());
            }
        } catch (NetgsmApiException e) {
            System.err.printf("sms failed status=%d code=%s requestId=%s%n", e.status, e.code, e.requestId);
            if (e.mayHaveBeenQueued) { /* 503 / 500: gönderilmiş olabilir. Tekrar GÖNDERMEYİN; GET /sms/v3/report ile kontrol edin. */ }
            else if (e.retryable) { /* geçici: işi daha sonra yeniden planlayın */ }
            else { /* code'a göre düzeltin (errors.md); NO_DELIVERABLE_MESSAGES'ta e.rejectedItems nedenleri taşır */ }
        }
    }
}
```

Bakiye kontrolü ([balance.md](../endpoints/balance.md), https://api-docs.netgsm.com.tr/get-balance/).
Yanıt 10 sn önbellektedir; gönderimden hemen sonra okunan değer en fazla 10 sn eski olabilir:

```java
try {
    JsonNode balance = client.balance(3, null);
    var sms = Optional.ofNullable(NetgsmClient.findBalance(balance, "Adet SMS")).orElse(java.math.BigDecimal.ZERO);        // amount metin ya da sayı olabilir
    var creditTl = Optional.ofNullable(NetgsmClient.findBalance(balance, "Kredi Bakiye")).orElse(java.math.BigDecimal.ZERO); // "92,150" → 92.150
} catch (NetgsmApiException e) {
    if (e.status == 429) { /* beklemeyin, döngüye girmeyin: kontrolü e.retryAfterSec saniye sonra yeniden planlayın */ }
    throw e;
}
```

Rapor webhook'u (Spring Web). Gövde sayısal kodlar taşır: `status` `1` iletildi, `2` iletilmedi ve
nedeni `errorCode`'da (yalnızca `status` `2` iken anlamlı), diğer kodlar nedeni kendisi söyler;
`operator` sayısaldır, `failReason` alanı yoktur, `referansID` `null` olabilir. Kod tabloları ve
`GET /report` karşılıkları: [webhooks.md](../endpoints/webhooks.md).

```java
@RestController
class NetgsmReportWebhook {
    static final Map<Integer, String> STATUS_REASON = Map.ofEntries(
            Map.entry(3, "INVALID_NUMBER"), Map.entry(4, "NOT_SENT_TO_OPERATOR"), Map.entry(8, "OPERATOR_REJECTED"),
            Map.entry(11, "OPERATOR_ERROR"), Map.entry(12, "SEND_ERROR"), Map.entry(13, "DUPLICATE"),
            Map.entry(14, "INSUFFICIENT_CREDIT"), Map.entry(15, "BLACKLISTED"), Map.entry(16, "IYS_REJECTED"),
            Map.entry(17, "IYS_ERROR"), Map.entry(18, "MESSAGE_NOT_CREATED"), Map.entry(19, "INVALID_NUMBER_FORMAT"),
            Map.entry(20, "NTS_NOT_APPROVED"), Map.entry(22, "NO_INTERNATIONAL_PERMISSION"));
    static final Map<Integer, String> ERROR_REASON = Map.of(
            111, "TIMEOUT", 112, "SMS_DISABLED_ON_DEVICE", 113, "DEVICE_NOT_SUPPORTED", 114, "ROUTING_FAILED",
            115, "OPERATOR_TIMEOUT", 116, "UNKNOWN_SUBSCRIBER", 117, "ILLEGAL_SUBSCRIBER", 119, "SYSTEM_ERROR");

    @PostMapping("/netgsm/report")
    ResponseEntity<Void> report(@RequestHeader(value = "X-Webhook-Token", required = false) String token, @RequestBody JsonNode body) {
        // Kayıtta verdiğiniz başlıkla isteğin sizden geldiğini doğrulayın.
        // Token tanımsız ya da boşsa istek reddedilir (fail-closed): aksi hâlde başlıksız istek de kabul edilirdi.
        String expected = System.getenv("NETGSM_WEBHOOK_TOKEN");
        if (expected == null || expected.isEmpty()) return ResponseEntity.status(500).build();
        if (token == null || !MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8)))
            return ResponseEntity.status(401).build(); // sabit zamanlı karşılaştırma
        for (JsonNode n : body.path("numbers")) {
            int status = n.path("status").asInt();
            String state = status == 1 ? "DELIVERED" : "NOT_DELIVERED";
            String reason = status == 1 ? null
                    : status == 2 ? ERROR_REASON.getOrDefault(n.path("errorCode").asInt(0), "UNKNOWN") // errorCode yalnızca status 2 iken; 0/null: bilinmiyor
                    : STATUS_REASON.getOrDefault(status, "UNKNOWN");
            String referenceId = n.path("referansID").isNull() ? null : n.path("referansID").asText(null);
            saveDelivery(n.path("jobid").asText(), n.path("number").asText(), state, reason, referenceId); // sizin kaydınız
        }
        return ResponseEntity.ok().build(); // herhangi bir 2xx teslim alındı demektir
    }
}
```

Notlar:

- Maven: `com.fasterxml.jackson.core:jackson-databind`. Jackson yerine Gson ya da başka bir kütüphane
  kullanıyorsanız yalnızca `parse` ve `writeValueAsString` çağrıları değişir.
- Spring Retry ya da Resilience4j kullanıyorsanız `/send` için 5xx'te (`503` dahil) tekrar politikasını
  kapatın: `/send`'de `503` sonrası görev çoğunlukla kuyruğa alınmamıştır ama bu kesin değildir, körlemesine
  tekrar çift gönderim olabilir. Okuma isteklerinde ve `/send/otp`'de `503` tekrarı güvenlidir.
- `token()` `synchronized` olduğu için yenileme sırasında diğer thread'ler bekler; token geçerliyken kilit
  anlık tutulur.
- Mock'ta denemek: mock'u başlatın, programı çalıştırın, sonra `curl -s http://127.0.0.1:4010/__mock/advice`.
  Hata dalları için [testing.md](../testing.md).
