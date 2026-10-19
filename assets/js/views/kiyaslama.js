/* Kıyaslama: portföyün getirisini BIST 100, gram altın, dolar ve enflasyonla karşılaştırır. */

import { h, tl, tlSigned, pctSigned, num, cls, isNum, colorAt, fmtDate } from '../util.js';
import { counterfactual } from '../insights.js';
import { transactions, valueHistory, cashflows } from '../store.js';
import { DB, indexForDate } from '../data.js';
import { lineChart } from '../charts.js';
import { sliceLastDays } from '../portfolio.js';
import { sectionCard, emptyState, rangeSelector, RANGES, tonedSection } from './common.js';

const BENCH_STYLES = {
  BIST100: { color: 'var(--c2)' },
  GRAMALTIN: { color: 'var(--c3)' },
  USDTRY: { color: 'var(--c4)' },
  TUFE: { color: 'var(--c6)' },
  PARAPIYASASI: { color: 'var(--c5)' },
  SP500TL: { color: 'var(--c1)' },
};

const benchStyle = (key) => BENCH_STYLES[key] || { color: colorAt(Object.keys(BENCH_STYLES).length) };
const benchLineStyle = (key) => {
  const style = benchStyle(key);
  return `width:18px;height:3px;border-radius:2px;background:${style.color};display:inline-block`;
};

/** Seriyi ilk geçerli değerine göre 100'e normalize eder. */
function normalize(values) {
  const base = values.find((v) => isNum(v) && v > 0);
  if (!isNum(base)) return values.map(() => null);
  return values.map((v) => (isNum(v) && v > 0 ? (v / base) * 100 : null));
}

function totalReturn(values) {
  const clean = values.filter((v) => isNum(v) && v > 0);
  if (clean.length < 2) return null;
  return (clean[clean.length - 1] / clean[0] - 1) * 100;
}

export function renderKiyaslama(ctx) {
  const { analysis, navigate } = ctx;
  const { series } = analysis;

  if (!series.dates.length) {
    return emptyState('Kıyaslama için işlem geçmişi gerekiyor',
      'En az bir alım işlemi girdiğinde portföyünün getirisi endekslerle karşılaştırılır.',
      'İşlem ekle', () => navigate('islemler'));
  }

  const root = h('div', { class: 'stack' });
  const available = Object.keys(DB.benchmarks || {});
  const selected = new Set(available);

  /* --------------------------------------------------------- grafik ve kontroller */

  // Portföy çizgisi, gerçek değerlerin siteye girilmeye başladığı günden (ilk kayıt,
  // 16.10.2026) itibaren kaydedilen günlük toplamlardan çizilir; para yatırma/çekme
  // getiri sayılmaz (zaman ağırlıklı). İşlem kayıtlarından modellenen eski seri kullanılmaz.
  const history = valueHistory();
  const flows = cashflows();
  const historyDates = Object.keys(history).filter((date) => Number(history[date]) > 0).sort();
  const firstRecord = historyDates[0] || null;
  const levels = new Map();
  {
    let level = 100;
    historyDates.forEach((date, i) => {
      if (i > 0) {
        const flow = flows.filter((item) => item.date > historyDates[i - 1] && item.date <= date)
          .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
        const previous = history[historyDates[i - 1]];
        if (previous > 0) level *= (history[date] - flow) / previous;
      }
      levels.set(date, level);
    });
  }
  const levelAt = (date) => {
    let found = null;
    for (const d of historyDates) { if (d > date) break; found = levels.get(d); }
    return found;
  };

  const calendar = DB.calendar || [];
  const lastDate = [calendar.at(-1), historyDates.at(-1)].filter(Boolean).sort().at(-1);
  const minusDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const RANGE_LIST = [
    { key: '1a', label: '1A', days: 30 },
    { key: '3a', label: '3A', days: 90 },
    { key: '6a', label: '6A', days: 180 },
    { key: '1y', label: '1Y', days: 365 },
    { key: '2y', label: '2Y', days: 730 },
    { key: '3y', label: '3Y', days: 1095 },
    { key: '5y', label: '5Y', days: 1825 },
    { key: 'bas', label: 'Başından', title: `Portföye para girildiğinden itibaren${firstRecord ? ` (${fmtDate(firstRecord)})` : ''}` },
  ];
  const rangeStart = (range) => (range.key === 'bas' ? firstRecord || calendar[0] : minusDays(lastDate, range.days));

  /** Aralıktaki tarihler: TEFAS takvimi + takvimden sonraki kayıtlı günler. */
  const datesFrom = (start) => [...new Set([
    ...calendar.filter((date) => date >= start),
    ...historyDates.filter((date) => date >= start),
  ])].sort();

  /** Kıyas serisinin bir tarihteki değeri (takvim dışındaki günlerde değer yok). */
  const benchAt = (key, date) => {
    const index = DB.indexOf?.get(date);
    const value = index == null ? null : DB.benchmarks[key]?.values?.[index];
    return value > 0 ? value : null;
  };
  const benchBefore = (key, date) => {
    const values = DB.benchmarks[key]?.values || [];
    for (let i = indexForDate(date); i >= 0; i -= 1) if (values[i] > 0) return values[i];
    return null;
  };

  let rangeKey = 'bas';
  const chartBox = h('div', { class: 'chart' });
  const chartNote = h('p', { class: 'dim', style: 'margin:6px 0 0;font-size:.78rem' });

  const draw = () => {
    const range = RANGE_LIST.find((r) => r.key === rangeKey) || RANGE_LIST.at(-1);
    const start = rangeStart(range);
    const dates = datesFrom(start);
    // Portföy ilk kayıt gününde 100'den başlar; kıyaslar aralığın başında 100'dür.
    const portBase = firstRecord ? levelAt(dates.find((d) => d >= firstRecord) || firstRecord) : null;
    const lines = [{
      name: 'Portföyüm',
      values: dates.map((date) => (firstRecord && date >= firstRecord && portBase ? levelAt(date) / portBase * 100 : null)),
      color: 'var(--accent)',
      width: 2.6,
    }];
    for (const key of available) {
      if (!selected.has(key)) continue;
      const base = benchBefore(key, dates[0]);
      lines.push({
        name: DB.benchmarks[key].label,
        values: dates.map((date) => { const v = benchAt(key, date); return base && v ? v / base * 100 : null; }),
        ...benchStyle(key),
        width: 1.6,
      });
    }
    const plotted = lines.flatMap((line) => line.values).filter(isNum);
    const ySpread = plotted.length ? Math.max(...plotted, 100) - Math.min(...plotted, 100) : 0;
    const yDigits = ySpread < 4 ? 2 : ySpread < 20 ? 1 : 0;
    const spanDays = dates.length ? (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86400000 : 0;
    lineChart(chartBox, {
      dates,
      series: lines,
      height: 300,
      baseline: 100,
      xFormat: spanDays <= 200 ? (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}` : undefined,
      // Dar aralıkta (ör. birkaç gün) eksen etiketleri tekrarlanmasın diye ondalık gösterilir.
      yFormat: (v) => num(v, yDigits),
      valueFormat: (v) => `${num(v, 1)} (${pctSigned(v - 100, 1)})`,
    });
    const dataStart = calendar[0];
    chartNote.textContent = [
      firstRecord && range.key !== 'bas' && firstRecord > start
        ? `Portföy çizgisi ${fmtDate(firstRecord)} tarihinde 100'den başlar; kıyaslar aralığın başında 100'dür.` : '',
      range.key !== 'bas' && dataStart && start < dataStart
        ? `Kıyas verisi ${fmtDate(dataStart)} tarihinden başlıyor.` : '',
    ].filter(Boolean).join(' ');
  };

  const toggles = h('div', { class: 'btn-row' },
    available.map((key) => h('button', {
      class: 'btn btn-sm', type: 'button', 'aria-pressed': 'true',
      style: `border-color:${benchStyle(key).color}`,
      onclick: (e) => {
        const on = selected.has(key);
        if (on) selected.delete(key); else selected.add(key);
        e.currentTarget.setAttribute('aria-pressed', String(!on));
        e.currentTarget.style.opacity = on ? '.45' : '1';
        draw();
      },
    },
    h('span', {
      class: 'swatch',
      style: benchLineStyle(key),
    }),
    DB.benchmarks[key].label)));

  const head = h('div', { class: 'card-head' },
    h('div', {},
      h('h2', {}, 'Getiri Kıyaslaması'),
      h('span', { class: 'sub' }, `Portföy ${firstRecord ? `${fmtDate(firstRecord)}’den` : 'ilk kayıttan'} itibaren kayıtlı günlük değerlerden · para giriş/çıkışı hariç · TÜFE aylık basamaklı`)),
    rangeSelector(rangeKey, (r) => {
      rangeKey = r.key;
      draw();
    }, RANGE_LIST));

  root.append(h('section', { class: 'card sec-lite sec-blue' }, head, toggles, chartBox, chartNote));
  draw();

  /* ------------------------------------------------------------------- tablo */

  // Portföy getirisi yalnızca aralığın tamamı kayıtlıysa yazılır; "Başından" ilk kayıttan bugüne.
  const portfolioReturn = (range) => {
    if (!firstRecord) return null;
    const start = rangeStart(range);
    if (range.key !== 'bas' && start < firstRecord) return null;
    const from = levelAt(start);
    const to = levelAt(historyDates.at(-1));
    return from > 0 && to > 0 && historyDates.length > 1 ? (to / from - 1) * 100 : null;
  };
  const benchReturn = (key, range) => {
    const start = rangeStart(range);
    if (range.key !== 'bas' && calendar[0] && start < calendar[0]) return null;
    const from = benchBefore(key, start);
    const to = benchBefore(key, lastDate);
    return from > 0 && to > 0 ? (to / from - 1) * 100 : null;
  };
  const rows = [
    { label: 'Portföyüm', color: 'var(--accent)', cells: RANGE_LIST.map(portfolioReturn) },
    ...available.map((key) => ({
      label: DB.benchmarks[key].label, color: benchStyle(key).color,
      cells: RANGE_LIST.map((range) => benchReturn(key, range)),
    })),
  ];

  const table = h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { style: 'text-align:left' }, ''),
      RANGE_LIST.map((r) => h('th', { title: r.title || null }, r.label)))),
    h('tbody', {}, rows.map((row) => h('tr', {},
      h('td', {},
        h('span', {
          class: 'swatch',
          style: `width:9px;height:9px;border-radius:3px;background:${row.color};display:inline-block;margin-right:7px`,
        }),
        row.label),
      row.cells.map((v) => h('td', { class: cls(v) }, isNum(v) ? pctSigned(v, 1) : '—')))))));

  root.append(tonedSection('blue', '⇄', 'Dönemsel Getiriler',
    `Portföy satırı zaman ağırlıklı · kayıt ${firstRecord ? fmtDate(firstRecord) : '—'} tarihinde başladığı için daha uzun aralıklar “—” · Başından = ilk kayıttan bugüne`, table));

  /* --------------------------------------------------- karşı-olgusal senaryo */

  const txs = ctx.analysisTransactions || transactions();
  const senaryolar = [];
  for (const key of available) {
    // TÜFE bir yatırım aracı değildir; getiri karşılaştırmasında alım gücü
    // eşiği olarak kalır, yatırım senaryosu gibi sunulmaz.
    if (key === 'TUFE') continue;
    const seri = DB.benchmarks[key]?.values || [];
    const sonuc = counterfactual(txs, seri);
    if (sonuc) senaryolar.push({ key, label: DB.benchmarks[key].label, ...sonuc });
  }

  if (senaryolar.length && analysis.totals.value > 0) {
    const gercek = {
      label: 'Portföyüm (gerçek)',
      value: analysis.totals.value,
      invested: analysis.totals.netInvested,
      gain: analysis.totals.totalPL,
      gainPct: analysis.totals.totalPct,
    };
    const satirlar = [gercek, ...senaryolar.sort((a, b) => b.value - a.value)];
    const enIyi = Math.max(...satirlar.map((x) => x.value));

    root.append(tonedSection('teal', '↗', 'Aynı Parayı Başka Yere Koysaydım',
      'Senin gerçek yatırım tarihlerin ve tutarlarınla',
      h('p', { class: 'dim', style: 'margin:0 0 12px;font-size:.85rem' },
        'Her satır, tam olarak senin yaptığın tarihlerde ve tutarlarda o varlığı '
        + 'almış olsaydın bugün elinde ne olacağını gösterir. Nakit akışları aynı '
        + 'olduğu için doğrudan karşılaştırılabilir.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { style: 'text-align:left' }, 'Senaryo'),
          h('th', {}, 'Bugünkü değer'), h('th', {}, 'Kazanç'), h('th', {}, 'Getiri'),
          h('th', {}, 'Fark'))),
        h('tbody', {}, satirlar.map((x, i) => h('tr', {
          style: i === 0 ? 'font-weight:650;background:var(--accent-soft)' : null,
        },
        h('td', {},
          h('span', {
            class: 'swatch',
            style: 'width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:7px;'
              + `background:${i === 0 ? 'var(--accent)' : benchStyle(x.key).color}`,
          }),
          x.label),
        h('td', {}, tl(x.value)),
        h('td', { class: cls(x.gain) }, tlSigned(x.gain)),
        h('td', { class: cls(x.gainPct) }, pctSigned(x.gainPct, 1)),
        h('td', { class: cls(x.value - enIyi) },
          x.value === enIyi ? '—' : tlSigned(x.value - enIyi)))))))));
  }

  /* ----------------------------------------------------------------- açıklama */

  root.append(h('div', { class: 'notice' },
    h('div', {}, h('b', {}, 'Neden iki farklı getiri var?')),
    h('div', { style: 'margin-top:5px' },
      'Buradaki portföy getirisi ', h('b', {}, 'zaman ağırlıklıdır'),
      ': ne zaman para eklediğinden bağımsız olarak fon seçimlerinin performansını ölçer, '
      + 'bu yüzden endekslerle adil kıyaslanır. Panel sekmesindeki ',
      h('b', {}, 'XIRR'),
      ' ise para ağırlıklıdır: paranın ne zaman girdiğini de hesaba katar, yani cebindeki '
      + 'gerçek yıllık getiriyi verir.'),
    !available.includes('TUFE')
      ? h('div', { style: 'margin-top:8px' },
        'TÜFE verisi şu an yüklenemedi. EVDS API anahtarını ve veri güncelleme çıktısını kontrol et.')
      : h('div', { style: 'margin-top:8px' },
        'TÜFE yatırım aracı değil, alım gücü ölçütüdür. Aylık endeks yayın gününde güncellenir; değerler dönem başında 100’e eşitlenerek portföyün nominal zaman ağırlıklı getirisiyle karşılaştırılır.')));

  return root;
}
