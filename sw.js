/* Bildirim servis çalışanı: günlük portföy bildirimini gösterir.
   Önbellekleme yapmaz; site her zaman ağdan yüklenir. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
