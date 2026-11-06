// Kasıtlı olarak HATALI örnek entegrasyon. /sms-review komutunu denemek için kullanılır.
// Asla çalıştırılmaz; bu dosyadaki kalıpları kopyalamayın.
//
// Planlı 8 sorun (satır numaraları bu başlık dahil dosyaya göredir):
//  1. İstemciye açılan kimlik bilgisi (NEXT_PUBLIC_*)      : satır 17-18
//  2. Token önbelleği yok, her gönderimde yeniden giriş    : satır 31
//  3. Alıcı başına tek /send (döngüde tek kayıt)           : satır 32, 54-58
//  4. 503 sonrası kontrolsüz tekrar (çift gönderim riski)  : satır 39
//  5. 429'da Retry-After yok sayılıp sabit bekleme         : satır 40-43
//  6. 401'de yeniden giriş yok, requestId loglanmıyor      : satır 44-47
//  7. 202 yanıtındaki rejectedItems işlenmiyor             : satır 48-49
//  8. /report için sık aralıklı polling (webhook yerine)   : satır 60-66

const AUTH_URL = 'https://ext-api.netgsm.com.tr/auth/v3';
const SMS_URL = 'https://ext-api.netgsm.com.tr/sms/v3';

const USERNAME = process.env.NEXT_PUBLIC_NETGSM_USERNAME ?? '';
const PASSWORD = process.env.NEXT_PUBLIC_NETGSM_PASSWORD ?? '';

async function login(): Promise<string> {
  const res = await fetch(`${AUTH_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD, scope: 'sms' }),
  });
  const data = await res.json();
  return data.access_token as string;
}

async function sendOne(to: string, text: string): Promise<void> {
  const token = await login();
  const body = JSON.stringify({ sender: 'MOCKTEST', messages: [{ recipient: to, text }] });
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${SMS_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    });
    if (res.status === 503) continue;
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok) {
      console.error('SMS gönderilemedi', res.status);
      return;
    }
    const data = await res.json();
    console.log('gönderildi', data.jobId);
    return;
  }
}

export async function notifyAll(recipients: string[], text: string): Promise<void> {
  for (const to of recipients) {
    await sendOne(to, text);
  }
}

export function watchReport(jobId: string, token: string): void {
  setInterval(async () => {
    const res = await fetch(`${SMS_URL}/report?jobIds=${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(await res.json());
  }, 5000);
}
