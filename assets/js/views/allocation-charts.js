/* Dağılım sekmesi grafikleri:
   - Alan haritası (treemap): kutu alanı = değer, renk = kâr/zarar yüzdesi (kırmızı · gri · yeşil).
   - Ay ay dağılım: ay sonu kayıtlarından %100 yığılmış sütunlar. */

import { h, tl, pct, pctSigned, isNum } from '../util.js';
import { assetType } from '../asset-groups.js';

/* --------------------------------------------------------------- yardımcılar */

// Varlık sınıfı → sabit renk (sıra değil varlık belirler). Açık ve koyu tema
// için ayrı adımlar, ikisi de renk körlüğü ve kontrast kontrolünden geçti.
export const CLASS_ORDER = ['Fon', 'Hisse', 'ETF', 'Kripto', 'Nakit'];
const CLASS_LABELS = { Fon: 'Fon', Hisse: 'Hisse', ETF: 'ETF', Kripto: 'Kripto', Nakit: 'Nakit', Diğer: 'Diğer' };

let tooltipEl = null;
function tooltip() {
  if (!tooltipEl) {
    tooltipEl = h('div', { class: 'viz-tooltip', role: 'status', hidden: true });
    document.body.append(tooltipEl);
  }
  return tooltipEl;
}
function showTip(event, lines) {
  const tip = tooltip();
  tip.replaceChildren(...lines.map((line, index) => h(index ? 'div' : 'strong', {}, line)));
  tip.hidden = false;
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, event.clientX + 12);
  const y = Math.min(window.innerHeight - tip.offsetHeight - 8, event.clientY + 12);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { if (tooltipEl) tooltipEl.hidden = true; }
function hoverable(el, lines) {
  el.addEventListener('pointermove', (event) => showTip(event, lines()));
  el.addEventListener('pointerdown', (event) => showTip(event, lines()));
  el.addEventListener('pointerleave', hideTip);
  return el;
}

/* ------------------------------------------------------- squarified treemap */

// Bruls, Huizing & van Wijk (2000): satırları en iyi en-boy oranına göre doldurur.
function squarify(items, x, y, w, hgt) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!items.length || total <= 0 || w <= 0 || hgt <= 0) return [];
  const scale = (w * hgt) / total;
  const nodes = items.map((item) => ({ item, area: item.value * scale }));
  const out = [];
  let rect = { x, y, w, h: hgt };
  let row = [];
  const worst = (r, side) => {
    const s = r.reduce((sum, n) => sum + n.area, 0);
    const max = Math.max(...r.map((n) => n.area));
    const min = Math.min(...r.map((n) => n.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const layoutRow = (r) => {
    const s = r.reduce((sum, n) => sum + n.area, 0);
    if (rect.w >= rect.h) {
      const colW = s / rect.h;
      let cy = rect.y;
      for (const n of r) { const nh = n.area / colW; out.push({ ...n, x: rect.x, y: cy, w: colW, h: nh }); cy += nh; }
      rect = { x: rect.x + colW, y: rect.y, w: rect.w - colW, h: rect.h };
    } else {
      const rowH = s / rect.w;
      let cx = rect.x;
      for (const n of r) { const nw = n.area / rowH; out.push({ ...n, x: cx, y: rect.y, w: nw, h: rowH }); cx += nw; }
      rect = { x: rect.x, y: rect.y + rowH, w: rect.w, h: rect.h - rowH };
    }
  };
  for (const node of nodes) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, node], side) <= worst(row, side)) row.push(node);
    else { layoutRow(row); row = [node]; }
  }
  if (row.length) layoutRow(row);
  return out;
}

/* Kırmızı · gri · yeşil ıraksak skala; tam doygunluk `limit` yüzdesinde. */
const NEG = [214, 64, 74];
const MID = [107, 118, 134];
const POS = [15, 141, 80];
function plColor(value, limit) {
  if (!isNum(value)) return `rgb(${MID.join(',')})`;
  const t = Math.min(1, Math.abs(value) / limit);
  const end = value >= 0 ? POS : NEG;
  return `rgb(${MID.map((m, i) => Math.round(m + (end[i] - m) * t)).join(',')})`;
}

/**
 * Alan haritası. rows: { code, kind, category, currency, marketValueTRY, dailyPct, totalPct, frozen }.
 * Varlıklar sınıflara (Fon/ETF/...) göre bloklanır; blok içinde değere göre dizilir.
 */
export function treemapCard(rows) {
  const items = rows.filter((row) => isNum(row.marketValueTRY) && row.marketValueTRY > 0);
  const total = items.reduce((sum, row) => sum + row.marketValueTRY, 0);
  let mode = 'daily';
  const box = h('div', { class: 'treemap', role: 'img', 'aria-label': 'Varlıkların değere göre alan haritası' });
  const legend = h('div', { class: 'treemap-legend' });
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Renk ölçüsü' });
  const buttons = [['daily', 'Günlük'], ['total', 'Toplam K/Z']].map(([key, label]) => {
    const button = h('button', { type: 'button', 'aria-pressed': String(key === mode) }, label);
    button.addEventListener('click', () => {
      mode = key;
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(['daily', 'total'][i] === mode)));
      draw();
    });
    seg.append(button);
    return button;
  });

  const groups = new Map();
  for (const row of items) {
    const type = assetType(row.code, row.kind, row.category);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(row);
  }
  const groupList = [...groups.entries()].map(([type, list]) => ({
    type, value: list.reduce((sum, row) => sum + row.marketValueTRY, 0),
    rows: [...list].sort((a, b) => b.marketValueTRY - a.marketValueTRY),
  })).sort((a, b) => b.value - a.value);

  function draw() {
    const width = box.clientWidth;
    if (!width) return;
    const height = Math.max(260, Math.min(460, Math.round(width * 0.52)));
    box.style.height = `${height}px`;
    const limit = mode === 'daily' ? 3 : 20;
    const valueOf = (row) => (row.frozen ? null : mode === 'daily' ? row.dailyPct : row.totalPct);
    const cells = [];
    for (const g of squarify(groupList.map((group) => ({ ...group })), 0, 0, width, height)) {
      const group = g.item;
      const labelH = g.h > 60 && g.w > 90 ? 18 : 0;
      cells.push(h('div', {
        class: 'treemap-group',
        style: `left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px`,
      }, labelH ? h('span', { class: 'treemap-group-label' },
        `${CLASS_LABELS[group.type] || group.type} · ${pct(group.value / total * 100, 1)}`) : null));
      const inner = squarify(group.rows.map((row) => ({ ...row, value: row.marketValueTRY })),
        g.x + 1, g.y + 1 + labelH, g.w - 2, g.h - 2 - labelH);
      for (const n of inner) {
        const row = n.item;
        const value = valueOf(row);
        const big = n.w >= 58 && n.h >= 36;
        const cell = h('div', {
          class: `treemap-cell${big ? '' : ' small'}`,
          style: `left:${n.x + 1}px;top:${n.y + 1}px;width:${Math.max(0, n.w - 2)}px;height:${Math.max(0, n.h - 2)}px;background:${plColor(value, limit)}`,
        }, big ? h('b', {}, row.code) : null,
        big && n.h >= 50 ? h('span', {}, row.frozen ? 'sabit' : isNum(value) ? pctSigned(value) : '—') : null);
        hoverable(cell, () => [
          row.code,
          `${tl(row.marketValueTRY)} · portföyün ${pct(row.marketValueTRY / total * 100, 1)}`,
          row.frozen ? 'Temerrüt: fiyat sabit' : `Günlük ${isNum(row.dailyPct) ? pctSigned(row.dailyPct) : '—'} · Toplam ${isNum(row.totalPct) ? pctSigned(row.totalPct) : '—'}`,
        ]);
        cells.push(cell);
      }
    }
    box.replaceChildren(...cells);
    legend.replaceChildren(
      h('span', {}, `−%${limit} ve altı`),
      h('i', { class: 'treemap-scale', style: `background:linear-gradient(90deg, ${plColor(-limit, limit)}, ${plColor(0, limit)}, ${plColor(limit, limit)})` }),
      h('span', {}, `+%${limit} ve üstü`),
      h('span', { class: 'dim' }, ' · kutu büyüklüğü = değer'));
  }

  const card = h('div', { class: 'stack', style: 'gap:10px' },
    h('div', { class: 'treemap-toolbar' }, seg, legend), box);
  if (!items.length) return h('p', { class: 'dim', style: 'margin:0' }, 'Değeri hesaplanan varlık yok.');
  // Kutu genişliği belli olunca ve her boyut değişiminde yeniden çizilir.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => draw()).observe(box);
  requestAnimationFrame(draw);
  return card;
}

/* ------------------------------------------------- ay ay %100 yığılmış sütun */

const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const monthName = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;

/** snapshots: { 'YYYY-MM': { total, cash, rows: [{ group, value }] } } */
export function monthlyAllocationCard(snapshots, currentMonth) {
  const months = Object.keys(snapshots || {}).filter((key) => /^\d{4}-\d{2}$/.test(key)).sort().slice(-12);
  if (!months.length) {
    return h('p', { class: 'dim', style: 'margin:0' }, 'Ay sonu kaydı henüz yok. Siteyi ay içinde açmak kaydı oluşturur.');
  }
  const series = months.map((month) => {
    const snap = snapshots[month] || {};
    const sums = new Map();
    for (const row of snap.rows || []) {
      if (!(row.value > 0)) continue;
      const key = CLASS_ORDER.includes(row.group) ? row.group : 'Diğer';
      sums.set(key, (sums.get(key) || 0) + row.value);
    }
    if (snap.cash > 0.5) sums.set('Nakit', (sums.get('Nakit') || 0) + snap.cash);
    const total = [...sums.values()].reduce((a, b) => a + b, 0);
    return { month, total, parts: [...CLASS_ORDER, 'Diğer'].filter((k) => sums.get(k) > 0).map((k) => ({ key: k, value: sums.get(k) })) };
  });
  const used = [...CLASS_ORDER, 'Diğer'].filter((key) => series.some((s) => s.parts.some((p) => p.key === key)));

  const legend = h('div', { class: 'stack-legend' }, used.map((key) => h('span', {},
    h('i', { class: `cls-${key === 'Diğer' ? 'diger' : key.toLowerCase()}` }), CLASS_LABELS[key])));
  const columns = h('div', { class: 'stack-cols', style: `--cols:${Math.max(series.length, 3)}` }, series.map((s) => h('div', { class: 'stack-col' },
    h('div', { class: 'stack-bar' }, s.parts.map((p) => {
      const share = s.total > 0 ? p.value / s.total * 100 : 0;
      const seg = h('div', {
        class: `stack-seg cls-${p.key === 'Diğer' ? 'diger' : p.key.toLowerCase()}`,
        style: `flex:${share}`,
      }, share >= 9 ? h('span', {}, pct(share, 0)) : null);
      return hoverable(seg, () => [`${monthName(s.month)} · ${CLASS_LABELS[p.key]}`, `${pct(share, 1)} · ${tl(p.value)}`]);
    })),
    h('div', { class: 'stack-label' }, monthName(s.month), s.month === currentMonth ? h('small', {}, 'devam') : null))));
  const note = series.length < 3
    ? h('p', { class: 'dim', style: 'margin:0;font-size:.8rem' },
      `İlk kayıt ${monthName(months[0])}. Her ay sonunda bir sütun eklenir; ağırlıkların kayması birkaç ay sonra belirginleşir.`)
    : null;
  // Erişilebilir tablo görünümü: renk dışında da okunabilsin.
  const table = h('details', { class: 'stack-table' },
    h('summary', {}, 'Tablo olarak göster'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Ay'), used.map((key) => h('th', {}, CLASS_LABELS[key])))),
      h('tbody', {}, series.map((s) => h('tr', {}, h('td', {}, monthName(s.month)), used.map((key) => {
        const part = s.parts.find((p) => p.key === key);
        return h('td', {}, part && s.total > 0 ? pct(part.value / s.total * 100, 1) : '—');
      })))))));
  return h('div', { class: 'stack', style: 'gap:12px' }, legend, columns, note, table);
}

/* ------------------------------------- tek çubukta varlık sınıfları (Quant sepet çubuğu) */

// Fon kategorileri için mavinin tonları (koyu → açık; beyaz yazı okunur kalır).
const FUND_SHADES = ['#123f86', '#1f5fbf', '#3b7ddd', '#0b2a5b', '#2f6fd0', '#5a8fe0'];

/**
 * classes: [{ key: 'Fon'|'ETF'|..., value, rows? }] · total: portföy toplamı.
 * Dilimlerin içinde "Fon %89" yazar; altındaki satırlarda tutar ve günlük/toplam K/Z.
 */
// Açılan sınıflar (ör. Fon) sayfa yeniden çizilse de açık kalır.
const expandedClasses = new Set();

export function classBarCard(classes, total, { plOf } = {}) {
  const parts = classes.filter((c) => c.value > 0)
    .sort((a, b) => CLASS_ORDER.indexOf(a.key) - CLASS_ORDER.indexOf(b.key));
  if (!parts.length || !(total > 0)) return h('p', { class: 'dim', style: 'margin:0' }, 'Değeri hesaplanan varlık yok.');
  const clsName = (key) => `cls-${key === 'Diğer' ? 'diger' : key.toLowerCase()}`;
  const subsOf = (c) => (c.subs || []).filter((sub) => sub.value > 0);
  const expandable = (c) => subsOf(c).length > 1;
  const toggle = (c) => {
    if (expandedClasses.has(c.key)) expandedClasses.delete(c.key); else expandedClasses.add(c.key);
    hideTip();
    render();
  };
  const root = h('div', { class: 'stack', style: 'gap:12px' });

  function render() {
    // Kapalıyken sınıf tek dilim; açılınca kategorilerine (sınıf renginin tonları) bölünür.
    const segments = parts.flatMap((c) => (expandable(c) && expandedClasses.has(c.key)
      ? subsOf(c).map((sub, index) => ({ parent: c, label: sub.label, value: sub.value, shade: FUND_SHADES[index % FUND_SHADES.length] }))
      : [{ parent: c, label: CLASS_LABELS[c.key] || c.key, value: c.value }]));
    const bar = h('div', { class: 'class-bar' }, segments.map((seg) => {
      const share = seg.value / total * 100;
      const el = h('span', {
        class: `${clsName(seg.parent.key)}${expandable(seg.parent) ? ' clickable' : ''}`,
        style: `flex:${share}${seg.shade ? `;background:${seg.shade}` : ''}`,
      }, share >= 7 ? `${seg.label} ${pct(share, 1)}` : '');
      if (expandable(seg.parent)) el.addEventListener('click', () => toggle(seg.parent));
      return hoverable(el, () => [seg.shade ? `${CLASS_LABELS[seg.parent.key]} · ${seg.label}` : seg.label, `${pct(share, 1)} · ${tl(seg.value)}`]);
    }));
    const rows = h('div', { class: 'class-rows' }, parts.flatMap((c) => {
      const open = expandable(c) && expandedClasses.has(c.key);
      const pl = plOf ? plOf(c) : null;
      const main = h(expandable(c) ? 'button' : 'div', {
        class: `class-row${expandable(c) ? ' clickable' : ''}`,
        type: expandable(c) ? 'button' : null,
        'aria-expanded': expandable(c) ? String(open) : null,
        onclick: expandable(c) ? () => toggle(c) : null,
      },
      h('i', { class: clsName(c.key) }),
      h('span', { class: 'class-name' }, CLASS_LABELS[c.key] || c.key,
        expandable(c) ? h('span', { class: 'class-caret' }, open ? '▾' : '▸') : null),
      h('b', {}, pct(c.value / total * 100, 1)),
      h('span', { class: 'class-value' }, tl(c.value)),
      pl || h('span', {}));
      const subs = open ? subsOf(c).map((sub, index) => h('div', { class: 'class-row sub' },
        h('i', { style: `background:${FUND_SHADES[index % FUND_SHADES.length]}` }),
        h('span', { class: 'class-name' }, sub.label),
        h('b', {}, pct(sub.value / total * 100, 1)),
        h('span', { class: 'class-value' }, tl(sub.value)),
        sub.pl || h('span', {}))) : [];
      return [main, ...subs];
    }));
    root.replaceChildren(bar, rows);
  }
  render();
  return root;
}
