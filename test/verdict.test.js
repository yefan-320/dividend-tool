import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/engine/verdict.js';

const quotes = { A: { p: 10, n: '甲' }, B: { p: 20, n: '乙' } };
const years5 = (v) => ({ years: { 2020: v, 2021: v, 2022: v, 2023: v, 2024: v } });
const dividends = {
  A: years5(0.6),
  B: years5(1.0),
};
const finance = {
  A: [0.8, 12, 10, 50, 1.2, 1e8],  // eps .8 → payout 75%，ocf 1.5
  B: [2.0, 15, 10, 50, 0.8, 1e8],  // payout 50%，ocf 覆盖 0.4
};

test('无财报 → 数据不足', () => {
  const r = evaluate('C', { quotes: { C: { p: 10, n: '丙' } }, dividends: { C: { years: { 2024: 1 } } }, finance: {} });
  assert.equal(r.level, 'missing');
});

test('支付率 >=90% → 回避', () => {
  const r = evaluate('D', {
    quotes: { D: { p: 10, n: '丁' } },
    dividends: { D: { years: { 2024: 1.0 } } },
    finance: { D: [1.0, 10, 10, 50, 1.2, 1e8] }, // payout 100%
  });
  assert.equal(r.level, 'avoid');
  assert.match(r.reasons[0], /支付率/);
});

test('亏损 → 回避', () => {
  const r = evaluate('E', {
    quotes: { E: { p: 10, n: '戊' } },
    dividends: { E: { years: { 2024: 0.5 } } },
    finance: { E: [-0.2, -5, -10, 60, 0.1, -1e8] },
  });
  assert.equal(r.level, 'avoid');
  assert.match(r.reasons[0], /亏损/);
});

test('经营现金流覆盖不足 → 回避', () => {
  const r = evaluate('B', { quotes, dividends, finance });
  assert.equal(r.level, 'avoid');
  assert.match(r.reasons[0], /经营现金流/);
});

test('股息率 >15% → 回避（先核实）', () => {
  const r = evaluate('F', {
    quotes: { F: { p: 1, n: '己' } },
    dividends: { F: { years: { 2024: 0.2 } } }, // dy 20%
    finance: { F: [2.0, 8, 5, 60, 2.5, 1e8] },
  });
  assert.equal(r.level, 'avoid');
  assert.match(r.reasons[0], /异常/);
});

test('健康 + 股息率 >=5% → 可买', () => {
  const r = evaluate('A', { quotes, dividends, finance });
  assert.equal(r.level, 'buy');
  assert.match(r.reasons[0], /股息率 6.0%/);
  assert.ok(Math.abs(r.metrics.payout - 75) < 1e-9);
  assert.ok(Math.abs(r.metrics.ocfCover - 1.5) < 1e-9);
});

test('股息率 4–5% → 观察', () => {
  const r = evaluate('G', {
    quotes: { G: { p: 12, n: '庚' } },
    dividends: { G: { years: { 2020: 0.55, 2021: 0.55, 2022: 0.55, 2023: 0.55, 2024: 0.55 } } }, // dy 4.58%
    finance: { G: [0.8, 12, 10, 50, 1.2, 1e8] },
  });
  assert.equal(r.level, 'wait');
});
