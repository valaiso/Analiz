const CHANNEL = 'ANALIZ_MIDAS_EXTENSION';

/** Installed extension reads the already-open Atlas tab and returns visible rows. */
export function requestMidasHistory(timeoutMs = 45_000) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('Eklentiden yanıt gelmedi. Eklentiyi kurup yenilediğinden emin ol.'));
    }, timeoutMs);

    function receive(event) {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (data?.channel !== CHANNEL || data.type !== 'RESULT' || data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      if (!data.response?.ok) reject(new Error(data.response?.error || 'Midas geçmişi okunamadı.'));
      else resolve(data.response.rows || []);
    }

    window.addEventListener('message', receive);
    window.postMessage({ channel: CHANNEL, type: 'READ', requestId }, location.origin);
  });
}
