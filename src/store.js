/**
 * 本地账本：买入记录存 localStorage，刷新不丢。
 * 记录结构 {id,date,code,side,shares,price,fee}
 */
import { quote, nameOf } from './data.js';

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

export function loadTxs() {
  try {
    const raw = localStorage.getItem(TX_KEY);
    if (raw === null) {
      const init = defaultTxs();
      localStorage.setItem(TX_KEY, JSON.stringify(init));
      return init;
    }
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return defaultTxs();
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
    if (Number.isFinite(v) && v >= 0) return v;
  }
  localStorage.setItem(CASH_KEY, '200000');
  return 200000;
}

export function saveCash(v) {
  localStorage.setItem(CASH_KEY, String(v));
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


/* ---------------- 组合方案（回测用：一组代码 + 目标权重） ---------------- */
const PLAN_KEY = 'd3:plans';

export function loadPlans() {
  try {
    const raw = localStorage.getItem(PLAN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function savePlans(list) {
  localStorage.setItem(PLAN_KEY, JSON.stringify(list));
}

export function savePlan(name, holdings) {
  const list = loadPlans();
  list.push({ id: 'p' + Date.now().toString(36), name, holdings, createdAt: new Date().toISOString().slice(0, 10) });
  savePlans(list);
  return list;
}

export function removePlan(id) {
  const list = loadPlans().filter((p) => p.id !== id);
  savePlans(list);
  return list;
}

/* ---------------- 自选 ---------------- */
const WATCH_KEY = 'd3:watch';

export function loadWatch() {
  try {
    const arr = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((c) => /^\d{6}$/.test(c)) : [];
  } catch {
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
    return { ...def, ...(j && typeof j === 'object' ? j : {}) };
  } catch {
    return { ...def };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
