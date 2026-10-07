# Analiz · Midas işlem aktarımı

Chrome ve Edge için Manifest V3 eklentisi. Midas Atlas'ta zaten açık olan oturumdan,
yalnızca ekranda görünen işlem geçmişi satırlarını okur. Parolaya, çerezlere veya
Midas'ın özel API uçlarına erişmez; ağ isteği ya da emir göndermez.
Eklenti simgesi proje kökündeki `iconV1.png` görselini kullanır.

Midas satırlarında bulunan ve Analiz'in yayımlanmış fiyat havuzunda olmayan semboller
için kullanıcı **Midas’tan İşlemleri Oku** dediğinde açık alış döneminin başlangıcından
itibaren günlük fiyat aranır. Bu tarih Midas işlem geçmişinden çıkarılamazsa üç yıllık
geçmiş kullanılır.
Borsa kodları Yahoo Finance'tan, Midas satırında `Fon` olarak tanınan kayıtlar TEFAS'tan
alınır. Bulunan geçmiş ve varlık bilgisi yalnızca Analiz'in bu tarayıcıdaki yerel
havuzuna eklenir; GitHub Pages'teki ortak dosyalar değiştirilmez. Her sembol için geçmiş
bulunmadan aktarım onayı açılmaz.
Ek fiyat geçmişi hesaba özel havuzda tutulur ve işlem alış tarihinden önceki noktalar
saklanmaz. Varlık tamamen satıldığında, Midas eşitlemesi bu durumu gördüğünde o varlığa
ait Midas işlem geçmişini ve hesaba özel ek fiyat geçmişini temizler. Kısmi satışta
mevcut alış dönemi korunur. Varlık yeniden alınırsa yeni alış tarihiyle yeni dönem başlar.
Analiz'in GitHub Pages'te yayımlanan genel fiyat dosyaları bu temizlikten etkilenmez.
Yahoo Finance varlık türü ve şirket/ETF adını sağlarsa yabancı ETF'ler “Yabancı ETF”
olarak etiketlenir ve ekranda sağlayıcının tam adı kullanılır.

## Kurulum

1. Chrome/Edge'de `chrome://extensions` / `edge://extensions` sayfasını açın.
2. Geliştirici modunu açın ve **Paketlenmemiş öğe yükle** seçeneğini kullanın.
3. Bu klasörü seçin: `extension/midas-reader`.
4. Eklentiyi güncelledikten sonra açık **Analiz** ve `https://atlas.getmidas.com/` sekmelerini yenileyin. Analiz köprüsü de açık sekmeye içerik betiği olarak yüklenir.
5. Midas'ın yatırım görünümünde **Pozisyonlar** ve **Emir geçmişi** tablolarını açın.
6. Analiz sekmesinde **İşlemler → Midas Aktarımı → Midas’tan İşlemleri Oku** düğmesine basın. Güncel hisse/fon adetleri yalnızca Pozisyonlar tablosundan alınır; emir geçmişi açık pozisyon kanıtı olarak kullanılmaz.
7. Midas'ın **Kripto** görünümüne geçip Kripto **Pozisyonlar** ve **Emir geçmişi** tablolarını açın; Analiz'de **Kripto Emirlerini Oku** düğmesine basın. Kripto açık varlıkları yatırım hesabından ayrı kaydedilir. Emir çiftlerinde (ör. ETH/USDT) sembol, çiftin ilk varlığıdır; USDT/USDC tek başına açık pozisyon sayılmaz.
8. Önizlemede emir sembolü, alış/satış, tarih, adet ve fiyatı kontrol edip içe aktarımı onaylayın.

Güncel paket sürümü `0.28.6`'dır. Kod GitHub'a gönderildiğinde Actions içindeki **Midas eklentisini paketle** işi, yüklenebilir ZIP'i `midas-reader-v0.28.6` adlı artifact olarak üretir. ZIP'i indirip boş bir klasöre açın; Chrome/Edge uzantılar sayfasında **Paketlenmemiş öğe yükle** ile içindeki dosyaların bulunduğu klasörü seçin. Eski paket görünüyorsa Yenile aynı eski klasörü tekrar yükler; yeni artifact klasörünü kullanıp Midas ve Analiz sekmelerini yenileyin. Aktarım günlüğü okuyucu sürümünü de yazar.

Eklenti Midas Atlas ve Analiz GitHub Pages adreslerinin yanı sıra Yahoo Finance ve
TEFAS fiyat kaynaklarına erişim izni ister.
İçe aktarılan işlemler `localStorage` içinde ayrı bir anahtarda tutulur; Supabase portföy
durumuna eklenmez. Uygulamanın diğer portföy verileri, kullanıcı Supabase hesabında oturum
açtıysa mevcut davranış gereği Supabase'e eşitlenir. Midas kayıtları yedek dışa aktarımına dahil edilir.

## Sınırlar

Eklenti yalnızca emir tablosunda durumu **Gerçekleşti/Tamamlandı** olan satırları alır;
bekleyen, iptal edilmiş ve kısmi emirleri atlar. Eklenti yalnızca sayfalama oklarını
kullanır; alım/satım emirlerine dokunmaz. Midas'ın açık olan tablo aralığındaki tüm
sayfalar taranır.
Yatırım ve kripto Pozisyonlar tablolarındaki sembol, adet, fiyat ve ortalama maliyet
yerel portföyün açık pozisyon kaynağıdır. Midas tablosundaki fiyat, eski yerel fiyat
geçmişiyle ezilmez. Yatırım hesabının toplamı ve kripto pozisyon değerleri ayrı okunur.
Emir geçmişindeki semboller canlı pozisyon tablosunda bulunmuyorsa panelde açık varlık
olarak gösterilmez. Okuma başarısız olursa son doğrulanmış pozisyon verisi korunur ve
panelde son taramanın başarısız olduğu belirtilir; eski aktarım biçimindeki pozisyonlar
canlı Midas verisi kabul edilmez.

Analiz açıkken eklenti, açık pozisyonların piyasa kotasyonlarını dakikada bir alır.
BIST ve ABD kotasyonları ayrı ayrı kendi piyasa tarihine ve sağlayıcının bildirdiği
normal seans aralığına göre değerlendirilir; saatler koda sabit yazılmaz. Güncel seans kotasyonu varsa günlük getiri önceki
kapanıştan hesaplanır. Önceki seans fiyatı toplam değerlemede korunur, ancak eski
seansın günlük hareketi yeni güne taşınmaz. Seans açıkken kotasyon 30 dakikadan eskiyse
günlük kazanç hesabına katılmaz; toplam değer için son fiyat saklanır ve panelde sembol
ile kotasyon yaşı gösterilir. TEFAS fonları site havuzundaki son yayımlanmış fiyatla
değerlenir.
Kotasyon sağlayıcısı gecikmeli olabilir.
Miktar, fiyat, tarih ya da sembol güvenle okunamazsa satır içe aktarılmaz. Midas
arayüzü değişirse içerik okuyucusunun güncellenmesi gerekebilir.
Fiyat kaynağında 3 yıllık geçmiş bulunmayan yeni semboller aktarım önizlemesini
tamamlamaz; fonlarda TEFAS'ın ilgili kod için fiyat döndürmesi gerekir.
