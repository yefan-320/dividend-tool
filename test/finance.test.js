import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xirr, annualize, maxDrawdown, stdev, sharpe, navFromReturns } from '../src/engine/finance.js';

test('xirr: 一年 10% 收益', () => {
  const r = xirr([
    { date: '2020-01-01', amount: -1000 },
    { date: '2021-01-01', amount: 1100 },
  ]);
  assert.ok(Math.abs(r - 0.1) < 1e-3, `got ${r}`);
});

test('xirr: 两笔买入不同时间', () => {
  // 第一笔 1 年翻倍，第二笔半年 10%
  const r = xirr([
    { date: '2020-01-01', amount: -1000 },
    { date: '2021-01-01', amount: 2000 },
    { date: '2021-07-01', amount: -1000 },
    { date: '2022-01-01', amount: 1100 },
  ]);
  assert.ok(r > 0.3 && r < 1.2, `got ${r}`);
});

test('xirr: 无解返回 null', () => {
  assert.equal(xirr([{ date: '2020-01-01', amount: -100 }]), null);
});

test('annualize: 半年 5% → 年化约 10.25%', () => {
  const a = annualize(0.05, 182.625);
  assert.ok(Math.abs(a - 0.1025) < 0.001, `got ${a}`);
});

test('maxDrawdown: 峰谷位置正确', () => {
  const navs = [
    { ym: '2020-01', nav: 1 },
    { ym: '2020-02', nav: 1.2 },
    { ym: '2020-03', nav: 0.9 },
    { ym: '2020-04', nav: 1.3 },
  ];
  const r = maxDrawdown(navs);
  assert.equal(r.peakIdx, 1);
  assert.equal(r.troughIdx, 2);
  assert.ok(Math.abs(r.mdd - (0.9 / 1.2 - 1)) < 1e-9);
});

test('navFromReturns: 复利', () => {
  const navs = navFromReturns([0.1, -0.1]);
  assert.equal(navs.length, 3);
  assert.ok(Math.abs(navs[2] - 0.99) < 1e-9);
});

test('stdev/sharpe 可算', () => {
  const s = stdev([0.01, 0.02, 0.015]);
  assert.ok(s > 0);
  const sh = sharpe([0.01, 0.02, 0.015], 0, 12);
  assert.ok(sh > 0);
});
