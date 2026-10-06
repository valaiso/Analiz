// Salt DOM okuma: mevcut Atlas oturumunu kullanır, ağ çağrısı/emir göndermez.
const TRADE_WORDS = /alış|alım|satış|satım|buy|sell/i;
const DATE_WORDS = /(?:\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|(?:^|\s)\d{1,2}\s+(?:oca|şub|sub|mar|nis|may|haz|tem|ağu|agu|eyl|eki|kas|ara)\w*\s+\d{4}\b)/i;

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

function candidateElements() {
  const isTransactionRow = (el) => {
    if (!isVisible(el)) return false;
    const text = textOf(el);
    return text.length >= 12 && text.length <= 700 && TRADE_WORDS.test(text) && DATE_WORDS.test(text);
  };
  const selectors = [
    'tr', '[role="row"]', '[data-testid*="transaction" i]',
    '[class*="transaction" i]', 'li',
  ];
  let elements = [];
  for (const selector of selectors) {
    elements = [...document.querySelectorAll(selector)].filter(isTransactionRow);
    if (elements.length) {
      if (selector.includes('transaction')) {
        elements = elements.filter((el) => ![...el.children].some((child) => isTransactionRow(child)
          && textOf(child).length < textOf(el).length));
      }
      break;
    }
  }

  // Midas ekranında satır yapısı etiketsiz div'lerden oluşursa seçilecek en küçük
  // kapsayıcıyı bulur; başlık ve bütün sayfa metnini işlem diye yorumlamaz.
  if (!elements.length) {
    elements = [...document.querySelectorAll('div, article, section')].filter((el) => {
      if (!isVisible(el)) return false;
      const text = textOf(el);
      if (text.length < 20 || text.length > 700 || !TRADE_WORDS.test(text) || !DATE_WORDS.test(text)) return false;
      return ![...el.children].some((child) => {
        const childText = textOf(child);
        return childText.length >= 20 && childText.length < text.length
          && TRADE_WORDS.test(childText) && DATE_WORDS.test(childText);
      });
    });
  }

  return elements.map((element) => {
    const text = textOf(element);
    const table = element.closest('table');
    const headers = table ? [...table.querySelectorAll('thead th')].map(textOf) : [];
    const cells = element.matches('tr, [role="row"]')
      ? [...element.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"]')].map(textOf)
      : [];
    return {
      text: multilineTextOf(element),
      headers,
      cells,
      sourceId: element.getAttribute('data-transaction-id')
        || element.getAttribute('data-order-id')
        || element.getAttribute('data-id')
        || '',
    };
  }).slice(0, 500);
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
  match = text.toLocaleLowerCase('tr').match(/(?:^|\s)(\d{1,2})\s+(oca|şub|sub|mar|nis|may|haz|tem|ağu|agu|eyl|eki|kas|ara)\w*\s+(\d{4})\b/);
  if (!match) return '';
  return `${match[3]}-${months[match[2]]}-${String(Number(match[1])).padStart(2, '0')}`;
}

function normalizeRow(row) {
  const text = row.text;
  const lower = text.toLocaleLowerCase('tr');
  const type = /satış|satım|sell/i.test(lower) ? 'SAT' : /alış|alım|buy/i.test(lower) ? 'AL' : '';
  const date = parseDate(text);
  const cells = row.cells || [];
  const headers = row.headers || [];
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

  let code = getLabel(/sembol|varlık|fon kodu|hisse kodu/i, 'sembol|varlık|fon kodu|hisse kodu')
    .match(/[A-Z][A-Z0-9.-]{1,9}/)?.[0] || '';
  if (!code) {
    const excluded = new Set(['AL', 'SAT', 'ALIŞ', 'ALIM', 'SATIŞ', 'SATIM', 'BUY', 'SELL', 'USD', 'TRY', 'TL', 'ADET', 'LOT', 'FON']);
    code = text.match(/\b[A-Z][A-Z0-9.-]{1,6}\b/g)?.find((token) => !excluded.has(token)) || '';
  }

  let units = parseLocaleNumber(getLabel(/miktar|adet|lot|gerçekleşen miktar|gerçekleşen adet/i, 'miktar|adet|lot|gerçekleşen miktar|gerçekleşen adet'));
  if (!(units > 0)) {
    const match = text.match(/([\d.,]+)\s*(?:adet|lot|pay|hisse)\b/i)
      || text.match(/(?:adet|lot|pay|hisse)\s*[:：]?\s*([\d.,]+)/i);
    units = match ? parseLocaleNumber(match[1]) : null;
  }

  let price = parseLocaleNumber(getLabel(/birim fiyat|gerçekleşme fiyatı|işlem fiyatı|fiyat/i, 'birim fiyat|gerçekleşme fiyatı|işlem fiyatı|fiyat'));
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
  const rows = candidateElements().map(normalizeRow);
  sendResponse({ ok: true, rows });
  return false;
});
