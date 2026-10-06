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
      if (!result?.ok) {
        sendResponse(result);
        return;
      }
      const known = new Set((message.knownCodes || []).map((code) => String(code).toUpperCase()));
      const positionCodes = new Set((result.positions || [])
        .map((position) => String(position.code || '').toUpperCase()).filter(Boolean));
      const positionsRead = positionCodes.size > 0;
      const missingRows = (result.rows || [])
        .filter((row) => !row.missing?.length && row.code && !known.has(String(row.code).toUpperCase())
          && (!positionsRead || positionCodes.has(String(row.code).toUpperCase())));
      const missingPositionCodes = (result.positions || [])
        .filter((position) => position.code && !known.has(String(position.code).toUpperCase()))
        .map((position) => String(position.code).toUpperCase());
      const missingCodes = [...new Set([
        ...missingRows.map((row) => String(row.code).toUpperCase()),
        ...missingPositionCodes,
      ])];
      const cycleStarts = activePurchaseStarts(result.rows || []);
      const fundCodes = new Set([...(message.fundCodes || []).map((code) => String(code).toUpperCase()), ...missingRows
        .filter((row) => /\bfon\s+(?:alış|alım|satış|satım)\b/i.test(row.rawText || ''))
        .map((row) => String(row.code).toUpperCase())]);
      const marketData = {};
      const marketErrors = {};
      for (const code of missingCodes) {
        try {
          const asset = await fetchAssetHistory(code, fundCodes.has(code), '3y', cycleStarts[code] || '');
          if (asset) marketData[code] = asset;
          else marketErrors[code] = 'Yahoo Finance veya TEFAS 3 yıllık geçmiş döndürmedi.';
        } catch (error) {
          marketErrors[code] = error.message || 'Fiyat geçmişi alınamadı.';
        }
      }
      for (const localAsset of message.localAssets || []) {
        const code = String(localAsset.code || '').toUpperCase();
        if (!code || marketData[code]) continue;
        try {
          const asset = await fetchAssetHistory(code, localAsset.source === 'TEFAS', '1mo');
          if (asset) marketData[code] = { ...asset, partial: true, startDate: localAsset.startDate || '' };
          else marketErrors[code] = 'Güncel fiyat yenilenemedi; önceki yerel fiyat geçmişi korunuyor.';
        } catch (error) {
          marketErrors[code] = `Güncel fiyat yenilenemedi; önceki geçmiş korunuyor. ${error.message || ''}`.trim();
        }
      }
      sendResponse({ ...result, marketData, marketErrors });
    } catch {
      sendResponse({
        ok: false,
        error: 'Midas sekmesindeki okuyucuya ulaşılamadı. Midas sekmesini yenileyip tekrar deneyin.',
      });
    }
  }).catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isoDate(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function activePurchaseStarts(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const code = String(row.code || '').toUpperCase();
    if (!code || !row.date || !(Number(row.units) > 0) || !['AL', 'SAT'].includes(row.type)) continue;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(row);
  }
  const starts = {};
  for (const [code, events] of groups) {
    events.sort((a, b) => a.date.localeCompare(b.date));
    let units = 0, startDate = '';
    for (const row of events) {
      if (row.type === 'AL') {
        if (units <= 1e-8) startDate = row.date;
        units += Number(row.units);
      } else {
        units = Math.max(0, units - Number(row.units));
        if (units <= 1e-8) { units = 0; startDate = ''; }
      }
    }
    if (units > 1e-8 && startDate) starts[code] = startDate;
  }
  return starts;
}

async function yahooHistory(code, ticker, range = '3y', startDate = '') {
  const params = new URLSearchParams({ interval: '1d', events: 'history' });
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    params.set('period1', String(Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000)));
    params.set('period2', String(Math.floor(Date.now() / 1000) + 86400));
  } else params.set('range', range);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${params}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
  const payload = await response.json();
  const chart = payload?.chart?.result?.[0];
  const timestamps = chart?.timestamp || [];
  const closes = chart?.indicators?.quote?.[0]?.close || [];
  const prices = timestamps.map((timestamp, index) => ({
    date: isoDate(timestamp, chart.meta?.exchangeTimezoneName),
    price: Number(closes[index]),
  })).filter((point) => Number.isFinite(point.price) && point.price > 0);
  if (prices.length < (startDate || range !== '3y' ? 1 : 20)) return null;
  const quoteType = String(chart.meta?.instrumentType || '').toUpperCase();
  const isBist = ticker.endsWith('.IS') && chart.meta?.currency === 'TRY';
  const kind = quoteType === 'ETF' ? (isBist ? 'BIST_ETF' : 'US_ETF') : (isBist ? 'HISSE' : 'US_STOCK');
  const name = chart.meta?.longName || chart.meta?.shortName || code;
  return {
    code, name, kind,
    category: quoteType === 'ETF' ? (isBist ? 'Borsa Yatırım Fonu' : 'Yabancı ETF')
      : (isBist ? 'Hisse Senedi' : 'Yabancı Hisse'),
    currency: chart.meta?.currency || (isBist ? 'TRY' : 'USD'), source: 'Yahoo Finance',
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : '', prices,
  };
}

function tefasBody(code, kind, start, end) {
  const ymd = (date) => date.toISOString().slice(0, 10).replaceAll('-', '');
  return {
    fonTipi: kind, fonKodu: code, aramaMetni: null, fonTurKod: null, fonGrubu: null,
    sfonTurKod: null, fonTurAciklama: null, kurucuKod: null,
    basTarih: ymd(start), bitTarih: ymd(end), basSira: 1, bitSira: 100000, dil: 'TR',
    sFonTurKod: '', fonKod: '', fonGrup: '', fonUnvanTip: '',
  };
}

async function tefasChunk(code, kind, start, end) {
  const response = await fetch('https://www.tefas.gov.tr/api/funds/fonGnlBlgSiraliGetir', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    body: JSON.stringify(tefasBody(code, kind, start, end)),
  });
  if (!response.ok) throw new Error(`TEFAS HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errorMessage && !/veri bulunamadı|out of bounds/i.test(payload.errorMessage)) {
    throw new Error(`TEFAS: ${payload.errorMessage}`);
  }
  return (payload.resultList || []).filter((row) => String(row.fonKodu || '').toUpperCase() === code)
    .map((row) => ({ date: String(row.tarih || '').slice(0, 10), price: Number(row.fiyat), name: row.fonUnvan || '' }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.price) && row.price > 0);
}

async function tefasHistory(code, purchaseDate = '') {
  const end = new Date();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) ? new Date(`${purchaseDate}T00:00:00Z`) : new Date(end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) start.setFullYear(start.getFullYear() - 3);
  for (const kind of ['YAT', 'EMK', 'BYF']) {
    // First verify this code belongs to this TEFAS market with a recent window.
    let recent;
    try {
      recent = await tefasChunk(code, kind, new Date(end.getTime() - 27 * 86400000), end);
    } catch {
      continue;
    }
    if (!recent.length) continue;
    const byDate = new Map(recent.map((row) => [row.date, row]));
    let chunkEnd = new Date(end.getTime() - 28 * 86400000);
    while (chunkEnd >= start) {
      const chunkStart = new Date(Math.max(start.getTime(), chunkEnd.getTime() - 27 * 86400000));
      const rows = await tefasChunk(code, kind, chunkStart, chunkEnd);
      for (const row of rows) byDate.set(row.date, row);
      chunkEnd = new Date(chunkStart.getTime() - 86400000);
      await delay(1200);
    }
    const prices = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (prices.length >= (purchaseDate ? 1 : 20)) return {
      code, name: prices.find((row) => row.name)?.name || code, kind,
      category: kind === 'BYF' ? 'Borsa Yatırım Fonu' : kind === 'EMK' ? 'Emeklilik Fonu' : 'Yatırım Fonu',
      currency: 'TRY', source: 'TEFAS', startDate: purchaseDate,
      prices: prices.map(({ date, price }) => ({ date, price })),
    };
  }
  return null;
}

async function tefasLatest(code) {
  const end = new Date();
  const start = new Date(end.getTime() - 27 * 86400000);
  for (const kind of ['YAT', 'EMK', 'BYF']) {
    try {
      const rows = await tefasChunk(code, kind, start, end);
      if (rows.length) return {
        code, name: rows.find((row) => row.name)?.name || code, kind,
        category: kind === 'BYF' ? 'Borsa Yatırım Fonu' : kind === 'EMK' ? 'Emeklilik Fonu' : 'Yatırım Fonu',
        currency: 'TRY', source: 'TEFAS', partial: true,
        prices: rows.map(({ date, price }) => ({ date, price })),
      };
    } catch {
      // Continue through TEFAS fund kinds; preserve the last saved local series on failure.
    }
  }
  return null;
}

async function fetchAssetHistory(code, isFund, range = '3y', purchaseDate = '') {
  if (isFund) return range === '3y' ? tefasHistory(code, purchaseDate) : tefasLatest(code);
  // Midas symbols are normally Turkish tickers; then try a direct US symbol.
  for (const ticker of [`${code}.IS`, code]) {
    try {
      const data = await yahooHistory(code, ticker, range, purchaseDate);
      if (data) return data;
    } catch {
      // Try the next market/source; do not interrupt importing other codes.
    }
  }
  return range === '3y' ? tefasHistory(code, purchaseDate) : tefasLatest(code);
}
