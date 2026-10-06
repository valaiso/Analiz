// Analiz sayfası ile eklenti arasındaki dar kapsamlı kullanıcı isteği köprüsü.
// Gelen işlem verisi yalnızca açık Analiz sekmesine geri gönderilir.
window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const request = event.data;
  if (request?.channel !== 'ANALIZ_MIDAS_EXTENSION' || request.type !== 'READ') return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'ANALIZ_READ_MIDAS_HISTORY',
      knownCodes: request.knownCodes || [], localAssets: request.localAssets || [],
      fundCodes: request.fundCodes || [],
    });
    window.postMessage({
      channel: 'ANALIZ_MIDAS_EXTENSION',
      type: 'RESULT',
      requestId: request.requestId,
      response,
    }, location.origin);
  } catch (error) {
    window.postMessage({
      channel: 'ANALIZ_MIDAS_EXTENSION',
      type: 'RESULT',
      requestId: request.requestId,
      response: { ok: false, error: 'Eklenti yanıt vermedi. Eklentiyi yenileyip yeniden deneyin.' },
    }, location.origin);
  }
});
