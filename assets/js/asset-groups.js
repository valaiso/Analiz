import { DB, lastIndex } from './data.js';
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
    const rate = DB.benchmarks?.USDTRY?.values?.[Math.max(0, lastIndex())];
    const fx = currency === 'USD' && Number.isFinite(rate) && rate > 0 ? rate : 1;
    return {
      ...row,
      name: meta.name || row.code,
      kind: meta.kind || '',
      category: meta.cat || meta.category || '',
      currency,
      allocationPct: Number.isFinite(row.allocationPct) ? row.allocationPct : null,
      value: Number.isFinite(row.allocationPct) ? row.allocationPct : 0,
      weight: Number.isFinite(row.allocationPct) ? row.allocationPct : 0,
      totalPLTRY: Number.isFinite(row.totalPL) ? row.totalPL * fx : null,
      dailyPLTRY: Number.isFinite(row.dailyPL) ? row.dailyPL * fx : null,
      closed: false,
    };
  });
}

