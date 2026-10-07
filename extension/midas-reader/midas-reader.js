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
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function directCellElements(row) {
  const explicit = [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"]')];
  return explicit.length ? explicit : [...row.children];
}

function directCells(row) {
  return directCellElements(row).map(textOf);
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

function canonicalHeader(value) {
  const text = String(value || '').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim().replace(/[:：]$/, '');
  if (/^(varlık|varlık kodu|sembol|sembol kodu)$/.test(text)) return 'Varlık';
  if (/^(durum|statü|status)$/.test(text)) return 'Durum';
  if (/^emir tipi$/.test(text)) return 'Emir tipi';
  if (/^(alış\s*\/\s*satış|işlem yönü)$/.test(text)) return 'Alış/satış';
  if (/^(adet|miktar|lot)$/.test(text)) return 'Adet';
  if (/^toplam$/.test(text)) return 'Toplam';
  if (/^fiyat$/.test(text)) return 'Fiyat';
  if (/^(emir tarihi|işlem tarihi)$/.test(text)) return 'Emir tarihi';
  if (/^(ort\.?\s*maliyet|ortalama maliyet)$/.test(text)) return 'Ort. Maliyet';
  if (/^dağılım$/.test(text)) return 'Dağılım';
  if (/^günlük getirisi?$/.test(text)) return 'Günlük getiri';
  if (/^toplam getirisi?$/.test(text)) return 'Toplam getiri';
  if (/^(pozisyon|değer)$/.test(text)) return 'Pozisyon';
  return '';
}

function headerCellItems(element) {
  const nodes = [element, ...element.querySelectorAll('*')]
    .filter(isVisible)
    .map((node) => ({
      node,
      label: canonicalHeader(textOf(node) || node.getAttribute('aria-label') || node.getAttribute('title') || ''),
      box: node.getBoundingClientRect(),
    }))
    .filter((item) => item.label);
  const bestByLabel = new Map();
  for (const item of nodes) {
    const previous = bestByLabel.get(item.label);
    if (!previous || item.box.width * item.box.height < previous.box.width * previous.box.height) {
      bestByLabel.set(item.label, item);
    }
  }
  return [...bestByLabel.values()].sort((a, b) => a.box.left - b.box.left);
}

function headerCells(element) {
  return headerCellItems(element).map((item) => item.label);
}

function isOrderHeader(element, cryptoOnly = false) {
  const cells = headerCells(element);
  const required = ['Durum', 'Alış/satış', 'Adet', 'Fiyat', 'Emir tarihi'];
  return required.every((label) => cells.includes(label))
    && (cryptoOnly || cells.includes('Varlık') || cells.includes('Emir tipi'));
}

function isPositionsHeader(element, cryptoOnly = false) {
  const cells = headerCells(element);
  // Günlük/getiri/dağılım sütunları dar ekranda gizlenebilir. Tabloyu tanımak
  // için yalnızca sembol ve miktar/fiyat eksenlerini şart koş.
  const hasBaseColumns = ['Varlık', 'Adet', 'Fiyat'].every((label) => cells.includes(label));
  // Midas'ın Kripto Pozisyonlar tablosu ayrıca bir Pozisyon (piyasa değeri)
  // sütunu gösterir; yatırım hesabı tablosunda bu sütun yoktur.
  return hasBaseColumns && (cryptoOnly ? cells.includes('Pozisyon') : !cells.includes('Pozisyon'));
}

function positionsRoot(cryptoOnly = false) {
  const matchingHeaders = [...document.querySelectorAll('tr, [role="row"], [class*="row" i], div')]
    .filter((element) => isVisible(element) && isPositionsHeader(element, cryptoOnly))
    .sort((a, b) => textOf(a).length - textOf(b).length);
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"], span, div')]
    .filter((element) => isVisible(element) && /^pozisyonlar$/iu.test(textOf(element)))
    .sort((a, b) => textOf(a).length - textOf(b).length);
  for (const heading of headings) {
    for (let scope = heading.parentElement, depth = 0; scope && depth < 24; scope = scope.parentElement, depth += 1) {
      if (matchingHeaders.some((header) => scope.contains(header))) return scope;
    }
  }
  // Some Atlas layouts render the title and the grid in separate wrappers.
  // The extra "Pozisyon" value column uniquely identifies the Crypto grid.
  if (cryptoOnly && matchingHeaders.length) {
    for (const header of matchingHeaders) {
      for (let scope = header.parentElement, depth = 0; scope && depth < 16; scope = scope.parentElement, depth += 1) {
        if (headings.some((heading) => scope.contains(heading))) return scope;
        const containsPositionData = [...scope.querySelectorAll('tr, [role="row"], [class*="row" i], li, div')]
          .some((element) => element !== header && isVisible(element)
            && textOf(element).length < 600 && /[₺$€]/.test(textOf(element)));
        if (containsPositionData && (activeCryptoTab() || /kripto|crypto/i.test(textOf(scope).slice(0, 400)))) return scope;
      }
    }
  }
  return null;
}

function positionSnapshotRows(cryptoOnly = false) {
  const root = positionsRoot(cryptoOnly);
  if (!root) return [];
  const headerRow = [...root.querySelectorAll('tr, [role="row"], [class*="row" i], div')]
    .filter((element) => isVisible(element) && isPositionsHeader(element, cryptoOnly))
    .sort((a, b) => textOf(a).length - textOf(b).length)[0];
  if (!headerRow) return [];
  const headers = headerCellItems(headerRow);
  const col = (label) => headers.findIndex((item) => item.label === label);
  const ix = {
    code: col('Varlık'), price: col('Fiyat'), avg: col('Ort. Maliyet'),
    units: col('Adet'), allocation: col('Dağılım'), daily: col('Günlük getiri'), total: col('Toplam getiri'),
    value: col('Pozisyon'),
  };
  const requiredIndexes = cryptoOnly
    ? [ix.code, ix.price, ix.units]
    : [ix.code, ix.price, ix.units];
  if (requiredIndexes.some((value) => value < 0)) return [];
  const rowNodes = [...root.querySelectorAll('tr, [role="row"], [class*="row" i], li, div')]
    .filter((element) => element !== headerRow && isVisible(element))
    .map((element) => ({ element, text: textOf(element) }))
    .filter(({ text }) => text.length > 0 && text.length < 600 && /[₺$€]|\b(?:USD|TRY)\b/i.test(text))
    .sort((a, b) => a.text.length - b.text.length);
  const found = new Map();
  const moneyFrom = (value) => {
    return parseMoney(value);
  };
  const percentFrom = (value) => {
    const text = String(value || '').replace(/[()]/g, ' ');
    const matches = [...text.matchAll(/([−+-])?\s*%\s*([\d.,]+)|([−+-])?\s*([\d.,]+)\s*%/g)];
    const match = matches.at(-1);
    if (!match) return null;
    const sign = match[1] || match[3] || '';
    const number = parseLocaleNumber(match[2] || match[4]);
    return number === null ? null : (sign === '-' || sign === '−' ? -number : number);
  };
  for (const { element } of rowNodes) {
    const containers = [element, ...element.querySelectorAll('tr, [role="row"], [class*="row" i], li, div')]
      .filter((container) => isVisible(container) && container.children.length >= 4 && container.children.length <= 12)
      .sort((a, b) => textOf(a).length - textOf(b).length);
    let cells = null;
    let rowElement = element;
    let sourceCells = [];
    for (const container of containers) {
      const cellElements = directCellElements(container).filter(isVisible);
      if (cellElements.length < 4 || cellElements.length > 12) continue;
      // Bazı Midas satırlarında DOM hücre sayısı başlık sayısına eşit olsa da
      // gizli/ek hücreler yüzünden sıra kayabiliyor. Her alanı başlığın x konumuyla
      // eşleştir; uzak hücreyi boş bırakıp yanlış alanı adet/maliyet olarak okuma.
      const unused = new Set(cellElements);
      const sourceAligned = [];
      const aligned = headers.map(({ box }) => {
        const x = (box.left + box.right) / 2;
        const nearest = [...unused].reduce((best, candidate) => {
          const rect = candidate.getBoundingClientRect();
          const distance = Math.abs((rect.left + rect.right) / 2 - x);
          return !best || distance < best.distance ? { candidate, distance } : best;
        }, null);
        if (!nearest || nearest.distance > Math.max(32, box.width / 2)) {
          sourceAligned.push('');
          return '';
        }
        unused.delete(nearest.candidate);
        const value = textOf(nearest.candidate);
        sourceAligned.push(value);
        return value;
      });
      const code = assetCodeAtRow(root, container, headers[ix.code], cryptoOnly)
        || String(aligned[ix.code] || '').match(/\b[A-Z][A-Z0-9.-]{1,9}\b/)?.[0] || '';
      if (code && moneyFrom(aligned[ix.price]) !== null
        && (ix.avg < 0 || moneyFrom(aligned[ix.avg]) !== null)) {
        cells = aligned;
        sourceCells = sourceAligned;
        rowElement = container;
        break;
      }
      // Midas bazen hücreleri ayrı sütunlarda değil, iç içe span/div metinleri
      // olarak üretir. Satır içindeki görünen metin düğümlerini sütunların x
      // koordinatlarına göre tekrar eşleştir; hücre sayısının eşit olmasına
      // veya her alanın başlık genişliğine sığmasına bağlı kalma.
      const rowBox = container.getBoundingClientRect();
      const rowCenterY = (rowBox.top + rowBox.bottom) / 2;
      const leafTokens = [...container.querySelectorAll('*')]
        .filter(isVisible)
        .map((node) => ({ node, text: textOf(node), box: node.getBoundingClientRect() }))
        .filter(({ node, text, box }) => text && text.length <= 100 && box.height > 0
          && box.top >= rowBox.top - 3 && box.bottom <= rowBox.bottom + 3
          && ![...node.children].some((child) => isVisible(child) && textOf(child) === text));
      if (leafTokens.length >= 3) {
        const unusedTokens = new Set(leafTokens);
        const tokenAligned = headers.map(({ box }) => {
          const x = (box.left + box.right) / 2;
          const nearest = [...unusedTokens].reduce((best, token) => {
            const dx = Math.abs((token.box.left + token.box.right) / 2 - x);
            const dy = Math.abs((token.box.top + token.box.bottom) / 2 - rowCenterY);
            const score = dx + dy * 0.45;
            return !best || score < best.score ? { token, score, dx } : best;
          }, null);
          if (!nearest || nearest.dx > Math.max(72, box.width)) return '';
          unusedTokens.delete(nearest.token);
          return nearest.token.text;
        });
        const tokenCode = assetCodeAtRow(root, container, headers[ix.code], cryptoOnly)
          || String(tokenAligned[ix.code] || '').match(/\b[A-Z][A-Z0-9.-]{1,9}\b/)?.[0] || '';
        if (tokenCode && moneyFrom(tokenAligned[ix.price]) !== null
          && (ix.avg < 0 || moneyFrom(tokenAligned[ix.avg]) !== null)) {
          cells = tokenAligned;
          sourceCells = tokenAligned;
          rowElement = container;
          break;
        }
      }
      const repeatedCell = cellElements.map(textOf);
      if (repeatedCell.length > 1 && repeatedCell.every((value) => value === repeatedCell[0])) {
        const code = assetCodeAtRow(root, container, headers[ix.code], cryptoOnly)
          || String(repeatedCell[0] || '').match(/\b[A-Z][A-Z0-9.-]{1,9}\b/)?.[0] || '';
        const moneyValues = [...repeatedCell[0].matchAll(/([−-])?\s*(?:₺|\$|€|USD|TRY)\s*([\d.,]+)/gi)]
          .map((match) => parseMoney(match[0])).filter((value) => value !== null);
        if (code && moneyValues.length >= 2) {
          const symbol = repeatedCell[0].match(/\$|€|USD|TRY|₺/i)?.[0] || '₺';
          const percents = [...repeatedCell[0].matchAll(/([−+-])?\s*%\s*([\d.,]+)|([−+-])?\s*([\d.,]+)\s*%/g)]
            .map((match) => `${match[1] || match[3] || ''}${match[2] || match[4]}%`);
          cells = Array(headers.length).fill('');
          cells[ix.code] = code;
          cells[ix.price] = `${symbol}${Math.abs(moneyValues[0])}`;
          cells[ix.avg] = `${symbol}${Math.abs(moneyValues[1])}`;
          cells[ix.daily] = `${moneyValues[2] < 0 ? '-' : ''}${symbol}${Math.abs(moneyValues[2] || 0)} ${percents[1] || ''}`;
          cells[ix.total] = `${moneyValues[3] < 0 ? '-' : ''}${symbol}${Math.abs(moneyValues[3] || 0)} ${percents[2] || ''}`;
          cells[ix.allocation] = percents[0] || '';
          sourceCells = sourceAligned;
          rowElement = container;
          break;
        }
      }
    }
    if (!cells) continue;
    const code = assetCodeAtRow(root, rowElement, headers[ix.code], cryptoOnly)
      || String(cells[ix.code] || '').match(/\b[A-Z][A-Z0-9.-]{1,9}\b/)?.[0] || '';
    if (!code || found.has(code)) continue;
    const text = cells.join(' ');
    const fields = {
      code,
      units: ix.units >= 0 ? parseQuantity(cells[ix.units]) : null,
      unitsText: ix.units >= 0 ? String(cells[ix.units] || '').trim() : '',
      price: moneyFrom(cells[ix.price]),
      avgCost: moneyFrom(cells[ix.avg]) ?? null,
      marketValue: cryptoOnly ? moneyFrom(cells[ix.value]) ?? null : null,
      allocationPct: ix.allocation >= 0 ? percentFrom(cells[ix.allocation]) ?? null : null,
      dailyPL: ix.daily >= 0 ? moneyFrom(cells[ix.daily]) ?? null : null,
      dailyPct: ix.daily >= 0 ? percentFrom(cells[ix.daily]) ?? null : null,
      totalPL: ix.total >= 0 ? moneyFrom(cells[ix.total]) ?? null : null,
      totalPct: ix.total >= 0 ? percentFrom(cells[ix.total]) ?? null : null,
      currency: /\$|\bUSD\b/i.test(String(cells[ix.price] || '')) ? 'USD' : 'TRY',
    };
    if (code) {
      fields.domCells = headers.map(({ label }, index) => ({
        header: label, raw: sourceCells[index] || '', selected: cells[index] || '',
      }));
    }
    // Fiyatla miktar değerlerinin tesadüfen yakın olması geçerli bir pozisyonu
    // reddetmemeli; yalnızca adet hücresinde para simgesi varsa alan eşleşmesi bozuktur.
    if (/[₺$€]|\b(?:USD|TRY)\b/i.test(fields.unitsText)) {
      fields.units = null;
      fields.unitsText = `${fields.unitsText} (fiyatla aynı, adet reddedildi)`.trim();
    }
    if (!(fields.units > 0)) continue;
    if (fields.price > 0 && fields.avgCost > 0 && Number.isFinite(fields.totalPct)) {
      const calculatedPct = (fields.price / fields.avgCost - 1) * 100;
      if (Math.abs(calculatedPct - fields.totalPct) > 15) {
        fields.costDiagnostic = `ortalama maliyet/toplam getiri uyuşmuyor (${calculatedPct.toFixed(2)}% / ${fields.totalPct.toFixed(2)}%)`;
        fields.avgCost = null;
      }
    }
    if (fields.price > 0 && fields.avgCost > 0) found.set(code, fields);
    else if (fields.price > 0 && fields.domCells) found.set(code, fields);
  }
  return [...found.values()];
}

function positionTableDiagnosis(cryptoOnly, rows) {
  const root = positionsRoot(cryptoOnly);
  const headers = root ? [...root.querySelectorAll('tr, [role="row"], [class*="row" i], div')]
    .filter((element) => isVisible(element) && isPositionsHeader(element, cryptoOnly))
    .sort((a, b) => textOf(a).length - textOf(b).length) : [];
  const rowCandidates = root ? [...root.querySelectorAll('tr, [role="row"], [class*="row" i], li, div')]
    .filter((element) => !headers.includes(element) && isVisible(element))
    .map(textOf)
    .filter((text) => text.length > 0 && text.length < 600 && /[₺$€]|\b(?:USD|TRY)\b/i.test(text)).length : 0;
  const rootText = root ? textOf(root) : '';
  const emptyStateFound = /(?:açık\s+)?(?:pozisyon|varlık|kripto hesabı)[^.!?]{0,60}(?:yok|bulunmuyor|bulunamadı|henüz)|(?:yok|bulunmuyor|bulunamadı|henüz)[^.!?]{0,60}(?:pozisyon|varlık|kripto hesabı)/iu.test(rootText);
  return {
    tableFound: Boolean(root && headers.length),
    emptyStateFound,
    headingFound: [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"], span, div')]
      .some((element) => isVisible(element) && /^pozisyonlar$/iu.test(textOf(element))),
    headerFound: headers.length > 0,
    columns: headers[0] ? headerCells(headers[0]) : [],
    rowCandidates,
    validRows: rows.length,
  };
}

function assetHintsFor(element) {
  const hints = [];
  const addNodeHints = (node) => {
    for (const attribute of [...(node.attributes || [])]) {
      if (!/aria-label|title|alt|symbol|ticker|asset|coin|currency|code|href|src|^data-/i.test(attribute.name)) continue;
      const value = String(attribute.value || '').trim();
      if (value && value.length <= 180 && !hints.includes(value)) hints.push(value);
    }
  };
  for (const node of [element, ...element.querySelectorAll('*')]) {
    addNodeHints(node);
    const value = textOf(node);
    // Only keep text from this row subtree. Looking at siblings of an individual
    // side/date cell leaked other orders' crypto pairs into symbol diagnosis.
    if (value && value.length <= 100 && !TRADE_WORDS.test(value) && !DATE_WORDS.test(value)
      && !hints.includes(value)) hints.push(value);
    if (hints.length >= 20) return hints;
  }
  return hints;
}

function assetCodeAtRow(root, rowElement, headerItem, allowStablecoins = false) {
  const rowBox = rowElement.getBoundingClientRect();
  const rowY = (rowBox.top + rowBox.bottom) / 2;
  const headerBox = headerItem?.box;
  const assetX = headerBox ? (headerBox.left + headerBox.right) / 2 : null;
  const excluded = new Set(['AL', 'SAT', 'BUY', 'SELL', 'USD', 'TRY', 'TL', 'FON', 'BIST', 'NASDAQ']);
  if (!allowStablecoins) { excluded.add('USDT'); excluded.add('USDC'); }
  const candidates = [...root.querySelectorAll('*')]
    .filter(isVisible)
    .map((node) => ({ node, code: textOf(node), box: node.getBoundingClientRect() }))
    .filter(({ code, box }) => /^[A-Z][A-Z0-9.-]{1,9}$/.test(code)
      && !excluded.has(code) && box.width <= 100 && box.height <= 32)
    .map((item) => ({
      ...item,
      yDistance: Math.abs((item.box.top + item.box.bottom) / 2 - rowY),
      xDistance: assetX == null ? 0 : Math.abs((item.box.left + item.box.right) / 2 - assetX),
    }))
    .filter((item) => item.yDistance <= Math.max(18, rowBox.height / 2 + 4))
    .sort((a, b) => a.yDistance - b.yDistance || a.xDistance - b.xDistance);
  return candidates[0]?.code || '';
}

function orderHistoryRoot(cryptoOnly = false) {
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"], span, div')]
    .filter((element) => isVisible(element) && /^emir\s+geçmişi$/iu.test(textOf(element)))
    .sort((a, b) => textOf(a).length - textOf(b).length);
  for (const heading of headings) {
    const cryptoHeading = isCryptoHistoryHeading(heading);
    if (cryptoOnly ? !cryptoHeading : cryptoHeading) continue;
    let headerScope = null;
    for (let scope = heading.parentElement, depth = 0; scope && depth < 12; scope = scope.parentElement, depth += 1) {
      const hasOrderHeader = [...scope.querySelectorAll('tr, [role="row"], [class*="row" i], div')]
        .some((element) => isVisible(element) && isOrderHeader(element, cryptoOnly));
      if (!hasOrderHeader) continue;
      headerScope = scope;
      const hasPager = [...scope.querySelectorAll('span, div, p')]
        .some((element) => isVisible(element) && /^\d+\s*[-–]\s*\d+\s*\/\s*\d+$/.test(textOf(element)));
      if (hasPager) return scope;
    }
    if (headerScope) return headerScope;
  }
  // The Crypto workspace can render its order table without the “Emir geçmişi”
  // heading. Fall back to the visible grid only when the Crypto tab is active.
  if (cryptoOnly && activeCryptoTab()) {
    const headers = [...document.querySelectorAll('tr, [role="row"], [class*="row" i], div')]
      .filter((element) => isVisible(element) && isOrderHeader(element, true))
      .sort((a, b) => textOf(a).length - textOf(b).length);
    for (const header of headers) {
      for (let scope = header.parentElement, depth = 0; scope && depth < 12; scope = scope.parentElement, depth += 1) {
        const hasPager = [...scope.querySelectorAll('span, div, p')]
          .some((element) => isVisible(element) && /^\d+\s*[-–]\s*\d+\s*\/\s*\d+$/.test(textOf(element)));
        if (hasPager) return scope;
      }
      return header.parentElement;
    }
  }
  return null;
}

function activeCryptoTab() {
  if (/kripto|crypto/i.test(`${location.pathname} ${location.search} ${location.hash}`)) return true;
  return [...document.querySelectorAll('[role="tab"], [aria-selected="true"], [aria-pressed="true"], [aria-current], button, a, [class*="active" i], [class*="selected" i]')]
    .filter(isVisible)
    .some((element) => {
      const label = textOf(element);
      const state = [element.getAttribute('aria-selected'), element.getAttribute('aria-pressed'),
        element.getAttribute('aria-current'), String(element.className?.baseVal || element.className || '')]
        .join(' ');
      return /^\s*(?:\d+\s*)?kripto(?:\s+(?:hesabı|hesabi|portföyü|portfoyu))?\s*$/iu.test(label)
        && /true|page|active|selected|current/i.test(state);
    });
}

function isCryptoHistoryHeading(heading) {
  for (let node = heading; node && node !== document.body; node = node.parentElement) {
    const aria = [node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('data-testid')]
      .filter(Boolean).join(' ');
    if (/kripto|crypto/i.test(`${aria} ${textOf(node)}`) && textOf(node).length < 2600) return true;
  }
  return /kripto|crypto/i.test(location.href);
}

function candidateElements(root, scanStats, cryptoOnly = false) {
  const headerCandidates = [...root.querySelectorAll('tr, [role="row"], [class*="row" i], div')]
    .filter((element) => isVisible(element) && isOrderHeader(element, cryptoOnly))
    .sort((a, b) => textOf(a).length - textOf(b).length);
  const headerRow = headerCandidates[0];
  if (!headerRow) return [];
  const headerItems = headerCellItems(headerRow);
  const headers = headerItems.map((item) => item.label);
  const norm = headers.map((header) => header.toLocaleLowerCase('tr'));
  const index = (pattern) => norm.findIndex((header) => pattern.test(header));
  const columns = {
    code: index(/varlık/), status: index(/durum/), side: index(/alış\s*\/\s*satış/),
    units: index(/adet/), price: index(/^fiyat$/), date: index(/emir tarihi/),
  };
  if (columns.status < 0 || columns.side < 0 || columns.units < 0 || columns.price < 0 || columns.date < 0) return [];
  if (scanStats) scanStats.headers = headers;
  if ([columns.status, columns.side, columns.units, columns.price, columns.date].some((column) => column < 0)) return [];

  // Midas görsel tablosunda satır, semantic table/role=row kullanmadan iç içe
  // div'lerle çizilebiliyor. Bu yüzden başlık satırının kardeşlerini varsaymak
  // yerine, Emir geçmişi panelinde işlem yönü ve tarih taşıyan en küçük satır
  // kapsayıcılarını bulup değer hücrelerini başlıkların x konumlarıyla eşle.
  const nodes = [...root.querySelectorAll('tr, [role="row"], [class*="row" i], [class*="order" i], [class*="item" i], li, article, a, button, div')]
    .filter((element) => element !== headerRow && isVisible(element))
    .map((element) => ({ element, text: textOf(element) }))
    .filter(({ text }) => text.length > 0 && text.length < 360
      && TRADE_WORDS.test(text) && DATE_WORDS.test(text))
    .sort((a, b) => a.text.length - b.text.length);
  const uniqueRows = new Map();
  for (const { element } of nodes) {
    const cellContainers = [element, ...element.querySelectorAll('tr, [role="row"], [class*="row" i], li, div')]
      .filter((container) => isVisible(container) && container.children.length >= 4 && container.children.length <= 14)
      .sort((a, b) => textOf(a).length - textOf(b).length);
    let cells = null;
    let matchedContainer = null;
    let directCount = 0;
    for (const container of cellContainers) {
      const cellElements = directCellElements(container).filter(isVisible);
      if (cellElements.length < 4 || cellElements.length > 14) continue;
      const rawCells = cellElements.map(textOf);
      const aligned = rawCells.length === headers.length ? rawCells : headerItems.map(({ box }) => {
        const targetX = (box.left + box.right) / 2;
        const nearest = cellElements.reduce((best, candidate) => {
          const rect = candidate.getBoundingClientRect();
          const distance = Math.abs((rect.left + rect.right) / 2 - targetX);
          return !best || distance < best.distance ? { candidate, distance } : best;
        }, null);
        return nearest ? textOf(nearest.candidate) : '';
      });
      const sideText = aligned[columns.side] || '';
      const dateText = aligned[columns.date] || '';
      if (TRADE_WORDS.test(sideText) && DATE_WORDS.test(dateText)) {
        cells = aligned;
        matchedContainer = container;
        directCount = rawCells.length;
        break;
      }
    }
    // Bazı Atlas tabloları sanal liste satırlarını hücre yerine <div> metinleri
    // olarak sunuyor. Başlık x koordinatlarıyla aynı satırdaki kısa metinleri eşle.
    if (!cells) {
      const rowBox = element.getBoundingClientRect();
      const rowY = (rowBox.top + rowBox.bottom) / 2;
      const tokens = [...element.querySelectorAll('*')].filter(isVisible)
        .map((node) => ({ node, text: textOf(node), box: node.getBoundingClientRect() }))
        .filter((item) => item.text && item.text.length <= 100 && item.box.height > 0
          && Math.abs((item.box.top + item.box.bottom) / 2 - rowY) <= Math.max(18, rowBox.height / 2 + 8))
        .sort((a, b) => a.box.left - b.box.left);
      const aligned = headerItems.map(({ box }) => {
        const targetX = (box.left + box.right) / 2;
        return tokens.reduce((best, item) => {
          const distance = Math.abs((item.box.left + item.box.right) / 2 - targetX);
          return !best || distance < best.distance ? { text: item.text, distance } : best;
        }, null)?.text || '';
      });
      const sideText = aligned[columns.side] || '';
      const dateText = aligned[columns.date] || '';
      if (TRADE_WORDS.test(sideText) && DATE_WORDS.test(dateText)) {
        cells = aligned;
        matchedContainer = element;
        directCount = tokens.length;
      }
    }
    if (!cells) continue;
    if (scanStats) {
      scanStats.rowNodes += 1;
      if (directCount === headers.length) scanStats.cellCountMatches += 1;
    }
    if (scanStats) scanStats.tradeDateMatches += 1;
    const status = cells[columns.status] || '';
    if (scanStats) {
      const category = statusCategory(status);
      scanStats.statuses[category] = (scanStats.statuses[category] || 0) + 1;
      if (executedStatus(status)) scanStats.completedStatuses += 1;
    }
    // Yalnızca açıkça tamamlanan işlemleri içe aktar; bekleyen/iptal/kısmi emirleri atla.
    if (!executedStatus(status)) continue;
    const text = cells.join('\n');
    const row = {
      text, headers, cells,
      sourceId: element.getAttribute('data-order-id') || element.getAttribute('data-id') || '',
      assetCode: assetCodeAtRow(root,
        matchedContainer && matchedContainer.getBoundingClientRect().height <= 80 ? matchedContainer : element,
        columns.code >= 0 ? headerItems[columns.code] : undefined),
      codeHints: assetHintsFor(matchedContainer || element),
    };
    const key = row.sourceId || text.replace(/\s+/g, ' ').trim();
    if (key && !uniqueRows.has(key)) uniqueRows.set(key, row);
  }

  // Midas yatırım hesabı bazı görünüm boyutlarında satır kapsayıcılarını
  // sütunlara bölüyor; hiçbir DOM satırının metninde hem yön hem tarih
  // bulunmadığından üstteki satır tabanlı arama boş dönebiliyor. Görünen kısa
  // metinleri aynı yatay bantta başlık koordinatlarına göre eşle.
  const textTokens = [...root.querySelectorAll('span, div, p, time, button, [role="cell"], [role="gridcell"]')]
    .filter(isVisible)
    .map((node) => ({ node, text: textOf(node), box: node.getBoundingClientRect() }))
    .filter((item) => item.text && item.text.length <= 100 && item.box.height > 0
      && item.box.top > headerRow.getBoundingClientRect().bottom - 4)
    .filter((item) => ![...item.node.children].some((child) => isVisible(child) && textOf(child) === item.text));
  const sideTokens = textTokens.filter((item) => /^(alış|alım|satış|satım|buy|sell)$/iu.test(item.text));
  if (scanStats) {
    scanStats.geometryTextTokens = textTokens.length;
    scanStats.geometrySideTokens = sideTokens.length;
    scanStats.geometryDateTokens = textTokens.filter((item) => DATE_WORDS.test(item.text)).length;
  }
  for (const sideToken of sideTokens) {
    const rowY = (sideToken.box.top + sideToken.box.bottom) / 2;
    const rowTokens = textTokens.filter((item) =>
      Math.abs((item.box.top + item.box.bottom) / 2 - rowY) <= Math.max(14, sideToken.box.height / 2 + 5));
    const aligned = headerItems.map(({ box }) => {
      const targetX = (box.left + box.right) / 2;
      return rowTokens.reduce((best, item) => {
        const distance = Math.abs((item.box.left + item.box.right) / 2 - targetX);
        return !best || distance < best.distance ? { text: item.text, distance } : best;
      }, null)?.text || '';
    });
    const sideText = aligned[columns.side] || '';
    const dateText = aligned[columns.date] || '';
    if (!TRADE_WORDS.test(sideText) || !DATE_WORDS.test(dateText)) continue;
    const status = aligned[columns.status] || '';
    if (!executedStatus(status)) continue;
    const text = aligned.join('\n');
    const row = {
      text, headers, cells: aligned, sourceId: '',
      assetCode: assetCodeAtRow(root, sideToken.node, columns.code >= 0 ? headerItems[columns.code] : undefined),
      codeHints: [...new Set(rowTokens.map((item) => item.text).filter((value) => value.length <= 100))],
    };
    const key = text.replace(/\s+/g, ' ').trim();
    if (key && !uniqueRows.has(key)) {
      uniqueRows.set(key, row);
      if (scanStats) {
        scanStats.rowNodes += 1;
        if (aligned.filter(Boolean).length === headers.length) scanStats.cellCountMatches += 1;
        scanStats.tradeDateMatches += 1;
        const category = statusCategory(status);
        scanStats.statuses[category] = (scanStats.statuses[category] || 0) + 1;
        scanStats.completedStatuses += 1;
      }
    }
  }
  return [...uniqueRows.values()].slice(0, 500);
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

async function collectCompletedHistory(cryptoOnly = false) {
  const collected = new Map();
  const scanStats = { headers: [], rowNodes: 0, cellCountMatches: 0, tradeDateMatches: 0,
    completedStatuses: 0, geometryTextTokens: 0, geometrySideTokens: 0, geometryDateTokens: 0, statuses: {} };
  // Midas Crypto SPA tablosu geç render edilebiliyor; başta boşsa kısa bekle.
  let root = orderHistoryRoot(cryptoOnly);
  for (let attempt = 0; !root && cryptoOnly && attempt < 20; attempt += 1) {
    await wait(200);
    root = orderHistoryRoot(true);
  }
  if (!root) return {
    rows: [], pageCount: 0, paginationStop: cryptoOnly
      ? 'Midas Kripto ekranında Emir geçmişi tablosu bulunamadı.'
      : 'Bu Midas ekranında Emir geçmişi tablosu bulunamadı.',
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
    for (const row of candidateElements(root, scanStats, cryptoOnly)) {
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
  const raw = String(value).trim();
  const signBeforeCurrency = /(?:^|[\s(])[-−]\s*(?:(?:₺|\$|€|USD|TRY)\s*)?\d/i.test(raw)
    || /(?:₺|\$|€|USD|TRY)\s*[-−]\s*\d/i.test(raw);
  const signBeforeNumber = /(?:^|[\s(])\+\s*(?:(?:₺|\$|€|USD|TRY)\s*)?\d/i.test(raw)
    || /(?:₺|\$|€|USD|TRY)\s*\+\s*\d/i.test(raw);
  let s = raw.match(/\d[\d.,]*/)?.[0] || '';
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? (signBeforeCurrency ? -Math.abs(n) : signBeforeNumber ? Math.abs(n) : n) : null;
}

function parseMoney(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const token = raw.match(/[+-]?\d[\d.,]*/)?.[0] || '';
  const unsigned = token.replace(/^[+-]/, '');
  const isForeignCurrency = /\$|€|\b(?:USD|USDT|USDC)\b/i.test(raw);
  // Turkish Midas prices use dots for thousands and commas for decimals:
  // ₺126.677 means 126,677 TL, while $126.677 remains a decimal quote.
  if (!isForeignCurrency && /^\d{1,3}(?:\.\d{3})+$/.test(unsigned)) {
    return parseLocaleNumber(raw.replace(token, token.replaceAll('.', '')));
  }
  return parseLocaleNumber(raw);
}

function parseQuantity(value) {
  const number = String(value || '').trim().match(/[+-]?\d[\d.,]*/)?.[0];
  if (!number) return null;
  // Midas Türkçe arayüzünde 1.234 adet bin iki yüz otuz dörttür; ondalık
  // paylar virgülle (0,125) gösterilir.
  if (/^\d{1,3}(?:\.\d{3})+$/.test(number)) return Number(number.replaceAll('.', ''));
  return parseLocaleNumber(number);
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
            const amount = parseMoney(line.replace(/^.*?(?:alım gücü|nakit bakiye|takas bekleyen bakiye)/i, ''));
            if (amount !== null) return amount;
          }
        }
        return null;
      };
      const dailyLine = lines.find((line) => /günlük/i.test(line));
      const dailyMoney = String(dailyLine || '').match(/([−-])?\s*(?:₺|\$|€|TRY|USD)\s*([−-]?\s*[\d.,]+)/i);
      const dailyPctMatch = String(dailyLine || '').match(/([−-])?\s*%\s*([\d.,]+)|([−-])?\s*([\d.,]+)\s*%/);
      const dailyPctValue = dailyPctMatch
        ? parseLocaleNumber(dailyPctMatch[2] || dailyPctMatch[4]) : null;
      return {
        totalValue: valueLine ? parseMoney(valueLine) : null,
        dailyChange: dailyMoney ? parseMoney(dailyMoney[0]) : null,
        dailyPct: dailyPctValue === null ? null
          : (dailyPctMatch[1] || dailyPctMatch[3] ? -Math.abs(dailyPctValue) : Math.abs(dailyPctValue)),
        tryBuyingPower: amountAfter(/alım gücü/i),
        tryCash: amountAfter(/nakit bakiye/i),
        trySettlement: amountAfter(/takas bekleyen bakiye/i),
      };
    }
  }
  return null;
}

const CRYPTO_NAME_CODES = new Map([
  ['bitcoin cash', 'BCH'], ['shiba inu', 'SHIB'], ['binance coin', 'BNB'],
  ['bitcoin', 'BTC'], ['btc', 'BTC'], ['ethereum', 'ETH'], ['ether', 'ETH'], ['eth', 'ETH'],
  ['solana', 'SOL'], ['sol', 'SOL'], ['ripple', 'XRP'], ['xrp', 'XRP'], ['dogecoin', 'DOGE'], ['doge', 'DOGE'],
  ['bnb', 'BNB'], ['cardano', 'ADA'], ['ada', 'ADA'],
  ['avalanche', 'AVAX'], ['avax', 'AVAX'], ['polkadot', 'DOT'], ['dot', 'DOT'],
  ['chainlink', 'LINK'], ['link', 'LINK'], ['litecoin', 'LTC'], ['ltc', 'LTC'],
  ['stellar', 'XLM'], ['xlm', 'XLM'], ['tron', 'TRX'], ['trx', 'TRX'],
  ['shiba', 'SHIB'], ['matic', 'POL'], ['polygon', 'POL'],
  ['toncoin', 'TON'], ['ton', 'TON'], ['uniswap', 'UNI'], ['uni', 'UNI'],
  ['bch', 'BCH'], ['cosmos', 'ATOM'], ['atom', 'ATOM'],
  ['near protocol', 'NEAR'], ['near', 'NEAR'], ['aptos', 'APT'], ['apt', 'APT'],
  ['sui', 'SUI'], ['arbitrum', 'ARB'], ['arb', 'ARB'], ['optimism', 'OP'], ['op', 'OP'],
  ['pepe', 'PEPE'], ['pepe coin', 'PEPE'], ['aave', 'AAVE'], ['maker', 'MKR'],
  ['render', 'RENDER'], ['render token', 'RENDER'], ['injective', 'INJ'], ['inj', 'INJ'],
  ['tether', 'USDT'], ['usd coin', 'USDC'], ['pax gold', 'PAXG'],
]);

function normalizeRow(row, cryptoOnly = false) {
  const text = row.text;
  const lower = text.toLocaleLowerCase('tr');
  const cells = row.cells || [];
  const headers = row.headers || [];
  const valueByHeader = (pattern) => {
    const i = headers.findIndex((header) => pattern.test(header));
    return i >= 0 ? cells[i] || '' : '';
  };
  const sideValue = valueByHeader(/alış\s*\/\s*satış|işlem yönü|yön/);
  const side = sideValue || text;
  const type = /satış|satım|sell/i.test(side) ? 'SAT' : /alış|alım|buy/i.test(side) ? 'AL' : '';
  const dateValue = valueByHeader(/emir tarihi|işlem tarihi|tarih/);
  const date = parseDate(dateValue || text);
  const time = String(dateValue || text).match(/\b\d{1,2}:\d{2}:\d{2}\b/)?.[0] || '';
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

  const codeValue = valueByHeader(/varlık|sembol|fon kodu|hisse kodu/i);
  const codeExcluded = new Set(['AL', 'SAT', 'ALIŞ', 'ALIM', 'SATIŞ', 'SATIM', 'BUY', 'SELL', 'USD', 'USDT', 'USDC', 'TRY', 'TL', 'ADET', 'LOT', 'FON', 'PIYASA', 'LIMIT', 'GERCEKLESTI', 'TAMAMLANDI']);
  const codeSources = [row.assetCode, codeValue, text, ...(row.codeHints || [])].filter(Boolean).map(String);
  const stablecoinPair = cryptoOnly && codeSources.some((value) =>
    /(?:^|[^A-Z0-9])(?:USDT|USDC)\s*[\/_-]\s*(?:USDT|USDC|USD|TRY|TL)(?:$|[^A-Z0-9])/i.test(value));
  const pairCode = codeSources.map((value) => value.match(/\b([A-Z][A-Z0-9.-]{1,11})\s*[\/_-]\s*(?:USDT|USDC|USD|TRY|TL)\b/i)?.[1]?.toUpperCase())
    .find((candidate) => candidate && !['AL', 'SAT', 'BUY', 'SELL', 'TRY', 'TL'].includes(candidate));
  const cryptoNameCode = cryptoOnly ? codeSources.flatMap((value) => {
    const normalized = value.toLocaleLowerCase('en').replace(/[_-]+/g, ' ');
    return [...CRYPTO_NAME_CODES.entries()]
      .filter(([name]) => new RegExp(`(?:^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(normalized))
      .map(([, code]) => code);
  }).find(Boolean) : '';
  let code = pairCode || cryptoNameCode || (row.assetCode && !codeExcluded.has(String(row.assetCode).toUpperCase())
    ? String(row.assetCode).toUpperCase()
    : (codeValue || getLabel(/sembol|varlık|fon kodu|hisse kodu/i, 'sembol|varlık|fon kodu|hisse kodu'))
      .match(/[A-Z][A-Z0-9.-]{1,11}/)?.[0] || '');
  if (codeExcluded.has(code.toUpperCase()) && !pairCode) code = '';
  if (!code) {
    for (const hint of row.codeHints || []) {
      const value = String(hint).trim();
      const direct = value.match(/^([A-Z][A-Z0-9.-]{1,9})$/)?.[1];
      const labelled = value.match(/(?:symbol|ticker|asset(?:\s+code)?|sembol|varlık(?:\s+kodu)?)\s*[:=#/-]\s*([A-Z][A-Z0-9.-]{1,9})/i)?.[1];
      const pathValue = value.match(/\/(?:symbols?|assets?|tickers?|funds?)\/([A-Z][A-Z0-9.-]{1,9})(?:\/|$|[?#])/i)?.[1];
      const candidate = direct || labelled || pathValue || '';
      if (candidate && !codeExcluded.has(candidate.toLocaleUpperCase('tr'))) { code = candidate.toLocaleUpperCase('tr'); break; }
    }
  }
  if (!code) {
    code = text.match(/\b[A-Z][A-Z0-9.-]{1,11}\b/g)?.find((token) => !codeExcluded.has(token)) || '';
  }

  const unitsValue = valueByHeader(/gerçekleşen miktar|gerçekleşen adet|adet|miktar|lot/i)
    || getLabel(/miktar|adet|lot|gerçekleşen miktar|gerçekleşen adet/i, 'miktar|adet|lot|gerçekleşen miktar|gerçekleşen adet');
  let units = parseQuantity(unitsValue);
  if (!(units > 0)) {
    const match = text.match(/([\d.,]+)\s*(?:adet|lot|pay|hisse)\b/i)
      || text.match(/(?:adet|lot|pay|hisse)\s*[:：]?\s*([\d.,]+)/i);
    units = match ? parseQuantity(match[1]) : null;
  }

  const priceValue = valueByHeader(/birim fiyat|gerçekleşme fiyatı|işlem fiyatı|fiyat/i)
    || getLabel(/birim fiyat|gerçekleşme fiyatı|işlem fiyatı|fiyat/i, 'birim fiyat|gerçekleşme fiyatı|işlem fiyatı|fiyat');
  let price = parseMoney(priceValue);
  const currencyValues = [...text.matchAll(/(?:₺|\$|€|USD|TRY)\s*([+-]?\d[\d.,]*)/gi)]
    .map((match) => parseMoney(match[0])).filter((value) => value > 0);
  const repeatedCellText = cells.length > 1 && cells.every((cell) => cell === cells[0]);
  // Midas görsel satırlarında başlığa göre eşleşen hücre bazen adet sütununa
  // düşebiliyor. İşlem satırında hem toplam hem birim fiyat para birimiyle
  // gösterildiğinden son para tutarı birim fiyattır; hücre haritasını düzeltir.
  if (currencyValues.length >= 2) {
    price = currencyValues[currencyValues.length - 1];
  } else if (repeatedCellText || priceValue === text || price === units) {
    if (currencyValues.length && units > 0) price = currencyValues[0] / units;
  }
  const totalValue = parseMoney(valueByHeader(/^toplam$/i));
  // Midas Crypto bazı satırlarda fiyat hücresini 0,002292, toplamı ise
  // 33,00 USDT gösteriyor. Adet × fiyat toplamla uyuşmuyorsa gerçek birim
  // fiyatı işlem toplamından türet; yanlış hücreyi fiyata aktarma.
  if (totalValue > 0 && units > 0 && price > 0
    && Math.abs(units * price - totalValue) / totalValue > 0.03) {
    price = totalValue / units;
  }
  if (!(price > 0) && totalValue > 0 && units > 0) price = totalValue / units;
  const amount = parseMoney(getLabel(/işlem tutarı|gerçekleşen tutar|toplam tutar|tutar/i, 'işlem tutarı|gerçekleşen tutar|toplam tutar|tutar'));
  if (!(price > 0) && amount > 0 && units > 0) price = amount / units;
  const fee = parseMoney(getLabel(/komisyon|masraf|ücret/i, 'komisyon|masraf|ücret')) || 0;
  const taxValue = valueByHeader(/stopaj|vergi kesintisi/i)
    || getLabel(/stopaj|vergi kesintisi/i, 'stopaj|vergi kesintisi');
  const taxMoney = String(taxValue || '').match(/(?:₺|TRY)\s*([\d.,]+)/i)?.[0];
  const withholdingTax = Math.max(0, parseMoney(taxMoney || taxValue) || 0);
  const currency = /\$|\bUSD\b|\bUSDT\b|\bUSDC\b/i.test(`${priceValue} ${text}`) ? 'USD'
    : /₺|\bTRY\b|\bTL\b/i.test(priceValue || text) ? 'TRY' : '';

  const missing = [];
  if (!date) missing.push('tarih');
  if (!type) missing.push('alış/satış');
  if (!code) missing.push('sembol');
  if (!(units > 0)) missing.push('miktar');
  if (!(price > 0)) missing.push('fiyat');
  const fieldDump = headers.map((header, index) => `${header}=${cells[index] || '—'}`).join(' | ');
  return {
    date, time, type, code, units, price, fee, withholdingTax, currency, sourceId: row.sourceId,
    rawText: text, missing, ignoredStablecoin: stablecoinPair,
    diagnostic: `Alanlar: ${fieldDump}. Ayrıştırılan: kod=${code || '—'}, yön=${type || '—'}, tarih=${date || '—'}, miktar=${units > 0 ? units : '—'}, fiyat=${price > 0 ? price : '—'}. ${!code ? `Sembol ipuçları: ${(row.codeHints || []).slice(0, 6).join(' / ') || 'bulunamadı'}. ` : ''}Eksik=${missing.join(',') || 'yok'}`,
  };
}

function deduplicateOrders(rows) {
  const unique = new Map();
  for (const row of rows) {
    const time = row.time || String(row.rawText || '').match(/\b\d{1,2}:\d{2}:\d{2}\b/)?.[0] || '';
    const key = row.sourceId
      ? `id:${row.sourceId}`
      : [row.date, row.code, row.type, time, row.units, row.price, row.fee, row.withholdingTax].join('|');
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ANALIZ_SCAN_VISIBLE_HISTORY') return undefined;
  const cryptoOnly = message.cryptoOnly === true;
  collectCompletedHistory(cryptoOnly).then(({ rows, pageCount, paginationStop, labels, start, scanStats }) => {
    const normalizedCandidates = rows.map((row) => normalizeRow(row, cryptoOnly));
    const uniqueRows = deduplicateOrders(normalizedCandidates);
    const duplicateOrdersRemoved = normalizedCandidates.length - uniqueRows.length;
    const ignoredStablecoinCount = cryptoOnly ? uniqueRows.filter((row) => row.ignoredStablecoin).length : 0;
    const normalized = uniqueRows.filter((row) => !row.ignoredStablecoin);
    const ready = normalized.filter((row) => !row.missing.length);
    const positions = cryptoOnly ? [] : positionSnapshotRows(false);
    const cryptoPositions = cryptoOnly ? positionSnapshotRows(true) : [];
    const positionsDiagnostic = cryptoOnly ? null : positionTableDiagnosis(false, positions);
    const cryptoPositionsDiagnostic = cryptoOnly ? positionTableDiagnosis(true, cryptoPositions) : null;
    const positionsCaptured = cryptoOnly ? false
      : positions.length > 0 || positionsDiagnostic?.emptyStateFound === true;
    const cryptoPositionsCaptured = cryptoOnly ? cryptoPositions.length > 0
      || cryptoPositionsDiagnostic?.emptyStateFound === true : false;
    if (!rows.length && !(cryptoOnly ? cryptoPositionsCaptured : positionsCaptured)) {
      const evidence = labels.length ? `Ekranda algılanan başlık/durum metinleri: ${labels.join(' · ')}.` : 'Ekranda tanınan emir tablosu başlığı görünmüyor.';
      const headers = scanStats?.headers?.length ? `Algılanan sütunlar: ${scanStats.headers.join(' · ')}.` : 'Satır sütunları eşleştirilemedi.';
      const statuses = Object.entries(scanStats?.statuses || {}).map(([name, count]) => `${name}: ${count}`).join(', ') || 'durum okunamadı';
      const rowStats = `Tablo teşhisi: ${scanStats?.pages || pageCount + 1} sayfa; ${scanStats?.rowNodes || 0} satır öğesi; ${scanStats?.cellCountMatches || 0} sütun sayısı uyan satır; ${scanStats?.tradeDateMatches || 0} alış/satış ve tarih uyan satır; ${scanStats?.completedStatuses || 0} tamamlandı durumlu satır; geometrik tarama ${scanStats?.geometryTextTokens || 0} metin, ${scanStats?.geometrySideTokens || 0} yön, ${scanStats?.geometryDateTokens || 0} tarih adayı buldu. Durum dağılımı: ${statuses}.`;
      sendResponse({ ok: false, accountSummary: cryptoOnly ? null : readAccountSummary(),
        positions, positionsCaptured, positionsDiagnostic, cryptoPositions, cryptoPositionsCaptured, cryptoPositionsDiagnostic,
        duplicateOrdersRemoved, ignoredStablecoinCount,
        error: `${cryptoOnly ? 'Midas Kripto' : 'Midas yatırım hesabı'} sayfasında tamamlanmış işlem satırı okunamadı. ${pageCount + 1} sayfa tarandı. ${start ? `Başlangıç sayfası: ${start}. ` : ''}${paginationStop ? `Sayfalama: ${paginationStop} ` : ''}${headers} ${rowStats} ${evidence}` });
      return;
    }
    sendResponse({ ok: true, rows: normalized, scannedPages: pageCount + 1,
      unmatchedCount: normalized.length - ready.length, accountSummary: cryptoOnly ? null : readAccountSummary(),
      duplicateOrdersRemoved, ignoredStablecoinCount,
      positions, positionsCaptured, positionsDiagnostic, cryptoPositions, cryptoPositionsCaptured, cryptoPositionsDiagnostic });
  }).catch((error) => {
    sendResponse({ ok: false, error: error.message || 'Midas emir geçmişi okunamadı.' });
  });
  return true;
});
