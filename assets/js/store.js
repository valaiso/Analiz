/* Kalıcı durum: profiller, işlemler, ayarlar.

   Ana portföy durumu localStorage'dadır ve oturum açıldığında app.js üzerinden
   Supabase'e eşitlenir. Midas içe aktarımları ayrı anahtarda yerel tutulur. */

const KEY = 'tefas-portfoy-v1';
// Midas'tan içe aktarılan işlemler yerel kalır; getState() / Supabase durumuna girmez.
const MIDAS_KEY = 'tefas-midas-import-v1';
const MIDAS_SNAPSHOT_KEY = 'tefas-midas-account-snapshot-v1';
const GENERIC_CRYPTO_CODES = new Set(['KRIPTO', 'CRYPTO', 'COIN', 'COINS']);
const listeners = new Set();

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function defaultState() {
  return {
    version: 1,
    activeProfile: 'ana',
    profiles: [{ id: 'ana', name: 'Portföyüm' }],
    tx: [],
    marketAssets: [],
    settings: { theme: 'auto', riskFree: 40, costMethod: 'ortalama' },
  };
}

function migrate(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const state = {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings || {}) },
  };
  if (!Array.isArray(state.profiles) || !state.profiles.length) state.profiles = base.profiles;
  if (!Array.isArray(state.tx)) state.tx = [];
  if (!Array.isArray(state.marketAssets)) state.marketAssets = [];
  if (!state.valueHistory || typeof state.valueHistory !== 'object' || Array.isArray(state.valueHistory)) {
    state.valueHistory = {};
  }
  // 3acb84d sürümü geçmiş günleri işlem kayıtlarından tahminle doldurmuştu.
  // Gerçek kayıt 2026-10-17'de başladı; tahmini günleri sil.
  if (state.valueHistorySeeded) {
    state.valueHistory = Object.fromEntries(Object.entries(state.valueHistory)
      .filter(([date]) => date >= '2026-10-17'));
    delete state.valueHistorySeeded;
  }
  // Eski sürüm hafta sonunu ayrı gün olarak kaydediyordu: Cumartesi/Pazar
  // kayıtları Cuma'ya taşınır (en geç tarihli hafta sonu değeri Cuma kapanışıdır).
  const weekendKeys = Object.keys(state.valueHistory).filter((date) => tradingDateFor(date) !== date).sort();
  for (const date of weekendKeys) {
    state.valueHistory[tradingDateFor(date)] = state.valueHistory[date];
    delete state.valueHistory[date];
  }
  // Silinmiş profile bağlı işlemleri ilk profile taşı.
  const ids = new Set(state.profiles.map((p) => p.id));
  for (const t of state.tx) if (!ids.has(t.profile)) t.profile = state.profiles[0].id;
  if (!ids.has(state.activeProfile) && state.activeProfile !== 'ALL') {
    state.activeProfile = state.profiles[0].id;
  }
  return state;
}

let state = load();
let midasTx = loadMidasTransactions();
let midasSnapshot = loadMidasSnapshot();
if (midasSnapshot && !state.midasPositionsCloud) syncMidasPositionsToCloud();

function loadMidasTransactions() {
  try {
    const value = JSON.parse(localStorage.getItem(MIDAS_KEY));
    return Array.isArray(value) ? value.filter((tx) => !(tx?.source === 'midas'
      && GENERIC_CRYPTO_CODES.has(String(tx.code || '').toLocaleUpperCase('en-US')))) : [];
  } catch {
    return [];
  }
}

function loadMidasSnapshot() {
  try {
    const value = JSON.parse(localStorage.getItem(MIDAS_SNAPSHOT_KEY));
    if (!value || typeof value !== 'object') return null;
    const originalCryptoPositions = Array.isArray(value.cryptoPositions) ? value.cryptoPositions : [];
    const cryptoPositions = Array.isArray(value.cryptoPositions)
      ? originalCryptoPositions.filter((position) => !GENERIC_CRYPTO_CODES.has(
        String(position?.code || '').toLocaleUpperCase('en-US')))
      : value.cryptoPositions;
    if (Array.isArray(value.cryptoPositions) && cryptoPositions.length !== originalCryptoPositions.length) {
      const removedPlaceholder = cryptoPositions.length !== originalCryptoPositions.length;
      const cleaned = { ...value, cryptoPositions,
        ...(removedPlaceholder ? { cryptoSummary: null, cryptoSummarySource: null, cryptoSummaryCapturedAt: null } : {}) };
      try { localStorage.setItem(MIDAS_SNAPSHOT_KEY, JSON.stringify(cleaned)); } catch { /* Bellekteki temiz kayıt yeterli. */ }
      return cleaned;
    }
    return value;
  } catch {
    return null;
  }
}

export const getMidasAccountSnapshot = () => midasSnapshot;

export function saveMidasAccountSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const hasStockUpdate = ['summary', 'positions', 'positionsCaptured']
    .some((key) => Object.prototype.hasOwnProperty.call(snapshot, key));
  const hasCryptoUpdate = ['cryptoSummary', 'cryptoPositions', 'cryptoPositionsCaptured']
    .some((key) => Object.prototype.hasOwnProperty.call(snapshot, key));
  const capturedAt = snapshot.capturedAt || new Date().toISOString();
  const stockCaptured = snapshot.positionsCaptured === true
    && Array.isArray(snapshot.positions);
  const cryptoCaptured = snapshot.cryptoPositionsCaptured === true
    && Array.isArray(snapshot.cryptoPositions);
  const validCryptoPositions = cryptoCaptured ? snapshot.cryptoPositions.filter((position) => !GENERIC_CRYPTO_CODES.has(
    String(position?.code || '').toLocaleUpperCase('en-US'))) : [];
  const removedGenericCrypto = cryptoCaptured && validCryptoPositions.length !== snapshot.cryptoPositions.length;
  const prior = midasSnapshot || {};
  midasSnapshot = { ...prior, capturedAt };
  if (hasStockUpdate) {
    const summaryValid = Number.isFinite(snapshot.summary?.totalValue) && snapshot.summary.totalValue >= 0;
    if (stockCaptured) {
      midasSnapshot = {
        ...midasSnapshot,
        summary: summaryValid ? snapshot.summary : null,
        summarySource: summaryValid ? 'midas-visible-v1' : null,
        summaryCapturedAt: summaryValid ? capturedAt : null,
        positions: snapshot.positions,
        positionsCaptured: true,
        positionsSource: 'midas-visible-v1',
        stockCapturedAt: capturedAt,
        stockScanFailedAt: null,
        positionsDiagnostic: null,
      };
    } else {
      // An incomplete screen scan must not erase the last valid snapshot. Old
      // snapshots without an authority marker are deliberately not trusted.
      midasSnapshot = {
        ...midasSnapshot,
        summary: summaryValid ? snapshot.summary : prior.summary,
        summarySource: summaryValid ? 'midas-visible-v1' : prior.summarySource,
        summaryCapturedAt: summaryValid ? capturedAt : prior.summaryCapturedAt || null,
        positions: prior.positionsSource === 'midas-visible-v1' ? prior.positions : [],
        positionsCaptured: prior.positionsSource === 'midas-visible-v1' && prior.positionsCaptured === true,
        positionsSource: prior.positionsSource === 'midas-visible-v1' ? prior.positionsSource : null,
        stockCapturedAt: prior.stockCapturedAt || null,
        stockScanFailedAt: capturedAt,
        positionsDiagnostic: snapshot.positionsDiagnostic || prior.positionsDiagnostic || null,
      };
    }
  }
  if (hasCryptoUpdate) {
    if (cryptoCaptured) {
      midasSnapshot = {
        ...midasSnapshot,
        cryptoSummary: removedGenericCrypto ? null : snapshot.cryptoSummary || null,
        cryptoSummarySource: !removedGenericCrypto && snapshot.cryptoSummary ? 'midas-visible-v1' : null,
        cryptoSummaryCapturedAt: !removedGenericCrypto && snapshot.cryptoSummary ? capturedAt : null,
        cryptoPositions: validCryptoPositions,
        cryptoPositionsCaptured: true,
        cryptoPositionsSource: 'midas-visible-v1',
        cryptoCapturedAt: capturedAt,
        cryptoScanFailedAt: null,
        cryptoPositionsDiagnostic: null,
      };
    } else {
      midasSnapshot = {
        ...midasSnapshot,
        cryptoSummary: prior.cryptoPositionsSource === 'midas-visible-v1' ? prior.cryptoSummary : null,
        cryptoSummarySource: prior.cryptoPositionsSource === 'midas-visible-v1' ? prior.cryptoSummarySource : null,
        cryptoSummaryCapturedAt: prior.cryptoSummaryCapturedAt || null,
        cryptoPositions: prior.cryptoPositionsSource === 'midas-visible-v1' ? prior.cryptoPositions : [],
        cryptoPositionsCaptured: prior.cryptoPositionsSource === 'midas-visible-v1' && prior.cryptoPositionsCaptured === true,
        cryptoPositionsSource: prior.cryptoPositionsSource === 'midas-visible-v1' ? prior.cryptoPositionsSource : null,
        cryptoCapturedAt: prior.cryptoCapturedAt || null,
        cryptoScanFailedAt: capturedAt,
        cryptoPositionsDiagnostic: snapshot.cryptoPositionsDiagnostic || prior.cryptoPositionsDiagnostic || null,
      };
    }
  }
  try {
    localStorage.setItem(MIDAS_SNAPSHOT_KEY, JSON.stringify(midasSnapshot));
  } catch (err) {
    console.error('Midas pozisyon özeti bu tarayıcıya kaydedilemedi', err);
  }
  syncMidasPositionsToCloud();
  persist();
}

/**
 * Bu tarayıcıdaki Midas pozisyonları hesaptaki kopyadan yeniyse (veya hesapta
 * hiç yoksa) hesaba yükler. Bulut durumu yüklendikten sonra çağrılır.
 */
export function ensureMidasPositionsSynced() {
  if (!midasSnapshot) return false;
  const cloud = state.midasPositionsCloud;
  const localStock = midasSnapshot.stockCapturedAt || '';
  const localCrypto = midasSnapshot.cryptoCapturedAt || '';
  const stale = !cloud || localStock > (cloud.stockCapturedAt || '') || localCrypto > (cloud.cryptoCapturedAt || '');
  if (!stale) return false;
  syncMidasPositionsToCloud();
  persist();
  return true;
}

/**
 * Günlük bildirimi gönderen sunucu tarafı adetleri bilmeli: son Midas
 * pozisyonlarının sade kopyası hesaba eşitlenen duruma yazılır.
 */
function syncMidasPositionsToCloud() {
  if (!midasSnapshot) return;
  const slim = (rows) => (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.code && row.units > 0)
    .map((row) => ({ code: row.code, units: row.units, price: row.price ?? null, currency: row.currency || '' }));
  state.midasPositionsCloud = {
    positions: midasSnapshot.positionsSource === 'midas-visible-v1' ? slim(midasSnapshot.positions) : [],
    cryptoPositions: midasSnapshot.cryptoPositionsSource === 'midas-visible-v1' ? slim(midasSnapshot.cryptoPositions) : [],
    stockCapturedAt: midasSnapshot.stockCapturedAt || null,
    cryptoCapturedAt: midasSnapshot.cryptoCapturedAt || null,
  };
}

/** Store recent market quotes separately from the last Midas account snapshot. */
export function saveMidasLiveQuotes(quotes) {
  if (!midasSnapshot || !quotes || typeof quotes !== 'object') return false;
  midasSnapshot = {
    ...midasSnapshot,
    liveQuotes: { ...(midasSnapshot.liveQuotes || {}), ...quotes },
    liveQuotesCapturedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(MIDAS_SNAPSHOT_KEY, JSON.stringify(midasSnapshot));
  } catch (err) {
    console.error('Piyasa fiyatları bu tarayıcıya kaydedilemedi', err);
  }
  return true;
}

function persistMidasTransactions() {
  try {
    localStorage.setItem(MIDAS_KEY, JSON.stringify(midasTx));
  } catch (err) {
    console.error('Midas işlemleri bu tarayıcıya kaydedilemedi', err);
  }
  listeners.forEach((fn) => fn(state));
}

function load() {
  try {
    return migrate(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return defaultState();
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Kaydedilemedi', err);
  }
  listeners.forEach((fn) => fn(state));
}

export const getState = () => state;
export const getMarketAssets = () => state.marketAssets;
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Store fetched market histories in the account-synced state. */
export function saveMarketAssets(assets) {
  state.marketAssets = Array.isArray(assets) ? assets : [];
  persist();
  return state.marketAssets.length;
}

/** Remove completed Midas cycles and keep only the currently open cycle. */
export function pruneMidasHistory(activeCycleStarts = {}, closedCodes = [], synchronizedCodes = []) {
  const closed = new Set((closedCodes || []).map((code) => String(code).toLocaleUpperCase('tr')));
  const synchronized = new Set((synchronizedCodes || []).map((code) => String(code).toLocaleUpperCase('tr')));
  const before = midasTx.length;
  midasTx = midasTx.filter((tx) => {
    const code = String(tx.code || '').toLocaleUpperCase('tr');
    if (closed.has(code)) return false;
    if (synchronized.has(code)) return false;
    const startDate = activeCycleStarts[code];
    return !startDate || tx.date >= startDate;
  });
  const removed = before - midasTx.length;
  if (removed) persistMidasTransactions();
  return removed;
}

/* ------------------------------------------------------- toplam değer geçmişi */

// Günlük toplam portföy değeri { 'YYYY-AA-GG': ₺ } olarak hesaba eşitlenen
// durumda saklanır; grafik her açılışta geçmişi yeniden hesaplamaz.
const VALUE_RECORD_INTERVAL_MS = 30 * 60_000;

export const valueHistory = () => state.valueHistory || {};

/** Bugünün toplamını yazar; aynı gün içinde en fazla 30 dakikada bir buluta gider. */
/**
 * Hafta sonu piyasa kapalıdır ve Midas Cuma kapanışını gösterir: Cumartesi /
 * Pazar değeri ayrı bir gün sayılmaz, önceki Cuma'nın kapanışı olarak yazılır.
 */
export function tradingDateFor(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day !== 0 && day !== 6) return date;
  const friday = new Date(`${date}T12:00:00Z`);
  friday.setUTCDate(friday.getUTCDate() - (day === 6 ? 1 : 2));
  return friday.toISOString().slice(0, 10);
}

export function recordPortfolioValue(calendarDate, value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(calendarDate)) || !(Number.isFinite(value) && value > 0)) return false;
  const date = tradingDateFor(calendarDate);
  const history = { ...(state.valueHistory || {}) };
  const rounded = Math.round(value * 100) / 100;
  const lastAt = Date.parse(state.valueHistoryUpdatedAt || '') || 0;
  if (history[date] === rounded) return false;
  // Değer %5'ten fazla değiştiyse (ör. yanlış fiyatla yazılmış kayıt düzeldi) beklemeden yaz.
  const bigChange = history[date] > 0 && Math.abs(rounded / history[date] - 1) > 0.05;
  if (history[date] !== undefined && !bigChange && Date.now() - lastAt < VALUE_RECORD_INTERVAL_MS) return false;
  history[date] = rounded;
  state.valueHistory = history;
  state.valueHistoryUpdatedAt = new Date().toISOString();
  persist();
  return true;
}

/** Geçmiş bir günün toplam değerini elle yazar (hafta sonu Cuma'ya gider). */
export function setPortfolioValue(calendarDate, value) {
  const amount = Math.round(Number(value) * 100) / 100;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(calendarDate)) || !(amount > 0)) return null;
  const date = tradingDateFor(calendarDate);
  state.valueHistory = { ...(state.valueHistory || {}), [date]: amount };
  persist();
  return date;
}

export function removePortfolioValue(date) {
  const history = { ...(state.valueHistory || {}) };
  delete history[date];
  state.valueHistory = history;
  persist();
}

/* ------------------------------------------------------ para giriş / çıkışı */

// Onaylanan para yatırma (+) / çekme (−) kayıtları ve son Midas tarama
// fotoğrafı hesapla eşitlenir; gerçek getiri bu kayıtlarla hesaplanır.
export const cashflows = () => (Array.isArray(state.cashflows) ? state.cashflows : []);
export const midasBaselineState = () => state.midasBaseline || null;
export const pendingCashflow = () => state.pendingCashflow || null;

/** Yeni tarama geldiyse karşılaştırma için önceki fotoğrafı saklayıp günceller. */
export function updateMidasBaseline(baseline, detected) {
  if (!baseline || state.midasBaseline?.key === baseline.key) return false;
  // Reddedilen tarama yeniden eşitlenene kadar tekrar sorulmaz.
  if (state.rejectedBaselineKey === baseline.key) return false;
  const previous = state.midasBaseline || null;
  state.midasBaseline = baseline;
  if (detected) {
    state.pendingCashflow = {
      amount: Math.round(detected.amount * 100) / 100,
      from: previous?.at || null,
      to: baseline.at,
      date: String(baseline.at || '').slice(0, 10),
      previousBaseline: previous,
    };
  }
  persist();
  return true;
}

/** Kullanıcı "Evet" dedi: tespit edilen tutar para hareketi olarak kaydedilir. */
export function confirmPendingCashflow() {
  const pending = state.pendingCashflow;
  if (!pending) return false;
  state.cashflows = [...cashflows(), {
    id: uid(), date: pending.date, amount: pending.amount, source: 'midas-tespit',
    from: pending.from ? String(pending.from).slice(0, 10) : null, to: pending.date,
  }].sort((a, b) => a.date.localeCompare(b.date));
  state.pendingCashflow = null;
  state.rejectedBaselineKey = null;
  persist();
  return true;
}

/**
 * Kullanıcı "Hayır" dedi: tarama şüphelidir. Önceki fotoğraf geri yüklenir ki
 * yeniden eşitlemeden sonraki tarama yine ona göre karşılaştırılsın.
 */
export function rejectPendingCashflow() {
  const pending = state.pendingCashflow;
  if (!pending) return false;
  state.rejectedBaselineKey = state.midasBaseline?.key || null;
  state.midasBaseline = pending.previousBaseline || null;
  state.pendingCashflow = null;
  persist();
  return true;
}

export function removeCashflow(id) {
  state.cashflows = cashflows().filter((flow) => flow.id !== id);
  persist();
}

/* --------------------------------------------------------------- temettüler */

// Temettü getiridir, ana para değildir. Midas taraması temettüyü "para
// eklendi" gibi görür; girilen temettü o tespitten düşülür.
export const dividends = () => (Array.isArray(state.dividends) ? state.dividends : []);

const inWindow = (date, from, to) => (!from || date > from) && (!to || date <= to);

/** Temettüyü kaydeder; aynı dönemi kapsayan para girişi varsa temettü kadar azaltır. */
export function addDividend({ date, code, amount }) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !(value > 0)) return null;
  const record = { id: uid(), date, code: String(code || '').trim().toLocaleUpperCase('tr'), amount: value, adjustments: [] };
  let remaining = value;
  const pending = state.pendingCashflow;
  if (pending && pending.amount > 0 && inWindow(date, pending.from && String(pending.from).slice(0, 10), pending.date)) {
    const used = Math.min(remaining, pending.amount);
    state.pendingCashflow = { ...pending, amount: Math.round((pending.amount - used) * 100) / 100 };
    if (state.pendingCashflow.amount < 1) state.pendingCashflow = null;
    remaining -= used;
  }
  state.cashflows = cashflows().map((flow) => {
    if (!(remaining > 0) || !(flow.amount > 0) || flow.source !== 'midas-tespit'
      || !inWindow(date, flow.from, flow.to)) return flow;
    const used = Math.min(remaining, flow.amount);
    remaining -= used;
    record.adjustments.push({ flowId: flow.id, amount: used });
    return { ...flow, amount: Math.round((flow.amount - used) * 100) / 100 };
  });
  state.dividends = [...dividends(), record].sort((a, b) => a.date.localeCompare(b.date));
  persist();
  return record;
}

/** Temettüyü siler; para girişinden düşülen tutarı geri ekler. */
export function removeDividend(id) {
  const record = dividends().find((item) => item.id === id);
  if (!record) return false;
  const back = new Map((record.adjustments || []).map((item) => [item.flowId, item.amount]));
  state.cashflows = cashflows().map((flow) => (back.has(flow.id)
    ? { ...flow, amount: Math.round((flow.amount + back.get(flow.id)) * 100) / 100 } : flow));
  state.dividends = dividends().filter((item) => item.id !== id);
  persist();
  return true;
}

/** İki tarama arasında girilmiş temettü toplamı (tespit tutarından düşülür). */
export function dividendsBetween(from, to) {
  return dividends().filter((item) => inWindow(item.date, from, to))
    .reduce((sum, item) => sum + item.amount, 0);
}

/* ------------------------------------------------------------------ profiller */

export const profiles = () => state.profiles;
export const activeProfileId = () => state.activeProfile;

export function activeProfileName() {
  if (state.activeProfile === 'ALL') return 'Tüm profiller';
  return state.profiles.find((p) => p.id === state.activeProfile)?.name || 'Portföy';
}

export function setActiveProfile(id) {
  state.activeProfile = id;
  persist();
}

export function addProfile(name) {
  const profile = { id: uid(), name: String(name || '').trim() || 'Yeni profil' };
  state.profiles.push(profile);
  state.activeProfile = profile.id;
  persist();
  return profile;
}

export function renameProfile(id, name) {
  const p = state.profiles.find((x) => x.id === id);
  if (p) { p.name = String(name || '').trim() || p.name; persist(); }
}

export function removeProfile(id) {
  if (state.profiles.length <= 1) return false;
  state.profiles = state.profiles.filter((p) => p.id !== id);
  state.tx = state.tx.filter((t) => t.profile !== id);
  midasTx = midasTx.filter((t) => t.profile !== id);
  if (state.activeProfile === id) state.activeProfile = state.profiles[0].id;
  persist();
  persistMidasTransactions();
  return true;
}

/* -------------------------------------------------------------------- işlemler */

/** Aktif profilin (veya 'ALL' ise tümünün) işlemleri, tarihe göre sıralı. */
export function transactions(profileId = state.activeProfile) {
  const all = [...state.tx, ...midasTx.filter((tx) => !GENERIC_CRYPTO_CODES.has(
    String(tx.code || '').toLocaleUpperCase('en-US')))];
  const list = profileId === 'ALL'
    ? all
    : all.filter((t) => t.profile === profileId);
  const byDate = new Map();
  for (const row of list) {
    const date = String(row.date || '');
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, dayRows]) => {
    // Midas provides a clock time for its fills. Sort same-day trades by time
    // only when every row has one; manual fills without a time keep their
    // original order rather than being guessed before/after Midas fills.
    if (dayRows.length > 1 && dayRows.every((row) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(row.time || '')))) {
      dayRows.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    }
    return dayRows;
  });
}

function transactionFingerprint(tx) {
  return [tx.date, String(tx.code || '').trim().toLocaleUpperCase('tr'), tx.type,
    Number(tx.units), Number(tx.price), Number(tx.fee || 0), Number(tx.withholdingTax || 0)].join('|');
}

function transactionCoreFingerprint(tx) {
  return [tx.date, String(tx.code || '').trim().toLocaleUpperCase('tr'), tx.type,
    Number(tx.units)].join('|');
}

/** Midas işlemlerini ayrı localStorage anahtarında saklar; Supabase state'ine eklemez. */
export function addMidasTransactions(rows) {
  const manualFingerprints = new Set(state.tx.map(transactionFingerprint));
  const importedById = new Map(midasTx.filter((t) => t.sourceId).map((t) => [t.sourceId, t]));
  const importedWithoutIdByCore = new Map();
  for (const tx of midasTx.filter((t) => !t.sourceId)) {
    const key = transactionCoreFingerprint(tx);
    if (!importedWithoutIdByCore.has(key)) importedWithoutIdByCore.set(key, []);
    importedWithoutIdByCore.get(key).push(tx);
  }
  const importedFingerprintsWithoutId = new Set(
    midasTx.filter((t) => !t.sourceId).map(transactionFingerprint),
  );
  const batchIds = new Set();
  const batchFingerprintsWithoutId = new Set();
  const profile = state.activeProfile === 'ALL' ? state.profiles[0].id : state.activeProfile;
  let added = 0, updated = 0, skipped = 0;
  for (const tx of rows || []) {
    const record = {
      id: `midas-${uid()}`,
      profile,
      source: 'midas',
      sourceId: String(tx.sourceId || ''),
      date: String(tx.date || ''),
      time: String(tx.time || ''),
      code: String(tx.code || '').trim().toLocaleUpperCase('tr'),
      type: tx.type === 'SAT' ? 'SAT' : 'AL',
      units: Number(tx.units),
      price: Number(tx.price),
      currency: tx.currency === 'USD' ? 'USD' : tx.currency === 'TRY' ? 'TRY' : '',
      fee: Number(tx.fee || 0),
      withholdingTax: Number(tx.withholdingTax || 0),
      note: tx.note || 'Midas aktarımı',
    };
    if (!record.date || !record.code || !(record.units > 0) || !(record.price > 0)) { skipped += 1; continue; }
    if (GENERIC_CRYPTO_CODES.has(record.code.toLocaleUpperCase('en-US'))) { skipped += 1; continue; }
    const fingerprint = transactionFingerprint(record);
    if (manualFingerprints.has(fingerprint)) { skipped += 1; continue; }
    if (record.sourceId) {
      if (batchIds.has(record.sourceId)) { skipped += 1; continue; }
      batchIds.add(record.sourceId);
      const existing = importedById.get(record.sourceId);
      if (existing) {
        const changed = ['date', 'code', 'type', 'units', 'price', 'fee', 'withholdingTax'].some((key) => existing[key] !== record[key])
          || Boolean(record.currency && existing.currency !== record.currency)
          || Boolean(record.time && existing.time !== record.time);
        if (changed) {
          Object.assign(existing, record, {
            id: existing.id, profile: existing.profile,
            currency: record.currency || existing.currency || '',
            time: record.time || existing.time || '',
          });
          updated += 1;
        } else skipped += 1;
        continue;
      }
    } else {
      const sameCore = importedWithoutIdByCore.get(transactionCoreFingerprint(record)) || [];
      if (sameCore.length === 1) {
        const existing = sameCore[0];
        const changed = existing.price !== record.price || existing.fee !== record.fee
          || Number(existing.withholdingTax || 0) !== record.withholdingTax
          || Boolean(record.currency && existing.currency !== record.currency)
          || Boolean(record.time && existing.time !== record.time);
        if (changed) {
          Object.assign(existing, record, {
            id: existing.id, profile: existing.profile,
            currency: record.currency || existing.currency || '',
            time: record.time || existing.time || '',
          });
          updated += 1;
        } else skipped += 1;
        continue;
      }
      if (sameCore.length > 1 || importedFingerprintsWithoutId.has(fingerprint)
        || batchFingerprintsWithoutId.has(fingerprint)) { skipped += 1; continue; }
      batchFingerprintsWithoutId.add(fingerprint);
      importedFingerprintsWithoutId.add(fingerprint);
    }
    midasTx.push(record);
    added += 1;
  }
  if (added || updated) persistMidasTransactions();
  return { added, updated, skipped };
}

export function addTransaction(tx) {
  const record = {
    id: uid(),
    profile: state.activeProfile === 'ALL' ? state.profiles[0].id : state.activeProfile,
    ...tx,
    code: String(tx.code || '').trim().toLocaleUpperCase('tr'),
    units: Number(tx.units),
    price: Number(tx.price),
    fee: Number(tx.fee || 0),
    withholdingTax: Number(tx.withholdingTax || 0),
  };
  state.tx.push(record);
  persist();
  return record;
}

export function updateTransaction(id, patch) {
  const t = [...state.tx, ...midasTx].find((x) => x.id === id);
  if (!t) return false;
  Object.assign(t, patch);
  t.units = Number(t.units);
  t.price = Number(t.price);
  t.fee = Number(t.fee || 0);
  t.withholdingTax = Number(t.withholdingTax || 0);
  if (t.source === 'midas') persistMidasTransactions();
  else persist();
  return true;
}

export function removeTransaction(id) {
  const before = state.tx.length;
  state.tx = state.tx.filter((t) => t.id !== id);
  const midasBefore = midasTx.length;
  midasTx = midasTx.filter((t) => t.id !== id);
  if (state.tx.length !== before) persist();
  else if (midasTx.length !== midasBefore) persistMidasTransactions();
}

export const allTransactions = () => [...state.tx, ...midasTx];

/* --------------------------------------------------------------------- ayarlar */

export const settings = () => state.settings;

export function setSetting(key, value) {
  state.settings[key] = value;
  persist();
}

/* ------------------------------------------------------------- yedekle / geri yükle */

export function exportJSON() {
  // Yedek alındığı anı sakla ki kullanıcıya "en son ne zaman yedekledin"
  // hatırlatması yapılabilsin.
  const metin = JSON.stringify({ ...state, midasTx, exportedAt: new Date().toISOString() }, null, 2);
  state.settings.lastBackup = new Date().toISOString().slice(0, 10);
  persist();
  return metin;
}

/** Son yedekten bu yana geçen gün; hiç yedek alınmadıysa null. */
export function daysSinceBackup() {
  const son = state.settings.lastBackup;
  if (!son) return null;
  return Math.floor((Date.now() - new Date(`${son}T00:00:00`).getTime()) / 86400000);
}

/** Yedeği içe aktarır. mode: 'replace' | 'merge' */
export function importJSON(text, mode = 'replace') {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.tx)) throw new Error('Dosya bir portföy yedeği değil.');

  if (mode === 'merge') {
    const existing = new Set(state.tx.map((t) => t.id));
    const nameToId = new Map(state.profiles.map((p) => [p.name, p.id]));
    for (const p of parsed.profiles || []) {
      if (!nameToId.has(p.name)) {
        const created = { id: uid(), name: p.name };
        state.profiles.push(created);
        nameToId.set(p.name, created.id);
      }
    }
    const oldIdToName = new Map((parsed.profiles || []).map((p) => [p.id, p.name]));
    let added = 0;
    for (const t of parsed.tx) {
      if (existing.has(t.id)) continue;
      const name = oldIdToName.get(t.profile);
      state.tx.push({ ...t, id: uid(), profile: nameToId.get(name) || state.profiles[0].id });
      added += 1;
    }
    const knownMidas = new Set(midasTx.map(transactionFingerprint));
    let midasAdded = 0;
    for (const t of Array.isArray(parsed.midasTx) ? parsed.midasTx : []) {
      const fingerprint = transactionFingerprint(t);
      if (knownMidas.has(fingerprint)) continue;
      midasTx.push({ ...t, id: `midas-${uid()}`, profile: nameToId.get(oldIdToName.get(t.profile)) || state.profiles[0].id, source: 'midas' });
      knownMidas.add(fingerprint);
      midasAdded += 1;
    }
    persist();
    if (midasAdded) persistMidasTransactions();
    return added;
  }

  state = migrate(parsed);
  if (Array.isArray(parsed.midasTx)) midasTx = parsed.midasTx;
  persist();
  if (Array.isArray(parsed.midasTx)) persistMidasTransactions();
  return state.tx.length;
}

export function resetAll() {
  state = defaultState();
  midasTx = [];
  persist();
  persistMidasTransactions();
}
