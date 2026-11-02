import test from 'node:test';
import { withEv } from './div-helper.js';
import assert from 'node:assert/strict';
import { runStockBacktest } from '../src/engine/stockBacktest.js';

const dates = ['2020-01-02', '2020-04-30', '2020-12-31', '2021-04-30', '2021-12-31'];
const series = { dates, closes: [10, 10, 10, 10, 10] };
// 分红只认 ev（真实除权除息日）：years 只服务股息率判断，不再折算成「4 月末到账」
const dividends = { A: { years: { 2019: 1, 2020: 1 }, ev: [['2020-12-31', 1], ['2021-12-31', 1]] } };
const fin = { A: [[2019, 2, 12, 20, 50, 2.5], [2020, 2, 12, 20, 50, 2.5]] };

test('个股回测：股息率 ≥ 5% 且质量过关 → 4 月末买入', () => {
  const r = runStockBacktest({
    code: 'A', dates, series, dividends, finHistory: fin,
    capital: 1000000, monthlyAdd: 0, minDy: 5,
    from: dates[0], to: dates.at(-1),
  });
  assert.equal(r.trades.filter((t) => t.type === '买入').length, 1);
  assert.equal(r.trades[0].date, '2020-04-30');
  assert.ok(r.end > 1000000);
  assert.ok(r.totalDiv > 0);
  assert.equal(r.stats.sells, 0);
  assert.ok(r.navHold.at(-1)[1] > 1000000);
});

test('个股回测：质量否决 → 卖出', () => {
  const badFin = { A: [[2019, 2, 12, 20, 50, 2.5], [2020, -1, -5, -2, 80, -2]] };
  const r = runStockBacktest({
    code: 'A', dates, series, dividends, finHistory: badFin,
    capital: 1000000, monthlyAdd: 0, minDy: 5,
    from: dates[0], to: dates.at(-1),
  });
  assert.equal(r.stats.sells, 1);
  assert.equal(r.trades.filter((t) => t.type === '卖出')[0].date, '2021-04-30');
  assert.ok(r.end > 1000000, '卖出后现金吃利息');
});

test('个股回测：股息率不足不买', () => {
  const r = runStockBacktest({
    code: 'A', dates, series: { dates, closes: [100, 100, 100, 100, 100] }, dividends, finHistory: fin,
    capital: 1000000, monthlyAdd: 0, minDy: 5,
    from: dates[0], to: dates.at(-1),
  });
  assert.equal(r.trades.filter((t) => t.type === '买入').length, 0);
  assert.ok(r.end > 1000000 && r.end < 1080000, '只有现金利息');
});
