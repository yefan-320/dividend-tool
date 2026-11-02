import test from 'node:test';
import { withEv } from './div-helper.js';
import assert from 'node:assert/strict';
import { runPortfolioBacktest } from '../src/engine/portfolioBacktest.js';

/* ---------------- 通用夹具（沿用 portfolioBacktest.test.js 的 mkSeries 风格） ---------------- */

const dates = ['2020-01-02', '2020-04-30', '2020-12-31', '2021-04-30', '2021-12-31'];

function mkSeries(map) {
  // 每只股票都有一根「回测起点之前」的日线，表示它起点前已上市（否则会触发“未上市建仓”规则）
  const m = new Map();
  for (const [code, closes] of Object.entries(map)) m.set(code, { dates: ['2019-06-03', ...dates], closes: [closes[0], ...closes] });
  return m;
}

/** 平盘组合：A 10 元、B 20 元，各 50%，无分红 */
function flatPortfolio(patch = {}) {
  return {
    dates,
    series: mkSeries({ A: [10, 10, 10, 10, 10], B: [20, 20, 20, 20, 20] }),
    dividends: {},
    holdings: [{ code: 'A', weight: 50 }, { code: 'B', weight: 50 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    ...patch,
  };
}

const buyEvents = (r) => r.events.filter((e) => e.type === '买入');

/* ---------------- 1. once 默认 = 显式 once ---------------- */

test('entry 默认 once：与显式 {mode:once} 完全一致，entry 返回归一化结构', () => {
  const a = runPortfolioBacktest(flatPortfolio());
  const b = runPortfolioBacktest(flatPortfolio({ entry: { mode: 'once' } }));
  assert.deepEqual(a.nav, b.nav);
  assert.deepEqual(a.navR, b.navR);
  assert.deepEqual(a.events, b.events);
  assert.equal(a.end, b.end);
  assert.deepEqual(a.entry, {
    mode: 'once', months: 12, minDy: 5.5,
    installments: [], triggered: {}, neverTriggered: [],
  });
  // once 行为与加 entry 之前一致：起点一次买齐、净值 = 本金
  assert.equal(Math.round(a.nav[0][1]), 1000000);
  assert.equal(a.entry.installments.length, 0);
});

test('entry 参数归一化：mode 非法回落 once，months clamp 1..60，minDy clamp 0..20', () => {
  const norm = (entry) => runPortfolioBacktest(flatPortfolio({ entry })).entry;
  assert.equal(norm({ mode: 'xxx' }).mode, 'once');
  assert.equal(norm({ mode: 'staged', months: 0 }).months, 1);
  assert.equal(norm({ mode: 'staged', months: 999 }).months, 60);
  assert.equal(norm({ mode: 'dip', minDy: -3 }).minDy, 0);
  assert.equal(norm({ mode: 'dip', minDy: 99 }).minDy, 20);
});

/* ---------------- 2. staged 分批建仓 ---------------- */

test('staged months=4 平盘无分红：nav[0]=本金，每期 1/4，持仓台阶上升、现金同步下降', () => {
  const capital = 1000000;
  const r = runPortfolioBacktest(flatPortfolio({ entry: { mode: 'staged', months: 4 } }));
  const perPeriod = capital / 4;

  // 未投本金仍是账户里的现金：净值口径 = 现金 + 持仓，起点净值 = 本金
  assert.equal(Math.round(r.nav[0][1]), capital);

  // 起点（1 期）+ 之后 3 个月末（2/3/4 期）
  assert.equal(r.entry.installments.length, 4);
  assert.deepEqual(r.entry.installments.map((x) => x.date), dates.slice(0, 4));
  // 第 1 期实际买入金额 ≈ 股票部分本金 ÷ months（±1 个整手；100 股整手会磨掉零头）
  assert.ok(Math.abs(r.entry.installments[0].amount - perPeriod) <= 2000,
    `第 1 期买入应≈${perPeriod}，实际 ${r.entry.installments[0].amount}`);
  for (const it of r.entry.installments) {
    assert.ok(Math.abs(it.amount - perPeriod) <= 4000, `每期预算应≈${perPeriod}，实际 ${it.amount}`);
  }
  const invested = r.entry.installments.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(invested - capital) <= 15000, `累计投入应≈本金，实际 ${invested}`);

  // 每期买入事件 why 形如「分批建仓 3/4 期」
  const stalls = buyEvents(r).filter((e) => e.why.startsWith('分批建仓'));
  assert.ok(stalls.some((e) => e.why === '分批建仓 2/4 期'));
  assert.ok(stalls.some((e) => e.why === '分批建仓 4/4 期'));

  // 前 3 个月末：持仓市值台阶上升、现金同步下降（起点 → 第 2/3/4 期）
  const stockOf = (row) => Object.entries(row).filter(([k]) => k !== 'cash').reduce((s, [, v]) => s + v, 0);
  for (let k = 1; k <= 3; k++) {
    const prev = r.comp[k - 1][1];
    const cur = r.comp[k][1];
    assert.ok(stockOf(cur) > stockOf(prev) + perPeriod * 0.8, `第 ${k + 1} 期后持仓市值应台阶上升`);
    assert.ok(cur.cash < prev.cash - perPeriod * 0.8, `第 ${k + 1} 期后现金应同步下降`);
  }

  // 4 个月末后股票基本买满
  const row = r.comp[3][1];
  const stockValue = row.A + row.B;
  assert.ok(stockValue > capital * 0.98, `满期后股票应≈本金，实际 ${stockValue}`);

  // 满期后预留归零，末值≈本金（只多出一点现金利息）
  assert.ok(Math.abs(r.end / capital - 1) < 0.02, `末值应≈本金，实际 ${r.end}`);
  assert.ok(r.end > capital, '现金利息照旧，末值略高于本金');
});

test('staged months=1 ≈ once（期数 1 时退化为一次买齐）', () => {
  const once = runPortfolioBacktest(flatPortfolio());
  const staged1 = runPortfolioBacktest(flatPortfolio({ entry: { mode: 'staged', months: 1 } }));
  assert.deepEqual(staged1.nav, once.nav);
  assert.deepEqual(staged1.navR, once.navR);
  assert.equal(staged1.end, once.end);
  assert.equal(staged1.entry.installments.length, 1);
  assert.equal(staged1.entry.installments[0].date, dates[0]);
  // months=1 没有预留本金，起点净值 = 本金
  assert.equal(Math.round(staged1.nav[0][1]), 1000000);
});

test('staged 预留本金不被提前花掉：4 月末高额分红只复投分红，后面两期照常投', () => {
  // 单票 100%、股价 10 元平盘、2019 年度每股分红 5 元，除息日 2020-04-30
  const r = runPortfolioBacktest({
    dates,
    series: new Map([['A', { dates: ['2019-06-03', ...dates], closes: [10, 10, 10, 10, 10, 10] }]]),
    dividends: { A: { years: { 2019: 5 }, ev: [['2020-04-30', 5]] } },
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    entry: { mode: 'staged', months: 4 },
  });
  const perPeriod = 250000;

  // 到 2020-04-30 只投了 2 期（50 万本金）+ 分红复投；未投的 50 万仍保留，没有被拿去提前建仓
  const row = r.comp[1][1];
  assert.ok(row.A < 700000, `2020-04-30 持仓不应超过 70 万（否则花了预留本金），实际 ${row.A}`);
  assert.ok(row.A > 600000, `分红应仍按现有逻辑复投，实际 ${row.A}`);
  // 未投本金是账户里的现金：净值 = 现金 + 持仓，应≈本金 + 分红 + 利息
  assert.ok(r.nav[1][1] > 1000000 + 120000, `净值应含保留本金+分红，实际 ${r.nav[1][1]}`);

  // 分红到账 125,000（25,000 股 × 5 元）
  assert.equal(r.totalDiv, 125000);

  // 第 3、4 期照常投：每期≈25 万，日期是后续月末
  assert.deepEqual(r.entry.installments.map((x) => x.date), dates.slice(0, 4));
  assert.ok(Math.abs(r.entry.installments[2].amount - perPeriod) <= 1000);
  assert.ok(Math.abs(r.entry.installments[3].amount - perPeriod) <= 1000);

  // 期末 = 本金 + 分红 + 利息（分红复投后仍归投资者）
  assert.ok(r.end > 1000000 + 120000, `期末应≈本金+分红，实际 ${r.end}`);
});

/* ---------------- 3. dip 股息率触发建仓 ---------------- */

test('dip：起点价高（股息率不足）不买，nav[0]===本金且无买入；跌到门槛下才买', () => {
  const series = new Map([['A', { dates: ['2019-06-03', '2020-01-02', '2020-04-30', '2020-12-31'], closes: [21, 21, 10, 10] }]]);
  const r = runPortfolioBacktest({
    dates: ['2020-01-02', '2020-04-30', '2020-12-31'],
    series, dividends: { A: { years: { 2018: 1, 2019: 1 } } },
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 0, from: '2020-01-02', to: '2020-12-31', mode: 'invest',
    entry: { mode: 'dip', minDy: 5.5 },
  });
  // 2020-01-02 已知 DPS 用 2018 年度 1 元 ÷ 21 元 = 4.8% < 5.5% → 不买
  assert.equal(r.nav[0][1], 1000000);
  assert.equal(r.comp[0][1].cash, 1000000);
  assert.equal(r.entry.triggered.A, '2020-04-30');
  // 2020-04-30 已知 2019 年度 1 元 ÷ 10 元 = 10% ≥ 5.5% → 买
  const buys = buyEvents(r);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].date, '2020-04-30');
  assert.match(buys[0].why, /^股息率 10\.0% ≥ 5\.5% 建仓$/);
  assert.deepEqual(r.entry.neverTriggered, []);
});

test('dip：全程价格高（股息率不足）→ 一直留现金，neverTriggered 列出', () => {
  const r = runPortfolioBacktest({
    dates,
    series: mkSeries({ A: [25, 25, 25, 25, 25] }),
    dividends: { A: { years: { 2018: 1, 2019: 1 } } },
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    entry: { mode: 'dip', minDy: 5.5 },
  });
  assert.equal(r.nav[0][1], 1000000);
  assert.equal(buyEvents(r).length, 0);
  assert.deepEqual(r.entry.triggered, {});
  assert.deepEqual(r.entry.neverTriggered, ['A']);
  assert.equal(r.pending.length, 0); // 有行情、只是没触发 → 不进 pending
});

test('dip：触发后按目标权重（总资产 × w%）买，误差不超过 1 个整手；无分红股票 neverTriggered', () => {
  const r = runPortfolioBacktest({
    dates,
    series: mkSeries({ A: [10, 10, 10, 10, 10], B: [10, 10, 10, 10, 10] }),
    dividends: { A: { years: { 2018: 1, 2019: 1 } } }, // A 起点即 10% 股息率；B 无分红历史，永不触发
    holdings: [{ code: 'A', weight: 50 }, { code: 'B', weight: 50 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    entry: { mode: 'dip', minDy: 5.5 },
  });
  // 起点：A 目标 = 100 万 × 50% = 50 万；1 个整手 = 100 股 = 1000 元
  const row0 = r.comp[0][1];
  assert.ok(Math.abs(row0.A - 500000) <= 1000, `A 首笔应≈50 万，实际 ${row0.A}`);
  assert.equal(row0.B || 0, 0); // B 不触发 → 一直留现金
  assert.ok(Math.abs(row0.cash - 500000) <= 1000);
  assert.equal(r.entry.triggered.A, dates[0]);
  assert.deepEqual(r.entry.neverTriggered, ['B']);

  // 2020-04-30 A 分红 5 万后总资产变大，触发补仓到「当前总资产 × 50%」（×1 个整手误差内）
  const row1 = r.comp[1][1];
  const total1 = (row1.A || 0) + (row1.B || 0) + row1.cash;
  const targetA = total1 * 0.5;
  assert.ok(Math.abs(row1.A - targetA) <= 1000, `A 应补到 ${targetA}，实际 ${row1.A}`);
  assert.equal(row1.B || 0, 0);
});

test('dip：月追加同样受股息率门槛约束（不触发就躺现金）', () => {
  const r = runPortfolioBacktest({
    dates: ['2020-01-02', '2020-04-30', '2020-12-31'],
    series: mkSeries({ A: [25, 25, 25, 25, 25] }),
    dividends: { A: { years: { 2018: 1, 2019: 1 } } },
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 10000, from: '2020-01-02', to: '2020-12-31', mode: 'invest',
    entry: { mode: 'dip', minDy: 5.5 },
  });
  assert.equal(buyEvents(r).length, 0, '股息率不到门槛，追加的钱不应买入');
  assert.equal(r.totalIn, 1000000 + 10000 * 6 * 2); // 2020-04、2020-12 两个追加日
  assert.ok(r.cashEnd > 1100000);
});

test('dip：区间内没上市的股票留在 pending，不塞进 neverTriggered', () => {
  const cal = ['2020-01-02', '2020-06-30', '2020-12-31', '2021-06-30'];
  const series = new Map([
    ['A', { dates: ['2019-06-03', ...cal], closes: [10, 10, 10, 10, 10] }],
    // C 2021-12-31 才上市：区间内没行情
    ['C', { dates: ['2021-12-31'], closes: [10] }],
  ]);
  const r = runPortfolioBacktest({
    dates: cal, series, dividends: { A: { years: { 2019: 1, 2020: 1 } } },
    holdings: [{ code: 'A', weight: 50 }, { code: 'C', weight: 50 }],
    capital: 1000000, monthlyAdd: 0, from: cal[0], to: cal.at(-1), mode: 'invest',
    entry: { mode: 'dip', minDy: 5.5 },
  });
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].code, 'C');
  assert.equal(r.pending[0].reason, '区间内未上市');
  assert.ok(r.entry.triggered.A); // A 有行情、触发过
  assert.deepEqual(r.entry.neverTriggered, []); // C 算 pending，不重复塞 neverTriggered
});

/* ---------------- 4. once 原有规则零回归 ---------------- */

const cal = ['2020-01-02', '2020-06-30', '2020-12-31', '2021-07-05', '2021-12-31', '2022-06-30'];

function unlistedSeries() {
  const A = { dates: ['2019-06-03', '2020-01-02', '2020-06-30', '2020-12-31', '2021-07-05', '2021-12-31', '2022-06-30'], closes: [10, 10, 10, 11, 11, 11, 11] };
  const B = { dates: ['2019-06-03', ...cal], closes: [20, 20, 20, 20, 20, 20, 20] };
  const C = { dates: ['2021-01-04', '2021-07-05', '2021-12-31', '2022-06-30'], closes: [20, 20, 21, 21] };
  return new Map([['A', A], ['B', B], ['C', C]]);
}

test('once + entry：未上市股票份额摊给已上市、上市满 6 个月建仓的规则不变', () => {
  const r = runPortfolioBacktest({
    dates: cal, series: unlistedSeries(), dividends: {},
    holdings: [{ code: 'A', weight: 40 }, { code: 'B', weight: 40 }, { code: 'C', weight: 20 }],
    capital: 1000000, monthlyAdd: 0, from: cal[0], to: cal.at(-1), mode: 'invest',
    entry: { mode: 'once' },
  });
  assert.equal(Math.round(r.nav[0][1]), 1000000);
  assert.equal(r.builds.length, 1);
  assert.equal(r.builds[0].code, 'C');
  assert.equal(r.builds[0].date, '2021-07-05');
  assert.equal(r.builds[0].shares, 10400); // 与现有一致：20% × 105 万 / 20 元，整手取整后 10,400 股
  assert.ok(r.events.some((e) => e.type === '买入' && e.code === 'C' && e.why.includes('上市满')));
  assert.deepEqual(r.entry, { mode: 'once', months: 12, minDy: 5.5, installments: [], triggered: {}, neverTriggered: [] });
});

/* ---------------- 5. replay 忽略 entry ---------------- */

test('replay 忽略 entry：传 staged 也与不传时净值一致', () => {
  const common = {
    dates,
    series: mkSeries({ A: [10, 10, 10, 10, 10] }),
    dividends: {},
    holdings: [{ code: 'A', weight: 100 }],
    capital: 0, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'replay',
    lots: [{ code: 'A', shares: 10000 }], cash0: 100000,
  };
  const a = runPortfolioBacktest(common);
  const b = runPortfolioBacktest({ ...common, entry: { mode: 'staged', months: 4 } });
  assert.deepEqual(a.nav, b.nav);
  assert.deepEqual(a.events, b.events);
  // replay 也回一份归一化 entry（但没有分期/触发数据）
  assert.equal(b.entry.mode, 'staged');
  assert.equal(b.entry.months, 4);
  assert.deepEqual(b.entry.installments, []);
  assert.deepEqual(b.entry.triggered, {});
  assert.deepEqual(b.entry.neverTriggered, []);
});
