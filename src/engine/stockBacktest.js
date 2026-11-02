/**
 * 单股回测引擎（纯函数，无 DOM）。
 *
 * 规则（每个 4 月末 / 12 月末决策一次，日级估值；分红日期另算，见下）：
 *  - 买入：股息率 ≥ minDy，且质量过关（不亏损、支付率 <85%、现金流覆盖 ≥0.7、ROE ≥5）
 *  - 卖出：质量不过关（亏损 / 现金流覆盖不足 / 支付率过高）或分红下调 ≥5%
 *  - 分红：每笔按真实除权除息日到账（每股派息 × 持股），进现金；没有 ev 就不派，不猜日期
 *  - 月追加：4/12 月末各入 6 个月
 *  - 不含税；价格不复权，分红单独计现金
 */
import { priceAt, prevDps, isMonthEnd, maxDrawdown, sharpeOf, xirr, annualize, qualityOf, dyQuality } from './market.js';
import { buildBenchmark } from './portfolioBacktest.js';

const DAY_RATE = 0.015 / 365;

/**
 * @param {object} o
 * @param {string} o.code
 * @param {string[]} o.dates
 * @param {{dates:string[],closes:number[]}} o.series
 * @param {object} o.dividends
 * @param {object} o.finHistory
 * @param {number} o.capital
 * @param {number} o.monthlyAdd
 * @param {number} o.minDy 买入股息率下限（%）
 * @param {Array} o.benchmarkSeries
 * @param {string} o.from
 * @param {string} o.to
 */
export function runStockBacktest(o) {
  const {
    code, series, dividends = {}, finHistory = {},
    capital = 1000000, monthlyAdd = 0, minDy = 5, benchmarkSeries = null, from, to,
    useQuality = true,   // false = 只看走势，不拿财报做质量筛选（也就不需要下财报）
  } = o;
  /* 区间要在这里裁：上游传进来的是全市场日历（2014-06 起），
     不裁的话页面上写「2016-10-30 →」，净值曲线却从 2014-06 画起，年化也按错的年数算。 */
  const all = o.dates || [];
  let lo = 0;
  let hi = all.length - 1;
  if (from) { const i = all.findIndex((d) => d >= from); if (i >= 0) lo = i; }
  if (to) { for (let i = all.length - 1; i >= lo; i--) { if (all[i] <= to) { hi = i; break; } } }
  const dates = lo <= hi ? all.slice(lo, hi + 1) : all;
  const px = (date) => priceAt(series, date);
  const nav = [];
  const navHold = [];
  const trades = [];
  const divByY = {};
  const yearly = [];
  const flows = [[dates[0], -capital]];
  let shares = 0;
  let cash = capital;
  let yearNav0 = capital;
  let lastYear = null;
  let yearDiv = 0;
  let yearAdds = 0;

  // 买入持有对照
  const d0 = dates[0];
  const p0 = px(d0);
  const holdShares = p0 > 0 ? Math.floor(capital / p0 / 100) * 100 : 0;
  let holdCash = capital - holdShares * p0;

  /* 分红只有一个来源：data/div/<code>.json 的 ev（每笔的真实除权除息日 + 每股派息）。
     没有 ev 的股票就是「没有派息明细」——回测一律不计，绝不编一个「4 月末」出来。
     years（年度合计）只服务股息率 / 选股判断，不参与回测入账。 */
  const evAll = Array.isArray(dividends?.[code]?.ev) ? dividends[code].ev : [];
  const evs = evAll.filter(([d, v]) => d >= (dates[0] || '') && (!to || d <= to) && v > 0);
  let evI = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEndDay = isMonthEnd(dates, i);
    const month = date.slice(5, 7);
    const isAprEnd = monthEndDay && month === '04';
    const isDecEnd = monthEndDay && month === '12';

    if (lastYear != null && y !== lastYear) {
      yearly.push({
        year: lastYear,
        nav0: yearNav0,
        nav1: nav[i - 1]?.[1] ?? null,
        div: yearDiv,
        cash,
        invest: yearAdds,
      });
      yearNav0 = nav[i - 1]?.[1] ?? yearNav0;
      yearDiv = 0;
      yearAdds = 0;
    }
    lastYear = y;

    if (i > 0 && cash > 0) cash *= 1 + DAY_RATE * daysBetween(dates[i - 1], date);
    if (i > 0 && holdCash > 0) holdCash *= 1 + DAY_RATE * daysBetween(dates[i - 1], date);

    // 分红到账：有几笔派几笔，每笔按自己的除权除息日
    {
      const paid = [];
      while (evI < evs.length && evs[evI][0] <= date) paid.push(evs[evI++]);
      for (const [xd, dps] of paid) {
        if (dps > 0 && shares > 0) {
          const amt = shares * dps;
          cash += amt;
          const dy = Number(String(xd).slice(0, 4));
          divByY[dy] = (divByY[dy] || 0) + amt;
          yearDiv += amt;
          trades.push({ date, type: '分红', amount: amt, div: amt, dps, why: `${xd} 除息到账` });
        }
        // 买入持有对照同样拿分红（现金，不买入）
        if (dps > 0 && holdShares > 0) holdCash += holdShares * dps;
      }
    }

    // 月追加
    if (monthlyAdd > 0 && (isAprEnd || isDecEnd)) {
      const amt = monthlyAdd * 6;
      cash += amt;
      yearAdds += amt;
      // 现金流记负：追加是流出。记正号会让 XIRR 把追加当收益，年化虚高
      flows.push([date, -amt]);
    }

    // 决策
    if (isAprEnd || isDecEnd) {
      const price = px(date);
      const dq = dyQuality({ dividends, finHistory, code, year: y, price });
      // 不启用质量筛选时，财报一律视为「未知但不否决」：只按股息率/分红变化做决策
      const q = useQuality ? qualityOf(finHistory, code, y - 1) : { ok: true, why: '' };
      const prev = prevDps(dividends, code, y - 1);
      const curDps = prevDps(dividends, code, y);
      const cut = prev > 0 && curDps > 0 && curDps < prev * 0.95;
      if (shares > 0) {
        if (!q.ok) {
          cash += shares * price;
          trades.push({ date, type: '卖出', shares, price, why: '质量否决：' + q.why });
          shares = 0;
        } else if (cut) {
          cash += shares * price;
          trades.push({ date, type: '卖出', shares, price, why: '分红下调 ≥5%' });
          shares = 0;
        }
      }
      if (shares === 0 && q.ok && dq.dy != null && dq.dy >= minDy) {
        const payoutBad = useQuality && dq.payout != null && dq.payout >= 85;
        const coverBad = useQuality && dq.cover != null && dq.cover < 0.7;
        if (!payoutBad && !coverBad) {
          const n = Math.floor(cash / price / 100) * 100;
          if (n > 0) {
            shares += n;
            cash -= n * price;
            trades.push({ date, type: '买入', shares: n, price, why: `股息率 ${dq.dy.toFixed(1)}% ≥ ${minDy}%` });
          }
        }
      }
    }

    const price = px(date);
    nav.push([date, cash + shares * (price || 0)]);
    navHold.push([date, holdCash + holdShares * (price || 0)]);
  }

  if (lastYear != null) {
    yearly.push({
      year: lastYear,
      nav0: yearNav0,
      nav1: nav[nav.length - 1]?.[1] ?? null,
      div: yearDiv,
      cash,
      invest: yearAdds,
    });
  }

  const end = nav.length ? nav[nav.length - 1][1] : capital;
  const endHold = navHold.length ? navHold[navHold.length - 1][1] : capital;
  const totalIn = capital + yearly.reduce((s, x) => s + (x.invest || 0), 0);
  const totalDiv = Object.values(divByY).reduce((s, x) => s + x, 0);
  const flowing = totalIn > capital;
  // capital=0 时收益率无定义：返回 null，不产生 NaN
  const ret = capital > 0 ? end / capital - 1 : null;
  const retHold = capital > 0 ? endHold / capital - 1 : null;
  const cagr = flowing
    ? xirr(flows.concat([[nav[nav.length - 1][0], end]]))
    : (ret == null ? null : annualize(ret, from, to));
  const cagrHold = retHold == null ? null : annualize(retHold, from, to);
  const bench = benchmarkSeries
    ? buildBenchmark({ dates, rows: benchmarkSeries, capital, monthlyAdd, from, to, flows: flowing })
    : null;
  const ddStat = maxDrawdown(nav);
  const buys = trades.filter((t) => t.type === '买入');
  const sells = trades.filter((t) => t.type === '卖出');

  return {
    code, from, to, dates, nav, navHold, trades, divByY, yearly,
    totalDiv, totalIn, end, endHold,
    stats: {
      ret,
      retHold,
      retFund: totalIn > 0 ? end / totalIn - 1 : null,
      cagr, cagrHold,
      mdd: ddStat.mdd,
      mddPeak: ddStat.mddPeak,
      mddTrough: ddStat.mddTrough,
      sharpe: sharpeOf(nav),
      buys: buys.length,
      sells: sells.length,
      benchCagr: bench ? bench.cagr : null,
      benchEnd: bench ? bench.end : null,
      excess: bench && cagr != null && bench.cagr != null ? cagr - bench.cagr : null,
      years: daysBetween(from, to) / 365.25,
    },
    bench,
    lastTrades: trades.slice(-12),
  };
}

function daysBetween(a, b) {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
}

/**
 * 定投回测（个股页用这个）：**不判断买卖点**。
 *
 * 规则只有三条：
 *   1. 第一天把首次本金全买进去
 *   2. 每年 4 月末 / 12 月末各入账 6 个月的追加额，当天全买进去
 *   3. 每笔分红按自己的除权除息日到账，当天收盘价再投进去（红利再投资）
 *
 * 不设股息率门槛、不看财报、不因为分红下调卖出——一分钱都不卖。
 * 对照口径（navHold）是同一笔本金第一天买入、追加照投但不复利、分红进现金不进股。
 */
export function runInvestBacktest(o) {
  const { code, series, dividends = {}, capital = 1000000, monthlyAdd = 0, from, to } = o;
  const all = o.dates || [];
  let lo = 0;
  let hi = all.length - 1;
  if (from) { const i = all.findIndex((d) => d >= from); if (i >= 0) lo = i; }
  if (to) { for (let i = all.length - 1; i >= lo; i--) { if (all[i] <= to) { hi = i; break; } } }
  const dates = lo <= hi ? all.slice(lo, hi + 1) : all;

  const px = (d) => priceAt(series, d) || 0;
  const nav = [];
  const hold = [];
  const trades = [];
  const divByY = {};
  const yearly = [];
  const flows = [];
  let shares = 0;
  let cash = 0;          // 凑不满 100 股的零钱
  let totalIn = 0;
  let totalDiv = 0;
  // 对照：同一笔本金第一天买入、永远不动、分红进现金不再投（buy & hold 的通常口径）
  let holdShares = 0;
  let holdCash = 0;
  let yearNav0 = 0;
  let yearDiv = 0;
  let yearIn = 0;
  let lastYear = null;

  // 建仓日：区间第一天可能停牌/没数据，顺延到第一个有收盘价的交易日
  let d0 = null;
  let p0 = 0;
  for (const d of dates) { const v = px(d); if (v > 0) { d0 = d; p0 = v; break; } }
  if (d0) {
    const n0 = p0 > 0 ? Math.floor(capital / p0 / 100) * 100 : 0;
    shares = n0;
    cash = capital - n0 * p0;
    holdShares = n0;
    holdCash = cash;
    totalIn = capital;
    flows.push([d0, -capital]);
    trades.push({ date: d0, type: '建仓', shares: n0, price: p0, amount: capital, why: '首次本金全买' });
  }

  /* 分红明细：只认「每一笔的除权除息日」（ev）；没有就不派。
     一年分两次（中期 + 年度）的公司，只有明细才对得上日子。 */
  /* 同上：只认 ev。没有派息明细就不派，不猜日期。 */
  const evAll = Array.isArray(dividends?.[code]?.ev) ? dividends[code].ev : [];
  const evs = evAll.filter(([d, v]) => d >= (dates[0] || '') && (!to || d <= to) && v > 0);
  let ei = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEndDay = isMonthEnd(dates, i);
    const mm = date.slice(5, 7);
    const isAprEnd = monthEndDay && mm === '04';

    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1]?.[1] ?? null, div: yearDiv, cash, invest: yearIn });
      yearNav0 = nav[i - 1]?.[1] ?? yearNav0;
      yearDiv = 0;
      yearIn = 0;
    }
    lastYear = y;

    // 定投：每个月末投一笔，设 5000 就是每月 5000
    if (i > 0 && monthlyAdd > 0 && monthEndDay && (!d0 || date >= d0)) {
      cash += monthlyAdd;
      totalIn += monthlyAdd;
      yearIn += monthlyAdd;
      flows.push([date, -monthlyAdd]);
      const p = px(date);
      const n = p > 0 ? Math.floor(cash / p / 100) * 100 : 0;
      if (n > 0) {
        shares += n;
        cash -= n * p;
        trades.push({ date, type: '定投', shares: n, price: p, amount: n * p, why: `每月定投 ${(monthlyAdd / 10000).toFixed(2)} 万` });
      }
    }

    /* 分红复投：除权除息日当天按收盘价买回（那天价格已经除过息，用不复权收盘价才对）。
       除权日撞上周末/停牌，顺延到下一个交易日——也就是这里第一次出现 date >= 除权日的位置。 */
    const divs = [];
    while (ei < evs.length && evs[ei][0] <= date) divs.push(evs[ei++]);

    for (const [xd, dps] of divs) {
      if (!(shares > 0) || !(dps > 0)) continue;
      const amt = shares * dps;
      totalDiv += amt;
      const dy = Number(String(xd).slice(0, 4));
      divByY[dy] = (divByY[dy] || 0) + amt;
      yearDiv += amt;
      cash += amt;
      holdCash += holdShares * dps;   // 对照口径：分红进现金，不投
      const p = px(date);
      const n = p > 0 ? Math.floor(cash / p / 100) * 100 : 0;
      if (n > 0) {
        shares += n;
        cash -= n * p;
        trades.push({ date, type: '分红复投', shares: n, price: p, amount: n * p, div: amt, dps, why: `${xd} 除息，每股派 ${dps.toFixed(4)}，当天买回` });
      } else {
        trades.push({ date, type: '分红', amount: amt, div: amt, dps, why: `${xd} 除息，每股派 ${dps.toFixed(4)}，不够一手留现金` });
      }
    }

    nav.push([date, shares * px(date) + cash]);
    hold.push([date, holdShares * px(date) + holdCash]);
  }

  if (lastYear != null) {
    yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[nav.length - 1]?.[1] ?? null, div: yearDiv, cash, invest: yearIn });
  }

  const end = nav.length ? nav[nav.length - 1][1] : capital;
  const endHold = hold.length ? hold[hold.length - 1][1] : capital;
  const cagrHold = capital > 0 ? annualize(endHold / capital - 1, from, to) : null;
  // 一次性投入时没有现金流，XIRR 无定义，退回复利折算
  const cagr = flows.length > 1
    ? xirr(flows.concat([[nav[nav.length - 1][0], end]]))
    : (capital > 0 ? annualize(end / capital - 1, from, to) : null);
  const retFund = totalIn > 0 ? end / totalIn - 1 : null;
  const ddStat = maxDrawdown(nav);
  const bench = o.benchmarkSeries
    ? buildBenchmark({ dates, rows: o.benchmarkSeries, capital, monthlyAdd, from, to, flows: flows.length > 1 })
    : null;
  const lowVol = o.lowVolSeries
    ? buildBenchmark({ dates, rows: o.lowVolSeries, capital, monthlyAdd, from, to, flows: flows.length > 1 })
    : null;

  // 回本：累计分红第一次 ≥ 本金 的那一年（本金口径；有定投时按首次本金算）
  let cumDiv = 0;
  let paybackYear = null;
  for (const y of yearly) { cumDiv += y.div; if (paybackYear == null && cumDiv >= capital) paybackYear = y.year; }
  // 图上三条线的终值（起点归一到 100），标题栏直接用，省得轴上再标一次
  const nav0v = nav.length ? nav[0][1] : capital;
  const lastNorm = (x) => (x && x.rows && x.rows.length && nav0v > 0 ? +((x.rows[x.rows.length - 1][1] / nav0v) * 100).toFixed(2) : null);
  // 分红增速：首末两个有分红的年份之间
  const dY = yearly.filter((y) => y.div > 0);
  const divCagr = dY.length > 1 && dY[0].year < dY[dY.length - 1].year
    ? Math.pow(dY[dY.length - 1].div / dY[0].div, 1 / (dY[dY.length - 1].year - dY[0].year)) - 1
    : null;

  return {
    code, from, to, dates, nav, navHold: hold, trades, divByY, yearly,
    totalDiv, totalIn, end, endHold, shares, cash, lastPrice: dates.length ? px(dates[dates.length - 1]) : 0,
    stats: {
      ret: capital > 0 ? end / capital - 1 : null,
      retHold: capital > 0 ? endHold / capital - 1 : null,
      retFund,
      cagr,
      cagrHold,
      mdd: ddStat.mdd,
      mddPeak: ddStat.mddPeak,
      mddTrough: ddStat.mddTrough,
      sharpe: sharpeOf(nav),
      buys: trades.filter((t) => t.type === '定投').length,
      reinvest: trades.filter((t) => t.type === '分红复投').length,
      divMissing: evs.length === 0,   // 没有派息明细：回测里一股分红都没有
      benchCagr: bench ? bench.cagr : null,
      benchEnd: bench ? bench.end : null,
      excess: bench && cagr != null && bench.cagr != null ? cagr - bench.cagr : null,
      lowVolCagr: lowVol ? lowVol.cagr : null,
      lowVolEnd: lowVol ? lowVol.end : null,
      excessLowVol: lowVol && cagr != null && lowVol.cagr != null ? cagr - lowVol.cagr : null,
      divCagr,
      paybackYear,
      navLast: nav.length && nav0v > 0 ? +((nav[nav.length - 1][1] / nav0v) * 100).toFixed(2) : null,
      benchLast: lastNorm(bench),
      lowVolLast: lastNorm(lowVol),
      years: daysBetween(from, to) / 365.25,
    },
    bench,
    lowVol,
    mode: 'invest',
  };
}
