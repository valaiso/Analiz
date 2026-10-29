/* İşlemler: alım/satım kayıtlarını ekleme, düzenleme ve silme. */

import {
  h, tl, money, units as fmtUnits, fmtDate, toast, confirmDialog, isNum, openModal,
} from '../util.js';
import {
  DB, priceOnDate, lastDate, indexForDate, addLocalMarketAssets, pruneLocalMarketAssets, usdTryAtIndex,
} from '../data.js';
import {
  transactions, addTransaction, updateTransaction, removeTransaction,
  allTransactions, addMidasTransactions, saveMidasAccountSnapshot, getMidasAccountSnapshot,
  pruneMidasHistory, dividends, addDividend, removeDividend, cashflows, addManualCashflow, removeCashflow,
} from '../store.js';
import { currentMidasPositions } from '../asset-groups.js';
import { sectionCard, fundPicker, tonedSection } from './common.js';
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
    list.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
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

function positionDiagnosticText(diagnostic) {
  if (!diagnostic) return '';
  const columns = diagnostic.columns?.length ? ` Sütunlar: ${diagnostic.columns.join(' · ')}.` : '';
  const view = diagnostic.activeViewMatches === false ? 'Yanlış Midas çalışma alanı açık. ' : '';
  const table = diagnostic.tableFound ? 'tablo doğrulandı' : 'tablo doğrulanmadı';
  const empty = diagnostic.emptyStateFound ? '; açık pozisyon olmadığı doğrulandı' : '';
  const parse = diagnostic.parseDiagnostics || {};
  const parser = Number.isFinite(parse.containersChecked)
    ? ` Hücre taraması: ${parse.containersChecked} kapsayıcı, ${parse.directOrderMatches || 0} DOM-sırası, ${parse.geometryMatches || 0} koordinat, ${parse.rowsWithSymbol || 0} sembol, ${parse.rowsWithQuantity || 0} adet; kripto geometrisi ${parse.cryptoGeometrySymbols || 0} sembol/${parse.cryptoGeometryRows || 0} satır (${parse.cryptoGeometryRejected || 0} elendi); elenen: hücre ${parse.rejected?.noCells || 0}, sembol ${parse.rejected?.noSymbol || 0}, adet ${parse.rejected?.noQuantity || 0}, fiyat ${parse.rejected?.noPrice || 0}.`
    : '';
  return `Tanı: ${view}${table}${empty}; Pozisyonlar başlığı ${diagnostic.headingFound ? 'var' : 'yok'}, uygun sütun başlığı ${diagnostic.headerFound ? 'var' : 'yok'}, ${diagnostic.rowCandidates || 0} satır adayı, ${diagnostic.validRows || 0} geçerli açık varlık.${columns}${parser}`;
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

function paginatedRows(items, renderTable, itemLabel = 'işlem') {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  let page = 0;
  const content = h('div', { class: 'stack', style: 'gap:10px' });
  const render = () => {
    page = Math.max(0, Math.min(page, pageCount - 1));
    const start = page * pageSize;
    const visible = items.slice(start, start + pageSize);
    const range = items.length ? `${start + 1}–${start + visible.length} / ${items.length} ${itemLabel}` : `0 ${itemLabel}`;
    const controls = h('div', { class: 'pagination' },
      h('span', { class: 'dim', text: range }),
      pageCount > 1 ? h('div', { class: 'pagination-controls' },
        h('button', {
          class: 'btn btn-sm', type: 'button', disabled: page === 0,
          'aria-label': 'Önceki sayfa', onclick: () => { page -= 1; render(); },
        }, '‹ Önceki'),
        h('span', { class: 'dim', 'aria-live': 'polite' }, `Sayfa ${page + 1} / ${pageCount}`),
        h('button', {
          class: 'btn btn-sm', type: 'button', disabled: page >= pageCount - 1,
          'aria-label': 'Sonraki sayfa', onclick: () => { page += 1; render(); },
        }, 'Sonraki ›')) : null);
    content.replaceChildren(renderTable(visible), controls);
  };
  render();
  return content;
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
  // Fiyat geçmişi eksik semboller beklenmeden atlanır; diğer işlemler aktarılır.
  const importable = ready.filter((row) => DB.byCode.has(row.code));
  const reusedCount = importable.filter((row) => row.fromStore).length;
  const line = (row) => h('tr', {},
    h('td', {}, row.date || '—'),
    h('td', {}, row.code || '—'),
    h('td', {}, row.type === 'SAT' ? 'Satış' : row.type === 'AL' ? 'Alış' : '—'),
    h('td', {}, row.units > 0 ? fmtUnits(row.units) : '—'),
    h('td', {}, row.price > 0 ? money(row.price) : '—'),
    h('td', { style: 'text-align:left;max-width:360px;white-space:normal' },
      row.missing?.length ? `${row.rawText} · ${row.diagnostic || `Okunamayan: ${row.missing.join(', ')}`}` : row.rawText));

  const table = (items, priceHeading, textHeading) => paginatedRows(items, (pageItems) =>
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'Tarih'),
          h('th', {}, 'Kod'),
          h('th', {}, 'Tür'),
          h('th', {}, 'Miktar'),
          h('th', {}, priceHeading),
          h('th', { style: 'text-align:left' }, textHeading))),
        h('tbody', {}, pageItems.map(line)))));

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
      disabled: !importable.length && !applyLifecycle,
      onclick: () => {
        const lifecycleResult = applyLifecycle?.();
        if (lifecycleResult && (lifecycleResult.removedTransactions || lifecycleResult.pruned.removed || lifecycleResult.pruned.trimmed)) {
          logMidas(`Kapalı dönem temizliği: ${lifecycleResult.removedTransactions} Midas işlem kaydı, ${lifecycleResult.pruned.removed} fiyat geçmişi silindi; ${lifecycleResult.pruned.trimmed} açık varlığın geçmişi alış tarihinden başlatıldı.`);
        }
        const result = addMidasTransactions(importable);
        // Erken durulan okumada kayıtlı eski işlemler silinip aynen geri yazılır; yeni sayılmaz.
        const added = Math.max(0, result.added - reusedCount);
        logMidas(`${added} yeni işlem eklendi, ${result.updated} mevcut Midas işlemi güncellendi, ${result.skipped} kayıt atlandı${reusedCount ? `, ${reusedCount} kayıtlı işlem korundu` : ''}.`);
        close();
        toast(added || result.updated
          ? `${added} yeni, ${result.updated} güncellenmiş Midas işlemi kaydedildi`
          : 'Yeni işlem yok; kayıtlar güncel');
        ctx.refresh();
      },
    }, unknownCodes.length
      ? `${importable.length} işlemi içe aktar (${unknownCodes.join(', ')} hariç)`
      : `${ready.length} işlemi içe aktar`));

  const body = h('div', { class: 'stack' },
    h('p', { class: 'dim' },
      `${candidates.length - candidates.filter((row) => row.fromStore).length} satır okundu (${scanInfo.scannedPages} sayfa)`
      + `${reusedCount ? `; ${reusedCount} kayıtlı eski işlem korunuyor` : ''}. ${ready.length} satır işlem bilgisi açısından tam; `
      + `${unknownCodes.length} kodda alış tarihinden itibaren fiyat geçmişi hâlâ eksik, ${unmatched.length} satırda işlem bilgisi eksik. `
      + 'Aktarım için sembollerin fiyat geçmişi gerekir. Midas’a hiçbir emir gönderilmez; ek fiyat geçmişleri hesabının ortak havuzuna eşitlenir, işlemler bu tarayıcıda kalır.'),
    quoteNotice,
    readyContent,
    unmatchedContent,
    actions);
  close = openModal('Midas işlem aktarımı · önizleme', body, { wide: true });
}
/**
 * Midas okumasında eski sayfaları atlamak için durma tarihi: bu hesap türündeki (yatırım ya da
 * kripto) kayıtlı en son Midas işleminden 3 gün öncesi. Güvenlik payı aynı gün/yakın günlerde
 * gecikmeli görünen emirleri de yeniden okutur; kayıt yoksa tamamı okunur.
 */
function midasStopBefore(crypto) {
  const dates = allTransactions().filter((tx) => tx.source === 'midas'
    && (DB.byCode.get(tx.code)?.kind === 'CRYPTO') === crypto && /^\d{4}-\d{2}-\d{2}/.test(tx.date || ''))
    .map((tx) => tx.date.slice(0, 10)).sort();
  if (!dates.length) return '';
  const last = new Date(`${dates.at(-1)}T12:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 3);
  return last.toISOString().slice(0, 10);
}

/** Kayıtlı Midas işlemini eklentinin satır biçimine çevirir (erken durulan okumada birleştirmek için). */
const storedAsRow = (tx) => ({
  date: tx.date, time: tx.time || '', type: tx.type, code: tx.code, units: tx.units, price: tx.price,
  fee: tx.fee || 0, withholdingTax: tx.withholdingTax || 0, currency: tx.currency || '', sourceId: tx.sourceId || '',
  missing: [], fromStore: true,
});

async function readMidas(ctx, button) {
  button.disabled = true;
  button.textContent = 'Midas ve fiyat verileri okunuyor…';
  logMidas('Midas emir geçmişi taraması başlatıldı.');
  logMidas('Fiyat havuzunda olmayan semboller için Midas işlem geçmişindeki açık alış döneminden başlayan fiyat geçmişi aranacak; mevcut ek varlıkların fiyatları da yenilenecek.');
  let accountLogged = false;
  try {
    const stopBefore = midasStopBefore(false);
    if (stopBefore) logMidas(`${stopBefore} öncesindeki işlemler zaten kayıtlı; okuyucu oraya gelince eski sayfaları atlayacak.`);
    const result = await requestMidasHistory(
      DB.funds.map((fund) => fund.code),
      DB.funds.filter((fund) => fund.localMarketData)
        .map((fund) => ({ code: fund.code, source: fund.catSrc, kind: fund.kind, startDate: fund.startDate })),
      DB.funds.filter((fund) => ['YAT', 'EMK', 'GYF', 'GSYF'].includes(fund.kind))
        .map((fund) => fund.code),
      600_000, { stopBefore },
    );
    if (result.stoppedEarly) {
      // Yalnızca yeni sayfalar okundu: durma tarihinden önceki kısım kayıtlı işlemlerden tamamlanır.
      // Sınır net bölünür (okunan satırlardan durma tarihinden öncekiler atılır) ki hiçbir emir iki kez sayılmasın.
      const older = allTransactions().filter((tx) => tx.source === 'midas'
        && DB.byCode.get(tx.code)?.kind !== 'CRYPTO' && tx.date < result.stopBefore).map(storedAsRow);
      const fresh = result.rows.filter((row) => !row.date || row.date >= result.stopBefore);
      logMidas(`${result.scannedPages} sayfa okundu, kayıtlı son işlemlere ulaşılınca durdu; ${result.stopBefore} öncesindeki ${older.length} kayıtlı işlem korunarak birleştirildi.`);
      result.rows = [...older, ...fresh];
    }
    logMidas(`Midas okuyucu sürümü: ${result.extensionVersion}.`);
    saveMidasAccountSnapshot({
      capturedAt: new Date().toISOString(),
      summary: result.accountSummary,
      positions: result.positions,
      positionsCaptured: result.positionsCaptured,
      positionsDiagnostic: result.positionsDiagnostic,
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
      const latestFxIndex = Math.max(0, DB.calendar.length - 1);
      const positionValueTRY = result.positions.reduce((sum, position) => {
        if (!(position.units > 0) || !(position.price > 0)) return sum;
        const fx = position.currency === 'USD' ? usdTryAtIndex(latestFxIndex) : 1;
        return sum + position.units * position.price * (Number.isFinite(fx) ? fx : 1);
      }, 0);
      logMidas(`Midas canlı adet×fiyat toplamı yaklaşık ${tl(positionValueTRY)}; pozisyon kartı bunu eski emir adetleri yerine kullanacak.`);
      for (const position of result.positions.filter((row) => row.code === 'TP2')) {
        logMidas(`TP2 adet kontrolü: Midas hücresi “${position.unitsText || 'okunamadı'}” → ayrıştırılan adet ${Number.isFinite(position.units) ? fmtUnits(position.units) : 'okunamadı'}.`);
      }
      for (const position of result.positions) {
        logMidas(`${position.code} Midas alanları: adet “${position.unitsText || 'yok'}” → ${Number.isFinite(position.units) ? fmtUnits(position.units) : 'okunamadı'}; fiyat ${Number.isFinite(position.price) ? position.price : 'yok'} ${position.currency}; ort. maliyet ${Number.isFinite(position.avgCost) ? position.avgCost : 'yok'}; dağılım ${Number.isFinite(position.allocationPct) ? `${position.allocationPct}%` : 'yok'}; hücre eşleme ${position.positionAlignment || 'belirlenemedi'}.`);
        if (position.costDiagnostic) logMidas(`${position.code}: ${position.costDiagnostic}. Maliyet K/Z hesabında kullanılmadı.`);
        if (position.domCells?.length) logMidas(`${position.code} sütun tanısı: ${position.domCells.map((cell) => `${cell.header}=[${cell.raw}]`).join(' | ')}.`);
      }
    } else if (result.positionsCaptured) {
      logMidas('Midas Pozisyonlar tablosu doğrulandı; yatırım hesabında açık hisse/fon pozisyonu yok.');
    } else {
      logMidas(`Midas Pozisyonlar tablosundaki açık varlıklar okunamadı. Emir geçmişinden pozisyon türetilmeyecek. ${positionDiagnosticText(result.positionsDiagnostic)}`);
    }
    logMidas(`${result.scannedPages} sayfa tarandı; ${rows.length} satır okundu, ${valid.length} satır aktarılabilir, ${rows.length - valid.length} satır eksik bilgi içeriyor.`);
    if (result.duplicateOrdersRemoved) logMidas(`Aynı emirlerin ${result.duplicateOrdersRemoved} yinelenen satırı elendi.`);
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
    const cycleEvents = new Map();
    for (const tx of rows) {
      const key = [tx.date, tx.code, tx.type, tx.time || '', tx.units, tx.price].join('|');
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
      } else if (cycle?.hasSell
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
      removedTransactions: pruneMidasHistory(activeCycleStarts, closedCodes, [...cycles.keys()]),
      pruned: pruneLocalMarketAssets(activeCycleStarts, closedCodes),
    }));
  } catch (error) {
    if (error.accountSummary || Object.prototype.hasOwnProperty.call(error, 'positionsCaptured') || error.positions?.length) {
      if (!accountLogged) logMidasAccount(error.accountSummary);
      saveMidasAccountSnapshot({
        capturedAt: new Date().toISOString(), summary: error.accountSummary,
        positions: error.positions, positionsCaptured: error.positionsCaptured,
        positionsDiagnostic: error.positionsDiagnostic,
      });
      if (error.positionsCaptured || error.positions?.length) {
        logMidas(`Emir satırları okunamasa da güncel Midas pozisyonları eşitlendi (${error.positions?.length || 0} varlık).`);
        ctx.refresh();
      } else {
        logMidas(`Midas Pozisyonlar tablosu bu taramada doğrulanamadı; geçmiş işlemler açık pozisyon sayılmayacak. ${positionDiagnosticText(error.positionsDiagnostic)}`);
        ctx.refresh();
      }
    }
    logMidas(`HATA: ${error.message}`);
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Midas’tan İşlemleri Oku';
  }
}

async function readMidasCrypto(ctx, button) {
  button.disabled = true;
  button.textContent = 'Kripto emir geçmişi okunuyor…';
  logMidas('Midas kripto emir geçmişi taraması başlatıldı.');
  try {
    const stopBefore = midasStopBefore(true);
    if (stopBefore) logMidas(`${stopBefore} öncesindeki kripto emirleri zaten kayıtlı; okuyucu oraya gelince eski sayfaları atlayacak.`);
    const result = await requestMidasHistory([], DB.funds.filter((fund) => fund.localMarketData
      && fund.kind === 'CRYPTO' && !['USDT', 'USDC'].includes(String(fund.code).toUpperCase()))
      .map((fund) => ({ code: fund.code, source: fund.catSrc, kind: fund.kind, startDate: fund.startDate })),
    [], 600_000, { cryptoOnly: true, stopBefore });
    if (result.stoppedEarly) {
      logMidas(`${result.scannedPages} sayfa okundu, kayıtlı son kripto emirlerine ulaşılınca durdu.`);
    }
    logMidas(`Midas okuyucu sürümü: ${result.extensionVersion}.`);
    const cryptoPositionValue = (result.cryptoPositions || []).reduce((sum, position) => {
      const nativeValue = Number.isFinite(position.marketValue) ? position.marketValue
        : Number(position.units) * Number(position.price);
      if (!(nativeValue > 0)) return sum;
      const fx = position.currency === 'USD'
        ? usdTryAtIndex(Math.max(0, indexForDate(new Date().toISOString().slice(0, 10)))) : 1;
      return sum + nativeValue * (Number.isFinite(fx) ? fx : 1);
    }, 0);
    saveMidasAccountSnapshot({
      capturedAt: new Date().toISOString(),
      cryptoSummary: result.cryptoPositionsCaptured ? { totalValue: cryptoPositionValue } : null,
      cryptoPositions: result.cryptoPositions || [],
      cryptoPositionsCaptured: result.cryptoPositionsCaptured,
      cryptoPositionsDiagnostic: result.cryptoPositionsDiagnostic,
    });
    if (result.cryptoPositionsCaptured) {
      logMidas((result.cryptoPositions || []).length
        ? `Midas Kripto Pozisyonlar tablosundan ${result.cryptoPositions.length} açık varlık okundu; güncel değer ${tl(cryptoPositionValue)}.`
        : 'Midas Kripto Pozisyonlar tablosu doğrulandı; açık kripto pozisyonu yok.');
      ctx.refresh();
    } else {
      logMidas(`Midas Crypto Pozisyonlar tablosu bu taramada okunamadı; emir geçmişinden açık kripto pozisyonu türetilmeyecek. ${positionDiagnosticText(result.cryptoPositionsDiagnostic)}`);
    }
    if (result.ignoredStablecoinCount) {
      logMidas(`${result.ignoredStablecoinCount} USDT/USDC karşıt para birimi emri kripto varlık işlemi olarak aktarılmadı.`);
    }
    if (!result.rows.length) {
      logMidas('Kripto emir geçmişinde tamamlanmış satır bulunamadı; mevcut pozisyon tablosu eşitlendi.');
      toast('Kripto pozisyonları eşitlendi; aktarılacak tamamlanmış emir bulunamadı.');
      return;
    }
    const assets = Object.values(result.marketData || {}).map((asset) => ({
      ...asset, kind: 'CRYPTO', category: 'Kripto',
    }));
    const assetByCode = new Map(assets.map((asset) => [asset.code, asset]));
    for (const row of result.rows) {
      if (['USDT', 'USDC'].includes(String(row.code || '').toUpperCase())) continue;
      if (!row.code || !row.date || !(row.price > 0) || assetByCode.has(row.code)) continue;
      assetByCode.set(row.code, {
        code: row.code, name: row.code, kind: 'CRYPTO', category: 'Kripto',
        currency: row.currency || 'TRY', source: 'Midas emir geçmişi', partial: true,
        startDate: row.date, prices: [{ date: row.date, price: row.price }],
      });
    }
    for (const row of result.rows) {
      const asset = assetByCode.get(row.code);
      if (!asset || !row.currency || row.currency === asset.currency || !(row.price > 0)) continue;
      const rate = usdTryAtIndex(Math.max(0, indexForDate(row.date)));
      if (!(rate > 0)) continue;
      row.price = row.currency === 'TRY' ? row.price / rate : row.price * rate;
      row.currency = asset.currency;
    }
    const stored = addLocalMarketAssets([...assetByCode.values()]);
    logMidas(`${result.scannedPages} sayfa tarandı; ${result.rows.length} kripto emri okundu, ${stored} kripto fiyat geçmişi eşitlendi.`);
    for (const [code, error] of Object.entries(result.marketErrors || {})) logMidas(`${code}: ${error}`);
    const unresolvedSymbols = result.rows.filter((row) => row.missing?.includes('sembol'));
    if (unresolvedSymbols.length) {
      logMidas(`${unresolvedSymbols.length} kripto emrinde varlık sembolü okunamadı; USDT/USDC para birimi sembol olarak kullanılmadı. Ayrıntılar önizlemede.`);
    }
    showMidasPreview(result.rows, result, ctx, result.marketErrors || {});
    if (stored) ctx.refresh();
  } catch (error) {
    if (Object.prototype.hasOwnProperty.call(error, 'cryptoPositionsCaptured')) {
      const positions = error.cryptoPositions || [];
      const totalValue = positions.reduce((sum, position) => sum
        + (Number(position.marketValue) || (Number(position.units) * Number(position.price) || 0)), 0);
      saveMidasAccountSnapshot({
        capturedAt: new Date().toISOString(),
        cryptoSummary: error.cryptoPositionsCaptured ? { totalValue } : null,
        cryptoPositions: positions, cryptoPositionsCaptured: error.cryptoPositionsCaptured,
        cryptoPositionsDiagnostic: error.cryptoPositionsDiagnostic,
      });
      logMidas(error.cryptoPositionsCaptured
        ? `Emir satırları okunamasa da güncel kripto pozisyonları eşitlendi (${positions.length} varlık).`
        : `Kripto Pozisyonlar tablosu bu taramada doğrulanamadı; geçmiş işlemler açık pozisyon sayılmayacak. ${positionDiagnosticText(error.cryptoPositionsDiagnostic)}`);
      ctx.refresh();
    }
    logMidas(`Kripto aktarım hatası: ${error.message}`);
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Kripto Emirlerini Oku';
  }
}

/** Seçilen varlığın USD bazlı olup olmadığını belirler. */
function getAssetCurrency(code) {
  const meta = DB.byCode.get(code);
  const isUsd = meta?.currency ? meta.currency === 'USD'
    : Boolean(meta && (meta.kind === 'US_ETF' || meta.kind === 'CRYPTO'));
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
  if (existing) unitsInput.value = String(existing.units);
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
  const availableUnitsHint = h('div', { class: 'hint' });

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

  function refreshAvailableUnits() {
    if (typeSel.value !== 'SAT') {
      availableUnitsHint.textContent = 'Tutar otomatik hesaplanır';
      return;
    }
    const code = picker.get();
    const txRows = transactions().filter((row) => row.code === code && (!existing || row.id !== existing.id));
    let available = txRows.reduce((sum, row) => sum + (row.type === 'AL' ? Number(row.units) : -Number(row.units)), 0);
    if (!txRows.length) {
      const position = (currentMidasPositions() || []).find((row) => row.code === code);
      available = Number(position?.units) || 0;
    }
    availableUnitsHint.textContent = code && available > 0 ? `Mevcut: ${fmtUnits(available)}` : 'Mevcut: —';
  }

  dateInput.addEventListener('change', () => syncPrice(true));
  picker.input.addEventListener('input', refreshAvailableUnits);
  picker.input.addEventListener('blur', () => { syncPrice(true); refreshAvailableUnits(); });
  typeSel.addEventListener('change', refreshAvailableUnits);
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
      field('Adet', unitsInput, availableUnitsHint),
      fieldWithLabel(feeLabel, feeInput),
      field('Stopaj (₺)', taxInput, h('div', { class: 'hint', text: 'Midas/ekstrede görünen gerçek kesintiyi gir' })),
      field('Not', noteInput)),
    error,
    h('div', { class: 'btn-row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: submit },
        isEdit ? 'Kaydet' : 'İşlemi Ekle')));

  if (existing || prefillCode) syncPrice(!existing);
  refreshAvailableUnits();
  return form;
}

/** Temettü geliri: girilen tutar getiri sayılır, ana paraya eklenmez. */
function dividendSection(ctx) {
  const dateInput = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const codeInput = h('input', { type: 'text', placeholder: 'Örn. SPY', maxlength: 12, style: 'text-transform:uppercase' });
  const amountInput = h('input', { type: 'number', step: 'any', min: '0', placeholder: '0,00' });
  const error = h('div', { class: 'hint', style: 'color:var(--down)' });
  const field = (label, control, hint) => h('div', { class: 'field' },
    h('label', { text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null);
  const submit = () => {
    const record = addDividend({ date: dateInput.value, code: codeInput.value, amount: amountInput.value });
    if (!record) { error.textContent = 'Tarih ve 0’dan büyük bir tutar gir.'; return; }
    toast(record.adjustments.length
      ? `${tl(record.amount)} temettü kaydedildi; aynı dönemdeki para girişinden düşüldü`
      : `${tl(record.amount)} temettü kaydedildi`);
    ctx.refresh();
  };
  const list = dividends().slice().reverse();
  const total = list.reduce((sum, item) => sum + item.amount, 0);
  const year = new Date().getFullYear();
  const thisYear = list.filter((item) => item.date.startsWith(String(year))).reduce((sum, item) => sum + item.amount, 0);
  const table = list.length ? h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Tarih'), h('th', {}, 'Varlık'), h('th', {}, 'Net tutar'), h('th', {}, ''))),
    h('tbody', {}, list.map((item) => h('tr', {},
      h('td', {}, fmtDate(item.date)),
      h('td', {}, item.code ? h('span', { class: 'code-chip' }, item.code) : '—'),
      h('td', {}, tl(item.amount)),
      h('td', {}, h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
          if (await confirmDialog('Temettüyü sil', `${fmtDate(item.date)} ${item.code || ''} ${tl(item.amount)} temettü kaydı silinsin mi?`)) {
            removeDividend(item.id);
            ctx.refresh();
          }
        },
      }, 'Sil'))))))) : null;
  return tonedSection('teal', '₺', 'Temettü Geliri',
    'Hesabına geçen net tutarı gir. Temettü getiri sayılır, ana paraya eklenmez; Midas taramasının “para eklendi” tespitinden otomatik düşülür.',
    h('div', { class: 'form-grid' },
      field('Tarih', dateInput),
      field('Varlık kodu', codeInput, 'İsteğe bağlı'),
      field('Net tutar (₺)', amountInput, 'Vergi kesintisi sonrası hesaba geçen')),
    error,
    h('div', { class: 'btn-row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, 'Temettüyü Ekle')),
    list.length ? h('p', { class: 'dim', style: 'margin:0' },
      `Toplam ${tl(total)} · ${year} yılı ${tl(thisYear)}`) : null,
    table);
}

/** Elle nakit ekleme/çekme: para hareketi olarak kaydedilir, kâr sayılmaz. */
function cashSection(ctx) {
  const dateInput = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const typeInput = h('select', {}, h('option', { value: 'ekle' }, 'Nakit ekleme (yatırma)'), h('option', { value: 'cek' }, 'Nakit çekme'));
  const amountInput = h('input', { type: 'number', step: 'any', min: '0', placeholder: '0,00' });
  const noteInput = h('input', { type: 'text', maxlength: 80, placeholder: 'Örn. maaş' });
  const error = h('div', { class: 'hint', style: 'color:var(--down)' });
  const field = (label, control, hint) => h('div', { class: 'field' },
    h('label', { text: label }), control, hint ? h('div', { class: 'hint', text: hint }) : null);
  const submit = () => {
    const amount = Number(amountInput.value);
    if (!(amount > 0)) { error.textContent = 'Tarih ve 0’dan büyük bir tutar gir.'; return; }
    const record = addManualCashflow({ date: dateInput.value, amount: typeInput.value === 'cek' ? -amount : amount, note: noteInput.value });
    if (!record) { error.textContent = 'Tarih ve 0’dan büyük bir tutar gir.'; return; }
    toast(record.adjustments.length
      ? `${tl(Math.abs(record.amount))} ${record.amount > 0 ? 'nakit ekleme' : 'nakit çekme'} kaydedildi; Midas tespitiyle çakışan kısım düşüldü`
      : `${tl(Math.abs(record.amount))} ${record.amount > 0 ? 'nakit ekleme' : 'nakit çekme'} kaydedildi`);
    ctx.refresh();
  };
  const list = cashflows().slice().reverse();
  const net = list.reduce((sum, flow) => sum + flow.amount, 0);
  const sourceLabel = (flow) => (flow.source === 'elle' ? 'Elle' : flow.source === 'midas-tespit' ? 'Midas tespiti' : '—');
  const table = list.length ? h('div', { class: 'table-wrap cash-table' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Tarih'), h('th', {}, 'Tür'), h('th', {}, 'Tutar'), h('th', {}, 'Kaynak'), h('th', {}, 'Not'), h('th', {}, ''))),
    h('tbody', {}, list.map((flow) => h('tr', {},
      h('td', {}, fmtDate(flow.date)),
      h('td', {}, flow.amount >= 0 ? 'Ekleme' : 'Çekme'),
      h('td', { class: flow.amount >= 0 ? 'up' : 'down' }, `${flow.amount >= 0 ? '+' : '−'}${tl(Math.abs(flow.amount))}`),
      h('td', { class: 'dim' }, sourceLabel(flow)),
      h('td', { class: 'dim' }, flow.note || ''),
      h('td', {}, h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
          if (await confirmDialog('Nakit kaydını sil', `${fmtDate(flow.date)} ${tl(Math.abs(flow.amount))} ${flow.amount >= 0 ? 'ekleme' : 'çekme'} kaydı silinsin mi? Gerçek getiri yeniden hesaplanır.`)) {
            removeCashflow(flow.id);
            ctx.refresh();
          }
        },
      }, 'Sil'))))))) : null;
  return tonedSection('blue', '₺', 'Nakit Eklenmesi',
    'Hesaba kendin para eklediğinde ya da çektiğinde gir. Kâr sayılmaz: gerçek getiriden düşülür, yatırılan paraya eklenir. Midas taraması aynı parayı tespit ederse tekrar sorulmaz.',
    h('div', { class: 'form-grid' },
      field('Tarih', dateInput),
      field('İşlem', typeInput),
      field('Tutar (₺)', amountInput),
      field('Not', noteInput, 'İsteğe bağlı')),
    error,
    h('div', { class: 'btn-row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, 'Kaydet')),
    list.length ? h('p', { class: 'dim', style: 'margin:0' }, `Net para girişi ${net >= 0 ? '+' : '−'}${tl(Math.abs(net))} · ${list.length} kayıt`) : null,
    table);
}

export function renderIslemler(ctx) {
  const root = h('div', { class: 'stack' });
  const list = transactions();

  const midasButton = h('button', {
    class: 'btn btn-primary', type: 'button',
    onclick: (event) => readMidas(ctx, event.currentTarget),
  }, 'Midas’tan İşlemleri Oku');
  const cryptoMidasButton = h('button', {
    class: 'btn', type: 'button',
    onclick: (event) => readMidasCrypto(ctx, event.currentTarget),
  }, 'Kripto Emirlerini Oku');
  const copyLogButton = h('button', {
    class: 'btn', type: 'button', onclick: () => copyMidasLog(midasLogField),
  }, 'Yanıtı kopyala');
  midasLogField = h('textarea', {
    readonly: true, rows: 5, 'aria-label': 'Midas aktarım yanıt geçmişi',
    style: 'width:100%;resize:vertical;font: .85rem var(--mono);margin-top:10px',
  }, midasActivity.length ? midasActivity.join('\n') : 'Henüz aktarım yapılmadı. Sonuçlar ve hatalar burada görünür.');
  root.append(tonedSection('blue', '⇣', 'Midas Aktarımı',
    'Yatırım veya Kripto ekranında Emir geçmişini açıp ilgili aktarım düğmesine bas. Bekleyen/iptal emirleri atlanır. Emir gönderilmez; işlem kayıtları bu tarayıcıda tutulur.',
    h('div', { class: 'btn-row' }, midasButton, cryptoMidasButton, copyLogButton),
    h('label', { style: 'display:block;margin-top:12px;font-weight:600' }, 'Aktarım yanıt geçmişi'),
    midasLogField));

  root.append(dividendSection(ctx));
  root.append(cashSection(ctx));

  /* --------------------------------------------------------------- ekleme formu */

  root.append(tonedSection('indigo', '+', 'Yeni İşlem', 'Varlık kodu ve tarihi seçince fiyat otomatik gelir',
    transactionForm({ prefillCode: ctx.prefill, onDone: () => ctx.refresh() })));

  /* ---------------------------------------------------------------- işlem listesi */

  if (!list.length) {
    root.append(h('div', { class: 'card empty' },
      h('h3', {}, 'Henüz işlem yok'),
      h('p', {}, 'Yukarıdaki formdan ilk alımını ekle.')));
    return root;
  }

  const historyRows = list.slice().reverse();
  const historyTable = paginatedRows(historyRows, (pageRows) => {
    const rows = pageRows.map((t) => {
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
    return h('div', { class: 'table-wrap' }, h('table', {},
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
      h('tbody', {}, rows)));
  });

  root.append(tonedSection('slate', '≡', 'İşlem Geçmişi',
    `${list.length} kayıt · sayfa başına 10 · en yeniden eskiye`, historyTable));

  return root;
}
