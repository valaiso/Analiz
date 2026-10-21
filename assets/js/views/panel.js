/* Panel: portföyün özeti - toplam değer, günlük ve toplam kazanç, pozisyonlar. */

import { h, tl, tlSigned, pct, pctSigned, units as fmtUnits, money, cls, isNum, fmtDate, toast }
  from '../util.js';
import { DB } from '../data.js';
import { lineChart, barChart } from '../charts.js';
import { sliceLastDays } from '../portfolio.js';
import { cashflowCalendar, realReturn } from '../insights.js';
import {
  transactions, daysSinceBackup, getMidasAccountSnapshot,
  valueHistory, recordPortfolioValue, recordMonthlySnapshot, setPortfolioValue, removePortfolioValue, cashflows, midasBaselineState, pendingCashflow,
  updateMidasBaseline, confirmPendingCashflow, rejectPendingCashflow, removeCashflow, dividends, dividendsBetween, manualCashflowsBetween,
} from '../store.js';
import {
  currentMidasPositions, currentMidasCryptoPositions, addSiteMarketMetrics,
  applyDailyMarketTransactions, groupAssetRows, assetType, midasStockAccountValue, assetLabel, groupFundsByType, fundStopajRate,
  midasBaseline, unexplainedChange,
} from '../asset-groups.js';
import { assetLogo } from '../logos.js';
import { tile, fundParts, groupTiles, plBadge } from './tiles.js';
import { kpiCard, plCard, sectionCard, toneCard, groupStrip, SECTION_TONES, emptyState, rangeSelector, sortableTable, RANGES } from './common.js';

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

function todayInIstanbul() {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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
  const stockPositionsCaptured = midasSnapshot?.positionsSource === 'midas-visible-v1'
    && midasSnapshot.positionsCaptured === true;
  const stockSummaryCaptured = midasSnapshot?.summarySource === 'midas-visible-v1'
    && Number.isFinite(midasSummary?.totalValue) && midasSummary.totalValue >= 0;
  const cryptoPositionsCaptured = midasSnapshot?.cryptoPositionsSource === 'midas-visible-v1'
    && midasSnapshot.cryptoPositionsCaptured === true;
  const rawSnapshotPositions = [
    ...(currentMidasPositions() || []),
    ...(currentMidasCryptoPositions() || []),
  ];
  const measuredSnapshotPositions = addSiteMarketMetrics(rawSnapshotPositions);
  const stockAccount = midasStockAccountValue(measuredSnapshotPositions
    .filter((row) => !row.midasCryptoSnapshot));
  const stockMidasTotal = stockPositionsCaptured ? stockAccount.total
    : stockSummaryCaptured ? midasSummary.totalValue : 0;
  const cryptoRows = measuredSnapshotPositions.filter((row) => row.midasCryptoSnapshot);
  const measuredCryptoValue = cryptoRows.reduce((sum, row) =>
    sum + (isNum(row.marketValueTRY) ? row.marketValueTRY : 0), 0);
  const liveCryptoValuationComplete = cryptoRows.length > 0
    && cryptoRows.every((row) => row.liveQuoteUsed && isNum(row.marketValueTRY));
  const cryptoTotal = cryptoPositionsCaptured
    ? liveCryptoValuationComplete ? measuredCryptoValue
      : Math.max(Number(midasSnapshot?.cryptoSummarySource === 'midas-visible-v1'
        ? midasSnapshot.cryptoSummary?.totalValue : 0) || 0, measuredCryptoValue)
    : 0;
  const midasPortfolioTotal = stockMidasTotal + cryptoTotal;
  const accountTransactions = transactions();
  const midasHistoryCodes = [...new Set(accountTransactions
    .filter((tx) => tx.source === 'midas')
    .map((tx) => String(tx.code || '').toUpperCase())
    .filter(Boolean))];
  const expectsStockSnapshot = midasHistoryCodes.some((code) => DB.byCode.get(code)?.kind !== 'CRYPTO');
  const expectsCryptoSnapshot = midasHistoryCodes.some((code) => DB.byCode.get(code)?.kind === 'CRYPTO');
  const missingCryptoSnapshot = !cryptoPositionsCaptured
    && (expectsCryptoSnapshot || Boolean(midasSnapshot?.cryptoScanFailedAt));
  const missingStockSnapshot = !stockPositionsCaptured && !stockSummaryCaptured
    && (expectsStockSnapshot || Boolean(midasSnapshot?.stockScanFailedAt));
  const midasSnapshotComplete = !missingStockSnapshot && !missingCryptoSnapshot;
  // Show the verified account subtotal even if another Midas workspace could
  // not be read. Hiding a valid ~₺400k investment snapshot because Crypto is
  // missing made the panel look empty and concealed which account was missing.
  const hasMidasTotal = (stockPositionsCaptured || stockSummaryCaptured || cryptoPositionsCaptured)
    && midasPortfolioTotal >= 0;
  const midasTotalPartial = hasMidasTotal && !midasSnapshotComplete;
  const hasMidasImportState = midasHistoryCodes.length > 0
    || Boolean(midasSnapshot?.stockScanFailedAt || midasSnapshot?.cryptoScanFailedAt
      || midasSnapshot?.positionsSource === 'midas-visible-v1'
      || midasSnapshot?.cryptoPositionsSource === 'midas-visible-v1');
  const positionsVerified = stockPositionsCaptured || cryptoPositionsCaptured;
  const snapshotPositions = measuredSnapshotPositions.map((row) =>
    row.midasCryptoSnapshot && midasPortfolioTotal > 0 && isNum(row.marketValueTRY)
      ? { ...row, allocationPct: row.marketValueTRY / midasPortfolioTotal * 100 }
      : row);
  const todayMidasTransactions = accountTransactions.filter((tx) => tx.source === 'midas'
    && String(tx.date || '').slice(0, 10) === todayInIstanbul());
  const dailyPositionCoverageComplete = (stockPositionsCaptured || !expectsStockSnapshot)
    && (cryptoPositionsCaptured || !expectsCryptoSnapshot);
  const dailyMarket = applyDailyMarketTransactions(snapshotPositions, todayMidasTransactions,
    todayInIstanbul(), { positionsComplete: dailyPositionCoverageComplete });
  const dailyPositions = dailyMarket.rows;
  // Do not infer an open holding from Midas order history.
  const displayPositions = positionsVerified ? dailyPositions
    : hasMidasTotal ? [] : open.filter((row) => !row.closed);
  const calculatedPositionsValue = snapshotPositions.reduce((sum, row) =>
    sum + (isNum(row.marketValueTRY) ? row.marketValueTRY : 0), 0);
  const accountValueConsistent = !hasMidasTotal || calculatedPositionsValue <= midasPortfolioTotal * 1.1;
  const positionSnapshotConsistent = accountValueConsistent
    && snapshotPositions.every((row) => isNum(row.marketValueTRY));
  const dailyRows = dailyPositions;
  const dailyMissing = dailyRows.filter((row) => !isNum(row.dailyPLTRY)
    && !dailyMarket.missingCodes.some((message) => message === `${row.code} (önceki kapanış fiyatı yok)`))
    .map((row) => {
      if (!(row.units > 0)) return `${row.code} (adet yok)`;
      if (row.quoteStale) return row.quoteAgeMinutes === null
        ? `${row.code} (kotasyon zamanı yok; günlük hesaba alınmadı)`
        : `${row.code} (kotasyon ${row.quoteAgeMinutes} dk eski; günlük hesaba alınmadı)`;
      if (row.quoteMissing) return `${row.code} (${row.quoteMissingReason})`;
      if (!row.siteDataAvailable) return `${row.code} (fiyat yok)`;
      return `${row.code} (önceki kapanış fiyatı yok)`;
    });
  const dailyIncompleteHint = [...new Set([
    ...dailyMarket.missingCodes,
    missingStockSnapshot ? 'yatırım pozisyonları doğrulanmadı' : '',
    missingCryptoSnapshot ? 'kripto hesabı doğrulanmadı' : '',
    ...dailyMissing,
  ].filter(Boolean))].join(', ');
  const dailyCryptoScope = cryptoPositionsCaptured ? 'kripto dahil'
    : missingCryptoSnapshot ? 'kripto hariç' : '';
  // Hesaplanabilen pozisyonların toplamı her zaman gösterilir; eksik kalanlar
  // ipucunda listelenir. Kart hiçbir zaman tümüyle boş kalmamalı.
  const siteDailyChange = dailyMarket.total;
  const siteDailyBase = dailyMarket.base;
  const siteDailyPct = siteDailyBase > 0 && isNum(siteDailyChange)
    ? siteDailyChange / siteDailyBase * 100 : null;
  const lastSessionDates = [...new Set(dailyRows.map((row) => row.dailyFromLastSession)
    .filter((value) => typeof value === 'string'))].sort();
  const dailyLastSessionNote = dailyRows.some((row) => row.dailyFromLastSession)
    ? `bugün piyasa hareketi yok; son işlem günü${lastSessionDates.length ? ` (${lastSessionDates.map(fmtDate).join(', ')})` : ''} kapanışına göre`
    : '';
  const snapshotAt = [
    stockPositionsCaptured ? midasSnapshot.stockCapturedAt : null,
    stockSummaryCaptured ? midasSnapshot.summaryCapturedAt : null,
    cryptoPositionsCaptured ? midasSnapshot.cryptoCapturedAt : null,
  ].filter(Boolean).sort().at(-1);
  const snapshotTime = snapshotAt
    ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(snapshotAt))
    : null;
  const verifiedAccounts = [
    stockPositionsCaptured || stockSummaryCaptured ? 'yatırım' : '',
    cryptoPositionsCaptured ? 'kripto' : '',
  ].filter(Boolean);
  const accountLabel = `Midas ${verifiedAccounts.join(' + ')} hesabı`;

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
  const missingPositionScans = [
    missingStockSnapshot
      ? 'yatırım hesabındaki hisse/fon Pozisyonlar tablosu' : '',
    missingCryptoSnapshot
      ? 'Kripto hesabındaki Pozisyonlar tablosu' : '',
  ].filter(Boolean);
  if (missingPositionScans.length) {
    root.append(h('div', { class: 'notice warn' },
      `${missingPositionScans.join(' ve ')} henüz doğrulanmadı. Emir geçmişindeki işlemler açık pozisyon olarak kullanılmıyor; ilgili Midas görünümünde Pozisyonlar tablosunu açıp aktarımı çalıştır.`));
  }
  const lastStockScanFailed = midasSnapshot?.stockScanFailedAt
    && (!midasSnapshot.stockCapturedAt || midasSnapshot.stockScanFailedAt > midasSnapshot.stockCapturedAt);
  const lastCryptoScanFailed = midasSnapshot?.cryptoScanFailedAt
    && (!midasSnapshot.cryptoCapturedAt || midasSnapshot.cryptoScanFailedAt > midasSnapshot.cryptoCapturedAt);
  if (lastStockScanFailed || lastCryptoScanFailed) {
    root.append(h('div', { class: 'notice warn' },
      'Son Midas taraması Pozisyonlar tablosunu doğrulayamadı. Önceki doğrulanmış anlık görüntü korunuyor; yeniden aktarım yapana kadar bu veriler güncel kabul edilmemeli.'));
  }
  // Adet, maliyet ve nakit yalnızca Midas taramasında güncellenir; fiyatlar
  // kendiliğinden yenilense de eski tarama alım/satım/temettüyü kaçırır.
  const MIDAS_STALE_DAYS = 3;
  const midasScanAges = [
    stockPositionsCaptured ? midasSnapshot.stockCapturedAt : null,
    cryptoPositionsCaptured ? midasSnapshot.cryptoCapturedAt : null,
  ].filter(Boolean).map((at) => (Date.now() - Date.parse(at)) / 86400000).filter(Number.isFinite);
  const oldestScanDays = midasScanAges.length ? Math.floor(Math.max(...midasScanAges)) : 0;
  if (oldestScanDays >= MIDAS_STALE_DAYS) {
    root.append(h('div', { class: 'notice warn' },
      `Son Midas taraması ${oldestScanDays} gün önce yapıldı. Fiyatlar güncel ama adet, ortalama maliyet ve nakit o günkü haliyle duruyor; `
      + 'bu sürede alım/satım, temettü ya da para yatırma olduysa toplam değer yanlış olabilir. ',
      h('button', {
        class: 'btn btn-sm', type: 'button', style: 'margin-left:6px',
        onclick: () => navigate('islemler'),
      }, 'Midas’tan yeniden oku')));
  }
  if (hasMidasTotal && midasSnapshotComplete) {
    recordPortfolioValue(todayInIstanbul(), midasPortfolioTotal);
    // Aylık rapor için ayın son pozisyon fotoğrafı (ay boyunca güncellenir).
    recordMonthlySnapshot(todayInIstanbul(), {
      total: midasPortfolioTotal,
      cash: stockPositionsCaptured ? stockAccount.cash : 0,
      rows: snapshotPositions.filter((row) => isNum(row.marketValueTRY) && row.marketValueTRY > 0).map((row) => ({
        code: row.code,
        group: assetType(row.code, row.kind, row.category),
        label: assetLabel(row.code) || '',
        currency: row.currency || 'TRY',
        units: row.units,
        price: row.price,
        value: Math.round(row.marketValueTRY * 100) / 100,
        unitTRY: row.units > 0 ? row.marketValueTRY / row.units : null,
        totalPLTRY: isNum(row.totalPLTRY) ? Math.round(row.totalPLTRY * 100) / 100 : null,
        totalPct: isNum(row.totalPct) ? row.totalPct : null,
        frozen: Boolean(row.frozen),
      })),
    });
  }

  /* ------------------------------------------------- para giriş/çıkış tespiti */

  // Yeni Midas taraması geldiyse önceki taramayla karşılaştır: fiyat
  // hareketiyle açıklanamayan fark para yatırma/çekme olabilir; kullanıcıya sor.
  const currentBaseline = midasBaseline();
  const previousBaseline = midasBaselineState();
  if (currentBaseline && previousBaseline?.key !== currentBaseline.key) {
    // Kripto hesabı ilk kez okunduysa eklenen değer para girişi değildir.
    const cryptoNewlyCaptured = !previousBaseline?.key?.split('|')[1] && currentBaseline.key.split('|')[1];
    const rawChange = previousBaseline && !cryptoNewlyCaptured
      ? unexplainedChange(previousBaseline, currentBaseline) : null;
    // Bu aralıkta girilmiş temettüler para girişi değildir; elle girilen nakit zaten
    // kayıtlıdır. İkisi de tespitten düşülür ki aynı para ikinci kez sorulmasın.
    const change = rawChange ? (() => {
      const from = String(previousBaseline.at || '').slice(0, 10);
      const to = String(currentBaseline.at || '').slice(0, 10);
      const amount = rawChange.amount - dividendsBetween(from, to) - manualCashflowsBetween(from, to);
      return { ...rawChange, amount, significant: Math.abs(amount) >= Math.max(1000, Math.abs(previousBaseline.total) * 0.01) };
    })() : null;
    updateMidasBaseline(currentBaseline, change?.significant ? change : null);
  }
  const pending = pendingCashflow();
  if (pending) {
    const deposit = pending.amount > 0;
    root.append(h('div', { class: 'notice warn' },
      h('strong', {}, deposit ? `Hesaba ${tl(pending.amount)} para eklendi mi?` : `Hesaptan ${tl(-pending.amount)} para çekildi mi?`),
      ` Son iki Midas taraması arasında (${pending.from ? fmtDate(pending.from.slice(0, 10)) : '—'} → ${fmtDate(pending.date)}) toplam değer, hisse/fon/ETF/kripto fiyat hareketiyle açıklanamayacak kadar ${deposit ? 'arttı' : 'azaldı'}. `
      + 'Evet dersen yatırılan para olarak kaydedilir ve gerçek getiri hesabında getiri sayılmaz. '
      + 'Bu tutarın içinde temettü varsa İşlemler → Temettü Geliri’ne gir; temettü kadarı otomatik olarak getiriye geçer. ',
      h('button', {
        class: 'btn btn-sm btn-primary', type: 'button', style: 'margin-left:6px',
        onclick: () => { confirmPendingCashflow(); ctx.refresh(); },
      }, deposit ? 'Evet, para ekledim' : 'Evet, para çektim'),
      h('button', {
        class: 'btn btn-sm', type: 'button', style: 'margin-left:6px',
        onclick: () => { rejectPendingCashflow(); navigate('islemler'); },
      }, 'Hayır, Midas’ı yeniden eşitle')));
  }
  const real = hasMidasTotal ? realReturn(valueHistory(), cashflows()) : null;
  const realDividends = real ? dividends().filter((item) => item.date > real.startDate)
    .reduce((sum, item) => sum + item.amount, 0) : 0;

  const txs = ctx.analysisTransactions || transactions();
  const taxableFundPL = new Map(analysis.holdings
    .filter((holding) => !holding.closed && assetType(holding.code, holding.kind, holding.cat) === 'Fon'
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
  // Açık dönemin ilk alış tarihi (pozisyon sıfırlanınca yeni dönem başlar).
  const holdingStart = new Map();
  const openUnits = new Map();
  for (const tx of txs) {
    const code = String(tx.code || '').toLocaleUpperCase('tr');
    const units = Number(tx.units) || 0;
    const before = openUnits.get(code) || 0;
    if (tx.type === 'AL') {
      if (before <= 1e-8) holdingStart.set(code, String(tx.date || '').slice(0, 10));
      openUnits.set(code, before + units);
    } else if (tx.type === 'SAT') {
      const after = Math.max(0, before - units);
      openUnits.set(code, after);
      if (after <= 1e-8) holdingStart.delete(code);
    }
  }
  const stopajRows = [...taxableFundPL.entries()]
    .filter(([, profit]) => profit > 0)
    .map(([code, profit]) => {
      const { rate, reason } = fundStopajRate(code, holdingStart.get(code), todayInIstanbul());
      return { code, profit, rate, reason, amount: profit * rate };
    })
    .sort((a, b) => b.amount - a.amount);
  const stopajEstimate = stopajRows.reduce((sum, row) => sum + row.amount, 0);

  /* ------------------------------------------------------------------ KPI'lar */

  const totalValueText = hasMidasTotal ? tl(midasPortfolioTotal) : hasMidasImportState ? '—' : tl(totals.value);
  const totalValueSub = hasMidasTotal
    ? `Hisse/Fon/ETF ${tl(stockMidasTotal)}${stockAccount.cash > 0.5 && stockPositionsCaptured ? ` (${tl(stockAccount.cash)} nakit dahil)` : ''} + Kripto ${tl(cryptoTotal)}${midasTotalPartial ? ' · kısmi toplam' : ''}`
    : hasMidasImportState
      ? 'Midas’ın açık pozisyonları doğrulanana kadar hesaplanmıyor'
      : `${totals.fundCount} varlık · ${fmtDate(totals.lastDate)}`;
  const dailyAmount = hasMidasTotal ? siteDailyChange : hasMidasImportState ? null : totals.dayPL;
  const dailyPctValue = hasMidasTotal ? siteDailyPct : hasMidasImportState ? null : totals.dayPct;
  const dailyHint = hasMidasTotal
    ? (isNum(siteDailyChange)
      ? `Piyasa fiyatlarından hesaplandı${dailyLastSessionNote ? ` · ${dailyLastSessionNote}` : ''}${dailyCryptoScope ? ` · ${dailyCryptoScope}` : ''}${dailyIncompleteHint ? ` · kısmi: ${dailyIncompleteHint}` : ''}`
      : `Günlük fiyat hareketi hesaplanamadı; eksik: ${dailyIncompleteHint || 'açık pozisyon fiyatı bulunamadı'}`)
    : hasMidasImportState
      ? 'Midas pozisyonları doğrulanana kadar günlük değişim hesaplanmıyor'
      : `${fmtDate(totals.prevDate)} kapanışına göre`;
  const heroTrend = (value) => (value > 0 ? 'hero-up' : value < 0 ? 'hero-down' : '');
  // Kurumsal özet bandı: toplam değer ve günlük kazanç.
  root.append(h('section', { class: 'hero' },
    h('div', {},
      h('span', { class: 'hero-eyebrow' }, `PORTFÖY ÖZETİ${snapshotTime ? ` · MİDAS ${snapshotTime}` : ''}`),
      h('h2', {}, totalValueText),
      h('p', {}, totalValueSub)),
    h('div', { class: 'hero-figures' },
      h('div', {},
        h('span', {}, 'Günlük kazanç'),
        h('strong', { class: heroTrend(dailyAmount) }, isNum(dailyAmount) ? tlSigned(dailyAmount) : '—'),
        h('em', { class: heroTrend(dailyPctValue) }, isNum(dailyPctValue) ? pctSigned(dailyPctValue) : '')),
      h('div', {},
        h('span', {}, 'Gerçek getiri'),
        h('strong', { class: heroTrend(real?.twr) }, isNum(real?.twr) ? pctSigned(real.twr) : '—'),
        h('em', {}, real && isNum(real.twr)
          ? `${fmtDate(real.startDate)}’den beri${realDividends > 0 ? ` · ${tl(realDividends)} temettü dahil` : ''}`
          : 'ikinci kayıt gününden itibaren')),
      h('div', {},
        h('span', {}, 'Stopaj (tahmini)'),
        h('strong', {}, tl(stopajEstimate)),
        h('em', {}, 'satışta fon kârından')),
      h('p', { class: 'hero-note' }, dailyHint))));

  const stopajContent = stopajRows.length
    ? h('div', { class: 'fund-tiles' }, stopajRows.map((row) => {
      const parts = fundParts(row.code);
      return tile({
        code: row.code, top: parts.issuer || 'Fon', name: parts.name,
        figs: [
          { label: 'Fon kârı', value: tl(row.profit) },
          { label: 'Oran', value: pct(row.rate * 100, 1) },
          { label: 'Stopaj', value: tl(row.amount) },
        ],
        foot: [row.reason],
      });
    }))
    : h('p', { class: 'dim', style: 'margin:0' },
      'Vergili fonlarda kâr oluştuğunda tahmini stopaj burada gösterilir.');
  const stopajSection = toneCard({
    tone: 'violet', icon: '%', title: 'Stopaj Kesintileri',
    sub: 'Hisse yoğun fonlar %0, ≥%51 BIST hisseli fonlar 1 yıl sonra %0, diğerleri %17,5 · portföy değerini etkilemez',
    figure: tl(stopajEstimate), figureSub: 'tahmini toplam',
  }, stopajContent);

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

  let rangeKey = 'all';
  const chartBox = h('div', { class: 'chart' });
  const untrackedPrincipal = hasMidasTotal
    ? Math.max(0, midasPortfolioTotal - (series.value.at(-1) || 0)) : 0;
  // Son işlem-günü değerini tarih sırasıyla bul (hafta sonu da önceki günü alır).
  const seriesAt = (values, date) => {
    let low = 0, high = series.dates.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (series.dates[mid] <= date) low = mid + 1; else high = mid;
    }
    return low > 0 ? values[low - 1] : null;
  };

  // Midas hesabında grafik yalnızca hesaba kaydedilen günlük toplamlardan
  // çizilir: kayıt ilk Midas toplamının alındığı günden başlar ve her gün eklenir.
  // Midas yoksa işlem kayıtlarından modellenen geçmiş kullanılır.
  if (hasMidasTotal && midasSnapshotComplete) recordPortfolioValue(todayInIstanbul(), midasPortfolioTotal);
  const storedValues = valueHistory();
  const chartDates = hasMidasTotal
    ? Object.keys(storedValues).filter((date) => isNum(storedValues[date])).sort()
    : [...series.dates];
  const chartValues = hasMidasTotal
    ? chartDates.map((date) => storedValues[date])
    : [...series.value];
  // Midas hesabında yatırılan para = kayıt başlangıcındaki değer + onaylanan
  // para giriş/çıkışları. Midas yoksa işlem kayıtlarından modellenir.
  const realInvested = real ? new Map(real.dates.map((date, index) => [date, real.invested[index]])) : null;
  const investedValues = chartDates.map((date) => {
    if (realInvested) return realInvested.get(date) ?? null;
    const invested = seriesAt(series.invested, date);
    return isNum(invested) ? invested + untrackedPrincipal
      : hasMidasTotal ? untrackedPrincipal || null : null;
  });
  const chartStartDate = chartDates[0];
  const chartEndDate = chartDates.at(-1);

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
        ? `Toplam değer ${chartStartDate ? fmtDate(chartStartDate) : 'bugün'} tarihinden itibaren her gün kaydedilir · yatırılan para = başlangıç değeri + onayladığın para giriş/çıkışları${missingCryptoSnapshot ? ' · kripto hariç' : ''}`
        : 'Geçmiş alım/satım kayıtlarına göre modellenir.')),
    rangeSelector(rangeKey, (r) => {
      rangeKey = r.key;
      drawChart();
    }, RANGES.map((range) => range.key === 'all'
      ? { ...range, label: 'Başlangıç', title: 'Yatırım başlangıcından itibaren' } : range)));

  // Kayıtlı günler: Midas'ta görülen geçmiş gün toplamları elle eklenip düzeltilebilir.
  const historyEditor = () => {
    const stored = valueHistory();
    const dateInput = h('input', { type: 'date', max: todayInIstanbul() });
    const valueInput = h('input', { type: 'number', step: 'any', min: '0', placeholder: 'Toplam ₺ (kripto dahil)' });
    const rows = Object.keys(stored).sort().reverse().map((date) => h('tr', {},
      h('td', { style: 'text-align:left' }, fmtDate(date)),
      h('td', {}, tl(stored[date])),
      h('td', {}, h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => { removePortfolioValue(date); ctx.refresh(); },
      }, 'Sil'))));
    return h('details', { style: 'margin-top:10px' },
      h('summary', { style: 'cursor:pointer;font-size:.85rem' }, `Kayıtlı günler (${rows.length}) · geçmiş gün ekle / düzelt`),
      h('p', { class: 'dim', style: 'margin:8px 0;font-size:.8rem' },
        'Midas’ta gördüğün bir günün toplam değerini (yatırım + kripto) gir. Aynı gün varsa üzerine yazılır; hafta sonu tarihi Cuma’ya kaydedilir.'),
      h('div', { class: 'btn-row', style: 'align-items:center' }, dateInput, valueInput,
        h('button', {
          class: 'btn btn-primary btn-sm', type: 'button',
          onclick: () => {
            const saved = setPortfolioValue(dateInput.value, valueInput.value);
            if (!saved) { toast('Tarih ve 0’dan büyük bir tutar gir'); return; }
            toast(`${fmtDate(saved)} değeri kaydedildi`);
            ctx.refresh();
          },
        }, 'Kaydet')),
      rows.length ? h('div', { class: 'table-wrap', style: 'max-width:420px;margin-top:8px' }, h('table', {},
        h('tbody', {}, rows))) : null);
  };

  if (chartDates.length || hasMidasTotal) {
    root.append(h('section', { class: 'card sec-lite sec-blue' }, head, chartBox, hasMidasTotal ? historyEditor() : null));
    drawChart();
  }

  /* ---------------------------------------------------------------- pozisyonlar */

  if (displayPositions.length) {
    const groupTitles = { ETF: 'ETF’ler', Fon: 'Fonlar', Hisse: 'Hisseler', Kripto: 'Kripto', Diğer: 'Diğer Varlıklar' };
    const positionGroups = groupAssetRows(displayPositions).map((group) => ({
      ...group,
      rows: [...group.rows].sort((a, b) => (b.allocationPct ?? -1) - (a.allocationPct ?? -1)),
      groupValue: group.rows.reduce((sum, row) => sum + (row.marketValueTRY || 0), 0),
    })).sort((a, b) => b.groupValue - a.groupValue);
    const share = (value) => (midasPortfolioTotal > 0 ? value / midasPortfolioTotal * 100 : null);
    const groupCard = (group, sub, ...children) => toneCard({
      ...(SECTION_TONES[group.label] || SECTION_TONES.Diğer),
      title: groupTitles[group.label] || group.label, sub,
      badge: positionSnapshotConsistent ? plBadge(group.rows) : null,
      figure: tl(group.groupValue),
      figureSub: isNum(share(group.groupValue)) ? `portföyün ${pct(share(group.groupValue), 1)}` : `${group.rows.length} varlık`,
    }, ...children);
    // Quant "kategori liderleri" düzeni: her varlık bir kutucuk; fonlar türe göre (PPF'ler yan yana).
    for (const group of positionGroups) {
      root.append(groupCard(group, null,
        ...groupTiles(group, { share, valuesOk: positionSnapshotConsistent })));
    }
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
  const yearlyRealizedTotal = nakit.realizedByYear.reduce((sum, year) => sum + year.amount, 0);
  const realizedDifference = Math.round((totals.realized - yearlyRealizedTotal) * 100) / 100;
  if (nakit.realizedByYear.length && Math.abs(realizedDifference) > 0.01) {
    root.append(h('div', { class: 'notice warn' },
      `Gerçekleşen K/Z kartı ile yıllık tablonun toplamı ${tlSigned(realizedDifference)} farklı. `
      + 'İşlem tarihi, adet ve fiyat kayıtlarını kontrol et.'));
  }
  let nakitSection = null;
  if (nakit.monthly.length > 1) {
    const kutu = h('div');
    const sonAylar = nakit.monthly.slice(-18);
    nakitSection = toneCard({
      tone: 'indigo', icon: '⇅', title: 'Aylık Yatırım Akışı',
      sub: `Son ${sonAylar.length} ay · pozitif = para koydun, negatif = çektin`,
      figure: tlSigned(sonAylar.reduce((sum, m) => sum + m.amount, 0)), figureSub: 'dönem toplamı',
    }, kutu);
    barChart(kutu, {
      items: sonAylar.map((m) => ({ label: m.month.slice(2), value: m.amount })),
      format: (v) => tlSigned(v),
      labelWidth: 52,
    });
  }
  if (nakitSection) root.append(h('div', { class: 'grid grid-2' }, stopajSection, nakitSection));
  else root.append(stopajSection);

  if (nakit.realizedByYear.length) {
    // Her yıl ayrı kutucuk: üst çizgi kâr/zarar rengini taşır.
    root.append(toneCard({
      tone: 'slate', icon: '∑', title: 'Yıllara Göre Gerçekleşen Kâr/Zarar',
      sub: 'Yalnızca satılan pozisyonlardan; açık pozisyonlar dahil değil',
      figure: tlSigned(yearlyRealizedTotal), figureSub: 'toplam',
    }, h('div', { class: 'year-tiles' }, nakit.realizedByYear.map((y) => h('div', { class: `year-tile ${cls(y.amount)}` },
      h('span', {}, String(y.year)),
      h('strong', { class: cls(y.amount) }, tlSigned(y.amount)))))));
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

  const oversold = analysis.holdings.filter((x) => x.oversold);
  if (oversold.length) {
    root.append(h('div', { class: 'notice warn' },
      `Dikkat: ${oversold.map((x) => x.code).join(', ')} satış adetleri kayıtlı alışları aşıyor. `
      + 'Eşleşmeyen fazla adetlerin kâr/zararı hesaplanmadı; eksik alış kaydını veya satış miktarını İşlemler sekmesinden kontrol et.'));
  }

  return root;
}
