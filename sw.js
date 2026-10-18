/* Servis çalışanı: günlük portföy bildirimini gösterir ve sitenin her açılışta
   güncel sürümle yüklenmesini sağlar. Önbellek tutmaz. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// iPhone ana ekran uygulaması HTML/CSS/JS dosyalarını uzun süre önbellekte
// tutup eski sürümü açabiliyor. Sitenin kendi dosyaları her istekte sunucuya
// sorulur (değişmediyse 304 döner, hızlıdır); ağ yoksa tarayıcı önbelleği kullanılır.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/Analiz/')) return;
  event.respondWith(fetch(new Request(request, { cache: 'no-cache' })).catch(() => fetch(request)));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Portföy', {
    body: data.body || '',
    icon: '/Analiz/iconV1.png',
    badge: '/Analiz/iconV1.png',
    tag: data.tag || 'gunluk-portfoy',
    renotify: true,
    data: { url: data.url || '/Analiz/#panel' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/Analiz/#panel';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => client.url.includes('/Analiz/'));
    if (open) return open.focus().then(() => open.navigate?.(url));
    return self.clients.openWindow(url);
  }));
});
