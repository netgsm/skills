/**
 * Test hesapları. 8500000000–8500000005 Netgsm Identity sandbox'ının demo hesaplarıyla
 * (kullanıcı adı, şifre, user_id, ad soyad, davranış) birebir aynıdır; 8500000006 ve sonrası
 * yalnızca mock'ta vardır. Her giriş bilgisi ya ana hesap (subUserId 0) ya da bir alt kullanıcıdır.
 */

const DEFAULTS = {
  apiAccess: true, ipAllowed: true, countryAllowed: true, active: true,
  activations: { send: true, receive: true, other: true },
  operatorOk: true, international: true, iysMode: true, duplicatesAllowed: false, otpCredit: true,
  // Kurumsal OTP hizmeti tanımlı hesap: POST /send/otp'ta `x-client: enterprise` göndermelidir.
  enterpriseOtp: false,
  balance: 'prepaid',
};

const main = password => [{ password, subUserId: 0 }];

/**
 * GET /sms/v3/balance verisi. `assets`: varlık türleri; bir türün
 * birden fazla kaydı (`amounts`) toplanıp sayı, tek kaydı metin olarak döner. `service`: türün ait olduğu
 * hizmet grubu (`?service=`). `sendService`: SMS gönderim hizmetinin varlığıdır; `service` verilmediğinde
 * dönen listede yer alır (bu liste `service=sms` ile aynı değildir: OTP SMS paketlerini de içerir). `credit`: TL kredi. `postpaid`: faturalı hesap (`stip=2` her zaman "0").
 * Değerler sabittir; mock gönderimlerde bakiye düşmez.
 */
export const BALANCES = {
  // Spec'teki stip=3 örneğiyle aynı: faturasız, kredi var.
  prepaid: () => ({
    postpaid: false,
    credit: 92.15,
    assets: [
      { name: 'Adet SMS', service: 'sms', sendService: true, amounts: [200, 77] },
      { name: 'Adet OTP SMS', service: 'otp', sendService: true, amounts: [767] },
      { name: 'Dakika', service: 'ses', sendService: true, amounts: [242] },
    ],
  }),
  // Faturasız, kredi yok, SMS paketi var: stip=2 `type: AdetSMS` döner.
  smsOnly: () => ({
    postpaid: false,
    credit: 0,
    assets: [{ name: 'Adet SMS', service: 'sms', sendService: true, amounts: [1500] }],
  }),
  // Faturalı: stip=2 her zaman "0".
  postpaid: () => ({
    postpaid: true,
    credit: 0,
    assets: [{ name: 'Adet OTP SMS', service: 'otp', sendService: true, amounts: [5000] }],
  }),
  // Faturasız, ne kredi ne paket: stip=2 yalnızca `code` döner, liste boştur.
  empty: () => ({ postpaid: false, credit: 0, assets: [] }),
};

export const SEED_ACCOUNTS = [
  // --- Identity sandbox ile aynı hesaplar ---
  { username: '8500000000', userId: 900001, firstName: 'Demo', lastName: 'Aktif', credentials: main('password001') },
  { username: '8500000001', userId: 900002, firstName: 'Demo', lastName: 'Aktivasyonsuz', credentials: main('password002'),
    activations: { send: false, receive: false, other: false } },
  { username: '8500000002', userId: 900003, firstName: 'Demo', lastName: 'IP', credentials: main('password003'), ipAllowed: false },
  { username: '8500000003', userId: 900004, firstName: 'Demo', lastName: 'Ana Hesap',
    credentials: [{ password: 'password004', subUserId: 4001, subFirstName: 'Demo', subLastName: 'Alt Kullanıcı', servicePermission: false }] },
  { username: '8500000004', userId: 900005, firstName: 'Demo', lastName: 'API', credentials: main('password005'), apiAccess: false },
  { username: '8500000005', userId: 900006, firstName: 'Demo', lastName: 'Pasif', credentials: main('password006'), active: false },
  // --- Yalnızca mock ---
  { username: '8500000006', userId: 900007, firstName: 'Mock', lastName: 'Operatör', credentials: main('password007'), operatorOk: false },
  { username: '8500000007', userId: 900008, firstName: 'Mock', lastName: 'Ülke', credentials: main('password008'), countryAllowed: false },
  { username: '8500000008', userId: 900009, firstName: 'Mock', lastName: 'İYS', credentials: main('password009'),
    international: false, iysMode: false, otpCredit: false, balance: 'smsOnly' },
  { username: '8500000009', userId: 900010, firstName: 'Mock', lastName: 'Ana Hesap', credentials: [
    { password: 'password010', subUserId: 0 },
    { password: 'password011', subUserId: 1, subFirstName: 'API', subLastName: 'Kullanıcı', servicePermission: true },
  ], balance: 'empty' },
  { username: '8500000010', userId: 900011, firstName: 'Demo', lastName: 'Kurumsal OTP', credentials: main('password012'),
    enterpriseOtp: true, balance: 'postpaid' },
];

function buildAccount(seed) {
  const s = { ...DEFAULTS, ...seed };
  const sender = (name, type, usable, reason, brandCode = 0) => ({ name, type, brandCode, usable, reason });
  return {
    id: s.username,
    userId: s.userId,
    username: s.username,
    subscriberCode: s.username,
    firstName: s.firstName,
    lastName: s.lastName,
    email: `${s.username}@sandbox.example.com`,
    apiAccess: s.apiAccess,
    ipAllowed: s.ipAllowed,
    countryAllowed: s.countryAllowed,
    active: s.active,
    activations: { ...s.activations },
    operatorOk: s.operatorOk,
    international: s.international,
    iysMode: s.iysMode,
    duplicatesAllowed: s.duplicatesAllowed,
    otpCredit: s.otpCredit,
    enterpriseOtp: s.enterpriseOtp,
    balance: BALANCES[s.balance](),
    // TESTHEADER: SMS sandbox'ının sabit başlığı; sandbox'a geçen kod başlık değiştirmeden çalışsın diye.
    senders: [
      sender('MOCKTEST', 'ALPHANUMERIC', true, null, s.iysMode ? 4567 : 0),
      sender('TESTHEADER', 'ALPHANUMERIC', true, null, s.iysMode ? 4567 : 0),
      sender('MOCKKAPALI', 'ALPHANUMERIC', false, 'ROUTING_CODE_MISSING'),
      sender(s.username, 'SUBSCRIBER_NUMBER', true, null),
    ],
    defaultSender: 'MOCKTEST',
    // SMS sandbox'ının kara listesi. Liste en yeniden eskiye döner: GET /blacklist 5000000001, 5000000002.
    blacklist: ['5000000002', '5000000001'],
    templates: [
      // SMS sandbox'ının tek şablonu (aynı kimlik, içerik ve parametreler)
      {
        templateId: 1,
        content: 'Merhaba ${name}, kodunuz ${code}',
        type: 'AUTH_OTP',
        description: 'Sandbox template',
        public: true,
        parameters: [{ name: 'name', type: 'TEXT', maxLength: 50 }, { name: 'code', type: 'TEXT', maxLength: 10 }],
        createdAt: '2026-01-01T12:00:00+03:00',
      },
      {
        templateId: 3,
        content: 'Dogrulama kodunuz: ${otpCode}',
        type: 'AUTH_OTP',
        description: 'Doğrulama kodu',
        public: false,
        parameters: [{ name: 'otpCode', type: 'BIGINT', maxLength: null }],
        createdAt: '2026-05-18T11:25:12.502+03:00',
      },
      {
        templateId: 4,
        content: 'Siparisiniz kargoya verildi.',
        type: 'SERVICE_ALERT',
        description: 'Kargo bilgilendirme',
        public: true,
        parameters: [],
        createdAt: '2026-03-02T09:00:00.000+03:00',
      },
      {
        templateId: 5,
        content: 'Randevunuz ${date} tarihinde. Not: ${note}',
        type: 'SERVICE_ALERT',
        description: 'Randevu hatırlatma',
        public: false,
        parameters: [{ name: 'date', type: 'DATE', maxLength: null }, { name: 'note', type: 'TEXT', maxLength: 30 }],
        createdAt: '2026-01-10T09:00:00.000+03:00',
      },
    ],
    // rehber: hesap başına tek grup
    directory: {
      groups: [{
        groupId: 7,
        name: 'Müşteriler',
        contacts: [
          { number: '905061230001', name: 'Ali', surname: 'Veli', address: 'Sayın' },
          { number: '905061230002', name: 'Ayşe', surname: 'Yılmaz', address: 'Sayın' },
          { number: '905061230003', name: 'Can', surname: 'Demir', address: 'Sayın' },
        ],
      }],
    },
  };
}

/**
 * @typedef {{ accountId: string, identity: 'main' | `sub:${number}`, subUserId: number,
 *   subUser: { id: number, first_name: string, last_name: string } | null, smsPermission: boolean }} Login
 */
export function createAccountStore(seed = SEED_ACCOUNTS) {
  const accounts = new Map();
  const credentials = new Map(); // accountId -> giriş bilgileri
  for (const item of seed) {
    const acc = buildAccount(item);
    accounts.set(acc.id, acc);
    credentials.set(acc.id, item.credentials ?? []);
  }
  return {
    /** @returns {Login | null} */
    login(username, password) {
      const acc = accounts.get(username);
      const c = acc && credentials.get(acc.id).find(x => x.password === password);
      if (!c) return null;
      if (c.subUserId === 0) return { accountId: acc.id, identity: 'main', subUserId: 0, subUser: null, smsPermission: true };
      return {
        accountId: acc.id, identity: `sub:${c.subUserId}`, subUserId: c.subUserId,
        subUser: { id: c.subUserId, first_name: c.subFirstName, last_name: c.subLastName },
        smsPermission: c.servicePermission,
      };
    },
    get(accountId) { return accounts.get(accountId); },
  };
}
