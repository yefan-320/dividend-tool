/**
 * 市场数据适配（纯函数）：把日 K + 月线拼成「按日期可查」的序列。
 *
 * 约定：
 *  - 日 K 为不复权收盘；月线也是不复权月末收盘
 *  - 日 K 覆盖 2018-07 之后；更早的区间用月线补齐（阶梯）
 *  - 价格查询：取「不晚于该日」的最近一个点
 */

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
  return ans >= 0 ? closes[ans] : null;
}

/**
 * 回测日历：优先用指数日线日期，不足时补月线月末 + 日 K 日历。
 * @returns {string[]}
 */
export function buildTradingDates({ indexRows = [], dailyCal = [], monthly = {}, from, to }) {
  const set = new Set();
  for (const [d] of indexRows) if (d >= from && d <= to) set.add(d);
  for (const d of dailyCal) if (d >= from && d <= to) set.add(d);
  // 月线兜底（没有日线时）
  if (!set.size) {
    for (const rows of Object.values(monthly)) {
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

/** 年化（按自然日） */
export function annualize(totalRet, from, to) {
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!(days > 0)) return null;
  return Math.pow(1 + totalRet, 365.25 / days) - 1;
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

/** XIRR（现金流资金加权年化） */
export function xirr(flows) {
  if (!flows || flows.length < 2) return null;
  const t0 = Date.parse(flows[0][0]);
  const ts = flows.map(([d, a]) => [(Date.parse(d) - t0) / 86400000 / 365.25, a]);
  let r = 0.1;
  for (let i = 0; i < 80; i++) {
    let f = 0;
    let df = 0;
    for (const [x, a] of ts) {
      const p = Math.pow(1 + r, x);
      f += a / p;
      df += (-x * a) / (p * (1 + r));
    }
    if (df === 0) break;
    const nr = r - f / df;
    if (!Number.isFinite(nr) || nr <= -1) break;
    if (Math.abs(nr - r) < 1e-9) { r = nr; break; }
    r = nr;
  }
  return r;
}
