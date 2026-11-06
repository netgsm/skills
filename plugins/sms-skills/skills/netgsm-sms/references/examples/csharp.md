# C# örneği

.NET 8, `HttpClient` ve `System.Text.Json` ile, ek paket gerektirmeden. Akış: token önbelleği → tek
`/send` → `rejectedItems` → hata dalları (401 / 429 / 5xx). Yalnızca sunucu tarafında
çalışır; kimlik bilgileri ortam değişkenlerinden (ya da `IConfiguration`'dan) okunur. `NETGSM_BASE_URL`
verilmezse mock'a gider.

ASP.NET Core'da `NetgsmClient`'ı **singleton** kaydedin (`builder.Services.AddSingleton(...)`) ve
`HttpClient`'ı `IHttpClientFactory`'den alın. Scoped ya da transient kayıt her istekte yeni token demektir.

```csharp
// Program.cs (dotnet new console)
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

var baseUrl = Environment.GetEnvironmentVariable("NETGSM_BASE_URL") ?? "http://127.0.0.1:4010"; // canlı: https://ext-api.netgsm.com.tr
using var http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(60) };
http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
var client = new NetgsmClient(http, Env("NETGSM_USERNAME"), Env("NETGSM_PASSWORD"));

var customers = new[] { (Phone: "905061234567", Name: "Ayşe"), (Phone: "905061234568", Name: "Mehmet") };
try
{
    var res = await client.SendAsync(new
    {
        sender = Environment.GetEnvironmentVariable("NETGSM_SENDER") ?? "MOCKTEST",
        encoding = "TURKISH",
        messages = customers.Select(c => new { recipient = c.Phone, text = $"Merhaba {c.Name}" }),
    });
    Console.WriteLine($"sms queued jobId={res["jobId"]} status={res["status"]} accepted={res["accepted"]} rejected={res["rejected"]}");
    foreach (var item in res["rejectedItems"]!.AsArray())
        Console.Error.WriteLine($"sms rejected jobId={res["jobId"]} index={item!["index"]} recipient={item["recipient"]} reason={item["reason"]}");
}
catch (NetgsmApiException e)
{
    Console.Error.WriteLine($"sms failed status={e.Status} code={e.Code} requestId={e.RequestId}");
    if (e.MayHaveBeenQueued) { /* 503 / 500: gönderilmiş olabilir. Tekrar GÖNDERMEYİN; GET /sms/v3/report ile kontrol edin. */ }
    else if (e.Retryable) { /* geçici: işi daha sonra yeniden planlayın */ }
    else { /* Code'a göre düzeltin (errors.md); NO_DELIVERABLE_MESSAGES'ta e.RejectedItems nedenleri taşır */ }
}

static string Env(string name) => Environment.GetEnvironmentVariable(name) ?? throw new InvalidOperationException($"{name} tanımlı değil");

public sealed class NetgsmApiException(int status, string code, string? requestId, bool retryable,
    bool mayHaveBeenQueued = false, JsonArray? rejectedItems = null, TimeSpan? retryAfter = null)
    : Exception($"Netgsm {status} {code} (requestId {requestId ?? "-"})")
{
    public int Status { get; } = status;
    public string Code { get; } = code;                 // mantık buna göre kurulur
    public string? RequestId { get; } = requestId;      // loglayın; destek talebinde paylaşın
    public bool Retryable { get; } = retryable;
    public bool MayHaveBeenQueued { get; } = mayHaveBeenQueued;
    public JsonArray? RejectedItems { get; } = rejectedItems;
    public TimeSpan? RetryAfter { get; } = retryAfter;  // 429'da Retry-After
}

public sealed class NetgsmClient(HttpClient http, string username, string password, int maxRetryAfterSec = 60)
{
    private sealed record Tokens(string Access, string Refresh, DateTimeOffset ExpiresAt, DateTimeOffset RefreshAt, DateTimeOffset RetryRefreshAt);
    private readonly SemaphoreSlim _lock = new(1, 1); // aynı anda tek token isteği
    private Tokens? _tokens;

    /// <summary>POST /sms/v3/send. Bütün alıcılar tek istekte; dönen rejectedItems işlenir.</summary>
    public async Task<JsonObject> SendAsync(object body, CancellationToken ct = default)
    {
        bool relogged = false, rateRetried = false;
        while (true)
        {
            var token = await GetTokenAsync(ct);
            using var req = new HttpRequestMessage(HttpMethod.Post, "sms/v3/send") { Content = JsonContent.Create(body) };
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            // Zaman aşımı (TaskCanceledException) gönderimde belirsiz bir 5xx gibidir: istek ulaşmış olabilir, otomatik tekrar etmeyin.
            using var res = await http.SendAsync(req, ct);
            var status = (int)res.StatusCode;
            var json = await ReadJsonAsync(res, ct);
            if (status == 202) return json;
            var code = json["code"]?.GetValue<string>() ?? $"HTTP_{status}";
            var rid = json["requestId"]?.GetValue<string>();
            var retryAfterHeader = res.Headers.RetryAfter;   // null: başlık yok
            var retryAfter = retryAfterHeader?.Delta;         // null: başlık yok ya da saniye değil (HTTP tarihi)

            if (status == 401 && !relogged) { relogged = true; await InvalidateAsync(token, ct); continue; } // bir kez
            if (status == 429)
            {
                if (retryAfterHeader is null) throw new NetgsmApiException(status, code, rid, false); // gönderim askıya alınmış
                // Okunamayan Retry-After: hemen tekrar denenmez, daha sonra denenir.
                if (retryAfter is null || rateRetried || retryAfter.Value.TotalSeconds > maxRetryAfterSec) throw new NetgsmApiException(status, code, rid, true);
                rateRetried = true;
                await Task.Delay(retryAfter.Value, ct);
                continue;
            }
            if (status >= 500) throw new NetgsmApiException(status, code, rid, false, mayHaveBeenQueued: true); // 503 dahil: kuyruğa alınmış olabilir, TEKRAR YOK
            // 400 / 403 / 413 / 422: aynı istek aynı sonucu verir.
            throw new NetgsmApiException(status, code, rid, false, rejectedItems: json["rejectedItems"]?.AsArray());
        }
    }

    /// <summary>
    /// GET /sms/v3/balance. Kampanyadan önce bir kez; döngüde ya da her mesajdan önce çağırmayın.
    /// 429'da beklemez ve tekrar etmez: Retryable ve RetryAfter ile hata fırlatır.
    /// </summary>
    public async Task<JsonObject> BalanceAsync(int stip = 3, string? service = null, CancellationToken ct = default)
    {
        var path = $"sms/v3/balance?stip={stip}" + (service is null ? "" : $"&service={Uri.EscapeDataString(service)}");
        var relogged = false;
        while (true)
        {
            var token = await GetTokenAsync(ct);
            using var req = new HttpRequestMessage(HttpMethod.Get, path);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var res = await http.SendAsync(req, ct);
            var status = (int)res.StatusCode;
            var json = await ReadJsonAsync(res, ct);
            if (status == 200) return json;
            if (status == 401 && !relogged) { relogged = true; await InvalidateAsync(token, ct); continue; }
            throw new NetgsmApiException(status, json["code"]?.GetValue<string>() ?? $"HTTP_{status}", json["requestId"]?.GetValue<string>(),
                status == 429 || status >= 500, retryAfter: res.Headers.RetryAfter?.Delta);
        }
    }

    /// <summary>Kredi metnini TL sayıya çevirir: "92,150" → 92.15, "0" → 0, 277 → 277. Okunamazsa null.</summary>
    public static decimal? ParseCredit(JsonNode? value)
    {
        var text = value?.ToString().Trim();  // amount metin ya da sayı olabilir
        if (text is null || !System.Text.RegularExpressions.Regex.IsMatch(text, @"^-?\d+([.,]\d+)?$")) return null;
        return decimal.Parse(text.Replace(',', '.'), System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>Varlığı adıyla bulur (liste sabit değildir, sıraya güvenilmez; ad büyük/küçük harfe duyarsız); yoksa null.</summary>
    public static decimal? FindBalance(JsonObject response, string name) =>
        ParseCredit(response["balance"]?.AsArray().FirstOrDefault(e =>
            string.Equals(e?["balance_name"]?.GetValue<string>()?.Trim(), name, StringComparison.OrdinalIgnoreCase))?["amount"]);

    private async Task<string> GetTokenAsync(CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var (t, now) = (_tokens, DateTimeOffset.UtcNow);
            if (t is not null && now < t.ExpiresAt && (now < t.RefreshAt || now < t.RetryRefreshAt)) return t.Access;
            if (t is not null)
            {
                var (s, j) = await PostAsync("auth/v3/token/refresh", new { refresh_token = t.Refresh }, ct);
                if (s == 200) return Store(j);
                if (j["code"]?.GetValue<string>() != "invalid_refresh_token" && now < t.ExpiresAt)
                {
                    _tokens = t with { RetryRefreshAt = now.AddSeconds(30) }; // geçici hata: eski token 30 sn daha
                    return t.Access;
                }
            }
            var (status, json) = await PostAsync("auth/v3/token", new { username, password, scope = "sms" }, ct);
            if (status != 200)
            {
                var code = json["code"]?.GetValue<string>() ?? $"HTTP_{status}";
                throw new NetgsmApiException(status, code, json["request_id"]?.GetValue<string>(), status >= 500 || code == "rate_limited");
            }
            return Store(json);
        }
        finally { _lock.Release(); }
    }

    private string Store(JsonObject j)
    {
        var life = j["expires_in"]!.GetValue<int>();
        var now = DateTimeOffset.UtcNow;
        _tokens = new Tokens(j["access_token"]!.GetValue<string>(), j["refresh_token"]!.GetValue<string>(),
            now.AddSeconds(life), now.AddSeconds(life - Math.Min(300, life / 10.0)), DateTimeOffset.MinValue);
        return _tokens.Access;
    }

    private async Task InvalidateAsync(string staleToken, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try { if (_tokens?.Access == staleToken) _tokens = null; } // başkası yenilediyse yenisi silinmez
        finally { _lock.Release(); }
    }

    private async Task<(int Status, JsonObject Json)> PostAsync(string path, object body, CancellationToken ct)
    {
        using var res = await http.PostAsJsonAsync(path, body, ct);
        return ((int)res.StatusCode, await ReadJsonAsync(res, ct));
    }

    private static async Task<JsonObject> ReadJsonAsync(HttpResponseMessage res, CancellationToken ct)
    {
        var text = await res.Content.ReadAsStringAsync(ct);
        try { return JsonNode.Parse(text) as JsonObject ?? new JsonObject(); }
        catch (JsonException) { return new JsonObject(); }
    }
}
```

Bakiye kontrolü ([balance.md](../endpoints/balance.md), https://api-docs.netgsm.com.tr/get-balance/).
Yanıt 10 sn önbellektedir; gönderimden hemen sonra okunan değer en fazla 10 sn eski olabilir:

```csharp
try
{
    var balance = await client.BalanceAsync(stip: 3);
    var sms = NetgsmClient.FindBalance(balance, "Adet SMS") ?? 0;          // amount metin ya da sayı olabilir
    var creditTl = NetgsmClient.FindBalance(balance, "Kredi Bakiye") ?? 0; // "92,150" → 92.15
}
catch (NetgsmApiException e) when (e.Status == 429)
{
    // Beklemeyin, döngüye girmeyin: kontrolü e.RetryAfter sonra yeniden planlayın.
}
```

Rapor webhook'u (ASP.NET Core minimal API). Gövde sayısal kodlar taşır: `status` `1` iletildi, `2`
iletilmedi ve nedeni `errorCode`'da (yalnızca `status` `2` iken anlamlı), diğer kodlar nedeni kendisi
söyler; `operator` sayısaldır, `failReason` alanı yoktur, `referansID` `null` olabilir. Kod tabloları ve
`GET /report` karşılıkları: [webhooks.md](../endpoints/webhooks.md).

```csharp
var statusReason = new Dictionary<int, string> {
    [3] = "INVALID_NUMBER", [4] = "NOT_SENT_TO_OPERATOR", [8] = "OPERATOR_REJECTED", [11] = "OPERATOR_ERROR",
    [12] = "SEND_ERROR", [13] = "DUPLICATE", [14] = "INSUFFICIENT_CREDIT", [15] = "BLACKLISTED", [16] = "IYS_REJECTED",
    [17] = "IYS_ERROR", [18] = "MESSAGE_NOT_CREATED", [19] = "INVALID_NUMBER_FORMAT", [20] = "NTS_NOT_APPROVED",
    [22] = "NO_INTERNATIONAL_PERMISSION" };
var errorReason = new Dictionary<int, string> {
    [111] = "TIMEOUT", [112] = "SMS_DISABLED_ON_DEVICE", [113] = "DEVICE_NOT_SUPPORTED", [114] = "ROUTING_FAILED",
    [115] = "OPERATOR_TIMEOUT", [116] = "UNKNOWN_SUBSCRIBER", [117] = "ILLEGAL_SUBSCRIBER", [119] = "SYSTEM_ERROR" };

app.MapPost("/netgsm/report", async (HttpRequest request, JsonObject payload) =>
{
    // Kayıtta verdiğiniz başlıkla isteğin sizden geldiğini doğrulayın.
    if (request.Headers["X-Webhook-Token"] != Environment.GetEnvironmentVariable("NETGSM_WEBHOOK_TOKEN")) return Results.Unauthorized();
    foreach (var n in payload["numbers"]?.AsArray() ?? new JsonArray())
    {
        var status = n!["status"]!.GetValue<int>();
        var (state, reason) = status switch
        {
            1 => ("DELIVERED", (string?)null),
            // errorCode yalnızca status 2 iken okunur; 0 ya da null: bilinmiyor
            2 => ("NOT_DELIVERED", errorReason.GetValueOrDefault(n["errorCode"]?.GetValue<int>() ?? 0, "UNKNOWN")),
            _ => ("NOT_DELIVERED", statusReason.GetValueOrDefault(status, "UNKNOWN")),
        };
        await SaveDeliveryAsync(n["jobid"]!.GetValue<string>(), n["number"]!.GetValue<string>(), state, reason,
            n["referansID"]?.GetValue<string>()); // sizin kaydınız
    }
    return Results.Ok(); // herhangi bir 2xx teslim alındı demektir
});
```

Notlar:

- `Polly` ya da `Microsoft.Extensions.Http.Resilience` kullanıyorsanız, standart tekrar politikası
  `500`, `503` ve `504`'ü de tekrarlar: Netgsm `/send` istekleri için bu politikayı kapatın. `/send`'de
  `503` sonrası görev çoğunlukla kuyruğa alınmamıştır ama bu kesin değildir; körlemesine tekrar çift gönderim olabilir.
  Okuma isteklerinde ve `/send/otp`'de `503` tekrarı güvenlidir.
- Mock'ta denemek: mock'u başlatın, `dotnet run`, sonra `curl -s http://127.0.0.1:4010/__mock/advice`.
  Hata dalları için [testing.md](../testing.md).
