const CHANNEL = 'ANALIZ_MIDAS_EXTENSION';
const REQUIRED_READER_VERSION = '0.28.6';

function compareVersions(left, right) {
  const a = String(left || '').split('.').map((part) => Number(part) || 0);
  const b = String(right || '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function requestReaderVersion(timeoutMs = 5000) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error(`Midas eklentisinin sürümü doğrulanamadı. ${REQUIRED_READER_VERSION} paketini yükleyip Midas ve Analiz sekmelerini yenileyin.`));
    }, timeoutMs);
    function receive(event) {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (data?.channel !== CHANNEL || data.type !== 'VERSION_RESULT' || data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      const version = data.response?.extensionVersion;
      if (!data.response?.ok || !version) {
        reject(new Error('Midas eklentisinin sürümü okunamadı. Güncel paketi yükleyip Midas ve Analiz sekmelerini yenileyin.'));
      } else if (compareVersions(version, REQUIRED_READER_VERSION) < 0) {
        reject(new Error(`Yüklü Midas eklentisi ${version}; gereken sürüm ${REQUIRED_READER_VERSION}. Actions artifact'ındaki yeni paketi yükleyip Midas ve Analiz sekmelerini yenileyin.`));
      } else resolve(version);
    }
    window.addEventListener('message', receive);
    window.postMessage({ channel: CHANNEL, type: 'VERSION', requestId }, location.origin);
  });
}

/** Installed extension reads the already-open Atlas tab and returns visible rows. */
export function requestMidasHistory(knownCodes = [], localAssets = [], fundCodes = [], timeoutMs = 600_000, options = {}) {
  const requestId = crypto.randomUUID();
  return requestReaderVersion().then((extensionVersion) => new Promise((resolve, reject) => {
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
        error.ignoredStablecoinCount = Number(data.response?.ignoredStablecoinCount) || 0;
        error.extensionVersion = extensionVersion;
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
        ignoredStablecoinCount: Number(data.response.ignoredStablecoinCount) || 0,
        extensionVersion,
        marketData: data.response.marketData || {},
        marketErrors: data.response.marketErrors || {},
      });
    }

    window.addEventListener('message', receive);
    window.postMessage({
      channel: CHANNEL, type: 'READ', requestId, knownCodes, localAssets, fundCodes,
      cryptoOnly: options.cryptoOnly === true,
    }, location.origin);
  }));
}

/** Fetch fresh intraday quotes through the installed extension, without a Midas tab. */
export function requestMidasLiveQuotes(codes = [], timeoutMs = 20_000, cryptoCodes = []) {
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
    window.postMessage({ channel: CHANNEL, type: 'LIVE_QUOTES', requestId, codes, cryptoCodes }, location.origin);
  });
}
