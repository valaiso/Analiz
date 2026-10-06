// Köprü yalnızca açık Midas sekmesindeki kullanıcı isteğini yönlendirir.
// Kimlik bilgisi, parola veya oturum çerezi okunmaz ya da saklanmaz.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ANALIZ_READ_MIDAS_HISTORY') return undefined;

  chrome.tabs.query({ url: 'https://atlas.getmidas.com/*' }).then(async (tabs) => {
    if (!tabs.length) {
      sendResponse({ ok: false, error: 'Önce Midas Atlas’ı açıp oturum açın.' });
      return;
    }

    const results = await Promise.all(tabs.map(async (tab) => {
      try {
        return await chrome.tabs.sendMessage(tab.id, { type: 'ANALIZ_SCAN_VISIBLE_HISTORY' });
      } catch {
        return null;
      }
    }));
    const result = results.find((item) => item?.ok && item.rows?.length);
    if (result) sendResponse(result);
    else {
      const page = results.find((item) => item?.ok);
      sendResponse(page || {
        ok: false,
        error: 'Midas sekmesi bulundu ama okunabilir işlem satırı yok. İşlem Geçmişi ekranını açıp yeniden deneyin.',
      });
    }
  }).catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
