/* Rapor: aylık portföy raporu (A4, PDF olarak kaydedilebilir).
   Düzen: kapak bandı + numaralı bölümler; her bölüm yazdırmada ayrı sayfadır. */

import { h, tl, tlSigned, pct, pctSigned, units as fmtUnits, cls, isNum, fmtDate, colorAt } from '../util.js';
import { lineChart, donutWithLegend, barChart } from '../charts.js';
import { valueHistory, cashflows, dividends, monthlySnapshots, transactions } from '../store.js';
import { buildMonthlyReport, reportMonths, monthLabel, FIRST_REPORT_MONTH } from '../report.js';
import { sectionCard } from './common.js';

const LINE_COLORS = {
  PORTFOY: 'var(--accent)', BIST100: 'var(--c2)', SP500TL: 'var(--c1)', GRAMALTIN: 'var(--c7)',
  USDTRY: 'var(--c4)', PARAPIYASASI: 'var(--c5)',
};
const SECTION_COUNT = 7;

const currentMonth = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit',
}).format(new Date()).slice(0, 7);

/** ▲ / ▼ işaretli, renkli yüzde. */
function trend(value, digits = 2) {
  if (!isNum(value)) return h('span', { class: 'dim' }, '—');
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '■';
  return h('span', { class: `trend ${cls(value)}` }, `${arrow} ${pctSigned(value, digits)}`);
}

const pctCell = (value) => h('td', {}, trend(value));

/** Verisi olmayan bölüm için açıklayıcı not (boş tire yerine). */
const emptyNote = (text) => h('div', { class: 'report-empty' }, h('span', { class: 'report-empty-icon' }, 'i'), h('span', {}, text));

function section(number, title, sub, report, ...children) {
  return h('section', { class: 'report-page' },
    h('header', { class: 'report-section-head' },
      h('span', { class: 'report-section-no' }, String(number)),
      h('div', {}, h('h2', {}, title), sub ? h('p', {}, sub) : null)),
    h('div', { class: 'report-section-body' }, ...children),
    h('footer', { class: 'report-footer' },
      h('span', {}, `Analiz · ${report.label} Portföy Raporu`),
      h('span', {}, `${number} / ${SECTION_COUNT}`)));
}

function tile(label, value, sub, tone = 'blue') {
  return h('div', { class: `report-tile tone-${tone}` },
    h('span', { class: 'report-tile-label' }, label),
    h('strong', { class: 'report-tile-value' }, value),
    sub ? h('span', { class: 'report-tile-sub' }, sub) : null);
}

function renderReport(report, { preview }) {
  const m = report.periods.month;
  const real = report.comparisonRows[0]?.realMonth;
  const change = m ? m.endValue - m.startValue : null;
  const changePct = m && m.startValue > 0 ? (m.endValue / m.startValue - 1) * 100 : null;
  const generated = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long' }).format(new Date());
  const root = h('div', { class: 'report' });
  const shortHistory = !m;
  const shortNote = `Bu dönem için en az iki kayıtlı gün gerekiyor (ilk kayıt ${fmtDate(report.firstDate)}). Getiri ve kıyaslar sonraki işlem günlerinde dolacak.`;

  /* ------------------------------------------------------------ kapak + özet */
  const cover = h('div', { class: 'report-cover' },
    h('div', { class: 'report-cover-top' },
      h('div', { class: 'report-brand' }, h('img', { src: '/Analiz/iconV1.png', alt: '' }), h('span', {}, 'Analiz')),
      h('span', { class: 'report-badge' }, preview ? 'ÖNİZLEME' : report.complete ? 'AY SONU RAPORU' : 'ARA RAPOR')),
    h('h1', {}, `${report.label} Portföy Raporu`),
    h('p', { class: 'report-cover-period' },
      m ? `${fmtDate(m.startDate)} – ${fmtDate(m.endDate)} · hazırlanma ${generated}` : `Hazırlanma ${generated}`),
    h('div', { class: 'report-cover-figures' },
      h('div', {}, h('span', {}, 'Toplam değer'), h('strong', {}, tl(m?.endValue ?? report.endTotal))),
      h('div', {}, h('span', {}, 'Aylık değişim'),
        h('strong', { class: `cover-trend ${cls(change)}` }, isNum(change)
          ? `${change >= 0 ? '▲' : '▼'} ${tlSigned(change)}${isNum(changePct) ? ` (${pctSigned(changePct, 2)})` : ''}` : '—')),
      h('div', {}, h('span', {}, 'Gerçek getiri'),
        h('strong', { class: `cover-trend ${cls(m?.twr)}` }, isNum(m?.twr) ? `${m.twr >= 0 ? '▲' : '▼'} ${pctSigned(m.twr, 2)}` : '—'))));

  const tiles = h('div', { class: 'report-tiles' },
    tile('Reel getiri', isNum(real) ? trend(real) : '—', 'Enflasyon (TÜFE) düşülmüş', 'teal'),
    tile('Net para girişi', m ? tlSigned(m.deposits - m.withdrawals) : '—',
      m ? `${tl(m.deposits)} yatırma · ${tl(m.withdrawals)} çekme` : 'Onaylanan para hareketleri', 'blue'),
    tile('Temettü geliri', tl(m?.dividends || 0), 'Getiriye dahil', 'green'),
    tile('Piyasa etkisi', m ? h('span', { class: cls(m.market) }, tlSigned(m.market)) : '—', 'Fiyat hareketlerinden', 'orange'));

  const movers = (rows, empty) => (rows.length
    ? h('ol', { class: 'report-movers' }, rows.map((row) => h('li', {},
      h('span', { class: 'code-chip' }, row.code),
      h('span', { class: cls(row.contribution) }, tlSigned(row.contribution)),
      isNum(row.monthPct) ? trend(row.monthPct, 1) : null)))
    : h('p', { class: 'dim', style: 'margin:0;font-size:.85rem' }, empty));
  const moversNote = report.hasStartSnapshot ? 'Bu ay yok' : 'Önceki ay sonu kaydı gerekiyor';

  root.append(h('section', { class: 'report-page report-first' }, cover,
    h('div', { class: 'report-section-body' },
      tiles,
      report.insights.length
        ? h('div', { class: 'report-highlights' }, h('h3', {}, 'Öne çıkanlar'),
          h('ul', {}, report.insights.map((text) => h('li', {}, text))))
        : null,
      shortHistory ? emptyNote(shortNote) : null,
      h('div', { class: 'report-movers-grid' },
        h('div', {}, h('h3', {}, '▲ En çok kazandıranlar'), movers(report.winners, moversNote)),
        h('div', {}, h('h3', {}, '▼ En çok kaybettirenler'), movers(report.losers, moversNote)))),
    h('footer', { class: 'report-footer' },
      h('span', {}, `Analiz · ${report.label} Portföy Raporu`), h('span', {}, `1 / ${SECTION_COUNT}`))));

  /* -------------------------------------------------------------- 2. kıyaslama */
  const compareBars = h('div');
  const chartBox = h('div', { class: 'chart' });
  const compareRows = report.comparisonRows.filter((row) => row.key !== 'TUFE' || isNum(row.month));
  root.append(section(2, 'Kıyaslama',
    'Portföy ile BIST 100, S&P 500 (TL), gram altın, dolar, PPF ortalaması ve enflasyon · reel = TÜFE düşülmüş',
    report,
    shortHistory ? emptyNote(shortNote) : h('div', { class: 'report-two' },
      h('div', {}, h('h3', {}, 'Bu ayın getirisi'), compareBars),
      h('div', {}, h('h3', {}, 'Dönem içi seyir (başlangıç = 100)'), chartBox)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'report-table' },
      h('thead', {}, h('tr', {},
        h('th', { style: 'text-align:left' }, 'Varlık / endeks'),
        h('th', {}, 'Bu ay'), h('th', {}, 'Bu ay reel'),
        h('th', {}, 'Yılbaşından beri'), h('th', {}, 'Başlangıçtan beri'), h('th', {}, 'Başlangıçtan reel'))),
      h('tbody', {}, compareRows.map((row) => h('tr', { class: row.key === 'PORTFOY' ? 'report-row-main' : '' },
        h('td', { style: 'text-align:left' }, row.label),
        pctCell(row.month), pctCell(row.realMonth), pctCell(row.ytd), pctCell(row.inception), pctCell(row.realInception)))))),
    h('p', { class: 'report-footnote' }, `Yılbaşı ve başlangıç sütunları ${fmtDate(report.firstDate)} tarihli ilk kayıttan itibaren hesaplanır. TÜFE son açıklanan aya kadardır.`)));

  /* ------------------------------------------------------------ 3. değer köprüsü */
  const bridge = m ? [
    { label: 'Ay başı değeri', value: m.startValue, total: true },
    { label: 'Yatırılan para', value: m.deposits },
    { label: 'Çekilen para', value: -m.withdrawals },
    { label: 'Temettü', value: m.dividends },
    { label: 'Piyasa (fiyat hareketi)', value: m.market },
    { label: 'Ay sonu değeri', value: m.endValue, total: true },
  ] : [];
  const bridgeMax = Math.max(1, ...bridge.filter((row) => !row.total).map((row) => Math.abs(row.value)));
  root.append(section(3, 'Değer Köprüsü', 'Ay başından ay sonuna değişimin kaynakları', report,
    m ? h('div', { class: 'report-bridge' }, bridge.map((row) => h('div', { class: `report-bridge-row${row.total ? ' total' : ''}` },
      h('span', { class: 'report-bridge-label' }, row.label),
      row.total ? h('span', {})
        : h('span', { class: 'report-bridge-bar' }, Math.abs(row.value) < 0.005 ? null : h('i', {
          class: row.value >= 0 ? 'up' : 'down',
          style: `width:${Math.max(2, Math.abs(row.value) / bridgeMax * 100).toFixed(1)}%`,
        })),
      h('strong', { class: row.total ? '' : cls(row.value) },
        row.total ? tl(row.value) : Math.abs(row.value) < 0.005 ? tl(0) : tlSigned(row.value)))))
      : emptyNote(shortNote),
    h('p', { class: 'report-footnote' }, 'Alım-satım nakit ile varlık arasında yer değiştirdiği için toplamı değiştirmez; piyasa etkisi fiyat hareketlerinden gelen kazanç/kayıptır.')));

  /* --------------------------------------------------------------- 4. dağılım */
  const showStart = report.hasStartSnapshot;
  const donut = donutWithLegend(report.allocation.map((row, index) => ({ label: row.label, value: row.value, color: colorAt(index) })), {
    centerTop: tl(report.endTotal, { compact: true }), centerBottom: 'ay sonu',
    format: (value) => (report.endTotal > 0 ? pct(value / report.endTotal * 100, 1) : '—'),
  });
  root.append(section(4, 'Dağılım', showStart ? 'Ay sonu ağırlıkları ve önceki ay sonuna göre değişim' : 'Ay sonu ağırlıkları', report,
    report.allocation.length ? h('div', { class: 'report-alloc' }, donut,
      h('div', { class: 'table-wrap' }, h('table', { class: 'report-table' },
        h('thead', {}, h('tr', {}, h('th', { style: 'text-align:left' }, 'Grup'), h('th', {}, 'Değer'), h('th', {}, 'Ağırlık'),
          showStart ? h('th', {}, 'Önceki ay') : null)),
        h('tbody', {}, report.allocation.map((row, index) => h('tr', {},
          h('td', { style: 'text-align:left' }, h('span', { class: 'report-swatch', style: `background:${colorAt(index)}` }), row.label),
          h('td', {}, tl(row.value)),
          h('td', {}, isNum(row.weight) ? pct(row.weight, 1) : '—'),
          showStart ? h('td', {}, isNum(row.startWeight) ? pct(row.startWeight, 1) : 'yeni') : null))))))
      : emptyNote('Ay sonu pozisyon kaydı yok. Ay içinde siteyi bir kez açmak kaydı oluşturur.')));

  /* ------------------------------------------------------------ 5. pozisyonlar */
  const contributionBox = h('div');
  root.append(section(5, 'Pozisyonlar',
    showStart ? 'Ay sonu · katkı = ay başında tutulan adetin fiyat değişimi (yaklaşık)' : 'Ay sonu', report,
    report.positions.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'report-table report-positions' },
      h('thead', {}, h('tr', {},
        h('th', { style: 'text-align:left' }, 'Varlık'), h('th', {}, 'Adet'), h('th', {}, 'Değer'), h('th', {}, 'Ağırlık'),
        showStart ? h('th', {}, 'Ay içi') : null, showStart ? h('th', {}, 'Katkı') : null, h('th', {}, 'Toplam K/Z'))),
      h('tbody', {}, report.positions.map((row) => h('tr', {},
        h('td', { style: 'text-align:left' },
          h('div', { class: 'report-asset' }, h('span', { class: 'code-chip' }, row.code),
            row.label ? h('span', { class: 'report-asset-label' }, row.label) : null)),
        h('td', {}, fmtUnits(row.units)),
        h('td', {}, tl(row.value)),
        h('td', {}, isNum(row.weight) ? pct(row.weight, 1) : '—'),
        showStart ? h('td', {}, row.frozen ? 'sabit' : trend(row.monthPct, 1)) : null,
        showStart ? h('td', { class: cls(row.contribution) }, row.frozen ? '—' : isNum(row.contribution) ? tlSigned(row.contribution) : '—') : null,
        h('td', {}, row.frozen ? h('span', { class: 'dim' }, 'temerrüt') : isNum(row.totalPLTRY)
          ? h('span', { class: cls(row.totalPLTRY) }, `${tlSigned(row.totalPLTRY)}${isNum(row.totalPct) ? ` · ${pctSigned(row.totalPct, 1)}` : ''}`)
          : '—')))),
      report.cash > 0.5 ? h('tfoot', {}, h('tr', {}, h('td', { style: 'text-align:left' }, 'Nakit ve bekleyen emirler'), h('td', {}, ''),
        h('td', {}, tl(report.cash)), h('td', {}, report.endTotal > 0 ? pct(report.cash / report.endTotal * 100, 1) : '—'),
        showStart ? h('td', {}, '') : null, showStart ? h('td', {}, '') : null, h('td', {}, ''))) : null))
      : emptyNote('Ay sonu pozisyon kaydı yok.'),
    showStart ? h('div', {}, h('h3', {}, 'Varlıkların bu aya katkısı'), contributionBox)
      : emptyNote('Varlık bazında aylık getiri ve katkı, önceki ay sonu pozisyon kaydı oluştuğunda (ilk kez Kasım raporunda) görünür.')));

  /* ------------------------------------------------------------ 6. risk ve vergi */
  root.append(section(6, 'Risk ve Vergi', 'Yoğunlaşma, dönem içi düşüş ve tahmini stopaj', report,
    h('div', { class: 'report-tiles' },
      tile('En büyük düşüş', isNum(report.risk.maxDrawdown) ? trend(report.risk.maxDrawdown) : '—', 'Ay içi, para hareketlerinden arındırılmış', 'red'),
      tile('En büyük pozisyon', `${report.risk.largestCode || '—'}${isNum(report.risk.largestWeight) ? ` · ${pct(report.risk.largestWeight, 1)}` : ''}`, 'Portföydeki payı', 'orange'),
      tile('İlk 3 varlık', pct(report.risk.top3Weight, 1), `${report.risk.positionCount} varlık içinde`, 'blue'),
      tile('Tahmini stopaj', tl(report.stopajTotal), 'Satışta fon kârından kesilir', 'purple')),
    report.risk.largestWeight > 40 ? h('div', { class: 'report-alert' },
      `Portföyün %${Math.round(report.risk.largestWeight)} kadarı tek varlıkta (${report.risk.largestCode}). Bu varlıktaki bir gelişme portföyün tamamını belirgin şekilde etkiler.`) : null));

  /* ------------------------------------------------------------------ 7. notlar */
  root.append(section(7, 'Notlar ve Veri Kaynakları', null, report,
    h('ul', { class: 'report-notes' },
      h('li', {}, 'Getiriler zaman ağırlıklıdır: onaylanan para yatırma/çekme getiri sayılmaz; temettü getiridir.'),
      h('li', {}, `Değerler hesaba kaydedilen günlük toplamlardan gelir (ilk kayıt ${fmtDate(report.firstDate)}); hafta sonları atlanır.`),
      report.frozenCodes.length ? h('li', {}, `${report.frozenCodes.join(', ')} temerrüttedir; fiyatı Midas’taki değerde sabittir, getiri ve K/Z hesaplanmaz.`) : null,
      h('li', {}, 'Kıyaslamalar: BIST 100, S&P 500 (dolar kuruyla TL’ye çevrilmiş), gram altın ve dolar Yahoo Finance’ten; PPF ortalaması TEFAS para piyasası fonlarının eşit ağırlıklı günlük getirisinden; TÜFE TCMB/TÜİK verisinden.'),
      h('li', {}, 'Pozisyon adetleri ve fiyatları Midas’tan, fon fiyatları TEFAS’tan alınır.'),
      h('li', {}, 'Bu rapor kişisel takip amaçlıdır, yatırım tavsiyesi değildir.'))));

  // Grafikler DOM'a eklendikten sonra çizilir.
  requestAnimationFrame(() => {
    if (!shortHistory) {
      barChart(compareBars, {
        items: compareRows.filter((row) => isNum(row.month)).map((row) => ({ label: row.label, value: row.month })),
        format: (value) => pctSigned(value, 2), labelWidth: 118,
      });
      lineChart(chartBox, {
        dates: report.chart.dates, height: 220,
        xFormat: (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`,
        yFormat: (value) => value.toFixed(0),
        valueFormat: (value) => value.toFixed(2),
        series: report.chart.series.map((series) => ({
          name: series.label, values: series.values,
          color: LINE_COLORS[series.key] || 'var(--c6)',
          width: series.key === 'PORTFOY' ? 2.8 : 1.5, fill: series.key === 'PORTFOY',
        })),
      });
    }
    if (showStart) {
      const items = report.positions.filter((row) => isNum(row.contribution) && !row.frozen)
        .map((row) => ({ label: row.code, value: row.contribution }));
      if (items.length) barChart(contributionBox, { items, format: (value) => tlSigned(value) });
    }
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
    root.lastChild.classList.add('report-intro');
    root.append(holder);
  }
  return root;
}
