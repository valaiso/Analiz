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

function statusCategory(status) {
  const value = String(status || '').toLocaleLowerCase('tr');
  if (!value) return 'boş';
  if (/bekliyor/.test(value)) return 'bekliyor';
  if (/iptal/.test(value)) return 'iptal';
  if (/kısmi|kismi/.test(value)) return 'kısmi';
  if (/reddedildi/.test(value)) return 'reddedildi';
  if (/gerçekleş|tamamlan|filled|executed/.test(value)) return 'tamamlandı';
  return 'diğer';
}

function isOrderHeader(element) {
  const cells = directCells(element)
    .map((cell) => cell.toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim().replace(/[:：]$/, ''));
  if (cells.some((cell) => cell.length > 32)) return false;
  const checks = [
    /^(varlık|varlık kodu|sembol|sembol kodu)$/, /^(durum|statü|status)$/,
    /^emir tipi$/, /^alış\s*\/\s*satış$|^işlem yönü$/,
    /^(adet|miktar|lot)$/, /^fiyat$/, /^(emir tarihi|işlem tarihi)$/,
  ];
  return cells.length >= 7 && cells.length <= 12 && checks.every((pattern) => cells.some((cell) => pattern.test(cell)));
}

function orderHistoryRoot() {
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"], span, div')]
    .filter((element) => isVisible(element) && /^emir\s+geçmişi$/iu.test(textOf(element)))
    .sort((a, b) => textOf(a).length - textOf(b).length);
  for (const heading of headings) {
    let headerScope = null;
    for (let scope = heading.parentElement, depth = 0; scope && depth < 12; scope = scope.parentElement, depth += 1) {
      const hasOrderHeader = [...scope.querySelectorAll('tr, [role="row"], [class*="row" i], div')]
        .some((element) => isVisible(element) && element.children.length >= 5
          && element.children.length <= 12 && isOrderHeader(element));
      if (!hasOrderHeader) continue;
      headerScope = scope;
      const hasPager = [...scope.querySelectorAll('span, div, p')]
        .some((element) => isVisible(element) && /^\d+\s*[-–]\s*\d+\s*\/\s*\d+$/.test(textOf(element)));
      if (hasPager) return scope;
    }
    if (headerScope) return headerScope;
  }
  return null;
}

function candidateElements(root, scanStats) {
  const rowSelector = 'tr, [role="row"], [class*="row" i]';
  // Atlas bazı tablo sürümlerinde table/role=row kullanmıyor; sütun başlıklarını
  // taşıyan CSS grid satırlarını da doğrudan çocuklarından tanı.
  const headerCandidates = [...root.querySelectorAll(`${rowSelector}, div`)]
    .filter((element) => isVisible(element) && element.children.length >= 5 && element.children.length <= 12);
  for (const headerRow of headerCandidates) {
    const headers = directCells(headerRow);
    const norm = headers.map((header) => header.toLocaleLowerCase('tr'));
    const index = (pattern) => norm.findIndex((header) => pattern.test(header));
    const columns = {
      code: index(/varlık|sembol|fon/),
      status: index(/durum|statü|status/),
      side: (() => {
        const tradeColumn = index(/alış\s*\/\s*satış|işlem yönü|yön/);
        return tradeColumn >= 0 ? tradeColumn : index(/emir tipi/);
      })(),
      units: index(/adet|miktar|lot/),
      price: index(/fiyat|toplam/),
      date: index(/emir tarihi|işlem tarihi|tarih/),
    };
    // Yalnızca gerçek emir tablosunu işle; sayfanın tamamını kapsayan listeleri
    // ve işlem geçmişi kartlarını satır sanıp çoğaltma.
    if (!isOrderHeader(headerRow)
      || [columns.code, columns.side, columns.units, columns.date].some((column) => column < 0)) continue;
    if (scanStats) scanStats.headers = headers;

    const semanticRoot = headerRow.closest('table, [role="table"]');
    let rows = semanticRoot
      ? [...semanticRoot.querySelectorAll(`tbody tr, ${rowSelector}, div, li`)]
      : [];
    if (!semanticRoot) {
      // CSS grid satırları başlıkla aynı kapsayıcıda veya birkaç seviye aşağıda
      // bulunur. Satır sayısı/sırası ve tarih/yön sütunlarıyla doğrula.
      let scope = headerRow.parentElement;
      for (let depth = 0; scope && root.contains(scope) && depth < 10; scope = scope.parentElement, depth += 1) {
        const candidates = [...scope.querySelectorAll(`${rowSelector}, li, div`)]
          .filter((row) => row !== headerRow && isVisible(row));
        const matching = candidates.filter((row) => {
          const cells = directCells(row);
          return cells.length === headers.length && TRADE_WORDS.test(cells[columns.side] || '')
            && DATE_WORDS.test(cells[columns.date] || '');
        });
        if (matching.length) { rows = matching; break; }
      }
    }
    if (scanStats) scanStats.rowNodes += rows.length;
    const uniqueRows = new Map();
    for (const element of rows) {
      const cells = directCells(element);
      if (scanStats && cells.length === headers.length) scanStats.cellCountMatches += 1;
      const status = columns.status >= 0 ? cells[columns.status] || '' : '';
      if (scanStats && cells.length === headers.length) {
        const category = statusCategory(status);
        scanStats.statuses[category] = (scanStats.statuses[category] || 0) + 1;
      }
      const text = cells.join('\n');
      const side = cells[columns.side] || '';
      const date = cells[columns.date] || '';
      const tradeAndDate = TRADE_WORDS.test(side) && DATE_WORDS.test(date);
      if (scanStats && cells.length === headers.length && tradeAndDate) scanStats.tradeDateMatches += 1;
      if (scanStats && cells.length === headers.length && columns.status >= 0 && executedStatus(status)) scanStats.completedStatuses += 1;
      // Midas'ın emir tablosunda durum sütunu olmayabilir. Bu tabloda satır
      // görünüyorsa ve doldurulmuş adet/fiyat varsa işlem gerçekleşmiştir;
      // durum sütunu varsa bekleyen/iptal satırlarını kesinlikle dışarıda tut.
      if ((columns.status >= 0 && !executedStatus(status)) || !tradeAndDate) continue;
      const row = {
        text,
        headers,
        cells,
        sourceId: element.getAttribute('data-order-id')
          || element.getAttribute('data-id')
          || '',
      };
      const key = row.sourceId || text.replace(/\s+/g, ' ').trim();
      if (key && !uniqueRows.has(key)) uniqueRows.set(key, row);
    }
    if (uniqueRows.size) return [...uniqueRows.values()].slice(0, 500);
  }
  return [];
}

function historyDiagnostics(root) {
  const labels = [...root.querySelectorAll('button, [role="button"], h1, h2, h3, span, div')]
    .filter(isVisible)
    .map(textOf)
    .filter((text) => text && text.length < 40)
    .filter((text) => /varlık|sembol|durum|statü|alış|satış|emir tipi|adet|miktar|lot|fiyat|emir tarihi|işlem tarihi|gerçekleş|tamamlan|bekliyor|iptal/i.test(text));
  return [...new Set(labels)].slice(0, 40);
}

function paginationState(direction, root) {
  const labels = [...root.querySelectorAll('span, div, p')]
    .filter((element) => isVisible(element) && /^\d+\s*[-–]\s*\d+\s*\/\s*\d+$/.test(textOf(element)))
    // innerText eşit olan bir sürü ancestor bulunabilir; en küçük metin kutusu
    // sayfa aralığının gerçek etiketi, geniş parent ise oku yanlış tarafta aratır.
    .sort((a, b) => {
      const aBox = a.getBoundingClientRect();
      const bBox = b.getBoundingClientRect();
      return (aBox.width * aBox.height) - (bBox.width * bBox.height)
        || textOf(a).length - textOf(b).length;
    });
  const indicator = labels[0];
  if (!indicator) return null;
  const indicatorBox = indicator.getBoundingClientRect();
  const verticalMatch = (box) => box.bottom >= indicatorBox.top - 14 && box.top <= indicatorBox.bottom + 14;
  const inDirection = (box) => direction === 'next'
    ? box.left >= indicatorBox.right - 3 && box.left - indicatorBox.right < 110
    : box.right <= indicatorBox.left + 3 && indicatorBox.left - box.right < 110;
  const labelOf = (element) => [element.getAttribute('aria-label'), element.getAttribute('title'),
    element.getAttribute('data-testid'), textOf(element)].filter(Boolean).join(' ').toLocaleLowerCase('tr');
  const enabled = (element) => !element.disabled
    && element.getAttribute('aria-disabled') !== 'true'
    && !element.classList.contains('disabled');

  // Önce erişilebilir etiketle doğru oku seç; burada üst çubuktaki diğer
  // butonlarla karışmaması için sayfa göstergesiyle aynı satırda olmasını şart koş.
  // Midas'ın responsive görünümünde gösterge ve ok farklı kardeş kapsayıcılara
  // alınabiliyor. Kontrolü belge genelinde buluyoruz ama yalnızca aynı satırdaki
  // ve göstergenin 140px yakınındaki kontrolleri kabul ediyoruz.
  const searchRoot = root.ownerDocument || document;
  const named = [...searchRoot.querySelectorAll('button, [role="button"], a[aria-label]')]
    .filter(isVisible)
    .filter((element) => verticalMatch(element.getBoundingClientRect())
      && inDirection(element.getBoundingClientRect()))
    .filter((element) => direction === 'next'
      ? /next|sonraki|ileri/.test(labelOf(element))
      : /previous|önceki|onceki|geri/.test(labelOf(element)));
  if (named.length) return { label: textOf(indicator), button: named[0], disabled: !enabled(named[0]) };

  // Midas'ın ikon-only pager oku button etiketi taşımayabilir. Sayfa
  // göstergesinin hemen sağı/solundaki gerçek butonu veya tıklanabilir SVG'yi bul.
  const candidates = [...searchRoot.querySelectorAll('button, [role="button"], [tabindex="0"], a, svg, [class*="button" i]')]
    .filter(isVisible)
    .map((element) => {
      const box = element.getBoundingClientRect();
      const clickable = element.closest('button, [role="button"], [tabindex="0"], a') || element;
      return { element: clickable, box: clickable.getBoundingClientRect(), source: element };
    })
    .filter(({ box }) => verticalMatch(box) && inDirection(box));
  if (candidates.length) {
    candidates.sort((a, b) => direction === 'next' ? a.box.left - b.box.left : b.box.right - a.box.right);
    const item = candidates[0].element;
    return { label: textOf(indicator), button: item, disabled: !enabled(item) };
  }

  // Son çare: sayfa okları div olabilir ve yalnızca cursor:pointer ile belli olur.
  const nearby = [...searchRoot.querySelectorAll('div, span')]
    .filter(isVisible)
    .map((element) => ({ element, box: element.getBoundingClientRect(), cursor: getComputedStyle(element).cursor }))
    .filter(({ box, cursor }) => cursor === 'pointer' && verticalMatch(box) && inDirection(box)
      && box.width <= 48 && box.height <= 48);
  if (nearby.length) {
    nearby.sort((a, b) => direction === 'next' ? a.box.left - b.box.left : b.box.right - a.box.right);
    return { label: textOf(indicator), button: nearby[0].element, disabled: false };
  }
  const box = indicatorBox;
  const nearbyControls = [...searchRoot.querySelectorAll('button, [role="button"], [tabindex], a, svg, [class*="button" i]')]
    .filter(isVisible)
    .map((element) => {
      const target = element.closest('button, [role="button"], [tabindex], a') || element;
      const rect = target.getBoundingClientRect();
      return {
        target,
        rect,
        description: [target.tagName.toLowerCase(), target.getAttribute('aria-label'), target.getAttribute('title'), target.getAttribute('data-testid'), target.className?.baseVal || target.className || '']
          .filter(Boolean).join(':').slice(0, 100),
      };
    })
    .filter(({ rect }) => rect.bottom >= box.top - 28 && rect.top <= box.bottom + 28
      && rect.left >= box.left - 150 && rect.right <= box.right + 180)
    .slice(0, 12)
    .map(({ description, rect }) => `${description}@${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
  const geometry = `Gösterge kutusu: x=${Math.round(box.left)}, y=${Math.round(box.top)}, w=${Math.round(box.width)}, h=${Math.round(box.height)}.`;
  const controls = nearbyControls.length ? `Yakın kontroller: ${nearbyControls.join(' · ')}.` : 'Gösterge çevresinde görünür kontrol yok.';
  return { label: textOf(indicator), button: null, disabled: true, reason: `${direction} sayfa kontrolü göstergenin yanında bulunamadı. ${geometry} ${controls}` };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function collectCompletedHistory() {
  const collected = new Map();
  const scanStats = { headers: [], rowNodes: 0, cellCountMatches: 0, tradeDateMatches: 0, completedStatuses: 0, statuses: {} };
  const root = orderHistoryRoot();
  if (!root) return {
    rows: [], pageCount: 0, paginationStop: 'Yatırım hesabındaki Emir geçmişi tablosu bulunamadı.',
    labels: [], start: '', accountSummary: readAccountSummary(),
  };
  const start = paginationState('prev', root)?.label || '';
  let pageCount = 0;
  let paginationStop = '';

  // Kullanıcı son sayfada bırakmış olsa bile taramayı en baştan yap.
  let initialBackCount = 0;
  while (initialBackCount < 300) {
    const previous = paginationState('prev', root);
    if (!previous?.button || previous.disabled) break;
    const oldLabel = previous.label;
    previous.button.click();
    let changed = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(100);
      if (paginationState('prev', root)?.label !== oldLabel) { changed = true; break; }
    }
    if (!changed) { paginationStop = 'Önceki ok tıklandı fakat başlangıç sayfasına dönüşte gösterge değişmedi.'; break; }
    initialBackCount += 1;
  }

  // Midas bazı hesaplarda yüzlerce emri 5'li sayfalarda gösteriyor. Yalnızca
  // emir tablosunun sayfa okunu kullanarak ilerle; alım/satım kontrollerine dokunma.
  while (pageCount < 300) {
    for (const row of candidateElements(root, scanStats)) {
      const key = row.sourceId || row.text.replace(/\s+/g, ' ').trim();
      if (key) collected.set(key, row);
    }

    const next = paginationState('next', root);
    if (!next?.button || next.disabled) {
      paginationStop = next?.reason || (next?.disabled ? 'İleri oku pasif veya son sayfaya ulaşıldı.' : 'İleri oku bulunamadı.');
      break;
    }
    const previousLabel = next.label;
    next.button.click();
    let changed = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(100);
      const current = paginationState('next', root);
      if (current?.label && current.label !== previousLabel) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      paginationStop = 'İleri oka tıklandı fakat sayfa göstergesi değişmedi.';
      break;
    }
    pageCount += 1;
  }

  // Tarama en son sayfada biter; başlangıç sayfasına geri dön.
  const restoreMoves = Math.max(0, pageCount - initialBackCount);
  for (let page = 0; page < restoreMoves; page += 1) {
    const previous = paginationState('prev', root);
    if (!previous?.button || previous.disabled) break;
    const previousLabel = previous.label;
    previous.button.click();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(100);
      if (paginationState('prev', root)?.label !== previousLabel) break;
    }
  }
  if (paginationStop && initialBackCount) paginationStop = `${paginationStop} Başlangıç sayfasına dönmek için ${initialBackCount} önceki sayfa geçildi.`;
  scanStats.pages = pageCount + 1;
  return { rows: [...collected.values()].slice(0, 500), pageCount, paginationStop, labels: historyDiagnostics(root), start, accountSummary: readAccountSummary(), scanStats };
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

function readAccountSummary() {
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"], span, div')]
    .filter((element) => isVisible(element) && /^yatırım hesabı$/iu.test(textOf(element)))
    .sort((a, b) => textOf(a).length - textOf(b).length);
  for (const heading of headings) {
    for (let scope = heading.parentElement, depth = 0; scope && depth < 8; scope = scope.parentElement, depth += 1) {
      const lines = multilineTextOf(scope);
      if (!lines.some((line) => /alım gücü/i.test(line)) || !lines.some((line) => /nakit bakiye/i.test(line))) continue;
      const headingIndex = lines.findIndex((line) => /^yatırım hesabı$/iu.test(line));
      const valueLine = lines.slice(Math.max(headingIndex, 0))
        .find((line) => /₺|TRY/i.test(line) && !/günlük|alım gücü|nakit bakiye|takas bekleyen/i.test(line));
      const amountAfter = (pattern) => {
        const index = lines.findIndex((entry) => pattern.test(entry));
        if (index < 0) return null;
        for (const line of lines.slice(index, index + 3)) {
          if (/₺|\$|TRY|USD/i.test(line)) {
            const amount = parseLocaleNumber(line.replace(/^.*?(?:alım gücü|nakit bakiye|takas bekleyen bakiye)/i, ''));
            if (amount !== null) return amount;
          }
        }
        return null;
      };
      const dailyLine = lines.find((line) => /günlük/i.test(line));
      return {
        totalValue: valueLine ? parseLocaleNumber(valueLine) : null,
        dailyChange: dailyLine ? parseLocaleNumber(dailyLine) : null,
        tryBuyingPower: amountAfter(/alım gücü/i),
        tryCash: amountAfter(/nakit bakiye/i),
        trySettlement: amountAfter(/takas bekleyen bakiye/i),
      };
    }
  }
  return null;
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
  collectCompletedHistory().then(({ rows, pageCount, paginationStop, labels, start, scanStats }) => {
    const normalized = rows.map(normalizeRow);
    const ready = normalized.filter((row) => !row.missing.length);
    if (!rows.length) {
      const evidence = labels.length ? `Ekranda algılanan başlık/durum metinleri: ${labels.join(' · ')}.` : 'Ekranda tanınan emir tablosu başlığı görünmüyor.';
      const headers = scanStats?.headers?.length ? `Algılanan sütunlar: ${scanStats.headers.join(' · ')}.` : 'Satır sütunları eşleştirilemedi.';
      const statuses = Object.entries(scanStats?.statuses || {}).map(([name, count]) => `${name}: ${count}`).join(', ') || 'durum okunamadı';
      const rowStats = `Tablo teşhisi: ${scanStats?.pages || pageCount + 1} sayfa; ${scanStats?.rowNodes || 0} satır öğesi; ${scanStats?.cellCountMatches || 0} sütun sayısı uyan satır; ${scanStats?.tradeDateMatches || 0} alış/satış ve tarih uyan satır; ${scanStats?.completedStatuses || 0} tamamlandı durumlu satır. Durum dağılımı: ${statuses}.`;
      sendResponse({ ok: false, accountSummary: readAccountSummary(), error: `Midas yatırım hesabı sayfasında tamamlanmış işlem satırı okunamadı. ${pageCount + 1} sayfa tarandı. ${start ? `Başlangıç sayfası: ${start}. ` : ''}${paginationStop ? `Sayfalama: ${paginationStop} ` : ''}${headers} ${rowStats} ${evidence} Yalnızca “Emir geçmişi” tablosu tarandı; kripto geçmişi dahil edilmedi.` });
      return;
    }
    sendResponse({ ok: true, rows: normalized, scannedPages: pageCount + 1, unmatchedCount: normalized.length - ready.length, accountSummary: readAccountSummary() });
  }).catch((error) => {
    sendResponse({ ok: false, error: error.message || 'Midas emir geçmişi okunamadı.' });
  });
  return true;
});
