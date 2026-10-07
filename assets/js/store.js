/* Kalıcı durum: profiller, işlemler, ayarlar.

   Ana portföy durumu localStorage'dadır ve oturum açıldığında app.js üzerinden
   Supabase'e eşitlenir. Midas içe aktarımları ayrı anahtarda yerel tutulur. */

const KEY = 'tefas-portfoy-v1';
// Midas'tan içe aktarılan işlemler yerel kalır; getState() / Supabase durumuna girmez.
const MIDAS_KEY = 'tefas-midas-import-v1';
const MIDAS_SNAPSHOT_KEY = 'tefas-midas-account-snapshot-v1';
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

function loadMidasTransactions() {
  try {
    const value = JSON.parse(localStorage.getItem(MIDAS_KEY));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function loadMidasSnapshot() {
  try {
    const value = JSON.parse(localStorage.getItem(MIDAS_SNAPSHOT_KEY));
    return value && typeof value === 'object' ? value : null;
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
    && Array.isArray(snapshot.positions) && snapshot.positions.length > 0;
  const cryptoCaptured = snapshot.cryptoPositionsCaptured === true
    && Array.isArray(snapshot.cryptoPositions) && snapshot.cryptoPositions.length > 0;
  const prior = midasSnapshot || {};
  midasSnapshot = { ...prior, capturedAt };
  if (hasStockUpdate) {
    const summaryValid = Number.isFinite(snapshot.summary?.totalValue) && snapshot.summary.totalValue > 0;
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
        cryptoSummary: snapshot.cryptoSummary || null,
        cryptoSummarySource: snapshot.cryptoSummary ? 'midas-visible-v1' : null,
        cryptoSummaryCapturedAt: snapshot.cryptoSummary ? capturedAt : null,
        cryptoPositions: snapshot.cryptoPositions,
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
  const all = [...state.tx, ...midasTx];
  const list = profileId === 'ALL'
    ? all
    : all.filter((t) => t.profile === profileId);
  return list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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
      code: String(tx.code || '').trim().toLocaleUpperCase('tr'),
      type: tx.type === 'SAT' ? 'SAT' : 'AL',
      units: Number(tx.units),
      price: Number(tx.price),
      fee: Number(tx.fee || 0),
      withholdingTax: Number(tx.withholdingTax || 0),
      note: tx.note || 'Midas aktarımı',
    };
    if (!record.date || !record.code || !(record.units > 0) || !(record.price > 0)) { skipped += 1; continue; }
    const fingerprint = transactionFingerprint(record);
    if (manualFingerprints.has(fingerprint)) { skipped += 1; continue; }
    if (record.sourceId) {
      if (batchIds.has(record.sourceId)) { skipped += 1; continue; }
      batchIds.add(record.sourceId);
      const existing = importedById.get(record.sourceId);
      if (existing) {
        const changed = ['date', 'code', 'type', 'units', 'price', 'fee', 'withholdingTax'].some((key) => existing[key] !== record[key]);
        if (changed) {
          Object.assign(existing, record, { id: existing.id, profile: existing.profile });
          updated += 1;
        } else skipped += 1;
        continue;
      }
    } else {
      const sameCore = importedWithoutIdByCore.get(transactionCoreFingerprint(record)) || [];
      if (sameCore.length === 1) {
        const existing = sameCore[0];
        const changed = existing.price !== record.price || existing.fee !== record.fee
          || Number(existing.withholdingTax || 0) !== record.withholdingTax;
        if (changed) {
          Object.assign(existing, record, { id: existing.id, profile: existing.profile });
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
