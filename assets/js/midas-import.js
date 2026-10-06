const CHANNEL = 'ANALIZ_MIDAS_EXTENSION';

/** Installed extension reads the already-open Atlas tab and returns visible rows. */
export function requestMidasHistory(knownCodes = [], localAssets = [], timeoutMs = 600_000) {
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
      if (!data.response?.ok) {
        const error = new Error(data.response?.error || 'Midas geçmişi okunamadı.');
        error.accountSummary = data.response?.accountSummary || null;
        reject(error);
      } else resolve({
        rows: data.response.rows || [],
        scannedPages: data.response.scannedPages || 1,
        unmatchedCount: data.response.unmatchedCount || 0,
        accountSummary: data.response.accountSummary || null,
        marketData: data.response.marketData || {},
        marketErrors: data.response.marketErrors || {},
      });
    }

    window.addEventListener('message', receive);
    window.postMessage({ channel: CHANNEL, type: 'READ', requestId, knownCodes, localAssets }, location.origin);
  });
}
