/**
 * 回测引擎（纯函数，无 DOM）。
 *
 * 计划模式：每年 4 月最后一个交易日，用「上一年度每股分红 / 4 月收盘价」算股息率，
 * 过滤后取股息率最高的 N 只等权买入，持有到次年 4 月调仓。
 *
 * 约定：
 *  - 价格用不复权月末收盘（data/monthly.json）
 *  - 分红用年度每股分红（data/baseline.json dividends），持有期按 12 个月均摊
 *  - 交易成本按换手率双边计
 *  - 基准为指数月末收盘（data/benchmark.json）
 */

const YM = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

export function toPriceIndex(months) {
  const out = new Map();
  for (const [code, rows] of Object.entries(months)) {
    out.set(code, new Map(rows));
  }
  return out;
}

function isST(name = '') {
  return /ST|退/.test(name);
}

/** 某年某月的价格 */
export function priceAt(prices, code, ym) {
  return prices.get(code)?.get(ym) ?? null;
}

/** 两个 ym 之间隔了几个月 */
function monthsBetween(a, b) {
  const [ay, am] = String(a).split('-').map(Number);
  const [by, bm] = String(b).split('-').map(Number);
  return (by * 12 + bm) - (ay * 12 + am);
}

/** code 在 ym 之前是否有至少 n 个月的价格数据（上市满 n 个月）
 *
 * 用「最早一条到 ym 的月份差」判断，不用「条数」：组合对比为了省流量，
 * 选股只喂每年 4 月末的价格（稀疏），按条数会数成「上市满 24 年」，
 * 把全市场筛空。月份差对完整月线和稀疏月线都成立。 */
function hasHistory(prices, code, ym, n = 24) {
  const m = prices.get(code);
  if (!m || !m.size) return false;
  const first = m.keys().next().value;
  if (!first) return false;
  return monthsBetween(first, ym) >= n;
}

/** 上一年度每股分红 */
function dpsPrevYear(divs, code, year) {
  return divs[code]?.years?.[year - 1] ?? null;
}

/** 连续分红年数（截至 year-1，向前数） */
function consecutiveDivYears(divs, code, year) {
  const years = divs[code]?.years || {};
  let n = 0;
  for (let y = year - 1; y >= year - 30; y--) {
    if (years[y] > 0) n++;
    else break;
  }
  return n;
}

/**
 * 选股：给定调仓年月，返回按股息率降序的候选。
 * 返回 [{code, name, dy, price, dps}]
 */
export function selectCandidates({ baseline, prices, ym, year, params, finHistory }) {
  const { pool, dividends } = baseline;
  // 财报没了就别筛：空对象也是「真值」，以前 `!!finHistory` 会把「拉失败」当成「有财报」，
  // 于是每只股票都在 `if (!fin) continue` 上被筛掉，策略静默变成空组合（99.9 万 / -0.0%）。
  const useQuality = params.quality !== false && finHistory && Object.keys(finHistory).length > 0;
  const out = [];
  for (const code of Object.keys(pool)) {
    const info = pool[code];
    if (!info) continue;
    if (isST(info.n)) continue;
    const price = priceAt(prices, code, ym);
    if (!price || price <= 0) continue;
    if (!hasHistory(prices, code, ym, params.minHistoryMonths ?? 24)) continue;
    const dps = dpsPrevYear(dividends, code, year);
    if (!(dps > 0)) continue;
    if (consecutiveDivYears(dividends, code, year) < (params.minDivYears ?? 3)) continue;
    const dy = (dps / price) * 100;
    if (dy < (params.minDy ?? 4)) continue;
    // 股息率上限：不是「越高越好」。研究见 tools/research/README.md 发现二：
    // 5%–6.5% 是最甜的一段，8% 以上多半是市场在说「这次分红不可持续」。
    // 不设这个上限时，2024 年这一期会被 10%+ 的煤炭/地产吸进去，单年跑输 16 个百分点。
    if (dy > (params.maxDy ?? 15)) continue;
    if (useQuality) {
      const rows = finHistory[code] || [];
      const fin = rows.find((r) => r[0] === year - 1);
      if (!fin) continue;
      const [, eps, roe, , , ocfps] = fin;
      if (!(eps > 0)) continue;
      const payout = (dps / eps) * 100;
      if (payout >= (params.maxPayout ?? 85)) continue;
      if (payout < (params.minPayout ?? 0)) continue;
      const cover = ocfps / eps;
      if (cover < (params.minCover ?? 0.7)) continue;
      if (roe != null && roe < (params.minRoe ?? 5)) continue;
    }
    out.push({ code, name: info.n, dy, price, dps });
  }
  out.sort((a, b) => b.dy - a.dy);
  return out;
}

/**
 * 按行业上限取前 n 只。
 * 高股息股容易扎堆在同一个周期行业（2022—2024 年就是一水儿的煤炭钢铁），
 * 单押一个行业的回撤会明显放大，所以这里限制同一行业最多取几只。
 */
export function pickWithIndCap(cand, holdN, indCap, pool = {}) {
  if (!indCap || indCap <= 0) return cand.slice(0, holdN);
  const byInd = new Map();
  const out = [];
  for (const x of cand) {
    const ind = pool[x.code]?.ind || '其他';
    const n = byInd.get(ind) || 0;
    if (n >= indCap) continue;
    byInd.set(ind, n + 1);
    out.push(x);
    if (out.length >= holdN) break;
  }
  return out;
}

/** 等权或股息率加权 */
function weightsFor(list, mode) {
  if (mode === 'dy') {
    const sum = list.reduce((s, x) => s + x.dy, 0);
    return list.map((x) => x.dy / sum);
  }
  const w = 1 / list.length;
  return list.map(() => w);
}

/**
 * 运行计划回测。
 * @param {object} opts
 * @param {object} opts.baseline {pool, dividends}
 * @param {object} opts.months   {code: [[ym, close]]}  净值用的完整月线（只需覆盖会被选中的股票）
 * @param {object} [opts.screenMonths] {code: [[ym, close]]} 选股用的价格，可以稀疏（只给每年 4 月末）
 * @param {object} opts.benchmark {ym: value}
 * @param {object} opts.params  {startYear, endYm, holdN, minDy, minDivYears, weight, cost}
 */
export function runPlanBacktest({ baseline, months, screenMonths = null, benchmark = {}, params = {}, finHistory = null }) {
  const p = {
    startYear: 2013,
    endYm: '2026-10',
    holdN: 20,
    minDy: 4,
    minDivYears: 3,
    weight: 'equal',
    cost: 0.001,
    ...params,
  };
  // 选股可以只看每年 4 月末的价（省流量），净值得用完整月线（回撤才对）
  const prices = toPriceIndex(screenMonths || months);
  const fullPrices = toPriceIndex(months);
  const rebalanceYm = (y) => YM(y, 4);

  // 预计算每月末列表
  const monthList = [];
  for (let y = p.startYear; y <= Number(p.endYm.slice(0, 4)); y++) {
    const endM = y === Number(p.endYm.slice(0, 4)) ? Number(p.endYm.slice(5, 7)) : 12;
    for (let m = 1; m <= endM; m++) monthList.push(YM(y, m));
  }

  let nav = 1;
  const navSeries = [];
  const periods = [];
  const trades = [];
  let current = null; // {ym, items:[{code, weight, dps, price}], year}
  let prevNav = 1;
  let navOwned = 1;
  let totalTurnover = 0;

  for (let i = 0; i < monthList.length; i++) {
    const ym = monthList[i];
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));

    // 调仓：每年 4 月
    if (m === 4 && y >= p.startYear) {
      const cand = selectCandidates({ baseline, prices, ym, year: y, params: p, finHistory });
      const picked = pickWithIndCap(cand, p.holdN, p.indCap ?? 0, baseline.pool);
      const ws = weightsFor(picked, p.weight);
      const items = picked.map((x, j) => ({ code: x.code, name: x.name, weight: ws[j], dy: x.dy, dps: x.dps, price: x.price }));

      if (current) {
        const oldMap = new Map(current.items.map((x) => [x.code, navOwned > 0 ? (x.shares * (x.lastPx || x.price)) / navOwned : 0]));
        const newMap = new Map(items.map((x) => [x.code, x.weight]));
        let turnover = 0;
        for (const [c, w] of oldMap) turnover += Math.max(0, w - (newMap.get(c) || 0));
        for (const [c, w] of newMap) turnover += Math.max(0, w - (oldMap.get(c) || 0));
        turnover = turnover / 2; // 单边换手
        totalTurnover += turnover;
        nav *= 1 - turnover * p.cost * 2;
        trades.push({ ym, turnover, sold: current.items.filter((x) => !newMap.has(x.code)).map((x) => x.code), bought: items.filter((x) => !oldMap.has(x.code)).map((x) => x.code) });
      } else {
        nav *= 1 - p.cost; // 建仓
        totalTurnover += 1;
      }
      // 按份数买入，之后一路持有到底——不做月度再平衡。
      // 以前这里是「每月把权重摊回等权」，等于隐含每月调仓一次：2021/2023/2025 这种
      // 分化年份会系统性跑输真实持有 10 个百分点以上，跑赢跑输都能翻向。
      for (const it of items) it.shares = (it.weight * nav) / it.price;
      navOwned = nav;
      current = { ym, year: y, items };
      periods.push({ ym, items: items.map((x) => ({ code: x.code, name: x.name, dy: x.dy })) });
    }

    // 月净值：份额 × 月末价；分红按上一年度均摊到 12 个月再投入
    if (current && i > 0) {
      const prevYm = monthList[i - 1];
      let v = 0;
      let live = 0;
      for (const it of current.items) {
        if (!(it.shares > 0)) continue;
        const p1 = priceAt(fullPrices, it.code, ym);
        const px = p1 || it.lastPx || it.price;
        if (!(px > 0)) continue;
        live += it.shares * px;
        const dps = dpsPrevYear(baseline.dividends, it.code, current.year);
        if (p1 && dps > 0) it.shares += (it.shares * dps) / 12 / p1;
        it.lastPx = px;
        v += it.shares * px;
      }
      // 全部成分股都停牌/缺数据时不更新净值，避免凭空归零
      if (live > 0) { prevNav = nav; nav = v; }
    }

    navSeries.push({ ym, nav });
    if (current && m === 12) {
      const yearStartIdx = navSeries.findIndex((x) => x.ym === YM(y - 1, 12));
      if (yearStartIdx >= 0) {
        // 留待 yearly 汇总
      }
    }
  }

  // 年度收益
  const yearly = [];
  for (let y = p.startYear; y <= Number(p.endYm.slice(0, 4)); y++) {
    const a = y === p.startYear ? 1 : navSeries.find((x) => x.ym === YM(y - 1, 12))?.nav;
    const b = navSeries.find((x) => x.ym === YM(y, 12))?.nav ?? navSeries[navSeries.length - 1].nav;
    if (a && b) yearly.push({ year: y, ret: b / a - 1 });
  }

  const total = nav - 1;
  const monthsCount = navSeries.length - 1;
  const yearsCount = monthsCount / 12;
  const cagr = yearsCount > 0 ? Math.pow(nav, 1 / yearsCount) - 1 : null;

  // 最大回撤
  let peak = navSeries[0]?.nav ?? 1, peakYm = navSeries[0]?.ym ?? '';
  let mdd = 0, mddPeak = '', mddTrough = '';
  for (const pt of navSeries) {
    if (pt.nav > peak) { peak = pt.nav; peakYm = pt.ym; }
    const dd = pt.nav / peak - 1;
    if (dd < mdd) { mdd = dd; mddPeak = peakYm; mddTrough = pt.ym; }
  }

  // 月度收益序列 -> 夏普
  const rets = [];
  for (let i = 1; i < navSeries.length; i++) rets.push(navSeries[i].nav / navSeries[i - 1].nav - 1);
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sharpe = sd > 0 ? ((mean * 12 - 0.02) / (sd * Math.sqrt(12))) : null;

  // 基准
  const benchSeries = [];
  for (const pt of navSeries) {
    const v = benchmark[pt.ym];
    if (Number.isFinite(v)) benchSeries.push({ ym: pt.ym, v });
  }
  let benchTotal = null, benchCagr = null, benchMdd = null;
  if (benchSeries.length > 1) {
    benchTotal = benchSeries[benchSeries.length - 1].v / benchSeries[0].v - 1;
    benchCagr = Math.pow(1 + benchTotal, 12 / (benchSeries.length - 1)) - 1;
    let bp = benchSeries[0].v, bmdd = 0;
    for (const x of benchSeries) { bp = Math.max(bp, x.v); bmdd = Math.min(bmdd, x.v / bp - 1); }
    benchMdd = bmdd;
  }

  return {
    nav: navSeries,
    yearly,
    periods,
    trades,
    benchmark: benchSeries,
    stats: {
      total,
      cagr,
      mdd,
      mddPeak,
      mddTrough,
      sharpe,
      turnover: totalTurnover / Math.max(1, periods.length),
      years: yearsCount,
      benchTotal,
      benchCagr,
      benchMdd,
      excess: benchTotal != null ? total - benchTotal : null,
    },
    params: p,
  };
}
