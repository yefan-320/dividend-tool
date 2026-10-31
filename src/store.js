/**
 * 本地账本：买入记录存 localStorage，刷新不丢。
 * 记录结构 {id,date,code,side,shares,price,fee}
 */
import { quote, nameOf } from './data.js';
import { normalizePlan, makePlan } from './engine/plan.js';

const TX_KEY = 'd3:txs';
const CASH_KEY = 'd3:cash';

/** 演示组合：7 只不同时间买入，用来展示"买入时点不同 → 收益率不同" */
export function defaultTxs() {
  return [
    { id: 't1', date: '2023-06-15', code: '000333', side: 'buy', shares: 1000, price: 62.0, fee: 5 },
    { id: 't2', date: '2024-01-10', code: '600036', side: 'buy', shares: 2000, price: 30.5, fee: 5 },
    { id: 't3', date: '2024-08-20', code: '601318', side: 'buy', shares: 1000, price: 48.0, fee: 5 },
    { id: 't4', date: '2025-03-05', code: '600887', side: 'buy', shares: 2000, price: 27.8, fee: 5 },
    { id: 't5', date: '2025-09-12', code: '600941', side: 'buy', shares: 500, price: 105.0, fee: 5 },
    { id: 't6', date: '2026-02-18', code: '601398', side: 'buy', shares: 5000, price: 7.2, fee: 5 },
    { id: 't7', date: '2026-05-08', code: '600066', side: 'buy', shares: 1000, price: 26.5, fee: 5 },
  ];
}

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00'));

/** 单条交易归一化：脏字段（负股数/字符串价格/未来格式日期/非法代码）直接丢弃 */
function normalizeTx(t) {
  if (!t || typeof t !== 'object') return null;
  const date = String(t.date ?? '');
  const code = String(t.code ?? '');
  const shares = Number(t.shares);
  const price = Number(t.price);
  if (!isIsoDate(date) || !/^\d{6}$/.test(code) || !(shares > 0) || !(price > 0)) return null;
  const fee = Number(t.fee);
  return {
    id: typeof t.id === 'string' && t.id ? t.id : 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    date,
    code,
    side: t.side === 'sell' ? 'sell' : 'buy',
    shares,
    price,
    fee: Number.isFinite(fee) && fee >= 0 ? fee : 0,
    ...(t.name ? { name: String(t.name).slice(0, 20) } : {}),
  };
}

export function loadTxs() {
  const fallback = () => {
    const init = defaultTxs();
    try { localStorage.setItem(TX_KEY, JSON.stringify(init)); } catch (e) { /* 存储满/隐私模式 */ }
    return init;
  };
  try {
    const raw = localStorage.getItem(TX_KEY);
    if (raw === null) return fallback();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return fallback();
    const clean = arr.map(normalizeTx).filter(Boolean);
    // 脏数据自动修复回 localStorage（结构/字段级），避免用户以为看到的是自己的数据
    if (clean.length !== arr.length || JSON.stringify(clean) !== JSON.stringify(arr)) {
      try { localStorage.setItem(TX_KEY, JSON.stringify(clean)); } catch (e) { /* 存储满 */ }
    }
    return clean;
  } catch {
    return fallback();
  }
}

export function saveTxs(txs) {
  localStorage.setItem(TX_KEY, JSON.stringify(txs));
}

export function addTx(tx) {
  const txs = loadTxs();
  txs.push({ ...tx, id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) });
  saveTxs(txs);
  return txs;
}

export function removeTx(id) {
  const txs = loadTxs().filter((t) => t.id !== id);
  saveTxs(txs);
  return txs;
}

export function resetTxs() {
  const txs = defaultTxs();
  saveTxs(txs);
  return txs;
}

export function loadCash() {
  const raw = localStorage.getItem(CASH_KEY);
  if (raw !== null) {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) return Math.min(1e12, v);
  }
  localStorage.setItem(CASH_KEY, '200000');
  return 200000;
}

export function saveCash(v) {
  const n = Number(v);
  const safe = Number.isFinite(n) ? Math.min(1e12, Math.max(0, n)) : 0;
  localStorage.setItem(CASH_KEY, String(safe));
  return safe;
}

/** 把任意代码变成可读的交易行（给表单回显） */
export function describeTx(tx) {
  const q = quote(tx.code);
  return {
    ...tx,
    name: q?.n || nameOf(tx.code),
    priceNow: q?.p ?? null,
  };
}


/* ---------------- 组合方案（一套代码 + 目标权重 + 建仓节奏） ---------------- */
const PLAN_KEY = 'd3:plans';

export function loadPlans() {
  try {
    const raw = localStorage.getItem(PLAN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) { localStorage.setItem(PLAN_KEY, '[]'); return []; }
    const list = arr
      .filter((x) => x && typeof x === 'object')
      .map(normalizePlan)
      .filter((p) => p.id);
    // 坏条目 / 需要归一化的旧方案顺手写回，避免每次加载重复处理脏数据
    if (list.length !== arr.length || JSON.stringify(list) !== JSON.stringify(arr)) {
      try { localStorage.setItem(PLAN_KEY, JSON.stringify(list)); } catch (e) { /* 存储满 */ }
    }
    return list;
  } catch {
    try { localStorage.setItem(PLAN_KEY, '[]'); } catch (e) { /* 存储满/隐私模式 */ }
    return [];
  }
}

export function savePlans(list) {
  localStorage.setItem(PLAN_KEY, JSON.stringify((list || []).map(normalizePlan).filter((p) => p.id)));
}

/**
 * 保存方案：有 id 就更新，没有就新增。
 * 兼容旧签名 savePlan(name, holdings)。
 * @returns {object} 保存后的方案
 */
export function savePlan(planOrName, holdings) {
  const list = loadPlans();
  let plan;
  if (typeof planOrName === 'string') {
    plan = makePlan({ name: planOrName, holdings: holdings || [] });
  } else {
    plan = normalizePlan(planOrName);
    if (!plan.id) plan.id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  plan.updatedAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const i = list.findIndex((p) => p.id === plan.id);
  if (i >= 0) list[i] = plan; else list.push(plan);
  savePlans(list);
  return plan;
}

export function removePlan(id) {
  const list = loadPlans().filter((p) => p.id !== id);
  savePlans(list);
  return list;
}

/** 复制方案（名称加「副本」，序号递增，避免重名） */
export function duplicatePlan(id) {
  const list = loadPlans();
  const src = list.find((p) => p.id === id);
  if (!src) return null;
  const base = src.name.replace(/ · 副本\d*$/, '');
  let name = `${base} · 副本`;
  let n = 1;
  while (list.some((p) => p.name === name)) { n++; name = `${base} · 副本${n}`; }
  const copy = makePlan({ ...src, id: '', name: name.slice(0, 20) });
  copy.id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  list.push(copy);
  savePlans(list);
  return copy;
}

/* ---------------- 自选 ---------------- */
const WATCH_KEY = 'd3:watch';

export function loadWatch() {
  try {
    const arr = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    // 只保留字符串形式的 6 位代码并去重（数字 123456 之类旧脏数据会被清掉）
    const clean = Array.isArray(arr)
      ? [...new Set(arr.filter((c) => typeof c === 'string' && /^\d{6}$/.test(c)))]
      : [];
    if (!Array.isArray(arr) || clean.length !== arr.length) {
      try { localStorage.setItem(WATCH_KEY, JSON.stringify(clean)); } catch (e) { /* 存储满 */ }
    }
    return clean;
  } catch {
    try { localStorage.setItem(WATCH_KEY, '[]'); } catch (e) { /* 存储满/隐私模式 */ }
    return [];
  }
}

export function saveWatch(list) {
  localStorage.setItem(WATCH_KEY, JSON.stringify([...new Set(list)]));
}

export function isWatched(code) {
  return loadWatch().includes(code);
}

/** 切换自选 → 返回 true=已加入 / false=已移除 */
export function toggleWatch(code) {
  const list = loadWatch();
  const has = list.includes(code);
  saveWatch(has ? list.filter((c) => c !== code) : [...list, code]);
  return !has;
}

/* ---------------- 设置 ---------------- */
const SETTINGS_KEY = 'd3:settings';

export function loadSettings() {
  const def = { expense: 4000 };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...def };
    const j = JSON.parse(raw);
    const st = { ...def, ...(j && typeof j === 'object' ? j : {}) };
    // 旧版可能存过负数/超大月支出：读取时归一到合法区间并写回（100 元/月 – 1000 万元/月）
    const exp = Number(st.expense);
    st.expense = Number.isFinite(exp) && exp >= 100 && exp <= 1e7 ? Math.round(exp) : def.expense;
    if (st.expense !== exp) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(st)); } catch (e) { /* 存储满 */ }
    }
    return st;
  } catch {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(def)); } catch (e) { /* 存储满/隐私模式 */ }
    return { ...def };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
