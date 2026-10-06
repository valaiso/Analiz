/* Dağılım: Midas canlı pozisyonları veya işlem geçmişinden türetilen dağılım. */

import { h, tl, tlSigned, pct, pctSigned, colorAt, isNum } from '../util.js';
import { donutWithLegend, barChart, stackedAreaChart } from '../charts.js';
import { weightHistory, attribution } from '../insights.js';
import { transactions } from '../store.js';
import { currentMidasPositions, groupAssetRows, assetType } from '../asset-groups.js';
import { sectionCard, emptyState } from './common.js';

const cls2 = (v) => (!isNum(v) || v === 0 ? '' : v > 0 ? 'up' : 'down');

export function renderDagilim(ctx) {
  const { analysis, navigate } = ctx;
  const { open, totals } = analysis;
  const live = currentMidasPositions();
  const usingMidas = Boolean(live?.length);
  const liveCodes = new Set((live || []).map((row) => row.code));
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
    root.append(h('div', { class: 'notice' },
      'Açık ETF, fon ve hisse listesi Midas’tan okunur. “Dağılım” yüzdesi Midas satırında gösterildiği gibi aktarılır; farklı varlık gruplarının yüzdeleri toplanmaz. Kripto satırları varsa işlem kayıtlarından ayrı gösterilir.'));
    for (const group of groupAssetRows(positions)) {
      const localOnly = group.label === 'Kripto';
      const table = h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { style: 'text-align:left' }, 'Varlık'),
          h('th', {}, 'Fiyat'), h('th', {}, 'Ort. Maliyet'), h('th', {}, 'Dağılım'),
          h('th', {}, 'Toplam K/Z'), h('th', {}, 'Bugünkü K/Z'))),
        h('tbody', {}, group.rows.map((row) => h('tr', {},
          h('td', {}, h('span', { class: 'code-chip' }, row.code)),
          h('td', {}, `${row.price == null ? '—' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: row.currency === 'USD' ? 'USD' : 'TRY', maximumFractionDigits: 2 }).format(row.price)}`),
          h('td', {}, `${row.avgCost == null ? '—' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: row.currency === 'USD' ? 'USD' : 'TRY', maximumFractionDigits: 2 }).format(row.avgCost)}`),
          h('td', {}, row.localRecord || !isNum(row.allocationPct) ? '—' : pct(row.allocationPct, 2)),
          h('td', { class: cls2(row.totalPLTRY) }, isNum(row.totalPLTRY) ? tlSigned(row.totalPLTRY) : '—'),
          h('td', { class: cls2(row.dailyPLTRY) }, isNum(row.dailyPLTRY) ? tlSigned(row.dailyPLTRY) : '—'))))));
      root.append(sectionCard(localOnly ? 'Kripto · İşlem Kayıtları' : `Midas · ${group.label}`,
        `${group.rows.length} varlık · ${localOnly ? 'Midas yatırım pozisyonlarından ayrı' : 'açık pozisyonlar'}`, table));
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

  /* Kâr/zarar katkısı: canlı görünümde Midas satırlarındaki güncel P/L kullanılır. */
  if (usingMidas) {
    for (const group of groupAssetRows(live)) {
      const rows = group.rows.filter((row) => isNum(row.totalPLTRY));
      if (!rows.length) continue;
      const box = h('div');
      const table = h('div', { class: 'table-wrap', style: 'margin-top:12px' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { style: 'text-align:left' }, 'Varlık'),
          h('th', {}, 'Kâr/Zarar (₺)'), h('th', {}, 'Getiri'))),
        h('tbody', {}, rows.map((row) => h('tr', {},
          h('td', {}, h('span', { class: 'code-chip' }, row.code)),
          h('td', { class: cls2(row.totalPLTRY) }, tlSigned(row.totalPLTRY)),
          h('td', { class: cls2(row.totalPct) }, isNum(row.totalPct) ? pctSigned(row.totalPct, 2) : '—'))))));
      root.append(sectionCard(`${group.label} · Kâr/Zarar Katkısı`,
        'Midas Pozisyonlar tablosundaki toplam getiri; TL’ye çevrilmiştir', box, table));
      barChart(box, { items: rows.map((row) => ({ label: row.code, value: row.totalPLTRY })), format: tlSigned });
    }

    for (const group of groupAssetRows(live)) {
      const rows = group.rows.filter((row) => isNum(row.dailyPLTRY) && Math.abs(row.dailyPLTRY) > 0.005);
      if (!rows.length) continue;
      const box = h('div');
      root.append(sectionCard(`${group.label} · Bugünkü Katkı`,
        'Açık pozisyonlardaki günlük değişim; nakit bakiyesi hariç', box));
      barChart(box, {
        items: rows.sort((a, b) => b.dailyPLTRY - a.dailyPLTRY)
          .map((row) => ({ label: row.code, value: row.dailyPLTRY })),
        format: tlSigned,
      });
    }
    if (localCrypto.length) {
      const rows = localCrypto.filter((row) => isNum(row.totalPLTRY));
      if (rows.length) {
        const box = h('div');
        root.append(sectionCard('Kripto · Kâr/Zarar Katkısı', 'Yerel işlem ve fiyat kayıtlarından; Midas yatırım toplamına dahil değil', box));
        barChart(box, { items: rows.map((row) => ({ label: row.code, value: row.totalPLTRY })), format: tlSigned });
      }
      const dailyCrypto = localCrypto.filter((row) => isNum(row.dailyPLTRY) && Math.abs(row.dailyPLTRY) > 0.005);
      if (dailyCrypto.length) {
        const box = h('div');
        root.append(sectionCard('Kripto · Bugünkü Katkı', 'Yerel işlem ve fiyat kayıtlarından hesaplanır', box));
        barChart(box, { items: dailyCrypto.map((row) => ({ label: row.code, value: row.dailyPLTRY })), format: tlSigned });
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
    const daily = open.filter((row) => isNum(row.dayPL) && Math.abs(row.dayPL) > 0.005)
      .sort((a, b) => b.dayPL - a.dayPL).map((row) => ({ label: row.code, value: row.dayPL }));
    if (daily.length) {
      const box = h('div');
      root.append(sectionCard('Bugünkü Katkı', `Toplam ${tlSigned(totals.dayPL)} · işlem geçmişi tahmini`, box));
      barChart(box, { items: daily, format: tlSigned });
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
  if (top && top.weight > 40) {
    root.append(h('div', { class: 'notice warn' },
      `Portföy ağırlığının ${pct(top.weight, 0)}’ı tek varlıkta (${top.code}).`));
  }
  return root;
}
