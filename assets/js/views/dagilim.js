/* Dağılım: Midas canlı pozisyonları veya işlem geçmişinden türetilen dağılım. */

import { h, tl, tlSigned, pct, pctSigned, colorAt, isNum, units as fmtUnits } from '../util.js';
import { DB } from '../data.js';
import { donutWithLegend, barChart, stackedAreaChart } from '../charts.js';
import { weightHistory, attribution } from '../insights.js';
import { transactions, getMidasAccountSnapshot } from '../store.js';
import { currentMidasPositions, addSiteMarketMetrics, groupAssetRows, assetType } from '../asset-groups.js';
import { sectionCard, emptyState } from './common.js';

const cls2 = (v) => (!isNum(v) || v === 0 ? '' : v > 0 ? 'up' : 'down');

function signedCurrency(value, currency = 'TRY') {
  if (!isNum(value)) return '—';
  const rendered = new Intl.NumberFormat('tr-TR', {
    style: 'currency', currency: currency === 'USD' ? 'USD' : 'TRY', maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${rendered}`;
}

export function renderDagilim(ctx) {
  const { analysis, navigate } = ctx;
  const { open, totals } = analysis;
  const liveRaw = currentMidasPositions();
  const usingMidas = Boolean(liveRaw?.length);
  const liveCodes = new Set((liveRaw || []).map((row) => row.code));
  const live = addSiteMarketMetrics(liveRaw || []);
  const midasTotal = getMidasAccountSnapshot()?.summary?.totalValue;
  const liveValueTotal = live.reduce((sum, row) => sum + (isNum(row.marketValueTRY) ? row.marketValueTRY : 0), 0);
  const liveValuesReconcile = !usingMidas || live.every((row) => isNum(row.marketValueTRY))
    && (!Number.isFinite(midasTotal) || liveValueTotal <= midasTotal * 1.1);
  const localCrypto = usingMidas ? open.filter((row) => assetType(row.code) === 'Kripto' && !liveCodes.has(row.code)).map((row) => ({
    ...row, kind: 'CRYPTO', currency: 'TRY', allocationPct: null,
    dailyPLTRY: row.dayPL, totalPLTRY: row.totalPL, localRecord: true,
  })) : [];
  const positions = usingMidas ? [...live, ...localCrypto] : open;

  if (!positions.length) {
    return emptyState('Dağılım için açık pozisyon gerekiyor',
      'Midas’tan işlemleri okuyunca açık ETF, fon ve hisseler burada gruplu görünür.',
      'İşlemlere git', () => navigate('islemler'));
  }

  const root = h('div', { class: 'stack' });
  if (usingMidas) {
    const priced = [
      ...live.filter((row) => row.marketValueTRY > 0)
        .map((row) => ({ ...row, pieValue: row.marketValueTRY })),
      ...localCrypto.filter((row) => row.value > 0)
        .map((row) => ({ ...row, pieValue: row.value })),
    ];
    const byTypeMap = new Map();
    for (const row of priced) {
      if (!(row.pieValue > 0)) continue;
      const baseType = assetType(row.code, row.kind, row.category);
      const type = baseType === 'Hisse' && row.currency !== 'USD' ? 'BIST Hisse' : baseType;
      byTypeMap.set(type, (byTypeMap.get(type) || 0) + row.pieValue);
    }
    const securitiesValue = priced.filter((row) => !row.localRecord)
      .reduce((sum, row) => sum + row.pieValue, 0);
    const missingPositionValue = live.filter((row) => !(row.units > 0) || !isNum(row.marketValueTRY));
    const valuesReconcile = liveValuesReconcile && !missingPositionValue.length
      && (!Number.isFinite(midasTotal) || securitiesValue <= midasTotal * 1.1);
    const cashValue = valuesReconcile && Number.isFinite(midasTotal) ? Math.max(0, midasTotal - securitiesValue) : 0;
    if (cashValue > 0.01) {
      byTypeMap.set('Nakit', (byTypeMap.get('Nakit') || 0) + cashValue);
      priced.push({ code: 'Nakit', pieValue: cashValue, kind: 'CASH' });
    }
    const byType = [...byTypeMap.entries()].sort((a, b) => b[1] - a[1])
      .map(([label, value], index) => ({ label, value, color: colorAt(index) }));
    const bistRows = priced.filter((row) => assetType(row.code, row.kind, row.category) === 'Hisse'
      && row.currency !== 'USD' && row.kind !== 'US_ETF' && row.kind !== 'CRYPTO');
    const bistSlices = bistRows.filter((row) => row.pieValue > 0)
      .sort((a, b) => b.pieValue - a.pieValue)
      .map((row, index) => ({ label: row.code, value: row.pieValue, color: colorAt(index) }));
    if (valuesReconcile) root.append(h('div', { class: 'grid grid-2' },
      sectionCard('Portföy Dağılımı', 'ETF · Fon · BIST hissesi · yabancı hisse · Nakit', donutWithLegend(byType, {
        centerTop: tl(Number.isFinite(midasTotal)
          ? midasTotal + localCrypto.reduce((sum, row) => sum + (row.value || 0), 0)
          : priced.reduce((sum, row) => sum + (row.pieValue || 0), 0), { compact: true }),
        centerBottom: 'Midas toplamı',
      })),
      sectionCard('BIST Hisseleri', 'BIST hisselerinin kendi içindeki dağılımı', donutWithLegend(bistSlices, {
        centerTop: tl(bistRows.reduce((sum, row) => sum + (row.pieValue || 0), 0), { compact: true }),
        centerBottom: 'BIST toplamı',
      }))));
    else root.append(h('div', { class: 'notice warn' },
      missingPositionValue.length
        ? `Dağılım grafiği bekletiliyor: Midas adedi/fiyatı okunamayan varlıklar: ${missingPositionValue.map((row) => row.code).join(', ')}. Eklentiyi yenileyip Midas aktarımını tekrar çalıştır.`
        : `Dağılım grafiği bekletiliyor: pozisyon fiyatlarından hesaplanan ${tl(securitiesValue)} değeri Midas hesap toplamı ${tl(midasTotal)} ile uyuşmuyor. Eklentiyi yenileyip Midas aktarımını tekrar çalıştır.`));
    root.append(h('div', { class: 'notice' },
      `Portföy değeri kayıtlı adet × sitenin son fiyatı × güncel kur ile hesaplanır; ${live.filter((row) => row.marketValueTRY > 0).length}/${live.length} açık varlığın değeri doğrulandı. Günlük değişim de sitenin her varlık için son iki fiyat noktasından hesaplanır; THF ve TP2 %0 kabul edilir.`));
    const sortedGroups = groupAssetRows(positions).map((group) => ({
      ...group,
      groupValue: group.rows.reduce((sum, row) => sum + (row.marketValueTRY || 0), 0),
    })).sort((a, b) => b.groupValue - a.groupValue);
    for (const group of sortedGroups) {
      const localOnly = group.label === 'Kripto';
      const rows = [...group.rows].sort((a, b) => (b.allocationPct ?? -1) - (a.allocationPct ?? -1));
      const table = h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { style: 'text-align:left' }, 'Varlık'),
          h('th', {}, 'Adet'), h('th', {}, 'Portföy Değeri'), h('th', {}, 'Ort. Maliyet'), h('th', {}, 'Dağılım'),
          h('th', {}, 'Toplam K/Z'), h('th', {}, 'Günlük'))),
        h('tbody', {}, rows.map((row) => h('tr', {},
          h('td', {}, h('span', { class: 'code-chip' }, row.code)),
          h('td', {}, fmtUnits(row.units)),
          h('td', {}, liveValuesReconcile && isNum(row.marketValueTRY) ? tl(row.marketValueTRY) : '—'),
          h('td', {}, `${row.avgCost == null ? '—' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: row.currency === 'USD' ? 'USD' : 'TRY', maximumFractionDigits: 2 }).format(row.avgCost)}`),
          h('td', {}, row.localRecord || !isNum(row.allocationPct) ? '—' : pct(row.allocationPct, 2)),
          h('td', { class: cls2(row.totalPLTRY) }, liveValuesReconcile && isNum(row.totalPLNative) ? `${signedCurrency(row.totalPLNative, row.currency)}${isNum(row.totalPct) ? ` · ${pctSigned(row.totalPct)}` : ''}` : '—'),
          h('td', { class: cls2(row.dailyPLNative) }, liveValuesReconcile && isNum(row.dailyPLNative) ? `${signedCurrency(row.dailyPLNative, row.currency)}${isNum(row.dailyPct) ? ` · ${pctSigned(row.dailyPct)}` : ''}` : '—'))))));
      root.append(sectionCard(localOnly ? 'Kripto' : group.label,
        localOnly ? 'Bitcoin elle manuel eklenmelidir.'
          : 'Portföy değeri = Midas adedi × güncel fiyat × güncel kur', table));
    }
  } else {
    const byFund = open.filter((row) => row.value > 0)
      .map((row, i) => ({ label: row.code, value: row.value, color: colorAt(i) }));
    const catMap = new Map();
    for (const row of open) if (row.value > 0) catMap.set(row.cat, (catMap.get(row.cat) || 0) + row.value);
    const byCat = [...catMap.entries()].sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: colorAt(i) }));
    root.append(h('div', { class: 'grid grid-2' },
      sectionCard('Dağılım', `${open.length} açık varlık`, donutWithLegend(byFund, {
        centerTop: tl(totals.value, { compact: true }), centerBottom: 'toplam',
      })),
      sectionCard('Kategori Dağılımı', 'İşlem geçmişinden hesaplanır', donutWithLegend(byCat, {
        centerTop: String(byCat.length), centerBottom: 'kategori',
      }))));
  }

  /* Toplam K/Z katkısı yalnız fon ve BIST hisseleri için gösterilir. */
  if (usingMidas) {
    for (const group of groupAssetRows(live)) {
      if (!['Fon', 'Hisse'].includes(group.label)) continue;
      const currencies = [...new Set(group.rows.map((row) => row.currency === 'USD' ? 'USD' : 'TRY'))];
      for (const currency of currencies) {
        const rows = group.rows.filter((row) => liveValuesReconcile && (row.currency === 'USD' ? 'USD' : 'TRY') === currency
          && isNum(row.totalPLNative));
        if (!rows.length) continue;
        const box = h('div');
        const table = h('div', { class: 'table-wrap', style: 'margin-top:12px' }, h('table', {},
          h('thead', {}, h('tr', {},
            h('th', { style: 'text-align:left' }, 'Varlık'),
            h('th', {}, `Toplam K/Z (${currency})`), h('th', {}, 'Getiri'))),
          h('tbody', {}, rows.map((row) => h('tr', {},
            h('td', {}, h('span', { class: 'code-chip' }, row.code)),
            h('td', { class: cls2(row.totalPLNative) }, signedCurrency(row.totalPLNative, currency)),
            h('td', { class: cls2(row.totalPct) }, isNum(row.totalPct) ? pctSigned(row.totalPct, 2) : '—'))))));
        root.append(sectionCard(`${group.label} · Kâr/Zarar Katkısı (${currency})`,
          'Açık pozisyonlarda Midas’ın güncel fiyatı, ortalama maliyeti ve adediyle hesaplanır', box, table));
        barChart(box, { items: rows.map((row) => ({ label: row.code, value: row.totalPLNative })),
          format: (value) => signedCurrency(value, currency) });
      }

    }
    if (localCrypto.length) {
      const rows = localCrypto.filter((row) => isNum(row.totalPLTRY));
      if (rows.length) {
        const box = h('div');
        root.append(sectionCard('Kripto · Kâr/Zarar Katkısı', 'Yerel işlem ve fiyat kayıtlarından; Midas yatırım toplamına dahil değil', box));
        barChart(box, { items: rows.map((row) => ({ label: row.code, value: row.totalPLTRY })), format: tlSigned });
      }
    }
  } else {
    const katkilar = attribution(analysis.holdings, totals.netInvested);
    if (katkilar.length) {
      const box = h('div');
      const toplamPuan = katkilar.reduce((sum, item) => sum + item.points, 0);
      root.append(sectionCard('Kâr/Zarar Katkısı',
        `Toplam getirinin ${pctSigned(toplamPuan, 1)} puanı bu dağılımdan geliyor`,
        h('p', { class: 'dim', style: 'margin:0 0 12px;font-size:.85rem' },
          'İşlem geçmişinden hesaplanır.'), box,
        h('div', { class: 'table-wrap', style: 'margin-top:12px' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', { style: 'text-align:left' }, 'Varlık'),
            h('th', {}, 'Kâr/Zarar'), h('th', {}, 'Getiriye katkısı'))),
          h('tbody', {}, katkilar.map((item) => h('tr', {},
            h('td', {}, h('span', { class: 'code-chip' }, item.code)),
            h('td', { class: cls2(item.amount) }, tlSigned(item.amount)),
            h('td', { class: cls2(item.points) }, `${pctSigned(item.points, 2)} puan`))))))));
      barChart(box, { items: katkilar.map((item) => ({ label: item.code, value: item.points })), format: (v) => `${pctSigned(v, 2)} puan` });
    }
  }

  if (!usingMidas && analysis.series.dates.length > 20) {
    const drift = weightHistory(transactions(), analysis.series.start, analysis.series.dates);
    if (drift.codes.length > 1) {
      const box = h('div');
      root.append(sectionCard('Ağırlık Kayması', 'İşlem geçmişinden modellenmiştir', box));
      stackedAreaChart(box, { rows: drift.rows, codes: drift.codes });
    }
  }

  const top = positions.filter((row) => isNum(row.weight)).sort((a, b) => b.weight - a.weight)[0];
  if (!usingMidas && top && top.weight > 40) {
    root.append(h('div', { class: 'notice warn' },
      `Portföy ağırlığının ${pct(top.weight, 0)}’ı tek varlıkta (${top.code}).`));
  }
  return root;
}
