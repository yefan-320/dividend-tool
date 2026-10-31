import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLots, lotStats, portfolioStats, dividendsForLot } from '../src/engine/portfolio.js';

const quotes = {
  '600036': { p: 40, n: '招商银行' },
  '000333': { p: 80, n: '美的集团' },
};
const divs = {
  '600036': { years: { 2023: 1.97, 2024: 2.0 } },
  '000333': { years: { 2023: 3.0, 2024: 3.5 } },
};

test('buildLots: FIFO 部分卖出', () => {
  const { lots, realized } = buildLots([
    { date: '2023-01-10', code: '600036', side: 'buy', shares: 1000, price: 30 },
    { date: '2023-05-10', code: '600036', side: 'buy', shares: 500, price: 35 },
    { date: '2024-01-10', code: '600036', side: 'sell', shares: 800, price: 42 },
  ]);
  assert.equal(realized.length, 1);
  // 卖出 800：先进先出，成本 800*30
  assert.ok(Math.abs(realized[0].pnl - 800 * 12) < 1e-6);
  // 剩余：第一笔 200 股 + 第二笔 500 股
  assert.equal(lots.length, 2);
  assert.equal(lots[0].shares, 200);
  assert.equal(lots[1].shares, 500);
});

test('dividendsForLot: 买入晚于除权日不计', () => {
  const lot = { date: '2024-07-10', shares: 100, code: '600036' };
  const d = dividendsForLot(lot, { '600036': { years: { 2023: 1.97, 2024: 2.0 } } }, '2026-10-30');
  // 2023 年度分红在 2024-06-30 实施，买入在 7 月，拿不到；2024 年度在 2025-06-30，能拿到
  assert.deepEqual(d.map((x) => x.year), [2024]);
});

test('lotStats: 一年持有，价格+分红', () => {
  const lot = { code: '600036', date: '2024-07-01', shares: 1000, price: 30, cost: 30000 };
  const s = lotStats(lot, quotes, { '600036': { years: { 2024: 2.0 } } }, '2026-10-30');
  // 2024 年度分红 2025-06-30 实施，2000 元
  assert.ok(Math.abs(s.divCash - 2000) < 1e-6);
  // 市值 40000，总收益 12000
  assert.ok(Math.abs(s.pnl - 12000) < 1e-6);
  assert.ok(Math.abs(s.ret - 0.4) < 1e-6);
  assert.ok(s.annualized > 0.1);
  assert.ok(s.xirr > 0.1);
});

test('portfolioStats: 两笔不同时间买入', () => {
  const txs = [
    { date: '2024-01-10', code: '600036', side: 'buy', shares: 1000, price: 30 },
    { date: '2025-01-10', code: '000333', side: 'buy', shares: 500, price: 70 },
  ];
  const r = portfolioStats(txs, quotes, divs, '2026-10-30');
  assert.equal(r.lots.length, 2);
  assert.equal(r.totalCost, 30000 + 35000);
  assert.ok(r.totalValue > 0);
  assert.ok(r.xirr > 0);
  assert.equal(r.byYear.length, 2);
});

test('portfolioStats: 空组合', () => {
  const r = portfolioStats([], {}, {}, '2026-10-30');
  assert.equal(r.totalCost, 0);
  assert.equal(r.xirr, null);
  assert.equal(r.totalRet, null);
});
