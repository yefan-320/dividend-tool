/**
 * 组合回测引擎（纯函数，无 DOM）。
 *
 * 两种模式：
 *  - invest：把「本金」在起点按目标结构买入，持有到终点；每笔分红按真实除权除息日到账、当天复投，
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
 *         已知 DPS 口径（只服务股息率判断）：4–12 月用 Y-1 年度，1–3 月用 Y-2 年度；
 *         触发后按目标权重（当前总资产 × w%）补到目标，只买不卖、100 股整手；
 *         不摊未上市份额、不做等权再平衡；分红复投 / 月追加同样受股息率门槛约束。
 *
 * 其他口径：
 *  - 价格不复权（日 K 2014-06 起，更早用月线月末），分红按年度现金到账
 *  - 现金年息 1.5%，日计
 *  - 不含税、不含佣金
 */
import { priceAt, prevDps, isMonthEnd, maxDrawdown, sharpeOf, xirr, annualize, stepUnits, ddReport, daysBetween, CASH_DAY_RATE } from './market.js';
import { normalizeEntry } from './plan.js';

function addMonths(dayStr, n) {
  const d = new Date(dayStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
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
  // 单位净值 = 点位 ÷ 起点点位：指数本身没有现金流，这才是它的「收益率曲线」，
  // 拿来算回撤不会被月追加稀释（out 是含追加的总资产口径）
  const unitNav = [[dates[0], 1]];
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
      // 现金流：投进去的钱是流出，记负号。记成正号会让 XIRR 把追加当收益，年化虚高好几倍
      flowsOut.push([d, -amt]);
    }
    out.push([d, units * useP]);
    unitNav.push([d, useP / p0]);
  }
  const end = out[out.length - 1][1];
  const cagr = flows
    ? xirr(flowsOut.concat([[dates[dates.length - 1], end]]))
    : annualize(end / capital - 1, from, to);
  return { rows: out, unitNav, end, cagr };
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
  // 回撤 / 夏普一律走单位净值（剔除月追加）：含现金流的 nav 会把回撤稀释掉
  const unitRows = result.unitNav.filter(([, v]) => Number.isFinite(v));
  const unitRowsR = result.unitNavR.filter(([, v]) => Number.isFinite(v));
  const dd = drawdownSeries(unitRows);
  const ddR = drawdownSeries(unitRowsR);
  const ddStat = maxDrawdown(unitRows);

  /* 回撤事件：跌了几次、每次多深多久、跌的时候分红填掉多少。
     填坑率走单位净值口径——追加过的账户按金额算会被稀释（-34.5% 的坑，追加 2 万/月能把
     填坑率从 13% 吹到 19%），所以不能直接用 events 里的金额除。 */
  const episodes = ddReport(unitRows, result.divPU || [], (result.events || []).filter((x) => x.type === '分红'));
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
  const benchStat = bench ? maxDrawdown(bench.unitNav || bench.rows) : null;

  return {
    mode, from, to, dates,
    nav: result.nav, navR: result.navR, unitNav: result.unitNav, unitNavR: result.unitNavR, dd, ddR, episodes,
    comp: result.comp, events: result.events, divByY: result.divByY, divByCode: result.divByCode,
    divMissing: result.divMissing || [],
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
      sharpe: sharpeOf(unitRows),
      // 口径对照：含追加的总资产口径（旧口径），只用来解释「为什么两个数不一样」
      mddCash: maxDrawdown(result.nav).mdd,
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

/* ============================ 投入模型的零件 ============================ */

/* runInvest 的主循环要在一个价位表上同时维护「复投 / 不复投」两套持仓，
   所以把与日期循环无关的零件（估值、权重、买入、再平衡）提到模块级：
   每个函数只通过 st（可变状态）+ env（不变量）两个对象拿东西，
   主函数剩下的就只有「每天按顺序做哪几件事」。 */

/** 持仓市值（只算有正价格的） */
function positionValue(shares, active, px, date) {
  let v = 0;
  for (const c of active) {
    const n = shares.get(c) || 0;
    if (n <= 0) continue;
    const p = px(c, date);
    if (p > 0) v += n * p;
  }
  return v;
}

/** 有效权重：未建仓股票的目标份额，平均摊给当前可买的股票 */
function effectiveWeights(active, wOf, list) {
  const set = new Set(list);
  let unbuildW = 0;
  for (const c of active) if (!set.has(c)) unbuildW += wOf.get(c) || 0;
  const n = list.length;
  const m = new Map();
  for (const c of list) m.set(c, (wOf.get(c) || 0) + (n ? unbuildW / n : 0));
  return m;
}

/**
 * 把股票部分调到目标权重的买/卖。结构再平衡会卖出超配；分红复投传 sell:false 只买不卖。
 * opt: {useCash, sell, buildFor, reserve, why, whySell, whyBuy}
 * reserve = 不能动的现金（staged 未投完本金），买入只能花「现金 − reserve」。
 */
function rebalanceStep(st, env, date, list, opt) {
  const { px, wOf, totalW, active } = env;
  if (!list.length || totalW <= 0) return;
  const eff = effectiveWeights(active, wOf, list);
  const prices = new Map();
  for (const c of list) prices.set(c, px(c, date) || 0);
  let stock = 0;
  for (const c of list) stock += (st.sh.get(c) || 0) * (prices.get(c) || 0);
  const T = opt.useCash ? st.cash + stock : stock;
  const stockTarget = T * (totalW / 100);
  // 1) 卖出超配（分红复投不卖）
  if (opt.sell !== false) {
    for (const c of list) {
      const p = prices.get(c) || 0;
      if (!(p > 0)) continue;
      const target = stockTarget * eff.get(c) / totalW;
      const cur = (st.sh.get(c) || 0) * p;
      if (cur > target + p * 100) {
        const n = Math.floor((cur - target) / p / 100) * 100;
        if (n > 0) {
          st.sh.set(c, st.sh.get(c) - n);
          st.cash += n * p;
          st.events.push({ date, type: '卖出', code: c, shares: n, price: p, why: opt.whySell });
        }
      }
    }
  }
  // 2) 买入低配（缺口大的先买）；分批模式下只能花「现金 − 未投本金」
  const gaps = [];
  for (const c of list) {
    const p = prices.get(c) || 0;
    if (!(p > 0)) continue;
    const target = stockTarget * eff.get(c) / totalW;
    const cur = (st.sh.get(c) || 0) * p;
    if (target - cur > 0) gaps.push({ c, p, gap: target - cur });
  }
  gaps.sort((a, b) => b.gap - a.gap);
  for (const g of gaps) {
    const avail = opt.reserve > 0 ? Math.max(0, st.cash - opt.reserve) : st.cash;
    const n = Math.floor(Math.min(avail, g.gap) / g.p / 100) * 100;
    if (n <= 0) continue;
    st.sh.set(g.c, (st.sh.get(g.c) || 0) + n);
    st.cash -= n * g.p;
    const isBuild = opt.buildFor && opt.buildFor.has(g.c);
    st.events.push({ date, type: '买入', code: g.c, shares: n, price: g.p, why: isBuild ? opt.whyBuy : (opt.why || '结构再平衡') });
  }
}

/**
 * 一期买入：把预算按有效权重补到目标 base（元），只买不卖、100 股整手、剩余留现金。
 * base = 当前持仓市值 + 本期预算（分期建仓）/ + 可复投现金×股票占比（分红复投）。
 * @returns {number} 实际花费
 */
function stagedBuyTo(st, env, date, shares, budget, base, why, record) {
  const { px, wOf, totalW, active, buildable } = env;
  if (!(budget > 0) || totalW <= 0) return 0;
  const list = active.filter((c) => buildable(c, date));
  if (!list.length) return 0;
  const eff = effectiveWeights(active, wOf, list);
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
    if (record) st.events.push({ date, type: '买入', code: g.c, shares: n, price: g.p, why });
  }
  return spent;
}

/**
 * 已知最近年度每股分红（元/股）：Y 年 1–3 月看 Y-2 年度，4–12 月看 Y-1 年度。
 * 只影响「股息率估算」，入账一律看 data/div 的 ev 除权日。
 */
function knownDps(dividends, code, date) {
  const years = dividends?.[code]?.years;
  if (!years) return 0;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const v = years[m >= 4 ? y - 1 : y - 2];
  return v > 0 ? v : 0;
}

/**
 * 股息率触发的买入：只有「DPS ÷ 当日价 × 100 ≥ minDy」才买，只买不卖、100 股整手。
 * 不摊未上市份额、不做等权再平衡（与 once/staged 口径不同）。
 * opt: {record, budget}——不复投口径的 budget 只用本金。
 * @returns {{cash:number, spent:number}}
 */
function dipBuyTo(st, env, date, shares, cashNow, opt = {}) {
  const { px, wOf, totalW, active, dividends, e } = env;
  const record = opt.record !== false;
  const budget = opt.budget == null ? Infinity : opt.budget;
  let cashLeft = cashNow;
  let spent = 0;
  if (totalW <= 0) return { cash: cashLeft, spent };
  const stock = positionValue(shares, active, px, date);
  const T = cashLeft + stock; // 目标 = 当前总资产 × w/100
  const gaps = [];
  for (const c of active) {
    const p = px(c, date) || 0;
    if (!(p > 0)) continue;
    const dps = knownDps(dividends, c, date);
    if (!(dps > 0)) continue;
    const dy = (dps / p) * 100;
    if (!(dy >= e.minDy)) continue;
    // 触发口径：股息率达到门槛（哪怕整手取整后买不到也算触发）
    if (record && !st.dipTriggered.has(c)) st.dipTriggered.set(c, date);
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
    if (record) st.events.push({ date, type: '买入', code: g.c, shares: n, price: g.p, why: `股息率 ${g.dy.toFixed(1)}% ≥ ${e.minDy}% 建仓` });
  }
  return { cash: cashLeft, spent };
}

/** 当日净值记账：两条净值 + 单位净值（TWR）+ 按股票细分的持仓表。 */
function recordDay(st, env, date, extIn) {
  const v = st.cash + positionValue(st.sh, env.active, env.px, date);
  const vR = st.cashR + positionValue(st.shR, env.active, env.px, date);
  st.nav.push([date, v]);
  st.navR.push([date, vR]);
  const a = stepUnits(st.units, v, extIn);
  st.units = a.units;
  st.unitNav.push([date, a.unitNav]);
  st.divPU.push([date, st.cumDivPU]);
  const b = stepUnits(st.unitsR, vR, extIn);
  st.unitsR = b.units;
  st.unitNavR.push([date, b.unitNav]);
  const compRow = { cash: +st.cash.toFixed(2) };
  for (const c of env.active) {
    const n = st.sh.get(c) || 0;
    if (n <= 0) continue;
    const p = env.px(c, date);
    if (p > 0) compRow[c] = +(n * p).toFixed(2);
  }
  st.comp.push([date, compRow]);
}

/**
 * 区间内新上市的股票：上市满 delay 后做一次结构再平衡把它买回来。
 * dip 不做未上市再平衡；staged 保留，但钱只能来自「现金 − 未投本金」。
 * @returns {string[]} 更新后的已建仓集合
 */
function stepNewListings(st, env, date, built) {
  const { active, buildable, wOf, px, isDip, isStaged, buildDelayMonths } = env;
  if (isDip) return built;
  const newly = active.filter((c) => !built.includes(c) && buildable(c, date));
  if (!newly.length) return built;
  const next = built.concat(newly);
  const list = active.filter((c) => buildable(c, date));
  rebalanceStep(st, env, date, list, {
    useCash: true,
    buildFor: new Set(newly),
    reserve: isStaged ? st.reserved : 0,
    whySell: `为 ${newly.map((c) => c).join('/')} 建仓调整（卖出）`,
    whyBuy: `上市满 ${buildDelayMonths} 个月建仓（初始份额 × 组合期间增长）`,
  });
  for (const c of newly) {
    st.builds.push({ code: c, date, listing: st.listingOf.get(c), targetWeight: wOf.get(c) || 0, shares: st.sh.get(c) || 0, price: px(c, date) || null });
  }
  return next;
}

/**
 * 到期末还没建仓的股票。once/staged 用 pending 的统一语义（未上市/未到建仓日/无数据）；
 * dip 的 pending 只表示无行情或未上市，有行情但没触发门槛的另列 neverTriggered。
 */
function settlePending(st, env, dates, built) {
  const { active, wOf, isDip } = env;
  const lastDate = dates[dates.length - 1];
  if (isDip) {
    const pending = active.filter((c) => !st.listingOf.get(c) || st.listingOf.get(c) > lastDate).map((c) => ({
      code: c, weight: wOf.get(c) || 0, listing: st.listingOf.get(c), buildDate: null,
      reason: !st.listingOf.get(c) ? '无行情数据' : '区间内未上市',
    }));
    const pendingSet = new Set(pending.map((p) => p.code));
    st.entryOut.neverTriggered = active.filter((c) => !st.dipTriggered.has(c) && !pendingSet.has(c));
    st.entryOut.triggered = Object.fromEntries(st.dipTriggered);
    return pending;
  }
  return active.filter((c) => !built.includes(c)).map((c) => ({
    code: c, weight: wOf.get(c) || 0, listing: st.listingOf.get(c), buildDate: st.buildAt.get(c),
    reason: !st.listingOf.get(c) ? '无行情数据' : (st.buildAt.get(c) > lastDate ? '区间内未到建仓日' : '区间内未上市'),
  }));
}

/**
 * 起点建仓：once 一次买齐；staged 只投第 1 期；dip 起点按股息率门槛判断。
 * 返回起点可买集合——主循环判断「新上市」时要和它比。
 */
function initialBuild(st, env, dates) {
  const { active, buildable, px, wOf, totalW, capital, isStaged, isDip, months, perPeriod } = env;
  const d0 = dates[0];
  const built = active.filter((c) => buildable(c, d0));
  const valueOf = (shares) => positionValue(shares, active, px, d0);
  if (isStaged) {
    st.stagedDone = 1;
    st.reserved = perPeriod * (months - 1); // 剩下 months-1 期的本金必须留着
    if (perPeriod > 0) {
      const budget = Math.min(perPeriod, Math.max(0, st.cash - st.reserved));
      const spent = stagedBuyTo(st, env, d0, st.sh, budget, valueOf(st.sh) + budget, `分批建仓 1/${months} 期`, true);
      st.cash -= spent;
      st.entryOut.installments.push({ date: d0, amount: spent });
      // 不复投口径：同样的期数/预算，但分红不进股票（与 once 的初始建仓口径一致）
      const spentR = stagedBuyTo(st, env, d0, st.shR, budget, valueOf(st.shR) + budget, `分批建仓 1/${months} 期`, false);
      st.cashR -= spentR;
    }
  } else if (isDip) {
    // dip：起点先按门槛试一次
    const n0 = dipBuyTo(st, env, d0, st.sh, st.cash);
    st.cash = n0.cash;
    const r0 = dipBuyTo(st, env, d0, st.shR, st.cashR, { record: false, budget: st.dipPrincipalR });
    st.cashR = r0.cash;
    st.dipPrincipalR -= r0.spent;
  } else if (built.length) {
    const eff = effectiveWeights(active, wOf, built);
    const stockTarget = capital * (totalW / 100);
    let spent = 0;
    for (const c of built) {
      const p = px(c, d0) || 0;
      if (!(p > 0)) continue;
      const target = stockTarget * eff.get(c) / totalW;
      const n = Math.floor(target / p / 100) * 100;
      if (n > 0) {
        st.sh.set(c, n);
        st.shR.set(c, n);
        st.events.push({ date: d0, type: '买入', code: c, shares: n, price: p, why: '初始建仓' });
        spent += n * p;
      }
    }
    // 权重已在入口归一化（合计 ≤100），整手向下取整后不会超过本金；Math.max 兜底浮点误差
    st.cash = Math.max(0, capital - spent);
    st.cashR = st.cash;
  }
  return built;
}

/** 当日分红到账：按各自除权除息日入账；没有 ev 的股票整段不计（记进 divMissing）。 */
function stepDividends(st, env, date, y) {
  let paid = 0;
  const payTo = (c, dps) => {
    if (!(dps > 0)) return;
    const n = st.sh.get(c) || 0;
    if (n > 0) {
      const amt = n * dps;
      st.cash += amt;
      paid += amt;
      // 单位净值口径的分红：每份净值收到多少。追加过的账户按金额算会被稀释
      if (st.units > 0) st.cumDivPU += amt / st.units;
      st.divByCode[c] = (st.divByCode[c] || 0) + amt;
    }
    const nR = st.shR.get(c) || 0;
    if (nR > 0) st.cashR += nR * dps;
  };
  for (const c of env.active) {
    const evs = env.dividends?.[c]?.ev;
    if (!Array.isArray(evs) || !evs.length) {
      // 没有派息明细 = 这只股票在回测里完全不派息。不猜日期、不编「4 月末」。
      st.divMissing.add(c);
      continue;
    }
    let ptr = st.evPtr.get(c);
    if (ptr === undefined) {
      // 第一次遇到这只股票：建仓日之前的分红不算
      ptr = 0;
      while (ptr < evs.length && evs[ptr][0] <= date) ptr++;
      st.evPtr.set(c, ptr);
      continue;
    }
    while (ptr < evs.length && evs[ptr][0] <= date) {
      payTo(c, evs[ptr][1]);
      ptr++;
    }
    st.evPtr.set(c, ptr);
  }
  if (paid > 0) {
    st.divByY[y] = (st.divByY[y] || 0) + paid;
    st.yearDiv += paid;
    st.events.push({ date, type: '分红', amount: paid, why: '除权除息日分红到账' });
  }
  return paid;
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
  // 单位净值（TWR）：剔除「月追加」这类外部现金流后的净值，回撤 / 夏普只能用这条算。
  // 直接把含现金流的 nav 拿去算回撤，追加的钱会抬高分母，把 -34.5% 稀释成 -23.8%。
  const unitNav = [];
  const unitNavR = [];
  let units = 0;   // 复投口径份额
  let unitsR = 0;  // 不复投口径份额
  let cumDivPU = 0;      // 累计「每份净值分红」，回撤填坑率用它算
  const divPU = [];      // [[date, cumDivPU]]

  /* ---------------- 建仓节奏状态 ---------------- */
  // entry 返回值：只新增字段，原有字段不变
  const entryOut = { mode: e.mode, months: e.months, minDy: e.minDy, installments: [], triggered: {}, neverTriggered: [] };
  let stagedDone = 0;          // 已投期数（起点算第 1 期）
  let reserved = isStaged ? stockCapital : 0; // 还没投、必须留在现金里的本金
  const dipTriggered = new Map(); // dip：code → 首次满足股息率门槛的日期
  let dipPrincipalR = isDip ? capital : 0; // 不复投口径：dip 只用本金买、分红不参与

  const stockValue = (date) => positionValue(sh, active, px, date);
  const stockValueR = (date) => positionValue(shR, active, px, date);

  let lastYear = null;
  let yearNav0 = capital;
  let yearDiv = 0;
  let yearAdds = 0;
  let yearCash = null;

  /* 每只股票的分红事件指针：按「真实除权除息日」逐笔到账，不再假设每年 4 月末统一发。
     ev 缺的股票在回测里完全不派息，并记进 divMissing 让页面说清楚。 */
  const evPtr = new Map();
  const divMissing = new Set();

  /* 零件函数的两个入口：st 是可变状态，env 是不变量。
     cash / cashR / units / cumDivPU / yearDiv 是 runInvest 顶层的 let，
     这里用访问器代理过去——否则零件改了 st.cash、主循环还在读自己的 cash，两边会分裂。 */
  const st = {
    sh, shR, events, dipTriggered, divByCode, divByY, evPtr, divMissing,
    nav, navR, comp, unitNav, unitNavR, divPU, entryOut, builds, listingOf, buildAt,
    get cash() { return cash; },
    set cash(v) { cash = v; },
    get cashR() { return cashR; },
    set cashR(v) { cashR = v; },
    get units() { return units; },
    set units(v) { units = v; },
    get unitsR() { return unitsR; },
    set unitsR(v) { unitsR = v; },
    get cumDivPU() { return cumDivPU; },
    set cumDivPU(v) { cumDivPU = v; },
    get yearDiv() { return yearDiv; },
    set yearDiv(v) { yearDiv = v; },
    get stagedDone() { return stagedDone; },
    set stagedDone(v) { stagedDone = v; },
    get reserved() { return reserved; },
    set reserved(v) { reserved = v; },
    get dipPrincipalR() { return dipPrincipalR; },
    set dipPrincipalR(v) { dipPrincipalR = v; },
  };
  const env = { active, wOf, totalW, px, buildable, dividends, e, capital, isStaged, isDip, months, perPeriod, stockCapital, designatedCash, buildDelayMonths };


  // 起点：可买集合（上市满 delay 的股票）；未上市份额摊给它们；随后按模式做初始建仓
  let built = initialBuild(st, env, dates);

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEndDay = isMonthEnd(dates, i);
    const isAprEnd = monthEndDay && date.slice(5, 7) === '04';
    const isDecEnd = monthEndDay && date.slice(5, 7) === '12';

    let extIn = 0;   // 当日外部现金流入（月追加），单位净值要按流入前净值增发份额
    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1]?.[1] ?? null, div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
      yearNav0 = nav[i - 1]?.[1] ?? yearNav0;
      yearDiv = 0;
      yearAdds = 0;
    }
    lastYear = y;

    if (i > 0) {
      const days = daysBetween(dates[i - 1], date);
      if (cash > 0) cash *= 1 + CASH_DAY_RATE * days;
      if (cashR > 0) cashR *= 1 + CASH_DAY_RATE * days;
    }

    stepDividends(st, env, date, y);

    // 月追加：4/12 月末各入 6 个月
    if (monthlyAdd > 0 && (isAprEnd || isDecEnd)) {
      const amt = monthlyAdd * 6;
      cash += amt;
      cashR += amt;
      yearAdds += amt;
      extIn += amt;
      // 现金流记负：这是从口袋里掏出去的钱。记正号 XIRR 会把它当收益，年化虚高 2~4 倍
      flowsN.push([date, -amt]);
      flowsR.push([date, -amt]);
      events.push({ date, type: '追加', amount: amt, why: '月追加（6 个月）' });
    }

    // 分批建仓：起点已投第 1 期，之后每个月末投 1 期、投满为止（只买不卖）
    if (isStaged && i > 0 && stagedDone > 0 && stagedDone < months && monthEndDay) {
      stagedDone += 1;
      reserved = perPeriod * (months - stagedDone);
      const budget = Math.min(perPeriod, Math.max(0, cash - reserved));
      // 目标 = 当前持仓市值 + 本期预算：这一期的钱按有效权重补进去
      const spent = stagedBuyTo(st, env, date, sh, budget, stockValue(date) + budget, `分批建仓 ${stagedDone}/${months} 期`, true);
      cash -= spent;
      entryOut.installments.push({ date, amount: spent });
      // 不复投口径：同样的期数/预算，但分红不进股票
      const budgetR = Math.min(perPeriod, Math.max(0, cashR - reserved));
      const spentR = stagedBuyTo(st, env, date, shR, budgetR, stockValueR(date) + budgetR, `分批建仓 ${stagedDone}/${months} 期`, false);
      cashR -= spentR;
    }

    built = stepNewListings(st, env, date, built);

    // 分红复投 / 追加资金：
    //  - once：按当前总资产 × 目标权重补缺口（原有口径）
    //  - staged：只能花「现金 − 未投本金 − 计划留的现金」；分红/追加仍按现有逻辑复投
    //            （目标 = 当前持仓市值 + 可复投现金 × 目标股票比例，现金仓位不变）
    //  - dip：不做等权复投，等月末按股息率门槛统一判断
    if (isStaged && (isAprEnd || isDecEnd)) {
      const free = Math.max(0, cash - reserved - designatedCash); // 分红/追加/利息 + 整手零头
      if (free > 0) {
        const addBase = free * (totalW / 100); // 按目标比例该进股票的部分
        const spent = stagedBuyTo(st, env, date, sh, free, stockValue(date) + addBase, '分红复投', true);
        cash -= spent;
      }
    } else if (!isDip && (isAprEnd || isDecEnd)) {
      rebalanceStep(st, env, date, active.filter((c) => buildable(c, date)), { useCash: true, sell: false, why: '分红复投' });
    }

    // dip：起点和每个月末检查股息率门槛；分红/追加的钱同样只有触发才买
    if (isDip && i > 0 && monthEndDay) {
      const rb = dipBuyTo(st, env, date, sh, cash);
      cash = rb.cash;
      // 不复投口径：dip 只用本金买、分红不参与（近似「同门槛但红利不复投」）
      if (dipPrincipalR > 0) {
        const rr = dipBuyTo(st, env, date, shR, cashR, { record: false, budget: dipPrincipalR });
        cashR = rr.cash;
        dipPrincipalR -= rr.spent;
      }
    }

    // 净值 = 现金（含 staged 未投本金）+ 持仓；预留本金只约束买入，不影响净值口径
    recordDay(st, env, date, extIn);
    yearCash = st.cash;
  }

  if (lastYear != null) {
    yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[nav.length - 1]?.[1] ?? null, div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
  }

  const pending = settlePending(st, env, dates, built);

  return {
    nav, navR, unitNav, unitNavR, divPU, comp, yearly, events, divByY, divByCode, builds, pending,
    divMissing: [...divMissing],
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
  // 单位净值（TWR）：剔除月追加这类外部现金流。回撤 / 夏普只能用这条算
  const unitNav = [];
  const unitNavR = [];
  let units = 0;
  let unitsR = 0;
  let cumDivPU = 0;
  const divPU = [];
  const events = [];
  const divByY = {};
  const divByCode = {};
  const yearly = [];
  const flowsN = [[dates[0], -cash0]];
  const flowsR = [[dates[0], -cash0]];
  const codesAll = [...new Set([...codes, ...base.keys()])].filter((c) => (base.get(c) || 0) > 0);
  const valueAt = (date, shares) => positionValue(shares, codesAll, px, date);
  const initValue = cash0 + valueAt(dates[0], shN);
  let lastYear = null;
  let yearNav0 = initValue;
  let yearDiv = 0;
  let yearAdds = 0;
  let yearCash = cash0;
  const evPtrR = new Map();
  const divMissing = new Set();
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEndDay = isMonthEnd(dates, i);
    const isAprEnd = monthEndDay && date.slice(5, 7) === '04';
    const isDecEnd = monthEndDay && date.slice(5, 7) === '12';
    let extIn = 0;   // 当日外部现金流入（月追加）
    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1]?.[1] ?? null, div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
      yearNav0 = nav[i - 1]?.[1] ?? yearNav0;
      yearDiv = 0;
      yearAdds = 0;
    }
    lastYear = y;
    if (i > 0) {
      const days = daysBetween(dates[i - 1], date);
      if (cash > 0) cash *= 1 + CASH_DAY_RATE * days;
      if (cashR > 0) cashR *= 1 + CASH_DAY_RATE * days;
    }
    {
      // 每笔按自己的除权除息日；没明细的股票一律不计（divMissing 里记一笔）
      const due = [];
      for (const c of codesAll) {
        const evs = dividends?.[c]?.ev;
        if (!Array.isArray(evs) || !evs.length) {
          divMissing.add(c);
          continue;
        }
        let ptr = evPtrR.get(c);
        if (ptr === undefined) { ptr = 0; while (ptr < evs.length && evs[ptr][0] <= date) ptr++; evPtrR.set(c, ptr); continue; }
        while (ptr < evs.length && evs[ptr][0] <= date) { due.push([c, evs[ptr][1], `${evs[ptr][0]} 除息（复投本股）`]); ptr++; }
        evPtrR.set(c, ptr);
      }
      for (const [c, dps, why] of due) {
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
          if (units > 0) cumDivPU += amt / units;
          divByY[y] = (divByY[y] || 0) + amt;
          divByCode[c] = (divByCode[c] || 0) + amt;
          yearDiv += amt;
          events.push({ date, type: '分红', amount: amt, code: c, why });
        }
      }
    }
    if (monthlyAdd > 0 && (isAprEnd || isDecEnd)) {
      const amt = monthlyAdd * 6;
      cash += amt;
      cashR += amt;
      yearAdds += amt;
      extIn += amt;
      // 同上：追加是流出，记负号
      flowsN.push([date, -amt]);
      flowsR.push([date, -amt]);
      events.push({ date, type: '追加', amount: amt, why: '月追加（6 个月）' });
    }
    const v = cash + valueAt(date, shN);
    const vR = cashR + valueAt(date, shR);
    nav.push([date, v]);
    navR.push([date, vR]);
    { const s = stepUnits(units, v, extIn); units = s.units; unitNav.push([date, s.unitNav]); divPU.push([date, cumDivPU]); }
    { const s = stepUnits(unitsR, vR, extIn); unitsR = s.units; unitNavR.push([date, s.unitNav]); }
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
  return { nav, navR, unitNav, unitNavR, divPU, comp, yearly, events, divByY, divByCode, builds: [], pending: [], flowsN, flowsR, cashEnd: cash, divMissing: [...divMissing] };
}
