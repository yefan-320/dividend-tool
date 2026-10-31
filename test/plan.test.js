import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEntry, normalizePlan, makePlan, planStockTotal, planCashPct, planStockAmount,
  equalWeights, normalizeToFull, roundWeights, relockToTotal, weightsFromAmounts, amountsFromWeights,
  entryLabel, entryDetail, stagedBudget, triggerPrice, lastDpsOf,
  estimatePlanDiv, planActionRows, DEFAULT_ENTRY,
} from '../src/engine/plan.js';

const quotes = {
  '600036': { n: '招商银行', p: 30 },
  '601398': { n: '工商银行', p: 6 },
  '000333': { n: '美的集团', p: 60 },
};
const dividends = {
  '600036': { years: { 2023: 1.5, 2024: 1.6 } },
  '601398': { years: { 2023: 0.3, 2024: 0.32 } },
  '000333': { years: { 2023: 2.4, 2024: 2.5 } },
};

/* ---------------- 归一化 ---------------- */

test('旧版方案（只有 name/holdings）能被补齐本金与建仓节奏', () => {
  const p = normalizePlan({ id: 'p1', name: '旧方案', holdings: [{ code: '600036', weight: 40 }, { code: '601398', weight: 35 }] });
  assert.equal(p.name, '旧方案');
  assert.equal(p.capital, 1000000);
  assert.deepEqual(p.entry, DEFAULT_ENTRY);
  assert.equal(p.holdings.length, 2);
  assert.equal(p.holdings[0].code, '600036');
});

test('方案归一化：去重合并、丢非法代码、超 100% 按比例压回', () => {
  const p = normalizePlan({
    name: ' 测试 ',
    holdings: [
      { code: '600036', weight: 60 },
      { code: '600036', weight: 20 },
      { code: 'abc', weight: 10 },
      { code: '601398', weight: 0 },
      { code: '000333', weight: '40' },
    ],
  });
  assert.equal(p.name, '测试');
  const byCode = Object.fromEntries(p.holdings.map((h) => [h.code, h.weight]));
  assert.equal(byCode['600036'], 66.67); // 80 × 100/120
  assert.equal(byCode['000333'], 33.33); // 40 × 100/120
  assert.ok(planStockTotal(p) <= 100);
});

test('建仓节奏归一化：模式、期数、门槛都有边界', () => {
  assert.deepEqual(normalizeEntry(undefined), DEFAULT_ENTRY);
  assert.deepEqual(normalizeEntry({ mode: 'xxx' }), DEFAULT_ENTRY);
  assert.equal(normalizeEntry({ mode: 'staged', months: 0 }).months, 1);
  assert.equal(normalizeEntry({ mode: 'staged', months: 999 }).months, 60);
  assert.equal(normalizeEntry({ mode: 'dip', minDy: -3 }).minDy, 0);
  assert.equal(normalizeEntry({ mode: 'dip', minDy: 88 }).minDy, 20);
  assert.equal(normalizeEntry({ mode: 'staged', months: '6' }).months, 6);
});

test('makePlan 会补 id，norm 后可直接保存', () => {
  const p = makePlan({ name: 'x' });
  assert.match(p.id, /^p/);
  assert.equal(planStockTotal(p), 0);
  assert.equal(planCashPct(p), 100);
});

/* ---------------- 结构与金额 ---------------- */

test('比例合计与现金：股票 85% → 现金 15%', () => {
  const p = normalizePlan({ capital: 2000000, holdings: [{ code: '600036', weight: 50 }, { code: '601398', weight: 35 }] });
  assert.equal(planStockTotal(p), 85);
  assert.equal(planCashPct(p), 15);
  assert.equal(planStockAmount(p), 1700000);
});

test('均分与归一化：合计恰好 100，且不丢股票', () => {
  const eq = equalWeights(['600036', '601398', '000333'], 100);
  assert.equal(eq.length, 3);
  assert.equal(Math.round(eq.reduce((s, h) => s + h.weight, 0) * 100) / 100, 100);
  const norm = normalizeToFull([{ code: 'a', weight: 2 }, { code: 'b', weight: 2 }]);
  assert.deepEqual(norm.map((h) => h.weight), [50, 50]);
});

test('金额 ⇄ 比例互换', () => {
  const p = normalizePlan({ capital: 1000000, holdings: [{ code: '600036', weight: 30 }, { code: '601398', weight: 20 }] });
  const amts = amountsFromWeights(p);
  assert.deepEqual(amts.map((a) => a.amount), [30, 20]); // 万元
  const back = weightsFromAmounts(amts.map((a) => ({ code: a.code, amount: a.amount * 10000 })), p.capital);
  assert.deepEqual(back.map((b) => b.weight), [30, 20]);
});

test('分批预算 = 股票部分 / 期数', () => {
  const p = normalizePlan({ capital: 1200000, holdings: [{ code: '600036', weight: 50 }, { code: '601398', weight: 50 }], entry: { mode: 'staged', months: 12 } });
  assert.equal(stagedBudget(p), 100000); // 120 万 × 100% / 12
  const once = { ...p, entry: { mode: 'once' } };
  assert.equal(stagedBudget(once), 1200000);
});

test('建仓文案与触发价', () => {
  assert.equal(entryLabel({ mode: 'once' }), '一次性建仓');
  assert.equal(entryLabel({ mode: 'staged', months: 12 }), '分批建仓 12 期');
  assert.equal(entryLabel({ mode: 'dip', minDy: 5.5 }), '股息率≥5.5% 才买');
  assert.ok(entryDetail({ mode: 'dip', minDy: 5.5 }).includes('5.5'));
  assert.equal(triggerPrice(0.5, 5), 10);
  assert.equal(triggerPrice(0, 5), null);
  assert.equal(triggerPrice(0.5, 0), null);
  assert.equal(lastDpsOf({ years: { 2022: 0.2, 2024: 0.4, 2023: 0 } }), 0.4);
});

/* ---------------- 分红估算 ---------------- */

test('方案分红估算：按目标金额 × 股息率', () => {
  const p = normalizePlan({
    capital: 1000000,
    holdings: [{ code: '600036', weight: 50 }, { code: '601398', weight: 50 }],
  });
  const est = estimatePlanDiv(p, quotes, dividends);
  // 600036: 50 万 / 30 × 1.6 = 26666.7；601398: 50 万 / 6 × 0.32 = 26666.7
  assert.ok(Math.abs(est.annualDiv - 53333.33) < 1);
  assert.ok(Math.abs(est.dyOnStock - 5.3333) < 0.01);
  assert.equal(est.missing, 0);
  assert.equal(est.rows.length, 2);
  assert.ok(Math.abs(est.rows[0].dy - 5.3333) < 0.01);
});

test('没有行情的股票：分红估算记 0 并计入 missing，不崩', () => {
  const p = normalizePlan({ capital: 100000, holdings: [{ code: '999999', weight: 100 }] });
  const est = estimatePlanDiv(p, quotes, dividends);
  assert.equal(est.annualDiv, 0);
  assert.equal(est.missing, 1);
});

/* ---------------- 执行清单 ---------------- */

test('执行清单：目标 − 当前 = 差额，按 100 股整手向下取整', () => {
  const plan = normalizePlan({
    capital: 1000000,
    holdings: [{ code: '600036', weight: 50 }, { code: '601398', weight: 50 }],
  });
  const positions = new Map([['600036', 10000]]); // 30 万，目标 50 万 → 买 6666 股 → 6600 股
  const act = planActionRows({ plan, positions, quotes, dividends });
  const cmb = act.rows.find((r) => r.code === '600036');
  assert.equal(cmb.target, 500000);
  assert.equal(cmb.current, 300000);
  assert.equal(cmb.delta, 200000);
  assert.equal(cmb.sugShares, 6600);
  assert.equal(cmb.sugSide, 'buy');
  const icbc = act.rows.find((r) => r.code === '601398');
  assert.equal(icbc.current, 0);
  assert.equal(icbc.sugShares, 83300); // 50 万 / 6 = 83333 股 → 向下取整手 83300
  assert.equal(act.summary.buyAmount, 700000);
  assert.equal(act.summary.sellAmount, 0);
  assert.equal(act.summary.targetStock, 1000000);
  assert.equal(act.summary.cashPlan, 0);
  assert.equal(act.summary.totalNow, 300000);
});

test('执行清单：超配给卖出建议，方案外持仓单独列出', () => {
  const plan = normalizePlan({ capital: 1000000, holdings: [{ code: '600036', weight: 50 }] });
  const positions = new Map([['600036', 20000], ['000333', 1000]]);
  const act = planActionRows({ plan, positions, quotes, dividends });
  const cmb = act.rows.find((r) => r.code === '600036');
  assert.equal(cmb.current, 600000);
  assert.equal(cmb.delta, -100000);
  assert.equal(cmb.sugShares, 3300); // 10 万 / 30 = 3333 股
  assert.equal(cmb.sugSide, 'sell');
  assert.equal(act.outside.length, 1);
  assert.equal(act.outside[0].code, '000333');
  assert.equal(act.outside[0].value, 60000);
  assert.equal(act.summary.sellAmount, 100000);
});

test('执行清单：股息率门槛模式下，没到门槛的标记未触发并给出触发价', () => {
  const plan = normalizePlan({
    capital: 100000,
    holdings: [{ code: '600036', weight: 100 }],
    entry: { mode: 'dip', minDy: 6 },
  });
  // 600036 现价 30，DPS 1.6 → 股息率 5.33% < 6%，触发价 = 1.6/0.06 = 26.67
  const act = planActionRows({ plan, positions: new Map(), quotes, dividends });
  const row = act.rows[0];
  assert.equal(row.triggered, false);
  assert.ok(Math.abs(row.triggerPrice - 26.6667) < 0.01);
  assert.ok(Math.abs(row.dy - 5.3333) < 0.01);
  assert.ok(row.gapToTrigger > 0);
  assert.equal(act.summary.entry.mode, 'dip');

  // 价格跌到 25 → 股息率 6.4% ≥ 6%，触发
  const low = planActionRows({ plan, positions: new Map(), quotes: { '600036': { p: 25 } }, dividends });
  assert.equal(low.rows[0].triggered, true);
});

test('执行清单：没有行情时不崩，建议为空', () => {
  const plan = normalizePlan({ capital: 100000, holdings: [{ code: '999999', weight: 100 }] });
  const act = planActionRows({ plan, positions: new Map([['999999', 100]]), quotes: {}, dividends: {} });
  assert.equal(act.rows[0].price, 0);
  assert.equal(act.rows[0].sugShares, 0);
  assert.equal(act.rows[0].dy, null);
});

test('权重保留 1 位小数，合计不会出现 100.1%', () => {
  const out = roundWeights([{ code: 'a', weight: 33.35 }, { code: 'b', weight: 33.35 }, { code: 'c', weight: 33.3 }], 1);
  assert.deepEqual(out.map((h) => h.weight), [33.4, 33.4, 33.3]);
  const relocked = relockToTotal([{ code: 'a', weight: 50 }, { code: 'b', weight: 50 }], 66.7, 1);
  assert.equal(Math.round(relocked.reduce((s, h) => s + h.weight, 0) * 10) / 10, 66.7);
  const eq = equalWeights(['600001', '600002', '600003', '600004', '600005', '600006', '600007'], 100);
  assert.equal(Math.round(eq.reduce((s, h) => s + h.weight, 0) * 10) / 10, 100);
});

test('执行清单：分批方案本轮买入不超过每期预算', () => {
  const plan = normalizePlan({
    capital: 1200000,
    holdings: [{ code: '600036', weight: 50 }, { code: '601398', weight: 50 }],
    entry: { mode: 'staged', months: 12 },
  });
  const full = planActionRows({ plan, positions: new Map(), quotes, dividends });
  assert.ok(full.summary.buyAmount > 1000000);
  const batch = planActionRows({ plan, positions: new Map(), quotes, dividends, buyCap: stagedBudget(plan) });
  const batchValue = batch.rows.filter((r) => r.sugSide === 'buy').reduce((s, r) => s + r.sugShares * r.price, 0);
  assert.ok(batchValue <= stagedBudget(plan), `本轮 ${batchValue} 应 ≤ ${stagedBudget(plan)}`);
  assert.ok(batchValue > stagedBudget(plan) * 0.9, '整手取整后不应剩太多');
});

test('执行清单：股息率门槛没触发时本轮建议为 0（不买）', () => {
  const plan = normalizePlan({
    capital: 100000,
    holdings: [{ code: '600036', weight: 100 }],
    entry: { mode: 'dip', minDy: 6 },
  });
  const act = planActionRows({ plan, positions: new Map(), quotes, dividends });
  assert.equal(act.rows[0].sugShares, 0);
  assert.equal(act.rows[0].sugSide, 'hold');
  assert.equal(act.rows[0].triggered, false);
});
