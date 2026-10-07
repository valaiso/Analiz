// Analiz sayfası ile eklenti arasındaki dar kapsamlı kullanıcı isteği köprüsü.
// Gelen işlem verisi yalnızca açık Analiz sekmesine geri gönderilir.
window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const request = event.data;
  if (request?.channel !== 'ANALIZ_MIDAS_EXTENSION'
    || !['READ', 'LIVE_QUOTES', 'VERSION'].includes(request.type)) return;

  try {
    if (request.type === 'VERSION') {
      const version = await chrome.runtime.sendMessage({ type: 'ANALIZ_GET_MIDAS_READER_VERSION' });
      window.postMessage({
        channel: 'ANALIZ_MIDAS_EXTENSION', type: 'VERSION_RESULT',
        requestId: request.requestId, response: version,
      }, location.origin);
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: request.type === 'LIVE_QUOTES' ? 'ANALIZ_FETCH_LIVE_QUOTES' : 'ANALIZ_READ_MIDAS_HISTORY',
      codes: request.codes || [], knownCodes: request.knownCodes || [],
      localAssets: request.localAssets || [], fundCodes: request.fundCodes || [],
      cryptoOnly: request.cryptoOnly === true,
    });
    window.postMessage({
      channel: 'ANALIZ_MIDAS_EXTENSION',
      type: request.type === 'LIVE_QUOTES' ? 'LIVE_QUOTES_RESULT' : 'RESULT',
      requestId: request.requestId,
      response,
    }, location.origin);
  } catch (error) {
    window.postMessage({
      channel: 'ANALIZ_MIDAS_EXTENSION',
      type: request.type === 'VERSION' ? 'VERSION_RESULT'
        : request.type === 'LIVE_QUOTES' ? 'LIVE_QUOTES_RESULT' : 'RESULT',
      requestId: request.requestId,
      response: { ok: false, error: `Eklenti mesaj köprüsü yanıt vermedi: ${error?.message || 'bilinmeyen bağlantı hatası'}. Midas ve Analiz sekmelerini yenileyip yeniden deneyin.` },
    }, location.origin);
  }
});
