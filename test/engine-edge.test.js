/**
 * 引擎边界测试与不变量校验（独立于现有 80 个用例）。
 *
 * 目的：把「回测/组合/方案/估值」这些纯函数的数学不变量和边界行为固化下来，
 * 并暴露少数脏输入/契约外输入下的缺陷（文件内用 `// 已修复回归:` 标注）。
 *
 * 2026-11-01：本文件首轮暴露的 5 个缺陷已由 Lead 修复（src/engine/portfolioBacktest.js /
 * market.js / stockBacktest.js / portfolio.js），下列相关用例全部保留为回归，当前应全绿。
 *
 * 口径提醒：
 *  - 组合回测 nav 口径（2026-11-01 Lead 确认）= 现金 + 持仓，含 staged 未投本金，
 *    所以 staged 的 nav[0] === capital（task-2 描述里的「nav[0] < capital」是旧口径，已废弃）。
 *  - 回测 weight 契约：各股票 weight 合计 ≤ 100（本文件同时测试 >100 的防御行为）。
 */
import test from 'node:test';
import { withEv } from './div-helper.js';
import assert from 'node:assert/strict';

import { runPortfolioBacktest } from '../src/engine/portfolioBacktest.js';
import { runStockBacktest } from '../src/engine/stockBacktest.js';
import { buildLots, lotStats, portfolioStats, dividendsForLot } from '../src/engine/portfolio.js';
import { normalizePlan, makePlan, normalizeEntry, planActionRows, planStockTotal } from '../src/engine/plan.js';
import { evaluate } from '../src/engine/verdict.js';
import { qualityOf, dyQuality } from '../src/engine/market.js';
import { xirr, annualize, asRate, stdev, sharpe, maxDrawdown, navFromReturns, monthlyReturns } from '../src/engine/finance.js';

/* ============================ 夹具 ============================ */

const DATES = ['2020-01-02', '2020-04-30', '2020-06-30', '2020-12-31', '2021-04-30', '2021-06-30', '2021-12-31', '2022-04-29'];

/** 每只股票在回测起点前都有一根日线（表示起点前已上市） */
function mkSeries(map, preDate = '2019-06-03') {
  const m = new Map();
  for (const [code, closes] of Object.entries(map)) {
    m.set(code, { dates: [preDate, ...DATES], closes: [closes[0], ...closes] });
  }
  return m;
}

/** 平盘两只股票：A 30 元、B 20 元 */
function flatSeries() {
  return mkSeries({
    A: DATES.map(() => 10),
    B: DATES.map(() => 20),
  });
}

function baseOpts(patch = {}) {
  return {
    dates: DATES,
    series: flatSeries(),
    dividends: {},
    holdings: [{ code: 'A', weight: 50 }, { code: 'B', weight: 50 }],
    capital: 1000000,
    monthlyAdd: 0,
    from: DATES[0],
    to: DATES.at(-1),
    mode: 'invest',
    ...patch,
  };
}

const buyEvents = (r) => r.events.filter((e) => e.type === '买入');

/** 通用不变量：nav 有限、现金非负、nav === 现金 + 持仓（comp 汇总）、end 一致 */
function assertNavInvariants(r, label) {
  assert.equal(r.nav.length, r.comp.length, `${label}: nav 与 comp 长度不一致`);
  for (let i = 0; i < r.nav.length; i++) {
    const [d, v] = r.nav[i];
    const row = r.comp[i][1];
    assert.ok(Number.isFinite(v), `${label}: ${d} nav 非有限数 ${v}`);
    assert.ok(v >= 0, `${label}: ${d} nav 为负 ${v}`);
    assert.ok(Number.isFinite(row.cash), `${label}: ${d} 现金非有限数`);
    assert.ok(row.cash >= -1e-6, `${label}: ${d} 现金为负 ${row.cash}`);
    let sum = 0;
    for (const [, val] of Object.entries(row)) {
      assert.ok(Number.isFinite(val), `${label}: ${d} 持仓市值非有限数`);
      sum += val;
    }
    assert.ok(Math.abs(sum - v) <= 0.1, `${label}: ${d} nav=${v} 与「现金+持仓」=${sum} 不一致`);
  }
  assert.equal(r.end, r.nav.at(-1)[1], `${label}: end 与最后一条 nav 不一致`);
  assert.equal(r.endR, r.navR.at(-1)[1], `${label}: endR 与最后一条 navR 不一致`);
  assert.ok(r.navR.every(([, v]) => Number.isFinite(v)), `${label}: navR 出现非有限数`);
  assert.ok(Math.abs(r.cashEnd - r.comp.at(-1)[1].cash) <= 0.01, `${label}: cashEnd 与最后一条 comp.cash 不一致（差 ${r.cashEnd - r.comp.at(-1)[1].cash}）`);
}

/* ============================ 1. 回测不变量：现金守恒 / nav 有限 ============================ */

test('不变量：once 回测全程 nav 有限、现金非负、nav = 现金 + 持仓，现金流记账正确', () => {
  const r = runPortfolioBacktest(baseOpts({
    series: mkSeries({
      A: [10, 12, 8, 11, 9, 13, 10, 12],
      B: [20, 18, 22, 19, 21, 17, 23, 20],
    }),
    dividends: withEv({ A: { years: { 2019: 1, 2020: 1, 2021: 1 } }, B: { years: { 2019: 2 } } }),
    monthlyAdd: 10000,
  }));
  assertNavInvariants(r, 'once');
  assert.equal(r.totalIn, 1000000 + 10000 * 6 * 5, '月追加 2020-04 / 2020-12 / 2021-04 / 2021-12 / 2022-04 共 5 次');
  assert.ok(r.totalDiv > 0, '应有分红到账');
  assert.ok(r.events.some((e) => e.type === '分红'));
  assert.ok(r.events.some((e) => e.type === '追加'));
  assert.ok(Number.isFinite(r.stats.ret) && Number.isFinite(r.stats.cagr), '收益/年化应为有限数');
  assert.ok(r.stats.mdd <= 0, '最大回撤应为非正数');
  // 所有买入事件都是 100 股整手、正股数
  for (const e of r.events) {
    if (e.type === '买入' || e.type === '卖出') {
      assert.ok(Number.isFinite(e.shares) && e.shares > 0 && e.shares % 100 === 0, `事件股数异常：${JSON.stringify(e)}`);
    }
  }
});

test('不变量：staged 回测 nav 含未投本金（nav[0]=capital）、预留本金始终留在现金里', () => {
  const capital = 1000000;
  const months = 6;
  const r = runPortfolioBacktest(baseOpts({ entry: { mode: 'staged', months } }));
  assert.equal(r.entry.mode, 'staged');
  assert.equal(r.entry.months, months);
  assert.equal(Math.round(r.nav[0][1]), capital, 'nav 口径 = 现金 + 持仓（含预留本金），nav[0] 应等于本金');
  const perPeriod = capital * ((50 + 50) / 100) / months;
  assert.equal(r.entry.installments.length, months, '2020-01 起 6 个月末应投满 6 期');
  for (const it of r.entry.installments) {
    assert.ok(Number.isFinite(it.amount) && it.amount > 0, `分期金额异常 ${JSON.stringify(it)}`);
    assert.ok(it.amount <= perPeriod + 0.01, `单期买入 ${it.amount} 超过预算 ${perPeriod}`);
  }
  // 逐日检查：现金 ≥ 还没投的本金（预留不得被分红/追加/再平衡提前花掉）
  for (let i = 0; i < r.comp.length; i++) {
    const d = r.comp[i][0];
    const done = r.entry.installments.filter((x) => x.date <= d).length;
    const reserved = Math.max(0, perPeriod * (months - done));
    assert.ok(r.comp[i][1].cash >= reserved - 0.01, `${d}: 现金 ${r.comp[i][1].cash} < 预留本金 ${reserved}`);
  }
  assertNavInvariants(r, 'staged');
  for (const e of buyEvents(r).filter((e) => e.why.startsWith('分批建仓'))) {
    assert.ok(e.shares > 0 && e.shares % 100 === 0, `分批买入应为 100 股整手：${JSON.stringify(e)}`);
  }
});

test('不变量：dip 回测 nav 有限、只买不卖、没触发的股票一直留现金', () => {
  const r = runPortfolioBacktest(baseOpts({
    series: mkSeries({
      A: [10, 12, 8, 11, 9, 13, 10, 12],
      B: [20, 18, 22, 19, 21, 17, 23, 20],
    }),
    dividends: withEv({ A: { years: { 2018: 1, 2019: 1, 2020: 1 } } }),
    entry: { mode: 'dip', minDy: 5.5 },
  }));
  assertNavInvariants(r, 'dip');
  assert.equal(r.entry.triggered.A, DATES[0], 'A 起点（2020-01 用 2018 年度 DPS）就达到门槛');
  assert.deepEqual(r.entry.neverTriggered, ['B'], 'B 无分红历史 → neverTriggered');
  assert.deepEqual(r.pending, [], '两只都有行情，不应进 pending');
  assert.equal(r.events.filter((e) => e.type === '卖出').length, 0, 'dip 只买不卖');
  for (const e of buyEvents(r)) {
    assert.ok(e.shares > 0 && e.shares % 100 === 0, 'dip 买入应为 100 股整手');
    assert.match(e.why, /^股息率 \d+\.\d% ≥ 5\.5% 建仓$/);
  }
});

/* ============================ 2. 仓位边界：权重和 / 单只 / 0 权重 / 空组合 ============================ */

test('权重合计 <100：股票部分按比例买入，剩下的计划现金不会被复投吃掉', () => {
  const holdings = [{ code: 'A', weight: 30 }, { code: 'B', weight: 30 }];
  const once = runPortfolioBacktest(baseOpts({ holdings }));
  // 起点：股票 60 万、现金 40 万；净值仍 = 本金
  assert.equal(Math.round(once.nav[0][1]), 1000000);
  assert.equal(Math.round(once.comp[0][1].cash), 400000);
  assert.equal(Math.round(once.comp[0][1].A), 300000);
  assert.equal(Math.round(once.comp[0][1].B), 300000);
  assert.ok(once.cashEnd >= 400000 * 0.98, `计划现金应大概率保留，实际 ${once.cashEnd}`);
  assertNavInvariants(once, '权重60 once');

  const staged = runPortfolioBacktest(baseOpts({ holdings, entry: { mode: 'staged', months: 2 } }));
  // 起点第 1 期 30 万 + 预留 30 万 + 计划现金 40 万 = 现金 70 万；净值 = 本金
  assert.equal(Math.round(staged.nav[0][1]), 1000000);
  assert.equal(Math.round(staged.comp[0][1].cash), 700000);
  assert.ok(staged.cashEnd >= 400000 * 0.98, `满期后计划现金应保留，实际 ${staged.cashEnd}`);
  assertNavInvariants(staged, '权重60 staged');
});

test('单只 100% / 0 权重 / 空组合：不崩、净值有限、不产生持仓/事件', () => {
  // 单只满仓
  const single = runPortfolioBacktest(baseOpts({ holdings: [{ code: 'A', weight: 100 }] }));
  assert.equal(Math.round(single.nav[0][1]), 1000000);
  assert.equal(Math.round(single.comp[0][1].A), 1000000);
  assert.equal(Math.round(single.comp[0][1].cash), 0);
  assertNavInvariants(single, '单只100');

  // 0 权重 = 空组合：全现金，只吃现金利息
  for (const holdings of [[{ code: 'A', weight: 0 }], []]) {
    for (const entry of [{ mode: 'once' }, { mode: 'staged', months: 4 }, { mode: 'dip', minDy: 5.5 }]) {
      const r = runPortfolioBacktest(baseOpts({ holdings, entry, dividends: withEv({ A: { years: { 2018: 1 } } }) }));
      assert.equal(Math.round(r.nav[0][1]), 1000000, `${entry.mode} 空组合起点净值应 = 本金`);
      assertNavInvariants(r, `空组合 ${entry.mode}`);
      assert.deepEqual(r.builds, []);
      assert.deepEqual(r.pending, []);
      assert.deepEqual(buyEvents(r), []);
      assert.ok(r.end > 1000000, '纯现金应吃到 1.5% 现金利息');
      // 注：股票本金为 0 时 staged 仍按月末记 0 元期数（不产生买入事件）——
      // 属展示层的 P3 观察项，UI 若要展示「建仓进度」需过滤 amount=0 的期数；引擎行为安全。
      assert.ok(r.entry.installments.every((x) => x.amount === 0), '股票本金为 0 时每期金额应为 0');
      assert.deepEqual(r.entry.neverTriggered, [], '空组合没有未触发股票');
    }
  }
});

test('未上市股票份额摊给已上市：起点不闲置、上市满 6 个月建仓后 nav 仍自洽', () => {
  const cal = ['2020-01-02', '2020-06-30', '2020-12-31', '2021-07-05', '2021-12-31', '2022-06-30'];
  const series = new Map([
    ['A', { dates: ['2019-06-03', '2020-01-02', '2020-06-30', '2020-12-31', '2021-07-05', '2021-12-31', '2022-06-30'], closes: [10, 10, 10, 11, 11, 11, 11] }],
    ['B', { dates: ['2019-06-03', ...cal], closes: [20, 20, 20, 20, 20, 20, 20] }],
    // C 2021-01-04 才上市
    ['C', { dates: ['2021-01-04', '2021-07-05', '2021-12-31', '2022-06-30'], closes: [20, 20, 21, 21] }],
  ]);
  const r = runPortfolioBacktest({
    dates: cal, series, dividends: {},
    holdings: [{ code: 'A', weight: 40 }, { code: 'B', weight: 40 }, { code: 'C', weight: 20 }],
    capital: 1000000, monthlyAdd: 0, from: cal[0], to: cal.at(-1), mode: 'invest',
  });
  // 起点 C 未上市 → 40/40 摊成 50/50
  assert.equal(Math.round(r.comp[0][1].cash), 0);
  assert.equal(Math.round(r.comp[0][1].A), 500000);
  assert.equal(Math.round(r.comp[0][1].B), 500000);
  assert.equal(Math.round(r.nav[0][1]), 1000000);
  assert.equal(r.builds.length, 1);
  assert.equal(r.builds[0].code, 'C');
  assert.equal(r.builds[0].date, '2021-07-05');
  assert.ok(r.builds[0].shares > 0 && r.builds[0].shares % 100 === 0);
  assertNavInvariants(r, '未上市摊分');
});

/* ============================ 3. entry：once 缺省 / replay 忽略 / staged 边界 ============================ */

test('once 缺省与显式 {mode:once} 结果完全一致（含 entry 字段）', () => {
  const a = runPortfolioBacktest(baseOpts({ dividends: withEv({ A: { years: { 2019: 1 } } }), monthlyAdd: 5000 }));
  const b = runPortfolioBacktest(baseOpts({ dividends: withEv({ A: { years: { 2019: 1 } } }), monthlyAdd: 5000, entry: { mode: 'once' } }));
  assert.deepEqual(a, b);
  assert.deepEqual(a.entry, { mode: 'once', months: 12, minDy: 5.5, installments: [], triggered: {}, neverTriggered: [] });
});

test('replay 模式忽略 entry：净值/事件/持仓构成与不传 entry 完全一致', () => {
  const common = {
    dates: DATES, series: flatSeries(), dividends: withEv({ A: { years: { 2019: 1 } } }),
    holdings: [{ code: 'A', weight: 100 }],
    capital: 0, monthlyAdd: 0, from: DATES[0], to: DATES.at(-1), mode: 'replay',
    lots: [{ code: 'A', shares: 10000 }], cash0: 100000,
  };
  const a = runPortfolioBacktest(common);
  const b = runPortfolioBacktest({ ...common, entry: { mode: 'staged', months: 4 } });
  assert.deepEqual(a.nav, b.nav);
  assert.deepEqual(a.navR, b.navR);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.comp, b.comp);
  // replay 也回一份归一化 entry，但不产生分期/触发数据
  assert.equal(b.entry.mode, 'staged');
  assert.equal(b.entry.months, 4);
  assert.deepEqual(b.entry.installments, []);
  assert.deepEqual(b.entry.triggered, {});
  assert.deepEqual(b.entry.neverTriggered, []);
});

test('staged months 边界：clamp 1..60，非法值回落默认 12，月末不够时按可用月末执行', () => {
  const cases = [
    [0, 1], [-5, 1], [1, 1], [8, 8], [60, 60], [61, 60], [999, 60], [NaN, 12], ['8', 8], [undefined, 12],
  ];
  for (const [input, expected] of cases) {
    const r = runPortfolioBacktest(baseOpts({ entry: { mode: 'staged', months: input } }));
    assert.equal(r.entry.months, expected, `months=${String(input)} 应归一化为 ${expected}`);
    assert.ok(r.entry.installments.length <= expected, '分期数不得超过期数');
    assert.equal(Math.round(r.nav[0][1]), 1000000);
    assertNavInvariants(r, `staged months=${String(input)}`);
  }
  // 区间只有 4 个月末，却设 12 期：只投 4+1 期，剩余本金留现金（现金利息照旧）
  const short = runPortfolioBacktest(baseOpts({
    dates: ['2020-01-02', '2020-04-30', '2020-12-31', '2021-04-30', '2021-12-31'],
    series: mkSeries({ A: [10, 10, 10, 10, 10], B: [20, 20, 20, 20, 20] }),
    entry: { mode: 'staged', months: 12 },
  }));
  assert.equal(short.entry.installments.length, 5, '起点 + 4 个月末 = 5 期');
  assert.equal(Math.round(short.nav[0][1]), 1000000);
  assert.ok(short.cashEnd > 500000, '没投出去的本金留在现金里');
  assertNavInvariants(short, 'staged 月末不够');
});

test('staged 每期预算 = 股票本金 / months，且按 100 股整手成交', () => {
  const dates = ['2020-01-02', '2020-04-30', '2020-12-31', '2021-04-30', '2021-12-31'];
  const r = runPortfolioBacktest({
    dates,
    series: mkSeries({ A: [10, 10, 10, 10, 10] }),
    dividends: {},
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    entry: { mode: 'staged', months: 4 },
  });
  // 单只、10 元、每期 25 万 → 每期正好 25,000 股 = 250,000 元
  assert.deepEqual(r.entry.installments.map((x) => x.amount), [250000, 250000, 250000, 250000]);
  assert.deepEqual(r.entry.installments.map((x) => x.date), dates.slice(0, 4));
  for (const e of buyEvents(r).filter((e) => e.why.startsWith('分批建仓'))) {
    assert.equal(e.shares % 100, 0, `股数不是整手：${JSON.stringify(e)}`);
    assert.equal(e.shares, 25000);
  }
});

/* ============================ 4. dip：门槛边界 / DPS 口径 / 目标权重 ============================ */

/** 单票 dip 场景：price 平盘，2018 年度 DPS 已知（起点用它） */
function dipCase({ minDy, dps, price = 20 }) {
  const dates = ['2020-01-02', '2020-04-30'];
  return runPortfolioBacktest({
    dates,
    series: new Map([['A', { dates: ['2019-06-03', ...dates], closes: [price, price, price] }]]),
    dividends: withEv({ A: { years: { 2018: dps } } }),
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    entry: { mode: 'dip', minDy },
  });
}

test('dip minDy 边界：恰好等于门槛触发，稍高不触发；minDy clamp 0..20 且四舍五入到两位', () => {
  // 股息率恰好 5%（DPS 1 / 价格 20）：minDy=5 触发
  const eq = dipCase({ minDy: 5, dps: 1 });
  assert.equal(eq.entry.minDy, 5);
  assert.equal(eq.entry.triggered.A, '2020-01-02');
  assert.equal(buyEvents(eq).length, 1);
  assert.equal(buyEvents(eq)[0].why, '股息率 5.0% ≥ 5% 建仓');
  // minDy=5.01 > 5%：不触发
  assert.deepEqual(dipCase({ minDy: 5.01, dps: 1 }).entry.triggered, {});
  // minDy=5.004 归一化成 5 → 触发；5.006 归一化成 5.01 → 不触发
  assert.equal(dipCase({ minDy: 5.004, dps: 1 }).entry.minDy, 5);
  assert.equal(dipCase({ minDy: 5.004, dps: 1 }).entry.triggered.A, '2020-01-02');
  assert.equal(dipCase({ minDy: 5.006, dps: 1 }).entry.minDy, 5.01);
  assert.deepEqual(dipCase({ minDy: 5.006, dps: 1 }).entry.triggered, {});
  // minDy=0：任何正股息率都触发；minDy 负数 clamp 到 0
  assert.equal(dipCase({ minDy: 0, dps: 0.001, price: 100 }).entry.triggered.A, '2020-01-02');
  assert.equal(dipCase({ minDy: -5, dps: 1 }).entry.minDy, 0);
  assert.equal(dipCase({ minDy: -5, dps: 1 }).entry.triggered.A, '2020-01-02');
  // minDy 上限 clamp 20：10% 股息率不触发
  assert.equal(dipCase({ minDy: 25, dps: 1, price: 10 }).entry.minDy, 20);
  assert.deepEqual(dipCase({ minDy: 25, dps: 1, price: 10 }).entry.triggered, {});
});

test('dip 已知 DPS 口径：4 月前用 Y-2 年度、4 月后用 Y-1 年度', () => {
  // 情形 1：2018 年度 0.5 元（2.5%，不到门槛）、2019 年度 2 元（10%）→ 只在 4 月后触发
  const dates = ['2020-01-02', '2020-04-30'];
  const r1 = runPortfolioBacktest({
    dates,
    series: new Map([['A', { dates: ['2019-06-03', ...dates], closes: [20, 20, 20] }]]),
    dividends: withEv({ A: { years: { 2018: 0.5, 2019: 2 } } }),
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    entry: { mode: 'dip', minDy: 5.5 },
  });
  assert.deepEqual(r1.entry.triggered, { A: '2020-04-30' }, '起点只能看到 2018 年度，4 月后才看到 2019 年度');
  assert.deepEqual(buyEvents(r1).map((e) => e.date), ['2020-04-30']);

  // 情形 2：只有 2020 年度 2 元；2021-02（月份 <4）只能看 2019 年度（无）→ 4 月后才触发
  const dates2 = ['2021-02-01', '2021-04-30'];
  const r2 = runPortfolioBacktest({
    dates: dates2,
    series: new Map([['A', { dates: ['2020-02-03', ...dates2], closes: [20, 20, 20] }]]),
    dividends: withEv({ A: { years: { 2020: 2 } } }),
    holdings: [{ code: 'A', weight: 100 }],
    capital: 1000000, monthlyAdd: 0, from: dates2[0], to: dates2.at(-1), mode: 'invest',
    entry: { mode: 'dip', minDy: 5.5 },
  });
  assert.deepEqual(r2.entry.triggered, { A: '2021-04-30' }, '1–3 月要用 Y-2 年度，2020 年度在 2021-04 才算「已知」');
});

test('dip 触发后按「当前总资产 × w%」补仓，误差不超过 1 个整手；无分红股票 neverTriggered', () => {
  const dates = ['2020-01-02', '2020-04-30'];
  const series = new Map(['A', 'B', 'C'].map((code) => [code, { dates: ['2019-06-03', ...dates], closes: [10, 10, 10] }]));
  const r = runPortfolioBacktest({
    dates, series,
    dividends: withEv({ A: { years: { 2018: 1 } } }), // A 起点 10% 触发；B/C 无分红
    holdings: [{ code: 'A', weight: 30 }, { code: 'B', weight: 40 }, { code: 'C', weight: 30 }],
    capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest',
    entry: { mode: 'dip', minDy: 5.5 },
  });
  const row = r.comp[0][1];
  const targetA = 1000000 * 30 / 100;
  assert.ok(Math.abs(row.A - targetA) <= 10 * 100, `A 应买到 ${targetA}±1 手，实际 ${row.A}`);
  assert.equal(row.B || 0, 0);
  assert.equal(row.C || 0, 0);
  assert.equal(Math.round(row.cash), 700000);
  assert.deepEqual(r.entry.triggered, { A: '2020-01-02' });
  assert.deepEqual(r.entry.neverTriggered, ['B', 'C']);
});

/* ============================ 5. 数值安全 ============================ */

// 已修复回归: 组合回测 capital=0 曾因除 capital 得到 NaN（2026-11-01 Lead 修复）
// 修复：收益率基准改为 nav[0]（replay 用 lots+cash0 起算），base<=0 时 ret/retR 返回 null；
//       cagr/cagrR 基于 ret 计算；src/engine/market.js annualize 增加 Number.isFinite(totalRet) 守卫。
// 原复现：runPortfolioBacktest({ ..., capital: 0 }) → 修复前 stats.ret/retR/cagr/cagrR = NaN
// 现在期望：stats.ret/retR/cagr/cagrR 为 null（nav 仍有限）
test('capital=0 时组合回测 stats.ret / cagr 返回 null（已修复回归）', () => {
  const r = runPortfolioBacktest(baseOpts({ capital: 0 }));
  assert.equal(r.stats.ret, null, `stats.ret 应为 null，实际 ${r.stats.ret}`);
  assert.equal(r.stats.retR, null, `stats.retR 应为 null，实际 ${r.stats.retR}`);
  assert.equal(r.stats.cagr, null, `stats.cagr 应为 null，实际 ${r.stats.cagr}`);
  assert.equal(r.stats.cagrR, null, `stats.cagrR 应为 null，实际 ${r.stats.cagrR}`);
  assert.ok(r.nav.every(([, v]) => Number.isFinite(v)), 'capital=0 时 nav 仍应为有限数');
});

// 已修复回归: 个股回测 capital=0 曾同样出现 NaN（2026-11-01 Lead 修复）
// 修复：src/engine/stockBacktest.js 中 capital=0 → ret/retHold/cagr/cagrHold 返回 null。
// 原复现：runStockBacktest({ ..., capital: 0 }) → 修复前 stats.ret/cagr/cagrHold = NaN
// 现在期望：三个字段为 null
test('capital=0 时个股回测 stats.ret / cagr / cagrHold 返回 null（已修复回归）', () => {
  const dates = ['2020-01-02', '2020-04-30', '2020-12-31'];
  const series = { dates: ['2019-06-03', ...dates], closes: [10, 10, 10, 10] };
  const r = runStockBacktest({
    code: 'A', dates, series, dividends: {}, finHistory: {},
    capital: 0, monthlyAdd: 0, minDy: 5, from: dates[0], to: dates.at(-1),
  });
  for (const key of ['ret', 'retHold', 'cagr', 'cagrHold']) {
    assert.equal(r.stats[key], null, `stats.${key} 应为 null，实际 ${r.stats[key]}`);
  }
});

test('数值安全：价格 0 / 分红 0 / 极端本金 不产生 NaN、Infinity 或负股数', () => {
  // 1) 持仓期间某天价格为 0（脏数据）：nav 允许跳变，但必须有限、可恢复、无 NaN
  const badSeries = new Map([['A', { dates: ['2019-06-03', ...DATES], closes: [10, 10, 0, 10, 10, 10, 10, 10, 10] }]]);
  const r0 = runPortfolioBacktest(baseOpts({ series: badSeries, holdings: [{ code: 'A', weight: 100 }] }));
  assert.ok(r0.nav.every(([, v]) => Number.isFinite(v)), '价格为 0 时 nav 仍应为有限数');
  assert.ok(Number.isFinite(r0.end) && Number.isFinite(r0.stats.ret), 'end / ret 应为有限数');
  assert.equal(Math.round(r0.end), 1000000, '价格恢复后净值应恢复');
  assertNavInvariants(r0, '价格为0');

  // 2) 分红为 0：不算分红、不产生分红事件
  const zeros = runPortfolioBacktest(baseOpts({ dividends: withEv({ A: { years: { 2019: 0 } }, B: { years: { 2019: 0 } } }) }));
  assert.equal(zeros.totalDiv, 0);
  assert.equal(zeros.events.filter((e) => e.type === '分红').length, 0);
  assertNavInvariants(zeros, '分红为0');

  // 3) 极端本金（1 万亿）+ 分批：全程有限、整手、正股数
  const huge = runPortfolioBacktest(baseOpts({
    capital: 1e12,
    holdings: [{ code: 'A', weight: 100 }],
    entry: { mode: 'staged', months: 3 },
  }));
  assert.ok(Number.isFinite(huge.end) && huge.end > 0);
  assert.equal(huge.entry.installments.length, 3);
  for (const e of buyEvents(huge)) assert.ok(Number.isFinite(e.shares) && e.shares > 0 && e.shares % 100 === 0);

  // 4) 仙股价格（0.01 元）：不应出现负股数 / NaN
  const penny = runPortfolioBacktest(baseOpts({
    series: new Map([['A', { dates: ['2019-06-03', ...DATES], closes: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01] }]]),
    holdings: [{ code: 'A', weight: 100 }],
  }));
  assert.equal(penny.events.filter((e) => e.type === '买入')[0].shares % 100, 0);
  assert.ok(Number.isFinite(penny.end));
});

/* ============================ 6. 组合回测入口的脏输入（已修复回归） ============================ */

// 已修复回归: 持仓重复代码曾导致持仓市值双计（2026-11-01 Lead 修复）
// 修复：入口新增 normalizeHoldings()——重复 code 权重相加、空代码/非有限/负权重丢弃、合计 >100 按比例缩到 100。
// 原复现：holdings [{code:'A',weight:50},{code:'A',weight:50}]、A=10 元 →
//         修复前 nav=1,000,000 但 comp 合计只有 500,000，且有 2 笔重复「初始建仓」事件
// 现在期望：A 权重合并为 100 → 全仓 100 万、只有 1 笔买入事件、nav = 现金 + 持仓
test('重复代码持仓会被归一化合并（已修复回归：不再双计、不再重复下单）', () => {
  const r = runPortfolioBacktest(baseOpts({ holdings: [{ code: 'A', weight: 50 }, { code: 'A', weight: 50 }] }));
  const row = r.comp[0][1];
  const sum = Object.values(row).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - r.nav[0][1]) < 0.5, `nav=${r.nav[0][1]} 与「现金+持仓」合计=${sum} 不一致（重复代码被双计）`);
  assert.equal(Math.round(row.A), 1000000, '合并后 A 权重 = 100 → 全仓 100 万');
  assert.equal(Math.round(row.cash), 0);
  assert.equal(buyEvents(r).filter((e) => e.code === 'A').length, 1, '同一代码只应有一笔初始建仓事件');
});

// 已修复回归: weight 合计 >100 曾导致 once 初始建仓现金为负（2026-11-01 Lead 修复）
// 修复：normalizeHoldings() 把合计 >100 的权重按比例缩到 100；初始建仓 cash 加 Math.max(0, ...) 兜底浮点误差。
// 原复现：holdings [{A,70},{B,50}]（120%）→ 修复前 comp[0].cash = -200,000
// 现在期望：现金 ≥ 0
test('权重合计 >100 会按比例缩到 100，现金不为负（已修复回归）', () => {
  const r = runPortfolioBacktest(baseOpts({ holdings: [{ code: 'A', weight: 70 }, { code: 'B', weight: 50 }] }));
  const minCash = Math.min(...r.comp.map(([, row]) => row.cash));
  assert.ok(minCash >= -1e-6, `最小现金 ${minCash} 为负（应 ≥0）`);
  // 70:50 = 58.33% : 41.67%（合计 100）→ 全仓 100 万，无超配
  const row = r.comp[0][1];
  assert.ok(Math.abs(row.A - 1000000 * 70 / 120) < 5000, `A 应≈${Math.round(1000000 * 70 / 120)}，实际 ${row.A}`);
  assert.ok(Math.abs((row.A + row.B) - 1000000) < 5000, '股票合计应≈100 万');
});

/* ============================ 7. plan.js：脏输入归一化 ============================ */

test('plan.normalizePlan 对脏输入安全：字符串权重/NaN/负数/重复/非法代码/超长名称', () => {
  const p = normalizePlan({
    name: '  ' + 'x'.repeat(50) + '  ',
    capital: 'abc',
    holdings: [
      { code: '600036', weight: '40' },
      { code: '600036', weight: 10 },   // 重复 → 合并 50
      { code: 'bad', weight: 5 },       // 非法代码 → 丢
      { code: '601398', weight: -5 },   // 负权重 → 丢
      { code: '000333', weight: NaN },  // NaN → 丢
      null,                             // 脏元素 → 丢
      'not-an-object',
    ],
    entry: { mode: 'staged', months: 999, minDy: -3 },
  });
  assert.equal(p.name, 'xxxxxxxxxxxxxxxxxxxx', '名称应 trim 并截断到 20 字');
  assert.equal(p.capital, 1000000, 'capital 非法 → 默认 100 万');
  assert.deepEqual(p.holdings, [{ code: '600036', weight: 50 }], '重复代码合并、脏权重/非法代码丢弃');
  assert.equal(p.entry.mode, 'staged');
  assert.equal(p.entry.months, 60, 'months clamp 60');
  assert.equal(p.entry.minDy, 0, 'minDy clamp 0');
  assert.equal(planStockTotal(p), 50);
  assert.ok(p.id === '');
});

test('plan.normalizePlan 权重合计 >100 按比例压回 100；null/非数组持仓安全', () => {
  const scaled = normalizePlan({ holdings: [{ code: '600036', weight: 80 }, { code: '601398', weight: 80 }] });
  assert.equal(planStockTotal(scaled), 100, '超 100 应压回 100');
  assert.deepEqual(scaled.holdings.map((h) => h.weight), [50, 50]);

  const nullish = normalizePlan(null);
  assert.equal(nullish.name, '我的方案');
  assert.deepEqual(nullish.holdings, []);
  assert.deepEqual(nullish.entry, { mode: 'once', months: 12, minDy: 5.5 });
  assert.equal(nullish.capital, 1000000);

  assert.deepEqual(normalizePlan({ holdings: {} }).holdings, []);
  assert.equal(normalizePlan({ capital: 0 }).capital, 1000, '本金下限 1000');
  assert.equal(normalizePlan({ capital: -5 }).capital, 1000);
  // 2026-11-01 起本金上限 1 万亿（防 1e15 落盘后显示 16 位数字 / 撑爆布局）
  assert.equal(normalizePlan({ capital: 1e15 }).capital, 1e12, '超大本金压到上限 1e12');
});

test('plan.makePlan / normalizeEntry / planActionRows 空参数安全', () => {
  const made = makePlan();
  assert.ok(/^p[a-z0-9]+$/.test(made.id), 'makePlan 应生成 p 开头的 id');
  assert.equal(made.capital, 1000000);
  assert.deepEqual(made.entry, { mode: 'once', months: 12, minDy: 5.5 });
  assert.equal(makePlan({ id: 'p-fixed' }).id, 'p-fixed', '显式 id 保留');

  assert.deepEqual(normalizeEntry(null), { mode: 'once', months: 12, minDy: 5.5 });
  assert.deepEqual(normalizeEntry({ mode: 'nope' }), { mode: 'once', months: 12, minDy: 5.5 });
  assert.equal(normalizeEntry({ mode: 'staged', months: '6' }).months, 6);
  assert.equal(normalizeEntry({ months: 0 }).months, 1);
  assert.equal(normalizeEntry({ months: 61 }).months, 60);
  assert.equal(normalizeEntry({ minDy: -1 }).minDy, 0);
  assert.equal(normalizeEntry({ minDy: 25 }).minDy, 20);

  const act = planActionRows({ plan: null });
  assert.deepEqual(act.rows, []);
  assert.deepEqual(act.outside, []);
  assert.equal(act.summary.capital, 0);
  assert.equal(act.summary.stagedBudget, 0);
  assert.equal(act.summary.entry.mode, 'once');
});

/* ============================ 8. portfolio.js 聚合边界（含已修复回归） ============================ */

test('portfolio 聚合：脏交易过滤、分红实施日边界、空组合安全', () => {
  // 股数 0 / 负股数 / 价格 0 / 空代码 → 直接丢弃
  const { lots } = buildLots([
    { date: '2024-01-10', code: 'X', side: 'buy', shares: 0, price: 10 },
    { date: '2024-01-10', code: 'X', side: 'buy', shares: -100, price: 10 },
    { date: '2024-01-10', code: 'X', side: 'buy', shares: 100, price: 0 },
    { date: '2024-01-10', code: '', side: 'buy', shares: 100, price: 10 },
    { date: '2024-01-10', code: 'X', side: 'buy', shares: 100, price: 10 },
  ]);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].shares, 100);

  // 分红实施日（Y+1-06-30）当天买入不算、前一天买入算
  const divs = { X: { years: { 2024: 1 } } };
  assert.deepEqual(dividendsForLot({ code: 'X', date: '2025-06-30', shares: 100 }, divs, '2026-10-30'), []);
  assert.equal(dividendsForLot({ code: 'X', date: '2025-06-29', shares: 100 }, divs, '2026-10-30').length, 1);

  // 空组合
  const empty = portfolioStats([], {}, {}, '2026-10-30');
  assert.equal(empty.totalCost, 0);
  assert.equal(empty.totalValue, 0);
  assert.equal(empty.totalRet, null);
  assert.equal(empty.xirr, null);
  assert.deepEqual(empty.byYear, []);
});

// 已修复回归: 交易缺 date / 非法日期曾让 portfolioStats 抛 TypeError（2026-11-01 Lead 修复）
// 修复：src/engine/portfolio.js buildLots 过滤掉无日期 / 非 YYYY-MM-DD / 非法日期的交易
//       （与 shares≤0、price≤0 同样处理）。
// 原复现：portfolioStats([{ code:'600036', side:'buy', shares:100, price:10 }], ...) → TypeError
// 现在期望：不抛错，脏交易被丢弃（lots 0、totalCost 0）
test('缺 date / 非法日期的交易会被过滤，portfolioStats 不崩（已修复回归）', () => {
  const txs = [{ code: '600036', side: 'buy', shares: 100, price: 10 }]; // 缺 date
  let out = null;
  assert.doesNotThrow(
    () => { out = portfolioStats(txs, { '600036': { p: 12 } }, {}, '2026-10-30'); },
    '缺 date 的脏交易应被过滤/跳过，而不是崩溃',
  );
  assert.equal(out.lots.length, 0, '缺 date 的交易应被丢弃');
  assert.equal(out.totalCost, 0);
  assert.equal(out.totalRet, null);
});

/* ============================ 9. finance / verdict / market 阈值边界 ============================ */

test('finance 边界：XIRR 一年 10%、无解 null、annualize/asRate 边界、夏普/回撤退化输入', () => {
  const r = xirr([{ date: '2020-01-01', amount: -1000 }, { date: '2021-01-01', amount: 1100 }]);
  assert.ok(Math.abs(r - 0.1) < 1e-3, `xirr 应≈10%，实际 ${r}`);
  assert.equal(xirr([{ date: '2020-01-01', amount: -100 }]), null, '单笔现金流无解');
  assert.equal(xirr([{ date: '2020-01-01', amount: -1000 }, { date: '2020-01-01', amount: 1100 }]), null, '同一天现金流无年化');
  assert.equal(xirr([{ date: '2020-01-01', amount: -1000 }, { date: '2021-01-01', amount: -100 }]), null, '同号现金流无解');

  assert.ok(Math.abs(annualize(0.1, 365.25) - 0.1) < 1e-9);
  assert.equal(annualize(0, 0), null, 'days<=0 → null');
  assert.equal(annualize(-1, 182.625), -1, '亏光 → -100%');
  assert.equal(annualize(-1.5, 182.625), -1, '超过 -100% 也应返回 -1 而不是 NaN');
  assert.equal(annualize(NaN, 182.625) === null || Number.isFinite(annualize(NaN, 182.625)), true, 'NaN 输入不得返回 NaN');

  // asRate 的契约：>1.5 视为百分数，否则视为小数（含 1.5 边界）
  assert.equal(asRate(0.05), 0.05);
  assert.equal(asRate(1.5), 1.5);
  assert.ok(Math.abs(asRate(1.51) - 0.0151) < 1e-12);
  assert.equal(asRate(5), 0.05);

  assert.equal(stdev([1]), null, '样本 <2 → null');
  assert.equal(sharpe([0.01, 0.01, 0.01]), null, '零波动 → null（不是 Infinity）');
  assert.equal(maxDrawdown([]).mdd, 0);
  assert.equal(maxDrawdown([1, 2, 3]).mdd, 0, '单调上涨无回撤');
  assert.deepEqual(navFromReturns([], 2), [2]);
  assert.deepEqual(monthlyReturns([{ date: '2020-01', value: 1 }]), []);
});

test('verdict 阈值边界：5% / 4% / 15% / 支付率 85% / 现金流覆盖 0.7 / 支付率 20%', () => {
  const healthy = (eps, ocfps, roe = 12) => [eps, roe, 10, 50, ocfps, 1e8];
  const fiveYears = (dps) => ({ years: { 2020: dps, 2021: dps, 2022: dps, 2023: dps, 2024: dps } });
  const fourYears = (dps) => ({ years: { 2021: dps, 2022: dps, 2023: dps, 2024: dps } });
  const ev = ({ dps, price = 10, div, fin }) => evaluate('A', {
    quotes: { A: { p: price, n: 'A' } },
    dividends: { A: div || fiveYears(dps) },
    finance: { A: fin || healthy(1, 1.2) },
  });

  // 股息率门槛：恰好 5% 且连续 5 年 → 可买；4.99% → 观察
  assert.equal(ev({ dps: 0.5 }).level, 'buy');
  assert.equal(ev({ dps: 0.5, price: 10.02 }).level, 'wait');
  // 股息率异常：恰好 15% 仍按正常规则（健康→可买），>15% 一律回避
  assert.equal(ev({ dps: 1.5, fin: healthy(2.0, 2.5) }).level, 'buy');
  assert.equal(ev({ dps: 1.51, fin: healthy(2.0, 2.5) }).level, 'avoid');
  // 支付率：恰好 85% → 回避；84.9% → 可买
  assert.equal(ev({ dps: 0.85 }).level, 'avoid');
  assert.equal(ev({ dps: 0.849 }).level, 'buy');
  // 现金流覆盖：恰好 0.7 → 通过；0.699 → 回避
  assert.equal(ev({ dps: 0.5, fin: healthy(1.0, 0.7) }).level, 'buy');
  assert.equal(ev({ dps: 0.5, fin: healthy(1.0, 0.699) }).level, 'avoid');
  // 支付率 <20% 回避：恰好 20% 不回避（落到观察）
  assert.equal(ev({ dps: 0.2 }).level, 'wait');
  assert.equal(ev({ dps: 0.199 }).level, 'avoid');
  // 连续分红边界：4 年（不足 5 年）+ 6% → 观察
  assert.equal(ev({ dps: 0.6, div: fourYears(0.6) }).level, 'wait');
  // 亏损 / 缺现金流 / 缺行情
  assert.equal(ev({ dps: 0.5, fin: healthy(0, 1.2) }).level, 'avoid');
  assert.equal(ev({ dps: 0.5, fin: healthy(1.0, null) }).level, 'missing');
  assert.equal(evaluate('A', { quotes: { A: {} }, dividends: { A: fiveYears(0.5) }, finance: { A: healthy(1, 1.2) } }).level, 'wait');
  assert.equal(evaluate('A', { quotes: { A: { p: 10 } }, dividends: {}, finance: {} }).level, 'missing');
});

test('market 阈值边界：qualityOf（eps/ROE/现金流覆盖）与 dyQuality', () => {
  const q = (row) => qualityOf({ X: [row] }, 'X', 2024);
  assert.deepEqual(q([2024, 1, 5, 0, 0, 0.7]), { ok: true, why: '' }, 'ROE=5、覆盖=0.7 都算过关');
  assert.equal(q([2024, 1, 4.9, 0, 0, 1]).why, 'ROE 偏低');
  assert.equal(q([2024, 0, 10, 0, 0, 1]).why, '亏损');
  assert.equal(q([2024, 1, 10, 0, 0, 0.69]).why, '现金流覆盖不足');
  assert.equal(q([2024, 1, 10, 0, 0, null]).ok, true, '缺现金流字段时不做覆盖否决');
  assert.equal(qualityOf({}, 'X', 2024).why, '缺财报');

  const good = dyQuality({ dividends: withEv({ X: { years: { 2024: 1 } } }), finHistory: { X: [[2024, 2, 10, 0, 0, 1.6]] }, code: 'X', year: 2025, price: 10 });
  assert.equal(good.dy, 10);
  assert.equal(good.payout, 50);
  assert.ok(Math.abs(good.cover - 0.8) < 1e-12);
  const none = dyQuality({ dividends: {}, finHistory: {}, code: 'X', year: 2025, price: 0 });
  assert.deepEqual(none, { dy: null, payout: null, cover: null });
});

/* ============================ 10. 已修复缺陷的补充回归（2026-11-01 Lead 修复） ============================ */

test('已修复回归：replay 模式 capital=0（lots+cash0 起算）stats.ret 为有限正数', () => {
  // 回归背景：收益率基准曾用参数 capital，replay 传 capital=0 时 end/capital-1 = Infinity；
  // 修复后 replay 以 nav[0]（lots 市值 + cash0）为基准，收益率有定义。
  const dates = ['2020-01-02', '2020-04-30', '2020-12-31'];
  const series = new Map([['A', { dates: ['2019-06-03', ...dates], closes: [10, 10, 10, 10] }]]);
  const r = runPortfolioBacktest({
    dates, series, dividends: {},
    holdings: [{ code: 'A', weight: 100 }],
    capital: 0, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'replay',
    lots: [{ code: 'A', shares: 10000 }], cash0: 100000,
  });
  assert.equal(r.nav[0][1], 200000, '期初净值 = 持仓市值 10 万 + 现金 10 万');
  assert.ok(Number.isFinite(r.stats.ret) && r.stats.ret > 0, `replay 收益率应为有限正数（现金利息），实际 ${r.stats.ret}`);
  assert.equal(r.stats.retR, r.stats.ret, '不复投口径同样基于 nav[0]；无分红时与 ret 相同');
  assert.ok(Number.isFinite(r.stats.cagr) && r.stats.cagr > 0, `cagr 应为有限正数，实际 ${r.stats.cagr}`);
});

test('已修复回归：交易日期在未来 → lotStats 年化为 null（days 仍 ≥1），不产生 1e28 级年化', () => {
  // 回归背景：未来日期的买入会让持有天数为负，被 Math.max(1,...) 兜成 1 天，
  // 年化变成 1e28 级天文数字；修复后 days 仍展示为 1，但 annualized 返回 null。
  const quotes = { 600036: { p: 12 } };
  const txs = [{ date: '2030-01-10', code: '600036', side: 'buy', shares: 100, price: 10 }];
  const { lots } = buildLots(txs);
  assert.equal(lots.length, 1, '日期格式合法，交易应保留');
  const s = lotStats(lots[0], quotes, {}, '2026-10-30');
  assert.equal(s.days, 1, 'days 仍按最少 1 天展示');
  assert.ok(Number.isFinite(s.ret), `收益率本身应有限，实际 ${s.ret}`);
  assert.equal(s.annualized, null, '未来日期买入的年化无意义 → null');

  const p = portfolioStats(txs, quotes, {}, '2026-10-30');
  assert.equal(p.lots.length, 1);
  assert.equal(p.lots[0].annualized, null);
  for (const lot of p.lots) {
    assert.ok(lot.annualized == null || Math.abs(lot.annualized) < 1e6, `不应出现 1e28 级年化，实际 ${lot.annualized}`);
  }
  assert.ok(Number.isFinite(p.totalRet), `totalRet 应有限，实际 ${p.totalRet}`);
});
