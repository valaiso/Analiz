/* Uygulama çatısı: veri yükleme, sekme yönlendirme, profil/tema ve Supabase eşitlemesi. */

import { $, h, fmtDate, toast } from './util.js';
import { loadCore, loadHistories, refreshData, DB } from './data.js';
import { analyze } from './portfolio.js';
import {
  transactions, profiles, activeProfileId, setActiveProfile, activeProfileName,
  settings, setSetting, subscribe, getState, importJSON, getMidasAccountSnapshot,
  saveMidasLiveQuotes,
} from './store.js';
import { requestMidasLiveQuotes } from './midas-import.js';
import { supabase } from './supabase-client.js';
import { renderPanel } from './views/panel.js';
import { renderDagilim } from './views/dagilim.js';
import { renderKiyaslama } from './views/kiyaslama.js';
import { renderRisk } from './views/risk.js';
import { renderIslemler } from './views/islemler.js';
import { renderFonlar, showFundDetail } from './views/fonlar.js';
import { renderAyarlar } from './views/ayarlar.js';

const VIEWS = {
  panel: { render: renderPanel, needsAnalysis: true },
  dagilim: { render: renderDagilim, needsAnalysis: true },
  kiyaslama: { render: renderKiyaslama, needsAnalysis: true },
  risk: { render: renderRisk, needsAnalysis: true },
  islemler: { render: renderIslemler, needsAnalysis: false },
  fonlar: { render: renderFonlar, needsAnalysis: true },
  ayarlar: { render: renderAyarlar, needsAnalysis: false },
};

const app = $('#app');
let currentView = 'panel';
let prefillCode = null;
let rendering = false;
let sessionUser = null;
let cloudReady = false;
let applyingCloudState = false;
let lastCloudUpdatedAt = null;
let saveTimer = null;
let pollTimer = null;
let saveQueue = Promise.resolve();
let startingSession = null;
let intradayQuoteTimer = null;
let intradayQuoteBusy = false;

/* ---------------------------------------------------------------- eşitleme */

function showAuthStyles() {
  if (document.getElementById('authStyles')) return;
  const style = document.createElement('style');
  style.id = 'authStyles';
  style.textContent = `
    .auth-shell { min-height: 72vh; display:grid; place-items:center; padding:24px 12px; }
    .auth-card { width:min(440px,100%); padding:24px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); }
    .auth-card h1 { font-size:1.35rem; margin-bottom:6px; }
    .auth-card p { color:var(--text-dim); margin:0 0 18px; }
    .auth-form { display:grid; gap:12px; }
    .auth-form label { display:grid; gap:5px; font-size:.82rem; color:var(--text-dim); font-weight:600; }
    .auth-form input { width:100%; min-height:42px; }
    .auth-error { color:var(--down); background:var(--down-soft); border-radius:8px; padding:9px 11px; font-size:.86rem; }
    .auth-note { margin-top:14px!important; font-size:.78rem; }
    .auth-sync { font-size:.76rem; color:var(--text-dim); white-space:nowrap; }
    .quote-time { font-size:.72rem; color:var(--text-dim); white-space:nowrap; font-variant-numeric:tabular-nums; }
    @media(max-width:640px) { .auth-card { padding:19px; } .auth-sync { display:none; } }
  `;
  document.head.append(style);
}

function showLogin(message = '') {
  clearInterval(pollTimer);
  clearInterval(intradayQuoteTimer);
  clearTimeout(saveTimer);
  pollTimer = null;
  intradayQuoteTimer = null;
  saveTimer = null;
  cloudReady = false;
  sessionUser = null;
  const topbar = document.querySelector('.topbar');
  const footer = document.querySelector('.footer');
  if (topbar) topbar.hidden = true;
  if (footer) footer.hidden = true;
  showAuthStyles();
  app.className = 'app auth-shell';
  app.innerHTML = `
    <section class="auth-card">
      <h1>Portföy hesabına giriş</h1>
      <p>PC ve telefondaki portföy kayıtlarını eşitlemek için Supabase hesabınla giriş yap.</p>
      <form class="auth-form" id="loginForm">
        <label>E-posta<input id="loginEmail" type="email" autocomplete="username" required></label>
        <label>Parola<input id="loginPassword" type="password" autocomplete="current-password" required></label>
        ${message ? '<div class="auth-error" id="loginError"></div>' : '<div class="auth-error" id="loginError" hidden></div>'}
        <button class="btn btn-primary" id="loginButton" type="submit">Giriş yap</button>
      </form>
      <p class="auth-note">İlk eşitlemeyi, kayıtlarının bulunduğu PC’de yap. Böylece mevcut portföyün buluta aktarılır. Hesap açma kapalıdır; bu ekrandan yeni hesap oluşturulamaz.</p>
    </section>`;
  const err = $('#loginError');
  if (message && err) err.textContent = message;
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#loginButton');
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    button.disabled = true;
    button.textContent = 'Giriş yapılıyor…';
    err.hidden = true;
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (data.user) await startAuthenticatedSession(data.user);
    } catch (error) {
      err.textContent = friendlyAuthError(error);
      err.hidden = false;
      button.disabled = false;
      button.textContent = 'Giriş yap';
    }
  });
}

async function signOutFromAccount() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await enqueueCloudSave();
  }
  const { error } = await supabase.auth.signOut();
  if (error) toast(`Çıkış yapılamadı: ${error.message}`);
  else showLogin();
}

function friendlyAuthError(error) {
  const message = String(error?.message || error || 'Bilinmeyen hata');
  if (/invalid login credentials/i.test(message)) return 'E-posta veya parola doğru değil.';
  if (/email not confirmed/i.test(message)) return 'E-posta hesabı henüz doğrulanmamış. Supabase Authentication > Users bölümünü kontrol et.';
  if (/fetch|network|failed to reach/i.test(message)) return 'Supabase bağlantısı kurulamadı. İnternet bağlantını kontrol et.';
  return `Giriş/eşitleme hatası: ${message}`;
}

function showMainUI(user) {
  app.className = 'app';
  const topbar = document.querySelector('.topbar');
  const footer = document.querySelector('.footer');
  if (topbar) topbar.hidden = false;
  if (footer) footer.hidden = false;

  let status = $('#cloudStatus');
  if (!status) {
    status = document.createElement('span');
    status.id = 'cloudStatus';
    status.className = 'auth-sync';
    $('.topbar-actions')?.prepend(status);
  }
  status.textContent = `Bulut · ${user.email || 'Giriş yapıldı'}`;
  status.title = 'Portföy kayıtları Supabase hesabınla eşitleniyor';

  let quoteTime = $('#quoteTime');
  if (!quoteTime) {
    quoteTime = document.createElement('span');
    quoteTime.id = 'quoteTime';
    quoteTime.className = 'quote-time';
    quoteTime.setAttribute('aria-label', 'Son kotasyon zamanı');
    $('.topbar-actions')?.prepend(quoteTime);
  }
  updateQuoteTimestamp();

  let signOut = $('#signOutBtn');
  if (!signOut) {
    signOut = document.createElement('button');
    signOut.id = 'signOutBtn';
    signOut.className = 'icon-btn';
    signOut.type = 'button';
    signOut.textContent = '⇥';
    signOut.title = 'Hesaptan çıkış yap';
    signOut.setAttribute('aria-label', 'Hesaptan çıkış yap');
    $('.topbar-actions')?.prepend(signOut);
    signOut.addEventListener('click', signOutFromAccount);
  }
  $('.topbar-actions')?.prepend(quoteTime);
}

function hasLocalPortfolio(state) {
  return Array.isArray(state?.tx) && state.tx.length > 0;
}

async function readCloudState(userId) {
  const { data, error } = await supabase
    .from('portfolio_state')
    .select('state_json, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function writeCloudState(snapshot) {
  if (!sessionUser) return;
  const { data, error } = await supabase
    .from('portfolio_state')
    .upsert({
      user_id: sessionUser.id,
      state_json: snapshot,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    .select('updated_at')
    .single();
  if (error) throw error;
  lastCloudUpdatedAt = data.updated_at;
}

function applyCloudState(remoteState) {
  applyingCloudState = true;
  try {
    importJSON(JSON.stringify(remoteState), 'replace');
  } finally {
    applyingCloudState = false;
  }
}

async function enqueueCloudSave() {
  if (!sessionUser || !cloudReady || applyingCloudState) return;
  const snapshot = JSON.parse(JSON.stringify(getState()));
  // Bir başarısız ağ yazımı sıradaki eşitlemeleri kilitlemesin.
  saveQueue = saveQueue.catch(() => {}).then(() => writeCloudState(snapshot));
  try {
    await saveQueue;
  } catch (error) {
    console.error('Bulut eşitleme hatası', error);
    toast('Cihaza kaydedildi; buluta eşitlenemedi. İnterneti kontrol et.');
  }
}

function scheduleCloudSave() {
  if (!sessionUser || !cloudReady || applyingCloudState) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    enqueueCloudSave();
  }, 700);
}

async function pullCloudChanges() {
  if (!sessionUser || !cloudReady || document.visibilityState === 'hidden' || saveTimer) return;
  try {
    const remote = await readCloudState(sessionUser.id);
    if (!remote) return;
    if (remote.updated_at && remote.updated_at !== lastCloudUpdatedAt) {
      lastCloudUpdatedAt = remote.updated_at;
      applyCloudState(remote.state_json);
      renderProfileSelect();
      await render();
    }
  } catch (error) {
    console.warn('Bulut verisi kontrol edilemedi', error);
  }
}

async function startAuthenticatedSession(user) {
  if (cloudReady && sessionUser?.id === user.id) return;
  if (startingSession) return startingSession;
  startingSession = (async () => {
    sessionUser = user;
    showMainUI(user);
    app.replaceChildren(h('div', { class: 'loading' },
      h('div', { class: 'spinner' }), h('p', {}, 'Portföy bulutla eşitleniyor…')));
    try {
      const remote = await readCloudState(user.id);
      if (remote) {
        lastCloudUpdatedAt = remote.updated_at;
        applyCloudState(remote.state_json);
      } else if (hasLocalPortfolio(getState())) {
        // İlk giriş kayıtların bulunduğu PC'den yapılır; mevcut işlemler ilk kez buluta taşınır.
        await writeCloudState(JSON.parse(JSON.stringify(getState())));
      } else {
        throw new Error('Bulutta henüz portföy kaydı yok. İlk eşitlemeyi, işlemlerinin bulunduğu PC’de yap.');
      }

      cloudReady = true;
      await loadCore();
      updateDataStatus();
      renderProfileSelect();
      navigate(VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'panel');
      clearInterval(pollTimer);
      pollTimer = setInterval(pullCloudChanges, 15000);
      window.addEventListener('focus', pullCloudChanges);
      document.addEventListener('visibilitychange', pullCloudChanges);
      clearInterval(intradayQuoteTimer);
      void refreshIntradayQuotes();
      intradayQuoteTimer = setInterval(refreshIntradayQuotes, 60_000);
    } catch (error) {
      console.error(error);
      cloudReady = false;
      showLogin(friendlyAuthError(error));
    }
  })().finally(() => { startingSession = null; });
  return startingSession;
}

function installAuthListener() {
  supabase.auth.onAuthStateChange((event, session) => {
    // Auth callback içinden Supabase sorgusu başlatmamak için işi sonraki kuyruğa bırak.
    queueMicrotask(() => {
      if (session?.user) startAuthenticatedSession(session.user);
      else if (event === 'SIGNED_OUT') showLogin();
    });
  });
}

/* ------------------------------------------------------------------ veri tazeliği */

function istanbulNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: new Date(`${date}T00:00:00`).getDay(),
  };
}

function stalenessNotice() {
  const last = DB.meta.lastDataDate;
  if (!last) return null;
  const { date, minutes, weekday } = istanbulNow();
  if (last >= date) return null;
  const isWeekday = weekday >= 1 && weekday <= 5;
  if (!isWeekday || minutes < 10 * 60) return null;
  return h('div', { class: 'notice warn', style: 'margin-bottom:14px' },
    h('b', {}, 'Bugünün fiyatları henüz yansımadı. '),
    `Gösterilen değerler ${fmtDate(last)} kapanışına ait. `,
    'TEFAS resmî tatillerde fiyat yayımlamaz; tatil değilse otomatik güncelleme '
    + 'gecikmiş olabilir, genelde kısa sürede düzelir.');
}

function updateDataStatus() {
  const status = $('#dataStatus');
  if (!status) return;
  status.textContent = `Veri: TEFAS · son fiyat günü ${fmtDate(DB.meta.lastDataDate)} · `
    + `${DB.meta.fundCount ?? DB.funds.length} fon kapsanıyor`;
  const disclaimer = document.querySelector('.disclaimer');
  if (disclaimer) disclaimer.textContent = 'Bu araç kişisel takip amaçlıdır, yatırım tavsiyesi değildir. Fiyat verileri TEFAS ve açık piyasa kaynaklarından alınır. Portföy işlemleri Supabase hesabınla eşitlenir; erişim kullanıcı hesabı ve veritabanı kurallarıyla sınırlandırılır.';
}

function updateQuoteTimestamp() {
  const label = $('#quoteTime');
  if (!label) return;
  const snapshot = getMidasAccountSnapshot();
  const activeCodes = new Set((snapshot?.positions || []).map((position) => String(position.code || '').toUpperCase()));
  const quoteTimes = Object.entries(snapshot?.liveQuotes || {})
    .filter(([code]) => !activeCodes.size || activeCodes.has(String(code).toUpperCase()))
    .map(([, quote]) => Number(quote?.timestamp))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
  const timestamp = quoteTimes.length ? Math.max(...quoteTimes) : Date.parse(snapshot?.capturedAt || '');
  label.textContent = Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('tr-TR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(timestamp))
    : '—';
  label.title = 'Son kotasyonun tarih ve saati';
}

async function refreshIntradayQuotes() {
  if (intradayQuoteBusy || document.visibilityState === 'hidden') return;
  const positions = getMidasAccountSnapshot()?.positions || [];
  const codes = [...new Set(positions.filter((position) => {
    const kind = String(DB.byCode.get(position.code)?.kind || position.kind || '').toUpperCase();
    return !['YAT', 'EMK', 'GYF', 'GSYF', 'CRYPTO'].includes(kind)
      && (kind || position.currency === 'USD');
  }).map((position) => position.code).filter(Boolean))].slice(0, 40);
  if (!codes.length) return;
  intradayQuoteBusy = true;
  try {
    const received = await requestMidasLiveQuotes(codes);
    if (Object.keys(received).length && saveMidasLiveQuotes(received)) {
      updateQuoteTimestamp();
      await render({ preserveScroll: true });
    }
  } catch {
    // Keep the last site prices when the optional browser extension is unavailable.
  } finally {
    intradayQuoteBusy = false;
  }
}

/* ------------------------------------------------------------------ yenileme */

async function refresh() {
  const btn = $('#refreshBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const { oncekiGun, yeniGun } = await refreshData();
    updateDataStatus();
    await render();
    if (yeniGun && oncekiGun && yeniGun > oncekiGun) toast(`Yeni veriler yüklendi: ${fmtDate(yeniGun)}`);
    else toast(`Veriler güncel: ${fmtDate(yeniGun)}`);
  } catch (error) {
    console.error(error);
    toast('Yenilenemedi - internet bağlantını kontrol et');
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

/* --------------------------------------------------------------------- tema */

function applyTheme() {
  const mode = settings().theme || 'auto';
  const root = document.documentElement;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(settings().theme || 'auto') + 1) % order.length];
  setSetting('theme', next);
  applyTheme();
  toast({ auto: 'Tema: sistem ayarı', light: 'Tema: açık', dark: 'Tema: koyu' }[next]);
}

/* ------------------------------------------------------------------ profiller */

function renderProfileSelect() {
  const select = $('#profileSelect');
  if (!select) return;
  const options = profiles().map((profile) => h('option', {
    value: profile.id, selected: profile.id === activeProfileId(),
  }, profile.name));
  if (profiles().length > 1) {
    options.push(h('option', { value: 'ALL', selected: activeProfileId() === 'ALL' }, '★ Tüm profiller'));
  }
  select.replaceChildren(...options);
}

/* ------------------------------------------------------------------ yönlendirme */

function setActiveTab(view) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
}

function navigate(view, opts = {}) {
  if (!VIEWS[view]) view = 'panel';
  currentView = view;
  prefillCode = opts.code || null;
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  setActiveTab(view);
  render();
}

/* -------------------------------------------------------------------- çizim */

async function render({ preserveScroll = false } = {}) {
  if (rendering || !cloudReady) return;
  rendering = true;
  updateQuoteTimestamp();
  const previousScrollY = window.scrollY;
  const view = VIEWS[currentView] || VIEWS.panel;
  try {
    const ctx = {
      navigate,
      refresh: () => { render(); },
      applyTheme,
      showFund: (code) => showFundDetail(code, ctx),
      prefill: prefillCode,
      profileName: activeProfileName(),
      accountEmail: sessionUser?.email || '',
      changeAccount: signOutFromAccount,
    };
    if (currentView === 'panel' || currentView === 'dagilim') {
      const positions = getMidasAccountSnapshot()?.positions || [];
      if (positions.length) await loadHistories(positions.map((position) => position.code));
    }
    if (view.needsAnalysis) {
      const txs = transactions();
      if (txs.length) app.replaceChildren(h('div', { class: 'loading' },
        h('div', { class: 'spinner' }), h('p', {}, 'Hesaplanıyor…')));
      ctx.analysis = await analyze(txs);
    }
    const node = view.render(ctx);
    const warning = stalenessNotice();
    app.replaceChildren(...(warning ? [warning, node] : [node]));
    prefillCode = null;
    window.scrollTo({ top: preserveScroll ? previousScrollY : 0, behavior: 'auto' });
  } catch (error) {
    console.error(error);
    app.replaceChildren(h('div', { class: 'card empty' },
      h('h3', {}, 'Bir hata oluştu'),
      h('p', {}, String(error?.message || error)),
      h('button', { class: 'btn', type: 'button', onclick: () => render() }, 'Tekrar dene')));
  } finally {
    rendering = false;
  }
}

/* --------------------------------------------------------------------- açılış */

async function boot() {
  applyTheme();
  const topbar = document.querySelector('.topbar');
  const footer = document.querySelector('.footer');
  if (topbar) topbar.hidden = true;
  if (footer) footer.hidden = true;

  $('#themeBtn').addEventListener('click', cycleTheme);
  $('#refreshBtn').addEventListener('click', refresh);
  $('#profileSelect').addEventListener('change', (event) => {
    setActiveProfile(event.target.value);
    render();
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => navigate(tab.dataset.view));
  }
  window.addEventListener('hashchange', () => {
    const view = location.hash.slice(1);
    if (VIEWS[view] && view !== currentView) navigate(view);
  });

  subscribe(() => {
    renderProfileSelect();
    scheduleCloudSave();
  });
  installAuthListener();
  showLogin();

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    showLogin(friendlyAuthError(error));
    return;
  }
  if (data.session?.user) await startAuthenticatedSession(data.session.user);
}

boot();
