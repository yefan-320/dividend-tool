import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotesText, alignDaily, maxQuoteDate, qqCode } from '../src/net.js';

test('qqCode：沪深代码 → 腾讯前缀', () => {
  assert.equal(qqCode('600036'), 'sh600036');
  assert.equal(qqCode('601398'), 'sh601398');
  assert.equal(qqCode('000333'), 'sz000333');
  assert.equal(qqCode('300750'), 'sz300750');
  assert.equal(qqCode('920001'), 'sh920001'); // 兜底
  assert.equal(qqCode('3888'), 'sz003888');
});

test('parseQuotesText：解析 qt.gtimg.cn 批量返回', () => {
  const line = (name, code, price, prev, time, pct) => {
    const a = ['1', name, code, String(price), String(prev)];
    while (a.length < 46) a.push('');
    a[30] = time; // 行情时间
    a[32] = String(pct); // 涨跌幅
    return `v_${code.startsWith('6') ? 'sh' : 'sz'}${code}="${a.join('~')}";`;
  };
  const text = [
    line('招商银行', '600036', 43.55, 42.94, '20261030161448', 1.42),
    line('美的集团', '000333', 81.1, 80.0, '20261030150000', 1.38),
    line('停牌股', '600999', 0.0, 10.0, '20261030090000', 0),
  ].join('\n');
  const out = parseQuotesText(text);
  assert.equal(out['600036'].n, '招商银行');
  assert.equal(out['600036'].p, 43.55);
  assert.equal(out['600036'].prev, 42.94);
  assert.equal(out['600036'].date, '2026-10-30');
  assert.equal(out['600036'].pct, 1.42);
  assert.equal(out['000333'].p, 81.1);
  assert.equal(out['600999'], undefined); // 停牌（价格 0）跳过
});

test('alignDaily：按交易日历对齐，停牌/未上市为 null', () => {
  const cal = ['2026-10-28', '2026-10-29', '2026-10-30'];
  const rows = [
    { d: '2026-10-28', o: 1, h: 1.1, l: 0.9, c: 1.0, v: 100 },
    { d: '2026-10-30', o: 1.1, h: 1.2, l: 1.05, c: 1.15, v: 200 },
  ];
  const a = alignDaily(rows, cal);
  assert.deepEqual(a.cal, cal);
  assert.equal(a.c[0], 1.0);
  assert.equal(a.c[1], null); // 停牌
  assert.equal(a.c[2], 1.15);
  assert.deepEqual(a.v, [100, null, 200]);
});

test('maxQuoteDate：取最大交易日期', () => {
  assert.equal(maxQuoteDate({ A: { date: '2026-10-29' }, B: { date: '2026-10-30' } }), '2026-10-30');
  assert.equal(maxQuoteDate({}), '');
  assert.equal(maxQuoteDate(null), '');
});
