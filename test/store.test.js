import test from 'node:test';
import assert from 'node:assert/strict';

/* 最小 localStorage mock：store.js 在 Node 里只依赖 localStorage 全局 */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const {
  loadTxs, saveTxs, addTx, removeTx, resetTxs, loadCash, saveCash,
  loadPlans, savePlans, loadWatch, saveWatch, isWatched, toggleWatch,
  loadSettings, saveSettings,
} = await import('../src/store.js');

function reset() {
  mem.clear();
}

test('loadTxs：首次加载写入演示交易，之后保持', () => {
  reset();
  const txs = loadTxs();
  assert.equal(txs.length, 7);
  assert.ok(txs.every((t) => t.date && t.code && t.shares > 0));
  assert.ok(mem.get('d3:txs'));
  assert.equal(loadTxs().length, 7);
});

test('loadTxs：非法 JSON 自动修复回默认演示数据并写回', () => {
  reset();
  mem.set('d3:txs', '{not json');
  const txs = loadTxs();
  assert.equal(txs.length, 7);
  assert.doesNotThrow(() => JSON.parse(mem.get('d3:txs')));
});

test('loadTxs：数组里混入非对象条目会被过滤并写回', () => {
  reset();
  const ok = { id: 'a', date: '2025-01-02', code: '600036', side: 'buy', shares: 100, price: 10, fee: 5 };
  mem.set('d3:txs', JSON.stringify([ok, null, 42, 'x']));
  const txs = loadTxs();
  assert.equal(txs.length, 1);
  assert.deepEqual(txs[0], ok);
  assert.equal(JSON.parse(mem.get('d3:txs')).length, 1);
});

test('loadTxs：不是数组时返回默认并写回数组', () => {
  reset();
  mem.set('d3:txs', JSON.stringify({ a: 1 }));
  const txs = loadTxs();
  assert.equal(txs.length, 7);
  assert.ok(Array.isArray(JSON.parse(mem.get('d3:txs'))));
});

test('addTx / removeTx / resetTxs 正常增删', () => {
  reset();
  const before = loadTxs().length;
  addTx({ date: '2025-06-01', code: '600036', side: 'buy', shares: 100, price: 10, fee: 5 });
  const after = loadTxs();
  assert.equal(after.length, before + 1);
  const last = after[after.length - 1];
  assert.ok(last.id);
  removeTx(last.id);
  assert.equal(loadTxs().length, before);
  resetTxs();
  assert.equal(loadTxs().length, 7);
});

test('loadCash：默认 20 万；非法/负数回退 20 万；超大值封顶 1e12', () => {
  reset();
  assert.equal(loadCash(), 200000);
  mem.set('d3:cash', 'abc');
  assert.equal(loadCash(), 200000);
  mem.set('d3:cash', '-100');
  assert.equal(loadCash(), 200000);
  mem.set('d3:cash', String(1e20));
  assert.equal(loadCash(), 1e12);
});

test('saveCash：负数归 0、超大封顶 1e12、NaN 归 0', () => {
  reset();
  assert.equal(saveCash(-5), 0);
  assert.equal(mem.get('d3:cash'), '0');
  assert.equal(saveCash(1e20), 1e12);
  assert.equal(saveCash('abc'), 0);
  assert.equal(saveCash(123456), 123456);
  assert.equal(loadCash(), 123456);
});

test('loadPlans：非法 JSON 自动修复为空数组', () => {
  reset();
  mem.set('d3:plans', 'oops');
  assert.deepEqual(loadPlans(), []);
  assert.equal(mem.get('d3:plans'), '[]');
});

test('loadPlans：坏条目被过滤，合法方案保留（含旧版字段补齐与权重压缩）', () => {
  reset();
  const plan = { id: 'p1', name: '测试', holdings: [{ code: '600036', weight: 80 }, { code: '601398', weight: 80 }] };
  mem.set('d3:plans', JSON.stringify([plan, null, { name: '没有id' }]));
  const list = loadPlans();
  assert.equal(list.length, 1);
  assert.equal(list[0].capital, 1000000);
  assert.equal(list[0].holdings.reduce((s, h) => s + h.weight, 0), 100);
  assert.equal(JSON.parse(mem.get('d3:plans')).length, 1);
});

test('loadPlans：本金超上限归一到 1e12', () => {
  reset();
  savePlans([{ id: 'p1', name: 'x', capital: 1e19, holdings: [{ code: '600036', weight: 100 }] }]);
  assert.equal(loadPlans()[0].capital, 1e12);
});

test('loadWatch：过滤非 6 位代码并写回；toggleWatch 往返', () => {
  reset();
  mem.set('d3:watch', JSON.stringify(['600036', 'abc', 123456, '600036']));
  assert.deepEqual(loadWatch(), ['600036']);
  assert.equal(JSON.parse(mem.get('d3:watch')).length, 1);
  assert.equal(isWatched('600036'), true);
  assert.equal(toggleWatch('600036'), false);
  assert.equal(isWatched('600036'), false);
  assert.equal(toggleWatch('601398'), true);
  assert.equal(isWatched('601398'), true);
  saveWatch(['601398', '601398']);
  assert.deepEqual(loadWatch(), ['601398']);
});

test('loadWatch：非法 JSON 自动修复为空数组', () => {
  reset();
  mem.set('d3:watch', 'bad');
  assert.deepEqual(loadWatch(), []);
  assert.equal(mem.get('d3:watch'), '[]');
});

test('loadSettings：默认月支出 4000；负数/超大/非数字归一到默认并写回', () => {
  reset();
  assert.deepEqual(loadSettings(), { expense: 4000 });
  mem.set('d3:settings', JSON.stringify({ expense: -500 }));
  assert.equal(loadSettings().expense, 4000);
  assert.equal(JSON.parse(mem.get('d3:settings')).expense, 4000);
  mem.set('d3:settings', JSON.stringify({ expense: 1e9 }));
  assert.equal(loadSettings().expense, 4000);
  mem.set('d3:settings', 'not-json');
  assert.equal(loadSettings().expense, 4000);
});

test('saveSettings：合并 patch，不清掉其它字段', () => {
  reset();
  saveSettings({ expense: 6000 });
  assert.deepEqual(loadSettings(), { expense: 6000 });
  saveSettings({ theme: 'light' });
  assert.deepEqual(loadSettings(), { expense: 6000, theme: 'light' });
});
