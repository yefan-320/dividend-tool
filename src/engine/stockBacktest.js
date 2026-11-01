/**
 * 单股回测引擎（纯函数，无 DOM）。
 *
 * 规则（每个 4 月末 / 12 月末决策一次，日级估值）：
 *  - 买入：股息率 ≥ minDy，且质量过关（不亏损、支付率 <85%、现金流覆盖 ≥0.7、ROE ≥5）
 *  - 卖出：质量不过关（亏损 / 现金流覆盖不足 / 支付率过高）或分红下调 ≥5%
 *  - 分红：每年 4 月末到账（上一年度每股分红 × 持股），进现金
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
    code, dates, series, dividends = {}, finHistory = {},
    capital = 1000000, monthlyAdd = 0, minDy = 5, benchmarkSeries = null, from, to,
    useQuality = true,   // false = 只看走势，不拿财报做质量筛选（也就不需要下财报）
  } = o;
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

    // 分红到账
    if (isAprEnd) {
      const dps = prevDps(dividends, code, y);
      if (dps > 0 && shares > 0) {
        const amt = shares * dps;
        cash += amt;
        divByY[y] = (divByY[y] || 0) + amt;
        yearDiv += amt;
        trades.push({ date, type: '分红', amount: amt, dps, why: `${y - 1} 年度分红到账` });
      }
      // 买入持有对照同样拿分红（现金，不买入）
      if (dps > 0 && holdShares > 0) holdCash += holdShares * dps;
    }

    // 月追加
    if (monthlyAdd > 0 && (isAprEnd || isDecEnd)) {
      const amt = monthlyAdd * 6;
      cash += amt;
      yearAdds += amt;
      flows.push([date, amt]);
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
