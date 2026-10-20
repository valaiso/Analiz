/* Varlık logoları: kodun solunda yuvarlak simge.
   ABD ETF/hisse ve BIST hisseleri Financial Modeling Prep'in açık logo adresinden,
   kripto paralar cryptocurrency-icons paketinden gelir. Fonlarda kurucu portföy
   şirketinin logosu sitenin içinden (assets/logos/issuers) gelir. Logo yoksa veya
   yüklenemezse varlık sınıfı renginde baş harfler gösterilir. */

import { h } from './util.js';
import { DB } from './data.js';
import { assetType } from './asset-groups.js';

const FMP = 'https://financialmodelingprep.com/image-stock/';
const CRYPTO = 'https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/';

const ISSUER_DIR = new URL('assets/logos/issuers/', document.baseURI).href;

// Fon adının başı → kurucu şirketin logosu (assets/logos/issuers/<ad>.png).
const FUND_ISSUERS = [
  ['GARANTİ', 'garanti'], ['İŞ PORTFÖY', 'is'], ['DENİZ', 'deniz'], ['AK PORTFÖY', 'ak'],
  ['YAPI KREDİ', 'yapikredi'], ['ZİRAAT', 'ziraat'], ['QNB', 'qnb'], ['PARDUS', 'pardus'],
  ['KUVEYT TÜRK', 'kuveytturk'], ['ROTA', 'rota'], ['HEDEF', 'hedef'], ['İSTANBUL PORTFÖY', 'istanbul'],
  ['TÜRKİYE', 'turkiye'], ['ANADOLU HAYAT', 'anadolu'], ['NEO PORTFÖY', 'neo'], ['AGESA', 'agesa'],
  ['AKTİF', 'aktif'], ['INVEO', 'inveo'], ['ALLIANZ', 'allianz'], ['FİBA', 'fiba'],
  ['ALLBATROSS', 'allbatross'], ['HSBC', 'hsbc'], ['OSMANLI', 'osmanli'], ['RE-PIE', 'repie'],
  ['METLİFE', 'metlife'], ['ATA PORTFÖY', 'ata'], ['AXA', 'axa'], ['ALBARAKA', 'albaraka'],
  ['TACİRLER', 'tacirler'], ['PUSULA', 'pusula'], ['TERA', 'tera'], ['ÜNLÜ', 'unlu'],
  ['VAKIF', 'vakif'], ['HALK', 'halk'], ['BTCTURK', 'btcturk'],
];

const failed = new Set();       // yüklenemeyen adresler: her çizimde yeniden istenmez
const onDark = new Map();       // adres → beyaz/şeffaf logo mu (koyu zemin gerekir)

function fundIssuer(name) {
  const upper = String(name || '').toLocaleUpperCase('tr');
  return FUND_ISSUERS.find(([key]) => upper.startsWith(key))?.[1] || null;
}

function logoSource(code, kind, currency) {
  const meta = DB.byCode.get(code) || {};
  const type = assetType(code, kind || meta.kind);
  const resolvedKind = String(kind || meta.kind || '').toUpperCase();
  if (type === 'Kripto') return `${CRYPTO}${code.toLowerCase()}.svg`;
  if (type === 'Fon') {
    const issuer = fundIssuer(meta.name);
    return issuer ? `${ISSUER_DIR}${issuer}.png` : null;
  }
  const us = ['US_ETF', 'US_STOCK'].includes(resolvedKind) || (currency || meta.currency) === 'USD';
  return `${FMP}${encodeURIComponent(code)}${us ? '' : '.IS'}.png`;
}

function initials(code) {
  const meta = DB.byCode.get(code) || {};
  if (assetType(code, meta.kind) === 'Fon' && meta.name) {
    // Fonlarda portföy şirketinin baş harfleri (ör. ZİRAAT PORTFÖY → ZP).
    const words = String(meta.name).toLocaleUpperCase('tr').split(/\s+/).filter(Boolean);
    const portfoy = words.findIndex((word) => word === 'PORTFÖY' || word === 'PYŞ');
    if (portfoy > 0) return (words[portfoy - 1][0] + 'P');
  }
  return code.replace(/[^A-Z0-9ÇĞİÖŞÜ]/gi, '').slice(0, 3);
}

/** Beyaz/şeffaf logolar (ör. Invesco) beyaz zeminde kaybolmasın diye ölçülür. */
function measure(img, url) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 24; canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    const { data } = ctx.getImageData(0, 0, 24, 24);
    let opaque = 0, transparent = 0, light = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) { transparent += 1; continue; }
      opaque += 1;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] > 205) light += 1;
    }
    const dark = transparent > 24 * 24 * 0.15 && opaque > 0 && light / opaque > 0.6;
    onDark.set(url, dark);
    return dark;
  } catch {
    onDark.set(url, false);
    return false;
  }
}

/** Kodun solundaki yuvarlak logo. */
export function assetLogo(code, { kind = '', currency = '' } = {}) {
  const upper = String(code || '').toLocaleUpperCase('tr');
  const type = assetType(upper, kind);
  const fallback = h('span', { class: 'asset-logo-text' }, upper === 'NAKIT' ? '₺' : initials(upper));
  const holder = h('span', { class: `asset-logo logo-${type === 'Diğer' ? 'diger' : type.toLowerCase()}`, 'aria-hidden': 'true' }, fallback);
  const url = upper && upper !== 'NAKIT' ? logoSource(upper, kind, currency) : null;
  if (!url || failed.has(url)) return holder;
  const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', crossorigin: 'anonymous', referrerpolicy: 'no-referrer' });
  img.addEventListener('load', () => {
    const dark = onDark.has(url) ? onDark.get(url) : measure(img, url);
    holder.classList.toggle('on-dark', dark);
    holder.classList.add('has-img');
  });
  img.addEventListener('error', () => { failed.add(url); img.remove(); });
  img.src = url;
  holder.append(img);
  return holder;
}
