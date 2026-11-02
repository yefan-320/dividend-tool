import test from 'node:test';
import { withEv } from './div-helper.js';
import assert from 'node:assert/strict';
import { runPortfolioBacktest } from '../src/engine/portfolioBacktest.js';

const dates = ['2020-01-02', '2020-04-30', '2020-12-31', '2021-04-30', '2021-12-31'];

function mkSeries(map) {
  // 每只股票都有一根「回测起点之前」的日线，表示它起点前已上市（否则会触发“未上市建仓”规则）
  const m = new Map();
  for (const [code, closes] of Object.entries(map)) m.set(code, { dates: ['2019-06-03', ...dates], closes: [closes[0], ...closes] });
  return m;
}

const dividends = withEv({ A: { years: { 2019: 1, 2020: 1 } }, B: { years: { 2019: 2 } } });

test('投入回测：起点净值 = 本金，分红复投进净值，不复投口径更少', () => {
  const series = mkSeries({ A: [10, 10, 10, 10, 10], B: [20, 20, 20, 20, 20] });
  const r = runPortfolioBacktest({
    dates, series, dividends,
    holdings: [{ code: 'A', weight: 50 }, { code: 'B', weight: 50 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
  });
  assert.equal(Math.round(r.nav[0][1]), 1000000);
  assert.equal(r.divByY['2020'], 100000); // A 50000×1 + B 25000×2
  assert.ok(r.end > r.nav[0][1]);
  assert.ok(r.endR < r.end, '不复投应少于复投');
  assert.equal(r.totalIn, 1000000);
  assert.ok(r.stats.cagr > 0);
  assert.ok(r.events.some((e) => e.type === '分红'));
  assert.equal(r.yearly.length, 2);
  assert.equal(r.comp.length, dates.length);
});

test('投入回测：月追加进现金流、XIRR 年化', () => {
  const series = mkSeries({ A: [10, 10, 10, 10, 10] });
  const r = runPortfolioBacktest({
    dates, series, dividends: {},
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 10000, from: dates[0], to: dates.at(-1), mode: 'invest',
  });
  assert.equal(r.totalIn, 1000000 + 10000 * 6 * 4); // 2020-04、2020-12、2021-04、2021-12 四个追加日
  assert.ok(r.stats.cagr != null);
  assert.ok(r.nav.at(-1)[1] > r.totalIn * 0.99);
});

test('持仓回放：按当前股数 + 现金，分红复投', () => {
  const series = mkSeries({ A: [10, 10, 10, 10, 10] });
  const r = runPortfolioBacktest({
    dates, series, dividends,
    holdings: [{ code: 'A', weight: 100 }],
    capital: 0, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'replay',
    lots: [{ code: 'A', shares: 10000 }], cash0: 100000,
  });
  assert.equal(r.nav[0][1], 100000 + 10000 * 10);
  assert.ok(r.end > r.nav[0][1]);
  assert.ok(r.stats.ret > 0);
});

test('基准同口径：同样本金买指数', () => {
  const series = mkSeries({ A: [10, 10, 10, 10, 10] });
  const r = runPortfolioBacktest({
    dates, series, dividends: {},
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    benchmarkSeries: [['2020-01-02', 1000], ['2020-04-30', 1100], ['2020-12-31', 1200], ['2021-04-30', 1150], ['2021-12-31', 1300]],
  });
  assert.ok(r.bench);
  assert.equal(r.bench.end, 1300000);
  assert.ok(Math.abs(r.bench.cagr - (Math.pow(1.3, 365 / 730) - 1)) < 0.01);
});


/* ---------------- 未上市股票：份额摊给已上市，上市满 6 个月按组合增长建仓 ---------------- */

const cal = ['2020-01-02', '2020-06-30', '2020-12-31', '2021-07-05', '2021-12-31', '2022-06-30'];

function unlistedSeries({ aPriceAtBuild = 11 } = {}) {
  const A = { dates: ['2019-06-03', '2020-01-02', '2020-06-30', '2020-12-31', '2021-07-05', '2021-12-31', '2022-06-30'], closes: [10, 10, 10, aPriceAtBuild, aPriceAtBuild, aPriceAtBuild, aPriceAtBuild] };
  const B = { dates: ['2019-06-03', ...cal], closes: [20, 20, 20, 20, 20, 20, 20] };
  const C = { dates: ['2021-01-04', '2021-07-05', '2021-12-31', '2022-06-30'], closes: [20, 20, 21, 21] };
  return new Map([['A', A], ['B', B], ['C', C]]);
}

test('未上市：起点把 C 的 20% 平均摊给 A/B（各 50%），2021-07-05 建仓', () => {
  const r = runPortfolioBacktest({
    dates: cal, series: unlistedSeries(), dividends: {},
    holdings: [{ code: 'A', weight: 40 }, { code: 'B', weight: 40 }, { code: 'C', weight: 20 }],
    capital: 1000000, monthlyAdd: 0, from: cal[0], to: cal.at(-1), mode: 'invest',
  });
  assert.equal(Math.round(r.nav[0][1]), 1000000);
  // 起点：A 50 万、B 50 万，C 还没上市
  assert.equal(r.events.filter((e) => e.type === '买入').slice(0, 2).map((e) => e.code).sort().join(','), 'A,B');
  const first = r.comp[0][1];
  assert.equal(Math.round(first.A / (first.A + first.B) * 100), 50);
  // 建仓事件
  assert.equal(r.builds.length, 1);
  assert.equal(r.builds[0].code, 'C');
  assert.equal(r.builds[0].date, '2021-07-05');
  // 目标 20% × 105 万 / 20 = 10,500 股；卖出按整手取整后现金 20.98 万 → 实际 10,400 股
  assert.equal(r.builds[0].shares, 10400);
  assert.ok(r.events.some((e) => e.type === '买入' && e.code === 'C' && e.why.includes('上市满')));
  assert.ok(r.events.some((e) => e.type === '卖出' && e.code === 'A'));
  // 建仓后权重回到 40/40/20
  const row = r.comp[3][1];
  const total = row.A + row.B + row.C + row.cash;
  assert.ok(Math.abs(row.A / total - 0.4) < 0.01);
  assert.ok(Math.abs(row.B / total - 0.4) < 0.01);
  assert.ok(Math.abs(row.C / total - 0.2) < 0.01);
});

test('未上市：区间下跌时买入金额跟着缩水（20 万 × 组合净值 0.9）', () => {
  const r = runPortfolioBacktest({
    dates: cal, series: unlistedSeries({ aPriceAtBuild: 8 }), dividends: {},
    holdings: [{ code: 'A', weight: 40 }, { code: 'B', weight: 40 }, { code: 'C', weight: 20 }],
    capital: 1000000, monthlyAdd: 0, from: cal[0], to: cal.at(-1), mode: 'invest',
  });
  // 建仓前股票市值 = 50000×8 + 25000×20 = 90 万 → C 目标 20% = 18 万
  assert.equal(r.builds[0].shares, 9000); // 180000/20
});

test('未上市：整段都没有行情也不崩，列出 pending', () => {
  const series = unlistedSeries();
  series.delete('C');
  const r = runPortfolioBacktest({
    dates: cal, series, dividends: {},
    holdings: [{ code: 'A', weight: 40 }, { code: 'B', weight: 40 }, { code: 'C', weight: 20 }],
    capital: 1000000, monthlyAdd: 0, from: cal[0], to: cal.at(-1), mode: 'invest',
  });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].code, 'C');
  assert.equal(r.pending[0].reason, '无行情数据');
  assert.ok(r.nav.at(-1)[1] > 0);
});

test('未上市：建仓日之后不再重复建仓', () => {
  const r = runPortfolioBacktest({
    dates: cal, series: unlistedSeries(), dividends: {},
    holdings: [{ code: 'A', weight: 40 }, { code: 'B', weight: 40 }, { code: 'C', weight: 20 }],
    capital: 1000000, monthlyAdd: 0, from: cal[0], to: cal.at(-1), mode: 'invest',
  });
  assert.equal(r.builds.length, 1);
  assert.equal(r.events.filter((e) => e.type === '买入' && e.code === 'C').length, 1);
});

/* ---------------- 未上市股票：多场景矩阵 ---------------- */

test('多只未上市 + 不同上市时间：各自按份额建仓，建仓后回到目标权重', () => {
  const cal2 = ['2020-01-02', '2021-01-04', '2021-07-05', '2022-01-04', '2022-07-05', '2023-01-03', '2023-06-30'];
  const mk = (datesArr, closes) => ({ dates: datesArr, closes });
  const series = new Map([
    // A/B 起点已上市；C 2021-01-04 上市（2021-07-05 建仓）；D 2022-01-04 上市（2022-07-05 建仓）
    ['A', mk(['2019-06-03', ...cal2], [10, 10, 10, 10, 10, 10, 10, 10])],
    ['B', mk(['2019-06-03', ...cal2], [20, 20, 20, 20, 20, 20, 20, 20])],
    ['C', mk(['2021-01-04', '2021-07-05', '2022-01-04', '2022-07-05', '2023-01-03', '2023-06-30'], [10, 10, 10, 10, 10, 10])],
    ['D', mk(['2022-01-04', '2022-07-05', '2023-01-03', '2023-06-30'], [15, 15, 15, 15])],
  ]);
  const r = runPortfolioBacktest({
    dates: cal2, series, dividends: {},
    holdings: [{ code: 'A', weight: 25 }, { code: 'B', weight: 25 }, { code: 'C', weight: 25 }, { code: 'D', weight: 25 }],
    capital: 1000000, monthlyAdd: 0, from: cal2[0], to: cal2.at(-1), mode: 'invest',
  });
  assert.equal(r.builds.length, 2);
  assert.equal(r.builds[0].code, 'C');
  assert.equal(r.builds[0].date, '2021-07-05');
  assert.equal(r.builds[1].code, 'D');
  assert.equal(r.builds[1].date, '2022-07-05');
  // 起点：A/B 各 37.5 万（C+D 的 50% 平均摊）
  const first = r.comp[0][1];
  assert.equal(Math.round(first.A / (first.A + first.B) * 100), 50);
  // 第一次建仓后：C 与 A/B 各约 1/3（D 还没上市，它的份额继续摊给可买的 3 只）
  const afterC = r.comp[2][1];
  const totC = Object.values(afterC).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(afterC.C / totC - 1 / 3) < 0.01, 'C 权重 ' + (afterC.C / totC));
  // 第二次建仓后：四只各约 25%
  const afterD = r.comp[4][1];
  const totD = Object.values(afterD).reduce((a, b) => a + b, 0);
  for (const c of ['A', 'B', 'C', 'D']) assert.ok(Math.abs(afterD[c] / totD - 0.25) < 0.01, c + ' 权重');
});

test('非等权：60/20/20（C 未上市）→ 起点 A70/B30，建仓后回到 60/20/20', () => {
  const r = runPortfolioBacktest({
    dates: cal, series: unlistedSeries(), dividends: {},
    holdings: [{ code: 'A', weight: 60 }, { code: 'B', weight: 20 }, { code: 'C', weight: 20 }],
    capital: 1000000, monthlyAdd: 0, from: cal[0], to: cal.at(-1), mode: 'invest',
  });
  const first = r.comp[0][1];
  assert.equal(Math.round((first.A / (first.A + first.B)) * 100), 70);
  const after = r.comp[3][1];
  const tot = Object.values(after).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(after.A / tot - 0.6) < 0.01);
  assert.ok(Math.abs(after.B / tot - 0.2) < 0.01);
  assert.ok(Math.abs(after.C / tot - 0.2) < 0.01);
});

test('上市不满 6 个月：建仓日 = 上市 + 6 个月，且期间份额摊给已上市', () => {
  const cal3 = ['2020-01-02', '2020-12-31', '2021-03-01', '2021-09-03', '2022-06-30'];
  const series = new Map([
    ['A', { dates: ['2019-06-03', ...cal3], closes: [10, 10, 10, 11, 12] }],
    ['C', { dates: ['2020-10-09', '2020-12-31', '2021-03-01', '2021-09-03', '2022-06-30'], closes: [20, 20, 20, 21, 22] }],
  ]);
  const r = runPortfolioBacktest({
    dates: cal3, series, dividends: {},
    holdings: [{ code: 'A', weight: 50 }, { code: 'C', weight: 50 }],
    capital: 1000000, monthlyAdd: 0, from: cal3[0], to: cal3.at(-1), mode: 'invest',
  });
  // 2020-10-09 上市 + 6 个月 = 2021-04-09 → 区间内第一个 ≥ 该日的交易日是 2021-09-03
  assert.equal(r.builds.length, 1);
  assert.equal(r.builds[0].date, '2021-09-03');
});

test('月追加 + 未上市：追加资金先摊给已上市，建仓金额含期间增长', () => {
  const r = runPortfolioBacktest({
    dates: cal, series: unlistedSeries(), dividends: {},
    holdings: [{ code: 'A', weight: 40 }, { code: 'B', weight: 40 }, { code: 'C', weight: 20 }],
    capital: 1000000, monthlyAdd: 10000, from: cal[0], to: cal.at(-1), mode: 'invest',
  });
  assert.ok(r.totalIn > 1000000);
  assert.equal(r.builds.length, 1);
  // 期间组合长大（月追加 + 股价），C 的建仓金额应大于初始 20 万
  assert.ok(r.builds[0].shares * r.builds[0].price > 200000, '建仓金额应含增长');
});

test('全是未上市：起点全是现金，逐只建仓，不崩', () => {
  const cal4 = ['2020-01-02', '2021-01-04', '2021-07-05', '2022-01-04', '2022-07-05', '2023-01-03'];
  const mk = (datesArr) => ({ dates: datesArr, closes: datesArr.map(() => 10) });
  const series = new Map([
    ['A', mk(['2021-01-04', '2021-07-05', '2022-01-04', '2022-07-05', '2023-01-03'])],
    ['B', mk(['2022-01-04', '2022-07-05', '2023-01-03'])],
  ]);
  const r = runPortfolioBacktest({
    dates: cal4, series, dividends: {},
    holdings: [{ code: 'A', weight: 50 }, { code: 'B', weight: 50 }],
    capital: 1000000, monthlyAdd: 0, from: cal4[0], to: cal4.at(-1), mode: 'invest',
  });
  assert.equal(Math.round(r.nav[0][1]), 1000000); // 起点全是现金
  assert.equal(r.builds.length, 2);
  assert.equal(r.builds[0].code, 'A');
  assert.equal(r.builds[1].code, 'B');
});

test('建仓延迟参数：3 个月与 6 个月结果不同', () => {
  const cal5 = ['2020-01-02', '2020-06-01', '2020-09-01', '2021-01-04', '2021-06-30'];
  const series = new Map([
    ['A', { dates: ['2019-06-03', ...cal5], closes: [10, 10, 10, 10, 10] }],
    ['C', { dates: ['2020-03-02', '2020-06-01', '2020-09-01', '2021-01-04', '2021-06-30'], closes: [20, 20, 20, 20, 20] }],
  ]);
  const r6 = runPortfolioBacktest({ dates: cal5, series, dividends: {}, holdings: [{ code: 'A', weight: 50 }, { code: 'C', weight: 50 }], capital: 1000000, monthlyAdd: 0, from: cal5[0], to: cal5.at(-1), mode: 'invest', buildDelayMonths: 6 });
  const r3 = runPortfolioBacktest({ dates: cal5, series, dividends: {}, holdings: [{ code: 'A', weight: 50 }, { code: 'C', weight: 50 }], capital: 1000000, monthlyAdd: 0, from: cal5[0], to: cal5.at(-1), mode: 'invest', buildDelayMonths: 3 });
  assert.equal(r6.builds[0].date, '2021-01-04'); // 2020-03-02 + 6m = 2020-09-02，日历里下一个交易日是 2021-01-04
  assert.equal(r3.builds[0].date, '2020-09-01'); // +3m = 2020-06-02 → 下一个交易日 2020-09-01
});
