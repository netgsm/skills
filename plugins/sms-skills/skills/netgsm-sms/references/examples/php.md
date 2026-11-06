# PHP örneği

PHP ≥ 8.1, `ext-curl` ve `ext-json` ile, başka paket gerektirmeden. Akış: token önbelleği → tek `/send`
→ `rejectedItems` → hata dalları (401 / 429 / 5xx). Yalnızca sunucu tarafında çalışır;
kimlik bilgileri ortam değişkenlerinden okunur. `NETGSM_BASE_URL` verilmezse mock'a gider.

**PHP-FPM'de her istek ayrı bir süreçtir:** token bir değişkende tutulursa her web isteği yeni token alır
ve `/token` sınırına (IP başına dakikada 30) takılır. Örnek token'ı APCu'da tutar; Laravel ya da
Symfony'de `cacheGet`/`cacheSet`'i framework'ün cache'iyle değiştirin.

```php
<?php
declare(strict_types=1);

final class NetgsmApiException extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,      // mantık buna göre kurulur (REJECTED_HEADER, ...)
        public readonly ?string $requestId,     // loglayın; destek talebinde paylaşın
        public readonly bool $retryable,
        public readonly bool $mayHaveBeenQueued = false,
        public readonly array $rejectedItems = [],
        string $detail = '',
        public readonly ?int $retryAfterSec = null,  // 429'da Retry-After (sn)
    ) {
        parent::__construct(trim("Netgsm $status $errorCode $detail") . ' (requestId ' . ($requestId ?? '-') . ')');
    }
}

final class NetgsmClient
{
    private const AUTH_TIMEOUT = 15;    // token isteklerinin süre sınırı (sn)
    private const LOCK_TTL = 40;        // > 2 × AUTH_TIMEOUT: kilit, refresh + giriş sürerken düşmez
    private ?string $lockOwner = null;
    private static array $local = [];  // APCu yoksa (ör. CLI) süreç içi önbellek

    public function __construct(
        private readonly string $username,
        private readonly string $password,
        private readonly string $baseUrl = 'http://127.0.0.1:4010',  // canlı: https://ext-api.netgsm.com.tr
        private readonly int $maxRetryAfterSec = 60,
    ) {}

    /** POST /sms/v3/send. Bütün alıcılar tek istekte; dönen rejectedItems işlenir. */
    public function send(array $body): array
    {
        $relogged = false; $rateRetried = false;
        while (true) {
            $token = $this->token();
            [$status, $headers, $json] = $this->post('/sms/v3/send', $body, $token);
            if ($status === 202) {
                return $json;
            }
            $code = $json['code'] ?? "HTTP_$status";
            $rid = $json['requestId'] ?? null;
            $rawRetryAfter = $headers['retry-after'] ?? null;
            $retryAfter = $rawRetryAfter !== null && ctype_digit($rawRetryAfter) ? (int) $rawRetryAfter : null;

            if ($status === 401 && !$relogged) {           // bir kez yeniden giriş, bir kez tekrar
                $relogged = true;
                $this->invalidate($token);
                continue;
            }
            if ($status === 429) {
                if ($rawRetryAfter === null) {              // gönderim askıya alınmış: beklemek işe yaramaz
                    throw new NetgsmApiException($status, $code, $rid, false);
                }
                // Okunamayan Retry-After (HTTP tarihi vb.): hemen tekrar denenmez, daha sonra denenir.
                if ($retryAfter === null || $rateRetried || $retryAfter > $this->maxRetryAfterSec) {
                    throw new NetgsmApiException($status, $code, $rid, true);
                }
                $rateRetried = true;
                sleep($retryAfter);
                continue;
            }
            if ($status >= 500) {                           // 503 dahil: kuyruğa alınmış olabilir, TEKRAR YOK; önce GET /report
                throw new NetgsmApiException($status, $code, $rid, false, true);
            }
            // 400 / 403 / 413 / 422: aynı istek aynı sonucu verir.
            throw new NetgsmApiException($status, $code, $rid, false, false, $json['rejectedItems'] ?? []);
        }
    }

    /**
     * GET /sms/v3/balance. Kampanyadan önce bir kez; döngüde ya da her mesajdan önce çağırmayın.
     * 429'da beklemez ve tekrar etmez: retryable ve retryAfterSec ile hata fırlatır.
     */
    public function balance(int $stip = 3, ?string $service = null): array
    {
        $query = http_build_query(['stip' => $stip] + ($service !== null ? ['service' => $service] : []));
        $relogged = false;
        while (true) {
            $token = $this->token();
            [$status, $headers, $json] = $this->post("/sms/v3/balance?$query", null, $token, 30);
            if ($status === 200) {
                return $json;
            }
            if ($status === 401 && !$relogged) {
                $relogged = true;
                $this->invalidate($token);
                continue;
            }
            $ra = $headers['retry-after'] ?? null;
            throw new NetgsmApiException($status, $json['code'] ?? "HTTP_$status", $json['requestId'] ?? null,
                $status === 429 || $status >= 500, false, [], '', $ra !== null && ctype_digit($ra) ? (int) $ra : null);
        }
    }

    /** Kredi metnini TL sayıya çevirir: "92,150" → 92.15, "0" → 0.0, 277 → 277.0. Okunamazsa null. */
    public static function parseCredit(mixed $value): ?float
    {
        if (is_int($value) || is_float($value)) {
            return (float) $value;
        }
        if (!is_string($value) || !preg_match('/^-?\d+([.,]\d+)?$/', trim($value))) {
            return null;
        }
        return (float) str_replace(',', '.', trim($value));
    }

    /** Varlığı adıyla bulur (liste sabit değildir, sıraya güvenilmez; ad büyük/küçük harfe duyarsız); yoksa null. */
    public static function findBalance(array $entries, string $name): ?float
    {
        foreach ($entries as $e) {
            if (strcasecmp(trim((string) ($e['balance_name'] ?? '')), $name) === 0) {
                return self::parseCredit($e['amount'] ?? null);
            }
        }
        return null;
    }

    private function token(): string
    {
        $t = $this->cacheGet();
        $now = time();
        if ($t !== null && $now < $t['expires_at'] && ($now < $t['refresh_at'] || $now < $t['retry_refresh_at'])) {
            return $t['access_token'];
        }
        // Yenilemeyi ya da girişi aynı anda tek bir FPM süreci yapar (aynı refresh token koordinasyonsuz
        // kullanılmaz). Kilidi alamayan süreç eski token geçerliyse onu kullanır, değilse yenisini bekler.
        if (!$this->lock()) {
            if ($t !== null && $now < $t['expires_at']) {
                return $t['access_token'];
            }
            for ($i = 0; $i < 50; $i++) {                   // en fazla ~5 sn
                usleep(100_000);
                $n = $this->cacheGet();
                if ($n !== null && time() < $n['expires_at']) {
                    return $n['access_token'];
                }
            }
            throw new NetgsmApiException(0, 'TOKEN_BUSY', null, true, false, [], 'token yenilemesi başka bir süreçte sürüyor');
        }
        try {
            return $this->renew($this->cacheGet(), $now);   // kilit alınırken başkası yenilemiş olabilir
        } finally {
            $this->unlock();
        }
    }

    private function renew(?array $t, int $now): string
    {
        if ($t !== null && $now < $t['expires_at'] && ($now < $t['refresh_at'] || $now < $t['retry_refresh_at'])) {
            return $t['access_token'];
        }
        if ($t !== null) {
            [$status, , $json] = $this->post('/auth/v3/token/refresh', ['refresh_token' => $t['refresh_token']], null, self::AUTH_TIMEOUT);
            if ($status === 200) {
                return $this->store($json);
            }
            if (($json['code'] ?? '') !== 'invalid_refresh_token' && $now < $t['expires_at']) {
                $t['retry_refresh_at'] = $now + 30;         // geçici hata: eski token 30 sn daha
                $this->cacheSet($t);
                return $t['access_token'];
            }
        }
        [$status, , $json] = $this->post('/auth/v3/token',
            ['username' => $this->username, 'password' => $this->password, 'scope' => 'sms'], null, self::AUTH_TIMEOUT);
        if ($status !== 200) {
            $code = $json['code'] ?? "HTTP_$status";
            throw new NetgsmApiException($status, $code, $json['request_id'] ?? null, $status >= 500 || $code === 'rate_limited');
        }
        return $this->store($json);
    }

    private function store(array $j): string
    {
        $now = time();
        $life = (int) $j['expires_in'];
        $this->cacheSet([
            'access_token' => $j['access_token'], 'refresh_token' => $j['refresh_token'],
            'expires_at' => $now + $life, 'refresh_at' => $now + $life - min(300, intdiv($life, 10)),
            'retry_refresh_at' => 0,
        ]);
        return $j['access_token'];
    }

    private function invalidate(string $staleToken): void
    {
        // Başka bir istek token'ı zaten yenilediyse yenisi silinmez.
        if (($this->cacheGet()['access_token'] ?? null) === $staleToken) {
            $this->cacheSet(null);
        }
    }

    private function lock(): bool
    {
        if (!(function_exists('apcu_enabled') && apcu_enabled())) {
            return true;                                    // APCu yok: süreç içi önbellek, kilit gerekmez
        }
        // apcu_add yalnızca anahtar yoksa yazar: tek kazanan. Değer bu sürecin rastgele sahiplik
        // belirtecidir. TTL (LOCK_TTL) iki token isteğinin süre sınırından uzundur: kilit, sahibi
        // çalışırken düşmez; takılıp kalan bir sürecin kilidi ise TTL dolunca kendiliğinden düşer.
        $owner = bin2hex(random_bytes(16));
        if (!apcu_add('netgsm_lock_' . $this->username, $owner, self::LOCK_TTL)) {
            return false;
        }
        $this->lockOwner = $owner;
        return true;
    }

    private function unlock(): void
    {
        // Karşılaştır-ve-sil: kilit yalnızca hâlâ bu sürecinse silinir; TTL dolduktan sonra başka bir
        // sürecin aldığı kilit silinmez. APCu'da dizgi için atomik karşılaştır-ve-sil yoktur
        // (apcu_cas yalnızca tamsayı); okuma ile silme arasındaki pencereyi LOCK_TTL > 2 × AUTH_TIMEOUT
        // kapatır: sahibi kilidi bırakırken TTL henüz dolmamıştır.
        if ($this->lockOwner !== null && function_exists('apcu_enabled') && apcu_enabled()) {
            $key = 'netgsm_lock_' . $this->username;
            if (apcu_fetch($key) === $this->lockOwner) {
                apcu_delete($key);
            }
        }
        $this->lockOwner = null;
    }

    private function cacheGet(): ?array
    {
        $key = 'netgsm_token_' . $this->username;
        $v = function_exists('apcu_enabled') && apcu_enabled() ? apcu_fetch($key) : (self::$local[$key] ?? null);
        return is_array($v) ? $v : null;
    }

    private function cacheSet(?array $t): void
    {
        $key = 'netgsm_token_' . $this->username;
        if (function_exists('apcu_enabled') && apcu_enabled()) {
            $t === null ? apcu_delete($key) : apcu_store($key, $t, max(1, $t['expires_at'] - time()));
        } elseif ($t === null) {
            unset(self::$local[$key]);
        } else {
            self::$local[$key] = $t;
        }
    }

    /**
     * $body null ise GET, değilse JSON gövdeli POST.
     * @return array{int, array<string,string>, array} durum kodu, küçük harfli başlıklar, JSON gövde
     */
    private function post(string $path, ?array $body, ?string $token = null, int $timeout = 60): array
    {
        $headers = [];
        $ch = curl_init($this->baseUrl . $path);
        if ($body !== null) {
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
            ]);
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_HTTPHEADER => array_merge(
                ['Content-Type: application/json', 'Accept: application/json'],
                $token !== null ? ["Authorization: Bearer $token"] : [],
            ),
            CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$headers): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);
        $raw = curl_exec($ch);
        if ($raw === false) {
            // Bağlantı hatası / zaman aşımı. SMS isteğinde belirsiz bir 5xx gibidir: istek ulaşmış olabilir, otomatik tekrar etmeyin.
            $sms = $token !== null;
            throw new NetgsmApiException(0, 'NETWORK_ERROR', null, !$sms, $sms, [], curl_error($ch));
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        return [$status, $headers, json_decode((string) $raw, true) ?: []];
    }
}

// --- Kullanım -----------------------------------------------------------------------------------
$client = new NetgsmClient(
    getenv('NETGSM_USERNAME') ?: throw new RuntimeException('NETGSM_USERNAME tanımlı değil'),
    getenv('NETGSM_PASSWORD') ?: throw new RuntimeException('NETGSM_PASSWORD tanımlı değil'),
    getenv('NETGSM_BASE_URL') ?: 'http://127.0.0.1:4010',
);
$customers = [['phone' => '905061234567', 'name' => 'Ayşe'], ['phone' => '905061234568', 'name' => 'Mehmet']];

try {
    $res = $client->send([
        'sender' => getenv('NETGSM_SENDER') ?: 'MOCKTEST',
        'encoding' => 'TURKISH',
        'messages' => array_map(fn (array $c) => ['recipient' => $c['phone'], 'text' => "Merhaba {$c['name']}"], $customers),
    ]);
    error_log("sms queued jobId={$res['jobId']} status={$res['status']} accepted={$res['accepted']} rejected={$res['rejected']}");
    foreach ($res['rejectedItems'] as $item) {
        error_log("sms rejected jobId={$res['jobId']} index={$item['index']} recipient={$item['recipient']} reason={$item['reason']}");
    }
} catch (NetgsmApiException $e) {
    error_log($e->getMessage());
    if ($e->mayHaveBeenQueued) {
        // 503 / 500: gönderilmiş olabilir. Tekrar GÖNDERMEYİN; GET /sms/v3/report ile kontrol edin.
    } elseif ($e->retryable) {
        // Geçici: işi daha sonra (kuyruk / zamanlanmış görev) yeniden planlayın.
    } else {
        // errorCode'a göre düzeltin (errors.md); NO_DELIVERABLE_MESSAGES'ta $e->rejectedItems nedenleri taşır.
    }
}
```

Bakiye kontrolü ([balance.md](../endpoints/balance.md), https://api-docs.netgsm.com.tr/get-balance/).
Yanıt 10 sn önbellektedir; gönderimden hemen sonra okunan değer en fazla 10 sn eski olabilir:

```php
try {
    $entries = $client->balance(3)['balance'];
    $sms = NetgsmClient::findBalance($entries, 'Adet SMS') ?? 0.0;          // amount metin ya da sayı olabilir
    $creditTl = NetgsmClient::findBalance($entries, 'Kredi Bakiye') ?? 0.0; // "92,150" → 92.15
} catch (NetgsmApiException $e) {
    if ($e->status === 429) {
        // Beklemeyin, döngüye girmeyin: kontrolü $e->retryAfterSec saniye sonra yeniden planlayın.
    }
    throw $e;
}
```

Rapor webhook'u (`netgsm-report.php`). Gövde sayısal kodlar taşır: `status` `1` iletildi, `2` iletilmedi
ve nedeni `errorCode`'da (yalnızca `status` `2` iken anlamlı), diğer kodlar nedeni kendisi söyler;
`operator` sayısaldır, `failReason` alanı yoktur, `referansID` `null` olabilir. Kod tabloları ve
`GET /report` karşılıkları: [webhooks.md](../endpoints/webhooks.md).

```php
<?php
// Kayıtta verdiğiniz başlıkla isteğin sizden geldiğini doğrulayın.
if (!hash_equals((string) getenv('NETGSM_WEBHOOK_TOKEN'), $_SERVER['HTTP_X_WEBHOOK_TOKEN'] ?? '')) {
    http_response_code(401);
    exit;
}
const STATUS_REASON = [3 => 'INVALID_NUMBER', 4 => 'NOT_SENT_TO_OPERATOR', 8 => 'OPERATOR_REJECTED', 11 => 'OPERATOR_ERROR',
    12 => 'SEND_ERROR', 13 => 'DUPLICATE', 14 => 'INSUFFICIENT_CREDIT', 15 => 'BLACKLISTED', 16 => 'IYS_REJECTED',
    17 => 'IYS_ERROR', 18 => 'MESSAGE_NOT_CREATED', 19 => 'INVALID_NUMBER_FORMAT', 20 => 'NTS_NOT_APPROVED',
    22 => 'NO_INTERNATIONAL_PERMISSION'];
const ERROR_REASON = [111 => 'TIMEOUT', 112 => 'SMS_DISABLED_ON_DEVICE', 113 => 'DEVICE_NOT_SUPPORTED', 114 => 'ROUTING_FAILED',
    115 => 'OPERATOR_TIMEOUT', 116 => 'UNKNOWN_SUBSCRIBER', 117 => 'ILLEGAL_SUBSCRIBER', 119 => 'SYSTEM_ERROR'];

$payload = json_decode((string) file_get_contents('php://input'), true) ?: [];
foreach ($payload['numbers'] ?? [] as $n) {
    $status = (int) $n['status'];
    if ($status === 1) {
        [$state, $reason] = ['DELIVERED', null];
    } elseif ($status === 2) {                       // errorCode yalnızca burada okunur; 0 ya da null: bilinmiyor
        [$state, $reason] = ['NOT_DELIVERED', ERROR_REASON[(int) ($n['errorCode'] ?? 0)] ?? 'UNKNOWN'];
    } else {
        [$state, $reason] = ['NOT_DELIVERED', STATUS_REASON[$status] ?? 'UNKNOWN'];
    }
    saveDelivery($n['jobid'], $n['number'], $state, $reason, $n['referansID'] ?? null); // sizin kaydınız
}
http_response_code(200); // herhangi bir 2xx teslim alındı demektir
```

Notlar:

- Guzzle kullanıyorsanız akış aynıdır: `http_errors => false` ile durum kodunu kendiniz okuyun, Guzzle'ın
  retry ara katmanını `/send` için 5xx'te (`503` dahil) **kapatın**.
- APCu'daki token'ı bütün FPM süreçleri paylaşır. Aynı refresh token birden fazla süreçte
  koordinasyonsuz kullanılmaz (bkz. [auth.md](../auth.md#oturum-modeli)): yenilemeyi ve ilk girişi
  `apcu_add` kilidini alan tek süreç yapar, diğerleri o sırada geçerli eski token'la devam eder ya da
  yenisini bekler. Kilidin değeri sürecin sahiplik belirtecidir; süreç kilidi yalnızca hâlâ kendisinin
  ise siler (karşılaştır-ve-sil). Kilidin ömrü (`LOCK_TTL`, 40 sn) token isteklerinin süre sınırının
  (`AUTH_TIMEOUT`, 15 sn; bir yenilemede en fazla refresh + giriş = 2 istek) üstündedir, böylece kilit
  sahibi çalışırken düşmez ve başka bir süreç aynı anda yenileme yapamaz. Laravel'de `Cache::lock`, Symfony'de Lock bileşeni aynı işi görür; birden fazla
  sunucuda paylaşılan bir cache kullanıyorsanız kilit de o cache'te olmalıdır.
- Bağlantı hatası ve zaman aşımı da `NetgsmApiException` olur (`errorCode` `NETWORK_ERROR`, `status` 0).
  SMS isteğinde `mayHaveBeenQueued` true'dur: istek ulaşmış olabilir.
- Mock'ta denemek: mock'u başlatın, `php netgsm.php` çalıştırın, sonra
  `curl -s http://127.0.0.1:4010/__mock/advice`. Hata dalları için [testing.md](../testing.md).
