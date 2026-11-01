/**
 * 组合回测引擎（纯函数，无 DOM）。
 *
 * 两种模式：
 *  - invest：把「本金」在起点按目标结构买入，持有到终点；每年 4 月末分红到账、分红复投，
 *            4/12 月末可月追加。对照口径 = 分红不复投（进现金）。
 *  - replay：按「当前持仓股数」从起点持有（假设自起点起就是这个组合），分红复投 / 不复投。
 *
 * 未上市股票（关键口径，2026-11 重写）：
 *  - 组合里有股票在回测起点还没上市时，它的目标份额「平均」摊给当时已上市的股票（资金不闲置）；
 *  - 该股票上市满 buildDelayMonths（默认 6）个月后，做一次结构再平衡：
 *    按目标权重重新分配，卖出超配的已上市股票，把它「初始份额 × 期间组合增长」的价值买回来；
 *    等价于：买入金额 = 初始本金 × 计划占比 × (组合股票市值 / 起点股票市值)。
 *  - 之后的分红复投继续按目标权重（含未建仓股票的份额摊给已上市股）。
 *
 * 建仓节奏（entry，只影响 invest；replay 忽略）：
 *  - once（默认）：起点按目标结构一次买齐（上面口径），与旧行为完全一致
 *  - staged：股票部分本金均分成 months 期（默认 12，clamp 1..60），起点投第 1 期，
 *            之后每个月末投 1 期、投满为止（每期预算 = capital × totalW% ÷ months）；
 *            每期只买不卖、按有效权重补缺口、100 股整手、剩余留现金；
 *            未投完的本金保留在现金里：分红复投 / 月追加 / 未上市再平衡只能花「现金 − 保留本金」，
 *            不能把预留本金提前买掉（只约束买入，不影响净值口径：现金也是账户资产，
 *            nav 仍 = 现金 + 持仓，nav[0] = capital）；
 *            满期后预留归零，末值≈本金。
 *  - dip：起点和每个月末检查「已知最近年度每股分红 ÷ 当日价」，≥ minDy%（默认 5.5）才买；
 *         已知 DPS 口径：4–12 月用 Y-1 年度，1–3 月用 Y-2 年度（Y-1 年度分红 Y 年 4 月末才到账）；
 *         触发后按目标权重（当前总资产 × w%）补到目标，只买不卖、100 股整手；
 *         不摊未上市份额、不做等权再平衡；分红复投 / 月追加同样受股息率门槛约束。
 *
 * 其他口径：
 *  - 价格不复权（日 K 2014-06 起，更早用月线月末），分红按年度现金到账
 *  - 现金年息 1.5%，日计
 *  - 不含税、不含佣金
 */
import { priceAt, prevDps, isMonthEnd, maxDrawdown, sharpeOf, xirr, annualize } from './market.js';

const DAY_RATE = 0.015 / 365;

function addMonths(dayStr, n) {
  const d = new Date(dayStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
}

function drawdownSeries(nav) {
  let peak = 0;
  const out = [];
  for (const [d, v] of nav) {
    if (v > peak) peak = v;
    out.push([d, peak > 0 ? (v / peak - 1) * 100 : 0]);
  }
  return out;
}

const ENTRY_MODES = ['once', 'staged', 'dip'];
const DEFAULT_ENTRY = { mode: 'once', months: 12, minDy: 5.5 };
const MAX_ENTRY_MONTHS = 60;

/**
 * 建仓节奏参数归一化（口径与 engine/plan.js 的 normalizeEntry 一致，避免 UI / 引擎两套数）：
 *  - mode 非法 → once
 *  - months clamp 1..60（默认 12）
 *  - minDy clamp 0..20（默认 5.5，两位小数）
 */
function normalizeEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const monthsRaw = Number(e.months);
  const minDyRaw = Number(e.minDy);
  const months = Math.min(MAX_ENTRY_MONTHS, Math.max(1, Math.round(Number.isFinite(monthsRaw) ? monthsRaw : DEFAULT_ENTRY.months)));
  const minDy = Math.min(20, Math.max(0, Math.round((Number.isFinite(minDyRaw) ? minDyRaw : DEFAULT_ENTRY.minDy) * 100) / 100));
  return { mode: ENTRY_MODES.includes(e.mode) ? e.mode : DEFAULT_ENTRY.mode, months, minDy };
}

/**
 * 目标结构归一化（引擎入口防御；UI 正常路径已由 plan.normalizePlan 处理）：
 *  - 合并重复代码（权重相加）——否则同一只股票会被买两次、持仓市值双计；
 *  - 丢弃空代码，非有限 / 负数权重按 0；
 *  - 权重合计 >100 时按比例缩到 100——否则 once 初始建仓现金会为负。
 * @returns {{holdings:Array<{code:string,weight:number}>, totalW:number}}
 */
function normalizeHoldings(holdings) {
  const map = new Map();
  for (const h of Array.isArray(holdings) ? holdings : []) {
    const code = h && h.code != null ? String(h.code).trim() : '';
    if (!code) continue;
    const w = Number(h.weight);
    const safe = Number.isFinite(w) && w > 0 ? w : 0;
    map.set(code, (map.get(code) || 0) + safe);
  }
  const list = [...map.entries()].map(([code, weight]) => ({ code, weight }));
  let totalW = list.reduce((a, h) => a + h.weight, 0);
  if (totalW > 100) {
    for (const h of list) h.weight = (h.weight / totalW) * 100;
    totalW = 100;
  }
  return { holdings: list, totalW };
}

/**
 * 基准同口径：同样本金 + 同样月追加买指数。
 * @returns {{rows:Array, cagr:number|null, end:number}}
 */
export function buildBenchmark({ dates, rows, capital, monthlyAdd, from, to, flows }) {
  const idx = new Map(rows);
  let first = null;
  for (const d of dates) {
    if (idx.has(d)) { first = d; break; }
  }
  if (!first) return null;
  const prices = [];
  let lastVal = null;
  for (const d of dates) {
    if (idx.has(d)) lastVal = idx.get(d);
    prices.push(lastVal);
  }
  const p0 = prices[0];
  if (!(p0 > 0)) return null;
  let units = capital / p0;
  const flowsOut = [[dates[0], -capital]];
  const out = [[dates[0], capital]];
  // 指数点位脏数据（<=0）时沿用上一个有效点位，而不是回落到初始本金
  let lastP = p0;
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i];
    const p = prices[i];
    if (p > 0) lastP = p;
    const useP = p > 0 ? p : lastP;
    const monthEnd = isMonthEnd(dates, i);
    const mm = d.slice(5, 7);
    if (monthlyAdd > 0 && monthEnd && (mm === '04' || mm === '12')) {
      const amt = monthlyAdd * 6;
      units += amt / useP;
      flowsOut.push([d, amt]);
    }
    out.push([d, units * useP]);
  }
  const end = out[out.length - 1][1];
  const cagr = flows
    ? xirr(flowsOut.concat([[dates[dates.length - 1], end]]))
    : annualize(end / capital - 1, from, to);
  return { rows: out, end, cagr };
}

/**
 * @param {object} o
 * @param {string[]} o.dates 交易日历
 * @param {Map<string,{dates:string[],closes:number[]}>} o.series 各股价格序列
 * @param {object} o.dividends baseline.dividends
 * @param {Array<{code:string,weight:number}>} o.holdings 目标结构（weight 为百分比，合计 ≤100）
 * @param {number} o.capital 本金（元）
 * @param {number} o.monthlyAdd 月追加（元）
 * @param {string} o.from
 * @param {string} o.to
 * @param {'invest'|'replay'} o.mode
 * @param {Array} [o.lots] replay 模式：当前持仓 [{code,shares}]
 * @param {number} [o.cash0] replay 模式：期初现金
 * @param {number} [o.buildDelayMonths=6] 上市后多久建仓（月）
 * @param {Array} [o.benchmarkSeries] 基准指数 [[date,value]]
 * @param {Array} [o.lowVolSeries] 低波指数 [[date,value]]
 * @param {object} [o.entry] 建仓节奏 {mode:'once'|'staged'|'dip', months, minDy}（只影响 invest）
 * @returns 原有字段不变；新增 entry：{mode, months, minDy, installments, triggered, neverTriggered}
 */
export function runPortfolioBacktest(o) {
  const {
    dates, series, dividends = {}, holdings = [], capital = 1000000, monthlyAdd = 0,
    from, to, mode = 'invest', lots = [], cash0 = 0,
    benchmarkSeries = null, lowVolSeries = null, buildDelayMonths = 6, entry = null,
  } = o;
  const entryIn = normalizeEntry(entry);
  const norm = normalizeHoldings(holdings);
  const codes = norm.holdings.map((h) => h.code);
  const wOf = new Map(norm.holdings.map((h) => [h.code, h.weight]));
  const totalW = norm.totalW;
  const cashPct = Math.max(0, 100 - totalW);
  const px = (code, date) => priceAt(series.get(code), date);
  const flowing = monthlyAdd > 0;

  const bench = benchmarkSeries
    ? buildBenchmark({ dates, rows: benchmarkSeries, capital, monthlyAdd, from, to, flows: flowing })
    : null;
  const lowVol = lowVolSeries
    ? buildBenchmark({ dates, rows: lowVolSeries, capital, monthlyAdd, from, to, flows: flowing })
    : null;

  const result = mode === 'replay'
    ? runReplay({ codes, wOf, dates, series, dividends, lots, cash0, capital, monthlyAdd, from, to })
    : runInvest({ codes, wOf, totalW, cashPct, dates, series, dividends, capital, monthlyAdd, from, to, buildDelayMonths, entry: entryIn });
  // replay 忽略 entry，但仍回一份归一化结果（分期/触发为空），前端不用判空
  const entryOut = result.entry || { ...entryIn, installments: [], triggered: {}, neverTriggered: [] };

  const end = result.nav.length ? result.nav[result.nav.length - 1][1] : capital;
  const endR = result.navR.length ? result.navR[result.navR.length - 1][1] : capital;
  const totalIn = capital + result.yearly.reduce((s, x) => s + (x.invest || 0), 0);
  const totalDiv = Object.values(result.divByY).reduce((s, x) => s + x, 0);
  const dd = drawdownSeries(result.nav);
  const ddR = drawdownSeries(result.navR);
  const ddStat = maxDrawdown(result.nav);
  const hasAdd = totalIn > capital;
  const flowsN = result.flowsN;
  const flowsR = result.flowsR;
  // 收益率基准：投入回测 = 本金；持仓回放 = 期初净值（replay 用 lots + cash0 起算，capital 只是 UI 参数）
  const nav0 = result.nav.length ? result.nav[0][1] : capital;
  const base = mode === 'replay' ? nav0 : capital;
  // base=0 时收益率无定义：返回 null（页面显示「—」），不产生 NaN / Infinity
  const ret = base > 0 ? end / base - 1 : null;
  const retR = base > 0 ? endR / base - 1 : null;
  const cagr = hasAdd
    ? xirr(flowsN.concat([[result.nav[result.nav.length - 1][0], end]]))
    : (ret == null ? null : annualize(ret, from, to));
  const cagrR = hasAdd
    ? xirr(flowsR.concat([[result.navR[result.navR.length - 1][0], endR]]))
    : (retR == null ? null : annualize(retR, from, to));
  const benchStat = bench ? maxDrawdown(bench.rows) : null;

  return {
    mode, from, to, dates,
    nav: result.nav, navR: result.navR, dd, ddR,
    comp: result.comp, events: result.events, divByY: result.divByY, divByCode: result.divByCode,
    yearly: result.yearly, builds: result.builds, pending: result.pending,
    entry: entryOut,
    totalDiv, totalIn, end, endR, cashEnd: result.cashEnd,
    stats: {
      ret,
      retR,
      retFund: totalIn > 0 ? end / totalIn - 1 : null,
      cagr,
      cagrR,
      mdd: ddStat.mdd,
      mddPeak: ddStat.mddPeak,
      mddTrough: ddStat.mddTrough,
      sharpe: sharpeOf(result.nav),
      years: daysBetween(from, to) / 365.25,
      benchCagr: bench ? bench.cagr : null,
      benchEnd: bench ? bench.end : null,
      benchMdd: benchStat ? benchStat.mdd : null,
      lowVolCagr: lowVol ? lowVol.cagr : null,
      lowVolEnd: lowVol ? lowVol.end : null,
      excess: bench && cagr != null && bench.cagr != null ? cagr - bench.cagr : null,
    },
    bench, lowVol,
  };
}

/* ============================ 投入模型 ============================ */

function runInvest({ codes, wOf, totalW, cashPct, dates, series, dividends, capital, monthlyAdd, from, to, buildDelayMonths, entry }) {
  const e = entry || normalizeEntry(null);
  const isStaged = e.mode === 'staged';
  const isDip = e.mode === 'dip';
  const months = Math.max(1, e.months);
  const stockCapital = capital * (totalW / 100);      // 股票部分的目标本金
  const perPeriod = isStaged ? stockCapital / months : 0; // staged：每期预算
  const designatedCash = isStaged ? capital * (cashPct / 100) : 0; // 计划里本来就留的现金（不参与复投）
  const active = codes.filter((c) => (wOf.get(c) || 0) > 0);
  const px = (code, date) => priceAt(series.get(code), date);
  const listingOf = new Map();
  const buildAt = new Map();
  for (const c of active) {
    const s = series.get(c);
    const d0 = s && s.dates.length ? s.dates[0] : null;
    listingOf.set(c, d0);
    buildAt.set(c, d0 ? addMonths(d0, buildDelayMonths) : null);
  }
  const buildable = (c, date) => {
    const b = buildAt.get(c);
    return !!b && date >= b && px(c, date) > 0;
  };

  const sh = new Map(active.map((c) => [c, 0]));
  const shR = new Map(active.map((c) => [c, 0]));
  let cash = capital;
  let cashR = capital;
  const events = [];
  const builds = [];
  const divByY = {};
  const divByCode = {};
  const yearly = [];
  const flowsN = [[dates[0], -capital]];
  const flowsR = [[dates[0], -capital]];
  const nav = [];
  const navR = [];
  const comp = [];

  /* ---------------- 建仓节奏状态 ---------------- */
  // entry 返回值：只新增字段，原有字段不变
  const entryOut = { mode: e.mode, months: e.months, minDy: e.minDy, installments: [], triggered: {}, neverTriggered: [] };
  let stagedDone = 0;          // 已投期数（起点算第 1 期）
  let reserved = isStaged ? stockCapital : 0; // 还没投、必须留在现金里的本金
  const dipTriggered = new Map(); // dip：code → 首次满足股息率门槛的日期
  let dipPrincipalR = isDip ? capital : 0; // 不复投口径：dip 只用本金买、分红不参与

  const stockValue = (date) => {
    let v = 0;
    for (const c of active) {
      const n = sh.get(c) || 0;
      if (n <= 0) continue;
      const p = px(c, date);
      if (p > 0) v += n * p;
    }
    return v;
  };
  const stockValueR = (date) => {
    let v = 0;
    for (const c of active) {
      const n = shR.get(c) || 0;
      if (n <= 0) continue;
      const p = px(c, date);
      if (p > 0) v += n * p;
    }
    return v;
  };

  /** 有效权重：未建仓股票的目标份额，平均摊给当前可买的股票 */
  const effWeights = (list) => {
    const set = new Set(list);
    let unbuildW = 0;
    for (const c of active) if (!set.has(c)) unbuildW += wOf.get(c) || 0;
    const n = list.length;
    const m = new Map();
    for (const c of list) m.set(c, (wOf.get(c) || 0) + (n ? unbuildW / n : 0));
    return m;
  };

  /**
   * 结构再平衡：把股票部分调回目标权重。
   * @param {object} opt {useCash:boolean, buildFor:Set, reserve:number, whySell:string, whyBuy:string}
   *   reserve：不能动的现金（staged 未投完本金），买入只能花「现金 − reserve」
   */
  const rebalance = (date, list, opt) => {
    if (!list.length || totalW <= 0) return;
    const eff = effWeights(list);
    const prices = new Map();
    for (const c of list) prices.set(c, px(c, date) || 0);
    let stock = 0;
    for (const c of list) stock += (sh.get(c) || 0) * (prices.get(c) || 0);
    const T = opt.useCash ? cash + stock : stock;
    const stockTarget = T * (totalW / 100);
    // 1) 卖出超配
    for (const c of list) {
      const p = prices.get(c) || 0;
      if (!(p > 0)) continue;
      const target = stockTarget * eff.get(c) / totalW;
      const cur = (sh.get(c) || 0) * p;
      if (cur > target + p * 100) {
        const n = Math.floor((cur - target) / p / 100) * 100;
        if (n > 0) {
          sh.set(c, sh.get(c) - n);
          cash += n * p;
          events.push({ date, type: '卖出', code: c, shares: n, price: p, why: opt.whySell });
        }
      }
    }
    // 2) 买入低配（缺口大的先买）；分批模式下只能花「现金 − 未投本金」
    const gaps = [];
    for (const c of list) {
      const p = prices.get(c) || 0;
      if (!(p > 0)) continue;
      const target = stockTarget * eff.get(c) / totalW;
      const cur = (sh.get(c) || 0) * p;
      if (target - cur > 0) gaps.push({ c, p, gap: target - cur });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    for (const g of gaps) {
      const avail = opt.reserve > 0 ? Math.max(0, cash - opt.reserve) : cash;
      const n = Math.floor(Math.min(avail, g.gap) / g.p / 100) * 100;
      if (n <= 0) continue;
      sh.set(g.c, (sh.get(g.c) || 0) + n);
      cash -= n * g.p;
      const isBuild = opt.buildFor && opt.buildFor.has(g.c);
      events.push({ date, type: '买入', code: g.c, shares: n, price: g.p, why: isBuild ? opt.whyBuy : '结构再平衡' });
    }
  };

  /** 分红复投 / 月追加后的买入：只买不卖，按有效权重补缺口 */
  const investCash = (date) => {
    const list = active.filter((c) => buildable(c, date));
    if (!list.length || totalW <= 0) return;
    const eff = effWeights(list);
    let stock = 0;
    for (const c of list) stock += (sh.get(c) || 0) * (px(c, date) || 0);
    const T = cash + stock;
    const stockTarget = T * (totalW / 100);
    const gaps = [];
    for (const c of list) {
      const p = px(c, date) || 0;
      if (!(p > 0)) continue;
      const target = stockTarget * eff.get(c) / totalW;
      const cur = (sh.get(c) || 0) * p;
      if (target - cur > 0) gaps.push({ c, p, gap: target - cur });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    for (const g of gaps) {
      const n = Math.floor(Math.min(cash, g.gap) / g.p / 100) * 100;
      if (n <= 0) continue;
      sh.set(g.c, (sh.get(g.c) || 0) + n);
      cash -= n * g.p;
      events.push({ date, type: '买入', code: g.c, shares: n, price: g.p, why: '分红复投' });
    }
  };

  /* ---------------- 分批建仓（staged） ---------------- */

  /**
   * 分批建仓 / 分红复投的一期买入：把预算 budget 按「有效权重」补到目标 base（元）。
   * base 的取法：
   *  - 分期建仓：base = 当前持仓市值 + 本期预算（这期钱投进去后持仓该有的样子）→ 每期只补缺口；
   *  - 分红复投：base = 当前持仓市值 + 可复投现金 × 目标股票比例（保持现金仓位不变）。
   * 未上市股票的份额按现有规则摊给当时可买的股票（同一套 effWeights）。
   * 只买不卖、100 股整手、剩余留现金。
   * @param {Map<string,number>} shares 持仓股数（sh 或 shR）
   * @param {number} budget 最多花多少现金
   * @param {number} base 目标持仓市值（元）
   * @param {string} why 事件原因
   * @param {boolean} record 是否记 events / 建仓流水
   * @returns {number} 实际花费
   */
  const stagedBuyTo = (date, shares, budget, base, why, record) => {
    if (!(budget > 0) || totalW <= 0) return 0;
    const list = active.filter((c) => buildable(c, date));
    if (!list.length) return 0;
    const eff = effWeights(list);
    const gaps = [];
    for (const c of list) {
      const p = px(c, date) || 0;
      if (!(p > 0)) continue;
      const target = base * (eff.get(c) || 0) / totalW;
      const cur = (shares.get(c) || 0) * p;
      if (target - cur > 0) gaps.push({ c, p, gap: target - cur });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    let left = budget;
    let spent = 0;
    for (const g of gaps) {
      const n = Math.floor(Math.min(left, g.gap) / g.p / 100) * 100;
      if (n <= 0) continue;
      shares.set(g.c, (shares.get(g.c) || 0) + n);
      const cost = n * g.p;
      spent += cost;
      left -= cost;
      if (record) events.push({ date, type: '买入', code: g.c, shares: n, price: g.p, why });
    }
    return spent;
  };

  /* ---------------- 股息率触发（dip） ---------------- */

  /**
   * 已知最近年度每股分红（元/股）：
   * Y-1 年度分红 Y 年 4 月末才到账，所以 Y 年 1–3 月只能看 Y-2 年度，4–12 月看 Y-1 年度。
   */
  const knownDps = (code, date) => {
    const years = dividends?.[code]?.years;
    if (!years) return 0;
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    const v = years[m >= 4 ? y - 1 : y - 2];
    return v > 0 ? v : 0;
  };

  /**
   * 股息率触发的买入：只有「已知 DPS ÷ 当日价 × 100 ≥ minDy」才买，
   * 按目标权重（当前总资产 × w%）补到目标，只买不卖、100 股整手；
   * 没触发（含无分红历史）的股票一直留现金。
   * 不摊未上市份额、不做等权再平衡（与 once/staged 的口径不同）。
   * @param {Map<string,number>} shares 持仓股数（sh 或 shR）
   * @param {number} cashNow 当前现金
   * @param {object} [opt] {record:boolean 记录触发/事件, budget:number 最多花多少（不复投口径只用本金）}
   * @returns {{cash:number, spent:number}}
   */
  const dipBuyTo = (date, shares, cashNow, opt = {}) => {
    const record = opt.record !== false;
    const budget = opt.budget == null ? Infinity : opt.budget;
    let cashLeft = cashNow;
    let spent = 0;
    if (totalW <= 0) return { cash: cashLeft, spent };
    let stock = 0;
    for (const c of active) {
      const n = shares.get(c) || 0;
      if (n <= 0) continue;
      const p = px(c, date);
      if (p > 0) stock += n * p;
    }
    const T = cashLeft + stock; // 目标 = 当前总资产 × w/100
    const gaps = [];
    for (const c of active) {
      const p = px(c, date) || 0;
      if (!(p > 0)) continue;
      const dps = knownDps(c, date);
      if (!(dps > 0)) continue;
      const dy = (dps / p) * 100;
      if (!(dy >= e.minDy)) continue;
      // 触发口径：股息率达到门槛（哪怕整手取整后买不到也算触发）
      if (record && !dipTriggered.has(c)) dipTriggered.set(c, date);
      const target = T * (wOf.get(c) || 0) / 100;
      const cur = (shares.get(c) || 0) * p;
      if (target - cur > 0) gaps.push({ c, p, dy, gap: target - cur });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    for (const g of gaps) {
      const room = Math.min(cashLeft, Math.max(0, budget - spent), g.gap);
      const n = Math.floor(room / g.p / 100) * 100;
      if (n <= 0) continue;
      shares.set(g.c, (shares.get(g.c) || 0) + n);
      const cost = n * g.p;
      cashLeft -= cost;
      spent += cost;
      if (record) events.push({ date, type: '买入', code: g.c, shares: n, price: g.p, why: `股息率 ${g.dy.toFixed(1)}% ≥ ${e.minDy}% 建仓` });
    }
    return { cash: cashLeft, spent };
  };

  // 起点：可买集合（上市满 delay 的股票）；未上市份额摊给它们
  let built = active.filter((c) => buildable(c, dates[0]));
  // 初始建仓：once 一次买齐；staged 只投第 1 期；dip 起点按股息率门槛判断
  if (isStaged) {
    stagedDone = 1;
    reserved = perPeriod * (months - 1); // 剩下 months-1 期的本金必须留着
    if (perPeriod > 0) {
      const budget = Math.min(perPeriod, Math.max(0, cash - reserved));
      const spent = stagedBuyTo(dates[0], sh, budget, stockValue(dates[0]) + budget, `分批建仓 1/${months} 期`, true);
      cash -= spent;
      entryOut.installments.push({ date: dates[0], amount: spent });
      // 不复投口径：同样的期数/预算，但分红不进股票（与 once 的初始建仓口径一致）
      const spentR = stagedBuyTo(dates[0], shR, budget, stockValueR(dates[0]) + budget, `分批建仓 1/${months} 期`, false);
      cashR -= spentR;
    }
  } else if (isDip) {
    // dip：起点先按门槛试一次
    const n0 = dipBuyTo(dates[0], sh, cash);
    cash = n0.cash;
    const r0 = dipBuyTo(dates[0], shR, cashR, { record: false, budget: dipPrincipalR });
    cashR = r0.cash;
    dipPrincipalR -= r0.spent;
  } else if (built.length) {
    const eff = effWeights(built);
    const T = capital;
    const stockTarget = T * (totalW / 100);
    const gaps = [];
    for (const c of built) {
      const p = px(c, dates[0]) || 0;
      if (!(p > 0)) continue;
      const target = stockTarget * eff.get(c) / totalW;
      const n = Math.floor(target / p / 100) * 100;
      if (n > 0) {
        sh.set(c, n);
        shR.set(c, n);
        events.push({ date: dates[0], type: '买入', code: c, shares: n, price: p, why: '初始建仓' });
        gaps.push(n * p);
      }
    }
    // 权重已在入口归一化（合计 ≤100），整手向下取整后不会超过本金；Math.max 兜底浮点误差
    cash = Math.max(0, capital - gaps.reduce((a, b) => a + b, 0));
    cashR = cash;
  }

  let lastYear = null;
  let yearNav0 = capital;
  let yearDiv = 0;
  let yearAdds = 0;
  let yearCash = null;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEndDay = isMonthEnd(dates, i);
    const isAprEnd = monthEndDay && date.slice(5, 7) === '04';
    const isDecEnd = monthEndDay && date.slice(5, 7) === '12';

    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1]?.[1] ?? null, div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
      yearNav0 = nav[i - 1]?.[1] ?? yearNav0;
      yearDiv = 0;
      yearAdds = 0;
    }
    lastYear = y;

    if (i > 0) {
      const days = daysBetween(dates[i - 1], date);
      if (cash > 0) cash *= 1 + DAY_RATE * days;
      if (cashR > 0) cashR *= 1 + DAY_RATE * days;
    }

    // 分红到账（Y-1 年度，Y 年 4 月末）
    if (isAprEnd) {
      let paid = 0;
      for (const c of active) {
        const dps = prevDps(dividends, c, y);
        if (!(dps > 0)) continue;
        const n = sh.get(c) || 0;
        if (n > 0) {
          cash += n * dps;
          paid += n * dps;
          divByCode[c] = (divByCode[c] || 0) + n * dps;
        }
        const nR = shR.get(c) || 0;
        if (nR > 0) cashR += nR * dps;
      }
      if (paid > 0) {
        divByY[y] = (divByY[y] || 0) + paid;
        yearDiv += paid;
        events.push({ date, type: '分红', amount: paid, why: `${y - 1} 年度分红到账` });
      }
    }

    // 月追加：4/12 月末各入 6 个月
    if (monthlyAdd > 0 && (isAprEnd || isDecEnd)) {
      const amt = monthlyAdd * 6;
      cash += amt;
      cashR += amt;
      yearAdds += amt;
      flowsN.push([date, amt]);
      flowsR.push([date, amt]);
      events.push({ date, type: '追加', amount: amt, why: '月追加（6 个月）' });
    }

    // 分批建仓：起点已投第 1 期，之后每个月末投 1 期、投满为止（只买不卖）
    if (isStaged && i > 0 && stagedDone > 0 && stagedDone < months && monthEndDay) {
      stagedDone += 1;
      reserved = perPeriod * (months - stagedDone);
      const budget = Math.min(perPeriod, Math.max(0, cash - reserved));
      // 目标 = 当前持仓市值 + 本期预算：这一期的钱按有效权重补进去
      const spent = stagedBuyTo(date, sh, budget, stockValue(date) + budget, `分批建仓 ${stagedDone}/${months} 期`, true);
      cash -= spent;
      entryOut.installments.push({ date, amount: spent });
      // 不复投口径：同样的期数/预算，但分红不进股票
      const budgetR = Math.min(perPeriod, Math.max(0, cashR - reserved));
      const spentR = stagedBuyTo(date, shR, budgetR, stockValueR(date) + budgetR, `分批建仓 ${stagedDone}/${months} 期`, false);
      cashR -= spentR;
    }

    // 是否有股票「上市满 delay」→ 做一次结构再平衡，把它的份额买回来
    // dip 不做未上市再平衡；staged 保留，但这笔钱只能来自「现金 − 未投本金」
    if (!isDip) {
      const newly = active.filter((c) => !built.includes(c) && buildable(c, date));
      if (newly.length) {
        built = built.concat(newly);
        const list = active.filter((c) => buildable(c, date));
        rebalance(date, list, {
          useCash: true,
          buildFor: new Set(newly),
          reserve: isStaged ? reserved : 0,
          whySell: `为 ${newly.map((c) => c).join('/')} 建仓调整（卖出）`,
          whyBuy: `上市满 ${buildDelayMonths} 个月建仓（初始份额 × 组合期间增长）`,
        });
        for (const c of newly) {
          builds.push({ code: c, date, listing: listingOf.get(c), targetWeight: wOf.get(c) || 0, shares: sh.get(c) || 0, price: px(c, date) || null });
        }
      }
    }

    // 分红复投 / 追加资金：
    //  - once：按当前总资产 × 目标权重补缺口（原有口径）
    //  - staged：只能花「现金 − 未投本金 − 计划留的现金」；分红/追加仍按现有逻辑复投
    //            （目标 = 当前持仓市值 + 可复投现金 × 目标股票比例，现金仓位不变）
    //  - dip：不做等权复投，等月末按股息率门槛统一判断
    if (isStaged && (isAprEnd || isDecEnd)) {
      const free = Math.max(0, cash - reserved - designatedCash); // 分红/追加/利息 + 整手零头
      if (free > 0) {
        const addBase = free * (totalW / 100); // 按目标比例该进股票的部分
        const spent = stagedBuyTo(date, sh, free, stockValue(date) + addBase, '分红复投', true);
        cash -= spent;
      }
    } else if (!isDip && (isAprEnd || isDecEnd)) {
      investCash(date);
    }

    // dip：起点和每个月末检查股息率门槛；分红/追加的钱同样只有触发才买
    if (isDip && i > 0 && monthEndDay) {
      const rb = dipBuyTo(date, sh, cash);
      cash = rb.cash;
      // 不复投口径：dip 只用本金买、分红不参与（近似「同门槛但红利不复投」）
      if (dipPrincipalR > 0) {
        const rr = dipBuyTo(date, shR, cashR, { record: false, budget: dipPrincipalR });
        cashR = rr.cash;
        dipPrincipalR -= rr.spent;
      }
    }

    // 净值 = 现金（含 staged 未投本金）+ 持仓；预留本金只约束买入，不影响净值口径
    const v = cash + stockValue(date);
    const vR = cashR + stockValueR(date);
    nav.push([date, v]);
    navR.push([date, vR]);
    const compRow = { cash: +cash.toFixed(2) };
    for (const c of active) {
      const n = sh.get(c) || 0;
      if (n <= 0) continue;
      const p = px(c, date);
      if (p > 0) compRow[c] = +(n * p).toFixed(2);
    }
    comp.push([date, compRow]);
    yearCash = cash;
  }

  if (lastYear != null) {
    yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[nav.length - 1]?.[1] ?? null, div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
  }

  // 到期末还没建仓的股票：
  //  - once/staged：区间内未上市 / 未到建仓日 / 完全无数据（pending 原有语义）
  //  - dip：pending 只表示「无行情 / 区间内没上市」；有行情但全程没触发门槛的单独列 neverTriggered
  const lastDate = dates[dates.length - 1];
  let pending;
  if (isDip) {
    pending = active.filter((c) => !listingOf.get(c) || listingOf.get(c) > lastDate).map((c) => ({
      code: c, weight: wOf.get(c) || 0, listing: listingOf.get(c), buildDate: null,
      reason: !listingOf.get(c) ? '无行情数据' : '区间内未上市',
    }));
    const pendingSet = new Set(pending.map((p) => p.code));
    entryOut.neverTriggered = active.filter((c) => !dipTriggered.has(c) && !pendingSet.has(c));
    entryOut.triggered = Object.fromEntries(dipTriggered);
  } else {
    pending = active.filter((c) => !built.includes(c)).map((c) => ({
      code: c, weight: wOf.get(c) || 0, listing: listingOf.get(c), buildDate: buildAt.get(c),
      reason: !listingOf.get(c) ? '无行情数据' : (buildAt.get(c) > lastDate ? '区间内未到建仓日' : '区间内未上市'),
    }));
  }

  return {
    nav, navR, comp, yearly, events, divByY, divByCode, builds, pending,
    flowsN, flowsR, cashEnd: cash, entry: entryOut,
  };
}

/* ============================ 持仓回放 ============================ */

function runReplay({ codes, wOf, dates, series, dividends, lots, cash0, capital, monthlyAdd, from, to }) {
  const px = (code, date) => priceAt(series.get(code), date);
  const base = new Map();
  for (const lot of lots) {
    const c = lot.code;
    if (!c) continue;
    base.set(c, (base.get(c) || 0) + (Number(lot.shares) || 0));
  }
  for (const c of codes) if (!base.has(c)) base.set(c, 0);
  const shN = new Map(base);
  const shR = new Map(base);
  let cash = cash0;
  let cashR = cash0;
  const nav = [];
  const navR = [];
  const comp = [];
  const events = [];
  const divByY = {};
  const divByCode = {};
  const yearly = [];
  const flowsN = [[dates[0], -cash0]];
  const flowsR = [[dates[0], -cash0]];
  const codesAll = [...new Set([...codes, ...base.keys()])].filter((c) => (base.get(c) || 0) > 0);
  const valueAt = (date, shares) => {
    let v = 0;
    for (const c of codesAll) {
      const n = shares.get(c) || 0;
      if (n <= 0) continue;
      const p = px(c, date);
      if (p > 0) v += n * p;
    }
    return v;
  };
  const initValue = cash0 + valueAt(dates[0], shN);
  let lastYear = null;
  let yearNav0 = initValue;
  let yearDiv = 0;
  let yearAdds = 0;
  let yearCash = cash0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEndDay = isMonthEnd(dates, i);
    const isAprEnd = monthEndDay && date.slice(5, 7) === '04';
    const isDecEnd = monthEndDay && date.slice(5, 7) === '12';
    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1]?.[1] ?? null, div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
      yearNav0 = nav[i - 1]?.[1] ?? yearNav0;
      yearDiv = 0;
      yearAdds = 0;
    }
    lastYear = y;
    if (i > 0) {
      const days = daysBetween(dates[i - 1], date);
      if (cash > 0) cash *= 1 + DAY_RATE * days;
      if (cashR > 0) cashR *= 1 + DAY_RATE * days;
    }
    if (isAprEnd) {
      for (const c of codesAll) {
        const dps = prevDps(dividends, c, y);
        if (!(dps > 0)) continue;
        const n = shN.get(c) || 0;
        const amt = n * dps;
        const p = px(c, date);
        if (amt > 0 && p > 0) {
          const buy = Math.floor(amt / p / 100) * 100;
          shN.set(c, n + buy);
          cash += amt - buy * p;
        } else cash += amt;
        const amtR = (shR.get(c) || 0) * dps;
        cashR += amtR;
        if (amt > 0) {
          divByY[y] = (divByY[y] || 0) + amt;
          divByCode[c] = (divByCode[c] || 0) + amt;
          yearDiv += amt;
          events.push({ date, type: '分红', amount: amt, code: c, why: `${y - 1} 年度分红（复投本股）` });
        }
      }
    }
    if (monthlyAdd > 0 && (isAprEnd || isDecEnd)) {
      const amt = monthlyAdd * 6;
      cash += amt;
      cashR += amt;
      yearAdds += amt;
      flowsN.push([date, amt]);
      flowsR.push([date, amt]);
      events.push({ date, type: '追加', amount: amt, why: '月追加（6 个月）' });
    }
    const v = cash + valueAt(date, shN);
    const vR = cashR + valueAt(date, shR);
    nav.push([date, v]);
    navR.push([date, vR]);
    const compRow = { cash: +cash.toFixed(2) };
    for (const c of codesAll) {
      const n = shN.get(c) || 0;
      const p = px(c, date);
      if (n > 0 && p > 0) compRow[c] = +(n * p).toFixed(2);
    }
    comp.push([date, compRow]);
    yearCash = cash;
  }
  if (lastYear != null) {
    yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[nav.length - 1]?.[1] ?? null, div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
  }
  return { nav, navR, comp, yearly, events, divByY, divByCode, builds: [], pending: [], flowsN, flowsR, cashEnd: cash };
}
