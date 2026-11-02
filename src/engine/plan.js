/**
 * 组合方案（纯函数）：数据模型 + 归一化 + 目标金额 + 调仓清单。
 *
 * 一个方案 = 一套代码 + 目标权重 + 计划本金 + 建仓节奏：
 *   { id, name, capital, holdings:[{code,weight}], entry:{mode,months,minDy}, note, createdAt, updatedAt }
 *
 * 口径：
 *  - weight 是「占总资产的百分比」，合计 ≤ 100；股票合计 85 → 留 15% 现金（回测里就是现金仓位）
 *  - 建仓节奏只影响「资金进入市场的节奏」，不改变目标结构：
 *      once   起点一次买齐
 *      staged 把股票部分均分成 months 期，每月末买一期（摊平买点）
 *      dip    每次买入前看股息率，只有 ≥ minDy% 才买，否则留现金等
 *  - 本文件不碰 localStorage / DOM，方便单测。
 */

export const LOT = 100;                       // A 股一手 = 100 股
export const DEFAULT_CAPITAL = 1000000;       // 默认计划本金 100 万
export const ENTRY_MODES = ['once', 'staged', 'dip'];
export const DEFAULT_ENTRY = { mode: 'once', months: 12, minDy: 5.5 };
export const MAX_MONTHS = 60;

/** 本地日期（YYYY-MM-DD）：toISOString 是 UTC，晚上会差一天 */
function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const toNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round1 = (v) => Math.round(v * 10) / 10;

/* ---------------- 归一化 ---------------- */

export function normalizeEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  return {
    mode: ENTRY_MODES.includes(e.mode) ? e.mode : 'once',
    months: Math.round(clamp(toNum(e.months, DEFAULT_ENTRY.months), 1, MAX_MONTHS)) || DEFAULT_ENTRY.months,
    minDy: Math.round(clamp(toNum(e.minDy, DEFAULT_ENTRY.minDy), 0, 20) * 100) / 100,
  };
}

/**
 * 把任意来源（旧版 localStorage / 手写 JSON）的方案对象整理成统一结构。
 * 旧版方案只有 {id,name,holdings:[{code,weight}],createdAt}，会补上 capital/entry。
 */
export function normalizePlan(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const merged = new Map();
  for (const h of Array.isArray(r.holdings) ? r.holdings : []) {
    const code = String(h?.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) continue;
    const w = toNum(h?.weight, 0);
    if (!(w > 0)) continue;
    merged.set(code, (merged.get(code) || 0) + w);
  }
  let total = 0;
  for (const w of merged.values()) total += w;
  // 合计超过 100 时按比例压回 100（宁可改比例，也不让回测算出超配的现金负数）
  const scale = total > 100 ? 100 / total : 1;
  const holdings = [...merged.entries()]
    .map(([code, weight]) => ({ code, weight: Math.round(weight * scale * 100) / 100 }))
    .sort((a, b) => b.weight - a.weight);
  const name = String(r.name ?? '').trim().slice(0, 20) || '我的方案';
  const entry = normalizeEntry(r.entry);
  const created = typeof r.createdAt === 'string' && r.createdAt ? r.createdAt : localDate();
  return {
    id: String(r.id || ''),
    name,
    // 本金上限 1 万亿（与 UI 输入上限一致），防止备份/手写 JSON 传入 1e19
    capital: Math.min(1e12, Math.max(1000, Math.round(toNum(r.capital, DEFAULT_CAPITAL)))),
    holdings,
    entry,
    note: String(r.note ?? '').slice(0, 120),
    createdAt: created,
    updatedAt: typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : created,
  };
}

/** 新建一个空方案（不落盘） */
export function makePlan(partial = {}) {
  const base = normalizePlan({ ...partial, id: partial.id || '' });
  if (!base.id) base.id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  return base;
}

/* ---------------- 结构计算 ---------------- */

export function planStockTotal(plan) {
  return (plan?.holdings || []).reduce((s, h) => s + (Number(h.weight) || 0), 0);
}

export function planCashPct(plan) {
  return Math.max(0, round1(100 - planStockTotal(plan)));
}

/** 股票部分的目标金额（元） */
export function planStockAmount(plan) {
  const capital = Math.max(0, Number(plan?.capital) || 0);
  return capital * (planStockTotal(plan) / 100);
}

/** 每只股票的目标金额（元） */
/** 权重保留 1 位小数（够用且不会出现 100.1% 这种合计） */
export function roundWeights(holdings, decimals = 1) {
  const f = 10 ** decimals;
  return (holdings || []).map((h) => ({ code: h.code, weight: Math.round((Number(h.weight) || 0) * f) / f }));
}

/**
 * 把一组权重按相对比例缩放到指定合计，四舍五入的尾差补到最后一只。
 * @param {Array<{code:string,weight:number}>} holdings
 * @param {number} total 目标合计
 */
export function relockToTotal(holdings, total = 100, decimals = 1) {
  const list = (holdings || []).filter((h) => Number(h.weight) > 0);
  const sum = list.reduce((s, h) => s + (Number(h.weight) || 0), 0);
  if (!(sum > 0) || !(total > 0)) return [];
  const f = 10 ** decimals;
  const out = list.map((h) => ({ code: h.code, weight: Math.round(((Number(h.weight) || 0) / sum) * total * f) / f }));
  const diff = Math.round((total - out.reduce((s, h) => s + h.weight, 0)) * f) / f;
  if (diff) out[out.length - 1].weight = Math.round((out[out.length - 1].weight + diff) * f) / f;
  return out;
}

/** 按总权重均分 */
export function equalWeights(codes, total = 100) {
  const list = [...new Set((codes || []).filter((c) => /^\d{6}$/.test(String(c))))];
  if (!list.length) return [];
  return relockToTotal(list.map((code) => ({ code, weight: 1 })), total, 1);
}

/** 把权重整体缩放到合计 100（不改变相对比例） */
export function normalizeToFull(holdings) {
  return relockToTotal(holdings, 100, 1);
}

/** 从「每只金额（元）」换回权重（金额模式 ⇄ 比例模式） */
export function weightsFromAmounts(rows, capital) {
  const cap = Math.max(1, Number(capital) || 0);
  return (rows || []).map((r) => ({ code: r.code, weight: Math.round((toNum(r.amount, 0) / cap) * 1000) / 10 }));
}

/** 每只股票目标金额按万元显示（金额模式回显） */
export function amountsFromWeights(plan) {
  const cap = Math.max(0, Number(plan?.capital) || 0);
  return (plan?.holdings || []).map((h) => ({
    code: h.code,
    amount: Math.round((cap * (Number(h.weight) || 0) / 100) / 1000) / 10, // 万元，1 位小数
  }));
}

/* ---------------- 建仓节奏文案 ---------------- */

export function entryLabel(entry) {
  const e = normalizeEntry(entry);
  if (e.mode === 'staged') return `分批建仓 ${e.months} 期`;
  if (e.mode === 'dip') return `股息率≥${e.minDy}% 才买`;
  return '一次性建仓';
}

export function entryDetail(entry) {
  const e = normalizeEntry(entry);
  if (e.mode === 'staged') return `股票部分的本金均分成 ${e.months} 期，每月末买一期：摊平买点，短期少赚也少亏`;
  if (e.mode === 'dip') return `每次买入前先看股息率，≥ ${e.minDy}% 才买，不到就留现金等；分红与追加同样按这个门槛`;
  return '起点把股票部分一次买齐：假设「现在就是起点」，最接近满仓买入的对照';
}

/** 分批每期预算（元） */
export function stagedBudget(plan) {
  const e = normalizeEntry(plan?.entry);
  if (e.mode !== 'staged') return planStockAmount(plan);
  return planStockAmount(plan) / Math.max(1, e.months);
}

/** 目标股息率对应的买入价（元） */
export function triggerPrice(dps, minDy) {
  const d = toNum(dps, 0);
  const t = toNum(minDy, 0);
  if (!(d > 0) || !(t > 0)) return null;
  return d / (t / 100);
}

/** 最近一个年度每股分红（元） */
export function lastDpsOf(divEntry) {
  const years = divEntry?.years || {};
  const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
  return ys.length ? years[ys[ys.length - 1]] : null;
}

/* ---------------- 估算与执行清单 ---------------- */

/**
 * 方案的年分红 / 组合股息率估算（用最新价、最近年度每股分红）。
 * @param {object} plan
 * @param {object} quotes {code:{p,...}}
 * @param {object} dividends baseline.dividends
 */
export function estimatePlanDiv(plan, quotes = {}, dividends = {}) {
  const capital = Math.max(0, Number(plan?.capital) || 0);
  let annualDiv = 0;
  let missing = 0;
  const rows = (plan?.holdings || []).map((h) => {
    const price = toNum(quotes[h.code]?.p, 0);
    const dps = toNum(lastDpsOf(dividends[h.code]), 0);
    const amount = capital * (Number(h.weight) || 0) / 100;
    const div = price > 0 ? (amount / price) * dps : 0;
    if (!(price > 0)) missing++;
    annualDiv += div;
    return {
      code: h.code,
      weight: Number(h.weight) || 0,
      amount,
      price,
      dps,
      dy: price > 0 && dps > 0 ? (dps / price) * 100 : null,
      annualDiv: div,
    };
  });
  const stockAmount = planStockAmount(plan);
  return {
    annualDiv,
    /** 相对「投进股票的钱」的股息率 */
    dyOnStock: stockAmount > 0 ? (annualDiv / stockAmount) * 100 : null,
    /** 相对「计划本金」的股息率（相当于月覆盖的分母） */
    dyOnCapital: capital > 0 ? (annualDiv / capital) * 100 : null,
    rows,
    missing,
  };
}

/**
 * 执行清单：把「当前持仓」调整到「方案目标」。
 * @param {object} o
 * @param {object} o.plan
 * @param {Map<string,number>|object} o.positions 当前持股 {code: shares}
 * @param {object} o.quotes
 * @param {object} o.dividends
 * @returns {{rows:Array, outside:Array, summary:object}}
 */
export function planActionRows({ plan, positions = new Map(), quotes = {}, dividends = {}, buyCap = null }) {
  const posOf = (code) => {
    const shares = positions instanceof Map ? positions.get(code) : positions?.[code];
    return toNum(shares, 0);
  };
  const entry = normalizeEntry(plan?.entry);
  const rows = (plan?.holdings || []).map((h) => {
    const price = toNum(quotes[h.code]?.p, 0);
    const target = (Number(plan?.capital) || 0) * (Number(h.weight) || 0) / 100;
    const shares = posOf(h.code);
    const current = shares * price;
    const delta = target - current;
    const sugLots = price > 0 ? Math.floor(Math.abs(delta) / (price * LOT)) : 0;
    const sugShares = sugLots * LOT;
    const side = delta > 0.5 ? 'buy' : delta < -0.5 ? 'sell' : 'hold';
    const dps = toNum(lastDpsOf(dividends[h.code]), 0);
    const dy = price > 0 && dps > 0 ? (dps / price) * 100 : null;
    const trig = triggerPrice(dps, entry.minDy);
    const triggered = entry.mode === 'dip' ? dy != null && dy >= entry.minDy : true;
    return {
      code: h.code,
      weight: Number(h.weight) || 0,
      price,
      target,
      shares,
      current,
      delta,
      side,
      sugShares,
      sugSide: sugShares > 0 ? side : 'hold',
      dps,
      dy,
      triggerPrice: trig,
      triggered,
      /** 距触发价还有多少空间（%） */
      gapToTrigger: trig && price > 0 ? ((price - trig) / price) * 100 : null,
      weightNow: 0, // 由 summary 里的当前总资产回填
    };
  });

  // 方案外的现有持仓（不在目标结构里，单独提示，不当成错误）
  const known = new Set(rows.map((r) => r.code));
  const outside = [];
  const posCodes = positions instanceof Map ? [...positions.keys()] : Object.keys(positions || {});
  for (const code of posCodes) {
    if (known.has(code)) continue;
    const shares = posOf(code);
    if (!(shares > 0)) continue;
    const price = toNum(quotes[code]?.p, 0);
    outside.push({ code, shares, price, value: shares * price });
  }
  outside.sort((a, b) => b.value - a.value);

  const currentStock = rows.reduce((s, r) => s + r.current, 0);
  const targetStock = rows.reduce((s, r) => s + r.target, 0);
  // 用户实际总资产 = 持仓市值 + 账本现金（另加方案外持仓），算实际占比时用它
  const outsideValue = outside.reduce((s, r) => s + r.value, 0);
  const totalNow = currentStock + outsideValue;
  for (const r of rows) r.weightNow = totalNow > 0 ? (r.current / totalNow) * 100 : 0;

  const buyAmount = rows.filter((r) => r.delta > 0.5).reduce((s, r) => s + r.delta, 0);
  const sellAmount = rows.filter((r) => r.delta < -0.5).reduce((s, r) => s + -r.delta, 0);
  // 建仓节奏对「本轮买入」的约束：
  //  - dip：没到股息率门槛的股票本轮不买（建议 = 0，显示等触发）
  //  - staged：本轮最多买「每期预算」那么多，缺口按比例拆到各股
  if (entry.mode === 'dip') {
    for (const r of rows) {
      if (!r.triggered) { r.sugShares = 0; r.sugSide = 'hold'; }
    }
  }
  if (buyCap != null && buyCap > 0) {
    const buys = rows.filter((r) => r.sugSide === 'buy' && r.sugShares > 0 && r.price > 0);
    const wanted = buys.reduce((s, r) => s + r.delta, 0);
    if (wanted > buyCap * 1.0001) {
      const ratio = buyCap / wanted;
      for (const r of buys) {
        const n = Math.floor((r.delta * ratio) / r.price / LOT) * LOT;
        r.sugShares = n;
        r.sugSide = n > 0 ? 'buy' : 'hold';
      }
    }
  }
  const divEst = estimatePlanDiv(plan, quotes, dividends);
  return {
    rows,
    outside,
    summary: {
      capital: Number(plan?.capital) || 0,
      targetStock,
      cashPlan: Math.max(0, (Number(plan?.capital) || 0) - targetStock),
      currentStock,
      outsideValue,
      totalNow,
      buyAmount,
      sellAmount,
      annualDiv: divEst.annualDiv,
      dyOnStock: divEst.dyOnStock,
      dyOnCapital: divEst.dyOnCapital,
      stagedBudget: stagedBudget(plan),
      entry,
    },
  };
}
