import test from 'node:test';
import assert from 'node:assert/strict';
import { db, divSummary, lastDps, currentDy, divIndexEntry } from '../src/data.js';

/** 每个用例重置全局 db（divIndex 按 baseline 对象身份自动重建，正好覆盖缓存失效逻辑） */
function setDivs(dividends, quotes = {}) {
  db.baseline = { pool: {}, dividends };
  db.quotes = quotes;
  db.quoteRev = 0;
}

test('divSummary：基本统计（年数 / 最近年度 / 首年 / 连续年数 / 最近 DPS）', () => {
  setDivs({
    '600036': { years: { 2019: 0.5, 2021: 0.6, 2022: 0.7 } },
  });
  const d = divSummary('600036');
  assert.ok(d);
  assert.equal(d.nYears, 3);
  assert.equal(d.firstY, 2019);
  assert.equal(d.lastY, 2022);
  assert.equal(d.dps, 0.7);
  // 2021、2022 连续；2020 缺 → 连续 2 年
  assert.equal(d.consecutive, 2);
});

test('divSummary：连续分红遇缺口即停（从最近年度往前数）', () => {
  setDivs({
    A: { years: { 2015: 0.1, 2016: 0.1, 2017: 0.1, 2018: 0.1, 2019: 0.1, 2020: 0, 2021: 0.1, 2022: 0.1, 2023: 0.1, 2024: 0.1 } },
    B: { years: { 2020: 0.2, 2021: 0.2, 2022: 0.2, 2023: 0.2, 2024: 0.2 } },
  });
  assert.equal(divSummary('A').consecutive, 4); // 2024,2023,2022,2021，2020 缺
  assert.equal(divSummary('B').consecutive, 5);
});

test('divSummary：连续年数上限（最近 31 个年度）', () => {
  const years = {};
  for (let y = 1990; y <= 2024; y++) years[y] = 0.1;
  setDivs({ LONG: { years } });
  const d = divSummary('LONG');
  assert.equal(d.nYears, 35);
  assert.equal(d.lastY, 2024);
  // 旧实现 for (y = last; y >= last - 30; y--) 最多数 31 年，保持同一口径
  assert.equal(d.consecutive, 31);
});

test('divSummary：0 / 负数 / NaN 不计入分红年，也不打断更早的记录截止', () => {
  setDivs({
    X: { years: { 2020: 0.3, 2021: 0, 2022: -1, 2023: NaN, 2024: 0.4 } },
  });
  const d = divSummary('X');
  assert.equal(d.nYears, 2);
  assert.equal(d.lastY, 2024);
  assert.equal(d.firstY, 2020);
  assert.equal(d.consecutive, 1); // 2024 之后往前是 2023=NaN → 停
});

test('divSummary：无有效分红的股票仍返回条目但 lastY 为 null', () => {
  setDivs({ EMPTY: { years: {} }, ZERO: { years: { 2024: 0 } } });
  const e = divSummary('EMPTY');
  assert.ok(e);
  assert.equal(e.nYears, 0);
  assert.equal(e.lastY, null);
  assert.equal(lastDps('EMPTY'), null);
  assert.equal(divSummary('ZERO').nYears, 0);
});

test('divSummary / lastDps / currentDy：不存在的代码返回 null', () => {
  setDivs({});
  assert.equal(divSummary('999999'), null);
  assert.equal(divIndexEntry('999999'), null);
  assert.equal(lastDps('999999'), null);
  assert.equal(currentDy('999999'), null);
});

test('lastDps / currentDy：用最新价重算股息率', () => {
  setDivs(
    { '600036': { years: { 2023: 0.4, 2024: 0.5 } } },
    { '600036': { n: '招商银行', p: 10, prev: 9.8, date: '2026-10-30' } },
  );
  assert.deepEqual(lastDps('600036'), { year: 2024, dps: 0.5 });
  assert.equal(currentDy('600036'), 5);
});

test('currentDy：无价格 / 价格 <= 0 / DPS 为 0 时返回 null', () => {
  setDivs(
    { A: { years: { 2024: 0.5 } }, B: { years: { 2024: 0.5 } }, C: { years: { 2024: 0 } } },
    { A: { p: 0 }, B: {}, C: { p: 10 } },
  );
  assert.equal(currentDy('A'), null);
  assert.equal(currentDy('B'), null);
  assert.equal(currentDy('C'), null);
});

test('divSummary：baseline 整体替换后缓存重建，返回新数据', () => {
  setDivs({ '600036': { years: { 2024: 0.5 } } });
  assert.equal(divSummary('600036').dps, 0.5);
  setDivs({ '600036': { years: { 2024: 0.8 } } });
  assert.equal(divSummary('600036').dps, 0.8);
  // 新增代码同样可见
  setDivs({ '600036': { years: { 2024: 0.8 } }, '601398': { years: { 2023: 0.3 } } });
  assert.equal(divSummary('601398').lastY, 2023);
});

test('divSummary：单次查询返回只读索引条目，多次查询结果一致', () => {
  setDivs({ '600036': { years: { 2023: 0.4, 2024: 0.5 } } });
  const a = divSummary('600036');
  const b = divSummary('600036');
  assert.equal(a.nYears, b.nYears);
  assert.equal(a.consecutive, b.consecutive);
  assert.equal(a.lastY, b.lastY);
  assert.deepEqual(a.years, b.years);
});
