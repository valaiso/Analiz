/* Panel: portföyün özeti - toplam değer, günlük ve toplam kazanç, pozisyonlar. */

import { h, tl, tlSigned, pct, pctSigned, units as fmtUnits, money, cls, isNum, fmtDate }
  from '../util.js';
import { DB } from '../data.js';
import { lineChart, barChart } from '../charts.js';
import { sliceLastDays } from '../portfolio.js';
import { cashflowCalendar } from '../insights.js';
import { transactions, daysSinceBackup, getMidasAccountSnapshot } from '../store.js';
import { currentMidasPositions, addSiteMarketMetrics, groupAssetRows, assetType } from '../asset-groups.js';
import { kpiCard, plCard, sectionCard, emptyState, rangeSelector, sortableTable, RANGES } from './common.js';

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

function signedCurrency(value, currency = 'TRY') {
  if (!isNum(value)) return '—';
  const rendered = new Intl.NumberFormat('tr-TR', {
    style: 'currency', currency: currency === 'USD' ? 'USD' : 'TRY', maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${rendered}`;
}

export function renderPanel(ctx) {
  const { analysis, navigate } = ctx;
  const { totals, open, series } = analysis;
  const midasSnapshot = getMidasAccountSnapshot();
  const midasSummary = midasSnapshot?.summary;
  const hasMidasTotal = isNum(midasSummary?.totalValue) && midasSummary.totalValue > 0;
  const rawSnapshotPositions = currentMidasPositions() || [];
  const snapshotPositions = addSiteMarketMetrics(rawSnapshotPositions);
  // If the extension could not read Midas's virtualized positions table, keep
  // the portfolio visible from imported transactions instead of hiding all
  // funds/ETFs just because the account total is present.
  const displayPositions = snapshotPositions.length ? snapshotPositions : open.filter((row) => !row.closed);
  const snapshotCodes = new Set(snapshotPositions.map((row) => row.code));
  const localCrypto = hasMidasTotal
    ? open.filter((row) => DB.byCode.get(row.code)?.kind === 'CRYPTO' && !snapshotCodes.has(row.code)).map((row) => ({
      ...row, dailyPLTRY: row.dayPL, totalPLTRY: row.totalPL,
      allocationPct: null, localRecord: true,
    }))
    : [];
  const calculatedPositionsValue = snapshotPositions.reduce((sum, row) =>
    sum + (isNum(row.marketValueTRY) ? row.marketValueTRY : 0), 0);
  const accountValueConsistent = !hasMidasTotal || calculatedPositionsValue <= midasSummary.totalValue * 1.1;
  const positionSnapshotConsistent = accountValueConsistent
    && snapshotPositions.every((row) => isNum(row.marketValueTRY));
  const dailyRows = [...snapshotPositions, ...localCrypto];
  const dailyComplete = dailyRows.length > 0 && dailyRows.every((row) => isNum(row.dailyPLTRY));
  const dailyMissing = dailyRows.filter((row) => !isNum(row.dailyPLTRY)).map((row) => {
    if (!(row.units > 0)) return `${row.code} (adet yok)`;
    if (row.quoteStale) return row.quoteAgeMinutes === null
      ? `${row.code} (kotasyon zamanı yok; günlük hesaba alınmadı)`
      : `${row.code} (kotasyon ${row.quoteAgeMinutes} dk eski; günlük hesaba alınmadı)`;
    if (row.quoteMissing) return `${row.code} (${row.quoteMissingReason}; son fiyat korunuyor)`;
    if (!row.siteDataAvailable) return `${row.code} (fiyat yok)`;
    return `${row.code} (önceki fiyat yok)`;
  });
  const siteDailyChange = dailyComplete
    ? dailyRows.reduce((sum, row) => sum + row.dailyPLTRY, 0) : null;
  const siteDailyBase = dailyComplete
    ? dailyRows.reduce((sum, row) => sum + (isNum(row.marketValuePrevTRY) ? row.marketValuePrevTRY : 0), 0)
    : 0;
  const siteDailyPct = siteDailyBase > 0 ? siteDailyChange / siteDailyBase * 100 : null;
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
  const txs = transactions();
  const taxableFundPL = new Map(analysis.holdings
    .filter((holding) => assetType(holding.code, holding.kind, holding.cat) === 'Fon'
      && !['THF', 'TP2'].includes(holding.code))
    .map((holding) => [holding.code, Number(holding.totalPL) || 0]));
  // Midas positions may have no corresponding transaction history in the app.
  // Use their live cost-based P/L when available so taxable funds like GPN count.
  for (const position of snapshotPositions) {
    if (assetType(position.code, position.kind, position.category) !== 'Fon'
      || ['THF', 'TP2'].includes(position.code)) continue;
    const transactionRealized = Number(analysis.holdings.find((holding) => holding.code === position.code)?.realized) || 0;
    const profit = Number.isFinite(position.totalPLTRY) ? position.totalPLTRY + transactionRealized
      : Number.isFinite(position.totalPLNative) ? position.totalPLNative
        : Number.isFinite(position.totalPL) ? position.totalPL + transactionRealized : taxableFundPL.get(position.code);
    if (Number.isFinite(profit)) taxableFundPL.set(position.code, profit);
  }
  const stopajRows = [...taxableFundPL.entries()]
    .filter(([, profit]) => profit > 0)
    .map(([code, profit]) => ({ code, profit, amount: profit * 0.175 }))
    .sort((a, b) => b.amount - a.amount);
  const stopajEstimate = stopajRows.reduce((sum, row) => sum + row.amount, 0);

  /* ------------------------------------------------------------------ KPI'lar */

  root.append(h('div', { class: 'grid grid-kpi' },
    kpiCard({
      label: 'Toplam Değer',
      tone: 'blue',
      value: tl(hasMidasTotal ? midasSummary.totalValue : totals.value),
      sub: hasMidasTotal
        ? `Midas yatırım hesabı · ${snapshotTime || 'son aktarım'}`
        : `${totals.fundCount} varlık · ${fmtDate(totals.lastDate)}`,
    }),
    plCard({
      label: 'Günlük Kazanç',
      tone: 'orange',
      amount: hasMidasTotal
        ? siteDailyChange : totals.dayPL,
      pct: hasMidasTotal
        ? siteDailyPct : totals.dayPct,
      formatMoney: tlSigned,
      formatPct: pctSigned,
      hint: hasMidasTotal
        ? (isNum(siteDailyChange)
          ? `BIST: BIST seans kotasyonu · ABD: ABD seans kotasyonu · fon: son TEFAS fiyatı · ${fmtDate(DB.meta.lastDataDate)} fiyat havuzu`
          : `Günlük hesap eksikleri: ${dailyMissing.join(', ') || 'açık pozisyon fiyatı bulunamadı'}`)
        : `${fmtDate(totals.prevDate)} kapanışına göre`,
    }),
    plCard({
      label: 'İşlem Kayıtlarına Göre K/Z',
      tone: 'green',
      amount: totals.totalPL,
      pct: totals.totalPct,
      formatMoney: tlSigned,
      formatPct: pctSigned,
      hint: totals.realized !== 0
        ? `${tlSigned(totals.unrealized)} açık · ${tlSigned(totals.realized)} gerçekleşmiş`
        : 'Geçmiş alış/satış kayıtlarından hesaplanır',
    }),
    kpiCard({
      label: 'İşlem Kayıtlarına Göre XIRR',
      tone: 'burgundy',
      value: isNum(analysis.xirr) ? pctSigned(analysis.xirr, 1) : '—',
      valueClass: cls(analysis.xirr),
      sub: 'Para ağırlıklı yıllık bileşik getiri',
      hint: !isNum(analysis.xirr)
        ? 'Hesap için en az birkaç haftalık geçmiş gerekir'
        : (series.dates.length < 90
          ? 'Kısa geçmişten yıllıklandırıldı - oynak olabilir'
          : null),
    }),
    kpiCard({
      label: 'Stopaj Kesintileri',
      tone: 'purple',
      value: tl(stopajEstimate),
      sub: 'Vergili fon kârının %17,5’i',
      hint: 'Otomatik hesaplanır; ana portföy değerini etkilemez.',
    })));

  const stopajTable = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { style: 'text-align:left' }, 'Varlık'),
      h('th', {}, 'Fon kârı'),
      h('th', {}, 'Tahmini stopaj'))),
    h('tbody', {}, stopajRows.map((row) => h('tr', {},
      h('td', { style: 'text-align:left' }, h('span', { class: 'code-chip' }, row.code)),
      h('td', {}, tl(row.profit)),
      h('td', {}, tl(row.amount))))));
  const stopajContent = stopajRows.length
    ? h('div', { class: 'stack' },
      h('div', { class: 'table-wrap', style: 'max-width:460px' }, stopajTable),
      h('p', { class: 'dim', style: 'margin:0' },
        `Tahmini toplam: ${tl(stopajEstimate)} · kârın %17,5’i`))
    : h('p', { class: 'dim', style: 'margin:0' },
      'Vergili fonlarda kâr oluştuğunda tahmini stopaj burada gösterilir.');
  const stopajSection = sectionCard('Stopaj Kesintileri',
    'Vergili fon kârının %17,5’i olarak hesaplanır · portföy değerini etkilemez', stopajContent);

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
  const snapshotDate = hasMidasTotal && midasSnapshot?.capturedAt
    ? new Date(midasSnapshot.capturedAt).toISOString().slice(0, 10) : null;
  const chartEndDate = [series.dates.at(-1), snapshotDate].filter(Boolean).sort().at(-1) || null;
  const untrackedPrincipal = hasMidasTotal
    ? Math.max(0, midasSummary.totalValue - (series.value.at(-1) || 0)) : 0;
  // Unknown Midas principal is held flat across available history, so longer
  // windows can still show a distinct range even when transaction history is short.
  const chartStartDate = untrackedPrincipal > 0 ? '2026-08-19' : series.dates[0] || snapshotDate;
  // Keep older calendar dates in the selected range so 6A/1Y/3Y zoom the
  // requested period. Portfolio values remain blank before the chosen start.
  const chartCalendar = chartEndDate
    ? DB.calendar.filter((date) => date <= chartEndDate) : [];
  const chartDates = chartCalendar.length
    ? [...chartCalendar, ...(chartEndDate > chartCalendar.at(-1) ? [chartEndDate] : [])]
    : (chartEndDate ? [chartEndDate] : []);
  const seriesIndexes = new Map(series.dates.map((date, index) => [date, index]));
  const chartValues = chartDates.map((date) => {
    if (date < chartStartDate) return null;
    const index = seriesIndexes.get(date);
    return index === undefined
      ? (hasMidasTotal ? untrackedPrincipal : null)
      : series.value[index] + untrackedPrincipal;
  });
  const investedValues = chartDates.map((date) => {
    if (date < chartStartDate) return null;
    const index = seriesIndexes.get(date);
    return index === undefined
      ? (hasMidasTotal ? untrackedPrincipal : null)
      : series.invested[index] + untrackedPrincipal;
  });

  const drawChart = () => {
    const range = { '1a': 30, '3a': 90, '6a': 180, '1y': 365, '3y': 1095, all: 0 }[rangeKey];
    const sinceStart = Math.max(1, Math.ceil((Date.parse(`${chartEndDate}T00:00:00Z`)
      - Date.parse(`${chartStartDate}T00:00:00Z`)) / 86400000));
    const selectedDays = range || sinceStart;
    const v = sliceLastDays(chartDates, chartValues, selectedDays);
    const inv = sliceLastDays(chartDates, investedValues, selectedDays);
    const visibleDays = v.dates.length > 1
      ? (Date.parse(`${v.dates.at(-1)}T00:00:00Z`) - Date.parse(`${v.dates[0]}T00:00:00Z`)) / 86400000 : 0;
    lineChart(chartBox, {
      dates: v.dates,
      height: 280,
      xFormat: (date) => visibleDays <= 180 ? `${date.slice(8, 10)}/${date.slice(5, 7)}`
        : `${date.slice(5, 7)}/${date.slice(0, 4)}`,
      yFormat: (x) => tl(x, { compact: true }),
      valueFormat: (x) => tl(x),
      series: [
        { name: 'Portföy değeri', values: v.values, color: 'var(--accent)', fill: true },
        { name: 'Yatırılan anapara', values: inv.values, color: 'var(--teal)', dashed: true, width: 1.8 },
      ],
    });
  };

  const head = h('div', { class: 'card-head' },
    h('div', {},
      h('h2', {}, 'Portföy Değeri ve Yatırılan Para'),
      h('span', { class: 'sub' }, hasMidasTotal
        ? `Midas toplamı temel alınır${untrackedPrincipal > 0 ? ` · geçmiş işlem kaydı olmayan ${tl(untrackedPrincipal)} bakiye sabit anapara varsayılır` : ''}`
        : 'Geçmiş alım/satım kayıtlarına göre modellenir.')),
    rangeSelector(rangeKey, (r) => {
      rangeKey = r.key;
      drawChart();
    }, RANGES.map((range) => range.key === 'all'
      ? { ...range, label: 'Başlangıç', title: 'Yatırım başlangıcından itibaren' } : range)));

  if (chartDates.length) {
    root.append(h('section', { class: 'card' }, head, chartBox));
    drawChart();
  }

  /* ---------------------------------------------------------------- pozisyonlar */

  if (hasMidasTotal && displayPositions.length) {
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
        { key: 'marketValueTRY', label: 'Portföy Değeri', render: (r) => positionSnapshotConsistent && isNum(r.marketValueTRY) ? tl(r.marketValueTRY) : '—' },
        { key: 'avgCost', label: 'Ort. Maliyet', render: (r) => moneyByCurrency(r.avgCost, r.currency) },
        { key: 'dailyPLTRY', label: 'Günlük', render: (r) => h('span', { class: cls(r.dailyPLTRY) }, `${r.noDailyChange || positionSnapshotConsistent ? signedCurrency(r.dailyPLNative, r.currency) : '—'}${(r.noDailyChange || positionSnapshotConsistent) && isNum(r.dailyPct) ? ` · ${pctSigned(r.dailyPct)}` : ''}`) },
        { key: 'totalPLTRY', label: 'Toplam K/Z', render: (r) => h('span', { class: cls(r.totalPLTRY) }, `${r.noDailyChange || positionSnapshotConsistent ? signedCurrency(r.totalPLNative, r.currency) : '—'}${(r.noDailyChange || positionSnapshotConsistent) && isNum(r.totalPct) ? ` · ${pctSigned(r.totalPct)}` : ''}`) },
        { key: 'allocationPct', label: 'Dağılım', render: (r) => isNum(r.allocationPct) ? pct(r.allocationPct, 2) : '—' },
      ],
      rows,
    });
    const groupTitles = { ETF: 'ETF’ler', Fon: 'Fonlar', Hisse: 'Hisseler', Kripto: 'Kripto', Diğer: 'Diğer Varlıklar' };
    const positionGroups = groupAssetRows(displayPositions).map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => (b.allocationPct ?? -1) - (a.allocationPct ?? -1)),
      groupValue: group.rows.reduce((sum, row) => sum + (row.marketValueTRY || 0), 0),
    })).sort((a, b) => b.groupValue - a.groupValue);
    for (const group of positionGroups) {
      root.append(sectionCard(groupTitles[group.label] || group.label,
        'Portföy değeri = Midas adedi × güncel fiyat × güncel kur', positionsTable(group.rows).element));
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

  /* --------------------------------------------------------------- nakit akışı */

  const nakit = cashflowCalendar(txs);
  let nakitSection = null;
  if (nakit.monthly.length > 1) {
    const kutu = h('div');
    const sonAylar = nakit.monthly.slice(-18);
    nakitSection = sectionCard('Aylık Yatırım Akışı',
      `Son ${sonAylar.length} ay · pozitif = para koydun, negatif = çektin`, kutu);
    barChart(kutu, {
      items: sonAylar.map((m) => ({ label: m.month.slice(2), value: m.amount })),
      format: (v) => tlSigned(v),
      labelWidth: 52,
    });
  }
  if (nakitSection) root.append(h('div', { class: 'grid grid-2' }, stopajSection, nakitSection));
  else root.append(stopajSection);

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
