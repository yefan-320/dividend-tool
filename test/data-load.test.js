import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * data.js 数据层单测：用 fetch mock 覆盖
 *  1. loadCore 从 finance-core.json 载入并 hydrate 成统一的 6 槽数组；
 *  2. loadFinanceExtra 把净利率/负债率/净利润合并进来；
 *  3. 兼容旧数据：没有 finance-core 时回退 finance-current（6 槽原样）。
 * 这些路径此前只有浏览器端人工验证，没有单测兜底。
 */

const DATA = {
  'quotes.json': {
    generated: '2026-10-30',
    quotes: { '600036': { n: '招商银行', p: 43.55, prev: 42.9, date: '2026-10-30' } },
  },
  'baseline.json': {
    generated: '2026-10-30',
    source: 'test',
    pool: { '600036': { n: '招商银行', cap: 1000 } },
    dividends: { '600036': { years: { 2023: 1.9, 2024: 2.016 } } },
    f10: {},
    holdings: [],
  },
  'benchmark.json': { bench: { '2026-10': 100 } },
  'finance-core.json': { year: 2025, data: { '600036': [1.2, 15.68, 2.212] } },
  'finance-extra.json': { year: 2025, data: { '600036': [8.32, 63.0, 1243064876] } },
  'finance-current.json': { year: 2025, data: { '600036': [1.2, 15.68, 8.32, 63.0, 2.212, 1243064876] } },
};

function mockFetch(overrides = {}) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const name = String(url).split('/').pop().split('?')[0];
    const body = overrides[name] ?? DATA[name];
    if (!body) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return () => { globalThis.fetch = orig; };
}

// 注意：mock 必须保持到测试执行为止（node:test 的 test() 是注册后异步执行，不能在文件末尾 restore）
const restore = mockFetch();
void restore;
const { db, loadCore, loadFinanceExtra, finOf } = await import('../src/data.js');

test('loadCore：finance-core 载入并 hydrate 成 6 槽数组（nm/liab/np 先留空）', async () => {
  const d = await loadCore();
  assert.equal(d.ready, true);
  assert.equal(d.generated, '2026-10-30');
  assert.equal(d.finYear, 2025);
  assert.deepEqual(db.finance['600036'], [1.2, 15.68, null, null, 2.212, null]);
  const f = finOf('600036');
  assert.equal(f.eps, 1.2);
  assert.equal(f.roe, 15.68);
  assert.equal(f.ocfps, 2.212);
  assert.equal(f.year, 2025);
  assert.equal(db.financeExtraLoaded, false);
});

test('loadFinanceExtra：合并净利率 / 负债率 / 净利润（只加载一次）', async () => {
  await loadFinanceExtra();
  assert.equal(db.financeExtraLoaded, true);
  assert.deepEqual(db.finance['600036'], [1.2, 15.68, 8.32, 63.0, 2.212, 1243064876]);
  const f = finOf('600036');
  assert.equal(f.nm, 8.32);
  assert.equal(f.liab, 63.0);
  assert.equal(f.np, 1243064876);
  const before = db.finance['600036'];
  await loadFinanceExtra(); // 再调一次不应重复合并/报错
  assert.deepEqual(db.finance['600036'], before);
});

test('兼容旧数据：缺 finance-core 时回退 finance-current（6 槽原样）', async () => {
  db.ready = false;
  db.finance = {};
  db.finYear = null;
  db.financeExtraLoaded = false;
  const restoreOverride = mockFetch();
  // 让 finance-core 请求 404，触发 loadCore 里的 fallback
  globalThis.fetch = async (url) => {
    const name = String(url).split('/').pop().split('?')[0];
    if (name === 'finance-core.json') return { ok: false, status: 404, json: async () => ({}) };
    const body = DATA[name];
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    await loadCore();
    assert.deepEqual(db.finance['600036'], [1.2, 15.68, 8.32, 63.0, 2.212, 1243064876]);
    assert.equal(db.finYear, 2025);
  } finally {
    restoreOverride();
  }
});

test('loadCore 幂等：ready 后再次调用直接返回同一对象', async () => {
  const a = await loadCore();
  const b = await loadCore();
  assert.equal(a, b);
});

