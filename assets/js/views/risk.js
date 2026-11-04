/* Risk: oynaklık, Sharpe, düşüşler, tutarlılık ve çeşitlendirme. */

import { h, pct, pctSigned, num, cls, isNum, fmtDate } from '../util.js';
import { DB } from '../data.js';
import { lineChart, monthlyReturnTable } from '../charts.js';
import { riskSummary } from '../portfolio.js';
import {
  monthlyReturns, yearlyFromMonthly, drawdownEpisodes, rollingReturns, diversification, recordedSeries,
} from '../insights.js';
import { settings, setSetting, valueHistory, cashflows, trackingStart } from '../store.js';
import { indexForDate } from '../data.js';
import { kpiCard, sectionCard, emptyState, tonedSection } from './common.js';

/** Seriden düşüş (drawdown) yüzdeleri üretir. */
function drawdownSeries(values) {
  let peak = -Infinity;
  return values.map((v) => {
    if (!isNum(v) || v <= 0) return null;
    peak = Math.max(peak, v);
    return (v / peak - 1) * 100;
  });
}

export function renderRisk(ctx) {
  const { analysis, navigate } = ctx;
  const { open } = analysis;
  // Risk, hesaba kaydedilen gerçek günlük değerlerden hesaplanır (ilk kayıt 16.10.2026);
  // kayıt yoksa eski işlem kayıtlarından modellenen seri kullanılır.
  const recorded = recordedSeries(valueHistory(), cashflows());
  const series = recorded.dates.length >= 2
    ? { ...recorded, start: Math.max(0, indexForDate(recorded.dates[0])) }
    : trackingStart() ? { ...recorded, start: 0 } : analysis.series;
  const MIN_DAYS = 10;

  if (series.dates.length < MIN_DAYS) {
    return recorded.dates.length
      ? emptyState('Risk ölçüleri için birkaç hafta daha gerekiyor',
        `Oynaklık, Sharpe oranı ve düşüşler kayıtlı günlük portföy değerlerinden hesaplanır. Kayıt ${fmtDate(recorded.dates[0])} tarihinde başladı; `
        + `şu an ${recorded.dates.length} işlem günü var, en az ${MIN_DAYS} gün gerekiyor.`)
      : emptyState('Risk analizi için daha fazla geçmiş gerekiyor',
        'Portföy değeri birkaç hafta kaydedildiğinde oynaklık, Sharpe oranı ve maksimum düşüş burada hesaplanır.',
        'İşlem ekle', () => navigate('islemler'));
  }

  const root = h('div', { class: 'stack' });
  // Risksiz faiz: elle girilmediyse para piyasası fonlarının son 1 yıllık getirisi (her gün güncel).
  const ppAll = (DB.benchmarks?.PARAPIYASASI?.values || []).map((v, i) => [i, v]).filter(([, v]) => isNum(v) && v > 0);
  const ppLast = ppAll.at(-1);
  const ppYearAgo = ppLast ? ppAll.filter(([i]) => i <= ppLast[0] - 250).at(-1) : null;
  const ppAuto = ppLast && ppYearAgo ? (ppLast[1] / ppYearAgo[1] - 1) * 100 : null;
  const manualRf = settings().riskFreeMode === 'manual';
  const riskFree = !manualRf && isNum(ppAuto) ? Math.round(ppAuto * 10) / 10 : Number(settings().riskFree) || 0;
  const summary = riskSummary(series.twr, series.dates, riskFree);
  if (series.dates.length < 60) {
    root.append(h('div', { class: 'notice warn' },
      h('strong', {}, 'Ön değerler. '),
      `Şu an ${series.dates.length} işlem günü var. Yıllık oynaklık, Sharpe ve yıllık getiri birkaç haftalık veriden yıllığa `
      + 'çevrildiği için çok oynaktır; en az 60 işlem günü (tercihen 1 yıl) dolmadan güvenilir kabul edilmemeli.'));
  }

  /* -------------------------------------------------------------------- KPI'lar */

  root.append(h('div', { class: 'grid grid-kpi' },
    kpiCard({
      label: 'Yıllık Oynaklık',
      tone: 'blue',
      value: isNum(summary.vol) ? pct(summary.vol, 1) : '—',
      sub: `${summary.vol > 25 ? 'Yüksek dalgalanma' : summary.vol > 12 ? 'Orta' : 'Düşük'}`
        + `${isNum(summary.volMargin) ? ` · hata payı ±${num(summary.volMargin, 1)} puan` : ''}`,
      hint: 'Günlük getirilerin standart sapması, yıllığa çevrilmiş. Hata payı %95 güvenle gerçek değerin aralığıdır.',
    }),
    kpiCard({
      label: 'Sharpe Oranı',
      tone: 'green',
      value: isNum(summary.sharpe)
        ? `${num(summary.sharpe, 2)}${isNum(summary.sharpeMargin) ? ` ± ${num(summary.sharpeMargin, 2)}` : ''}`
        : '—',
      valueClass: cls(summary.sharpe),
      sub: `Risksiz getiri %${num(riskFree, 1)} ${!manualRf && isNum(ppAuto) ? '(para piyasası fonları, son 1 yıl)' : '(elle girildi)'}`,
      hint: isNum(summary.sharpeMargin) && Math.abs(summary.sharpe) < summary.sharpeMargin
        ? `Hata payı (%95) Sharpe'ın kendisinden büyük: ${summary.observations} günlük veriyle iyi mi kötü mü olduğu henüz söylenemez.`
        : 'Aldığın risk başına düşen fazla getiri; 1 üzeri iyi kabul edilir. ± hata payı %95 güven aralığıdır (Lo, 2002).',
    }),
    kpiCard({
      label: 'Maksimum Düşüş',
      tone: 'burgundy',
      value: isNum(summary.maxDD) ? pct(summary.maxDD, 1) : '—',
      valueClass: 'down',
      sub: 'Zirveden en derin geri çekilme',
    }),
    kpiCard({
      label: 'Yıllık Getiri (TWR)',
      tone: 'orange',
      value: isNum(summary.annual) ? pctSigned(summary.annual, 1) : '—',
      valueClass: cls(summary.annual),
      sub: `${Math.round(summary.days)} günlük geçmişten`,
      hint: summary.days < 180
        ? 'Kısa geçmiş - yıllıklandırılmış değerler oynak olabilir'
        : null,
    }),
    kpiCard({
      label: 'Kazançlı Gün Oranı',
      tone: 'teal',
      value: isNum(summary.positiveDays) ? pct(summary.positiveDays, 0) : '—',
      sub: isNum(summary.best)
        ? `En iyi ${pctSigned(summary.best, 1)} · en kötü ${pctSigned(summary.worst, 1)}`
        : null,
    })));

  /* ---------------------------------------------------------- risksiz getiri ayarı */

  const ppSerisi = DB.benchmarks?.PARAPIYASASI?.values;
  let ppYillik = null;
  if (ppSerisi?.length) {
    const dilim = ppSerisi.slice(series.start, Math.max(0, indexForDate(series.dates.at(-1))) + 1)
      .filter((v) => isNum(v) && v > 0);
    if (dilim.length > 30 && summary.days > 0) {
      ppYillik = ((dilim[dilim.length - 1] / dilim[0]) ** (365.25 / summary.days) - 1) * 100;
    }
  }

  const rfInput = h('input', {
    type: 'number', value: String(riskFree), min: '0', max: '200', step: '1',
    style: 'width:90px',
  });
  rfInput.addEventListener('change', () => {
    setSetting('riskFree', Number(rfInput.value) || 0);
    setSetting('riskFreeMode', 'manual');
    ctx.refresh();
  });

  root.append(sectionCard(null, null,
    h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' },
      h('label', { class: 'dim', style: 'font-size:.86rem' },
        'Sharpe hesabında kullanılacak risksiz yıllık getiri (%):'),
      rfInput,
      manualRf && isNum(ppAuto)
        ? h('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => { setSetting('riskFreeMode', 'auto'); ctx.refresh(); },
        }, `Otomatik: para piyasası fonları (%${num(ppAuto, 1)})`)
        : null),
    isNum(ppYillik)
      ? h('p', { class: 'dim', style: 'margin:8px 0 0;font-size:.8rem' },
        `Aynı dönemde ${DB.benchmarks.PARAPIYASASI.label.toLowerCase()} `
        + `%${num(ppYillik, 1)} yıllık getirmiş. Bu, mevduat benzeri düşük riskli `
        + 'getirinin gerçek karşılığıdır; varsayım yerine bunu kullanabilirsin.')
      : null));

  /* ------------------------------------------------------- aylık getiri tablosu */

  const aylik = monthlyReturns(series.dates, series.twr);
  if (aylik.length >= 2) {
    root.append(tonedSection('indigo', '▦', 'Aylık Getiriler',
      'Zaman ağırlıklı (TWR) · yeşil kazanç, kırmızı kayıp',
      monthlyReturnTable(aylik, yearlyFromMonthly(aylik))));
  }

  /* ----------------------------------------------------------------- düşüş grafiği */

  const ddBox = h('div', { class: 'chart' });
  root.append(tonedSection('orange', '↘', 'Zirveden Düşüş (Drawdown)',
    'Portföyün en yüksek değerine göre ne kadar geride olduğu', ddBox));
  lineChart(ddBox, {
    dates: series.dates,
    height: 220,
    baseline: 0,
    yFormat: (v) => pct(v, 0),
    valueFormat: (v) => pct(v, 2),
    series: [{ name: 'Düşüş', values: drawdownSeries(series.twr), color: 'var(--down)', fill: true }],
    legend: false,
  });

  /* -------------------------------------------------------------- düşüş dökümü */

  const donemler = drawdownEpisodes(series.dates, series.twr, 5);
  if (donemler.length) {
    root.append(tonedSection('orange', '≡', 'Düşüş Dökümü',
      'En derin geri çekilmeler ve toparlanma süreleri',
      h('p', { class: 'dim', style: 'margin:0 0 12px;font-size:.85rem' },
        'Bir düşüşün ne kadar derin olduğu kadar, kaç ay boyunca zararda '
        + 'kaldığın da önemlidir. "Toparlanma" sütunu, portföyün eski zirvesine '
        + 'dönmesinin ne kadar sürdüğünü gösterir.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { style: 'text-align:left' }, 'Zirve'),
          h('th', { style: 'text-align:left' }, 'Dip'),
          h('th', {}, 'Derinlik'),
          h('th', {}, 'Düşüş süresi'),
          h('th', { style: 'text-align:left' }, 'Toparlanma'))),
        h('tbody', {}, donemler.map((d) => h('tr', {},
          h('td', {}, fmtDate(d.peakDate)),
          h('td', {}, fmtDate(d.troughDate)),
          h('td', { class: 'down' }, pct(d.depth, 1)),
          h('td', {}, `${Math.abs(d.durationDays)} gün`),
          h('td', {}, d.recovered
            ? `${d.recoveryDays} günde toparladı`
            : h('span', { class: 'pill down' }, `${d.recoveryDays} gündür sürüyor`)))))))));
  }

  /* ------------------------------------------------------- yuvarlanan getiriler */

  const pencereler = [
    { gun: 90, ad: '3 aylık' },
    { gun: 365, ad: '1 yıllık' },
  ].map((p) => ({ ...p, sonuc: rollingReturns(series.dates, series.twr, p.gun) }))
    .filter((p) => p.sonuc);

  if (pencereler.length) {
    root.append(tonedSection('teal', '↻', 'Yuvarlanan Getiriler',
      'Geçmişteki tüm dönemler üzerinden - tek bir şanslı dönemi tutarlılıktan ayırır',
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { style: 'text-align:left' }, 'Pencere'),
          h('th', {}, 'En kötü'), h('th', {}, 'Ortanca'), h('th', {}, 'En iyi'),
          h('th', {}, 'Kazançlı oran'), h('th', {}, 'Dönem sayısı'))),
        h('tbody', {}, pencereler.map((p) => h('tr', {},
          h('td', {}, p.ad),
          h('td', { class: cls(p.sonuc.worst) }, pctSigned(p.sonuc.worst, 1)),
          h('td', { class: cls(p.sonuc.median) }, pctSigned(p.sonuc.median, 1)),
          h('td', { class: cls(p.sonuc.best) }, pctSigned(p.sonuc.best, 1)),
          h('td', {}, pct(p.sonuc.positiveShare, 0)),
          h('td', { class: 'dim' }, String(p.sonuc.count)))))))));
  }

  /* --------------------------------------------------------------- çeşitlendirme */

  const cesit = diversification(open);
  if (cesit && open.length > 1) {
    root.append(tonedSection('violet', '◔', 'Çeşitlendirme',
      'Kaç bağımsız bahis tuttuğun',
      h('div', { class: 'grid grid-3' },
        kpiCard({
          label: 'Etkin Bahis Sayısı',
          value: isNum(cesit.effN) ? num(cesit.effN, 1) : '—',
          sub: `${open.length} fon tutuyorsun`,
          hint: 'Fonlar birlikte hareket ettikçe bu sayı fon sayısının altına düşer',
        }),
        kpiCard({
          label: 'Ağırlık Dengesi',
          value: num(cesit.hhi, 1),
          sub: 'Korelasyonu yok sayarsak kaç eşit fona denk',
          hint: 'Fon sayısına yakınsa ağırlıklar dengeli demektir',
        })),
      h('p', { class: 'dim', style: 'margin:12px 0 0;font-size:.85rem' },
        isNum(cesit.effN) && cesit.effN < open.length * 0.6
          ? `${open.length} farklı fonun var ama birlikte hareket ettikleri için `
            + `yaklaşık ${num(cesit.effN, 1)} bağımsız bahis gibi davranıyorlar. `
            + 'Çeşitlendirme beklediğin kadar koruma sağlamıyor olabilir.'
          : 'Fonların büyük ölçüde birbirinden bağımsız hareket ediyor.')));
  }

  return root;
}
