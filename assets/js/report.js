/* Aylık portföy raporu: tüm rakamlar burada hesaplanır, görünüm views/rapor.js'te.

   Kaynaklar: hesaba kaydedilen günlük toplamlar (valueHistory), onaylanan para
   giriş/çıkışları, temettüler, ay sonu pozisyon fotoğrafları (monthlySnapshots)
   ve sitenin kıyaslama serileri (BIST100, altın, dolar, S&P 500, PPF, TÜFE). */

import { DB, indexForDate } from './data.js';
import { realReturn } from './insights.js';
import { fundStopajRate, FROZEN_FUND_CODES } from './asset-groups.js';

export const FIRST_REPORT_MONTH = '2026-11';

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const monthLabel = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** Kıyaslama sırası ve adları; TÜFE reel getiri için ayrıca kullanılır. */
export const BENCHMARK_ORDER = [
  ['BIST100', 'BIST 100'],
  ['SP500TL', 'S&P 500 (TL)'],
  ['GRAMALTIN', 'Gram Altın'],
  ['USDTRY', 'Dolar/TL'],
  ['PARAPIYASASI', 'PPF Ortalaması'],
  ['TUFE', 'Enflasyon (TÜFE)'],
];

const previousMonth = (month) => {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
};

/** Raporu hazırlanabilecek aylar: ilk rapor ayından itibaren kayıt olan aylar. */
export function reportMonths(history, snapshots) {
  const months = new Set([
    ...Object.keys(history || {}).map((date) => date.slice(0, 7)),
    ...Object.keys(snapshots || {}),
  ]);
  return [...months].filter((month) => month >= FIRST_REPORT_MONTH).sort().reverse();
}

/** İki tarih arasında kıyaslama serisinin getirisi (%); veri yoksa null. */
function benchmarkReturn(key, fromDate, toDate) {
  const values = DB.benchmarks?.[key]?.values || [];
  const at = (date) => {
    for (let i = indexForDate(date); i >= 0; i -= 1) if (values[i] > 0) return values[i];
    return null;
  };
  const start = at(fromDate);
  const end = at(toDate);
  return start > 0 && end > 0 ? (end / start - 1) * 100 : null;
}

/** Kıyaslama serisini başlangıç tarihinde 100 olacak şekilde günlere göre verir. */
function benchmarkIndex(key, dates) {
  const values = DB.benchmarks?.[key]?.values || [];
  const raw = dates.map((date) => {
    for (let i = indexForDate(date); i >= 0; i -= 1) if (values[i] > 0) return values[i];
    return null;
  });
  const base = raw.find((value) => value > 0);
  return raw.map((value) => (base && value > 0 ? value / base * 100 : null));
}

const realOf = (nominal, inflation) => (Number.isFinite(nominal) && Number.isFinite(inflation)
  ? ((1 + nominal / 100) / (1 + inflation / 100) - 1) * 100 : null);

/** Belirli bir dönem için portföyün zaman ağırlıklı getirisi ve değer köprüsü. */
function periodReturn(history, flows, dividends, fromDate, toDate) {
  const dates = Object.keys(history).filter((date) => date >= fromDate && date <= toDate).sort();
  if (dates.length < 2) return null;
  const subset = Object.fromEntries(dates.map((date) => [date, history[date]]));
  const real = realReturn(subset, flows);
  const startDate = dates[0];
  const endDate = dates.at(-1);
  const inPeriod = (item) => item.date > startDate && item.date <= endDate;
  const deposits = flows.filter((flow) => inPeriod(flow) && flow.amount > 0).reduce((sum, flow) => sum + flow.amount, 0);
  const withdrawals = flows.filter((flow) => inPeriod(flow) && flow.amount < 0).reduce((sum, flow) => sum - flow.amount, 0);
  const dividendTotal = dividends.filter(inPeriod).reduce((sum, item) => sum + item.amount, 0);
  const startValue = history[startDate];
  const endValue = history[endDate];
  return {
    startDate, endDate, startValue, endValue,
    twr: real?.twr ?? null,
    deposits, withdrawals, dividends: dividendTotal,
    market: endValue - startValue - deposits + withdrawals - dividendTotal,
    dates, real,
  };
}

/** Kayıtlı günlerden para giriş/çıkışından arındırılmış endeks (başlangıç 100) ve en büyük düşüş. */
function portfolioIndex(history, flows, dates) {
  let level = 100;
  let peak = 100;
  let maxDrawdown = 0;
  const index = dates.map((date, i) => {
    if (i > 0) {
      const flow = flows.filter((item) => item.date > dates[i - 1] && item.date <= date)
        .reduce((sum, item) => sum + item.amount, 0);
      const previous = history[dates[i - 1]];
      if (previous > 0) level *= (history[date] - flow) / previous;
    }
    peak = Math.max(peak, level);
    maxDrawdown = Math.min(maxDrawdown, (level / peak - 1) * 100);
    return level;
  });
  return { index, maxDrawdown };
}

/**
 * Ayın raporunu hesaplar.
 * input: { month, history, flows, dividends, snapshots, transactions }
 */
export function buildMonthlyReport({ month, history = {}, flows = [], dividends = [], snapshots = {}, transactions = [] }) {
  const monthDates = Object.keys(history).filter((date) => date.startsWith(month)).sort();
  const priorDates = Object.keys(history).filter((date) => date < `${month}-01`).sort();
  // Dönem, önceki ayın son kayıtlı gününden (ay başı değeri) bu ayın son gününe kadardır.
  const fromDate = priorDates.at(-1) || monthDates[0];
  const toDate = monthDates.at(-1);
  const firstDate = Object.keys(history).sort()[0];
  const yearStart = Object.keys(history).filter((date) => date < `${month.slice(0, 4)}-01-01`).sort().at(-1) || firstDate;
  // Ay bitti mi? (İstanbul saatine göre bugünün ayı rapor ayından sonraysa.)
  const currentMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit' })
    .format(new Date()).slice(0, 7);
  const complete = month < currentMonth;

  const periods = {
    month: fromDate && toDate ? periodReturn(history, flows, dividends, fromDate, toDate) : null,
    ytd: yearStart && toDate ? periodReturn(history, flows, dividends, yearStart, toDate) : null,
    inception: firstDate && toDate ? periodReturn(history, flows, dividends, firstDate, toDate) : null,
  };

  const comparison = BENCHMARK_ORDER.map(([key, label]) => {
    const row = { key, label };
    for (const [name, period] of Object.entries(periods)) {
      row[name] = period ? benchmarkReturn(key, period.startDate, period.endDate) : null;
    }
    return row;
  }).filter((row) => DB.benchmarks?.[row.key]);
  const inflation = comparison.find((row) => row.key === 'TUFE') || {};
  const portfolioRow = {
    key: 'PORTFOY', label: 'Portföyüm',
    month: periods.month?.twr ?? null, ytd: periods.ytd?.twr ?? null, inception: periods.inception?.twr ?? null,
  };
  const comparisonRows = [portfolioRow, ...comparison].map((row) => ({
    ...row,
    realMonth: row.key === 'TUFE' ? null : realOf(row.month, inflation.month),
    realYtd: row.key === 'TUFE' ? null : realOf(row.ytd, inflation.ytd),
    realInception: row.key === 'TUFE' ? null : realOf(row.inception, inflation.inception),
  }));

  // Grafik: dönem içi günler, portföy ve kıyaslamalar 100'den başlar.
  const chartDates = periods.month?.dates || [];
  const portfolio = portfolioIndex(history, flows, chartDates);
  const chartSeries = [
    { key: 'PORTFOY', label: 'Portföyüm', values: portfolio.index },
    ...comparison.filter((row) => row.key !== 'TUFE').map((row) => ({
      key: row.key, label: row.label, values: benchmarkIndex(row.key, chartDates),
    })),
  ];

  // Pozisyonlar: ay sonu fotoğrafı ve önceki ay sonu fotoğrafı.
  const end = snapshots[month] || null;
  const start = snapshots[previousMonth(month)] || null;
  const startByCode = new Map((start?.rows || []).map((row) => [row.code, row]));
  const endTotal = end?.total || periods.month?.endValue || 0;
  const positions = (end?.rows || []).map((row) => {
    const before = startByCode.get(row.code);
    const monthPct = !row.frozen && before?.unitTRY > 0 && row.unitTRY > 0 ? (row.unitTRY / before.unitTRY - 1) * 100 : null;
    // Katkı: ay başında tutulan adetin fiyat değişimi (ay içi alım/satımlar hariç, yaklaşık).
    const heldUnits = before ? Math.min(before.units || 0, row.units || 0) : 0;
    const contribution = row.frozen ? 0
      : before?.unitTRY > 0 && row.unitTRY > 0 ? heldUnits * (row.unitTRY - before.unitTRY) : null;
    return {
      ...row,
      weight: endTotal > 0 ? row.value / endTotal * 100 : null,
      startWeight: start?.total > 0 && before ? before.value / start.total * 100 : null,
      monthPct, contribution,
    };
  }).sort((a, b) => b.value - a.value);
  const cash = end?.cash || 0;

  const groups = new Map();
  for (const row of positions) {
    const key = row.group === 'Fon' ? `Fon · ${String(row.label || 'Diğer').split(' · ')[0]}` : row.group;
    groups.set(key, (groups.get(key) || 0) + row.value);
  }
  if (cash > 0.5) groups.set('Nakit', cash);
  const startGroups = new Map();
  for (const row of start?.rows || []) {
    const key = row.group === 'Fon' ? `Fon · ${String(row.label || 'Diğer').split(' · ')[0]}` : row.group;
    startGroups.set(key, (startGroups.get(key) || 0) + row.value);
  }
  if (start?.cash > 0.5) startGroups.set('Nakit', start.cash);
  const allocation = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({
    label, value,
    weight: endTotal > 0 ? value / endTotal * 100 : null,
    startWeight: start?.total > 0 && startGroups.has(label) ? startGroups.get(label) / start.total * 100 : null,
  }));

  const ranked = positions.filter((row) => Number.isFinite(row.contribution) && !row.frozen);
  const winners = [...ranked].sort((a, b) => b.contribution - a.contribution).filter((row) => row.contribution > 0).slice(0, 3);
  const losers = [...ranked].sort((a, b) => a.contribution - b.contribution).filter((row) => row.contribution < 0).slice(0, 3);

  // Ayın hareketleri.
  const monthTransactions = transactions.filter((tx) => String(tx.date || '').startsWith(month))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const monthFlows = flows.filter((flow) => flow.date.startsWith(month) && flow.amount);
  const monthDividends = dividends.filter((item) => item.date.startsWith(month));
  const fees = monthTransactions.reduce((sum, tx) => sum + (Number(tx.fee) || 0), 0);

  // Risk ve yoğunlaşma.
  const weights = positions.map((row) => row.weight || 0).sort((a, b) => b - a);
  const largest = positions[0] || null;
  const risk = {
    maxDrawdown: chartDates.length > 1 ? portfolio.maxDrawdown : null,
    largestCode: largest?.code || null,
    largestWeight: largest?.weight ?? null,
    top3Weight: weights.slice(0, 3).reduce((sum, value) => sum + value, 0),
    positionCount: positions.length,
  };

  // Tahmini stopaj (fon kârı üzerinden; temerrüt fonları hariç).
  const stopaj = positions.filter((row) => row.group === 'Fon' && !FROZEN_FUND_CODES.has(row.code) && row.totalPLTRY > 0)
    .map((row) => {
      const { rate } = fundStopajRate(row.code, '', toDate || `${month}-28`);
      return { code: row.code, profit: row.totalPLTRY, rate, amount: row.totalPLTRY * rate };
    });

  // Kurallara göre özet cümleler.
  const insights = [];
  const m = periods.month;
  const fmt = (value) => `${value >= 0 ? '+' : '−'}%${Math.abs(value).toLocaleString('tr-TR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const pts = (value) => `${Math.abs(value).toLocaleString('tr-TR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} puan`;
  if (Number.isFinite(m?.twr)) {
    insights.push(`Portföy bu ay para giriş/çıkışları hariç ${fmt(m.twr)} getiri sağladı.`);
    for (const row of comparison) {
      if (!Number.isFinite(row.month) || row.key === 'TUFE') continue;
      if (['BIST100', 'SP500TL', 'PARAPIYASASI'].includes(row.key)) {
        const diff = m.twr - row.month;
        insights.push(`${row.label} ${fmt(row.month)}; portföy ${pts(diff)} ${diff >= 0 ? 'önde' : 'geride'}.`);
      }
    }
    if (Number.isFinite(inflation.month)) {
      const realMonth = realOf(m.twr, inflation.month);
      insights.push(`Enflasyon (TÜFE) dönemde ${fmt(inflation.month)}; reel getiri ${fmt(realMonth)}.`);
    }
  }
  if (risk.largestWeight > 40) {
    insights.push(`Tek varlığın (${risk.largestCode}) portföydeki payı %${Math.round(risk.largestWeight)}; yoğunlaşma yüksek.`);
  }
  if (winners[0]) insights.push(`Ayın en çok kazandıranı ${winners[0].code}, en çok kaybettireni ${losers[0]?.code || '—'}.`);

  return {
    month, label: monthLabel(month), complete,
    fromDate, toDate, firstDate,
    periods, comparisonRows, chart: { dates: chartDates, series: chartSeries },
    positions, cash, endTotal, allocation, winners, losers,
    monthTransactions, monthFlows, monthDividends, fees,
    risk, stopaj, stopajTotal: stopaj.reduce((sum, row) => sum + row.amount, 0),
    insights,
    frozenCodes: positions.filter((row) => row.frozen).map((row) => row.code),
    hasSnapshot: Boolean(end), hasStartSnapshot: Boolean(start),
  };
}
