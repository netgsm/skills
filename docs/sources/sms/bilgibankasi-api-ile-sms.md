# API ile SMS Gönderimi (Bilgi Bankası)

Kaynak: https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/api-ile-sms
Bilgi bankası makalesinin 2026-10-30 tarihli metni. Ekran görüntüleri dahil değildir.

---

API ile SMS gönderimi yapabilmek için öncelikle API alt kullanıcısı oluşturmanız ve API erişim izninizi aktifleştirmeniz gerekmektedir. Aşağıdaki adımları takip ederek işlemlerinizi tamamlayabilirsiniz.

SMS gönderimi yapabilmek için;

- Hesabınızda onaylı gönderici adı (Başlık) tanımlı olması gerekmektedir. (https://bilgibankasi.netgsm.com.tr/sms/toplu-sms/gonderici-adi-talebi)
- Hesabınıza SMS paketi tanımlamanız gerekmektedir. (https://www.netgsm.com.tr/fiyatlar/toplu-sms)

## 1. API Alt Kullanıcısı Oluşturma

- Online İşlemler üzerinden Abonelik İşlemleri > Alt Kullanıcı Hesapları menüsüne giriş yapınız ve Yeni Kayıt butonuna tıklayınız.
- Açılan ekranda alt kullanıcı türü olarak mutlaka API Kullanıcısı seçeneğini işaretleyiniz ve İleri butonuna tıklayınız.
- Bir sonraki ekranda yer alan bilgileri eksiksiz şekilde doldurunuz. Kimlik doğrulama işlemleri nedeniyle girilen bilgilerin, kimlik belgesindeki bilgiler ile birebir aynı olması gerekmektedir. Bilgileri girdikten sonra İleri butonuna tıklayarak devam ediniz.
- Yetkilendirme ekranında, alt kullanıcının erişmesini istediğiniz API servislerini seçmeniz gerekmektedir. SMS gönderimi işlemleri için SMS hizmetini işaretleyiniz ve Kaydet butonuna tıklayınız.
- Karşınıza çıkan API Kullanacak Uygulama seçimi ekranında uygulama adınızı aratarak seçebilir, listede bulunmaması durumunda manuel olarak ekleyebilir veya uygulama seçmeden devam edebilirsiniz.
- Son adımda, sisteme kayıtlı GSM numaranıza gönderilen doğrulama kodunu girip Devam Et butonuna tıklayınız. Bu işlemin ardından API alt kullanıcınız oluşturulacaktır.

## 2. API Erişimini Aktifleştirme

- API servisleri üzerinden işlem yapabilmeniz için API erişim izninizin aktif olması gerekmektedir.
- Doğrulama kodunu girdikten sonra açılan ekranda yer alan "API ile hesap erişimini onaylıyorum" kutucuğunu işaretleyiniz ve Devam Et butonuna tıklayınız.
- API İşlemleri ekranında gerekli bilgileri doldurduktan sonra Aktifleştir butonuna tıklayarak API erişiminizi aktif hâle getirebilirsiniz.

NOT: API ile SMS gönderimi için gerekli dokümanlara Netgsm API Dokümantasyonu (https://www.netgsm.com.tr/dokuman/#api-dokumani) adresinden ulaşabilirsiniz.

## Bilgilendirme

API entegrasyonu sırasında yazılımınızda aşağıdaki bilgilerin tanımlanması gerekmektedir.

- Kullanıcı Adı (User Name): Netgsm abone numarası
- Şifre (Password): Oluşturulan API alt kullanıcısı şifresi
- Gönderici Adı (Originator): Onaylı gönderici adı

Alt kullanıcı şifrenizi unutmanız durumunda, ilgili alt kullanıcının yanında bulunan Düzenle butonu üzerinden yeni şifre oluşturabilirsiniz.
