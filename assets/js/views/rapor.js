/* Rapor: aylık portföy raporu - TEFAS Quant rapor düzeni (2 sayfa A4, PDF olarak kaydedilebilir).
   Sayfa 1: getiri, kıyaslama ve değer köprüsü. Sayfa 2: dağılım, pozisyonlar, risk ve notlar. */

import { h, tl, tlSigned, pct, pctSigned, units as fmtUnits, cls, isNum, fmtDate, colorAt } from '../util.js';
import { lineChart } from '../charts.js';
import { valueHistory, cashflows, dividends, monthlySnapshots, transactions } from '../store.js';
import { buildMonthlyReport, reportMonths, monthLabel, FIRST_REPORT_MONTH } from '../report.js';
import { sectionCard, tonedSection } from './common.js';

const LINE_COLORS = {
  PORTFOY: '#1f5fbf', BIST100: 'var(--c2)', SP500TL: 'var(--c3)', GRAMALTIN: 'var(--c7)',
  USDTRY: 'var(--c4)', PARAPIYASASI: 'var(--c5)',
};
const PAGE_COUNT = 2;

const currentMonth = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit',
}).format(new Date()).slice(0, 7);

const tone = (value) => (value > 0 ? 'up' : value < 0 ? 'down' : '');
const pctText = (value, digits = 2) => (isNum(value) ? pctSigned(value, digits) : '—');
const pctCell = (value) => h('td', { class: `r ${tone(value)}` }, pctText(value));
const empty = (text) => h('div', { class: 'rp-empty' }, text);

function block(title, dot, ...children) {
  return h('section', { class: 'rp-block' },
    h('h3', {}, h('span', { class: `rp-dot ${dot || ''}` }), title), ...children);
}

function kpi(label, value, sub, valueTone) {
  return h('div', { class: valueTone || '' },
    h('span', {}, label), h('b', {}, value), sub ? h('em', {}, sub) : null);
}

/** Ortadan iki yöne çubuk listesi (Quant "kategorilere göre net akış" düzeni). */
function divergingRows(rows, format) {
  const max = Math.max(1e-9, ...rows.filter((row) => !row.total).map((row) => Math.abs(row.value || 0)));
  return h('div', { class: 'rp-cats' }, rows.map((row) => h('div', { class: `rp-cat${row.main ? ' main' : ''}${row.total ? ' total' : ''}` },
    h('span', { class: 'rp-cat-name' }, row.label),
    row.total ? h('span', {}) : h('span', { class: 'rp-cat-track' }, h('span', { class: 'rp-cat-mid' }),
      isNum(row.value) && Math.abs(row.value) > 1e-9
        ? h('i', { class: row.value >= 0 ? 'up' : 'down', style: `width:${(Math.abs(row.value) / max * 50).toFixed(1)}%` })
        : null),
    h('span', { class: `rp-cat-val ${row.total ? '' : tone(row.value)}` }, isNum(row.value) ? format(row.value, row) : '—'))));
}

function bar(value, max, barTone) {
  const width = max ? Math.min(100, Math.abs(value) / max * 100) : 0;
  return h('span', { class: `rp-bar ${barTone}` }, h('i', { style: `width:${width.toFixed(1)}%` }));
}

function moversTable(rows, barTone, note) {
  if (!rows.length) return empty(note);
  const max = Math.max(1, ...rows.map((row) => Math.abs(row.contribution || 0)));
  return h('table', { class: 'rp-table' },
    h('thead', {}, h('tr', {}, h('th', { class: 'rk' }, '#'), h('th', {}, 'Varlık'),
      h('th', { class: 'r' }, 'Katkı'), h('th', { class: 'r' }, 'Ay içi'), h('th', { class: 'bar-col' }, ''))),
    h('tbody', {}, rows.map((row, index) => h('tr', {},
      h('td', { class: 'rk' }, String(index + 1)),
      h('td', {}, h('b', { class: 'mono' }, row.code)),
      h('td', { class: `r ${barTone}` }, tlSigned(row.contribution)),
      h('td', { class: `r ${tone(row.monthPct)}` }, pctText(row.monthPct, 1)),
      h('td', { class: 'bar-col' }, bar(row.contribution, max, barTone))))));
}

function page(report, number, preview, ...children) {
  return h('article', { class: 'rp-page' },
    h('header', { class: 'rp-cover' },
      h('div', { class: 'rp-brand' }, h('img', { src: '/Analiz/iconV1.png', alt: '' }),
        h('div', {}, h('b', {}, 'Analiz'), h('span', {}, 'PORTFÖY RAPORU'))),
      h('span', { class: 'rp-badge' }, preview ? 'ÖNİZLEME' : report.complete ? 'AYLIK RAPOR' : 'ARA RAPOR'),
      h('h1', {}, number === 1 ? `${report.label} Portföy Raporu` : 'Pozisyonlar, Dağılım ve Risk'),
      h('p', { class: 'rp-period' }, report.periodText)),
    ...children,
    h('footer', { class: 'rp-footer' },
      h('span', {}, 'Kaynak: Midas (adet, fiyat), TEFAS (fon fiyatları), Yahoo Finance ve TCMB (kıyaslar). Getiriler zaman ağırlıklıdır; para yatırma/çekme getiri sayılmaz. Yatırım tavsiyesi değildir.'),
      h('span', {}, `Oluşturma ${report.generated} · Sayfa ${number} / ${PAGE_COUNT}`)));
}

function renderReport(report, { preview }) {
  const m = report.periods.month;
  const real = report.comparisonRows[0]?.realMonth;
  const change = m ? m.endValue - m.startValue : null;
  const shortNote = `Bu dönem için en az iki kayıtlı gün gerekiyor (ilk kayıt ${fmtDate(report.firstDate)}). Getiri ve kıyaslar sonraki işlem günlerinde dolacak.`;
  report.generated = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium' }).format(new Date());
  report.periodText = `${m ? `${fmtDate(m.startDate)} – ${fmtDate(m.endDate)}` : report.label} · ${report.risk.positionCount || 0} varlık · ilk kayıt ${fmtDate(report.firstDate)}`;

  /* ------------------------------------------------------------- sayfa 1 */
  const compareRows = report.comparisonRows.filter((row) => row.key !== 'TUFE' || isNum(row.month));
  const chartBox = h('div', { class: 'chart' });
  const bridge = m ? [
    { label: 'Ay başı değeri', value: m.startValue, total: true },
    { label: 'Yatırılan para', value: m.deposits },
    { label: 'Çekilen para', value: -m.withdrawals },
    { label: 'Temettü', value: m.dividends },
    { label: 'Piyasa etkisi', value: m.market },
    { label: 'Ay sonu değeri', value: m.endValue, total: true },
  ] : [];

  const page1 = page(report, 1, preview,
    h('div', { class: 'rp-kpis' },
      kpi('Ay sonu değeri', tl(m?.endValue ?? report.endTotal),
        isNum(change) ? `${tlSigned(change)} değişim` : 'ay başı kaydı bekleniyor'),
      kpi('Aylık getiri', pctText(m?.twr), 'para hareketlerinden arındırılmış', tone(m?.twr)),
      kpi('Reel getiri', pctText(real), 'TÜFE düşülmüş', tone(real)),
      kpi('Net para girişi', m ? tlSigned(m.deposits - m.withdrawals) : '—',
        `temettü ${tl(m?.dividends || 0)}`)),
    block('Bu ayın getirisi: portföy ve kıyaslar', 'brand',
      m ? divergingRows(compareRows.filter((row) => isNum(row.month))
        .map((row) => ({ label: row.label, value: row.month, main: row.key === 'PORTFOY' })), (value) => pctSigned(value, 2))
        : empty(shortNote)),
    block('Dönem tablosu', 'brand',
      h('table', { class: 'rp-table' },
        h('thead', {}, h('tr', {},
          h('th', { style: 'width:30%' }, 'Varlık / endeks'), h('th', { class: 'r' }, 'Bu ay'), h('th', { class: 'r' }, 'Bu ay reel'),
          h('th', { class: 'r' }, 'Yılbaşından'), h('th', { class: 'r' }, 'Başlangıçtan'), h('th', { class: 'r hide-sm' }, 'Başl. reel'))),
        h('tbody', {}, compareRows.map((row) => h('tr', { class: row.key === 'PORTFOY' ? 'main' : '' },
          h('td', {}, row.label), pctCell(row.month), pctCell(row.realMonth), pctCell(row.ytd), pctCell(row.inception),
          h('td', { class: `r hide-sm ${tone(row.realInception)}` }, pctText(row.realInception)))))),
      h('p', { class: 'rp-note' }, `Yılbaşı ve başlangıç sütunları ${fmtDate(report.firstDate)} tarihli ilk kayıttan itibaren hesaplanır. TÜFE son açıklanan aya kadardır.`)),
    block('Dönem içi seyir (başlangıç = 100)', 'brand', m ? chartBox : empty(shortNote)),
    h('div', { class: 'rp-two' },
      block('Değer köprüsü', 'brand',
        m ? divergingRows(bridge, (value, row) => (row.total ? tl(value) : tlSigned(value))) : empty(shortNote)),
      block('Öne çıkanlar', 'brand',
        report.insights.length ? h('ul', { class: 'rp-list' }, report.insights.map((text) => h('li', {}, text)))
          : empty('Ay ilerledikçe öne çıkan gelişmeler burada özetlenir.'))));

  /* ------------------------------------------------------------- sayfa 2 */
  const showStart = report.hasStartSnapshot;
  const moversNote = showStart ? 'Bu ay yok' : 'Varlık bazında katkı, önceki ay sonu pozisyon kaydı oluşunca görünür.';
  const allocTotal = report.allocation.reduce((sum, row) => sum + row.value, 0);
  const valueMax = Math.max(1, ...report.positions.map((row) => row.value || 0));
  const risk = report.risk;

  const page2 = page(report, 2, preview,
    h('div', { class: 'rp-kpis' },
      kpi('En büyük pozisyon', risk.largestCode || '—', isNum(risk.largestWeight) ? `portföyün ${pct(risk.largestWeight, 1)}` : ''),
      kpi('İlk 3 varlık', pct(risk.top3Weight, 1), `${risk.positionCount} varlık içinde`),
      kpi('En büyük düşüş', pctText(risk.maxDrawdown), 'ay içi, zirveden', tone(risk.maxDrawdown)),
      kpi('Tahmini stopaj', tl(report.stopajTotal), 'satışta fon kârından')),
    block('Varlık dağılımı', 'brand',
      report.allocation.length ? h('div', {},
        h('div', { class: 'rp-stack' }, report.allocation.map((row, index) => h('span', {
          style: `flex:${Math.max(0.001, row.value)};background:${colorAt(index)}`, title: row.label,
        }))),
        h('div', { class: 'rp-legend' }, report.allocation.map((row, index) => h('div', {},
          h('i', { style: `background:${colorAt(index)}` }),
          h('span', {}, row.label),
          h('b', {}, allocTotal > 0 ? pct(row.value / allocTotal * 100, 1) : '—'),
          showStart ? h('em', { class: 'dim', style: 'font-style:normal;font-size:8.5px' },
            isNum(row.startWeight) ? `önceki ${pct(row.startWeight, 1)}` : 'yeni') : null))))
        : empty('Ay sonu pozisyon kaydı yok. Ay içinde siteyi bir kez açmak kaydı oluşturur.')),
    h('div', { class: 'rp-two' },
      block('En çok kazandıranlar', 'up', moversTable(report.winners, 'up', moversNote)),
      block('En çok kaybettirenler', 'down', moversTable(report.losers, 'down', moversNote))),
    block('Pozisyonlar', 'brand',
      report.positions.length ? h('table', { class: 'rp-table' },
        h('thead', {}, h('tr', {},
          h('th', { style: 'width:30%' }, 'Varlık'), h('th', { class: 'r hide-sm' }, 'Adet'), h('th', { class: 'r' }, 'Değer'),
          h('th', { class: 'r' }, 'Ağırlık'), h('th', { class: 'r' }, showStart ? 'Ay içi' : 'Toplam K/Z'),
          h('th', { class: 'r hide-sm' }, 'K/Z %'), h('th', { class: 'bar-col' }, ''))),
        h('tbody', {}, report.positions.map((row) => h('tr', {},
          h('td', {}, h('b', { class: 'mono' }, row.code), ' ', h('span', { class: 'nm' }, row.label || '')),
          h('td', { class: 'r hide-sm' }, fmtUnits(row.units)),
          h('td', { class: 'r' }, tl(row.value)),
          h('td', { class: 'r' }, isNum(row.weight) ? pct(row.weight, 1) : '—'),
          showStart
            ? h('td', { class: `r ${tone(row.monthPct)}` }, row.frozen ? 'sabit' : pctText(row.monthPct, 1))
            : h('td', { class: `r ${tone(row.totalPLTRY)}` }, row.frozen ? 'temerrüt' : isNum(row.totalPLTRY) ? tlSigned(row.totalPLTRY) : '—'),
          h('td', { class: `r hide-sm ${tone(row.totalPct)}` }, row.frozen ? '—' : pctText(row.totalPct, 1)),
          h('td', { class: 'bar-col' }, bar(row.value || 0, valueMax, 'brand'))))),
        report.cash > 0.5 ? h('tfoot', {}, h('tr', {},
          h('td', {}, 'Nakit ve bekleyen emirler'), h('td', { class: 'hide-sm' }, ''), h('td', { class: 'r' }, tl(report.cash)),
          h('td', { class: 'r' }, report.endTotal > 0 ? pct(report.cash / report.endTotal * 100, 1) : '—'),
          h('td', {}, ''), h('td', { class: 'hide-sm' }, ''), h('td', { class: 'bar-col' }, ''))) : null)
        : empty('Ay sonu pozisyon kaydı yok.'),
      risk.largestWeight > 40 ? h('div', { class: 'rp-alert' },
        `Portföyün %${Math.round(risk.largestWeight)} kadarı tek varlıkta (${risk.largestCode}); bu varlıktaki bir gelişme portföyün tamamını belirgin şekilde etkiler.`) : null),
    block('Notlar', 'brand', h('ul', { class: 'rp-list' },
      h('li', {}, `Değerler hesaba kaydedilen günlük toplamlardan gelir (ilk kayıt ${fmtDate(report.firstDate)}); hafta sonları atlanır.`),
      report.frozenCodes.length ? h('li', {}, `${report.frozenCodes.join(', ')} temerrüttedir; fiyatı Midas’taki değerde sabittir, getiri ve K/Z hesaplanmaz.`) : null,
      h('li', {}, 'Kıyaslar: BIST 100, S&P 500 (TL), gram altın, dolar (Yahoo Finance); PPF ortalaması TEFAS para piyasası fonlarından; TÜFE TCMB/TÜİK verisinden.'),
      h('li', {}, 'Stopaj tahminidir: hisse yoğun fonlarda %0, diğer fonlarda %17,5; portföy değerini etkilemez.'))));

  const doc = h('div', { class: 'rp-doc' }, page1, page2);
  // Grafik DOM'a eklendikten sonra çizilir.
  requestAnimationFrame(() => {
    if (!m) return;
    lineChart(chartBox, {
      dates: report.chart.dates, height: 170,
      xFormat: (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`,
      yFormat: (value) => value.toFixed(0),
      valueFormat: (value) => value.toFixed(2),
      series: report.chart.series.map((series) => ({
        name: series.label, values: series.values,
        color: LINE_COLORS[series.key] || 'var(--c6)',
        width: series.key === 'PORTFOY' ? 2.6 : 1.4, fill: series.key === 'PORTFOY',
      })),
    });
  });
  return doc;
}

export function renderRapor() {
  const root = h('div', { class: 'stack' });
  const history = valueHistory();
  const snapshots = monthlySnapshots();
  const months = reportMonths(history, snapshots);
  const input = (month) => ({
    month, history, flows: cashflows(), dividends: dividends(), snapshots, transactions: transactions(),
  });

  const holder = h('div');
  let shownMonth = null;
  const printButton = h('button', {
    class: 'btn btn-primary', type: 'button',
    onclick: () => {
      const previous = document.title;
      document.title = `Analiz-Portfoy-Raporu-${shownMonth || ''}`; // PDF dosya adı
      window.print();
      setTimeout(() => { document.title = previous; }, 500);
    },
  }, '⤓ PDF olarak indir');
  const show = (month, preview = false) => {
    shownMonth = month;
    holder.replaceChildren(renderReport(buildMonthlyReport(input(month)), { preview }));
  };
  const toolbar = (...actions) => h('div', { class: 'rp-toolbar no-print' },
    h('div', {}, h('h2', {}, 'Aylık portföy raporu'),
      h('p', { class: 'dim' }, 'Getiri, kıyaslama, dağılım ve pozisyonlar · PDF için yazdırma penceresinde “PDF olarak kaydet” seç')),
    h('div', { class: 'rp-actions' }, ...actions));

  if (months.length) {
    const select = h('select', { 'aria-label': 'Rapor ayı' },
      months.map((month) => h('option', { value: month }, monthLabel(month))));
    select.addEventListener('change', () => show(select.value));
    root.append(toolbar(select, printButton), holder);
    show(months[0]);
  } else {
    const now = currentMonth();
    const intro = tonedSection('blue', '▤', 'Aylık Rapor',
      `İlk rapor ${monthLabel(FIRST_REPORT_MONTH)} ayıyla başlar`,
      h('p', { style: 'margin:0' },
        `${monthLabel(FIRST_REPORT_MONTH)} raporu ay boyunca ara rapor olarak, ay bitince tam rapor olarak burada görünür. `
        + 'Rapor; günlük kayıtlar, para hareketleri, temettüler ve ay sonu pozisyonlarından otomatik hazırlanır.'),
      h('div', { class: 'btn-row', style: 'margin-top:12px' },
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => {
            intro.replaceWith(toolbar(h('span', { class: 'dim', style: 'font-size:.82rem' },
              `Önizleme: ${monthLabel(now)} verisiyle`), printButton));
            show(now, true);
          },
        }, `Görünüme göz at (${monthLabel(now)} verisiyle önizleme)`)));
    intro.classList.add('no-print');
    root.append(intro, holder);
  }
  return root;
}
