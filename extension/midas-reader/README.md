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
4. `https://atlas.getmidas.com/` sekmesini yenileyin ve Midas'ta **Emir geçmişi** tablosunu açın.
5. Midas emir geçmişinde, eklenti son eriştiğiniz Midas sekmesindeki tablonun sayfalarını sırayla tarar ve başladığı sayfaya geri döner. Sayfa göstergesi ve oklar farklı kapsayıcılarda olsa da yalnızca göstergeyle aynı satırdaki yakın sayfalama kontrolü kullanılır.
6. Analiz'i ayrı sekmede yenileyin. **İşlemler → Midas Aktarımı → Midas’tan İşlemleri Oku** düğmesine basın.
7. Önizlemede sembol, alış/satış, tarih, adet ve fiyatı kontrol edip içe aktarımı onaylayın.

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
Pozisyonlar tablosunda “Adet” veya “Miktar” sütunu görünüyorsa açık adet, ortalama maliyet
ve sembol yerel portföy hesapları için okunur; günlük/toplam getiri hücreleri kullanılmaz.

Analiz açıkken eklenti, açık pozisyonların piyasa kotasyonlarını dakikada bir alır.
Kotasyonun piyasa tarihi bugünkü piyasa tarihiyle aynıysa günlük getiride bu kotasyon
ve önceki kapanış kullanılır. Yeni piyasa tarihli kotasyon gelene kadar son fiyat
portföy değerinde korunur; eski seansın günlük hareketi yeni güne taşınmaz.
BIST hisseleri ve işlem gören ETF'ler
son kotasyonla; TEFAS fonları site havuzundaki son yayımlanmış fiyatla değerlenir.
Kotasyon sağlayıcısı gecikmeli olabilir.
Miktar, fiyat, tarih ya da sembol güvenle okunamazsa satır içe aktarılmaz. Midas
arayüzü değişirse içerik okuyucusunun güncellenmesi gerekebilir.
Fiyat kaynağında 3 yıllık geçmiş bulunmayan yeni semboller aktarım önizlemesini
tamamlamaz; fonlarda TEFAS'ın ilgili kod için fiyat döndürmesi gerekir.
