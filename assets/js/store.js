/* Kalıcı durum: profiller, işlemler, ayarlar.

   Ana portföy durumu localStorage'dadır ve oturum açıldığında app.js üzerinden
   Supabase'e eşitlenir. Midas içe aktarımları ayrı anahtarda yerel tutulur. */

const KEY = 'tefas-portfoy-v1';
// Midas'tan içe aktarılan işlemler yerel kalır; getState() / Supabase durumuna girmez.
const MIDAS_KEY = 'tefas-midas-import-v1';
const listeners = new Set();

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function defaultState() {
  return {
    version: 1,
    activeProfile: 'ana',
    profiles: [{ id: 'ana', name: 'Portföyüm' }],
    tx: [],
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

function loadMidasTransactions() {
  try {
    const value = JSON.parse(localStorage.getItem(MIDAS_KEY));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
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
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

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
    Number(tx.units), Number(tx.price), Number(tx.fee || 0)].join('|');
}

/** Midas işlemlerini ayrı localStorage anahtarında saklar; Supabase state'ine eklemez. */
export function addMidasTransactions(rows) {
  const manualFingerprints = new Set(state.tx.map(transactionFingerprint));
  const importedIds = new Set(midasTx.map((t) => t.sourceId).filter(Boolean));
  const importedFingerprintsWithoutId = new Set(
    midasTx.filter((t) => !t.sourceId).map(transactionFingerprint),
  );
  const batchIds = new Set();
  const batchFingerprintsWithoutId = new Set();
  const profile = state.activeProfile === 'ALL' ? state.profiles[0].id : state.activeProfile;
  let added = 0;
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
      note: tx.note || 'Midas aktarımı',
    };
    if (!record.date || !record.code || !(record.units > 0) || !(record.price > 0)) continue;
    const fingerprint = transactionFingerprint(record);
    if (manualFingerprints.has(fingerprint)) continue;
    if (record.sourceId) {
      if (importedIds.has(record.sourceId) || batchIds.has(record.sourceId)) continue;
      batchIds.add(record.sourceId);
      importedIds.add(record.sourceId);
    } else {
      if (importedFingerprintsWithoutId.has(fingerprint) || batchFingerprintsWithoutId.has(fingerprint)) continue;
      batchFingerprintsWithoutId.add(fingerprint);
      importedFingerprintsWithoutId.add(fingerprint);
    }
    midasTx.push(record);
    added += 1;
  }
  if (added) persistMidasTransactions();
  return added;
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
