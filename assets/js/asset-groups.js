import { DB, cachedHistory, exactPriceAtIndex, lastIndex, fxToTRY } from './data.js';
import { getMidasAccountSnapshot } from './store.js';

const GROUP_ORDER = ['ETF', 'Fon', 'Hisse', 'Kripto', 'Diğer'];
const NO_DAILY_CHANGE_CODES = new Set(['THF', 'TP2']);

export function assetType(code, suppliedKind = '', suppliedCategory = '') {
  const kind = String(suppliedKind || DB.byCode.get(code)?.kind || '').toUpperCase();
  const category = String(suppliedCategory || DB.byCode.get(code)?.cat || DB.byCode.get(code)?.category || '').toLocaleLowerCase('tr');
  if (['US_ETF', 'BIST_ETF', 'BYF'].includes(kind) || /\betf\b|borsa yatırım fonu/.test(category)) return 'ETF';
  if (kind === 'CRYPTO') return 'Kripto';
  if (['YAT', 'EMK', 'GYF', 'GSYF'].includes(kind) || /fon|emeklilik/.test(category)) return 'Fon';
  if (['HISSE', 'BIST_STOCK', 'BIST_HISSE'].includes(kind) || /hisse|equity|stock/.test(category)) return 'Hisse';
  return 'Diğer';
}

export function groupAssetRows(rows) {
  const groups = new Map(GROUP_ORDER.map((label) => [label, []]));
  for (const row of rows || []) groups.get(assetType(row.code, row.kind, row.category))?.push(row);
  return GROUP_ORDER.map((label) => ({ label, rows: groups.get(label) })).filter((group) => group.rows.length);
}

export function currentMidasPositions() {
  const snapshot = getMidasAccountSnapshot();
  if (!snapshot?.summary?.totalValue || !Array.isArray(snapshot.positions) || !snapshot.positions.length) return null;
  return snapshot.positions.map((row) => {
    const meta = DB.byCode.get(row.code) || {};
    const currency = row.currency || meta.currency || (meta.kind === 'US_ETF' || meta.kind === 'CRYPTO' ? 'USD' : 'TRY');
    return {
      ...row,
      name: meta.name || row.code,
      kind: meta.kind || '',
      category: meta.cat || meta.category || '',
      currency,
      allocationPct: Number.isFinite(row.allocationPct) ? row.allocationPct : null,
      value: Number.isFinite(row.allocationPct) ? row.allocationPct : 0,
      weight: Number.isFinite(row.allocationPct) ? row.allocationPct : 0,
      // Midas'ın getiri hücrelerini kullanmıyoruz: arayüz yapısı değiştiğinde
      // yanlış sütunlar okunabiliyor. K/Z, site fiyat geçmişiyle hesaplanır.
      totalPLTRY: null,
      dailyPLTRY: null,
      closed: false,
    };
  });
}

/** Midas'ın açık sembollerini site fiyat geçmişi ve yerel işlem adetleriyle birleştir. */
export function addSiteMarketMetrics(positions) {
  return (positions || []).map((position) => {
    // Midas canlı pozisyonlarında adet yalnızca Midas tablosundan gelmeli.
    // Eski işlem kayıtları açık adetle uyuşmayabilir ve günlük katkıyı büyütür.
    const units = Number.isFinite(position.units) && position.units > 0 ? position.units : null;
    if (!(units > 0)) return {
      ...position, units: null,
      dailyPLTRY: NO_DAILY_CHANGE_CODES.has(position.code) ? 0 : null,
      dailyPct: NO_DAILY_CHANGE_CODES.has(position.code) ? 0 : null,
      totalPLTRY: NO_DAILY_CHANGE_CODES.has(position.code) ? 0 : null,
      totalPct: NO_DAILY_CHANGE_CODES.has(position.code) ? 0 : null,
      marketValueTRY: null, marketValuePrevTRY: null, siteDataAvailable: false,
    };
    const latestIndex = Math.max(0, lastIndex());
    const hist = cachedHistory(position.code);
    let quoteIndex = -1;
    let priceFromHistory = null;
    for (let index = latestIndex; index >= 0; index -= 1) {
      const candidate = exactPriceAtIndex(hist, index);
      if (Number.isFinite(candidate) && candidate > 0) {
        quoteIndex = index;
        priceFromHistory = candidate;
        break;
      }
    }
    let previousIndex = -1;
    let previousPrice = null;
    for (let index = quoteIndex - 1; index >= 0; index -= 1) {
      const candidate = exactPriceAtIndex(hist, index);
      if (Number.isFinite(candidate) && candidate > 0) {
        previousIndex = index;
        previousPrice = candidate;
        break;
      }
    }
    const quoteDate = quoteIndex >= 0 ? DB.calendar[quoteIndex] : DB.byCode.get(position.code)?.date || null;
    const price = Number.isFinite(priceFromHistory) ? priceFromHistory
      : (Number.isFinite(DB.byCode.get(position.code)?.price) ? DB.byCode.get(position.code).price
        : (Number.isFinite(position.price) && position.price > 0 ? position.price : null));
    const avgCost = Number.isFinite(position.avgCost) && position.avgCost > 0
      ? position.avgCost : null;
    const fx = fxToTRY(position.code, quoteIndex >= 0 ? quoteIndex : latestIndex);
    const previousFx = fxToTRY(position.code, previousIndex);
    const hasSitePrice = Number.isFinite(price) && Number.isFinite(fx);
    // ABD fon/hisselerinin kapanışı Türkiye takviminde çoğunlukla bir gün geridedir.
    // Her varlığı kendi son iki gerçek kapanışından hesapla; global TEFAS tarihiyle
    // birebir eşitlik aramak geçerli fiyatları yanlışlıkla eksik sayıyordu.
    const recentQuote = quoteIndex >= 0 && latestIndex - quoteIndex <= 1;
    const noDailyChange = NO_DAILY_CHANGE_CODES.has(position.code);
    const hasPreviousPrice = !noDailyChange && hasSitePrice && recentQuote && previousIndex >= 0
      && Number.isFinite(previousPrice) && Number.isFinite(previousFx);
    const dailyPLTRY = noDailyChange ? 0 : hasPreviousPrice
      ? units * (price * fx - previousPrice * previousFx) : null;
    const dailyPct = noDailyChange ? 0 : hasPreviousPrice && previousPrice * previousFx > 0
      ? ((price * fx) / (previousPrice * previousFx) - 1) * 100 : null;
    const totalPLTRY = hasSitePrice && Number.isFinite(avgCost)
      ? units * (price - avgCost) * fx : null;
    const totalPct = hasSitePrice && Number.isFinite(avgCost) && avgCost > 0
      ? ((price / avgCost) - 1) * 100 : null;
    return {
      ...position,
      price,
      units,
      avgCost,
      dailyPLTRY,
      dailyPct,
      totalPLTRY,
      totalPct,
      marketValueTRY: hasSitePrice ? units * price * fx : null,
      marketValuePrevTRY: noDailyChange && hasSitePrice
        ? units * price * fx
        : hasPreviousPrice ? units * previousPrice * previousFx : null,
      siteDataAvailable: hasSitePrice,
      quoteDate,
      noDailyChange,
    };
  });
}

