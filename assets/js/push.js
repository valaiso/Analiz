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
  await saveSubscription(sub);
  window.dispatchEvent(new Event('pushchange'));
  return sub;
}

async function saveSubscription(sub) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Önce hesabına giriş yap.');
  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: user.id,
    endpoint: sub.endpoint,
    subscription: sub.toJSON(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if (error) throw new Error(`Abonelik hesaba kaydedilemedi: ${error.message}`);
}

/**
 * İzin verilmiş ve abonelik varsa her açılışta hesaba yeniden yazar. iPhone
 * aboneliği yenileyebilir ya da ilk kayıt ağ hatasıyla kaybolmuş olabilir.
 * Döner: hesapta kayıtlı cihaz sayısı (bilinmiyorsa null).
 */
export async function syncPushSubscription() {
  // Servis çalışanı her açılışta güncellenir; site dosyalarını da güncel tutan odur.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE, updateViaCache: 'none' })
      .then((reg) => reg.update()).catch(() => {});
  }
  if (!pushSupported() || Notification.permission !== 'granted') return registeredDeviceCount();
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) await saveSubscription(sub);
  return registeredDeviceCount();
}

export async function registeredDeviceCount() {
  // TEFAS Quant'ın aylık rapor abonelikleri (subscription.app) sayılmaz
  const { count, error } = await supabase.from('push_subscriptions').select('endpoint', { count: 'exact', head: true })
    .is('subscription->>app', null);
  return error ? null : count;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
  window.dispatchEvent(new Event('pushchange'));
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

const BELL = '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>';
const bellIcon = (on) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BELL}${on ? '' : '<path d="M3 3l18 18"/>'}</svg>`;

/**
 * Telefonda üst çubuktaki zil: günlük bildirimin açık olup olmadığını gösterir, dokununca açar/kapatır.
 * Açılamıyorsa (ana ekran uygulaması değil, izin reddedilmiş) nedenini söyler ve Ayarlar'a götürür.
 */
export function initPushButton(btn, toast) {
  if (!btn) return;
  const paint = async () => {
    const status = await pushStatus().catch(() => 'unsupported');
    const on = status === 'on';
    btn.innerHTML = bellIcon(on);
    btn.classList.toggle('is-on', on);
    const label = on ? 'Günlük bildirim açık' : 'Günlük bildirim kapalı';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(on));
    return status;
  };
  btn.addEventListener('click', async () => {
    // Durum eşzamanlı belirlenir: iPhone izin penceresini yalnızca dokunuşun hemen ardından açar
    const status = isIOS() && !isStandaloneApp() ? 'needs-home-screen' : !pushSupported() ? 'unsupported'
      : Notification.permission === 'denied' ? 'denied' : btn.classList.contains('is-on') ? 'on' : 'off';
    if (status === 'needs-home-screen' || status === 'unsupported' || status === 'denied') {
      toast({
        'needs-home-screen': 'Bildirim için Analiz’i ana ekrandaki simgeden aç (Ayarlar’da adımlar var).',
        unsupported: 'Bu cihaz bildirimleri desteklemiyor (iPhone’da iOS 16.4 veya üstü gerekir).',
        denied: 'Bildirim izni kapalı: iPhone Ayarlar → Bildirimler → Analiz.',
      }[status]);
      location.hash = 'ayarlar';
      return;
    }
    btn.disabled = true;
    try {
      if (status === 'on') {
        await disablePush();
        toast('Günlük bildirim kapatıldı');
      } else {
        await enablePush();
        toast('Günlük bildirim açıldı · her işlem günü 18:00');
      }
    } catch (error) {
      toast(error.message || 'Bildirim ayarlanamadı');
    } finally {
      btn.disabled = false;
      await paint();
    }
  });
  window.addEventListener('pushchange', paint);
  void paint();
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
