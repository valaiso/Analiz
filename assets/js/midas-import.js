const CHANNEL = 'ANALIZ_MIDAS_EXTENSION';

/** Installed extension reads the already-open Atlas tab and returns visible rows. */
export function requestMidasHistory(knownCodes = [], localAssets = [], fundCodes = [], timeoutMs = 600_000, options = {}) {
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
        error.positions = data.response?.positions || [];
        error.positionsCaptured = data.response?.positionsCaptured === true;
        error.positionsDiagnostic = data.response?.positionsDiagnostic || null;
        error.cryptoPositions = data.response?.cryptoPositions || [];
        error.cryptoPositionsCaptured = data.response?.cryptoPositionsCaptured === true;
        error.cryptoPositionsDiagnostic = data.response?.cryptoPositionsDiagnostic || null;
        error.duplicateOrdersRemoved = Number(data.response?.duplicateOrdersRemoved) || 0;
        reject(error);
      } else resolve({
        rows: data.response.rows || [],
        scannedPages: data.response.scannedPages || 1,
        unmatchedCount: data.response.unmatchedCount || 0,
        accountSummary: data.response.accountSummary || null,
        positions: data.response.positions || [],
        positionsCaptured: data.response.positionsCaptured === true,
        positionsDiagnostic: data.response.positionsDiagnostic || null,
        cryptoPositions: data.response.cryptoPositions || [],
        cryptoPositionsCaptured: data.response.cryptoPositionsCaptured === true,
        cryptoPositionsDiagnostic: data.response.cryptoPositionsDiagnostic || null,
        duplicateOrdersRemoved: Number(data.response.duplicateOrdersRemoved) || 0,
        marketData: data.response.marketData || {},
        marketErrors: data.response.marketErrors || {},
      });
    }

    window.addEventListener('message', receive);
    window.postMessage({
      channel: CHANNEL, type: 'READ', requestId, knownCodes, localAssets, fundCodes,
      cryptoOnly: options.cryptoOnly === true,
    }, location.origin);
  });
}

/** Fetch fresh intraday quotes through the installed extension, without a Midas tab. */
export function requestMidasLiveQuotes(codes = [], timeoutMs = 20_000) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('Canlı fiyat isteği zaman aşımına uğradı.'));
    }, timeoutMs);

    function receive(event) {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (data?.channel !== CHANNEL || data.type !== 'LIVE_QUOTES_RESULT' || data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      if (!data.response?.ok) reject(new Error(data.response?.error || 'Canlı fiyatlar alınamadı.'));
      else resolve(data.response.quotes || {});
    }

    window.addEventListener('message', receive);
    window.postMessage({ channel: CHANNEL, type: 'LIVE_QUOTES', requestId, codes }, location.origin);
  });
}
