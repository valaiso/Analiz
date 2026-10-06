/* Veri katmanı: yayımlanmış JSON dosyalarını yükler ve sorgular.
   Fon geçmişleri büyük olduğu için yalnızca ihtiyaç duyulan fonlar için
   istek atılır ve bellekte tutulur. */

import { isNum } from './util.js';

const DATA_URL = new URL('../../data/', import.meta.url).href;
const LOCAL_ASSET_KEY = 'analiz-local-market-assets-v1';

export const DB = {
  funds: [],            // funds.json içeriği
  byCode: new Map(),    // kod -> fon kaydı
  calendar: [],         // ["YYYY-MM-DD", ...] tüm veri günleri
  indexOf: new Map(),   // tarih -> takvim indeksi
  benchmarks: {},       // { BIST100: {label, unit, values:[...]}, ... }
  meta: {},
};

const historyCache = new Map();     // kod -> { i, p, filled }
const pending = new Map();          // kod -> Promise

async function getJSON(path, { bypassCache = false } = {}) {
  // 'reload' tarayıcı önbelleğini tamamen atlar; iOS'ta ana ekrana eklenmiş
  // uygulamada elle yenileme yapılamadığı için bu şart.
  const url = DATA_URL + path + (bypassCache ? `?t=${Date.now()}` : '');
  const res = await fetch(url, { cache: bypassCache ? 'reload' : 'no-cache' });
  if (!res.ok) throw new Error(`${path} yüklenemedi (HTTP ${res.status})`);
  return res.json();
}

/** Uygulama açılışında gereken küçük dosyaları yükler. */
export async function loadCore({ bypassCache = false } = {}) {
  const opt = { bypassCache };
  const [funds, calendar, benchmarks, meta] = await Promise.all([
    getJSON('funds.json', opt),
    getJSON('calendar.json', opt),
    getJSON('benchmarks.json', opt).catch(() => ({})),
    getJSON('meta.json', opt).catch(() => ({})),
  ]);
  DB.calendar = calendar;
  DB.benchmarks = benchmarks || {};
  DB.meta = meta || {};
  DB.indexOf = new Map(calendar.map((d, i) => [d, i]));
  const localAssets = readLocalAssets();
  const serverCodes = new Set(funds.map((fund) => fund.code));
  const localFunds = localAssets.filter((asset) => !serverCodes.has(asset.code))
    .map((asset) => installAssetInMemory(asset)).filter(Boolean);
  DB.funds = [...funds, ...localFunds];
  DB.byCode = new Map(DB.funds.map((f) => [f.code, f]));
  return DB;
}

function readLocalAssets() {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_ASSET_KEY) || '[]');
    return Array.isArray(value) ? value.filter((asset) => asset?.code && Array.isArray(asset.prices)) : [];
  } catch {
    return [];
  }
}

function installAssetInMemory(asset) {
  const byIndex = new Map();
  for (const point of asset.prices) {
    if (!point?.date || !isNum(point.price) || point.price <= 0) continue;
    const idx = indexForDate(point.date);
    if (idx >= 0) byIndex.set(idx, point.price);
  }
  if (!byIndex.size) return null;
  const first = Math.min(...byIndex.keys());
  const end = Math.max(...byIndex.keys());
  const prices = Array.from({ length: end - first + 1 }, (_, offset) => byIndex.get(first + offset) ?? null);
  const history = { i: first, p: prices, filled: forwardFill(prices), local: true };
  historyCache.set(asset.code, history);
  const latest = asset.prices[asset.prices.length - 1];
  return {
    code: asset.code, name: asset.name || asset.code, kind: asset.kind || 'HISSE',
    cat: asset.category || 'Hisse Senedi', catSrc: asset.source || 'local',
    currency: asset.currency || 'TRY', price: latest?.price ?? null,
    date: latest?.date || null, chg: null, ret: {}, vol: null, mdd: null,
    size: 0, inv: 0, alloc: {}, i0: first, n: prices.length, localMarketData: true,
  };
}

/** Add fetched market history to this browser's private data pool. */
export function addLocalMarketAssets(assets) {
  const current = new Map(readLocalAssets().map((asset) => [asset.code, asset]));
  let added = 0;
  for (const asset of assets || []) {
    if (!asset?.code || !Array.isArray(asset.prices) || (!asset.partial && asset.prices.length < 20)) continue;
    const code = String(asset.code).trim().toLocaleUpperCase('tr');
    const existingMeta = DB.byCode.get(code);
    if (existingMeta && !existingMeta.localMarketData) continue;
    const clean = {
      code, name: String(asset.name || code), kind: String(asset.kind || 'HISSE'),
      category: String(asset.category || 'Hisse Senedi'), currency: asset.currency === 'USD' ? 'USD' : 'TRY',
      source: String(asset.source || current.get(code)?.source || 'local'),
      prices: asset.prices.filter((point) => point?.date && isNum(point.price) && point.price > 0)
        .map((point) => ({ date: String(point.date).slice(0, 10), price: Number(point.price) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
    const previous = current.get(code);
    if (asset.partial && previous) {
      const byDate = new Map(previous.prices.map((point) => [point.date, point.price]));
      for (const point of clean.prices) byDate.set(point.date, point.price);
      clean.prices = [...byDate].map(([date, price]) => ({ date, price }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
    if (clean.prices.length < 20) continue;
    current.set(code, clean);
    const fund = installAssetInMemory(clean);
    if (fund) {
      const existingIndex = DB.funds.findIndex((entry) => entry.code === code);
      if (existingIndex >= 0) DB.funds[existingIndex] = fund;
      else DB.funds.push(fund);
      DB.byCode.set(code, fund);
      added += 1;
    }
  }
  if (added) localStorage.setItem(LOCAL_ASSET_KEY, JSON.stringify([...current.values()]));
  return added;
}

/** Bir fonun fiyat geçmişini yükler (önbelleklenir). */
export async function loadHistory(code) {
  if (historyCache.has(code)) return historyCache.get(code);
  if (pending.has(code)) return pending.get(code);

  const task = getJSON(`history/${encodeURIComponent(code)}.json`)
    .then((raw) => {
      const entry = { i: raw.i | 0, p: raw.p || [], filled: forwardFill(raw.p || []) };
      historyCache.set(code, entry);
      pending.delete(code);
      return entry;
    })
    .catch((err) => {
      pending.delete(code);
      // Fon TEFAS'tan kalkmış olabilir; boş geçmiş dön ki arayüz çökmesin.
      console.warn(`Geçmiş yüklenemedi: ${code}`, err);
      const entry = { i: 0, p: [], filled: [], missing: true };
      historyCache.set(code, entry);
      return entry;
    });

  pending.set(code, task);
  return task;
}

export function loadHistories(codes) {
  return Promise.all([...new Set(codes)].map(loadHistory));
}

export const cachedHistory = (code) => historyCache.get(code) || null;

/**
 * Tüm veriyi sunucudan yeniden çeker (önbelleği atlayarak).
 * Önceki son veri günü ile yenisini döndürür ki arayüz "yeni veri geldi mi"
 * sorusunu yanıtlayabilsin.
 */
export async function refreshData() {
  const oncekiGun = DB.meta.lastDataDate || null;
  historyCache.clear();
  pending.clear();
  await loadCore({ bypassCache: true });
  return { oncekiGun, yeniGun: DB.meta.lastDataDate || null };
}

/**
 * Boşlukları bir önceki geçerli fiyatla doldurur (tatil/eksik gün).
 * Sıfır ve negatif değerler geçersiz sayılır - TEFAS ara sıra fiyat
 * açıklanmayan günler için 0 yayımlıyor.
 */
function forwardFill(arr) {
  const out = new Array(arr.length);
  let last = null;
  for (let i = 0; i < arr.length; i++) {
    if (isNum(arr[i]) && arr[i] > 0) last = arr[i];
    out[i] = last;
  }
  return out;
}

/**
 * Takvim indeksindeki fiyat. Fonun verisi o gün yoksa en son bilinen fiyat
 * kullanılır; fon henüz kurulmamışsa null döner.
 */
export function priceAtIndex(hist, idx) {
  if (!hist || !hist.filled.length) return null;
  const k = idx - hist.i;
  if (k < 0) return null;
  if (k >= hist.filled.length) return hist.filled[hist.filled.length - 1];
  return hist.filled[k];
}

/** O günkü gerçek (ileri doldurulmamış) fiyat; yoksa null. */
export function exactPriceAtIndex(hist, idx) {
  if (!hist) return null;
  const k = idx - hist.i;
  const value = k >= 0 && k < hist.p.length ? hist.p[k] : null;
  return isNum(value) && value > 0 ? value : null;
}

/** ISO tarihi takvim indeksine çevirir; tam eşleşme yoksa önceki iş günü. */
export function indexForDate(iso) {
  if (DB.indexOf.has(iso)) return DB.indexOf.get(iso);
  const cal = DB.calendar;
  let lo = 0, hi = cal.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cal[mid] <= iso) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

/** Belirli bir tarihteki fon fiyatı (işlem formunda otomatik doldurma için). */
export async function priceOnDate(code, iso) {
  const idx = indexForDate(iso);
  if (idx < 0) return null;
  const hist = await loadHistory(code);
  return exactPriceAtIndex(hist, idx) ?? priceAtIndex(hist, idx);
}

export const lastIndex = () => DB.calendar.length - 1;
export const lastDate = () => DB.calendar[DB.calendar.length - 1];

/** Varlığın işlem/fiyat para birimi. ABD ETF'leri ve kripto USD, diğerleri TRY. */
export function currencyForCode(code) {
  const meta = DB.byCode.get(code);
  return meta?.currency === 'USD' || meta?.kind === 'US_ETF' || meta?.kind === 'CRYPTO'
    ? 'USD' : 'TRY';
}

/** Takvim günündeki USD/TRY; seri o güne kadar bilinen son kuru içerir. */
export function usdTryAtIndex(idx) {
  const rate = DB.benchmarks?.USDTRY?.values?.[idx];
  return isNum(rate) && rate > 0 ? rate : null;
}

/** Varlığın kendi para biriminden raporlama para birimi TRY'ye çeviri katsayısı. */
export function fxToTRY(code, idx) {
  return currencyForCode(code) === 'USD' ? usdTryAtIndex(idx) : 1;
}

/** Fon kodu/ünvanına göre arama (otomatik tamamlama). */
export function searchFunds(query, limit = 12) {
  const q = (query || '').trim().toLocaleUpperCase('tr');
  if (!q) return [];
  const starts = [], contains = [];
  for (const f of DB.funds) {
    if (f.code === q) { starts.unshift(f); continue; }
    if (f.code.startsWith(q)) starts.push(f);
    else if (f.code.includes(q) || f.name.toLocaleUpperCase('tr').includes(q)) contains.push(f);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
