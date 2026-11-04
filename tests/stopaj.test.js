// Fon stopajı tahmini: "ilk giren ilk çıkar" (FIFO) partileri.
import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { near } from './setup.js';
import { fifoLots, fifoStopaj, lotsMatchUnits } from '../assets/js/tax.js';

test('FIFO: satış önce en eski partiden düşülür', () => {
  const txs = [
    { date: '2026-01-02', code: 'ZBJ', type: 'AL', units: 10, price: 1 },
    { date: '2026-02-02', code: 'ZBJ', type: 'AL', units: 10, price: 2 },
    { date: '2026-03-02', code: 'ZBJ', type: 'SAT', units: 15, price: 3 },
  ];
  const { lots, sold, oversold } = fifoLots(txs, 'ZBJ');
  assert.equal(oversold, false);
  assert.equal(lots.length, 1);
  near(assert, lots[0].units, 5);
  near(assert, lots[0].unitCost, 2);
  near(assert, sold[0].cost, 10 * 1 + 5 * 2);
  near(assert, sold[0].proceeds, 45);
});

test('FIFO, ortalama maliyetten farklı sonuç verir (eski ucuz parti önce satılır)', () => {
  const txs = [
    { date: '2026-01-02', code: 'F', type: 'AL', units: 100, price: 1 },
    { date: '2026-02-02', code: 'F', type: 'AL', units: 100, price: 2 },
    { date: '2026-03-02', code: 'F', type: 'SAT', units: 100, price: 2 },
  ];
  const { lots } = fifoLots(txs, 'F');
  // Kalan parti 2'den alınanlar: bugün 2,5'tan satılsa kâr 50 (ortalama maliyetle 100 olurdu).
  const result = fifoStopaj(lots, 2.5, () => ({ rate: 0.175, reason: '%17,5' }));
  near(assert, result.profit, 50);
  near(assert, result.amount, 50 * 0.175);
});

test('Stopaj: aynı orandaki partilerin kâr ve zararı birbirini götürür, net zarar vergilenmez', () => {
  const lots = [
    { date: '2026-01-01', units: 10, unitCost: 1 },
    { date: '2026-02-01', units: 10, unitCost: 3.5 },
  ];
  const result = fifoStopaj(lots, 2, () => ({ rate: 0.175, reason: '' }));
  near(assert, result.profit, -5);
  near(assert, result.amount, 0);
});

test('Stopaj: farklı oranlı partiler ayrı hesaplanır (1 yıl kuralı)', () => {
  const lots = [
    { date: '2024-01-01', units: 10, unitCost: 1 },
    { date: '2026-06-01', units: 10, unitCost: 1 },
  ];
  const rateFor = (date) => (date < '2025-11-01' ? { rate: 0, reason: '%0' } : { rate: 0.175, reason: '%17,5' });
  const result = fifoStopaj(lots, 2, rateFor);
  near(assert, result.profit, 20);
  near(assert, result.amount, 10 * 0.175);
});

test('Alış komisyonu partinin maliyetine eklenir', () => {
  const { lots } = fifoLots([{ date: '2026-01-02', code: 'A', type: 'AL', units: 10, price: 1, fee: 1 }], 'A');
  near(assert, lots[0].unitCost, 1.1);
});

test('Parti adedi Midas adediyle karşılaştırılır (eksik işlem geçmişi yakalanır)', () => {
  assert.equal(lotsMatchUnits([{ units: 5 }, { units: 7 }], 12), true);
  assert.equal(lotsMatchUnits([{ units: 5 }], 12), false);
});
