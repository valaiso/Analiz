/* Varlık kutucukları (TEFAS Quant "kategori liderleri" düzeni).
   Panel ve Dağılım aynı kutucukları kullanır: her varlık bir kutucuk,
   fonlar türlerine göre (PPF'ler yan yana) şeritlerle ayrılır. */

import { h, tl, pct, pctSigned, units as fmtUnits, cls, isNum } from '../util.js';
import { DB } from '../data.js';
import { assetLabel, groupFundsByType } from '../asset-groups.js';
import { assetLogo } from '../logos.js';
import { groupStrip } from './common.js';

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
export function tile({ code, kind, currency, top, name, share, frozen, figs, foot }) {
  return h('article', { class: `fund-tile${frozen ? ' is-frozen' : ''}` },
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
export function positionTile(r, { type, valuesOk = true } = {}) {
  const fund = type === 'Fon';
  const parts = fund ? fundParts(r.code) : null;
  const label = assetLabel(r.code) || '';
  const daily = r.frozen ? '—' : r.noDailyChange || isNum(r.dailyPLNative) ? signedMoney(r.dailyPLNative, r.currency) : '—';
  const total = r.frozen ? 'temerrüt' : valuesOk && isNum(r.totalPLNative) ? signedMoney(r.totalPLNative, r.currency) : '—';
  return tile({
    code: r.code, kind: r.kind, currency: r.currency, frozen: r.frozen,
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

/**
 * Bir varlık grubunun kutucukları. Fonlar türe göre şeritlenir;
 * `share(value)` portföy payını yüzde olarak döndürür.
 */
export function groupTiles(group, { share = () => null, valuesOk = true } = {}) {
  const grid = (rows) => h('div', { class: 'fund-tiles pos-tiles' },
    rows.map((row) => positionTile(row, { type: group.label, valuesOk })));
  if (group.label !== 'Fon') return [grid(group.rows)];
  return groupFundsByType(group.rows).map((fundGroup) => h('div', { class: 'sec-group' },
    groupStrip({
      label: fundGroup.type,
      value: `${tl(fundGroup.value)}${isNum(share(fundGroup.value)) ? ` · ${pct(share(fundGroup.value), 1)}` : ''}`,
      share: share(fundGroup.value),
    }),
    grid(fundGroup.rows)));
}
