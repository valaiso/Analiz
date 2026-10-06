import { DB } from './data.js';
import { getMidasAccountSnapshot } from './store.js';

const GROUP_ORDER = ['ETF', 'Fon', 'Hisse', 'Kripto', 'Diğer'];

export function assetType(code, suppliedKind = '') {
  const kind = String(suppliedKind || DB.byCode.get(code)?.kind || '').toUpperCase();
  const category = String(DB.byCode.get(code)?.cat || DB.byCode.get(code)?.category || '').toLocaleLowerCase('tr');
  if (kind === 'US_ETF' || kind === 'BYF' || /\betf\b|borsa yatırım fonu/.test(category)) return 'ETF';
  if (kind === 'CRYPTO') return 'Kripto';
  if (['YAT', 'EMK', 'GYF', 'GSYF'].includes(kind) || /fon|emeklilik/.test(category)) return 'Fon';
  if (kind === 'HISSE' || /hisse|equity|stock/.test(category)) return 'Hisse';
  return 'Diğer';
}

export function groupAssetRows(rows) {
  const groups = new Map(GROUP_ORDER.map((label) => [label, []]));
  for (const row of rows || []) groups.get(assetType(row.code, row.kind))?.push(row);
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
export function addSiteMarketMetrics(positions, localHoldings = []) {
  const holdings = new Map((localHoldings || []).map((row) => [row.code, row]));
  return (positions || []).map((position) => {
    const holding = holdings.get(position.code);
    if (!holding || !(holding.units > 0)) return {
      ...position,
      dailyPLTRY: null,
      dailyPct: null,
      totalPLTRY: null,
      totalPct: null,
      marketValueTRY: null,
      marketValuePrevTRY: null,
      siteDataAvailable: false,
    };
    const price = Number.isFinite(holding.price) ? holding.price : null;
    const avgCost = Number.isFinite(position.avgCost) && position.avgCost > 0
      ? position.avgCost : holding.avgCost;
    const fx = Number.isFinite(holding.fxRate) ? holding.fxRate : 1;
    const hasSitePrice = Number.isFinite(price) && !holding.missingFx;
    const dailyPLTRY = hasSitePrice && Number.isFinite(holding.dayPct) && Number.isFinite(holding.dayPL)
      ? holding.dayPL : null;
    const totalPLTRY = hasSitePrice && Number.isFinite(avgCost)
      ? holding.units * (price - avgCost) * fx : null;
    const totalPct = hasSitePrice && Number.isFinite(avgCost) && avgCost > 0
      ? ((price / avgCost) - 1) * 100 : null;
    return {
      ...position,
      price,
      units: holding.units,
      avgCost,
      dailyPLTRY,
      dailyPct: holding.dayPct,
      totalPLTRY,
      totalPct,
      marketValueTRY: hasSitePrice && Number.isFinite(holding.value) ? holding.value : null,
      marketValuePrevTRY: dailyPLTRY !== null && Number.isFinite(holding.prevValue) ? holding.prevValue : null,
      siteDataAvailable: hasSitePrice,
    };
  });
}

