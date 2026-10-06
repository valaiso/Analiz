# Analiz · Midas işlem aktarımı

Chrome ve Edge için Manifest V3 eklentisi. Midas Atlas'ta zaten açık olan oturumdan,
yalnızca ekranda görünen işlem geçmişi satırlarını okur. Parolaya, çerezlere veya
Midas'ın özel API uçlarına erişmez; ağ isteği ya da emir göndermez.
Eklenti simgesi proje kökündeki `iconV1.png` görselini kullanır.

## Kurulum

1. Chrome/Edge'de `chrome://extensions` / `edge://extensions` sayfasını açın.
2. Geliştirici modunu açın ve **Paketlenmemiş öğe yükle** seçeneğini kullanın.
3. Bu klasörü seçin: `extension/midas-reader`.
4. `https://atlas.getmidas.com/` sekmesini yenileyin ve Midas'ta **Emir geçmişi** tablosunu açın.
5. Midas emir geçmişinde, eklenti son eriştiğiniz Midas sekmesindeki tablonun sayfalarını sırayla tarar ve başladığı sayfaya geri döner. Sayfa göstergesi ve oklar farklı kapsayıcılarda olsa da yalnızca göstergeyle aynı satırdaki yakın sayfalama kontrolü kullanılır.
6. Analiz'i ayrı sekmede yenileyin. **İşlemler → Midas Aktarımı → Midas’tan İşlemleri Oku** düğmesine basın.
7. Önizlemede sembol, alış/satış, tarih, adet ve fiyatı kontrol edip içe aktarımı onaylayın.

Eklenti yalnızca iki site için erişim izni ister: Midas Atlas ve Analiz GitHub Pages adresi.
İçe aktarılan işlemler `localStorage` içinde ayrı bir anahtarda tutulur; Supabase portföy
durumuna eklenmez. Uygulamanın diğer portföy verileri, kullanıcı Supabase hesabında oturum
açtıysa mevcut davranış gereği Supabase'e eşitlenir. Midas kayıtları yedek dışa aktarımına dahil edilir.

## Sınırlar

Eklenti yalnızca emir tablosunda durumu **Gerçekleşti/Tamamlandı** olan satırları alır;
bekleyen, iptal edilmiş ve kısmi emirleri atlar. Eklenti yalnızca sayfalama oklarını
kullanır; alım/satım emirlerine dokunmaz. Midas'ın açık olan tablo aralığındaki tüm
sayfalar taranır.
Miktar, fiyat, tarih ya da sembol güvenle okunamazsa satır içe aktarılmaz. Midas
arayüzü değişirse içerik okuyucusunun güncellenmesi gerekebilir.
