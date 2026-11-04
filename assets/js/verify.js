/* Veri doğrulama: panelin gösterdiği rakamları kendi içinde ve kaynaklarla (Midas taraması,
   TEFAS, döviz kuru, kayıtlı günlük değerler) karşılaştırır. Her panel çiziminde çalışır;
   ↻ Yenile'ye basınca taze veriyle yeniden çalışır ve özeti gösterir. */

import { DB, cachedHistory, exactPriceAtIndex, indexForDate, lastIndex, usdTryAtIndex } from './data.js';
import { isTurkishMarketClosed } from './holidays.js';

const tl = (value) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 }).format(value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function istanbulDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(date);
}

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Bugünden önceki son Türkiye iş günü (bugün iş günüyse bugün). */
function lastTurkishTradingDay(today) {
  let day = today;
  for (let i = 0; i < 10 && isTurkishMarketClosed(day); i += 1) day = addDays(day, -1);
  return day;
}

/** İki tarih arasındaki (ikisi hariç) Türkiye iş günleri. */
function tradingDaysBetween(from, to) {
  const days = [];
  for (let day = addDays(from, 1); day < to; day = addDays(day, 1)) {
    if (!isTurkishMarketClosed(day)) days.push(day);
  }
  return days;
}

let lastResult = null;
export const lastDataChecks = () => lastResult;

/**
 * @returns {{at: string, checks: {status: 'ok'|'warn'|'error', title: string, detail: string}[]}}
 */
export function runDataChecks(input) {
  const {
    snapshot, rows = [], stockAccount, cryptoTotal = 0, total, dailyAmount,
    history = {}, flows = [], start, baseline, pending, oversold = [], totalGain = null, realizedSinceStart = 0,
    dividendsSinceStart = 0, openingRows = null,
  } = input;
  const checks = [];
  const add = (status, title, detail) => checks.push({ status, title, detail });
  const today = istanbulDate();
  const live = rows.filter((row) => row.units > 0);

  // 1) Toplam = pozisyonlar + nakit (+ kripto)
  if (stockAccount && isNum(total)) {
    const sum = stockAccount.positions + stockAccount.cash + cryptoTotal;
    const diff = sum - total;
    add(Math.abs(diff) < 1 ? 'ok' : 'error', 'Toplam değer = pozisyonlar + nakit',
      Math.abs(diff) < 1
        ? `${tl(stockAccount.positions)} pozisyon + ${tl(stockAccount.cash)} nakit${cryptoTotal ? ` + ${tl(cryptoTotal)} kripto` : ''} = ${tl(total)}`
        : `Pozisyon ve nakit toplamı ${tl(sum)}, gösterilen toplam ${tl(total)} (${tl(diff)} fark).`);
  }

  // 2) Midas taramasındaki fiyatlar sitenin fiyatlarıyla uyumlu mu?
  const scanDay = istanbulDate(snapshot?.stockCapturedAt || snapshot?.capturedAt || '');
  const scanIndex = scanDay ? indexForDate(scanDay) : -1;
  const priceIssues = [];
  for (const row of live) {
    if (row.frozen || row.midasCryptoSnapshot || !(row.midasPrice > 0) || scanIndex < 0) continue;
    const hist = cachedHistory(row.code);
    if (row.currency === 'USD') {
      // ABD fiyatı: tarama günü ya da bir önceki işlem gününün kapanışına göre ±%4
      const closes = [exactPriceAtIndex(hist, scanIndex), exactPriceAtIndex(hist, scanIndex - 1), row.price].filter((p) => p > 0);
      if (closes.length && !closes.some((p) => Math.abs(p / row.midasPrice - 1) <= 0.04)) {
        priceIssues.push(`${row.code}: Midas $${row.midasPrice}, site $${closes[0].toFixed(2)}`);
      }
    } else {
      const exact = exactPriceAtIndex(hist, scanIndex);
      // Midas fon fiyatını kuruşa yuvarlar: fark en fazla yarım kuruş olmalı
      if (exact && Math.abs(exact - row.midasPrice) > 0.0051) {
        priceIssues.push(`${row.code}: Midas ₺${row.midasPrice}, TEFAS ₺${exact}`);
      }
    }
  }
  add(priceIssues.length ? 'warn' : 'ok', 'Fiyatlar Midas ile uyumlu',
    priceIssues.length ? `Farklı fiyat: ${priceIssues.join(' · ')}` : `${live.filter((r) => !r.frozen).length} varlığın fiyatı Midas taramasıyla tutarlı.`);

  // 3) Fiyatların güncelliği
  const tefasLast = DB.calendar.at(-1);
  const expectedDay = today ? lastTurkishTradingDay(today) : null;
  const tefasLate = tefasLast && expectedDay && tradingDaysBetween(tefasLast, expectedDay).length > 0;
  add(tefasLate ? 'warn' : 'ok', 'TEFAS verisi güncel',
    tefasLate ? `Son TEFAS günü ${tefasLast}; ${expectedDay} bekleniyordu. Veri güncellemesi gecikmiş olabilir.`
      : `Son TEFAS fiyat günü ${tefasLast}.`);
  const staleRows = live.filter((row) => {
    if (row.frozen || !row.quoteDate) return false;
    if (row.currency === 'USD') return (Date.parse(today) - Date.parse(row.quoteDate)) / 86400000 > 4;
    return tefasLast && row.quoteDate < tefasLast && tradingDaysBetween(row.quoteDate, tefasLast).length >= 1;
  });
  // Fonların hepsi aynı TEFAS fiyat gününden mi? (farklıysa günlük kazanç farklı günleri karıştırır)
  const fundDays = [...new Set(live.filter((row) => !row.frozen && row.currency !== 'USD' && !row.midasCryptoSnapshot && row.quoteDate)
    .map((row) => row.quoteDate))].sort();
  if (fundDays.length) {
    add(fundDays.length > 1 ? 'warn' : 'ok', 'Fonlar aynı fiyat gününde',
      fundDays.length > 1
        ? `Fonlar farklı günlerin fiyatıyla hesaplanıyor (${live.filter((r) => !r.frozen && r.currency !== 'USD' && r.quoteDate)
          .map((r) => `${r.code} ${r.quoteDate}`).join(', ')}); günlük kazanç farklı günleri karıştırıyor olabilir.`
        : `Bütün fonlar ${fundDays[0]} TEFAS fiyatıyla hesaplanıyor.`);
  }
  add(staleRows.length ? 'warn' : 'ok', 'Varlık fiyatları güncel',
    staleRows.length ? `Eski fiyatla hesaplanan: ${staleRows.map((r) => `${r.code} (${r.quoteDate})`).join(', ')}`
      : 'Bütün açık varlıklar son fiyatla hesaplanıyor (temerrütteki fonlar sabit fiyatlı).');

  // 4) Döviz kuru
  const fxNow = usdTryAtIndex(lastIndex());
  const fxPrev = usdTryAtIndex(lastIndex() - 1);
  if (live.some((row) => row.currency === 'USD')) {
    const jump = isNum(fxNow) && isNum(fxPrev) && fxPrev > 0 ? Math.abs(fxNow / fxPrev - 1) : null;
    add(!isNum(fxNow) ? 'error' : jump !== null && jump > 0.03 ? 'warn' : 'ok', 'Dolar/TL kuru',
      !isNum(fxNow) ? 'Kur bulunamadı; dolar varlıkları hesaplanamaz.'
        : `USD/TRY ${fxNow.toFixed(4)}${jump !== null ? ` (önceki güne göre %${(jump * 100).toFixed(2)} değişim)` : ''}`);
  }

  // 5) Günlük kazanç = varlıkların günlük değişim toplamı
  if (isNum(dailyAmount)) {
    const sum = live.reduce((s, row) => s + (isNum(row.dailyPLTRY) ? row.dailyPLTRY : 0), 0);
    const diff = dailyAmount - sum;
    add(Math.abs(diff) < 1 ? 'ok' : 'warn', 'Günlük kazanç tutarlı',
      Math.abs(diff) < 1 ? `Günlük ${tl(dailyAmount)} = varlıkların günlük değişim toplamı.`
        : `Gösterilen ${tl(dailyAmount)}, varlıkların toplamı ${tl(sum)} (${tl(diff)} fark).`);
  }

  // 5a) Bugün adedi artan varlıklar: yeni adetlerin günlük kazancı alış fiyatından mı?
  if (openingRows) {
    const grown = live.filter((row) => !row.frozen && openingRows[row.code] && row.units > openingRows[row.code].units + 1e-9);
    const unadjusted = grown.filter((row) => !row.dailyBoughtToday && !row.dailyTransactionsApplied);
    if (grown.length) {
      add(unadjusted.length ? 'warn' : 'ok', 'Bugün alınanlar alış fiyatından sayılıyor',
        unadjusted.length
          ? `${unadjusted.map((r) => r.code).join(', ')}: bugün adet arttı ama alış maliyeti bulunamadı; günlük kazanç yeni adetleri dünkü fiyattan sayıyor.`
          : `${grown.map((r) => `${r.code} +${(r.units - openingRows[r.code].units).toLocaleString('tr-TR', { maximumFractionDigits: 6 })} adet`).join(', ')}: günlük kazanç gerçek alış fiyatından hesaplandı.`);
    }
  }

  // 5b) Özet bandındaki toplam kazanç = kartlardaki "Toplam" kazançlar + satışlardan gerçekleşen + temettü
  if (isNum(totalGain) && start) {
    const cards = live.reduce((s, row) => s + (!row.frozen && isNum(row.totalPLTRY) ? row.totalPLTRY : 0), 0);
    const expected = cards + realizedSinceStart + dividendsSinceStart;
    const diff = totalGain - expected;
    const parts = `kartlar ${tl(cards)}${realizedSinceStart ? ` + satışlar ${tl(realizedSinceStart)}` : ''}${dividendsSinceStart ? ` + temettü ${tl(dividendsSinceStart)}` : ''}`;
    add(Math.abs(diff) <= 5 ? 'ok' : Math.abs(diff) <= 50 ? 'warn' : 'error', 'Toplam kazanç kartlarla tutarlı',
      Math.abs(diff) <= 5
        ? `Toplam kazanç ${tl(totalGain)} = ${parts}.`
        : `Özet bandı ${tl(totalGain)}, ${parts} = ${tl(expected)} (${tl(diff)} fark). Başlangıç değeri ya da nakit hesabı kaymış olabilir.`);
  }

  // 6) Midas taramasının yaşı
  const scanAt = Date.parse(snapshot?.stockCapturedAt || snapshot?.capturedAt || '');
  if (Number.isFinite(scanAt)) {
    // Son işlem gününden önceki tarama eskidir: o günden beri alım/satım yapılmış olabilir.
    const scanDate = istanbulDate(new Date(scanAt));
    const prevTradingDay = today ? lastTurkishTradingDay(addDays(today, -1)) : null;
    const old = scanDate && prevTradingDay && scanDate < prevTradingDay;
    add(old ? 'warn' : 'ok', 'Midas taraması güncel',
      old ? `Son Midas taraması ${scanDate}; ${prevTradingDay} ve sonrasındaki alım/satımlar görünmüyor olabilir. PC'de Midas'ı tara.`
        : `Son tarama ${new Date(scanAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}.`);
  }

  // 7) Kayıtlı günlük değerler: bugünkü kayıt, eksik gün, açıklanamayan sıçrama
  const dates = Object.keys(history).filter((d) => isNum(history[d]) && history[d] > 0).sort();
  if (dates.length) {
    const todayRecord = history[dates.at(-1)];
    if (dates.at(-1) === expectedDay && isNum(total) && total > 0) {
      const gap = Math.abs(todayRecord / total - 1);
      add(gap > 0.005 ? 'warn' : 'ok', 'Bugünün kaydı güncel',
        gap > 0.005 ? `Kayıtlı ${tl(todayRecord)}, şu an ${tl(total)}; kayıt birkaç dakika içinde güncellenir.`
          : `${dates.at(-1)} kaydı ${tl(todayRecord)}.`);
    }
    const missing = tradingDaysBetween(dates[0], dates.at(-1)).filter((d) => !(d in history));
    add(missing.length ? 'warn' : 'ok', 'Kayıtlı günlerde boşluk yok',
      missing.length ? `Değeri kaydedilmemiş iş günleri: ${missing.join(', ')} (grafik bu günleri atlar).`
        : `${dates.length} kayıtlı gün, arada eksik iş günü yok.`);
    const jumps = [];
    for (let i = 1; i < dates.length; i += 1) {
      const prev = history[dates[i - 1]];
      const flow = flows.filter((f) => f.date > dates[i - 1] && f.date <= dates[i]).reduce((s, f) => s + (Number(f.amount) || 0), 0);
      const change = (history[dates[i]] - flow) / prev - 1;
      if (Math.abs(change) > 0.02) jumps.push(`${dates[i]} (%${(change * 100).toFixed(1)})`);
    }
    add(jumps.length ? 'warn' : 'ok', 'Günlük değerlerde açıklanamayan sıçrama yok',
      jumps.length ? `Para hareketiyle açıklanamayan %2'den büyük değişim: ${jumps.join(', ')}. Para eklediysen ya da çektiysen İşlemler → Nakit Eklenmesi'ne gir.`
        : 'Günden güne değişimler piyasa hareketiyle uyumlu.');
  }

  // 8) Takip başlangıcı fotoğrafı her varlığı kapsıyor mu?
  if (start) {
    const missingBase = live.filter((row) => !row.frozen && !baseline?.rows?.[row.code]
      && !(row.purchaseDate && row.purchaseDate >= start));
    add(!baseline ? 'warn' : 'ok', 'Takip başlangıcı kaydı',
      !baseline ? `${start} başlangıç değerleri henüz kaydedilmedi.`
        : `${start} itibarıyla ${Object.keys(baseline.rows || {}).length} varlığın başlangıç değeri kayıtlı`
          + `${missingBase.length ? `; sonradan eklenen: ${missingBase.map((r) => r.code).join(', ')} (alış maliyetiyle hesaplanır)` : ''}.`);
  }

  // 9) Onay bekleyen para hareketi / eşleşmeyen satış
  if (pending) add('warn', 'Onay bekleyen para hareketi', `Panelin üstündeki "para eklendi mi?" sorusunu yanıtla (${tl(pending.amount)}).`);
  if (oversold.length) add('warn', 'Alış kaydı eksik satış', `${oversold.join(', ')}: satılan adet kayıtlı alışlardan fazla.`);

  // 10) Nakit payı makul mü (Midas toplamında olup pozisyon listesinde olmayan tutar)
  if (stockAccount && isNum(total) && total > 0 && stockAccount.cash > 0) {
    const share = stockAccount.cash / total;
    add(share > 0.1 ? 'warn' : 'ok', 'Nakit / takastaki para',
      `${tl(stockAccount.cash)} (portföyün %${(share * 100).toFixed(1)}): Midas toplamında olup pozisyon listesinde görünmeyen tutar `
      + '(serbest nakit ya da takastaki para).' + (share > 0.1 ? ' Oran yüksek; Midas taramasını yenile.' : ''));
  }

  lastResult = { at: new Date().toISOString(), checks };
  return lastResult;
}
