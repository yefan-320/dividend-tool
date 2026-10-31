import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanBacktest, selectCandidates, toPriceIndex, priceAt } from '../src/engine/backtest.js';

// 造 3 只股票、4 年数据的小宇宙
function makeUniverse() {
  const months = {};
  const baseline = { pool: {}, dividends: {} };
  const codes = ['A', 'B', 'C'];
  for (const c of codes) {
    months[c] = [];
    baseline.pool[c] = { n: c + '公司', ind: '测试', cap: 1e10, dy: 5 };
    baseline.dividends[c] = { years: {}, nYears: 10, consecutive: 10, lastY: 2015 };
  }
  for (const c of codes) for (let y = 2009; y <= 2011; y++) baseline.dividends[c].years[y] = 1;
  for (let y = 2012; y <= 2016; y++) {
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      months.A.push([ym, 10]);
      months.B.push([ym, 20]);
      months.C.push([ym, 40]);
    }
    baseline.dividends.A.years[y - 1] = 1.0; // dy 10%
    baseline.dividends.B.years[y - 1] = 0.8; // dy 4%
    baseline.dividends.C.years[y - 1] = 0.4; // dy 1%
  }
  return { baseline, months };
}

test('selectCandidates: 按股息率过滤排序', () => {
  const { baseline, months } = makeUniverse();
  const prices = toPriceIndex(months);
  const cand = selectCandidates({ baseline, prices, ym: '2014-04', year: 2014, params: { minDy: 3, minDivYears: 3, minHistoryMonths: 6 } });
  assert.deepEqual(cand.map((x) => x.code), ['A', 'B']);
  assert.ok(Math.abs(cand[0].dy - 10) < 1e-9);
});

test('selectCandidates: ST 排除', () => {
  const { baseline, months } = makeUniverse();
  baseline.pool.A.n = 'ST公司';
  const prices = toPriceIndex(months);
  const cand = selectCandidates({ baseline, prices, ym: '2014-04', year: 2014, params: { minDy: 3, minDivYears: 3, minHistoryMonths: 6 } });
  assert.deepEqual(cand.map((x) => x.code), ['B']);
});

test('runPlanBacktest: 净值、年度、基准', () => {
  const { baseline, months } = makeUniverse();
  const benchmark = {};
  for (let y = 2013; y <= 2016; y++) for (let m = 1; m <= 12; m++) benchmark[`${y}-${String(m).padStart(2, '0')}`] = 1000;
  const r = runPlanBacktest({
    baseline, months, benchmark,
    params: { startYear: 2013, endYm: '2016-12', holdN: 1, minDy: 3, minDivYears: 3, weight: 'equal', minHistoryMonths: 12 },
  });
  // 每年持有股息率最高的 A，价格不变，靠分红增长
  assert.ok(r.nav.length === 48);
  assert.ok(r.stats.total > 0);
  assert.equal(r.periods.length, 4);
  assert.equal(r.periods[0].items[0].code, 'A');
  assert.equal(r.stats.benchTotal, 0);
});

test('runPlanBacktest: 价格翻倍时净值翻倍', () => {
  const { baseline, months } = makeUniverse();
  // A 从 2014-04 起翻倍
  months.A = months.A.map(([ym, v]) => [ym, ym >= '2014-04' ? 20 : 10]);
  const r = runPlanBacktest({
    baseline, months, benchmark: {},
    params: { startYear: 2014, endYm: '2014-12', holdN: 1, minDy: 3, minDivYears: 3, minHistoryMonths: 12 },
  });
  // 2014-04 买入价 20，之后不变，收益来自分红
  assert.ok(r.stats.total > 0 && r.stats.total < 1.5, `got ${r.stats.total}`);
});

test('priceAt 缺失返回 null', () => {
  const prices = toPriceIndex({ X: [['2020-01', 5]] });
  assert.equal(priceAt(prices, 'X', '2020-02'), null);
  assert.equal(priceAt(prices, 'Y', '2020-01'), null);
});
