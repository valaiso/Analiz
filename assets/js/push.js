/* Günlük portföy bildirimi (Web Push). Telefon aboneliği Supabase'e yazılır;
   her işlem günü 18:00'de GitHub Actions bildirimi gönderir. iPhone'da yalnızca
   ana ekrana eklenmiş uygulamadan açılabilir (iOS 16.4+). */
import { supabase } from './supabase-client.js';

const VAPID_PUBLIC_KEY = 'BCqEzXeK-J1lFgWvYoOmd1SnveNzmq1L-Ch_IalHNbSeRc79o0fJ7bUAIbMn42ZAcqc0wqfOHMzW4gmN2AZ6yQQ';
const SW_URL = '/Analiz/sw.js';
const SW_SCOPE = '/Analiz/';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const isStandaloneApp = () => window.matchMedia?.('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function keyToBytes(base64url) {
  const padded = `${base64url}${'='.repeat((4 - base64url.length % 4) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function registration() {
  return navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
}

/** Bu cihaz için bildirim durumu: 'unsupported' | 'needs-home-screen' | 'denied' | 'on' | 'off'. */
export async function pushStatus() {
  if (isIOS() && !isStandaloneApp()) return 'needs-home-screen';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** İzin ister, aboneliği oluşturur ve hesaba kaydeder. Düğmeye basınca çağrılmalı. */
export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Bildirim izni verilmedi.');
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(VAPID_PUBLIC_KEY) });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Önce hesabına giriş yap.');
  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: user.id,
    endpoint: sub.endpoint,
    subscription: sub.toJSON(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if (error) throw new Error(`Abonelik hesaba kaydedilemedi: ${error.message}`);
  return sub;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}

/** İzin ve servis çalışanı doğru mu diye telefonda hemen bir deneme bildirimi gösterir. */
export async function testNotification() {
  const reg = await registration();
  await navigator.serviceWorker.ready;
  await reg.showNotification('🟢 Portföy bugün +%1,25', {
    body: 'Deneme bildirimi · her işlem günü 18:00’de gerçek değişim gelir',
    icon: '/Analiz/iconV1.png',
    // Aynı etiketli bildirim Chrome'da sessizce yer değiştirir; her denemeye yeni etiket.
    tag: `deneme-${Date.now()}`,
  });
}

/** Sorun giderme için kısa tanı satırı: neden açılamadığını gösterir. */
export function pushDiagnostics() {
  const ios = isIOS() ? navigator.userAgent.match(/OS (\d+)[_.](\d+)/) : null;
  const parts = [
    ios ? `iOS ${ios[1]}.${ios[2]}` : navigator.userAgent.includes('Windows') ? 'Windows' : 'tarayıcı',
    `uygulama modu: ${isStandaloneApp() ? 'evet' : 'hayır'}`,
    `bildirim desteği: ${'Notification' in window ? 'var' : 'yok'}`,
    `push desteği: ${'PushManager' in window ? 'var' : 'yok'}`,
    `izin: ${'Notification' in window ? { granted: 'verildi', denied: 'reddedildi', default: 'sorulmadı' }[Notification.permission] : '—'}`,
  ];
  return parts.join(' · ');
}
