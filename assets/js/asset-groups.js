import {
  DB, cachedHistory, exactPriceAtIndex, lastIndex, indexForDate, usdTryAtIndex,
} from './data.js';
import { getMidasAccountSnapshot } from './store.js';

const GROUP_ORDER = ['ETF', 'Fon', 'Hisse', 'Kripto', 'Diğer'];
const NO_DAILY_CHANGE_CODES = new Set(['THF', 'TP2']);

function marketDateInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateInTimezone(value, timeZone) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function currencyFxToTRY(code, currency, index) {
  if (currency !== 'USD') return 1;
  let cursor = Number.isFinite(index) ? Math.min(index, lastIndex()) : lastIndex();
  while (cursor >= 0) {
    const rate = usdTryAtIndex(cursor);
    if (Number.isFinite(rate) && rate > 0) return rate;
    cursor -= 1;
  }
  return null;
}

function transactionFxToTRY(code, tx, fallbackCurrency, index, referenceUnitTRY, kindHint = '') {
  let currency = tx.currency === 'USD' ? 'USD' : tx.currency === 'TRY' ? 'TRY'
    : fallbackCurrency || DB.byCode.get(code)?.currency || 'TRY';
  const kind = String(kindHint || DB.byCode.get(code)?.kind || '').toUpperCase();
  if (!tx.currency && kind === 'CRYPTO' && currency === 'TRY'
    && Number.isFinite(referenceUnitTRY) && referenceUnitTRY > 0) {
    const usdFx = currencyFxToTRY(code, 'USD', index);
    const nativePrice = Number(tx.price);
    if (Number.isFinite(usdFx) && usdFx > 0 && nativePrice > 0
      && Math.abs(nativePrice * usdFx - referenceUnitTRY) < Math.abs(nativePrice - referenceUnitTRY)) {
      currency = 'USD';
    }
  }
  return currencyFxToTRY(code, currency, index);
}

function previousMarketUnitTRY(code, date, currencyHint = '') {
  const hist = cachedHistory(code);
  if (!hist || !DB.calendar.length) return null;
  let index = indexForDate(date);
  if (index >= 0 && DB.calendar[index] === date) index -= 1;
  while (index >= 0) {
    const price = exactPriceAtIndex(hist, index);
    if (Number.isFinite(price) && price > 0) {
      const currency = currencyHint || DB.byCode.get(code)?.currency || 'TRY';
      const fx = currencyFxToTRY(code, currency, index);
      return Number.isFinite(fx) ? price * fx : null;
    }
    index -= 1;
  }
  return null;
}

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
  if (snapshot?.positionsSource !== 'midas-visible-v1'
    || snapshot.positionsCaptured !== true || !Array.isArray(snapshot.positions)) return null;
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
      // Midas'ın anlık pozisyon fiyatı ve getiri alanları eşitleme anında gelir.
      midasStockSnapshot: true,
      midasSnapshotCapturedAt: snapshot.stockCapturedAt || snapshot.capturedAt || null,
      closed: false,
    };
  });
}

/** Current crypto holdings come from Midas's separate Crypto Positions table. */
export function currentMidasCryptoPositions() {
  const snapshot = getMidasAccountSnapshot();
  if (snapshot?.cryptoPositionsSource !== 'midas-visible-v1'
    || snapshot.cryptoPositionsCaptured !== true || !Array.isArray(snapshot.cryptoPositions)) return null;
  const latestIndex = Math.max(0, lastIndex());
  return snapshot.cryptoPositions.map((row) => {
    const meta = DB.byCode.get(row.code) || {};
    const currency = row.currency || 'TRY';
    const units = Number.isFinite(row.units) && row.units > 0 ? row.units : null;
    const history = cachedHistory(row.code);
    const historyCurrency = DB.byCode.get(row.code)?.currency || currency;
    const snapshotCurrency = currency === 'USD' ? 'USD' : 'TRY';
    const currentDate = marketDateInTimezone('Europe/Istanbul');
    const snapshotCapturedAt = snapshot.cryptoCapturedAt || snapshot.capturedAt || null;
    const snapshotPriceIsToday = dateInTimezone(snapshotCapturedAt, 'Europe/Istanbul') === currentDate;
    const liveQuote = snapshot.liveQuotes?.[row.code];
    const liveQuoteTimestamp = Number(liveQuote?.timestamp);
    const liveQuoteAgeMs = Number.isFinite(liveQuoteTimestamp) ? Date.now() - liveQuoteTimestamp : Infinity;
    const liveQuoteFresh = Number.isFinite(liveQuote?.price) && liveQuote.price > 0
      && liveQuoteAgeMs >= -60_000 && liveQuoteAgeMs <= 10 * 60_000;
    const liveQuoteCurrency = liveQuote?.currency === 'USD' ? 'USD' : 'TRY';
    const liveQuoteDate = String(liveQuote?.date || currentDate).slice(0, 10);
    const liveQuoteIndex = Math.max(0, indexForDate(liveQuoteDate));
    const liveQuotePreviousIndex = DB.calendar[liveQuoteIndex] === liveQuoteDate
      ? Math.max(0, liveQuoteIndex - 1) : liveQuoteIndex;
    const liveQuoteCurrentFx = liveQuoteFresh
      ? currencyFxToTRY(row.code, liveQuoteCurrency, latestIndex) : null;
    const liveQuotePreviousFx = liveQuoteFresh
      ? currencyFxToTRY(row.code, liveQuoteCurrency, liveQuotePreviousIndex) : null;
    const liveQuoteCurrentTRY = liveQuoteFresh && Number.isFinite(liveQuoteCurrentFx)
      ? liveQuote.price * liveQuoteCurrentFx : null;
    const liveQuotePreviousTRY = liveQuoteFresh && Number.isFinite(liveQuote?.previousClose)
      && liveQuote.previousClose > 0 && Number.isFinite(liveQuotePreviousFx)
      ? liveQuote.previousClose * liveQuotePreviousFx : null;
    let latestHistoryPrice = null;
    let latestHistoryIndex = -1;
    for (let index = latestIndex; index >= 0; index -= 1) {
      const candidate = exactPriceAtIndex(history, index);
      if (Number.isFinite(candidate) && candidate > 0) {
        latestHistoryPrice = candidate;
        latestHistoryIndex = index;
        break;
      }
    }
    const historyPriceIsToday = latestHistoryIndex >= 0 && DB.calendar[latestHistoryIndex] === currentDate;
    const historyCurrentFx = latestHistoryIndex >= 0
      ? currencyFxToTRY(row.code, historyCurrency, latestHistoryIndex) : null;
    const fallbackHistoryPrice = Number.isFinite(latestHistoryPrice)
      ? historyCurrency === snapshotCurrency ? latestHistoryPrice
        : snapshotCurrency === 'TRY' && Number.isFinite(historyCurrentFx)
          ? latestHistoryPrice * historyCurrentFx
          : snapshotCurrency === 'USD' && Number.isFinite(historyCurrentFx) && historyCurrentFx > 0
            ? latestHistoryPrice / historyCurrentFx : null
      : null;
    const currentFx = currencyFxToTRY(row.code, snapshotCurrency, latestIndex);
    const livePriceInSnapshotCurrency = Number.isFinite(liveQuoteCurrentTRY)
      && Number.isFinite(currentFx) && currentFx > 0 ? liveQuoteCurrentTRY / currentFx : null;
    const price = Number.isFinite(livePriceInSnapshotCurrency) ? livePriceInSnapshotCurrency
      : snapshotPriceIsToday && Number.isFinite(row.price) && row.price > 0 ? row.price
        : historyPriceIsToday && Number.isFinite(fallbackHistoryPrice) ? fallbackHistoryPrice
          : Number.isFinite(row.price) && row.price > 0 ? row.price
            : Number.isFinite(fallbackHistoryPrice) ? fallbackHistoryPrice : null;
    let referenceIndex = -1;
    let referencePrice = null;
    for (let index = latestIndex; index >= 0; index -= 1) {
      if (DB.calendar[index] >= currentDate) continue;
      const candidate = exactPriceAtIndex(history, index);
      if (Number.isFinite(candidate) && candidate > 0) {
        referenceIndex = index;
        referencePrice = candidate;
        break;
      }
    }
    const referenceFx = referenceIndex >= 0
      ? currencyFxToTRY(row.code, snapshotCurrency, referenceIndex) : null;
    const historyFx = referenceIndex >= 0
      ? currencyFxToTRY(row.code, historyCurrency, referenceIndex) : null;
    const referencePriceInSnapshotCurrency = Number.isFinite(referencePrice)
      && (historyCurrency === snapshotCurrency || Number.isFinite(historyFx) && historyFx > 0)
      ? historyCurrency === snapshotCurrency ? referencePrice
        : snapshotCurrency === 'TRY' ? referencePrice * historyFx : referencePrice / historyFx
      : null;
    const currentUnitTRY = Number.isFinite(liveQuoteCurrentTRY) ? liveQuoteCurrentTRY
      : (snapshotPriceIsToday || historyPriceIsToday) && price && Number.isFinite(currentFx)
        ? price * currentFx : null;
    const marketValueTRY = liveQuoteFresh && units && Number.isFinite(liveQuoteCurrentTRY)
      ? units * liveQuoteCurrentTRY
      : Number.isFinite(row.marketValue)
      ? snapshotCurrency === 'USD' ? Number.isFinite(currentFx) ? row.marketValue * currentFx : null
        : row.marketValue
      : units && price && Number.isFinite(currentFx) ? units * price * currentFx : null;
    const historyPreviousUnitTRY = Number.isFinite(referencePriceInSnapshotCurrency) && Number.isFinite(referenceFx)
      ? referencePriceInSnapshotCurrency * referenceFx : null;
    const previousUnitTRY = Number.isFinite(liveQuotePreviousTRY)
      ? liveQuotePreviousTRY : historyPreviousUnitTRY;
    const calculatedDailyPLTRY = units && Number.isFinite(currentUnitTRY) && Number.isFinite(previousUnitTRY)
      ? units * (currentUnitTRY - previousUnitTRY) : null;
    const calculatedDailyPLNative = units && price && Number.isFinite(currentUnitTRY)
      && Number.isFinite(previousUnitTRY) && Number.isFinite(currentFx)
      ? units * (price - previousUnitTRY / currentFx)
      : units && price && Number.isFinite(currentUnitTRY) && Number.isFinite(referencePriceInSnapshotCurrency)
        ? units * (price - referencePriceInSnapshotCurrency) : null;
    const dailyPLNative = calculatedDailyPLNative;
    const dailyPLTRY = calculatedDailyPLTRY;
    const dailyPct = Number.isFinite(previousUnitTRY) && previousUnitTRY > 0 && Number.isFinite(currentUnitTRY)
      ? (currentUnitTRY / previousUnitTRY - 1) * 100 : null;
    const noDailyChange = NO_DAILY_CHANGE_CODES.has(row.code);
    return {
      ...row,
      name: meta.name || row.code,
      kind: 'CRYPTO',
      category: meta.cat || meta.category || 'Kripto',
      currency,
      units,
      price,
      marketValueTRY,
      dailyPLTRY: noDailyChange ? 0 : dailyPLTRY,
      dailyPLNative: noDailyChange ? 0 : dailyPLNative,
      dailyPct: noDailyChange ? 0 : dailyPct,
      dailyUnitPriceNowTRY: currentUnitTRY,
      dailyUnitPricePrevTRY: noDailyChange ? currentUnitTRY : previousUnitTRY,
      marketValuePrevTRY: noDailyChange ? marketValueTRY
        : Number.isFinite(previousUnitTRY) && units ? units * previousUnitTRY : null,
      allocationPct: null,
      value: Number.isFinite(marketValueTRY) ? marketValueTRY : 0,
      weight: null,
      midasCryptoSnapshot: true,
      midasSnapshotCapturedAt: snapshotCapturedAt,
      liveQuoteUsed: liveQuoteFresh && Number.isFinite(liveQuoteCurrentTRY),
      liveQuoteAgeMinutes: Number.isFinite(liveQuoteAgeMs) ? Math.max(0, Math.ceil(liveQuoteAgeMs / 60_000)) : null,
      quoteMissing: !Number.isFinite(liveQuoteCurrentTRY) && !snapshotPriceIsToday && !historyPriceIsToday,
      quoteMissingReason: 'bugünün kripto kotasyonu alınmadı; son fiyat korunuyor',
      closed: false,
      noDailyChange,
    };
  });
}

/** Midas'ın açık sembollerini site fiyat geçmişi ve yerel işlem adetleriyle birleştir. */
export function addSiteMarketMetrics(positions) {
  const liveQuotes = getMidasAccountSnapshot()?.liveQuotes || {};
  return (positions || []).map((position) => {
    // Midas canlı pozisyonlarında adet yalnızca Midas tablosundan gelmeli.
    // Eski işlem kayıtları açık adetle uyuşmayabilir ve günlük katkıyı büyütür.
    const units = Number.isFinite(position.units) && position.units > 0 ? position.units : null;
    if (position.midasCryptoSnapshot) {
      const price = Number.isFinite(position.price) && position.price > 0 ? position.price : null;
      const avgCost = Number.isFinite(position.avgCost) && position.avgCost > 0 ? position.avgCost : null;
      const totalPLNative = units && price && avgCost ? units * (price - avgCost)
        : Number.isFinite(position.totalPL) ? position.totalPL : null;
      const latestIndex = Math.max(0, lastIndex());
      const fx = currencyFxToTRY(position.code, position.currency, latestIndex);
      const noDailyChange = NO_DAILY_CHANGE_CODES.has(position.code);
      return {
        ...position,
        units,
        price,
        avgCost,
        dailyPLTRY: noDailyChange ? 0 : position.dailyPLTRY,
        dailyPLNative: noDailyChange ? 0 : position.dailyPLNative,
        dailyPct: noDailyChange ? 0 : position.dailyPct,
        dailyUnitPriceNowTRY: position.dailyUnitPriceNowTRY,
        dailyUnitPricePrevTRY: noDailyChange ? position.dailyUnitPriceNowTRY : position.dailyUnitPricePrevTRY,
        totalPLNative,
        totalPLTRY: Number.isFinite(totalPLNative) && Number.isFinite(fx) ? totalPLNative * fx : null,
        totalPct: avgCost && price ? ((price / avgCost) - 1) * 100 : null,
        marketValueTRY: Number.isFinite(position.marketValueTRY) ? position.marketValueTRY
          : units && price && Number.isFinite(fx) ? units * price * fx : null,
        marketValuePrevTRY: noDailyChange ? position.marketValueTRY : position.marketValuePrevTRY,
        siteDataAvailable: Boolean(units && price),
        quoteSource: position.liveQuoteUsed ? 'Yahoo Finance canlı fiyatı' : 'Midas Crypto Pozisyonlar',
        quoteMissing: position.quoteMissing === true,
        quoteMissingReason: position.quoteMissingReason || '',
        quoteStale: false,
        quoteAgeMinutes: position.liveQuoteAgeMinutes ?? null,
        noDailyChange,
      };
    }
    if (!(units > 0)) return {
      ...position, units: null,
      dailyPLTRY: NO_DAILY_CHANGE_CODES.has(position.code) ? 0 : null,
      dailyPLNative: NO_DAILY_CHANGE_CODES.has(position.code) ? 0 : null,
      dailyPct: NO_DAILY_CHANGE_CODES.has(position.code) ? 0 : null,
      totalPLTRY: null,
      totalPLNative: null,
      totalPct: null,
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
    const meta = DB.byCode.get(position.code) || {};
    const kind = String(meta.kind || position.kind || '').toUpperCase();
    const currency = position.currency || meta.currency || 'TRY';
    const canUseIntraday = ['US_ETF', 'BIST_ETF', 'BYF', 'HISSE', 'BIST_STOCK', 'BIST_HISSE', 'US_STOCK'].includes(kind);
    const liveQuote = canUseIntraday ? liveQuotes[position.code] : null;
    const hasLiveQuote = Number.isFinite(liveQuote?.price) && liveQuote.price > 0
      && Number.isFinite(liveQuote?.previousClose) && liveQuote.previousClose > 0;
    const quoteTimestamp = Number(liveQuote?.timestamp);
    const quoteAgeMinutes = Number.isFinite(quoteTimestamp)
      ? Math.max(0, Math.ceil((Date.now() - quoteTimestamp) / 60_000)) : null;
    const marketSessionOpenNow = liveQuote?.isRegularSessionNow === true;
    const useQuotePrice = hasLiveQuote && liveQuote.isRegularSessionBar !== false
      && marketSessionOpenNow && quoteAgeMinutes !== null && quoteAgeMinutes <= 30;
    // Use a fresh in-session quote when available; otherwise keep the price
    // read from Midas. Historical series must not replace the holding's price:
    // they can be stale or adjusted differently (notably THF/TP2).
    const exchangeTraded = canUseIntraday;
    const defaultTimezone = ['US_ETF', 'US_STOCK'].includes(kind) ? 'America/New_York' : 'Europe/Istanbul';
    const marketTimezone = liveQuote?.exchangeTimezoneName || defaultTimezone;
    const marketToday = exchangeTraded
      ? marketDateInTimezone(marketTimezone) : marketDateInTimezone('Europe/Istanbul');
    const snapshotPriceIsToday = position.midasStockSnapshot
      && dateInTimezone(position.midasSnapshotCapturedAt, marketTimezone) === marketToday;
    const historyPriceIsToday = quoteIndex >= 0 && quoteDate === marketToday;
    const price = useQuotePrice ? liveQuote.price
      : historyPriceIsToday && Number.isFinite(priceFromHistory) ? priceFromHistory
        : snapshotPriceIsToday && Number.isFinite(position.price) && position.price > 0 ? position.price
        : Number.isFinite(priceFromHistory) ? priceFromHistory
          : Number.isFinite(DB.byCode.get(position.code)?.price) ? DB.byCode.get(position.code).price
            : Number.isFinite(position.price) && position.price > 0 ? position.price : null;
    const avgCost = Number.isFinite(position.avgCost) && position.avgCost > 0
      ? position.avgCost : null;
    const fx = currencyFxToTRY(position.code, currency, latestIndex);
    const hasSitePrice = Number.isFinite(price) && Number.isFinite(fx);
    // ABD fon/hisselerinin kapanışı Türkiye takviminde çoğunlukla bir gün geridedir.
    // Her varlığı kendi son iki gerçek kapanışından hesapla; global TEFAS tarihiyle
    // birebir eşitlik aramak geçerli fiyatları yanlışlıkla eksik sayıyordu.
    const firstTrackedPoint = !hasLiveQuote && quoteIndex >= 0 && hist?.i === quoteIndex
      && Boolean(meta.startDate);
    const noDailyChange = NO_DAILY_CHANGE_CODES.has(position.code);
    // Kapanış saati varsaymak yerine, kotasyonun piyasa tarihini bugünkü piyasa
    // tarihiyle karşılaştır. Yeni tarihli kotasyon yoksa son fiyat değerlemede
    // kalır; önceki seansın günlük hareketi bugüne kopyalanmaz.
    const quoteIsFromCurrentMarketDate = hasLiveQuote && liveQuote.date === marketToday
      && liveQuote.isRegularSessionBar !== false;
    const useIntradayChange = quoteIsFromCurrentMarketDate
      && (quoteAgeMinutes !== null && quoteAgeMinutes <= 30 || snapshotPriceIsToday || historyPriceIsToday);
    const quoteStale = exchangeTraded && hasLiveQuote && marketSessionOpenNow
      && (quoteAgeMinutes === null || quoteAgeMinutes > 30);
    const quoteMissing = exchangeTraded && (!hasLiveQuote
      || marketSessionOpenNow && !quoteIsFromCurrentMarketDate);
    const quoteMissingReason = !hasLiveQuote
      ? 'piyasa kotasyonu alınmadı; son fiyat korunuyor'
      : 'seans açık ama bugünün kotasyonu henüz gelmedi';
    const dailyReferencePrice = useIntradayChange ? liveQuote.previousClose
      : snapshotPriceIsToday && !historyPriceIsToday && Number.isFinite(priceFromHistory) ? priceFromHistory
        : previousPrice;
    const dailyReferenceIndex = useIntradayChange
      ? Math.max(0, quoteIndex - 1)
      : snapshotPriceIsToday && !historyPriceIsToday ? quoteIndex : previousIndex;
    const previousFx = currencyFxToTRY(position.code, currency, dailyReferenceIndex);
    const hasPreviousPrice = !noDailyChange && hasSitePrice
      && (useIntradayChange || historyPriceIsToday && previousIndex >= 0
        || snapshotPriceIsToday && quoteIndex >= 0)
      && Number.isFinite(dailyReferencePrice) && dailyReferencePrice > 0
      && Number.isFinite(previousFx);
    const dailyQuoteUnavailable = !hasSitePrice || !hasPreviousPrice;
    const calculatedDailyPLNative = noDailyChange ? 0
      : dailyQuoteUnavailable ? null
        : hasPreviousPrice ? units * (price - dailyReferencePrice) : firstTrackedPoint ? 0 : null;
    const calculatedDailyPLTRY = noDailyChange ? 0
      : dailyQuoteUnavailable ? null
        : hasPreviousPrice ? units * (price * fx - dailyReferencePrice * previousFx) : firstTrackedPoint ? 0 : null;
    const calculatedDailyPct = noDailyChange ? 0
      : dailyQuoteUnavailable ? null
        : hasPreviousPrice ? (price / dailyReferencePrice - 1) * 100 : firstTrackedPoint ? 0 : null;
    const dailyPLNative = calculatedDailyPLNative;
    const dailyPLTRY = calculatedDailyPLTRY;
    const dailyPct = calculatedDailyPct;
    const totalPLNative = Number.isFinite(position.totalPL) ? position.totalPL
      : hasSitePrice && Number.isFinite(avgCost) ? units * (price - avgCost)
        : null;
    const totalPLTRY = Number.isFinite(totalPLNative) ? totalPLNative * fx : null;
    const totalPct = Number.isFinite(position.totalPct) ? position.totalPct
        : hasSitePrice && Number.isFinite(avgCost) && avgCost > 0 ? ((price / avgCost) - 1) * 100
        : null;
    const dailyUnitPriceNowTRY = hasSitePrice ? price * fx : null;
    const dailyUnitPricePrevTRY = noDailyChange ? dailyUnitPriceNowTRY
      : hasPreviousPrice ? dailyReferencePrice * previousFx
        : firstTrackedPoint ? price * fx : null;
    const marketValuePrevTRY = Number.isFinite(dailyUnitPricePrevTRY)
      ? noDailyChange ? units * dailyUnitPriceNowTRY : units * dailyUnitPricePrevTRY : null;
    return {
      ...position,
      price,
      units,
      avgCost,
      dailyPLTRY,
      dailyPLNative,
      dailyPct,
      dailyUnitPriceNowTRY,
      dailyUnitPricePrevTRY,
      totalPLTRY,
      totalPLNative,
      totalPct,
      marketValueTRY: hasSitePrice ? units * price * fx : null,
      marketValuePrevTRY,
      siteDataAvailable: hasSitePrice,
      quoteDate: hasLiveQuote ? liveQuote.date : quoteDate,
      quoteSource: hasLiveQuote ? liveQuote.source : 'site',
      quoteMissing,
      quoteMissingReason,
      quoteStale,
      quoteAgeMinutes,
      noDailyChange,
    };
  });
}

/** Compute the daily mark-to-market using market prices and same-day fills. */
export function applyDailyMarketTransactions(positions, transactions, date, { positionsComplete = false } = {}) {
  const byCode = new Map((transactions || []).filter((tx) => tx.source === 'midas'
    && String(tx.date || '').slice(0, 10) === date && tx.code)
    .reduce((groups, tx) => {
      const code = String(tx.code).trim().toLocaleUpperCase('tr');
      if (!groups.has(code)) groups.set(code, []);
      groups.get(code).push(tx);
      return groups;
    }, new Map()));
  const missingCodes = [];
  const adjustedRows = (positions || []).map((row) => {
    const fills = byCode.get(row.code) || [];
    byCode.delete(row.code);
    if (row.noDailyChange || !fills.length) return row;
    const previousUnitTRY = row.dailyUnitPricePrevTRY;
    const currentUnitTRY = row.dailyUnitPriceNowTRY;
    const currentUnits = Number(row.units) || 0;
    const bought = fills.filter((tx) => tx.type === 'AL').reduce((sum, tx) => sum + Number(tx.units || 0), 0);
    const sold = fills.filter((tx) => tx.type === 'SAT').reduce((sum, tx) => sum + Number(tx.units || 0), 0);
    const openingUnits = currentUnits - bought + sold;
    if (!Number.isFinite(previousUnitTRY) || openingUnits < -1e-6
      || currentUnits > 1e-8 && !Number.isFinite(currentUnitTRY)) {
      missingCodes.push(`${row.code} (günlük fiyat veya işlem adedi tutarsız)`);
      return { ...row, dailyPLTRY: null, dailyPLNative: null, dailyPct: null, marketValuePrevTRY: null };
    }
    let adjustmentTRY = 0;
    let validFills = true;
    for (const tx of fills) {
      const units = Number(tx.units);
      const price = Number(tx.price);
      if (!(units > 0) || !(price > 0)) { validFills = false; break; }
      const tradeIndex = Math.max(0, indexForDate(String(tx.date).slice(0, 10)));
      const tradeFx = transactionFxToTRY(row.code, tx,
        row.currency || DB.byCode.get(row.code)?.currency || 'TRY', tradeIndex,
        previousUnitTRY, row.kind);
      if (!Number.isFinite(tradeFx)) { validFills = false; break; }
      const tradeValueTRY = price * tradeFx;
      adjustmentTRY += tx.type === 'SAT'
        ? units * (tradeValueTRY - previousUnitTRY)
        : units * (previousUnitTRY - tradeValueTRY);
      adjustmentTRY -= (Number(tx.fee) || 0) * tradeFx;
    }
    if (!validFills) {
      missingCodes.push(`${row.code} (işlem fiyatı dönüştürülemedi)`);
      return { ...row, dailyPLTRY: null, dailyPLNative: null, dailyPct: null, marketValuePrevTRY: null };
    }
    const dailyPLTRY = (currentUnits > 0 ? currentUnits * (currentUnitTRY - previousUnitTRY) : 0)
      + adjustmentTRY;
    const openingValueTRY = Math.max(0, openingUnits) * previousUnitTRY;
    const currentFx = Number.isFinite(currentUnitTRY) && Number(row.price) > 0
      ? currentUnitTRY / Number(row.price) : 1;
    return {
      ...row,
      dailyPLTRY,
      dailyPLNative: currentFx > 0 ? dailyPLTRY / currentFx : dailyPLTRY,
      dailyPct: openingValueTRY > 0 ? dailyPLTRY / openingValueTRY * 100 : null,
      marketValuePrevTRY: openingValueTRY,
      dailyOpeningUnits: Math.max(0, openingUnits),
      dailyTransactionsApplied: true,
    };
  });

  const closedRows = [];
  if (positionsComplete) {
    for (const [code, fills] of byCode) {
      const meta = DB.byCode.get(code) || {};
      if (NO_DAILY_CHANGE_CODES.has(code)) continue;
      const currency = meta.currency || fills.find((tx) => tx.currency)?.currency || 'TRY';
      const previousUnitTRY = previousMarketUnitTRY(code, date, currency);
      const bought = fills.filter((tx) => tx.type === 'AL').reduce((sum, tx) => sum + Number(tx.units || 0), 0);
      const sold = fills.filter((tx) => tx.type === 'SAT').reduce((sum, tx) => sum + Number(tx.units || 0), 0);
      const openingUnits = sold - bought;
      if (!Number.isFinite(previousUnitTRY) || openingUnits < -1e-6) {
        missingCodes.push(`${code} (günlük referans fiyatı yok)`);
        continue;
      }
      let adjustmentTRY = 0;
      let validFills = true;
      for (const tx of fills) {
        const units = Number(tx.units);
        const price = Number(tx.price);
        if (!(units > 0) || !(price > 0)) { validFills = false; break; }
        const tradeIndex = Math.max(0, indexForDate(String(tx.date).slice(0, 10)));
        const tradeFx = transactionFxToTRY(code, tx, currency, tradeIndex, previousUnitTRY, meta.kind);
        if (!Number.isFinite(tradeFx)) { validFills = false; break; }
        const tradeValueTRY = price * tradeFx;
        adjustmentTRY += tx.type === 'SAT'
          ? units * (tradeValueTRY - previousUnitTRY)
          : units * (previousUnitTRY - tradeValueTRY);
        adjustmentTRY -= (Number(tx.fee) || 0) * tradeFx;
      }
      if (!validFills) {
        missingCodes.push(`${code} (işlem fiyatı dönüştürülemedi)`);
        continue;
      }
      closedRows.push({
        code, dailyPLTRY: adjustmentTRY, marketValuePrevTRY: Math.max(0, openingUnits) * previousUnitTRY,
        dailyTransactionsApplied: true, closedToday: true,
      });
    }
  } else {
    missingCodes.push(...byCode.keys().map((code) => `${code} (pozisyon görüntüsü eksik)`));
  }

  const allRows = [...adjustedRows, ...closedRows];
  const valuedRows = allRows.filter((row) => Number.isFinite(row.dailyPLTRY));
  return {
    rows: adjustedRows,
    closedRows,
    total: valuedRows.length ? valuedRows.reduce((sum, row) => sum + row.dailyPLTRY, 0) : null,
    base: valuedRows.reduce((sum, row) => sum + (Number.isFinite(row.marketValuePrevTRY) ? row.marketValuePrevTRY : 0), 0),
    valuedCount: valuedRows.length,
    missingCodes,
  };
}
