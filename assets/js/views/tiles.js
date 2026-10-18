/* Varlık kutucukları (TEFAS Quant "kategori liderleri" düzeni).
   Panel ve Dağılım aynı kutucukları kullanır: her varlık bir kutucuk,
   fonlar türlerine göre (PPF'ler yan yana) şeritlerle ayrılır. */

import { h, tl, tlSigned, pct, pctSigned, units as fmtUnits, cls, isNum } from '../util.js';
import { DB } from '../data.js';
import { assetLabel, groupFundsByType } from '../asset-groups.js';
import { assetLogo } from '../logos.js';

export function moneyByCurrency(value, currency) {
  if (!isNum(value)) return '—';
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency', currency: currency === 'USD' ? 'USD' : 'TRY', maximumFractionDigits: 2,
  }).format(value);
}

function signedMoney(value, currency) {
  if (!isNum(value)) return '—';
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${moneyByCurrency(Math.abs(value), currency)}`;
}

/** "ZİRAAT PORTFÖY BAŞAK PARA PİYASASI (TL) FONU" → { issuer: "ZİRAAT PORTFÖY", name: "BAŞAK PARA PİYASASI" } */
export function fundParts(code) {
  const full = String(DB.byCode.get(code)?.name || '').replace(/\s*YÖNETİMİ A\.Ş\.?/i, '');
  const match = full.match(/^(.*?PORTFÖY)\s+(.*)$/);
  const clean = (text) => text.replace(/\s+FONU?\b/g, '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return { issuer: match ? match[1] : '', name: clean(match ? match[2] : full) };
}

const TOP_LABELS = { ETF: 'ETF', Hisse: 'Hisse', Kripto: 'Kripto', Diğer: 'Varlık' };

/**
 * Tek kutucuk. Genel yapı: üstte logo + küçük başlık + pay rozeti, büyük kod,
 * kısa ad, üç rakam ve en altta ayrıntı satırı.
 */
export function tile({ code, kind, currency, top, name, share, frozen, figs, foot, accent }) {
  return h('article', { class: `fund-tile${frozen ? ' is-frozen' : ''}`, style: accent ? `--sec:${accent}` : null },
    h('div', { class: 'fund-tile-top' },
      assetLogo(code, { kind, currency }),
      h('span', { class: 'fund-tile-type' }, top || ''),
      isNum(share) ? h('span', { class: 'fund-tile-share' }, pct(share, 1)) : null),
    h('div', { class: 'fund-tile-code' }, code),
    h('div', { class: 'fund-tile-name' }, name || ''),
    h('div', { class: 'fund-tile-figs' }, figs.map((fig) => h('div', { class: [fig.className || '', cls(fig.tone)].join(' ').trim() },
      h('span', {}, fig.label), h('b', {}, fig.value), fig.sub ? h('em', {}, fig.sub) : null))),
    foot ? h('div', { class: 'fund-tile-foot' }, ...foot.map((text) => h('span', {}, text))) : null);
}

/** Midas pozisyonu için kutucuk: Değer · Günlük · Toplam K/Z (telefonda Günlük ⇄ Toplam). */
export function positionTile(r, { type, valuesOk = true, accent } = {}) {
  const fund = type === 'Fon';
  const parts = fund ? fundParts(r.code) : null;
  const label = assetLabel(r.code) || '';
  const daily = r.frozen ? '—' : r.noDailyChange || isNum(r.dailyPLNative) ? signedMoney(r.dailyPLNative, r.currency) : '—';
  const total = r.frozen ? 'temerrüt' : valuesOk && isNum(r.totalPLNative) ? signedMoney(r.totalPLNative, r.currency) : '—';
  return tile({
    code: r.code, kind: r.kind, currency: r.currency, frozen: r.frozen, accent,
    top: fund ? parts.issuer || 'Fon' : `${TOP_LABELS[type] || 'Varlık'}${r.currency === 'USD' ? ' · USD' : ''}`,
    name: fund ? parts.name || label : label.replace(/\s*·.*$/, '') || DB.byCode.get(r.code)?.name || '',
    share: r.localRecord ? null : r.allocationPct,
    figs: [
      { label: 'Değer', className: 'fig-value', value: valuesOk && isNum(r.marketValueTRY) ? tl(r.marketValueTRY) : '—' },
      { label: 'Günlük', className: 'col-daily', tone: r.frozen ? null : r.dailyPLNative, value: daily,
        sub: !r.frozen && isNum(r.dailyPct) ? pctSigned(r.dailyPct) : null },
      { label: 'Toplam K/Z', className: 'col-total', tone: r.frozen ? null : r.totalPLNative, value: total,
        sub: !r.frozen && isNum(r.totalPct) ? pctSigned(r.totalPct) : null },
    ],
    foot: [`${fmtUnits(r.units)} adet`,
      `${moneyByCurrency(r.price, r.currency)}${isNum(r.avgCost) ? ` · ort. ${moneyByCurrency(r.avgCost, r.currency)}` : ''}`],
  });
}

// Fon türü renkleri (TEFAS Quant paleti); dağılım çubuğu ve kutucuk üst çizgisi aynı rengi taşır.
const TYPE_COLORS = ['#1f5fbf', '#ea580c', '#7c3aed', '#0891b2', '#c58b12', '#0b2a5b', '#be123c', '#15803d'];

/** Grubun günlük ve toplam kâr/zararı ile yüzdeleri (temerrüttekiler hariç). */
export function groupPL(rows) {
  let daily = 0, dailyBase = 0, total = 0, cost = 0;
  for (const row of rows || []) {
    if (row.frozen || !isNum(row.marketValueTRY)) continue;
    if (isNum(row.dailyPLTRY)) { daily += row.dailyPLTRY; dailyBase += row.marketValueTRY - row.dailyPLTRY; }
    if (isNum(row.totalPLTRY)) { total += row.totalPLTRY; cost += row.marketValueTRY - row.totalPLTRY; }
  }
  return {
    daily, dailyPct: dailyBase > 0 ? daily / dailyBase * 100 : null,
    total, totalPct: cost > 0 ? total / cost * 100 : null,
  };
}

/** Başlık için iki yeşil/kırmızı rozet: Günlük ve Toplam. */
export function plBadge(rows) {
  const pl = groupPL(rows);
  const badge = (label, amount, amountPct) => (isNum(amountPct)
    ? h('span', { class: `pl-badge ${cls(amount)}` },
      h('small', {}, label), `${amount >= 0 ? '▲' : '▼'} ${tlSigned(amount)} · ${pctSigned(amountPct)}`)
    : null);
  const badges = [badge('Günlük', pl.daily, pl.dailyPct), badge('Toplam', pl.total, pl.totalPct)].filter(Boolean);
  return badges.length ? h('span', { class: 'pl-badges' }, badges) : null;
}

/** Quant "Not dağılımı" gibi: türlerin tek çubukta payları ve açıklama satırı. */
function typeDistribution(types, total) {
  return h('div', { class: 'type-dist' },
    h('div', { class: 'dist-bar' }, types.map((t) => h('span', {
      style: `flex:${Math.max(0.0001, t.value)};background:${t.color}`, title: `${t.type}: ${pct(t.value / total * 100, 1)}`,
    }))),
    h('div', { class: 'dist-legend' }, types.map((t) => h('div', { class: 'dist-item' },
      h('i', { style: `background:${t.color}` }),
      h('span', {}, t.type),
      h('b', {}, total > 0 ? pct(t.value / total * 100, 1) : '—'),
      h('em', {}, tl(t.value))))));
}

/**
 * Grubun yalnızca oran dağılımı (Dağılım sekmesi): fonlarda türler
 * (Hisse Senedi Yoğun, PPF…), diğer gruplarda varlıkların grup içi payı.
 */
export function groupDistribution(group) {
  const parts = group.label === 'Fon'
    ? groupFundsByType(group.rows).map((t) => ({ type: t.type, value: t.value }))
    : group.rows.filter((row) => isNum(row.marketValueTRY) && row.marketValueTRY > 0)
      .map((row) => ({ type: assetLabel(row.code) ? `${row.code} · ${assetLabel(row.code).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*·.*$/, '').trim()}` : row.code, value: row.marketValueTRY }));
  const sorted = parts.filter((t) => t.value > 0).sort((a, b) => b.value - a.value)
    .map((t, index) => ({ ...t, color: TYPE_COLORS[index % TYPE_COLORS.length] }));
  const total = sorted.reduce((sum, t) => sum + t.value, 0);
  return total > 0 ? typeDistribution(sorted, total) : h('p', { class: 'dim', style: 'margin:0' }, 'Değeri hesaplanan varlık yok.');
}

/** Bir varlık grubunun kutucukları; fonlarda üstte tür dağılım çubuğu. */
export function groupTiles(group, { share = () => null, valuesOk = true } = {}) {
  const grid = (rows) => h('div', { class: 'fund-tiles pos-tiles' },
    rows.map((row) => positionTile(row, { type: group.label, valuesOk })));
  if (group.label !== 'Fon') return [grid(group.rows)];
  // Fonlar tek ızgarada; aynı türdekiler yan yana, tür rengi kutucuğun üst çizgisinde.
  const types = groupFundsByType(group.rows).map((fundGroup, index) => ({ ...fundGroup, color: TYPE_COLORS[index % TYPE_COLORS.length] }));
  const total = types.reduce((sum, t) => sum + t.value, 0);
  return [
    typeDistribution(types, total),
    h('div', { class: 'fund-tiles pos-tiles' }, types.flatMap((t) =>
      t.rows.map((row) => positionTile(row, { type: 'Fon', valuesOk, accent: t.color })))),
  ];
}
