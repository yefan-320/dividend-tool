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
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i];
    const p = prices[i];
    if (!(p > 0)) { out.push([d, units * p0]); continue; }
    const monthEnd = isMonthEnd(dates, i);
    const mm = d.slice(5, 7);
    if (monthlyAdd > 0 && monthEnd && (mm === '04' || mm === '12')) {
      const amt = monthlyAdd * 6;
      units += amt / p;
      flowsOut.push([d, amt]);
    }
    out.push([d, units * p]);
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
 */
export function runPortfolioBacktest(o) {
  const {
    dates, series, dividends = {}, holdings = [], capital = 1000000, monthlyAdd = 0,
    from, to, mode = 'invest', lots = [], cash0 = 0,
    benchmarkSeries = null, lowVolSeries = null, buildDelayMonths = 6,
  } = o;
  const codes = holdings.map((h) => h.code).filter((c) => c);
  const wOf = new Map(holdings.map((h) => [h.code, Number(h.weight) || 0]));
  const totalW = holdings.reduce((a, h) => a + (Number(h.weight) || 0), 0);
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
    : runInvest({ codes, wOf, totalW, cashPct, dates, series, dividends, capital, monthlyAdd, from, to, buildDelayMonths });

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
  const cagr = hasAdd
    ? xirr(flowsN.concat([[result.nav[result.nav.length - 1][0], end]]))
    : annualize(end / capital - 1, from, to);
  const cagrR = hasAdd
    ? xirr(flowsR.concat([[result.navR[result.navR.length - 1][0], endR]]))
    : annualize(endR / capital - 1, from, to);
  const benchStat = bench ? maxDrawdown(bench.rows) : null;

  return {
    mode, from, to, dates,
    nav: result.nav, navR: result.navR, dd, ddR,
    comp: result.comp, events: result.events, divByY: result.divByY, divByCode: result.divByCode,
    yearly: result.yearly, builds: result.builds, pending: result.pending,
    totalDiv, totalIn, end, endR, cashEnd: result.cashEnd,
    stats: {
      ret: end / capital - 1,
      retR: endR / capital - 1,
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

function runInvest({ codes, wOf, totalW, cashPct, dates, series, dividends, capital, monthlyAdd, from, to, buildDelayMonths }) {
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
   * @param {object} opt {useCash:boolean, buildFor:Set, whySell:string, whyBuy:string}
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
    // 2) 买入低配（缺口大的先买）
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
      const n = Math.floor(Math.min(cash, g.gap) / g.p / 100) * 100;
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

  // 起点：可买集合（上市满 delay 的股票）；未上市份额摊给它们
  let built = active.filter((c) => buildable(c, dates[0]));
  let cash0Left = capital;
  // 初始建仓（同时给不复投口径建一份）
  if (built.length) {
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
    cash = capital - gaps.reduce((a, b) => a + b, 0);
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

    // 是否有股票「上市满 delay」→ 做一次结构再平衡，把它的份额买回来
    const newly = active.filter((c) => !built.includes(c) && buildable(c, date));
    if (newly.length) {
      built = built.concat(newly);
      const list = active.filter((c) => buildable(c, date));
      rebalance(date, list, {
        useCash: true,
        buildFor: new Set(newly),
        whySell: `为 ${newly.map((c) => c).join('/')} 建仓调整（卖出）`,
        whyBuy: `上市满 ${buildDelayMonths} 个月建仓（初始份额 × 组合期间增长）`,
      });
      for (const c of newly) {
        builds.push({ code: c, date, listing: listingOf.get(c), targetWeight: wOf.get(c) || 0, shares: sh.get(c) || 0, price: px(c, date) || null });
      }
    }

    // 分红复投 / 追加资金按目标权重买入
    if (isAprEnd || isDecEnd) investCash(date);

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

  // 到期末还没建仓的股票（区间内未上市 / 未到建仓日 / 完全无数据）
  const lastDate = dates[dates.length - 1];
  const pending = active.filter((c) => !built.includes(c)).map((c) => ({
    code: c, weight: wOf.get(c) || 0, listing: listingOf.get(c), buildDate: buildAt.get(c),
    reason: !listingOf.get(c) ? '无行情数据' : (buildAt.get(c) > lastDate ? '区间内未到建仓日' : '区间内未上市'),
  }));

  return {
    nav, navR, comp, yearly, events, divByY, divByCode, builds, pending,
    flowsN, flowsR, cashEnd: cash,
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
