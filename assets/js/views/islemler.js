/* İşlemler: alım/satım kayıtlarını ekleme, düzenleme ve silme. */

import {
  h, tl, money, units as fmtUnits, fmtDate, toast, confirmDialog, isNum, openModal,
} from '../util.js';
import {
  DB, priceOnDate, lastDate, indexForDate, addLocalMarketAssets, pruneLocalMarketAssets,
} from '../data.js';
import {
  transactions, addTransaction, updateTransaction, removeTransaction,
  activeProfileId, profiles, allTransactions, addMidasTransactions, saveMidasAccountSnapshot, getMidasAccountSnapshot,
  pruneMidasHistory,
} from '../store.js';
import { currentMidasPositions } from '../asset-groups.js';
import { sectionCard, fundPicker } from './common.js';
import { requestMidasHistory } from '../midas-import.js';

function transactionCycles(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const code = String(row.code || '').trim().toLocaleUpperCase('tr');
    if (!code || !row.date || !(Number(row.units) > 0) || !['AL', 'SAT'].includes(row.type)) continue;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(row);
  }
  const out = new Map();
  for (const [code, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let units = 0, startDate = null, hasBuy = false, hasSell = false;
    for (const row of list) {
      const quantity = Number(row.units);
      if (row.type === 'AL') {
        hasBuy = true;
        if (units <= 1e-8) startDate = row.date;
        units += quantity;
      } else {
        hasSell = true;
        units = Math.max(0, units - quantity);
        if (units <= 1e-8) { units = 0; startDate = null; }
      }
    }
    out.set(code, { units, startDate, hasBuy, hasSell });
  }
  return out;
}

let midasActivity = [];
let midasLogField = null;

function logMidas(message) {
  const stamp = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
  midasActivity.push(`[${stamp}] ${message}`);
  midasActivity = midasActivity.slice(-80);
  if (midasLogField) midasLogField.value = midasActivity.join('\n');
}

function logMidasAccount(summary) {
  if (!summary) return;
  const fmt = (value) => Number.isFinite(value)
    ? new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(value)
    : 'okunamadı';
  logMidas(`Midas yatırım hesabı toplam değeri: ${fmt(summary.totalValue)}. Bu güncel hesap değeridir; yatırılan ana para ile aynı şey değildir.`);
  if (Number.isFinite(summary.dailyChange)) logMidas(`Midas günlük hesap değişimi: ${fmt(summary.dailyChange)}.`);
  if (Number.isFinite(summary.tryCash)) logMidas(`Midas TL nakit bakiye: ${fmt(summary.tryCash)}.`);
  if (Number.isFinite(summary.tryBuyingPower)) logMidas(`Midas TL alım gücü: ${fmt(summary.tryBuyingPower)}.`);
  if (Number.isFinite(summary.trySettlement)) logMidas(`Midas TL takas bekleyen bakiye: ${fmt(summary.trySettlement)}.`);
}

async function copyMidasLog(field) {
  const text = field.value.trim();
  if (!text) { toast('Kopyalanacak aktarım mesajı yok'); return; }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    field.focus(); field.select();
    document.execCommand('copy');
  }
  toast('Aktarım mesajı kopyalandı');
}

function showMidasPreview(rows, scanInfo, ctx, marketErrors = {}, applyLifecycle = null) {
  const candidates = rows.map((row) => ({
    ...row,
    missing: [...(row.missing || [])],
  }));
  // Fiyat veritabanında henüz bulunmayan sembollerin işlemlerini de sakla.
  // Böylece alım/satım kaydı korunur; pozisyon fiyat gelene kadar "fiyat yok" görünür.
  const ready = candidates.filter((row) => !row.missing.length);
  const unmatched = candidates.filter((row) => row.missing.length);
  const unknownCodes = [...new Set(ready.filter((row) => !DB.byCode.has(row.code)).map((row) => row.code))];
  const line = (row) => h('tr', {},
    h('td', {}, row.date || '—'),
    h('td', {}, row.code || '—'),
    h('td', {}, row.type === 'SAT' ? 'Satış' : row.type === 'AL' ? 'Alış' : '—'),
    h('td', {}, row.units > 0 ? fmtUnits(row.units) : '—'),
    h('td', {}, row.price > 0 ? money(row.price) : '—'),
    h('td', { style: 'text-align:left;max-width:360px;white-space:normal' }, row.rawText));

  const table = (items, priceHeading, textHeading) => h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Tarih'),
        h('th', {}, 'Kod'),
        h('th', {}, 'Tür'),
        h('th', {}, 'Miktar'),
        h('th', {}, priceHeading),
        h('th', { style: 'text-align:left' }, textHeading))),
      h('tbody', {}, items.map(line))));

  const readyContent = ready.length
    ? table(ready, 'Birim fiyat', 'Midas satırı')
    : h('div', { class: 'notice warn' },
      'İçe aktarılacak işlem alanları henüz tam okunamadı. Eksik satırları aşağıdan inceleyin.');

  const quoteNotice = unknownCodes.length
    ? h('div', { class: 'notice warn' },
      `${unknownCodes.join(', ')} için alış tarihinden itibaren fiyat geçmişi alınamadı. Bu kodların işlemleri aktarılmayacak. `
      + 'Midas kodunun borsa sembolüyle aynı olduğunu kontrol edin ve yeniden deneyin. '
      + Object.entries(marketErrors).map(([code, error]) => `${code}: ${error}`).join(' · '))
    : null;

  const unmatchedContent = unmatched.length
    ? h('details', {},
      h('summary', {}, `Atlanacak ${unmatched.length} satırı göster`),
      h('div', { style: 'margin-top:10px' }, table(unmatched, 'Fiyat', 'Okunan satır')))
    : null;

  let close;
  const actions = h('div', { class: 'btn-row', style: 'justify-content:flex-end' },
    h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Vazgeç'),
    h('button', {
      class: 'btn btn-primary', type: 'button',
      disabled: (!ready.length && !applyLifecycle) || unknownCodes.length > 0,
      onclick: () => {
        const lifecycleResult = applyLifecycle?.();
        if (lifecycleResult && (lifecycleResult.removedTransactions || lifecycleResult.pruned.removed || lifecycleResult.pruned.trimmed)) {
          logMidas(`Kapalı dönem temizliği: ${lifecycleResult.removedTransactions} Midas işlem kaydı, ${lifecycleResult.pruned.removed} fiyat geçmişi silindi; ${lifecycleResult.pruned.trimmed} açık varlığın geçmişi alış tarihinden başlatıldı.`);
        }
        const result = addMidasTransactions(ready);
        logMidas(`${result.added} yeni işlem eklendi, ${result.updated} mevcut Midas işlemi güncellendi, ${result.skipped} kayıt atlandı.`);
        close();
        toast(result.added || result.updated
          ? `${result.added} yeni, ${result.updated} güncellenmiş Midas işlemi kaydedildi`
          : 'Bu işlemler zaten kayıtlı');
        ctx.refresh();
      },
    }, unknownCodes.length ? 'Fiyat geçmişi tamamlanınca aktar' : `${ready.length} işlemi içe aktar`));

  const body = h('div', { class: 'stack' },
    h('p', { class: 'dim' },
      `${candidates.length} satır okundu (${scanInfo.scannedPages} sayfa). ${ready.length} satır işlem bilgisi açısından tam; `
      + `${unknownCodes.length} kodda alış tarihinden itibaren fiyat geçmişi hâlâ eksik, ${unmatched.length} satırda işlem bilgisi eksik. `
      + 'Aktarım için sembollerin fiyat geçmişi gerekir. Midas’a hiçbir emir gönderilmez; ek fiyat geçmişleri hesabının ortak havuzuna eşitlenir, işlemler bu tarayıcıda kalır.'),
    quoteNotice,
    readyContent,
    unmatchedContent,
    actions);
  close = openModal('Midas işlem aktarımı · önizleme', body, { wide: true });
}
async function readMidas(ctx, button) {
  button.disabled = true;
  button.textContent = 'Midas ve fiyat verileri okunuyor…';
  logMidas('Midas emir geçmişi taraması başlatıldı.');
  logMidas('Fiyat havuzunda olmayan semboller için Midas işlem geçmişindeki açık alış döneminden başlayan fiyat geçmişi aranacak; mevcut ek varlıkların fiyatları da yenilenecek.');
  let accountLogged = false;
  try {
    const result = await requestMidasHistory(
      DB.funds.map((fund) => fund.code),
      DB.funds.filter((fund) => fund.localMarketData)
        .map((fund) => ({ code: fund.code, source: fund.catSrc })),
      DB.funds.filter((fund) => ['YAT', 'EMK', 'GYF', 'GSYF'].includes(fund.kind))
        .map((fund) => fund.code),
    );
    saveMidasAccountSnapshot({
      capturedAt: new Date().toISOString(),
      summary: result.accountSummary,
      positions: result.positions,
    });
    if (result.accountSummary) {
      logMidasAccount(result.accountSummary);
      accountLogged = true;
    }
    const { rows } = result;
    if (!rows.length) {
      throw new Error('Tamamlanmış emir satırı bulunamadı. Midas “Emir geçmişi” tablosunda “Gerçekleşti/Tamamlandı” durumundaki kayıtları göster; bekleyen ve iptal emirleri aktarılmaz.');
    }
    const valid = rows.filter((row) => !row.missing?.length);
    const importedStopaj = rows.reduce((sum, row) => sum + (Number(row.withholdingTax) || 0), 0);
    if (importedStopaj > 0) logMidas(`Midas işlem geçmişinden ${tl(importedStopaj)} stopaj okundu.`);
    if (result.positions?.length) {
      const withUnits = result.positions.filter((position) => Number.isFinite(position.units) && position.units > 0).length;
      logMidas(`Midas Pozisyonlar tablosundan ${result.positions.length} açık varlık kaydı okundu; ${withUnits} kayıtta adet bilgisi var.`);
      for (const position of result.positions.filter((row) => row.code === 'TP2')) {
        logMidas(`TP2 adet kontrolü: Midas hücresi “${position.unitsText || 'okunamadı'}” → ayrıştırılan adet ${Number.isFinite(position.units) ? fmtUnits(position.units) : 'okunamadı'}.`);
      }
      for (const position of result.positions) {
        logMidas(`${position.code} Midas alanları: adet “${position.unitsText || 'yok'}” → ${Number.isFinite(position.units) ? fmtUnits(position.units) : 'okunamadı'}; fiyat ${Number.isFinite(position.price) ? position.price : 'yok'} ${position.currency}; ort. maliyet ${Number.isFinite(position.avgCost) ? position.avgCost : 'yok'}; dağılım ${Number.isFinite(position.allocationPct) ? `${position.allocationPct}%` : 'yok'}.`);
        if (position.costDiagnostic) logMidas(`${position.code}: ${position.costDiagnostic}. Maliyet K/Z hesabında kullanılmadı.`);
        if (position.domCells?.length) logMidas(`${position.code} sütun tanısı: ${position.domCells.map((cell) => `${cell.header}=[${cell.raw}]`).join(' | ')}.`);
      }
    } else {
      logMidas('Midas toplam hesabı okundu; ancak Pozisyonlar tablosundaki açık varlıklar okunamadı. Panelde eski işlem kayıtlarından türetilmiş pozisyonlar kullanılmayacak.');
    }
    logMidas(`${result.scannedPages} sayfa tarandı; ${rows.length} satır okundu, ${valid.length} satır aktarılabilir, ${rows.length - valid.length} satır eksik bilgi içeriyor.`);
    if (rows.length && !valid.length) {
      const missingCounts = new Map();
      for (const row of rows) for (const field of row.missing || []) {
        missingCounts.set(field, (missingCounts.get(field) || 0) + 1);
      }
      logMidas(`Eksik alan dağılımı: ${[...missingCounts].map(([field, count]) => `${field} ${count}`).join(' · ') || 'belirlenemedi'}.`);
      for (const [index, row] of rows.slice(0, 2).entries()) {
        if (row.diagnostic) logMidas(`Satır tanısı ${index + 1}: ${row.diagnostic}`);
      }
    }
    // Midas fiyat geçmişlerini yalnızca mevcut alış döneminden itibaren tut.
    // Midas açık pozisyonu varsa işlem satırları eksik olsa dahi kapanış sayma.
    const positions = currentMidasPositions() || [];
    const positionCodes = new Set(positions.map((position) => position.code));
    const midasRows = allTransactions().filter((tx) => tx.source === 'midas');
    const cycleEvents = new Map();
    for (const tx of [...midasRows, ...rows]) {
      const key = [tx.sourceId || '', tx.date, tx.code, tx.type, tx.units, tx.price].join('|');
      if (!cycleEvents.has(key)) cycleEvents.set(key, tx);
    }
    const cycles = transactionCycles([...cycleEvents.values()]);
    const manualCycles = transactionCycles(allTransactions().filter((tx) => tx.source !== 'midas'));
    const activeCycleStarts = {};
    const closedCodes = [];
    const currentCodes = new Set([...cycles.keys(), ...manualCycles.keys(), ...positionCodes]);
    for (const code of currentCodes) {
      const cycle = cycles.get(code);
      const manualCycle = manualCycles.get(code);
      const positionOpen = positionCodes.has(code);
      const manualOpen = (manualCycle?.units || 0) > 1e-8;
      if (cycle?.units > 1e-8 || positionOpen || manualOpen) {
        const existingStart = DB.byCode.get(code)?.startDate;
        activeCycleStarts[code] = cycle?.startDate || manualCycle?.startDate
          || existingStart || new Date().toISOString().slice(0, 10);
      } else if ((cycle?.hasBuy && cycle?.hasSell)
        || (manualCycle?.hasBuy && manualCycle?.hasSell)) {
        closedCodes.push(code);
      }
    }
    const closedSet = new Set(closedCodes);
    const cycleRows = rows.filter((row) => {
      if (closedSet.has(row.code)) return false;
      const start = activeCycleStarts[row.code];
      return !start || row.date >= start;
    });
    const fetchedAssets = Object.values(result.marketData || {}).filter((asset) => !closedSet.has(asset.code)).map((asset) => ({
      ...asset,
      startDate: activeCycleStarts[asset.code] || asset.startDate || '',
    }));
    const storedCount = addLocalMarketAssets(fetchedAssets);
    if (fetchedAssets.length) {
      for (const asset of fetchedAssets) {
        logMidas(asset.partial
          ? `${asset.code}: fiyat geçmişi güncellendi (${asset.prices.length} yeni nokta, kaynak: ${asset.source}); hesaba ait ortak havuzla eşitlendi.`
          : `${asset.code}: ${asset.startDate ? `${asset.startDate} alış tarihinden` : 'bulunabilen dönemden'} başlayan fiyat geçmişi alındı (${asset.prices.length} nokta, kaynak: ${asset.source}); hesaba ait ortak fiyat havuzuna kaydedildi.`);
      }
      if (storedCount) ctx.refresh();
    }
    for (const [code, error] of Object.entries(result.marketErrors || {})) {
      logMidas(`${code}: ${error}`);
    }
    const stillUnknown = [...new Set(valid.filter((row) => !DB.byCode.has(row.code)).map((row) => row.code))];
    if (stillUnknown.length) logMidas(`Fiyat verisi alınamayan semboller: ${stillUnknown.join(', ')}. Bu semboller tamamlanmadan aktarım onayı açılmayacak.`);
    showMidasPreview(cycleRows, result, ctx, result.marketErrors || {}, () => ({
      removedTransactions: pruneMidasHistory(activeCycleStarts, closedCodes),
      pruned: pruneLocalMarketAssets(activeCycleStarts, closedCodes),
    }));
  } catch (error) {
    if (!accountLogged && error.accountSummary) logMidasAccount(error.accountSummary);
    logMidas(`HATA: ${error.message}`);
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Midas’tan İşlemleri Oku';
  }
}

/** Seçilen varlığın USD bazlı olup olmadığını belirler. */
function getAssetCurrency(code) {
  const meta = DB.byCode.get(code);
  const isUsd = meta && (meta.currency === 'USD' || meta.kind === 'US_ETF' || meta.kind === 'CRYPTO');
  return {
    isUsd,
    sym: isUsd ? '$' : '₺',
    label: isUsd ? 'USD' : 'TRY',
  };
}

/** Alım/satım formu. `existing` verilirse düzenleme modunda çalışır. */
function transactionForm({ existing, onDone, prefillCode }) {
  const isEdit = Boolean(existing);
  const picker = fundPicker({
    value: existing?.code || prefillCode || '',
    placeholder: 'Varlık kodu girin',
    onPick: () => { syncPrice(true); },
  });

  const typeSel = h('select', {},
    h('option', { value: 'AL', selected: existing?.type !== 'SAT' }, 'Alış'),
    h('option', { value: 'SAT', selected: existing?.type === 'SAT' }, 'Satış'));

  const dateInput = h('input', {
    type: 'date', value: existing?.date || lastDate(), max: lastDate(),
  });
  const unitsInput = h('input', {
    type: 'number', step: 'any', min: '0', placeholder: '0',
    value: existing ? String(existing.units) : '',
  });
  const amountInput = h('input', { type: 'number', step: 'any', min: '0', placeholder: '0,00' });
  const priceInput = h('input', {
    type: 'number', step: 'any', min: '0', placeholder: '0,000000',
    value: existing ? String(existing.price) : '',
  });
  const feeInput = h('input', {
    type: 'number', step: 'any', min: '0', placeholder: '0',
    value: existing?.fee ? String(existing.fee) : '',
  });
  const taxInput = h('input', {
    type: 'number', step: 'any', min: '0', placeholder: '0',
    value: existing?.withholdingTax ? String(existing.withholdingTax) : '',
  });
  const noteInput = h('input', { type: 'text', placeholder: 'İsteğe bağlı', value: existing?.note || '' });

  const priceHint = h('div', { class: 'hint', text: 'Varlık kodu ve tarih seçince otomatik dolar' });
  const nameHint = h('div', { class: 'hint' });

  // Dinamik etiket elementleri
  const priceLabel = h('label', { text: 'Birim Fiyat (₺)' });
  const amountLabel = h('label', { text: 'Tutar (₺)' });
  const feeLabel = h('label', { text: 'Masraf (₺)' });

  if (existing) {
    const meta = DB.byCode.get(existing.code);
    nameHint.textContent = meta?.name || '';
    amountInput.value = (existing.units * existing.price).toFixed(2);
  }

  /** Seçilen fon+tarih için TEFAS/YFinance fiyatını ve para birimi sembolünü günceller. */
  async function syncPrice(force = false) {
    const code = picker.get();
    const date = dateInput.value;
    const meta = DB.byCode.get(code);
    
    // Para birimi sembolünü belirle
    const { sym } = getAssetCurrency(code);
    priceLabel.textContent = `Birim Fiyat (${sym})`;
    amountLabel.textContent = `Tutar (${sym})`;
    feeLabel.textContent = `Masraf (${sym})`;

    nameHint.textContent = meta?.name || (code ? 'Bu varlık kodunda fiyat verisi bulunamadı' : '');
    nameHint.className = meta || !code ? 'hint' : 'hint warn';
    if (!code || !date || !meta) return;

    if (indexForDate(date) < 0) {
      priceHint.textContent = 'Bu tarih veri aralığının dışında - fiyatı elle gir';
      priceHint.className = 'hint warn';
      return;
    }
    const price = await priceOnDate(code, date);
    if (!isNum(price)) {
      priceHint.textContent = 'Bu tarihte fiyat bulunamadı - elle gir';
      priceHint.className = 'hint warn';
      return;
    }
    if (force || !priceInput.value) {
      priceInput.value = String(price);
      recalcFromAmount();
    }
    priceHint.textContent = `${fmtDate(date)}: ${money(price)} ${sym}`;
    priceHint.className = 'hint';
  }

  // Tutar <-> adet karşılıklı hesaplanır.
  function recalcFromAmount() {
    const price = Number(priceInput.value);
    const amount = Number(amountInput.value);
    if (price > 0 && amount > 0) unitsInput.value = String(Number((amount / price).toFixed(6)));
  }
  function recalcFromUnits() {
    const price = Number(priceInput.value);
    const qty = Number(unitsInput.value);
    if (price > 0 && qty > 0) amountInput.value = String(Number((qty * price).toFixed(2)));
  }

  dateInput.addEventListener('change', () => syncPrice(true));
  picker.input.addEventListener('blur', () => syncPrice(true));
  amountInput.addEventListener('input', recalcFromAmount);
  unitsInput.addEventListener('input', recalcFromUnits);
  priceInput.addEventListener('input', () => {
    if (Number(amountInput.value) > 0) recalcFromAmount();
    else recalcFromUnits();
  });

  const error = h('div', { class: 'hint warn' });

  const submit = () => {
    const code = picker.get();
    const qty = Number(unitsInput.value);
    const price = Number(priceInput.value);
    const withholdingTax = Number(taxInput.value) || 0;
    if (!DB.byCode.get(code)) { error.textContent = 'Geçerli bir varlık kodu seç.'; return; }
    if (!(qty > 0)) { error.textContent = 'Adet sıfırdan büyük olmalı.'; return; }
    if (!(price > 0)) { error.textContent = 'Birim fiyat sıfırdan büyük olmalı.'; return; }
    if (!(withholdingTax >= 0)) { error.textContent = 'Stopaj sıfır veya daha büyük olmalı.'; return; }
    if (!dateInput.value) { error.textContent = 'Tarih seç.'; return; }

    const payload = {
      code, type: typeSel.value, date: dateInput.value,
      units: qty, price, fee: Number(feeInput.value) || 0,
      withholdingTax, note: noteInput.value.trim(),
    };
    if (isEdit) {
      updateTransaction(existing.id, payload);
      toast('İşlem güncellendi');
    } else {
      addTransaction(payload);
      toast(`${code} ${payload.type === 'SAT' ? 'satışı' : 'alışı'} eklendi`);
    }
    onDone?.();
  };

  const fieldWithLabel = (labelEl, control, hint) => h('div', { class: 'field' },
    labelEl, control, hint || null);

  const field = (labelStr, control, hint) => h('div', { class: 'field' },
    h('label', { text: labelStr }), control, hint || null);

  const form = h('div', { class: 'stack' },
    h('div', { class: 'form-grid' },
      field('Varlık Kodu', picker.wrap, nameHint),
      field('İşlem', typeSel),
      field('Tarih', dateInput),
      fieldWithLabel(priceLabel, priceInput, priceHint),
      fieldWithLabel(amountLabel, amountInput, h('div', { class: 'hint', text: 'Adet otomatik hesaplanır' })),
      field('Adet', unitsInput, h('div', { class: 'hint', text: 'Tutar otomatik hesaplanır' })),
      fieldWithLabel(feeLabel, feeInput),
      field('Stopaj (₺)', taxInput, h('div', { class: 'hint', text: 'Midas/ekstrede görünen gerçek kesintiyi gir' })),
      field('Not', noteInput)),
    error,
    h('div', { class: 'btn-row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: submit },
        isEdit ? 'Kaydet' : 'İşlemi Ekle')));

  if (existing || prefillCode) syncPrice(!existing);
  return form;
}

export function renderIslemler(ctx) {
  const root = h('div', { class: 'stack' });
  const list = transactions();
  const multiProfile = activeProfileId() === 'ALL';
  const profileName = new Map(profiles().map((p) => [p.id, p.name]));

  const midasButton = h('button', {
    class: 'btn btn-primary', type: 'button', disabled: multiProfile,
    onclick: (event) => readMidas(ctx, event.currentTarget),
  }, multiProfile ? 'Önce tek profil seç' : 'Midas’tan İşlemleri Oku');
  const copyLogButton = h('button', {
    class: 'btn', type: 'button', onclick: () => copyMidasLog(midasLogField),
  }, 'Yanıtı kopyala');
  midasLogField = h('textarea', {
    readonly: true, rows: 5, 'aria-label': 'Midas aktarım yanıt geçmişi',
    style: 'width:100%;resize:vertical;font: .85rem var(--mono);margin-top:10px',
  }, midasActivity.length ? midasActivity.join('\n') : 'Henüz aktarım yapılmadı. Sonuçlar ve hatalar burada görünür.');
  root.append(sectionCard('Midas Aktarımı',
    'Yatırım hesabındaki Emir geçmişini sayfalar boyunca tarar; kripto işlem geçmişini dışarıda bırakır. Bekleyen/iptal emirlerini atlar ve Yatırım hesabı toplam değerini yanıt geçmişine yazar. Emir göndermez; işlemler bu tarayıcıda kalır.',
    h('div', { class: 'btn-row' }, midasButton, copyLogButton),
    h('label', { style: 'display:block;margin-top:12px;font-weight:600' }, 'Aktarım yanıt geçmişi'),
    midasLogField));

  /* --------------------------------------------------------------- ekleme formu */

  if (multiProfile) {
    root.append(h('div', { class: 'notice' },
      'Şu an tüm profiller birlikte görüntüleniyor. Yeni işlem eklemek için üstten '
      + 'tek bir profil seç.'));
  } else {
    root.append(sectionCard('Yeni İşlem', 'Varlık kodu ve tarihi seçince fiyat otomatik gelir',
      transactionForm({ prefillCode: ctx.prefill, onDone: () => ctx.refresh() })));
  }

  /* ---------------------------------------------------------------- işlem listesi */

  if (!list.length) {
    root.append(h('div', { class: 'card empty' },
      h('h3', {}, 'Henüz işlem yok'),
      h('p', {}, 'Yukarıdaki formdan ilk alımını ekle.')));
    return root;
  }

  const historyRows = list.slice().reverse().slice(0, 20);
  const rows = historyRows.map((t) => {
    const meta = DB.byCode.get(t.code);
    const { sym } = getAssetCurrency(t.code);
    const amount = t.units * t.price;
    const finalAmount = t.type === 'SAT' ? amount - (t.fee || 0) : amount + (t.fee || 0);

    return h('tr', {},
      h('td', {}, fmtDate(t.date)),
      h('td', {},
        h('span', { class: 'code-chip' }, t.code),
        t.source === 'midas'
          ? h('span', { class: 'dim', style: 'margin-left:6px;font-size:.76rem' }, 'Midas')
          : null,
        multiProfile
          ? h('span', { class: 'dim', style: 'margin-left:7px;font-size:.76rem' },
            profileName.get(t.profile) || '')
          : null),
      h('td', { class: 'name', style: 'text-align:left' }, meta?.name || '—'),
      h('td', {}, h('span', { class: `pill ${t.type === 'SAT' ? 'down' : 'up'}` },
        t.type === 'SAT' ? 'Satış' : 'Alış')),
      h('td', {}, fmtUnits(t.units)),
      h('td', {}, `${money(t.price)} ${sym}`),
      h('td', {}, `${sym}${money(finalAmount)}`),
      h('td', {}, Number(t.withholdingTax) > 0 ? tl(t.withholdingTax) : '—'),
      h('td', { style: 'text-align:right;white-space:nowrap' },
        h('button', {
          class: 'btn btn-sm', type: 'button', title: 'Düzenle',
          onclick: () => {
            const close = openModal('İşlemi Düzenle',
              transactionForm({ existing: t, onDone: () => { close(); ctx.refresh(); } }));
          },
        }, '✎'),
        ' ',
        h('button', {
          class: 'btn btn-sm btn-danger', type: 'button', title: 'Sil',
          onclick: async () => {
            const ok = await confirmDialog('İşlemi sil',
              `${fmtDate(t.date)} tarihli ${t.code} işlemi silinecek. Emin misin?`,
              { danger: true, okLabel: 'Sil' });
            if (ok) { removeTransaction(t.id); toast('İşlem silindi'); ctx.refresh(); }
          },
        }, '🗑')));
  });

  root.append(sectionCard('İşlem Geçmişi',
    `${historyRows.length} kayıt gösteriliyor · ${list.length} toplam · en yeniden eskiye`,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { style: 'text-align:left' }, 'Tarih'),
        h('th', { style: 'text-align:left' }, 'Fon'),
        h('th', { style: 'text-align:left' }, 'Ünvan'),
        h('th', { style: 'text-align:left' }, 'Tür'),
        h('th', {}, 'Adet'),
        h('th', {}, 'Birim Fiyat'),
        h('th', {}, 'Tutar'),
        h('th', {}, 'Stopaj'),
        h('th', { style: 'text-align:right' }, ''))),
      h('tbody', {}, rows)))));

  return root;
}
