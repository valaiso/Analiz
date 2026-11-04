/* Vergi hesapları: fon stopajı tahmini.

   Bu dosya tarayıcıya bağlı değildir (yalnızca girdi alır, sonuç döndürür); bu yüzden
   tests/ altındaki otomatik testlerle doğrulanır.

   Yöntem: GVK geçici 67. madde stopaj matrahında alış bedelini "ilk giren ilk çıkar"
   (FIFO) yöntemiyle belirler; aracı kurum da satışta böyle hesaplar. Site eskiden ağırlıklı
   ortalama maliyet kullanıyordu; farklı fiyatlardan alınan fonlarda tahmin sapıyordu. */

const EPS = 1e-9;
const num = (value) => Number(value) || 0;

/**
 * İşlemlerden bir varlığın elde kalan alış partilerini FIFO ile çıkarır.
 * @param {Array} txs  tarih sırasındaki işlemler ({ date, code, type: 'AL'|'SAT', units, price, fee })
 * @param {string} code
 * @param {(tx) => number} fxFor  işlemin TL'ye çevrim kuru (TL varlıkta 1, dolar varlıkta o günün kuru)
 * @returns {{ lots: {date, units, unitCost}[], sold: {date, units, proceeds, cost, lots}[], oversold: boolean }}
 */
export function fifoLots(txs, code, fxFor = () => 1) {
  const lots = [];
  const sold = [];
  let oversold = false;
  for (const tx of txs || []) {
    if (tx.code !== code || !(num(tx.units) > 0) || !(num(tx.price) > 0)) continue;
    const fx = num(fxFor(tx)) || 1;
    if (tx.type === 'SAT') {
      let remaining = num(tx.units);
      let cost = 0;
      const used = [];
      while (remaining > EPS && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.units, remaining);
        cost += take * lot.unitCost;
        used.push({ date: lot.date, units: take, unitCost: lot.unitCost });
        lot.units -= take;
        remaining -= take;
        if (lot.units <= EPS) lots.shift();
      }
      if (remaining > EPS) oversold = true;
      const matched = num(tx.units) - Math.max(0, remaining);
      sold.push({
        date: tx.date, units: matched,
        proceeds: (matched * num(tx.price) - num(tx.fee)) * fx,
        cost, lots: used,
      });
    } else {
      // Alış komisyonu maliyete eklenir.
      const fee = num(tx.fee) / num(tx.units);
      lots.push({ date: tx.date, units: num(tx.units), unitCost: (num(tx.price) + fee) * fx });
    }
  }
  return { lots, sold, oversold };
}

/**
 * Bugün satılsa kesilecek tahmini fon stopajı (FIFO partilerle).
 * Her parti kendi alış tarihine göre oranlanır (ör. 1 yıl kuralı); aynı orandaki partilerin
 * kâr ve zararı satışta birbirini götürür, net zarar vergiye konu olmaz.
 * @param {{date, units, unitCost}[]} lots
 * @param {number} priceTRY  güncel birim fiyat
 * @param {(lotDate) => {rate, reason}} rateFor
 */
export function fifoStopaj(lots, priceTRY, rateFor) {
  const byRate = new Map();
  let profit = 0;
  for (const lot of lots || []) {
    const gain = lot.units * (priceTRY - lot.unitCost);
    profit += gain;
    const { rate, reason } = rateFor(lot.date);
    const group = byRate.get(rate) || { rate, reason, gain: 0 };
    group.gain += gain;
    byRate.set(rate, group);
  }
  let amount = 0;
  for (const group of byRate.values()) amount += Math.max(0, group.gain) * group.rate;
  const groups = [...byRate.values()];
  const main = groups.sort((a, b) => b.gain - a.gain)[0];
  return { profit, amount, rate: profit > 0 ? amount / profit : main?.rate ?? 0, reason: main?.reason || '', groups };
}

/** FIFO partilerinin toplam adedi Midas'taki adetle uyuşuyor mu? (eksik işlem geçmişi kontrolü) */
export function lotsMatchUnits(lots, units) {
  const total = (lots || []).reduce((sum, lot) => sum + lot.units, 0);
  return Math.abs(total - num(units)) <= Math.max(1e-6, Math.abs(num(units)) * 1e-6);
}

