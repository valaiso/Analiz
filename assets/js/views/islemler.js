/* İşlemler: alım/satım kayıtlarını ekleme, düzenleme ve silme. */

import {
  h, tl, money, units as fmtUnits, fmtDate, toast, confirmDialog, isNum, openModal,
} from '../util.js';
import { DB, priceOnDate, lastDate, indexForDate } from '../data.js';
import {
  transactions, addTransaction, updateTransaction, removeTransaction,
  activeProfileId, profiles, addMidasTransactions,
} from '../store.js';
import { sectionCard, fundPicker } from './common.js';
import { requestMidasHistory } from '../midas-import.js';

function showMidasPreview(rows, ctx) {
  const candidates = rows.map((row) => ({
    ...row,
    missing: [...(row.missing || [])],
  }));
  const ready = candidates.filter((row) => !row.missing.length && DB.byCode.has(row.code));
  const unmatched = candidates.filter((row) => row.missing.length || !DB.byCode.has(row.code));
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
      'Henüz otomatik eşleşen işlem yok. Midas işlem geçmişindeki görünen satır biçimini kontrol et.');

  const unmatchedContent = unmatched.length
    ? h('details', {},
      h('summary', {}, `Atlanacak ${unmatched.length} satırı göster`),
      h('div', { style: 'margin-top:10px' }, table(unmatched, 'Fiyat', 'Okunan satır')))
    : null;

  let close;
  const actions = h('div', { class: 'btn-row', style: 'justify-content:flex-end' },
    h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Vazgeç'),
    h('button', {
      class: 'btn btn-primary', type: 'button', disabled: !ready.length,
      onclick: () => {
        const count = addMidasTransactions(ready);
        close();
        toast(count ? `${count} Midas işlemi yerel olarak eklendi` : 'Bu işlemler zaten kayıtlı');
        ctx.refresh();
      },
    }, `${ready.length} işlemi içe aktar`));

  const body = h('div', { class: 'stack' },
    h('p', { class: 'dim' },
      `${candidates.length} satır bulundu. ${ready.length} satır otomatik eşleşti; `
      + `${unmatched.length} satır eksik bilgi veya tanınmayan varlık kodu nedeniyle atlanacak. `
      + 'Midas’a hiçbir emir gönderilmez. Onaylanan kayıtlar bu tarayıcıda yerel saklanır.'),
    readyContent,
    unmatchedContent,
    actions);
  close = openModal('Midas işlem aktarımı · önizleme', body, { wide: true });
}
async function readMidas(ctx, button) {
  button.disabled = true;
  button.textContent = 'Midas sekmesi okunuyor…';
  try {
    const rows = await requestMidasHistory();
    if (!rows.length) throw new Error('İşlem satırı bulunamadı. Midas’ta Yatırım İşlem Geçmişi ekranını aç.');
    showMidasPreview(rows, ctx);
  } catch (error) {
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
  const noteInput = h('input', { type: 'text', placeholder: 'İsteğe bağlı', value: existing?.note || '' });

  const priceHint = h('div', { class: 'hint', text: 'Fon ve tarih seçince otomatik dolar' });
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

    nameHint.textContent = meta?.name || (code ? 'Bu kodda fon bulunamadı' : '');
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
    if (!DB.byCode.get(code)) { error.textContent = 'Geçerli bir fon kodu seç.'; return; }
    if (!(qty > 0)) { error.textContent = 'Adet sıfırdan büyük olmalı.'; return; }
    if (!(price > 0)) { error.textContent = 'Birim fiyat sıfırdan büyük olmalı.'; return; }
    if (!dateInput.value) { error.textContent = 'Tarih seç.'; return; }

    const payload = {
      code, type: typeSel.value, date: dateInput.value,
      units: qty, price, fee: Number(feeInput.value) || 0, note: noteInput.value.trim(),
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
      field('Fon', picker.wrap, nameHint),
      field('İşlem', typeSel),
      field('Tarih', dateInput),
      fieldWithLabel(priceLabel, priceInput, priceHint),
      fieldWithLabel(amountLabel, amountInput, h('div', { class: 'hint', text: 'Adet otomatik hesaplanır' })),
      field('Adet', unitsInput, h('div', { class: 'hint', text: 'Tutar otomatik hesaplanır' })),
      fieldWithLabel(feeLabel, feeInput),
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
  root.append(sectionCard('Midas Aktarımı',
    'Açık Midas işlem geçmişini oku; emir gönderilmez. İçe aktarılan kayıtlar bu tarayıcıda kalır ve Supabase’e eşitlenmez.',
    h('div', { class: 'btn-row' }, midasButton)));

  /* --------------------------------------------------------------- ekleme formu */

  if (multiProfile) {
    root.append(h('div', { class: 'notice' },
      'Şu an tüm profiller birlikte görüntüleniyor. Yeni işlem eklemek için üstten '
      + 'tek bir profil seç.'));
  } else {
    root.append(sectionCard('Yeni İşlem', 'Fon ve tarihi seçince fiyat otomatik gelir',
      transactionForm({ prefillCode: ctx.prefill, onDone: () => ctx.refresh() })));
  }

  /* ---------------------------------------------------------------- işlem listesi */

  if (!list.length) {
    root.append(h('div', { class: 'card empty' },
      h('h3', {}, 'Henüz işlem yok'),
      h('p', {}, 'Yukarıdaki formdan ilk alımını ekle.')));
    return root;
  }

  const rows = list.slice().reverse().map((t) => {
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

  root.append(sectionCard('İşlem Geçmişi', `${list.length} kayıt · en yeniden eskiye`,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { style: 'text-align:left' }, 'Tarih'),
        h('th', { style: 'text-align:left' }, 'Fon'),
        h('th', { style: 'text-align:left' }, 'Ünvan'),
        h('th', { style: 'text-align:left' }, 'Tür'),
        h('th', {}, 'Adet'),
        h('th', {}, 'Birim Fiyat'),
        h('th', {}, 'Tutar'),
        h('th', { style: 'text-align:right' }, ''))),
      h('tbody', {}, rows)))));

  return root;
}
