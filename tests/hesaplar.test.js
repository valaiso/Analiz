// Bu oturumda bulunan hataların tekrar etmemesi için senaryolar ve temel hesaplar.
import { seedStorage, near } from './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// Midas işlemleri site yüklenmeden önce tarayıcı deposuna konur (aynı gün alış ve satış).
seedStorage('tefas-midas-import-v1', [
  { id: 'm2', source: 'midas', date: '2026-08-21', time: '14:20:05', code: 'BTCX', type: 'SAT', units: 0.00083, price: 75821 },
  { id: 'm1', source: 'midas', date: '2026-08-21', time: '9:58:26', code: 'BTCX', type: 'AL', units: 0.000835, price: 74530 },
  { id: 'm4', source: 'midas', date: '2026-08-22', code: 'ABC', type: 'SAT', units: 5, price: 2 },
  { id: 'm3', source: 'midas', date: '2026-08-22', code: 'ABC', type: 'AL', units: 5, price: 1 },
]);

const store = await import('../assets/js/store.js');
const { buildPositions, riskSummary } = await import('../assets/js/portfolio.js');
const { realReturn, cashflowCalendar, estimatedInflation } = await import('../assets/js/insights.js');
const { cashflowThreshold, unexplainedChange, applyDailyMarketTransactions, weeklyMarketGain } = await import('../assets/js/asset-groups.js');
const { runDataChecks } = await import('../assets/js/verify.js');

test('Aynı gün işlemleri saate göre sayı olarak sıralanır (9:58 alış, 14:20 satıştan önce)', () => {
  const day = store.transactions().filter((tx) => tx.code === 'BTCX');
  assert.deepEqual(day.map((tx) => tx.type), ['AL', 'SAT']);
});

test('Saati olmayan aynı gün işlemlerinde alış satıştan önce sayılır', () => {
  const day = store.transactions().filter((tx) => tx.code === 'ABC');
  assert.deepEqual(day.map((tx) => tx.type), ['AL', 'SAT']);
});

test('Doğru sıralamayla sahte "alıştan fazla satış" uyarısı çıkmaz', () => {
  const positions = buildPositions(store.transactions().filter((tx) => tx.code === 'BTCX'));
  assert.equal(positions.get('BTCX').oversold, false);
});

test('Para girişi eşiği: haftalık piyasa kazancının %50\'si, en az oynayan kısmın binde 1\'i', () => {
  const base = { total: 525000, frozenValue: 441000 };           // oynayan kısım 84.000
  near(assert, cashflowThreshold(base, 550), 275);               // normal hafta
  near(assert, cashflowThreshold(base, 40), 84);                 // durgun hafta: taban
  near(assert, cashflowThreshold(base, -300), 150);              // eksi hafta: büyüklüğü
  near(assert, cashflowThreshold(base, null), 84);               // geçmiş yok: taban
  near(assert, cashflowThreshold({ total: 1000000, frozenValue: 0 }, 100), 1000); // 1 milyonda taban 1.000
});

test('Taban portföyle büyür: 1,5 milyonda 1.500 TL, 2 milyonda 2.000 TL', () => {
  near(assert, cashflowThreshold({ total: 1500000, frozenValue: 0 }, 100), 1500);
  near(assert, cashflowThreshold({ total: 2000000, frozenValue: 0 }, 100), 2000);
  // Haftalık kazanç büyükse eşik onun yarısıdır: 2 milyonda 10.000 TL kazanç → 5.000 TL eşik.
  near(assert, cashflowThreshold({ total: 2000000, frozenValue: 0 }, 10000), 5000);
  // Tasfiyedeki (fiyatı donmuş) fonlar tabana girmez: 2 milyonun 440 bini donmuşsa taban 1.560 TL.
  near(assert, cashflowThreshold({ total: 2000000, frozenValue: 440000 }, 100), 1560);
});

test('Haftalık piyasa kazancı para hareketlerini çıkarır ve sorgulanan günü saymaz', () => {
  const history = { '2026-11-02': 100000, '2026-11-06': 100300, '2026-11-09': 102700, '2026-11-10': 104000 };
  const flows = [{ date: '2026-11-09', amount: 2000 }];
  // 10 Kasım taraması sorgulanıyor: hafta 2 → 9 Kasım; 102.700 − 100.000 − 2.000 = 700
  near(assert, weeklyMarketGain(history, flows, '2026-11-10'), 700);
  assert.equal(weeklyMarketGain({ '2026-11-03': 1 }, [], null), null);
});

test('2.000 TL\'lik para yatırma artık yakalanır (eskiden 5.250 TL altı kâr sayılıyordu)', () => {
  const previous = { total: 525000, frozenValue: 440000, units: { ZBJ: 10000 }, unitTRY: { ZBJ: 5 } };
  const current = { total: 527000, frozenValue: 440000, units: { ZBJ: 10000 }, unitTRY: { ZBJ: 5 } };
  const change = unexplainedChange(previous, current);
  near(assert, change.amount, 2000);
  assert.equal(change.significant, true);
  // Haftalık kazanç 1.000 TL olsa bile (eşik 500) 2.000 TL yakalanır.
  assert.ok(Math.abs(change.amount) >= cashflowThreshold(previous, 1000));
});

test('Fiyat hareketi para girişi sanılmaz', () => {
  const previous = { total: 100000, frozenValue: 0, units: { ZBJ: 10000 }, unitTRY: { ZBJ: 5 } };
  const current = { total: 100500, frozenValue: 0, units: { ZBJ: 10000 }, unitTRY: { ZBJ: 5.05 } };
  const change = unexplainedChange(previous, current);
  near(assert, change.amount, 0);
  assert.equal(change.significant, false);
});

test('Bugün alınan adetlerin günlük kazancı alış maliyetinden hesaplanır', () => {
  // Dün 11.059 adet (Midas maliyeti 60.935,09); bugün 1.798 adet 10.035,55 TL'ye alındı.
  const row = {
    code: 'ZBJ', units: 12857, price: 5.578, currency: 'TRY',
    dailyUnitPriceNowTRY: 5.578, dailyUnitPricePrevTRY: 5.572391,
    marketValueTRY: 12857 * 5.578, purchasePLTRY: 12857 * 5.578 - (60935.09 + 10035.55),
  };
  const result = applyDailyMarketTransactions([row], [], '2026-11-04', {
    openingRows: { ZBJ: { units: 11059, midasCost: 60935.09 } },
  });
  const expected = 11059 * (5.578 - 5.572391) + (1798 * 5.578 - 10035.55);
  near(assert, result.rows[0].dailyPLTRY, expected, 1e-4);
  near(assert, result.total, expected, 1e-4);
});

test('Gerçek getiri: ilk günün para girişi getiriyi bozmaz, sonraki giriş kâr sayılmaz', () => {
  const history = { '2026-11-03': 100000, '2026-11-04': 101000, '2026-11-05': 103020 };
  const flows = [{ date: '2026-11-03', amount: 5000 }, { date: '2026-11-05', amount: 1000 }];
  const real = realReturn(history, flows);
  near(assert, real.profit, 103020 - 100000 - 1000);
  near(assert, real.twr, ((101000 / 100000) * ((103020 - 1000) / 101000) - 1) * 100, 1e-9);
});

test('Takip başlangıcından önceki satışlar gerçekleşen kâra ve aylık akışa girmez', () => {
  const txs = [
    { date: '2026-10-01', code: 'X', type: 'AL', units: 10, price: 1 },
    { date: '2026-10-15', code: 'X', type: 'SAT', units: 5, price: 2 },
    { date: '2026-11-10', code: 'X', type: 'SAT', units: 5, price: 3 },
  ];
  const result = cashflowCalendar(txs, '2026-11-03');
  assert.equal(result.realizedSales.length, 1);
  near(assert, result.realizedSales[0].amount, 5 * 3 - 5 * 1);
  assert.deepEqual(result.monthly.map((m) => m.month), ['2026-11']);
});

test('Sharpe ve oynaklık hata payı (Lo 2002) veri arttıkça daralır', () => {
  const series = (n) => Array.from({ length: n }, (_, i) => 100 * (1.0005 ** i) * (1 + (i % 2 ? 0.002 : -0.002)));
  const dates = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  const short = riskSummary(series(120), dates(120), 0);
  const long = riskSummary(series(400), dates(400), 0);
  assert.ok(Number.isFinite(short.sharpeMargin) && Number.isFinite(long.sharpeMargin));
  assert.ok(short.sharpeMargin > long.sharpeMargin);
  near(assert, short.sharpeMargin, 1.96 * Math.sqrt((252 + short.sharpe ** 2 / 2) / short.observations), 1e-9);
  near(assert, short.volMargin, 1.96 * short.vol / Math.sqrt(2 * short.observations), 1e-9);
});

test('Veri kontrolü: özet bandı kartların toplamından saparsa hata verir', () => {
  const rows = [{ code: 'ZBJ', units: 1, totalPLTRY: 64.56 }, { code: 'SCHD', units: 1, totalPLTRY: 46.91 }];
  const base = { rows, history: {}, start: '2026-11-03' };
  const ok = runDataChecks({ ...base, totalGain: 111.48 }).checks.find((c) => c.title === 'Toplam kazanç kartlarla tutarlı');
  const bad = runDataChecks({ ...base, totalGain: 126.74 - 95.32 + 95.32 + 95 }).checks.find((c) => c.title === 'Toplam kazanç kartlarla tutarlı');
  assert.equal(ok.status, 'ok');
  assert.equal(bad.status, 'error');
});

test('Veri kontrolü: fonlar farklı fiyat günlerindeyse uyarır', () => {
  const rows = [
    { code: 'ZBJ', units: 1, currency: 'TRY', quoteDate: '2026-11-04' },
    { code: 'AIS', units: 1, currency: 'TRY', quoteDate: '2026-11-03' },
  ];
  const check = runDataChecks({ rows }).checks.find((c) => c.title === 'Fonlar aynı fiyat gününde');
  assert.equal(check.status, 'warn');
});

test('Tahmini enflasyon: son açıklanan aylık TÜFE geçen güne göre bölünür', () => {
  // Eylül 4.368,20 → Ekim 4.480,88 (%2,58); 2 günlük tahmin ≈ %0,168
  const values = [4289.26, 4289.26, 4368.201771, 4368.201771, 4480.884378, 4480.884378];
  const est = estimatedInflation(values, 2);
  near(assert, est.monthly, (4480.884378 / 4368.201771 - 1) * 100, 1e-9);
  near(assert, est.estimate, ((4480.884378 / 4368.201771) ** (2 / 30.44) - 1) * 100, 1e-9);
  near(assert, estimatedInflation(values, 30.44).estimate, est.monthly, 1e-9);   // tam bir ay = aylık oran
  assert.equal(estimatedInflation([100, 100], 5), null);                          // tek değer: tahmin yok
});

test('Satış sonrası: gerçekleşen kâr ve kart kârı başlangıç değerinden ölçülür, toplamı değer artışına eşit', () => {
  // 3 Kasım öncesi 1.000 adet ortalama 5,51'den alınmış; 3 Kasım değeri 5,572.
  const txs = [
    { date: '2026-10-01', code: 'ZB', type: 'AL', units: 500, price: 5.50 },
    { date: '2026-10-20', code: 'ZB', type: 'AL', units: 500, price: 5.52 },
    { date: '2026-11-06', code: 'ZB', type: 'SAT', units: 400, price: 5.62 },
    { date: '2026-11-09', code: 'ZB', type: 'AL', units: 200, price: 5.60 },
  ];
  const calc = cashflowCalendar(txs, '2026-11-03', { ZB: { unitTRY: 5.572 } });
  // Satış kârı 3 Kasım değerinden: 400 × (5,62 − 5,572) = 19,2 (ortalama maliyetle 44 olurdu)
  near(assert, calc.realizedSales[0].amount, 400 * (5.62 - 5.572), 1e-9);
  // Kalan 800 adedin başlangıçtan beri maliyeti: 600 × 5,572 + 200 × 5,60
  near(assert, calc.sinceStart.ZB.units, 800);
  near(assert, calc.sinceStart.ZB.cost, 600 * 5.572 + 200 * 5.60, 1e-9);
  // Bugün fiyat 5,65 → kart kârı + gerçekleşen = 3 Kasım'dan beri değer artışı (nakit dahil)
  const price = 5.65;
  const cardGain = 800 * price - calc.sinceStart.ZB.cost;
  const valueChange = (800 * price + 400 * 5.62 - 200 * 5.60) - 1000 * 5.572;
  near(assert, cardGain + calc.realizedSales[0].amount, valueChange, 1e-9);
});

test('Sunucu değerleri yalnızca eksik günleri doldurur; cihaz kaydının ve bugünün üzerine yazmaz', () => {
  store.setSetting('trackingStart', '2026-11-03');
  store.setPortfolioValue('2026-11-10', 525550.11);
  const added = store.fillValueGaps([
    { date: '2026-11-10', value: 1 },          // cihaz kaydı var: değişmez
    { date: '2026-11-11', value: 525700.5 },   // eksik gün: doldurulur
    { date: '2026-11-12', value: 2 },          // bugün: cihaz kaydeder, doldurulmaz
    { date: '2026-11-01', value: 3 },          // takip başlangıcından önce: alınmaz
  ], '2026-11-12');
  assert.equal(added, 1);
  const history = store.valueHistory();
  assert.equal(history['2026-11-10'], 525550.11);
  assert.equal(history['2026-11-11'], 525700.5);
  assert.equal(history['2026-11-12'], undefined);
  assert.equal(history['2026-11-01'], undefined);
});
