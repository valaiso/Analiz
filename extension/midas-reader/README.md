# Analiz · Midas işlem aktarımı

Chrome ve Edge için Manifest V3 eklentisi. Midas Atlas'ta zaten açık olan oturumdan,
yalnızca ekranda görünen işlem geçmişi satırlarını okur. Parolaya, çerezlere veya
Midas'ın özel API uçlarına erişmez; ağ isteği ya da emir göndermez.

## Kurulum

1. Chrome/Edge'de `chrome://extensions` / `edge://extensions` sayfasını açın.
2. Geliştirici modunu açın ve **Paketlenmemiş öğe yükle** seçeneğini kullanın.
3. Bu klasörü seçin: `extension/midas-reader`.
4. `https://atlas.getmidas.com/` sekmesini yenileyin ve Midas'ta **Yatırım İşlem Geçmişi** sayfasını açın.
5. Analiz'i ayrı sekmede yenileyin. **İşlemler → Midas Aktarımı → Midas’tan İşlemleri Oku** düğmesine basın.
6. Önizlemede otomatik eşleşen satırları kontrol edip içe aktarımı onaylayın.

Eklenti yalnızca iki site için erişim izni ister: Midas Atlas ve Analiz GitHub Pages adresi.
İçe aktarılan işlemler `localStorage` içinde ayrı bir anahtarda tutulur; Supabase portföy
durumuna eklenmez. Uygulamanın diğer portföy verileri, kullanıcı Supabase hesabında oturum
açtıysa mevcut davranış gereği Supabase'e eşitlenir. Midas kayıtları yedek dışa aktarımına dahil edilir.

## Sınırlar

İlk sürüm, Atlas işlem geçmişinde o anda sayfaya yüklenmiş görünen satırları tarar.
Eski kayıtlar için Midas'ta tarih aralığını değiştirip geçmiş satırlarını açın. Miktar,
fiyat, tarih veya sembol satır metninden güvenle çıkarılamazsa önizlemede eksik gösterilir
ve içe aktarılmaz. Midas arayüzü değişirse içerik okuyucusunun güncellenmesi gerekebilir.
