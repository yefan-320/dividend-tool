/**
 * 差分测试扩展：方案执行清单 + staged/dip 建仓 + 月追加（differential testing）。
 *
 * 原则：
 *  - 参考实现只 import 引擎顶层入口，按 src 注释口径独立重写；不复用 src 内部函数，避免同错。
 *  - 固定夹具（不依赖当前日期）；容差：相对 1e-6，金额 round 到分处允许 0.01 元。
 *
 * 覆盖：
 *  A. engine/plan.js planActionRows：目标金额/差额/建议整手股数/买卖方向/现金计划/分批预算/
 *     dip 门槛未触发不买/方案外持仓/权重 Now。
 *     口径来源：src/engine/plan.js:38-46（entry 归一化）、:183-210（stagedBudget/triggerPrice/lastDpsOf）、
 *               :212-240（estimatePlanDiv）、:254-350（planActionRows）。
 *  B. engine/portfolioBacktest.js staged：逐月 nav/comp 现金/installments(date,amount)/end、
 *     预留本金不被分红/追加花掉、期数超出区间月末时只投可用期数。
 *  C. 同文件 dip：已知 DPS 口径（4 月前 Y-2 / 4 月后 Y-1）、minDy 门槛、目标权重补仓、只买不卖、
 *     triggered/neverTriggered/pending、买入事件 why。
 *  D. once + monthlyAdd>0：4/12 月末各入 6 个月、totalIn/yearly.invest/end/cagr（XIRR 独立求解）。
 *     口径来源：src/engine/portfolioBacktest.js:85-110、:245-256、:376-404、:418-448、:452-508、
 *               :513-538、:552-608、:617-683、:680-706、:185-215；
 *               src/engine/market.js:139-148（annualize）、:188-207（xirr）。
 *
 * 运行：cd 红利工具 && node --test test/*.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planActionRows } from '../src/engine/plan.js';
import { runPortfolioBacktest } from '../src/engine/portfolioBacktest.js';

/* ---------------- 工具 ---------------- */
const DAY_RATE = 0.015 / 365;
const MS = 86400000;
const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / MS));
const isMonthEndRef = (dates, i) => !dates[i + 1] || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7);
const prevDpsRef = (divs, code, year) => { const v = divs?.[code]?.years?.[year - 1]; return v > 0 ? v : 0; };
function priceAtRef(series, date) {
  if (!series || !series.dates.length) return null;
  let v = null;
  for (let i = 0; i < series.dates.length; i++) { if (series.dates[i] <= date) v = series.closes[i]; else break; }
  return v;
}
function assertClose(a, e, msg, rel = 1e-6, abs = 0) {
  const d = Math.abs(a - e), tol = Math.max(abs, rel * Math.abs(e));
  if (!(d <= tol)) throw new Error(`${msg}: 期望 ${e} 实际 ${a} 差 ${d}`);
}
const clone = (x) => structuredClone(x);
function monthEndDates(y0, y1) {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let m = 1; m <= 12; m++) {
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(dim).padStart(2, '0')}`);
  }
  return out;
}

/* ---------------- 参考实现 A：planActionRows ---------------- */
const LOT = 100;
const ENTRY_MODES = ['once', 'staged', 'dip'];
const toNum = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
function refNormalizeEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const months = Math.round(Math.min(60, Math.max(1, toNum(e.months, 12)))) || 12;
  const minDy = Math.round(Math.min(20, Math.max(0, toNum(e.minDy, 5.5))) * 100) / 100;
  return { mode: ENTRY_MODES.includes(e.mode) ? e.mode : 'once', months, minDy };
}
function refLastDpsOf(divEntry) {
  const years = divEntry?.years || {};
  const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
  return ys.length ? years[ys[ys.length - 1]] : null;
}
function refTriggerPrice(dps, minDy) {
  const d = toNum(dps, 0), t = toNum(minDy, 0);
  if (!(d > 0) || !(t > 0)) return null;
  return d / (t / 100);
}
function refStockTotal(plan) { return (plan?.holdings || []).reduce((s, h) => s + (Number(h.weight) || 0), 0); }
function refStockAmount(plan) { const cap = Math.max(0, Number(plan?.capital) || 0); return cap * (refStockTotal(plan) / 100); }
function refStagedBudget(plan) {
  const e = refNormalizeEntry(plan?.entry);
  if (e.mode !== 'staged') return refStockAmount(plan);
  return refStockAmount(plan) / Math.max(1, e.months);
}
function refEstimateDiv(plan, quotes, dividends) {
  const capital = Math.max(0, Number(plan?.capital) || 0);
  let annualDiv = 0;
  for (const h of plan?.holdings || []) {
    const price = toNum(quotes[h.code]?.p, 0);
    const dps = toNum(refLastDpsOf(dividends[h.code]), 0);
    const amount = capital * (Number(h.weight) || 0) / 100;
    if (price > 0) annualDiv += (amount / price) * dps;
  }
  const stockAmount = refStockAmount(plan);
  return {
    annualDiv,
    dyOnStock: stockAmount > 0 ? (annualDiv / stockAmount) * 100 : null,
    dyOnCapital: capital > 0 ? (annualDiv / capital) * 100 : null,
  };
}
function refPlanActionRows({ plan, positions = new Map(), quotes = {}, dividends = {}, buyCap = null }) {
  const posOf = (code) => toNum(positions instanceof Map ? positions.get(code) : positions?.[code], 0);
  const entry = refNormalizeEntry(plan?.entry);
  const capital = Number(plan?.capital) || 0;
  const rows = (plan?.holdings || []).map((h) => {
    const price = toNum(quotes[h.code]?.p, 0);
    const target = capital * (Number(h.weight) || 0) / 100;
    const shares = posOf(h.code);
    const current = shares * price;
    const delta = target - current;
    const sugLots = price > 0 ? Math.floor(Math.abs(delta) / (price * LOT)) : 0;
    const sugShares = sugLots * LOT;
    const side = delta > 0.5 ? 'buy' : delta < -0.5 ? 'sell' : 'hold';
    const dps = toNum(refLastDpsOf(dividends[h.code]), 0);
    const dy = price > 0 && dps > 0 ? (dps / price) * 100 : null;
    const trig = refTriggerPrice(dps, entry.minDy);
    const triggered = entry.mode === 'dip' ? dy != null && dy >= entry.minDy : true;
    return {
      code: h.code, weight: Number(h.weight) || 0, price, target, shares, current, delta, side, sugShares,
      sugSide: sugShares > 0 ? side : 'hold', dps, dy, triggerPrice: trig, triggered,
      gapToTrigger: trig && price > 0 ? ((price - trig) / price) * 100 : null, weightNow: 0,
    };
  });
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
  const outsideValue = outside.reduce((s, r) => s + r.value, 0);
  const totalNow = currentStock + outsideValue;
  for (const r of rows) r.weightNow = totalNow > 0 ? (r.current / totalNow) * 100 : 0;
  const buyAmount = rows.filter((r) => r.delta > 0.5).reduce((s, r) => s + r.delta, 0);
  const sellAmount = rows.filter((r) => r.delta < -0.5).reduce((s, r) => s + -r.delta, 0);
  if (entry.mode === 'dip') for (const r of rows) if (!r.triggered) { r.sugShares = 0; r.sugSide = 'hold'; }
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
  const divEst = refEstimateDiv(plan, quotes, dividends);
  return {
    rows,
    outside,
    summary: {
      capital, targetStock, cashPlan: Math.max(0, capital - targetStock), currentStock, outsideValue, totalNow,
      buyAmount, sellAmount, annualDiv: divEst.annualDiv, dyOnStock: divEst.dyOnStock, dyOnCapital: divEst.dyOnCapital,
      stagedBudget: refStagedBudget(plan), entry,
    },
  };
}

/* ---------------- 参考实现 B/C/D：组合回测（once/staged/dip + monthlyAdd） ---------------- */
function refNormalizeHoldings(holdings) {
  const map = new Map();
  for (const h of Array.isArray(holdings) ? holdings : []) {
    const code = h && h.code != null ? String(h.code).trim() : '';
    if (!code) continue;
    const w = Number(h.weight);
    map.set(code, (map.get(code) || 0) + (Number.isFinite(w) && w > 0 ? w : 0));
  }
  const list = [...map.entries()].map(([code, weight]) => ({ code, weight }));
  let totalW = list.reduce((s, h) => s + h.weight, 0);
  if (totalW > 100) {
    for (const h of list) h.weight = (h.weight / totalW) * 100;
    totalW = 100;
  }
  return { list, totalW };
}
function refXirr(flows) {
  // 独立实现：在 (-0.9999, 10) 上用二分找 NPV 符号变化（与引擎的 Newton 实现独立）
  const list = flows.filter(([d, a]) => Number.isFinite(a) && a !== 0 && d);
  if (list.length < 2) return null;
  const t0 = Math.min(...list.map(([d]) => Date.parse(d)));
  const ts = list.map(([d, a]) => [(Date.parse(d) - t0) / MS / 365.25, a]);
  const maxT = Math.max(...ts.map(([t]) => t));
  if (!(maxT > 0)) return null;
  const npv = (r) => ts.reduce((s, [t, a]) => s + a / Math.pow(1 + r, t), 0);
  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (Math.abs(f) < 1e-10) return mid;
    if (flo * f <= 0) { hi = mid; fhi = f; } else { lo = mid; flo = f; }
  }
  return (lo + hi) / 2;
}
function refAnnualize(totalRet, from, to) {
  const days = (Date.parse(to) - Date.parse(from)) / MS;
  if (!(days > 0)) return null;
  if (!Number.isFinite(totalRet)) return null;
  const v = Math.pow(1 + totalRet, 365.25 / days) - 1;
  return Number.isFinite(v) ? v : null;
}
function refPortfolio({ dates, series, dividends = {}, holdings = [], capital = 1000000, monthlyAdd = 0, entry = null, from, to }) {
  const { list: active, totalW } = refNormalizeHoldings(holdings);
  const e = refNormalizeEntry(entry);
  const isStaged = e.mode === 'staged';
  const isDip = e.mode === 'dip';
  const months = Math.max(1, e.months);
  const cashPct = Math.max(0, 100 - totalW);
  const stockCapital = capital * (totalW / 100);
  const perPeriod = isStaged ? stockCapital / months : 0;
  const designatedCash = isStaged ? capital * (cashPct / 100) : 0;
  const wOf = new Map(active.map((h) => [h.code, h.weight]));
  const px = (code, date) => priceAtRef(series.get(code), date);
  const stockValue = (sh, date) => active.reduce((s, h) => s + (sh.get(h.code) || 0) * (px(h.code, date) || 0), 0);

  const sh = new Map(active.map((h) => [h.code, 0]));
  const shR = new Map(active.map((h) => [h.code, 0]));
  let cash = capital;
  let cashR = capital;
  const events = [];
  const divByY = {};
  const divByCode = {};
  const yearly = [];
  const nav = [];
  const navR = [];
  const comp = [];
  const flowsN = [[dates[0], -capital]];
  const flowsR = [[dates[0], -capital]];
  const entryOut = { mode: e.mode, months: e.months, minDy: e.minDy, installments: [], triggered: {}, neverTriggered: [] };
  let stagedDone = 0;
  let reserved = isStaged ? stockCapital : 0;
  const dipTriggered = new Map();
  let dipPrincipalR = isDip ? capital : 0;

  // stagedBuyTo（口径：src/engine/portfolioBacktest.js:418-448）
  const stagedBuyTo = (date, sharesMap, budget, base, why, record) => {
    if (!(budget > 0) || totalW <= 0) return 0;
    const gaps = [];
    for (const h of active) {
      const p = px(h.code, date);
      if (!(p > 0)) continue;
      const target = base * h.weight / totalW;
      const cur = (sharesMap.get(h.code) || 0) * p;
      if (target - cur > 0) gaps.push({ code: h.code, p, gap: target - cur });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    let left = budget, spent = 0;
    for (const g of gaps) {
      const n = Math.floor(Math.min(left, g.gap) / g.p / 100) * 100;
      if (n <= 0) continue;
      sharesMap.set(g.code, (sharesMap.get(g.code) || 0) + n);
      const cost = n * g.p;
      spent += cost; left -= cost;
      if (record) events.push({ date, type: '买入', code: g.code, shares: n, price: g.p, why });
    }
    return spent;
  };
  // dip 买入（口径：src/engine/portfolioBacktest.js:452-508）
  const knownDps = (code, date) => {
    const years = dividends?.[code]?.years;
    if (!years) return 0;
    const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
    const v = years[m >= 4 ? y - 1 : y - 2];
    return v > 0 ? v : 0;
  };
  const dipBuyTo = (date, sharesMap, cashNow, opt = {}) => {
    const record = opt.record !== false;
    const budget = opt.budget == null ? Infinity : opt.budget;
    let cashLeft = cashNow, spent = 0;
    if (totalW <= 0) return { cash: cashLeft, spent };
    const T = cashLeft + stockValue(sharesMap, date);
    const gaps = [];
    for (const h of active) {
      const p = px(h.code, date);
      if (!(p > 0)) continue;
      const dps = knownDps(h.code, date);
      if (!(dps > 0)) continue;
      const dy = (dps / p) * 100;
      if (!(dy >= e.minDy)) continue;
      if (record && !dipTriggered.has(h.code)) dipTriggered.set(h.code, date);
      const target = T * h.weight / 100;
      const cur = (sharesMap.get(h.code) || 0) * p;
      if (target - cur > 0) gaps.push({ code: h.code, p, dy, gap: target - cur });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    for (const g of gaps) {
      const room = Math.min(cashLeft, Math.max(0, budget - spent), g.gap);
      const n = Math.floor(room / g.p / 100) * 100;
      if (n <= 0) continue;
      sharesMap.set(g.code, (sharesMap.get(g.code) || 0) + n);
      const cost = n * g.p;
      cashLeft -= cost; spent += cost;
      if (record) events.push({ date, type: '买入', code: g.code, shares: n, price: g.p, why: `股息率 ${g.dy.toFixed(1)}% ≥ ${e.minDy}% 建仓` });
    }
    return { cash: cashLeft, spent };
  };

  // 起点
  if (isStaged) {
    stagedDone = 1;
    reserved = perPeriod * (months - 1);
    if (perPeriod > 0) {
      const budget = Math.min(perPeriod, Math.max(0, cash - reserved));
      const spent = stagedBuyTo(dates[0], sh, budget, stockValue(sh, dates[0]) + budget, `分批建仓 1/${months} 期`, true);
      cash -= spent;
      entryOut.installments.push({ date: dates[0], amount: spent });
      const spentR = stagedBuyTo(dates[0], shR, budget, stockValue(shR, dates[0]) + budget, `分批建仓 1/${months} 期`, false);
      cashR -= spentR;
    }
  } else if (isDip) {
    const n0 = dipBuyTo(dates[0], sh, cash);
    cash = n0.cash;
    const r0 = dipBuyTo(dates[0], shR, cashR, { record: false, budget: dipPrincipalR });
    cashR = r0.cash;
    dipPrincipalR -= r0.spent;
  } else if (totalW > 0) {
    let builtSum = 0;
    for (const h of active) {
      const p = px(h.code, dates[0]);
      if (!(p > 0)) continue;
      const n = Math.floor((capital * h.weight / 100) / p / 100) * 100;
      if (n > 0) {
        sh.set(h.code, n); shR.set(h.code, n);
        events.push({ date: dates[0], type: '买入', code: h.code, shares: n, price: p, why: '初始建仓' });
        builtSum += n * p;
      }
    }
    cash = Math.max(0, capital - builtSum);
    cashR = cash;
  }

  let lastYear = null, yearNav0 = capital, yearDiv = 0, yearAdds = 0, yearCash = null;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEnd = isMonthEndRef(dates, i);
    const isAprEnd = monthEnd && date.slice(5, 7) === '04';
    const isDecEnd = monthEnd && date.slice(5, 7) === '12';
    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1][1], div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
      yearNav0 = nav[i - 1][1]; yearDiv = 0; yearAdds = 0;
    }
    lastYear = y;
    if (i > 0) {
      const days = daysBetween(dates[i - 1], date);
      if (cash > 0) cash *= 1 + DAY_RATE * days;
      if (cashR > 0) cashR *= 1 + DAY_RATE * days;
    }
    if (isAprEnd) {
      let paid = 0;
      for (const h of active) {
        const dps = prevDpsRef(dividends, h.code, y);
        if (!(dps > 0)) continue;
        const n = sh.get(h.code) || 0;
        if (n > 0) { cash += n * dps; paid += n * dps; divByCode[h.code] = (divByCode[h.code] || 0) + n * dps; }
        const nR = shR.get(h.code) || 0;
        if (nR > 0) cashR += nR * dps;
      }
      if (paid > 0) { divByY[y] = (divByY[y] || 0) + paid; yearDiv += paid; events.push({ date, type: '分红', amount: paid, why: `${y - 1} 年度分红到账` }); }
    }
    if (monthlyAdd > 0 && (isAprEnd || isDecEnd)) {
      const amt = monthlyAdd * 6;
      cash += amt; cashR += amt; yearAdds += amt;
      flowsN.push([date, amt]); flowsR.push([date, amt]);
      events.push({ date, type: '追加', amount: amt, why: '月追加（6 个月）' });
    }
    if (isStaged && i > 0 && stagedDone > 0 && stagedDone < months && monthEnd) {
      stagedDone += 1;
      reserved = perPeriod * (months - stagedDone);
      const budget = Math.min(perPeriod, Math.max(0, cash - reserved));
      const spent = stagedBuyTo(date, sh, budget, stockValue(sh, date) + budget, `分批建仓 ${stagedDone}/${months} 期`, true);
      cash -= spent;
      entryOut.installments.push({ date, amount: spent });
      const budgetR = Math.min(perPeriod, Math.max(0, cashR - reserved));
      const spentR = stagedBuyTo(date, shR, budgetR, stockValue(shR, date) + budgetR, `分批建仓 ${stagedDone}/${months} 期`, false);
      cashR -= spentR;
    }
    if (isStaged && (isAprEnd || isDecEnd)) {
      const free = Math.max(0, cash - reserved - designatedCash);
      if (free > 0) {
        const addBase = free * (totalW / 100);
        const spent = stagedBuyTo(date, sh, free, stockValue(sh, date) + addBase, '分红复投', true);
        cash -= spent;
      }
    } else if (!isDip && (isAprEnd || isDecEnd)) {
      // once・investCash 口径：src/engine/portfolioBacktest.js:376-404
      const T = cash + stockValue(sh, date);
      const gaps = [];
      for (const h of active) {
        const p = px(h.code, date);
        if (!(p > 0)) continue;
        const target = T * h.weight / 100;
        const cur = (sh.get(h.code) || 0) * p;
        if (target - cur > 0) gaps.push({ code: h.code, p, gap: target - cur });
      }
      gaps.sort((a, b) => b.gap - a.gap);
      for (const g of gaps) {
        const n = Math.floor(Math.min(cash, g.gap) / g.p / 100) * 100;
        if (n <= 0) continue;
        sh.set(g.code, (sh.get(g.code) || 0) + n);
        cash -= n * g.p;
        events.push({ date, type: '买入', code: g.code, shares: n, price: g.p, why: '分红复投' });
      }
    }
    if (isDip && i > 0 && monthEnd) {
      const rb = dipBuyTo(date, sh, cash);
      cash = rb.cash;
      if (dipPrincipalR > 0) {
        const rr = dipBuyTo(date, shR, cashR, { record: false, budget: dipPrincipalR });
        cashR = rr.cash;
        dipPrincipalR -= rr.spent;
      }
    }
    const v = cash + stockValue(sh, date);
    const vR = cashR + stockValue(shR, date);
    nav.push([date, v]); navR.push([date, vR]);
    const row = { cash: +cash.toFixed(2) };
    for (const h of active) {
      const n = sh.get(h.code) || 0;
      if (n <= 0) continue;
      const p = px(h.code, date);
      if (p > 0) row[h.code] = +(n * p).toFixed(2);
    }
    comp.push([date, row]);
    yearCash = cash;
  }
  yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[nav.length - 1][1], div: yearDiv, cash: yearCash ?? 0, invest: yearAdds });
  const lastDate = dates[dates.length - 1];
  let pending;
  if (isDip) {
    pending = active.filter((h) => { const s = series.get(h.code); const listing = s && s.dates.length ? s.dates[0] : null; return !listing || listing > lastDate; })
      .map((h) => ({ code: h.code, weight: h.weight, reason: !(series.get(h.code)?.dates?.length) ? '无行情数据' : '区间内未上市' }));
    const pset = new Set(pending.map((p) => p.code));
    entryOut.neverTriggered = active.filter((h) => !dipTriggered.has(h.code) && !pset.has(h.code)).map((h) => h.code);
    entryOut.triggered = Object.fromEntries(dipTriggered);
  } else {
    pending = []; // 夹具里全部起点已上市
  }
  const totalDiv = Object.values(divByY).reduce((s, x) => s + x, 0);
  const totalIn = capital + yearly.reduce((s, x) => s + (x.invest || 0), 0);
  const end = nav[nav.length - 1][1];
  const endR = navR[navR.length - 1][1];
  const hasAdd = totalIn > capital;
  const ret = capital > 0 ? end / capital - 1 : null;
  const retR = capital > 0 ? endR / capital - 1 : null;
  const cagr = hasAdd ? refXirr(flowsN.concat([[lastDate, end]])) : (ret == null ? null : refAnnualize(ret, from ?? dates[0], to ?? lastDate));
  const cagrR = hasAdd ? refXirr(flowsR.concat([[lastDate, endR]])) : (retR == null ? null : refAnnualize(retR, from ?? dates[0], to ?? lastDate));
  return { nav, navR, comp, divByY, divByCode, yearly, end, endR, cashEnd: cash, totalDiv, totalIn, entry: entryOut, pending, events, flowsN, cagr, cagrR, ret, retR };
}


/* ============================ A 夹具：方案执行清单 ============================ */

const QUOTES = {
  '600036': { p: 30, n: '招商银行' },
  '601398': { p: 6, n: '工商银行' },
  '000333': { p: 60, n: '美的集团' },
  '600519': { p: 1700, n: '贵州茅台' },
};
const DIVIDENDS = {
  '600036': { years: { 2023: 1.5, 2024: 1.6 } },
  '601398': { years: { 2023: 0.3, 2024: 0.32 } },
  '000333': { years: { 2023: 2.4 } },
};
function basePlan(entry) {
  return {
    id: 'p1', name: '测试方案', capital: 1000000,
    holdings: [{ code: '600036', weight: 40 }, { code: '601398', weight: 35 }, { code: '000333', weight: 15 }],
    entry,
  };
}
function actionCase({ plan, positions, buyCap = null }) {
  return {
    plan: clone(plan),
    positions: positions instanceof Map ? new Map([...positions]) : clone(positions),
    quotes: QUOTES,
    dividends: DIVIDENDS,
    buyCap,
  };
}
function assertActionRowsMatch(engine, ref, label) {
  assert.equal(engine.rows.length, ref.rows.length, `${label}: rows 长度`);
  for (let i = 0; i < engine.rows.length; i++) {
    const a = engine.rows[i];
    const b = ref.rows[i];
    assert.equal(a.code, b.code, `${label}: row${i} code`);
    for (const k of ['weight', 'price', 'target', 'shares', 'current', 'delta', 'sugShares', 'dps']) {
      assertClose(a[k], b[k], `${label}: row${i}.${k}`, 1e-9, 1e-9);
    }
    for (const k of ['dy', 'triggerPrice', 'gapToTrigger', 'weightNow']) {
      if (a[k] === null || b[k] === null) assert.equal(a[k], b[k], `${label}: row${i}.${k} null 标记`);
      else assertClose(a[k], b[k], `${label}: row${i}.${k}`, 1e-9, 1e-9);
    }
    for (const k of ['side', 'sugSide', 'triggered']) assert.equal(a[k], b[k], `${label}: row${i}.${k}`);
  }
  assert.deepEqual(engine.outside, ref.outside, `${label}: outside 持仓`);
  for (const k of ['capital', 'targetStock', 'cashPlan', 'currentStock', 'outsideValue', 'totalNow', 'buyAmount', 'sellAmount', 'annualDiv', 'stagedBudget']) {
    assertClose(engine.summary[k], ref.summary[k], `${label}: summary.${k}`, 1e-9, 1e-9);
  }
  for (const k of ['dyOnStock', 'dyOnCapital']) {
    if (engine.summary[k] === null || ref.summary[k] === null) assert.equal(engine.summary[k], ref.summary[k], `${label}: summary.${k} null 标记`);
    else assertClose(engine.summary[k], ref.summary[k], `${label}: summary.${k}`, 1e-9, 1e-9);
  }
  assert.deepEqual(engine.summary.entry, ref.summary.entry, `${label}: summary.entry`);
}

/* ============================ A1：once 常规（买/卖/持有 + 方案外持仓） ============================ */

test('差分：planActionRows once 常规——目标/差额/整手建议/持有阈值/权重 Now/方案外持仓', () => {
  const plan = basePlan({ mode: 'once' });
  // 600036 持仓 5000×30=15 万 < 目标 40 万 → 买；601398 10 万股×6=60 万 > 35 万 → 卖；
  // 000333 2500×60=15 万 = 目标 → 持有；600519 不在方案里 → outside 单列
  const opts = actionCase({ plan, positions: new Map([['600036', 5000], ['601398', 100000], ['000333', 2500], ['600519', 100]]) });
  const engine = planActionRows(clone(opts));
  const ref = refPlanActionRows(clone(opts));
  assertActionRowsMatch(engine, ref, 'once 常规');

  const rowOf = (code) => engine.rows.find((r) => r.code === code);
  assert.equal(rowOf('600036').side, 'buy');
  assert.equal(rowOf('600036').sugShares, 8300, '（40万-15万）/30 元 = 8333 股 → 向下取 83 手 = 8300 股');
  assert.equal(rowOf('601398').side, 'sell');
  assert.equal(rowOf('601398').sugShares, 41600, '（60万-35万）/6 元 = 41666 股 → 向下取 416 手 = 41600 股');
  assert.equal(rowOf('000333').side, 'hold');
  assert.equal(rowOf('000333').delta, 0);
  // 方案外持仓 600519 100 股 × 1700 = 17 万
  assert.equal(engine.outside.length, 1);
  assert.equal(engine.outside[0].code, '600519');
  assert.equal(engine.outside[0].value, 170000);
  // weightNow = 当前持仓市值 / (方案内当前市值 + 方案外市值)
  const totalNow = 150000 + 600000 + 150000 + 170000;
  assertClose(rowOf('600036').weightNow, 150000 / totalNow * 100, 'weightNow');
  assert.equal(engine.summary.totalNow, totalNow);
  assert.equal(engine.summary.capital, 1000000);
  assert.equal(engine.summary.cashPlan, 100000, '计划现金 = 本金 100 万 - 股票目标 90 万');
});

/* ============================ A2：dip 门槛 ============================ */

test('差分：planActionRows dip 门槛——触发价/偏离度/未触发不买（sugShares=0、sugSide=hold）', () => {
  // minDy=5：600036 dy=1.6/30=5.33% 触发；601398 dy=0.32/6=5.33% 触发；000333 dy=2.4/60=4% 未触发
  const plan = basePlan({ mode: 'dip', minDy: 5 });
  const opts = actionCase({ plan, positions: new Map([['600036', 2000]]) });
  const engine = planActionRows(clone(opts));
  const ref = refPlanActionRows(clone(opts));
  assertActionRowsMatch(engine, ref, 'dip 门槛');

  const a = engine.rows.find((r) => r.code === '600036');
  const b = engine.rows.find((r) => r.code === '601398');
  const c = engine.rows.find((r) => r.code === '000333');
  assert.equal(a.triggered, true);
  assert.equal(a.triggerPrice, 32, '触发价 = 1.6 / 5% = 32 元'); // 30 元 < 32 → 已低于触发价
  assert.ok(a.gapToTrigger < 0);
  assert.equal(b.triggered, true);
  assert.equal(c.triggered, false);
  assert.equal(c.sugShares, 0, 'dip 未触发 → 本轮不买');
  assert.equal(c.sugSide, 'hold');
  assertClose(c.triggerPrice, 48, '触发价 = 2.4 / 5% = 48 元；现价 60 元还差 20%', 1e-9, 1e-9);
  assertClose(c.gapToTrigger, (60 - 48) / 60 * 100, 'gapToTrigger', 1e-9, 1e-9);
  // 已持有且已触发、低于目标的股票：照常给买入建议
  assert.equal(a.side, 'buy');
  assert.equal(a.sugSide, 'buy');
});

/* ============================ A3：staged buyCap 本轮预算 ============================ */

test('差分：planActionRows staged——本轮买入受「每期预算」约束，缺口按比例拆成整手', () => {
  const plan = basePlan({ mode: 'staged', months: 6 });
  // 页面口径（src/pages/plans.js:375-376）：staged 时 buyCap = stagedBudget(plan) = 股票目标 90 万 / 6 = 15 万
  const buyCap = refStagedBudget(plan);
  assert.equal(buyCap, 150000);
  const opts = actionCase({ plan, positions: new Map(), buyCap });
  const engine = planActionRows(clone(opts));
  const ref = refPlanActionRows(clone(opts));
  assertActionRowsMatch(engine, ref, 'staged buyCap');

  // 不限预算时三只的缺口合计 = 90 万；压到 15 万后按缺口比例（1/6）重算整手
  const totalDelta = engine.rows.reduce((s, r) => s + Math.max(0, r.delta), 0);
  assertClose(engine.summary.buyAmount, totalDelta, 'summary.buyAmount（未受预算约束的缺口合计）');
  const suggested = engine.rows.reduce((s, r) => s + r.sugShares * r.price, 0);
  assert.ok(suggested <= buyCap + 0.01, `建议买入金额 ${suggested} 应 ≤ 每期预算 ${buyCap}`);
  assertClose(engine.rows.find((r) => r.code === '600036').sugShares, 2200, '400000/6/30 → 2222 股 → 2200 股整手');
  assertClose(engine.rows.find((r) => r.code === '601398').sugShares, 9700, '350000/6/6 → 9722 股 → 9700 股整手');
  assertClose(engine.rows.find((r) => r.code === '000333').sugShares, 400, '150000/6/60 → 416 股 → 400 股整手');
  assert.equal(engine.summary.stagedBudget, 150000);
});

/* ============================ A4：缺行情 / 空方案 / 本金 0 ============================ */

test('差分：planActionRows 缺行情、空方案、本金 0 的边界与参考实现一致', () => {
  // 缺行情：000001 没有报价 → price=0 / sugShares=0 / sugSide=hold，但 target 仍是 10 万
  const planWithMissing = {
    ...basePlan({ mode: 'once' }),
    holdings: [...basePlan({ mode: 'once' }).holdings, { code: '000001', weight: 10 }],
  };
  const opts1 = actionCase({ plan: planWithMissing, positions: { '600036': 0 } });
  const engine1 = planActionRows(clone(opts1));
  const ref1 = refPlanActionRows(clone(opts1));
  assertActionRowsMatch(engine1, ref1, '缺行情');
  const miss = engine1.rows.find((r) => r.code === '000001');
  assert.equal(miss.price, 0);
  assert.equal(miss.target, 100000);
  assert.equal(miss.side, 'buy');
  assert.equal(miss.sugShares, 0);
  assert.equal(miss.sugSide, 'hold');
  assert.equal(miss.dy, null);
  assert.equal(miss.triggerPrice, null);
  assert.equal(miss.gapToTrigger, null);

  // 空方案 + 本金 0：rows 空、summary 全 0/null 不崩
  const opts2 = actionCase({ plan: { capital: 0, holdings: [], entry: { mode: 'once' } }, positions: new Map() });
  const engine2 = planActionRows(clone(opts2));
  const ref2 = refPlanActionRows(clone(opts2));
  assertActionRowsMatch(engine2, ref2, '空方案/本金0');
  assert.deepEqual(engine2.rows, []);
  assert.equal(engine2.summary.capital, 0);
  assert.equal(engine2.summary.stagedBudget, 0);
  assert.equal(engine2.summary.dyOnCapital, null);

  // staged 不传 buyCap（页面外的直接调用）：不做预算约束，建议为完整缺口整手
  const planNoCap = basePlan({ mode: 'staged', months: 6 });
  const opts3 = actionCase({ plan: planNoCap, positions: new Map() });
  const engine3 = planActionRows(clone(opts3));
  const ref3 = refPlanActionRows(clone(opts3));
  assertActionRowsMatch(engine3, ref3, 'staged 无 buyCap');
  assert.equal(engine3.rows.find((r) => r.code === '600036').sugShares, 13300, '40 万/30 元 = 13333 股 → 13300 股整手');
});

/* ============================ B/C/D 夹具：组合回测 ============================ */

function mkFolioSeries(spec) {
  const series = new Map();
  for (const [code, f] of Object.entries(spec)) {
    const dates = f.dates;
    const closes = dates.map((_, i) => Math.round(f.fn(i) * 100) / 100);
    series.set(code, { dates: [f.pre, ...dates], closes: [Math.round(f.fn(-1) * 100) / 100, ...closes] });
  }
  return series;
}

/** 组合回测差分：逐月 nav/navR、comp（现金+持仓）、installments、triggered/neverTriggered、pending、买入事件、end/cagr */
function diffPortfolioCase({ name, dates, series, dividends = {}, holdings, capital = 1000000, monthlyAdd = 0, entry = null }) {
  const opts = { dates, series, dividends, holdings, capital, monthlyAdd, from: dates[0], to: dates.at(-1), mode: 'invest', entry };
  const engine = runPortfolioBacktest(clone(opts));
  const ref = refPortfolio(clone(opts));

  assert.equal(engine.nav.length, ref.nav.length, `${name}: nav 长度`);
  for (let i = 0; i < engine.nav.length; i++) {
    assert.equal(engine.nav[i][0], ref.nav[i][0], `${name}: nav 日期`);
    assertClose(engine.nav[i][1], ref.nav[i][1], `${name}: nav ${engine.nav[i][0]}`);
    assertClose(engine.navR[i][1], ref.navR[i][1], `${name}: navR ${engine.navR[i][0]}`);
  }
  // 持仓构成（现金 + 各股市值，引擎 round 到分）
  assert.equal(engine.comp.length, ref.comp.length, `${name}: comp 长度`);
  for (let i = 0; i < engine.comp.length; i++) {
    assert.equal(engine.comp[i][0], ref.comp[i][0], `${name}: comp 日期`);
    const a = engine.comp[i][1];
    const b = ref.comp[i][1];
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${name}: comp ${engine.comp[i][0]} 字段`);
    for (const k of Object.keys(b)) assertClose(a[k], b[k], `${name}: comp ${engine.comp[i][0]} ${k}`, 1e-9, 0.01);
  }
  assertClose(engine.end, ref.end, `${name}: end`);
  assertClose(engine.endR, ref.endR, `${name}: endR`);
  assertClose(engine.totalDiv, ref.totalDiv, `${name}: totalDiv`);
  assertClose(engine.totalIn, ref.totalIn, `${name}: totalIn`, 1e-9, 1e-9);
  assertClose(engine.cashEnd, ref.cashEnd, `${name}: cashEnd`, 1e-9, 0.01);
  assert.equal(engine.yearly.length, ref.yearly.length, `${name}: 年度条数`);
  for (let i = 0; i < engine.yearly.length; i++) {
    const a = engine.yearly[i];
    const b = ref.yearly[i];
    assert.equal(a.year, b.year);
    assertClose(a.nav0, b.nav0, `${name}: ${a.year} 年初净值`);
    assertClose(a.nav1, b.nav1, `${name}: ${a.year} 年末净值`);
    assertClose(a.div, b.div, `${name}: ${a.year} 分红`, 1e-9, 0.01);
    assertClose(a.cash, b.cash, `${name}: ${a.year} 年末现金`, 1e-9, 0.01);
    assertClose(a.invest, b.invest, `${name}: ${a.year} 追加`, 1e-9, 1e-9);
  }
  // 分期记录
  assert.equal(engine.entry.installments.length, ref.entry.installments.length, `${name}: installments 长度`);
  for (let i = 0; i < engine.entry.installments.length; i++) {
    assert.equal(engine.entry.installments[i].date, ref.entry.installments[i].date, `${name}: installment ${i} 日期`);
    assertClose(engine.entry.installments[i].amount, ref.entry.installments[i].amount, `${name}: installment ${i} 金额`, 1e-9, 1e-9);
  }
  assert.deepEqual(engine.entry.triggered, ref.entry.triggered, `${name}: triggered`);
  assert.deepEqual(engine.entry.neverTriggered, ref.entry.neverTriggered, `${name}: neverTriggered`);
  assert.deepEqual(engine.pending.map((p) => [p.code, p.reason]), ref.pending.map((p) => [p.code, p.reason]), `${name}: pending`);
  // 分批/dip 买入事件（日期、代码、股数、价格、reason）
  const buyEvents = (r) => r.events
    .filter((e) => e.type === '买入' && (e.why.startsWith('分批建仓') || e.why.startsWith('股息率')))
    .map((e) => [e.date, e.code, e.shares, e.price, e.why]);
  assert.deepEqual(buyEvents(engine), buyEvents(ref), `${name}: 分批/dip 买入事件`);
  // CAGR（有月追加时走 XIRR，参考实现用独立二分求解）
  if (engine.stats.cagr != null || ref.cagr != null) {
    assert.ok(engine.stats.cagr != null && ref.cagr != null, `${name}: cagr 空值一致性`);
    assertClose(engine.stats.cagr, ref.cagr, `${name}: cagr`, 1e-6, 1e-9);
    assertClose(engine.stats.cagrR, ref.cagrR, `${name}: cagrR`, 1e-6, 1e-9);
  }
  return engine;
}

/* ============================ B1：staged 6 期 + 中途分红 ============================ */

test('差分：staged 6 期 + 中途分红——逐月 nav/现金/installments/end 一致，预留本金不被分红花掉', () => {
  const dates = monthEndDates(2020, 2021);
  const series = mkFolioSeries({
    AAA: { dates, pre: '2016-06-30', fn: (i) => 10 * (1 + 0.006 * i + 0.05 * Math.sin(i / 4)) },
    BBB: { dates, pre: '2016-06-30', fn: (i) => 20 * (1 - 0.002 * i + 0.04 * Math.cos(i / 5)) },
  });
  const r = diffPortfolioCase({
    name: 'staged6', dates, series,
    dividends: { AAA: { years: { 2019: 0.6, 2020: 0.5 } }, BBB: { years: { 2019: 1.2, 2020: 1.0 } } },
    holdings: [{ code: 'AAA', weight: 60 }, { code: 'BBB', weight: 40 }],
    entry: { mode: 'staged', months: 6 },
  });
  const perPeriod = 1000000 * 100 / 100 / 6;
  assert.equal(r.entry.months, 6);
  assert.equal(r.entry.installments.length, 6, '成立起投 + 之后 5 个月末');
  assert.deepEqual(r.entry.installments.map((x) => x.date), dates.slice(0, 6));
  assert.equal(Math.round(r.nav[0][1]), 1000000, 'nav[0] = 本金（未投本金仍在现金里）');
  for (const it of r.entry.installments) {
    assert.ok(it.amount > 0 && it.amount <= perPeriod + 0.01, `单期 ${it.amount} 应 ≤ 每期预算 ${perPeriod}`);
  }
  // 预留本金不提前花掉：逐日 现金 ≥ 剩余期数 × 每期预算（分红/复投只花 free 部分）
  for (let i = 0; i < r.comp.length; i++) {
    const d = r.comp[i][0];
    const done = r.entry.installments.filter((x) => x.date <= d).length;
    const reserved = Math.max(0, perPeriod * (6 - done));
    assert.ok(r.comp[i][1].cash >= reserved - 0.01, `${d}: 现金 ${r.comp[i][1].cash} < 预留 ${reserved}`);
  }
});

/* ============================ B2：staged 80% 股票 + 月追加 ============================ */

test('差分：staged 80% 股票 + 月追加——计划现金与追加资金都不花预留本金', () => {
  const dates = monthEndDates(2020, 2021);
  const series = mkFolioSeries({
    AAA: { dates, pre: '2016-06-30', fn: (i) => 10 * (1 + 0.006 * i + 0.05 * Math.sin(i / 4)) },
    BBB: { dates, pre: '2016-06-30', fn: (i) => 20 * (1 - 0.002 * i + 0.04 * Math.cos(i / 5)) },
  });
  const r = diffPortfolioCase({
    name: 'staged80+add', dates, series,
    dividends: { AAA: { years: { 2019: 0.6, 2020: 0.5 } } },
    holdings: [{ code: 'AAA', weight: 50 }, { code: 'BBB', weight: 30 }],
    monthlyAdd: 10000,
    entry: { mode: 'staged', months: 4 },
  });
  const perPeriod = 1000000 * 80 / 100 / 4; // 20 万
  const designatedCash = 1000000 * 20 / 100; // 计划留 20% 现金
  assert.equal(r.totalIn, 1000000 + 10000 * 6 * 4, '4/12 月末各入 6 个月，2020/2021 共 4 次');
  assert.equal(r.entry.installments.length, 4);
  for (let i = 0; i < r.comp.length; i++) {
    const d = r.comp[i][0];
    const done = r.entry.installments.filter((x) => x.date <= d).length;
    const reserved = Math.max(0, perPeriod * (4 - done));
    assert.ok(r.comp[i][1].cash >= reserved + designatedCash - 0.01, `${d}: 现金 ${r.comp[i][1].cash} < 预留+计划现金 ${reserved + designatedCash}`);
  }
  assert.ok(r.cashEnd >= designatedCash, '期末至少保留计划现金');
});

/* ============================ B3：staged 期数 > 区间月末数 ============================ */

test('差分：staged 期数大于区间月末数——只执行可用月末，剩余本金留现金', () => {
  const dates = monthEndDates(2020, 2020); // 只 12 个月末
  const series = mkFolioSeries({ AAA: { dates, pre: '2016-06-30', fn: (i) => 10 + i * 0.1 } });
  const r = diffPortfolioCase({
    name: 'staged24/12', dates, series, dividends: {},
    holdings: [{ code: 'AAA', weight: 100 }],
    entry: { mode: 'staged', months: 24 },
  });
  assert.equal(r.entry.months, 24);
  assert.equal(r.entry.installments.length, 12, '起点 + 11 个月末 = 12 期（区间内只有 12 个月末）');
  assert.equal(Math.round(r.nav[0][1]), 1000000);
  // 24 期中只投了 12 期 → 剩余约 50 万本金留在现金里
  assert.ok(r.cashEnd > 500000, `剩余本金应留现金，实际 ${r.cashEnd}`);
  assert.ok(r.cashEnd < 600000, `只应是预留部分 + 利息/零头，实际 ${r.cashEnd}`);
});

/* ============================ C1：dip 门槛/只买不卖/neverTriggered ============================ */

test('差分：dip 触发/跌价后触发/无分红 neverTriggered——nav、events.why、triggered 一致', () => {
  const dates = monthEndDates(2020, 2021);
  const series = mkFolioSeries({
    AAA: { dates, pre: '2016-06-30', fn: () => 10 },                      // 一直 10 元，1 元 DPS → 10% 起点即触发
    BBB: { dates, pre: '2016-06-30', fn: (i) => (i < 5 ? 25 : 12) },     // 2020-06 跌到 12 元 → dy 8.33% 触发
    CCC: { dates, pre: '2016-06-30', fn: (i) => 8 + (i % 3) * 0.5 },     // 无分红 → 永不触发
  });
  const r = diffPortfolioCase({
    name: 'dip 门槛', dates, series,
    dividends: { AAA: { years: { 2018: 1, 2019: 1 } }, BBB: { years: { 2018: 1, 2019: 1 } } },
    holdings: [{ code: 'AAA', weight: 40 }, { code: 'BBB', weight: 40 }, { code: 'CCC', weight: 20 }],
    monthlyAdd: 10000,
    entry: { mode: 'dip', minDy: 5.5 },
  });
  assert.deepEqual(r.entry.triggered, { AAA: '2020-01-31', BBB: '2020-06-30' });
  assert.deepEqual(r.entry.neverTriggered, ['CCC']);
  assert.equal(r.entry.minDy, 5.5);
  assert.equal(r.entry.installments.length, 0, 'dip 没有分期');
  assert.equal(r.events.filter((e) => e.type === '卖出').length, 0, 'dip 只买不卖');
  assert.equal(r.totalIn, 1000000 + 10000 * 6 * 4);
  // 买入事件 why 格式（引擎与参考逐条一致已在 diffPortfolioCase 内部比对）
  const buy = r.events.filter((e) => e.type === '买入');
  assert.ok(buy.length > 0);
  for (const e of buy) assert.match(e.why, /^股息率 \d+\.\d% ≥ 5\.5% 建仓$/);
  assert.ok(buy.some((e) => e.code === 'BBB' && e.date === '2020-06-30'), 'BBB 跌到 12 元（dy 8.3%）后才买入');
});

/* ============================ C2：dip 的 DPS 口径 ============================ */

test('差分：dip 已知 DPS 口径——1–3 月用 Y-2、4 月后才有 Y-1（只在 4 月后触发）', () => {
  // 2018 年度 0.5 元（2.5%，不到门槛）；2019 年度 2 元（10%，2020-04 才「已知」）
  const dates = ['2020-01-31', '2020-02-28', '2020-03-31', '2020-04-30', '2020-05-29', '2020-06-30'];
  const series = mkFolioSeries({ AAA: { dates, pre: '2016-06-30', fn: () => 20 } });
  const r = diffPortfolioCase({
    name: 'dip DPS口径', dates, series,
    dividends: { AAA: { years: { 2018: 0.5, 2019: 2 } } },
    holdings: [{ code: 'AAA', weight: 100 }],
    entry: { mode: 'dip', minDy: 5.5 },
  });
  assert.deepEqual(r.entry.triggered, { AAA: '2020-04-30' }, '4 月前只能看到 2018 年度 0.5 元 → 不触发');
  const buy = r.events.filter((e) => e.type === '买入');
  assert.ok(buy.length >= 1);
  assert.ok(buy.every((e) => e.date >= '2020-04-30'), '不应在 4 月前买入');
  assert.equal(buy[0].why, '股息率 10.0% ≥ 5.5% 建仓');
});

/* ============================ C3：dip 全不触发 + 未上市 pending ============================ */

test('差分：dip 全部不触发 + 无行情股票进 pending（不进 neverTriggered）', () => {
  const dates = monthEndDates(2020, 2021);
  const series = mkFolioSeries({ AAA: { dates, pre: '2016-06-30', fn: () => 30 } }); // 1 元 DPS → 3.3% < 5.5%
  const r = diffPortfolioCase({
    name: 'dip 全不触发', dates, series,
    dividends: { AAA: { years: { 2018: 1 } } },
    holdings: [{ code: 'AAA', weight: 50 }, { code: 'NODATA', weight: 50 }],
    entry: { mode: 'dip', minDy: 5.5 },
  });
  assert.deepEqual(r.entry.triggered, {});
  assert.deepEqual(r.entry.neverTriggered, ['AAA']);
  assert.deepEqual(r.pending.map((p) => [p.code, p.reason]), [['NODATA', '无行情数据']]);
  assert.equal(r.events.filter((e) => e.type === '买入').length, 0, '从未触发 → 一股不买');
  assert.equal(Math.round(r.nav[0][1]), 1000000, '起点全现金，nav = 本金');
  assert.ok(r.end > 1000000, '现金利息照旧');
});

/* ============================ D1：once + 月追加 / XIRR ============================ */

test('差分：once + 月追加——4/12 月末各入 6 个月，totalIn/end/cagr（XIRR）一致', () => {
  const dates = monthEndDates(2019, 2021);
  const series = mkFolioSeries({
    AAA: { dates, pre: '2016-06-30', fn: (i) => 10 + i * 0.05 },
    BBB: { dates, pre: '2016-06-30', fn: (i) => 20 + Math.sin(i / 3) * 2 },
  });
  const r = diffPortfolioCase({
    name: 'once+add', dates, series,
    dividends: { AAA: { years: { 2018: 0.5, 2019: 0.6, 2020: 0.55 } }, BBB: { years: { 2018: 1, 2019: 1.1, 2020: 1.05 } } },
    holdings: [{ code: 'AAA', weight: 55 }, { code: 'BBB', weight: 45 }],
    monthlyAdd: 10000,
    entry: { mode: 'once' },
  });
  // 2019/2020/2021 各有 4 月、12 月两个追加日：6 次 × 6 个月 × 1 万 = 36 万
  assert.equal(r.totalIn, 1000000 + 10000 * 6 * 6);
  assert.deepEqual(r.yearly.map((y) => [y.year, y.invest]), [[2019, 120000], [2020, 120000], [2021, 120000]]);
  assert.ok(Number.isFinite(r.stats.cagr) && r.stats.cagr > 0, 'XIRR 年化应为有限正数');
  assert.ok(Number.isFinite(r.stats.cagrR));
  assert.ok(r.end > r.totalIn, '上涨行情期末应高于累计投入');
});
