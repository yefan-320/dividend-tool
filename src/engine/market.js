import { xirr as financeXirr } from './finance.js';

/**
 * 市场数据适配（纯函数）：把日 K + 月线拼成「按日期可查」的序列。
 *
 * 约定：
 *  - 日 K 为不复权收盘；月线也是不复权月末收盘
 *  - 日 K 覆盖 2018-07 之后；更早的区间用月线补齐（阶梯）
 *  - 价格查询：取「不晚于该日」的最近一个点
 */

/** 闲置现金日利率：名义年息 1.5%，按日复利（实际年化 1.5113%） */
export const CASH_DAY_RATE = 0.015 / 365;

/**
 * 自然日差（非负，取整到天）。用于现金计息、回撤天数、持仓天数。
 * 年化不走这里（annualize 要连续时间）；非法日期串会得 NaN 并一路穿透，调用方须保证入参合法。
 */
export function daysBetween(a, b) {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
}

/** 月末日期占位（字符串可比较；倒推时用） */
export function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * 单只股票的合并序列：月线（早期）+ 日 K（晚期）。
 * @param {object} opts
 * @param {string[]} opts.cal       日 K 日历
 * @param {object} opts.daily       {c:[...]} 与 cal 对齐的收盘
 * @param {Array} opts.monthly      [[ym, close], ...]
 */
export function buildSeries({ cal, daily, monthly }) {
  const dates = [];
  const closes = [];
  const dailyStart = cal && cal.length ? cal[0] : null;
  for (const [ym, close] of monthly || []) {
    if (!(close > 0)) continue;
    const d = monthEnd(ym);
    if (dailyStart && d >= dailyStart) continue;
    dates.push(d);
    closes.push(close);
  }
  if (cal && daily && daily.c) {
    for (let i = 0; i < cal.length; i++) {
      const c = daily.c[i];
      if (c == null || !(c > 0)) continue;
      dates.push(cal[i]);
      closes.push(c);
    }
  }
  return { dates, closes };
}

/**
 * 合并序列里「不晚于 date」的最近收盘价。
 * @returns {number|null}
 */
export function priceAt(series, date) {
  if (!series || !series.dates.length) return null;
  const { dates, closes } = series;
  if (date < dates[0]) return null;
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans < 0) return null;
  /* 停牌 / 数据缺口的空值（null）往前找最近一个有效价。
     以前直接返回 null，下游 shares × null = 0，净值一天之内从 95 万掉到 745 块，
     再顺手把最大回撤算成 -99.9%。一只股票只要有几天数据是空的，回测就废了。 */
  for (let i = ans; i >= 0; i--) {
    const v = closes[i];
    if (v > 0) return v;
  }
  return null;
}

/**
 * 回测日历：优先用指数日线日期，不足时补月线月末 + 日 K 日历。
 * @returns {string[]}
 */
export function buildTradingDates({ indexRows = [], dailyCal = [], monthly = {}, from, to }) {
  const set = new Set();
  for (const [d] of indexRows) if (d >= from && d <= to) set.add(d);
  for (const d of dailyCal) if (d >= from && d <= to) set.add(d);
  // 月线兜底（没有日线时）；月线按需加载，没拉时是 null
  if (!set.size) {
    for (const rows of Object.values(monthly || {})) {
      for (const [ym] of rows) {
        const d = monthEnd(ym);
        if (d >= from && d <= to) set.add(d);
      }
    }
  }
  return [...set].sort();
}

/** 该日期是否当月最后一个交易日（按月追加/分红到账用） */
export function isMonthEnd(dates, i) {
  const d = dates[i];
  const next = dates[i + 1];
  return !next || next.slice(0, 7) !== d.slice(0, 7);
}

/** 某年某月最后交易日 */
export function lastDateOfMonth(dates, ym) {
  let hit = null;
  for (const d of dates) {
    if (d.slice(0, 7) === ym) hit = d;
    else if (d > ym + '-31') break;
  }
  return hit;
}

/** 上一年度每股分红 */
export function prevDps(dividends, code, year) {
  const v = dividends?.[code]?.years?.[year - 1];
  return v > 0 ? v : 0;
}

/** 财务质量（用 year 年报）：返回 {ok, why} */
export function qualityOf(finHistory, code, year) {
  const rows = finHistory?.[code] || [];
  const hit = rows.find((r) => r[0] === year);
  if (!hit) return { ok: false, why: '缺财报' };
  const [, eps, roe, , , ocfps] = hit;
  if (!(eps > 0)) return { ok: false, why: '亏损' };
  if (roe != null && roe < 5) return { ok: false, why: 'ROE 偏低' };
  if (ocfps != null && eps > 0 && ocfps / eps < 0.7) return { ok: false, why: '现金流覆盖不足' };
  return { ok: true, why: '' };
}

/** 股息率、支付率（用 year 年报） */
export function dyQuality({ dividends, finHistory, code, year, price }) {
  const dps = prevDps(dividends, code, year);
  if (!(dps > 0) || !(price > 0)) return { dy: null, payout: null, cover: null };
  const dy = (dps / price) * 100;
  const rows = finHistory?.[code] || [];
  const fin = rows.find((r) => r[0] === year - 1);
  const eps = fin ? fin[1] : null;
  const ocfps = fin ? fin[5] : null;
  return {
    dy,
    payout: eps > 0 ? (dps / eps) * 100 : null,
    cover: eps > 0 && ocfps != null ? ocfps / eps : null,
  };
}

/** 年化（按自然日）；totalRet 非有限时返回 null（capital=0 等无意义输入） */
export function annualize(totalRet, from, to) {
  if (!Number.isFinite(totalRet)) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!(days > 0)) return null;
  const v = Math.pow(1 + totalRet, 365.25 / days) - 1;
  return Number.isFinite(v) ? v : null;
}

/** 最大回撤 */
export function maxDrawdown(rows) {
  let peak = null;
  let peakDate = '';
  let mdd = 0;
  let mddPeak = '';
  let mddTrough = '';
  for (const [d, v] of rows) {
    if (peak == null || v > peak) {
      peak = v;
      peakDate = d;
    }
    const dd = peak > 0 ? v / peak - 1 : 0;
    if (dd < mdd) {
      mdd = dd;
      mddPeak = peakDate;
      mddTrough = d;
    }
  }
  return { mdd, mddPeak, mddTrough };
}

/**
 * 单位净值（TWR）推进一格：外部流入按「流入前净值」增发份额。
 * 总资产 nav 含月追加，拿来算回撤会把 -34.5% 稀释成 -23.8%（追加 2 万/月就能做到），
 * 回撤 / 夏普必须走这条曲线。分红复投、再平衡是内部行为，不动份额。
 */
export function stepUnits(units, v, extIn) {
  if (!(units > 0)) return { units: v > 0 ? v : 1, unitNav: 1 };
  let u = units;
  if (extIn > 0) {
    const perUnit = (v - extIn) / u;   // 流入前的单位净值
    if (perUnit > 0) u += extIn / perUnit;
  }
  return { units: u, unitNav: u > 0 ? v / u : null };
}

/**
 * 回撤事件序列：把净值曲线切成一段段「从新高跌下去、再爬回新高」。
 * 只有一个「最大回撤」看不出持有体验——跌了几次、每次多久见底、现在是否还在水下，才是用户要判断的。
 */
export function drawdownEpisodes(rows, minDepth = 0.03) {
  const out = [];
  if (!Array.isArray(rows) || rows.length < 2) return out;
  let peakV = -Infinity;
  let peakDate = rows[0][0];
  let troughV = Infinity;
  let troughDate = null;
  let running = false;

  const close = (recoverDate) => {
    if (!running || troughDate == null) { running = false; return; }
    const depth = troughV / peakV - 1;
    if (depth <= -minDepth) {
      out.push({
        peak: peakDate, peakV, trough: troughDate, troughV, depth,
        recover: recoverDate || null,
        downDays: daysBetween(peakDate, troughDate),
        upDays: recoverDate ? daysBetween(troughDate, recoverDate) : daysBetween(troughDate, rows[rows.length - 1][0]),
        ongoing: !recoverDate,
      });
    }
    running = false;
  };

  for (const [d, v] of rows) {
    if (!Number.isFinite(v)) continue;
    if (v >= peakV) {
      close(d);
      // 峰值日期只在「真的刷新高」时移动：等于前高算恢复，不算新高，
      // 否则 maxDrawdown 报 2021-05-26、这里报 2021-05-28，同一段回撤两个日期
      if (v > peakV) { peakV = v; peakDate = d; }
      troughV = Infinity;
      troughDate = null;
    } else {
      running = true;
      if (v < troughV) { troughV = v; troughDate = d; }
    }
  }
  close(null);
  return out;
}

/**
 * 回撤报告：episodes + 「跌的时候分红填掉多少」。
 * 填坑率走单位净值口径（每份净值分红 ÷ 峰值单位净值 ÷ 跌幅）；用金额算会被追加稀释。
 */
export function ddReport(unitRows, divPU = [], divEvents = []) {
  const episodes = drawdownEpisodes(unitRows, 0.03);
  const cumAt = (rows, d) => {
    let v = 0;
    for (const [x, y] of rows) { if (x <= d) v = y; else break; }
    return v;
  };
  const unitAt = (d) => unitRows.find(([x]) => x === d)?.[1] ?? 1;
  const lastV = unitRows.length ? unitRows[unitRows.length - 1][1] : null;
  for (const e of episodes) {
    // 还没爬回来的段：现在离前高还有多远，这比一个「未修复」标签有用
    e.nowDepth = e.ongoing && lastV != null && e.peakV > 0 ? lastV / e.peakV - 1 : null;
    const got = cumAt(divPU, e.trough) - cumAt(divPU, e.peak);
    const peakUnit = unitAt(e.peak) || 1;
    e.fill = e.depth < 0 && peakUnit > 0 ? got / peakUnit / Math.abs(e.depth) : null;
    e.divPerUnit = got;
    e.divReal = divEvents
      .filter((x) => x.date >= e.peak && x.date <= e.trough)
      .reduce((a, x) => a + (x.amount || 0), 0);
  }
  return episodes;
}

/** 日收益夏普（年化） */
export function sharpeOf(rows, riskFree = 0.02) {
  if (!rows || rows.length < 3) return null;
  const rets = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1][1];
    const b = rows[i][1];
    if (a > 0) rets.push(b / a - 1);
  }
  if (!rets.length) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  if (!(sd > 0)) return null;
  return ((mean * 252 - riskFree) / (sd * Math.sqrt(252)));
}

/**
 * XIRR（现金流资金加权年化）。输入沿用回测内部的 [[date, amount], ...] 形式，
 * 口径与 engine/finance.js 的 xirr([{date, amount}]) 完全一致（过滤非法流、无解返回 null）。
 */
export function xirr(flows) {
  if (!Array.isArray(flows) || flows.length < 2) return null;
  const objFlows = flows.map((f) => (Array.isArray(f) ? { date: f[0], amount: f[1] } : f));
  return financeXirr(objFlows);
}
