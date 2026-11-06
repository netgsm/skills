import { parseArgs } from 'node:util';
import { createMockServer } from './server.mjs';

const HELP = `Netgsm SMS API v3 yerel mock'u

Kullanım: node netgsm-sms-mock.mjs [seçenekler]

Seçenekler:
  --port <n>          Dinlenecek port (varsayılan 4010)
  --host <h>          Dinlenecek adres (varsayılan 127.0.0.1). Loopback dışı bir adreste uyarı
                      yazılır ve loopback webhook adresleri gerçek API'deki gibi reddedilir.
  --token-ttl <sn>    Token ömrü, saniye (varsayılan 86400)
  --rate-scale <oran> Hız sınırı çarpanı (varsayılan 1; 10 = sınırlar on kat gevşek)
  --quiet             Başarılı istekleri yazma; yalnızca hata (✘) ve bulguları (⚠) göster
  --help              Bu yardımı göster
`;

const OPTIONS = {
  port: { type: 'string', default: '4010' },
  host: { type: 'string', default: '127.0.0.1' },
  'token-ttl': { type: 'string', default: '86400' },
  'rate-scale': { type: 'string', default: '1' },
  quiet: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

function fail(message) {
  console.error(`Hata: ${message}\n\n${HELP}`);
  process.exit(1);
}

const bannerFor = (base) => `
Netgsm SMS API v3 mock'u çalışıyor

  Identity base URL : ${base}/auth/v3
  SMS base URL      : ${base}/sms/v3

Test hesapları (8500000000–8500000005 Identity sandbox'ının demo hesaplarıyla aynıdır)

  username     şifre         ne gösterir
  8500000000   password001   Her şey açık: gönderim, rapor, gelen kutusu, İYS modu
  8500000001   password002   Hizmet aktivasyonu yok: sms kapsamı 403 service_not_activated
  8500000002   password003   IP izni yok: 403 ip_not_allowed
  8500000003   password004   Hizmet yetkisi olmayan alt kullanıcı (4001): 403 sub_user_not_permitted
  8500000004   password005   API erişimi kapalı: 403 api_access_denied
  8500000005   password006   Hesap pasif: 403 account_inactive
  Yalnızca mock:
  8500000006   password007   Token alınır, /send 403 FORBIDDEN (operatör hizmeti yok)
  8500000007   password008   Ülke izni yok: 403 country_not_allowed
  8500000008   password009   İYS modu, yurt dışı gönderim izni ve OTP kredisi yok; bakiye: yalnızca SMS paketi
  8500000009   password010   Ana hesap; password011 aynı hesabın API alt kullanıcısı (1); bakiye boş
  8500000010   password012   Kurumsal OTP hesabı: /send/otp x-client: enterprise başlığı ister; faturalı

Başlıklar (sender): MOCKTEST ve TESTHEADER (SMS sandbox'ının başlığı) kullanılabilir, MOCKKAPALI
yönlendirme kodu eksik olduğu için reddedilir, abone numarası (username) her hesapta kullanılabilir.
Sandbox'la ortak sabit veri: şablon 1 (Merhaba \${name}, kodunuz \${code}), kara liste 5000000001, 5000000002.
Bakiye (GET /sms/v3/balance): diğer hesaplarda kredi 92,150 TL ve paketler; değerler sabittir.

Kontrol uçları (kimlik doğrulaması gerekmez; POST istekleri Content-Type: application/json ister):
  POST   ${base}/__mock/scenario   Sıradaki isteğe hata enjekte eder
  GET    ${base}/__mock/scenario   Kuyruktaki senaryoları listeler
  DELETE ${base}/__mock/scenario   Senaryo kuyruğunu temizler
  GET    ${base}/__mock/advice     Mock'un tespit ettiği entegrasyon bulguları
  POST   ${base}/__mock/clock      Saati ileri alır ({"advanceSeconds": 60})
  POST   ${base}/__mock/inbound    Gelen SMS ekler
  POST   ${base}/__mock/reset      Bütün durumu başa döndürür

Mock gerçek başlık onayını, gerçek İYS izinlerini, gerçek bakiye tüketimini ve gerçek operatör iletimini taklit etmez.
Durdurmak için Ctrl+C.
`;

let values;
try {
  ({ values } = parseArgs({ options: OPTIONS, allowPositionals: false }));
} catch (err) {
  fail(err.message);
}
if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const num = (name, raw, { min, integer }) => {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    fail(`--${name} için geçersiz değer: ${raw}`);
  }
  return n;
};
const port = num('port', values.port, { min: 0, integer: true });
if (port > 65535) fail(`--port için geçersiz değer: ${values.port}`);
const tokenTtlSec = num('token-ttl', values['token-ttl'], { min: 1, integer: true });
const rateScale = num('rate-scale', values['rate-scale'], { min: Number.MIN_VALUE });

const server = createMockServer({ port, host: values.host, tokenTtlSec, rateScale, quiet: values.quiet });

let base;
try {
  base = await server.listen();
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(`Hata: ${values.host}:${port} portu kullanımda. Başka bir port seçmek için --port <n> kullanın (ör. --port 4011).`);
  } else if (err?.code === 'EACCES') {
    console.error(`Hata: ${values.host}:${port} portunu dinleme izni yok. Başka bir port için --port <n> kullanın.`);
  } else {
    console.error(`Hata: mock başlatılamadı: ${err?.message ?? err}`);
  }
  process.exit(1);
}

process.stdout.write(bannerFor(base));

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
