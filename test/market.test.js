import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, priceAt, monthEnd, buildTradingDates, prevDps, qualityOf, dyQuality, maxDrawdown, xirr } from '../src/engine/market.js';

test('monthEnd 取当月最后一天', () => {
  assert.equal(monthEnd('2024-02'), '2024-02-29');
  assert.equal(monthEnd('2023-02'), '2023-02-28');
  assert.equal(monthEnd('2026-10'), '2026-10-31');
});

test('buildSeries：月线在前、日 K 在后，日 K 覆盖的月份不再用月线', () => {
  const s = buildSeries({
    cal: ['2020-01-02', '2020-01-03', '2020-01-06'],
    daily: { c: [10, 11, null] },
    monthly: [['2019-11', 8], ['2019-12', 9], ['2021-01', 12]],
  });
  assert.deepEqual(s.dates, ['2019-11-30', '2019-12-31', '2020-01-02', '2020-01-03']);
  assert.equal(priceAt(s, '2020-01-02'), 10);
  assert.equal(priceAt(s, '2020-01-06'), 11); // 停牌取最近价
  assert.equal(priceAt(s, '2019-12-30'), 8); // 取不晚于该日的最近点
  assert.equal(priceAt(s, '2019-01-01'), null); // 早于序列
});

test('buildTradingDates：指数日线 + 日 K 日历并集，按区间过滤', () => {
  const dates = buildTradingDates({
    indexRows: [['2020-01-02', 1], ['2020-01-03', 1], ['2020-01-06', 1]],
    dailyCal: ['2020-01-02', '2020-01-07'],
    monthly: {},
    from: '2020-01-02',
    to: '2020-01-07',
  });
  assert.deepEqual(dates, ['2020-01-02', '2020-01-03', '2020-01-06', '2020-01-07']);
});

test('prevDps / qualityOf / dyQuality', () => {
  const divs = { A: { years: { 2019: 1, 2020: 1.2 } } };
  assert.equal(prevDps(divs, 'A', 2020), 1);
  assert.equal(prevDps(divs, 'A', 2021), 1.2);
  assert.equal(prevDps(divs, 'B', 2020), 0);
  const fin = { A: [[2019, 2, 12, 20, 50, 2.5]] };
  assert.equal(qualityOf(fin, 'A', 2019).ok, true);
  assert.equal(qualityOf(fin, 'A', 2020).ok, false);
  assert.equal(qualityOf({ A: [[2019, 2, 12, 20, 50, 0.5]] }, 'A', 2019).ok, false);
  const dq = dyQuality({ dividends: divs, finHistory: fin, code: 'A', year: 2020, price: 10 });
  assert.equal(dq.dy, 10);
  assert.equal(dq.payout, 50);
  assert.equal(dq.cover, 1.25);
});

test('maxDrawdown / xirr', () => {
  const md = maxDrawdown([['2020-01-02', 100], ['2020-03-02', 80], ['2020-06-02', 120], ['2020-09-02', 90]]);
  assert.equal(Math.round(md.mdd * 1000) / 1000, -0.25);
  assert.equal(md.mddPeak, '2020-06-02');
  assert.equal(md.mddTrough, '2020-09-02');
  const irr = xirr([['2020-01-01', -100], ['2021-01-01', 110]]);
  assert.ok(Math.abs(irr - 0.1) < 0.005);
});
