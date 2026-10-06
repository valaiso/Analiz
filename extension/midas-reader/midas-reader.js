// Salt DOM okuma: mevcut Atlas oturumunu kullanır, ağ çağrısı/emir göndermez.
const TRADE_WORDS = /alış|alım|satış|satım|buy|sell/i;
const DATE_WORDS = /(?:\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|(?:^|\s)\d{1,2}\s+(?:oca(?:k)?|şub(?:at)?|sub(?:at)?|mar(?:t)?|nis(?:an)?|may(?:ıs|is)?|haz(?:iran)?|tem(?:muz)?|ağu(?:stos)?|agu(?:stos)?|eyl(?:ül|ul)?|eki(?:m)?|kas(?:ım|im)?|ara(?:lık|lik)?)(?:\s+\d{4})?\b)/iu;

function isVisible(element) {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function textOf(element) {
  return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
}

function multilineTextOf(element) {
  return (element.innerText || element.textContent || '')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}

function directCells(row) {
  const explicit = [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"]')];
  return (explicit.length ? explicit : [...row.children]).map(textOf);
}

function executedStatus(status) {
  const value = String(status || '').toLocaleLowerCase('tr');
  if (/bekliyor|[iİ]ptal|kısmi|kismi|reddedildi/.test(value)) return false;
  return /gerçekleş|tamamlan|filled|executed/.test(value);
}

function hasOrderHistoryTable() {
  const rowSelector = 'tr, [role="row"], [class*="row" i]';
  const required = [/varlık|sembol|fon/, /durum|statü|status/, /alış\s*\/\s*satış|işlem yönü|yön/, /adet|miktar|lot/, /fiyat/, /emir tarihi|işlem tarihi|tarih/];
  return [...document.querySelectorAll(rowSelector)].filter(isVisible).some((row) => {
    const cells = directCells(row).map((cell) => cell.toLocaleLowerCase('tr'));
    return required.every((pattern) => cells.some((cell) => pattern.test(cell)));
  });
}

function candidateElements() {
  const rowSelector = 'tr, [role="row"], [class*="row" i]';
  const visibleRows = [...document.querySelectorAll(rowSelector)].filter(isVisible);
  for (const headerRow of visibleRows) {
    const headers = directCells(headerRow);
    const norm = headers.map((header) => header.toLocaleLowerCase('tr'));
    const index = (pattern) => norm.findIndex((header) => pattern.test(header));
    const columns = {
      code: index(/varlık|sembol|fon/),
      status: index(/durum|statü|status/),
      side: index(/alış\s*\/\s*satış|işlem yönü|yön/),
      units: index(/adet|miktar|lot/),
      price: index(/fiyat/),
      date: index(/emir tarihi|işlem tarihi|tarih/),
    };
    // Yalnızca gerçek emir tablosunu işle; sayfanın tamamını kapsayan listeleri
    // ve işlem geçmişi kartlarını satır sanıp çoğaltma.
    if (Object.values(columns).some((column) => column < 0)) continue;

    const root = headerRow.closest('table, [role="table"], [role="grid"]')
      || headerRow.parentElement?.parentElement
      || document;
    const rows = [...root.querySelectorAll(rowSelector)]
      .filter((row) => row !== headerRow && isVisible(row));
    return rows.flatMap((element) => {
      const cells = directCells(element);
      const status = cells[columns.status] || '';
      const text = cells.join('\n');
      const side = cells[columns.side] || '';
      const date = cells[columns.date] || '';
      if (!executedStatus(status) || !TRADE_WORDS.test(side) || !DATE_WORDS.test(date)) return [];
      return [{
        text,
        headers,
        cells,
        sourceId: element.getAttribute('data-order-id')
          || element.getAttribute('data-id')
          || '',
      }];
    }).slice(0, 500);
  }
  return [];
}

function paginationState(direction) {
  const labels = [...document.querySelectorAll('span, div, p')]
    .filter((element) => isVisible(element) && /^\d+\s*[-–]\s*\d+\s*\/\s*\d+$/.test(textOf(element)))
    .sort((a, b) => textOf(a).length - textOf(b).length);
  const indicator = labels[0];
  if (!indicator) return null;
  const indicatorBox = indicator.getBoundingClientRect();

  for (let container = indicator.parentElement, depth = 0; container && depth < 5; container = container.parentElement, depth += 1) {
    const buttons = [...container.querySelectorAll('button')]
      .filter((button) => isVisible(button))
      .map((button) => ({ button, box: button.getBoundingClientRect() }))
      .filter(({ box }) => box.bottom >= indicatorBox.top - 12 && box.top <= indicatorBox.bottom + 12);
    const candidates = buttons.filter(({ box }) => direction === 'next'
      ? box.left >= indicatorBox.right - 2
      : box.right <= indicatorBox.left + 2);
    if (candidates.length) {
      candidates.sort((a, b) => direction === 'next' ? a.box.left - b.box.left : b.box.right - a.box.right);
      return {
        label: textOf(indicator),
        button: candidates[0].button,
        disabled: candidates[0].button.disabled
          || candidates[0].button.getAttribute('aria-disabled') === 'true',
      };
    }
  }
  return { label: textOf(indicator), button: null, disabled: true };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function collectCompletedHistory() {
  const collected = new Map();
  if (!hasOrderHistoryTable()) return [];
  const start = paginationState('prev')?.label || '';
  let pageCount = 0;

  // Midas bazı hesaplarda yüzlerce emri 5'li sayfalarda gösteriyor. Yalnızca
  // emir tablosunun sayfa okunu kullanarak ilerle; alım/satım kontrollerine dokunma.
  while (pageCount < 300) {
    for (const row of candidateElements()) {
      const key = row.sourceId || row.text.replace(/\s+/g, ' ').trim();
      if (key) collected.set(key, row);
    }

    const next = paginationState('next');
    if (!next?.button || next.disabled) break;
    const previousLabel = next.label;
    next.button.click();
    let changed = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(100);
      const current = paginationState('next');
      if (current?.label && current.label !== previousLabel) {
        changed = true;
        break;
      }
    }
    if (!changed) break;
    pageCount += 1;
  }

  // Kullanıcının başladığı tablo sayfasına geri dön.
  for (let page = 0; page < pageCount; page += 1) {
    const previous = paginationState('prev');
    if (!previous?.button || previous.disabled) break;
    const previousLabel = previous.label;
    previous.button.click();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(100);
      if (paginationState('prev')?.label !== previousLabel) break;
    }
  }
  return [...collected.values()].slice(0, 500);
}

function parseLocaleNumber(value) {
  if (!value) return null;
  let s = String(value).match(/[+-]?\d[\d.,]*/)?.[0] || '';
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(text) {
  let match = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return `${year}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
  }
  const months = { oca: '01', şub: '02', sub: '02', mar: '03', nis: '04', may: '05', haz: '06', tem: '07', ağu: '08', agu: '08', eyl: '09', eki: '10', kas: '11', ara: '12' };
  match = text.toLocaleLowerCase('tr').match(/(?:^|\s)(\d{1,2})\s+(oca(?:k)?|şub(?:at)?|sub(?:at)?|mar(?:t)?|nis(?:an)?|may(?:ıs|is)?|haz(?:iran)?|tem(?:muz)?|ağu(?:stos)?|agu(?:stos)?|eyl(?:ül|ul)?|eki(?:m)?|kas(?:ım|im)?|ara(?:lık|lik)?)(?:\s+(\d{4}))?(?=$|[\s,])/u);
  if (!match) return '';
  const monthKey = match[2].slice(0, 3);
  const now = new Date();
  let year = Number(match[3] || now.getFullYear());
  if (!match[3] && Number(months[monthKey]) > now.getMonth() + 1) year -= 1;
  return `${year}-${months[monthKey]}-${String(Number(match[1])).padStart(2, '0')}`;
}
function normalizeRow(row) {
  const text = row.text;
  const lower = text.toLocaleLowerCase('tr');
  const cells = row.cells || [];
  const headers = row.headers || [];
  const valueByHeader = (pattern) => {
    const i = headers.findIndex((header) => pattern.test(header));
    return i >= 0 ? cells[i] || '' : '';
  };
  const side = valueByHeader(/alış\s*\/\s*satış|işlem yönü|yön/) || text;
  const type = /satış|satım|sell/i.test(side) ? 'SAT' : /alış|alım|buy/i.test(side) ? 'AL' : '';
  const date = parseDate(valueByHeader(/emir tarihi|işlem tarihi|tarih/) || text);
  const fieldByHeader = (pattern) => {
    const i = headers.findIndex((header) => pattern.test(header));
    return i >= 0 ? cells[i] : '';
  };
  const getLabel = (headerPattern, textPattern) =>
    fieldByHeader(headerPattern) || (() => {
      for (const line of text.split(/\r?\n/)) {
        const re = new RegExp(`^\\s*(?:${textPattern})\\s*[:：]?\\s*(.*?)\\s*$`, 'i');
        const value = line.match(re)?.[1]?.trim();
        if (value) return value;
      }
      return '';
    })();

  let code = (valueByHeader(/varlık|sembol|fon kodu|hisse kodu/i)
    || getLabel(/sembol|varlık|fon kodu|hisse kodu/i, 'sembol|varlık|fon kodu|hisse kodu'))
    .match(/[A-Z][A-Z0-9.-]{1,9}/)?.[0] || '';
  if (!code) {
    const excluded = new Set(['AL', 'SAT', 'ALIŞ', 'ALIM', 'SATIŞ', 'SATIM', 'BUY', 'SELL', 'USD', 'TRY', 'TL', 'ADET', 'LOT', 'FON']);
    code = text.match(/\b[A-Z][A-Z0-9.-]{1,6}\b/g)?.find((token) => !excluded.has(token)) || '';
  }

  let units = parseLocaleNumber(valueByHeader(/gerçekleşen miktar|gerçekleşen adet|adet|miktar|lot/i)
    || getLabel(/miktar|adet|lot|gerçekleşen miktar|gerçekleşen adet/i, 'miktar|adet|lot|gerçekleşen miktar|gerçekleşen adet'));
  if (!(units > 0)) {
    const match = text.match(/([\d.,]+)\s*(?:adet|lot|pay|hisse)\b/i)
      || text.match(/(?:adet|lot|pay|hisse)\s*[:：]?\s*([\d.,]+)/i);
    units = match ? parseLocaleNumber(match[1]) : null;
  }

  let price = parseLocaleNumber(valueByHeader(/birim fiyat|gerçekleşme fiyatı|işlem fiyatı|fiyat/i)
    || getLabel(/birim fiyat|gerçekleşme fiyatı|işlem fiyatı|fiyat/i, 'birim fiyat|gerçekleşme fiyatı|işlem fiyatı|fiyat'));
  const amount = parseLocaleNumber(getLabel(/işlem tutarı|gerçekleşen tutar|toplam tutar|tutar/i, 'işlem tutarı|gerçekleşen tutar|toplam tutar|tutar'));
  if (!(price > 0) && amount > 0 && units > 0) price = amount / units;
  const fee = parseLocaleNumber(getLabel(/komisyon|masraf|ücret/i, 'komisyon|masraf|ücret')) || 0;

  const missing = [];
  if (!date) missing.push('tarih');
  if (!type) missing.push('alış/satış');
  if (!code) missing.push('sembol');
  if (!(units > 0)) missing.push('miktar');
  if (!(price > 0)) missing.push('fiyat');
  return { date, type, code, units, price, fee, sourceId: row.sourceId, rawText: text, missing };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ANALIZ_SCAN_VISIBLE_HISTORY') return undefined;
  collectCompletedHistory().then((rawRows) => {
    sendResponse({ ok: true, rows: rawRows.map(normalizeRow) });
  }).catch((error) => {
    sendResponse({ ok: false, error: error.message || 'Midas emir geçmişi okunamadı.' });
  });
  return true;
});
