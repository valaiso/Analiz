/* Panel: portföyün özeti - toplam değer, günlük ve toplam kazanç, pozisyonlar. */

import { h, tl, tlSigned, pct, pctSigned, units as fmtUnits, money, cls, isNum, fmtDate }
  from '../util.js';
import { DB } from '../data.js';
import { lineChart, barChart } from '../charts.js';
import { sliceLastDays } from '../portfolio.js';
import { timingQuality, cashflowCalendar } from '../insights.js';
import { transactions, daysSinceBackup, getMidasAccountSnapshot } from '../store.js';
import { currentMidasPositions, addSiteMarketMetrics, groupAssetRows } from '../asset-groups.js';
import { kpiCard, plCard, sectionCard, emptyState, rangeSelector, sortableTable } from './common.js';

/**
 * Fon TEFAS'ta fiyat yayımlamayı bırakmış mı?
 * Kapanan fonlarda son bilinen fiyat sonsuza kadar taşınır; kullanıcı donmuş
 * bir değere baktığını bilmeli.
 */
const DURMUS_GUN_ESIGI = 7;

function fiyatiDurmus(holding) {
  if (!holding.lastPriceDate || !DB.meta.lastDataDate) return false;
  const fark = (new Date(DB.meta.lastDataDate) - new Date(holding.lastPriceDate)) / 86400000;
  return fark > DURMUS_GUN_ESIGI;
}

export function renderPanel(ctx) {
  const { analysis, navigate } = ctx;
  const { totals, open, series } = analysis;
  const midasSnapshot = getMidasAccountSnapshot();
  const midasSummary = midasSnapshot?.summary;
  const hasMidasTotal = isNum(midasSummary?.totalValue) && midasSummary.totalValue > 0;
  const rawSnapshotPositions = currentMidasPositions() || [];
  const snapshotPositions = addSiteMarketMetrics(rawSnapshotPositions);
  const snapshotCodes = new Set(snapshotPositions.map((row) => row.code));
  const pricedSnapshotPositions = snapshotPositions.filter((row) => isNum(row.dailyPLTRY));
  const missingDailyCodes = snapshotPositions.filter((row) => !isNum(row.dailyPLTRY)).map((row) => {
    if (!(row.units > 0)) return `${row.code} (adet okunamadı)`;
    if (!row.siteDataAvailable) return `${row.code} (fiyat geçmişi yok)`;
    return `${row.code} (son kapanış değişimi yok)`;
  });
  const localCrypto = hasMidasTotal
    ? open.filter((row) => DB.byCode.get(row.code)?.kind === 'CRYPTO' && !snapshotCodes.has(row.code)).map((row) => ({
      ...row, dailyPLTRY: row.dayPL, totalPLTRY: row.totalPL,
      allocationPct: null, localRecord: true,
    }))
    : [];
  const completeMidasDaily = snapshotPositions.length > 0
    && pricedSnapshotPositions.length === snapshotPositions.length;
  const siteDailyPL = pricedSnapshotPositions.reduce((sum, row) => sum + row.dailyPLTRY, 0)
    + localCrypto.reduce((sum, row) => sum + (row.dailyPLTRY || 0), 0);
  const siteDailyBase = pricedSnapshotPositions.reduce((sum, row) =>
    sum + (row.marketValuePrevTRY || 0), 0)
    + localCrypto.reduce((sum, row) => sum + (row.prevValue || 0), 0);
  const snapshotTime = midasSnapshot?.capturedAt
    ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(midasSnapshot.capturedAt))
    : null;

  if (!open.length && !analysis.closed.length && !snapshotPositions.length && !hasMidasTotal) {
    return emptyState(
      'Henüz işlem yok',
      'Portföyünü görmek için önce fon alım işlemlerini gir. Fon kodunu ve tarihi seçince '
      + 'birim fiyat TEFAS verisinden otomatik doldurulur.',
      'İlk işlemi ekle',
      () => navigate('islemler'),
    );
  }

  const root = h('div', { class: 'stack' });

  /* ------------------------------------------------------------------ KPI'lar */

  root.append(h('div', { class: 'grid grid-kpi' },
    kpiCard({
      label: 'Toplam Değer',
      value: tl(hasMidasTotal ? midasSummary.totalValue : totals.value),
      sub: hasMidasTotal
        ? `Midas yatırım hesabı · ${snapshotTime || 'son aktarım'}`
        : `${totals.fundCount} varlık · ${fmtDate(totals.lastDate)}`,
    }),
    plCard({
      label: 'Günlük Kazanç',
      amount: hasMidasTotal
        ? (completeMidasDaily ? siteDailyPL : null) : totals.dayPL,
      pct: hasMidasTotal
        ? (completeMidasDaily && siteDailyBase > 0 ? (siteDailyPL / siteDailyBase) * 100 : null) : totals.dayPct,
      formatMoney: tlSigned,
      formatPct: pctSigned,
      hint: hasMidasTotal
        ? (completeMidasDaily
          ? 'Her varlığın sitedeki son iki kapanış fiyatına göre; adet Midas’tan alınır'
          : `Günlük toplam bekletiliyor · ${missingDailyCodes.join(', ') || 'hesap verisi eksik'}`)
        : `${fmtDate(totals.prevDate)} kapanışına göre`,
    }),
    plCard({
      label: 'İşlem Kayıtlarına Göre K/Z',
      amount: totals.totalPL,
      pct: totals.totalPct,
      formatMoney: tlSigned,
      formatPct: pctSigned,
      hint: totals.realized !== 0
        ? `${tlSigned(totals.unrealized)} açık · ${tlSigned(totals.realized)} gerçekleşmiş`
        : 'Geçmiş alış/satış kayıtlarından hesaplanır',
    }),
    kpiCard({
      label: 'İşlem Kayıtlarına Göre Net Yatırılan',
      value: tl(totals.netInvested),
      sub: 'Alımlar − satışlar (masraflar dahil)',
    }),
    kpiCard({
      label: 'İşlem Kayıtlarına Göre XIRR',
      value: isNum(analysis.xirr) ? pctSigned(analysis.xirr, 1) : '—',
      valueClass: cls(analysis.xirr),
      sub: 'Para ağırlıklı yıllık bileşik getiri',
      hint: !isNum(analysis.xirr)
        ? 'Hesap için en az birkaç haftalık geçmiş gerekir'
        : (series.dates.length < 90
          ? 'Kısa geçmişten yıllıklandırıldı - oynak olabilir'
          : null),
    })));

  const txs = transactions();

  if (txs.length >= 5 && daysSinceBackup() === null) {
    root.append(h('div', { class: 'notice' },
      `${txs.length} işlem girdin ama henüz yedek almadın. Veriler yalnızca bu `
      + 'tarayıcıda duruyor; tarayıcı verilerini temizlersen kaybolur. ',
      h('button', {
        class: 'btn btn-sm', type: 'button', style: 'margin-left:6px',
        onclick: () => navigate('ayarlar'),
      }, "Ayarlar'dan yedek al")));
  }

  /* ------------------------------------------------------ portföy değeri grafiği */

  let rangeKey = '6a';
  const chartBox = h('div', { class: 'chart' });

  const drawChart = () => {
    const range = { '1a': 30, '3a': 90, '6a': 180, '1y': 365, '3y': 1095, all: 0 }[rangeKey];
    const v = sliceLastDays(series.dates, series.value, range);
    const inv = sliceLastDays(series.dates, series.invested, range);
    lineChart(chartBox, {
      dates: v.dates,
      height: 280,
      yFormat: (x) => tl(x, { compact: true }),
      valueFormat: (x) => tl(x),
      series: [
        { name: 'Portföy değeri', values: v.values, color: 'var(--accent)', fill: true },
        { name: 'Yatırılan anapara', values: inv.values, color: 'var(--text-dim)', dashed: true, width: 1.5 },
      ],
    });
  };

  const head = h('div', { class: 'card-head' },
    h('div', {},
      h('h2', {}, 'İşlem Kayıtlarına Göre Portföy Değeri'),
      h('span', { class: 'sub' }, 'Geçmiş alım/satımlardan modellenir; Midas canlı hesabı değildir.')),
    rangeSelector(rangeKey, (r) => {
      rangeKey = r.key;
      head.querySelectorAll('.seg button').forEach((b) => {
        b.setAttribute('aria-pressed', b.textContent === r.label ? 'true' : 'false');
      });
      drawChart();
    }));

  if (!hasMidasTotal) {
    root.append(h('section', { class: 'card' }, head, chartBox));
    drawChart();
  }

  /* ---------------------------------------------------------------- pozisyonlar */

  if (hasMidasTotal && snapshotPositions.length) {
    const moneyByCurrency = (value, currency) => {
      if (!isNum(value)) return '—';
      return new Intl.NumberFormat('tr-TR', {
        style: 'currency', currency: currency === 'USD' ? 'USD' : 'TRY', maximumFractionDigits: 2,
      }).format(value);
    };
    const positionsTable = (rows) => sortableTable({
      initialSort: { key: 'allocationPct', dir: 'desc' },
      columns: [
        { key: 'code', label: 'Varlık', defaultDir: 'asc', render: (r) => h('span', { class: 'code-chip' }, r.code) },
        { key: 'units', label: 'Adet', render: (r) => fmtUnits(r.units) },
        { key: 'marketValueTRY', label: 'Portföy Değeri', render: (r) => isNum(r.marketValueTRY) ? tl(r.marketValueTRY) : '—' },
        { key: 'avgCost', label: 'Ort. Maliyet', render: (r) => moneyByCurrency(r.avgCost, r.currency) },
        { key: 'dailyPLTRY', label: 'Günlük', render: (r) => h('span', { class: cls(r.dailyPLTRY) }, `${isNum(r.dailyPLTRY) ? tlSigned(r.dailyPLTRY) : '—'}${isNum(r.dailyPct) ? ` · ${pctSigned(r.dailyPct)}` : ''}`) },
        { key: 'totalPLTRY', label: 'Toplam K/Z', render: (r) => h('span', { class: cls(r.totalPLTRY) }, `${isNum(r.totalPLTRY) ? tlSigned(r.totalPLTRY) : '—'}${isNum(r.totalPct) ? ` · ${pctSigned(r.totalPct)}` : ''}`) },
        { key: 'allocationPct', label: 'Dağılım', render: (r) => isNum(r.allocationPct) ? pct(r.allocationPct, 2) : '—' },
      ],
      rows,
    });
    const groupTitles = { ETF: 'ETF’ler', Fon: 'Fonlar', Hisse: 'Hisseler', Kripto: 'Kripto', Diğer: 'Diğer Varlıklar' };
    const positionGroups = groupAssetRows(snapshotPositions).map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => (b.allocationPct ?? -1) - (a.allocationPct ?? -1)),
      groupValue: group.rows.reduce((sum, row) => sum + (row.marketValueTRY || 0), 0),
    })).sort((a, b) => b.groupValue - a.groupValue);
    for (const group of positionGroups) {
      root.append(sectionCard(groupTitles[group.label] || group.label,
        null, positionsTable(group.rows).element));
    }
    if (localCrypto.length) {
      const table = sortableTable({
        initialSort: { key: 'value', dir: 'desc' },
        columns: [
          { key: 'code', label: 'Varlık', render: (row) => h('span', { class: 'code-chip' }, row.code) },
          { key: 'units', label: 'Adet', render: (row) => fmtUnits(row.units) },
          { key: 'dailyPLTRY', label: 'Bugünkü K/Z (₺)', render: (row) => h('span', { class: cls(row.dailyPLTRY) }, tlSigned(row.dailyPLTRY)) },
          { key: 'totalPLTRY', label: 'Toplam K/Z (₺)', render: (row) => h('span', { class: cls(row.totalPLTRY) }, tlSigned(row.totalPLTRY)) },
        ],
        rows: localCrypto,
      });
      root.append(sectionCard('Kripto', 'Bitcoin elle manuel eklenmelidir.', table.element));
    }
    if (!localCrypto.length) root.append(h('div', { class: 'notice' }, 'Bitcoin elle manuel eklenmelidir.'));
  } else if (!hasMidasTotal && open.length) {
    const table = sortableTable({
      initialSort: { key: 'value', dir: 'desc' },
      onRowClick: (row) => ctx.showFund(row.code),
      columns: [
        {
          key: 'code', label: 'Fon', defaultDir: 'asc',
          render: (r) => h('div', { style: 'display:flex;flex-direction:column;gap:2px' },
            h('span', {}, h('span', { class: 'code-chip' }, r.code),
              r.missingPrice ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'fiyat yok') : null,
              fiyatiDurmus(r) ? h('span', { class: 'pill down', style: 'margin-left:6px' }, 'fiyat durmuş') : null),
            h('span', { class: 'dim', style: 'font-size:.76rem;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, r.name)),
        },
        { key: 'units', label: 'Adet', render: (r) => fmtUnits(r.units) },
        { key: 'avgCost', label: 'Ort. Maliyet', render: (r) => `${money(r.avgCost)} ${r.currencySymbol}` },
        { key: 'price', label: 'Güncel Fiyat', render: (r) => `${money(r.price)} ${r.currencySymbol}` },
        {
          key: 'dayPct', label: 'Günlük',
          render: (r) => h('span', { class: cls(r.dayPct) },
            `${pctSigned(r.dayPct)}${isNum(r.dayPL) && r.dayPL !== 0 ? ` · ${tlSigned(r.dayPL)}` : ''}`),
        },
        { key: 'value', label: 'Değer', render: (r) => tl(r.value) },
        {
          key: 'unrealized', label: 'Kâr / Zarar',
          render: (r) => h('span', { class: cls(r.unrealized) },
            `${tlSigned(r.unrealized)} (${pctSigned(r.unrealizedPct)})`),
        },
        { key: 'weight', label: 'Ağırlık', render: (r) => pct(r.weight, 1) },
      ],
      rows: open,
    });

    root.append(sectionCard('Pozisyonlar', `${open.length} açık fon · satır tıklanabilir`,
      table.element));
  }

  /* ---------------------------------------------------------- zamanlama kalitesi */

  const activeCodes = hasMidasTotal
    ? new Set([...snapshotPositions, ...localCrypto].map((position) => position.code)) : null;
  const zamanlama = timingQuality(txs).filter((row) => !activeCodes || activeCodes.has(row.code));
  if (zamanlama.length) {
    const agirlik = zamanlama.reduce((s2, z) => s2 + z.invested, 0);
    const ortalama = agirlik > 0
      ? zamanlama.reduce((s2, z) => s2 + z.diffPct * z.invested, 0) / agirlik : null;

    const timingTable = (rows) => h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { style: 'text-align:left' }, 'Varlık'),
        h('th', {}, 'Ort. alım fiyatın'),
        h('th', {}, 'Dönemin ort. fiyatı'),
        h('th', {}, 'Fark'),
        h('th', {}, 'Yatırdığın'))),
      h('tbody', {}, rows.map((z) => h('tr', {},
        h('td', {}, h('span', { class: 'code-chip' }, z.code)),
        h('td', {}, money(z.avgCost)),
        h('td', {}, money(z.avgMarket)),
        h('td', { class: z.diffPct < 0 ? 'up' : 'down' }, pctSigned(z.diffPct, 1)),
        h('td', {}, tl(z.invested)))))));
    root.append(sectionCard('Zamanlama Kalitesi',
      hasMidasTotal ? 'Yalnızca Midas’ta şu anda açık görünen varlıklar' : 'Alım fiyatların, tuttuğun varlıkların ortalama piyasa fiyatına göre',
      h('p', { class: 'dim', style: 'margin:0 0 12px;font-size:.85rem' },
        isNum(ortalama)
          ? (ortalama < 0
            ? `Ağırlıklı ortalamada, tuttuğun dönemin ortalama fiyatının ${pct(Math.abs(ortalama), 1)} `
              + 'altından almışsın.'
            : `Ağırlıklı ortalamada, tuttuğun dönemin ortalama fiyatının ${pct(ortalama, 1)} `
              + 'üstünden almışsın.')
          : ''),
      groupAssetRows(zamanlama).map((group) => sectionCard(group.label,
        `${group.rows.length} açık varlık · işlem kayıtlarından zamanlama`, timingTable(group.rows)))));
  }

  /* --------------------------------------------------------------- nakit akışı */

  const nakit = cashflowCalendar(txs);
  if (nakit.monthly.length > 1) {
    const kutu = h('div');
    const sonAylar = nakit.monthly.slice(-18);
    root.append(sectionCard('Aylık Yatırım Akışı',
      `Son ${sonAylar.length} ay · pozitif = para koydun, negatif = çektin`, kutu));
    barChart(kutu, {
      items: sonAylar.map((m) => ({ label: m.month.slice(2), value: m.amount })),
      format: (v) => tlSigned(v),
      labelWidth: 52,
    });
  }

  if (nakit.realizedByYear.length) {
    root.append(sectionCard('Yıllara Göre Gerçekleşen Kâr/Zarar',
      'Yalnızca satılan pozisyonlardan; açık pozisyonlar dahil değil',
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { style: 'text-align:left' }, 'Yıl'), h('th', {}, 'Gerçekleşen K/Z'))),
        h('tbody', {}, nakit.realizedByYear.map((y) => h('tr', {},
          h('td', {}, String(y.year)),
          h('td', { class: cls(y.amount) }, tlSigned(y.amount)))))))));
  }


  if (analysis.preRange) {
    root.append(h('div', { class: 'notice' },
      `Bazı işlemlerin ${fmtDate(series.dates[0])} tarihinden eski. TEFAS'tan `
      + 'yalnızca son 3 yılın fiyatları alındığı için grafikler bu tarihten '
      + 'itibaren çiziliyor; maliyet ve toplam kazanç hesapların gerçek alım '
      + 'fiyatlarınla yapılıyor, etkilenmiyor.'));
  }

  const durmus = hasMidasTotal ? [] : open.filter(fiyatiDurmus);
  const fiyatYok = hasMidasTotal ? [] : open.filter((holding) => holding.missingPrice || holding.missingFx);
  if (fiyatYok.length) {
    root.append(h('div', { class: 'notice warn' },
      `${fiyatYok.map((holding) => holding.code).join(', ')} için fiyat geçmişi bulunamadı. `
      + 'Bu pozisyonların maliyeti ve adetleri işlem kaydında korunur; güncel değer/kâr-zarar toplamına katılmaz. '
      + `Eksik fiyatlı pozisyon maliyeti: ${tl(analysis.totals.unpricedCost)}. `
      + 'Toplam getiri yüzdesi ve XIRR fiyat verisi gelene kadar gösterilmez.'));
  }

  if (durmus.length) {
    root.append(h('div', { class: 'notice warn' },
      `${durmus.map((x) => `${x.code} (son fiyat ${fmtDate(x.lastPriceDate)})`).join(', ')} `
      + 'için TEFAS bir süredir yeni fiyat yayımlamıyor - fon kapanmış olabilir. '
      + 'Bu pozisyonların değeri son bilinen fiyattan hesaplanıyor, yani güncel değil.'));
  }

  const oversold = hasMidasTotal ? [] : analysis.holdings.filter((x) => x.oversold);
  if (oversold.length) {
    root.append(h('div', { class: 'notice warn' },
      `Dikkat: ${oversold.map((x) => x.code).join(', ')} için elde olandan fazla satış girilmiş. `
      + 'Fazla kısım yok sayıldı - İşlemler sekmesinden kontrol et.'));
  }

  return root;
}
