/**
 * 基础金融计算（纯函数，无依赖，可在浏览器/Node 共用）
 */

/** 把百分比/小数统一成小数 */
export const asRate = (v) => (v > 1.5 ? v / 100 : v);

/**
 * XIRR：给定现金流 [{date:'YYYY-MM-DD', amount:number}]，求年化内部收益率。
 * 买入为负、分红/卖出为正。用 Newton 迭代，失败回退二分。
 * 返回小数（0.083 表示 8.3%），无解返回 null。
 */
export function xirr(flows, guess = 0.1) {
  const list = flows
    .filter((f) => f && Number.isFinite(f.amount) && f.amount !== 0 && f.date)
    .map((f) => ({ t: Date.parse(f.date), amount: f.amount }))
    .filter((f) => Number.isFinite(f.t));
  if (list.length < 2) return null;
  const t0 = Math.min(...list.map((f) => f.t));
  const years = list.map((f) => (f.t - t0) / (365.25 * 86400000));
  if (Math.max(...years) <= 0) return null;

  const npv = (r) => list.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, years[i]), 0);
  const dnpv = (r) =>
    list.reduce((s, f, i) => s - (years[i] * f.amount) / Math.pow(1 + r, years[i] + 1), 0);

  let r = guess;
  for (let i = 0; i < 100; i++) {
    const v = npv(r);
    if (Math.abs(v) < 1e-7) return r;
    const d = dnpv(r);
    if (!Number.isFinite(d) || Math.abs(d) < 1e-12) break;
    const next = r - v / d;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-9) return next;
    r = next;
  }

  // 二分兜底：在 (-0.999, 10) 找符号变化
  let lo = -0.999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** 简单年化：把区间收益率换算成年化（复利） */
export function annualize(rate, days) {
  if (!Number.isFinite(rate) || !Number.isFinite(days) || days <= 0) return null;
  if (1 + rate <= 0) return -1;
  return Math.pow(1 + rate, 365.25 / days) - 1;
}

/** 年化波动率（日/月收益序列） */
export function stdev(returns) {
  const a = returns.filter(Number.isFinite);
  if (a.length < 2) return null;
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const v = a.reduce((s, x) => s + (x - mean) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}

/** 夏普：年化收益 - 无风险 / 年化波动 */
export function sharpe(returns, rf = 0.02, periodsPerYear = 12) {
  const sd = stdev(returns);
  if (!sd) return null;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  return ((mean * periodsPerYear - rf) / (sd * Math.sqrt(periodsPerYear)));
}

/** 最大回撤：输入净值序列 [{date, nav}] 或数字数组，返回 { mdd, peak, trough } */
export function maxDrawdown(navs) {
  const list = navs.map((v) => (typeof v === 'number' ? v : v.nav)).filter(Number.isFinite);
  if (list.length < 2) return { mdd: 0, peakIdx: 0, troughIdx: 0 };
  let peak = list[0], peakIdx = 0, mdd = 0, troughIdx = 0, bestPeak = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i] > peak) { peak = list[i]; peakIdx = i; }
    const dd = list[i] / peak - 1;
    if (dd < mdd) { mdd = dd; troughIdx = i; bestPeak = peakIdx; }
  }
  return { mdd, peakIdx: bestPeak, troughIdx };
}

/** 复利累计：把收益率序列 [r1, r2, ...] 变成净值 */
export function navFromReturns(returns, start = 1) {
  let nav = start;
  return [nav, ...returns.map((r) => (nav *= 1 + r))];
}

/** 按年月分组计算月度收益 */
export function monthlyReturns(points) {
  // points: [{ date:'YYYY-MM', value:number }]，返回 [{month, ret}]
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].value, b = points[i].value;
    if (a > 0) out.push({ month: points[i].date, ret: b / a - 1 });
  }
  return out;
}
