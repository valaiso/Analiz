/* Rapor: aylık portföy raporu (A4, PDF olarak kaydedilebilir). */

import { h, tl, tlSigned, pct, pctSigned, units as fmtUnits, cls, isNum, fmtDate } from '../util.js';
import { lineChart, donutWithLegend, barChart } from '../charts.js';
import { valueHistory, cashflows, dividends, monthlySnapshots, transactions } from '../store.js';
import { buildMonthlyReport, reportMonths, monthLabel, FIRST_REPORT_MONTH } from '../report.js';
import { sectionCard } from './common.js';

const LINE_COLORS = {
  PORTFOY: 'var(--accent)', BIST100: 'var(--c2)', SP500TL: 'var(--c1)', GRAMALTIN: 'var(--c3)',
  USDTRY: 'var(--c4)', PARAPIYASASI: 'var(--c5)',
};

const currentMonth = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit',
}).format(new Date()).slice(0, 7);

const pctCell = (value) => h('td', { class: cls(value) }, isNum(value) ? pctSigned(value, 2) : '—');

function page(title, sub, ...children) {
  return h('section', { class: 'report-page card' },
    h('div', { class: 'report-page-head' }, h('h2', {}, title), sub ? h('span', { class: 'sub' }, sub) : null),
    ...children);
}

function kpi(label, value, sub, tone) {
  return h('div', { class: 'report-kpi' },
    h('span', { class: 'report-kpi-label' }, label),
    h('strong', { class: tone || '' }, value),
    sub ? h('span', { class: 'report-kpi-sub' }, sub) : null);
}

function renderReport(report, { preview }) {
  const m = report.periods.month;
  const root = h('div', { class: 'report' });

  /* ---------------------------------------------------------------- 1. özet */
  root.append(page(`${report.label} Portföy Raporu`,
    `${m ? `${fmtDate(m.startDate)} – ${fmtDate(m.endDate)}` : 'Dönem verisi yok'}`
    + `${report.complete ? '' : ' · ay devam ediyor (ara rapor)'}${preview ? ' · ÖNİZLEME' : ''}`,
    h('div', { class: 'report-kpis' },
      kpi('Ay sonu değeri', tl(m?.endValue ?? report.endTotal), m ? `Ay başı ${tl(m.startValue)}` : null),
      kpi('Değişim', m ? tlSigned(m.endValue - m.startValue) : '—',
        m && m.startValue > 0 ? pctSigned((m.endValue / m.startValue - 1) * 100, 2) : null,
        m ? cls(m.endValue - m.startValue) : ''),
      kpi('Gerçek getiri', isNum(m?.twr) ? pctSigned(m.twr, 2) : '—', 'Para giriş/çıkışı hariç', cls(m?.twr)),
      kpi('Reel getiri', isNum(report.comparisonRows[0]?.realMonth) ? pctSigned(report.comparisonRows[0].realMonth, 2) : '—',
        'TÜFE düşülmüş', cls(report.comparisonRows[0]?.realMonth)),
      kpi('Net para girişi', m ? tlSigned(m.deposits - m.withdrawals) : '—',
        m ? `${tl(m.deposits)} yatırma · ${tl(m.withdrawals)} çekme` : null),
      kpi('Temettü', tl(m?.dividends || 0), `${report.monthDividends.length} ödeme`)),
    report.insights.length ? h('ul', { class: 'report-insights' }, report.insights.map((text) => h('li', {}, text))) : null,
    h('div', { class: 'grid grid-2' },
      h('div', {}, h('h3', {}, 'En çok kazandıranlar'),
        report.winners.length ? h('ul', { class: 'report-list' }, report.winners.map((row) =>
          h('li', {}, h('span', { class: 'code-chip' }, row.code), ` ${tlSigned(row.contribution)}${isNum(row.monthPct) ? ` (${pctSigned(row.monthPct, 1)})` : ''}`)))
          : h('p', { class: 'dim' }, '—')),
      h('div', {}, h('h3', {}, 'En çok kaybettirenler'),
        report.losers.length ? h('ul', { class: 'report-list' }, report.losers.map((row) =>
          h('li', {}, h('span', { class: 'code-chip' }, row.code), ` ${tlSigned(row.contribution)}${isNum(row.monthPct) ? ` (${pctSigned(row.monthPct, 1)})` : ''}`)))
          : h('p', { class: 'dim' }, '—')))));

  /* -------------------------------------------------------------- 2. kıyaslama */
  const compareTable = h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { style: 'text-align:left' }, ''),
      h('th', {}, 'Bu ay'), h('th', {}, 'Bu ay reel'),
      h('th', {}, 'Yılbaşından beri'), h('th', {}, 'Başlangıçtan beri'), h('th', {}, 'Başlangıçtan reel'))),
    h('tbody', {}, report.comparisonRows.map((row) => h('tr', { class: row.key === 'PORTFOY' ? 'report-row-main' : '' },
      h('td', { style: 'text-align:left' }, row.label),
      pctCell(row.month), pctCell(row.realMonth), pctCell(row.ytd), pctCell(row.inception), pctCell(row.realInception))))));
  const chartBox = h('div', { class: 'chart' });
  root.append(page('Kıyaslama',
    `Hepsi dönem başında 100 · reel = TÜFE düşülmüş · yılbaşı ve başlangıç ${fmtDate(report.firstDate)} kaydından itibaren`,
    compareTable, chartBox));

  /* ------------------------------------------------------------ 3. değer köprüsü */
  if (m) {
    const bridge = [
      { label: 'Ay başı', value: m.startValue },
      { label: 'Yatırma', value: m.deposits },
      { label: 'Çekme', value: -m.withdrawals },
      { label: 'Temettü', value: m.dividends },
      { label: 'Piyasa', value: m.market },
      { label: 'Ay sonu', value: m.endValue },
    ];
    root.append(page('Değer Köprüsü', 'Ay başından ay sonuna değişimin kaynakları',
      h('div', { class: 'table-wrap', style: 'max-width:480px' }, h('table', {},
        h('tbody', {}, bridge.map((row, index) => h('tr', { class: index === 0 || index === bridge.length - 1 ? 'report-row-main' : '' },
          h('td', { style: 'text-align:left' }, row.label),
          h('td', { class: index === 0 || index === bridge.length - 1 ? '' : cls(row.value) },
            index === 0 || index === bridge.length - 1 ? tl(row.value) : Math.abs(row.value) < 0.005 ? tl(0) : tlSigned(row.value))))))),
      h('p', { class: 'dim', style: 'margin:0;font-size:.8rem' },
        'Piyasa = fiyat hareketlerinden gelen kazanç/kayıp (alım-satım nakit ile varlık arasında yer değiştirdiği için toplamı değiştirmez).')));
  }

  /* --------------------------------------------------------------- 4. dağılım */
  const donut = donutWithLegend(report.allocation.map((row) => ({ label: row.label, value: row.value })), {
    centerTop: tl(report.endTotal, { compact: true }), centerBottom: 'ay sonu',
    format: (value) => (report.endTotal > 0 ? pct(value / report.endTotal * 100, 1) : '—'),
  });
  root.append(page('Dağılım', 'Ay sonu ağırlıkları ve önceki aya göre değişim',
    h('div', { class: 'grid grid-2' }, donut,
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { style: 'text-align:left' }, 'Grup'), h('th', {}, 'Değer'), h('th', {}, 'Ağırlık'), h('th', {}, 'Önceki ay'))),
        h('tbody', {}, report.allocation.map((row) => h('tr', {},
          h('td', { style: 'text-align:left' }, row.label),
          h('td', {}, tl(row.value)),
          h('td', {}, isNum(row.weight) ? pct(row.weight, 1) : '—'),
          h('td', {}, isNum(row.startWeight) ? pct(row.startWeight, 1) : '—')))))))));

  /* ------------------------------------------------------------ 5. pozisyonlar */
  const contributionBox = h('div');
  root.append(page('Pozisyonlar', 'Ay sonu · katkı = ay başında tutulan adetin fiyat değişimi (yaklaşık)',
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { style: 'text-align:left' }, 'Varlık'), h('th', {}, 'Adet'), h('th', {}, 'Değer'), h('th', {}, 'Ağırlık'),
        h('th', {}, 'Ay içi'), h('th', {}, 'Katkı'), h('th', {}, 'Toplam K/Z'))),
      h('tbody', {}, report.positions.map((row) => h('tr', {},
        h('td', { style: 'text-align:left;white-space:normal' }, h('span', { class: 'code-chip' }, row.code),
          row.label ? h('span', { class: 'dim', style: 'margin-left:6px;font-size:.78rem' }, row.label) : null),
        h('td', {}, fmtUnits(row.units)),
        h('td', {}, tl(row.value)),
        h('td', {}, isNum(row.weight) ? pct(row.weight, 1) : '—'),
        row.frozen ? h('td', {}, '—') : pctCell(row.monthPct),
        h('td', { class: cls(row.contribution) }, row.frozen ? '—' : isNum(row.contribution) ? tlSigned(row.contribution) : '—'),
        h('td', { class: cls(row.totalPLTRY) }, row.frozen ? '—' : isNum(row.totalPLTRY)
          ? `${tlSigned(row.totalPLTRY)}${isNum(row.totalPct) ? ` · ${pctSigned(row.totalPct, 1)}` : ''}` : '—')))),
      report.cash > 0.5 ? h('tfoot', {}, h('tr', {}, h('td', { style: 'text-align:left' }, 'Nakit'), h('td', {}, ''),
        h('td', {}, tl(report.cash)), h('td', {}, report.endTotal > 0 ? pct(report.cash / report.endTotal * 100, 1) : '—'),
        h('td', {}, ''), h('td', {}, ''), h('td', {}, ''))) : null)),
    h('h3', {}, 'Ay içi katkı'), contributionBox));

  /* ---------------------------------------------------------- 6. ayın hareketleri */
  const txRows = report.monthTransactions.map((tx) => h('tr', {},
    h('td', { style: 'text-align:left' }, fmtDate(tx.date)),
    h('td', {}, h('span', { class: 'code-chip' }, tx.code)),
    h('td', {}, tx.type === 'SAT' ? 'Satış' : 'Alış'),
    h('td', {}, fmtUnits(tx.units)),
    h('td', {}, isNum(tx.price) ? tx.price.toLocaleString('tr-TR', { maximumFractionDigits: 4 }) : '—'),
    h('td', {}, tx.currency === 'USD' ? 'USD' : 'TL')));
  root.append(page('Ayın Hareketleri', `${report.monthTransactions.length} işlem · ${report.monthFlows.length} para hareketi · ${report.monthDividends.length} temettü · komisyon ${tl(report.fees)}`,
    report.monthFlows.length || report.monthDividends.length ? h('div', { class: 'table-wrap', style: 'max-width:520px' }, h('table', {},
      h('tbody', {},
        ...report.monthFlows.map((flow) => h('tr', {}, h('td', { style: 'text-align:left' }, fmtDate(flow.date)),
          h('td', {}, flow.amount > 0 ? 'Para yatırma' : 'Para çekme'), h('td', { class: cls(flow.amount) }, tlSigned(flow.amount)))),
        ...report.monthDividends.map((item) => h('tr', {}, h('td', { style: 'text-align:left' }, fmtDate(item.date)),
          h('td', {}, `Temettü${item.code ? ` · ${item.code}` : ''}`), h('td', { class: 'up' }, tlSigned(item.amount))))))) : null,
    txRows.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { style: 'text-align:left' }, 'Tarih'), h('th', {}, 'Varlık'), h('th', {}, 'Yön'),
        h('th', {}, 'Adet'), h('th', {}, 'Fiyat'), h('th', {}, 'Para birimi'))),
      h('tbody', {}, txRows))) : h('p', { class: 'dim' }, 'Bu ay alım/satım işlemi yok.')));

  /* ------------------------------------------------------------ 7. risk ve vergi */
  root.append(page('Risk ve Vergi', 'Ay içi en büyük düşüş para giriş/çıkışından arındırılmıştır',
    h('div', { class: 'report-kpis' },
      kpi('Ay içi en büyük düşüş', isNum(report.risk.maxDrawdown) ? pctSigned(report.risk.maxDrawdown, 2) : '—', null, cls(report.risk.maxDrawdown)),
      kpi('En büyük pozisyon', report.risk.largestCode || '—', isNum(report.risk.largestWeight) ? pct(report.risk.largestWeight, 1) : null),
      kpi('İlk 3 varlığın payı', pct(report.risk.top3Weight, 1), `${report.risk.positionCount} varlık`),
      kpi('Tahmini stopaj', tl(report.stopajTotal), 'Satışta fon kârından kesilir'))));

  /* ------------------------------------------------------------------ 8. notlar */
  root.append(page('Notlar ve Veri Kaynakları', null,
    h('ul', { class: 'report-notes' },
      h('li', {}, 'Getiriler zaman ağırlıklıdır: onaylanan para yatırma/çekme getiri sayılmaz; temettü getiridir.'),
      h('li', {}, `Değerler hesaba kaydedilen günlük toplamlardan gelir (ilk kayıt ${fmtDate(report.firstDate)}); hafta sonları atlanır.`),
      report.frozenCodes.length ? h('li', {}, `${report.frozenCodes.join(', ')} temerrüttedir; fiyatı Midas’taki değerde sabittir, getiri ve K/Z hesaplanmaz.`) : null,
      h('li', {}, 'Kıyaslamalar: BIST 100, S&P 500 (dolar kuruyla TL’ye çevrilmiş), gram altın ve dolar Yahoo Finance’ten; PPF ortalaması TEFAS para piyasası fonlarının eşit ağırlıklı günlük getirisinden; TÜFE TCMB/TÜİK verisinden (son açıklanan aya kadar).'),
      h('li', {}, 'Pozisyon adetleri ve fiyatları Midas’tan, fon fiyatları TEFAS’tan alınır.'),
      !report.hasStartSnapshot ? h('li', {}, 'Önceki ay sonu pozisyon kaydı olmadığı için ay içi varlık getirileri ve katkılar hesaplanamadı.') : null,
      h('li', {}, 'Bu rapor kişisel takip amaçlıdır, yatırım tavsiyesi değildir.'))));

  // Grafikler DOM'a eklendikten sonra çizilir.
  requestAnimationFrame(() => {
    const dates = report.chart.dates;
    if (dates.length > 1) {
      lineChart(chartBox, {
        dates, height: 240,
        xFormat: (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`,
        yFormat: (value) => value.toFixed(0),
        valueFormat: (value) => value.toFixed(2),
        series: report.chart.series.map((series) => ({
          name: series.label, values: series.values,
          color: LINE_COLORS[series.key] || 'var(--c6)',
          width: series.key === 'PORTFOY' ? 2.6 : 1.5, fill: series.key === 'PORTFOY',
        })),
      });
    } else {
      chartBox.append(h('p', { class: 'dim' }, 'Grafik için en az iki kayıtlı gün gerekir.'));
    }
    const items = report.positions.filter((row) => isNum(row.contribution) && !row.frozen)
      .map((row) => ({ label: row.code, value: row.contribution }));
    if (items.length) barChart(contributionBox, { items, format: (value) => tlSigned(value) });
    else contributionBox.append(h('p', { class: 'dim' }, 'Katkı hesabı için önceki ay sonu kaydı gerekir.'));
  });
  return root;
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
  const printButton = h('button', {
    class: 'btn btn-primary', type: 'button',
    onclick: () => window.print(),
  }, 'PDF indir');
  const show = (month, preview = false) => {
    holder.replaceChildren(renderReport(buildMonthlyReport(input(month)), { preview }));
  };

  if (months.length) {
    const select = h('select', { 'aria-label': 'Rapor ayı' },
      months.map((month) => h('option', { value: month }, monthLabel(month))));
    select.addEventListener('change', () => show(select.value));
    root.append(h('div', { class: 'card report-toolbar' },
      h('label', { class: 'dim' }, 'Ay ', select), printButton,
      h('span', { class: 'dim', style: 'font-size:.8rem' }, 'PDF indir → yazdırma penceresinde “PDF olarak kaydet” seç.')));
    root.append(holder);
    show(months[0]);
  } else {
    const now = currentMonth();
    root.append(sectionCard('Aylık Rapor',
      `İlk rapor ${monthLabel(FIRST_REPORT_MONTH)} ayıyla başlar`,
      h('p', { style: 'margin:0' },
        `${monthLabel(FIRST_REPORT_MONTH)} raporu ay boyunca ara rapor olarak, ay bitince tam rapor olarak burada görünür. `
        + 'Rapor; günlük kayıtlar, para hareketleri, temettüler ve ay sonu pozisyonlarından otomatik hazırlanır.'),
      h('div', { class: 'btn-row', style: 'margin-top:12px' },
        h('button', {
          class: 'btn', type: 'button',
          onclick: (event) => {
            event.currentTarget.closest('.card').after(h('div', { class: 'card report-toolbar' }, printButton,
              h('span', { class: 'dim', style: 'font-size:.8rem' }, 'Önizleme: rapor düzenini görmek için bu ayın verisiyle hazırlandı.')));
            show(now, true);
          },
        }, `Görünüme göz at (${monthLabel(now)} verisiyle önizleme)`))));
    root.append(holder);
  }
  return root;
}
