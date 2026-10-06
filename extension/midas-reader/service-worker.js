// Köprü yalnızca açık Midas sekmesindeki kullanıcı isteğini yönlendirir.
// Kimlik bilgisi, parola veya oturum çerezi okunmaz ya da saklanmaz.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ANALIZ_READ_MIDAS_HISTORY') return undefined;

  chrome.tabs.query({ url: 'https://atlas.getmidas.com/*' }).then(async (tabs) => {
    if (!tabs.length) {
      sendResponse({ ok: false, error: 'Önce Midas Atlas’ı açıp oturum açın.' });
      return;
    }

    // Sayfalar arasında gezen okuyucu aynı anda yalnızca tek sekmeye dokunmalı.
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    try {
      const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'ANALIZ_SCAN_VISIBLE_HISTORY' });
      sendResponse(result);
    } catch {
      sendResponse({
        ok: false,
        error: 'Midas sekmesindeki okuyucuya ulaşılamadı. Midas sekmesini yenileyip tekrar deneyin.',
      });
    }
  }).catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
