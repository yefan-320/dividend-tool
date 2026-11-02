/**
 * 差分测试（differential testing）：用「独立朴素参考实现」重算，对照 engine 输出。
 *
 * 原则：
 *  - 参考实现只 import 引擎的顶层入口，不复用 src 内部函数；口径按 src 文件/行号注释独立重写，
 *    避免「照抄同一份逻辑 → 同错同对」。
 *  - 容差：相对误差 ≤1e-6（nav / 收益 / 换手等）；引擎内部 round 到分的位置（comp/年末现金）
 *    额外允许 0.01 元绝对误差。
 *
 * 覆盖：
 *  1) engine/backtest.js runPlanBacktest：每年 4 月末选股、等权、换手成本、月收益、年度收益
 *     口径来源：src/engine/backtest.js:62-112（选股过滤）、:115-155（月份表/参数）、
 *               :149-204（调仓/换手成本/月收益）、:207-218（年度收益/CAGR）
 *  2) engine/portfolioBacktest.js runPortfolioBacktest（once、全部起点已上市、无月追加）：
 *     口径来源：src/engine/portfolioBacktest.js:85-110（持仓归一化）、:376-404（分红复投 investCash）、
 *               :513-538（起点整手建仓）、:552-560（现金日息）、:584-608（4 月末分红）、
 *               :680-706（净值/持仓构成/年度数据）
 *  3) engine/stockBacktest.js runStockBacktest（单只、4/12 月末决策）：
 *     口径来源：src/engine/stockBacktest.js:52-55（买入持有对照）、:81-90（分红）、
 *               :103-152（4/12 月末买卖决策）、:154（日级净值）
 *  4) 固定种子随机场景 + 纯函数性 + 分红复投/不复投对照
 *
 * 运行：cd 红利工具 && node --test test/*.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runPlanBacktest } from '../src/engine/backtest.js';
import { runPortfolioBacktest } from '../src/engine/portfolioBacktest.js';
import { runStockBacktest } from '../src/engine/stockBacktest.js';

/* ============================ 公共工具 ============================ */

const DAY_RATE = 0.015 / 365;
const MS_PER_DAY = 86400000;

/** 与引擎一致的「自然日差」口径（src/engine/portfolioBacktest.js daysBetween） */
const daysBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / MS_PER_DAY));

/** 差分红夹具：把「年度合计 years」摊成「真实除权日 ev」。
    引擎现在只认 ev——没有除权日的分红一律不计，所以夹具必须给明细。 */
function withEv(dividends, monthDay = '06-30') {
  const out = {};
  for (const [code, d] of Object.entries(dividends)) {
    const ev = Object.entries(d.years || {})
      .map(([y, v]) => [`${Number(y) + 1}-${monthDay}`, v])
      .filter(([, v]) => v > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    out[code] = { ...d, ev };
  }
  return out;
}

/** 月份最后一天（引擎按月追加/分红判定用「日历里当月最后一根」；夹具直接给月末交易日） */
const isMonthEndRef = (dates, i) => !dates[i + 1] || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7);

/** 上一年度每股分红（与 src/engine/market.js prevDps 同口径：>0 才算） */
function prevDpsRef(dividends, code, year) {
  const v = dividends?.[code]?.years?.[year - 1];
  return v > 0 ? v : 0;
}

/** 朴素价格查询：序列里「不晚于 date」的最近收盘价（参考实现不复用引擎的二分 priceAt） */
function priceAtRef(series, date) {
  if (!series || !series.dates || !series.dates.length) return null;
  let value = null;
  for (let i = 0; i < series.dates.length; i++) {
    if (series.dates[i] <= date) value = series.closes[i];
    else break;
  }
  return value;
}

/** 相对误差断言（默认 1e-6）；abs 用于引擎里已经 round 到分的字段 */
function assertClose(actual, expected, msg, rel = 1e-6, abs = 0) {
  const diff = Math.abs(actual - expected);
  const tol = Math.max(abs, rel * Math.abs(expected));
  assert.ok(diff <= tol, `${msg}: 期望 ${expected}，实际 ${actual}（差 ${diff}，容差 ${tol}）`);
}

/** [[date, value]] 序列逐点对比 */
function assertSeriesClose(actual, expected, msg, rel = 1e-6) {
  assert.equal(actual.length, expected.length, `${msg}: 长度不一致`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i][0], expected[i][0], `${msg}: 第 ${i} 个日期不一致`);
    assertClose(actual[i][1], expected[i][1], `${msg}: ${expected[i][0]}`, rel);
  }
}

const clone = (x) => structuredClone(x);

/* ============================ 参考实现 1：计划回测（runPlanBacktest） ============================ */

/**
 * 独立重写「每年 4 月末按股息率选 N 只等权调仓」：
 *  - 候选过滤：非 ST/退、4 月有价格、上市 ≥minHistoryMonths 个月、上年度 DPS>0、
 *    连续分红 ≥minDivYears、股息率 ∈ [minDy, 15]、可选质量过滤（eps>0、payout<85、ocf/eps≥0.7、roe≥5）
 *  - 选股按股息率降序，等权
 *  - 换手成本：单边换手率 × cost × 2；首次建仓 cost 一次
 *  - 月收益：权重 ×（价格涨跌 + 上年度 DPS/上年 4 月价/12）；成分股缺数据时按命中权重归一
 *  - 年度收益：上年 12 月末 nav → 当年 12 月末 nav
 * 口径来源：src/engine/backtest.js:62-112 / :149-218
 */
function refPlanBacktest({ baseline, months, params = {}, finHistory = null }) {
  const p = { startYear: 2013, endYm: '2026-10', holdN: 20, minDy: 4, minDivYears: 3, weight: 'equal', cost: 0.001, ...params };
  const YM = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  const priceOf = (code, ym) => {
    for (const [k, v] of months[code] || []) if (k === ym) return v;
    return null;
  };
  const monthsBefore = (code, ym) => (months[code] || []).filter(([k]) => k < ym).length;
  const consecutiveYears = (code, year) => {
    const years = baseline.dividends[code]?.years || {};
    let n = 0;
    for (let y = year - 1; y >= year - 30; y--) {
      if (years[y] > 0) n++;
      else break;
    }
    return n;
  };

  const endYear = Number(p.endYm.slice(0, 4));
  const monthList = [];
  for (let y = p.startYear; y <= endYear; y++) {
    const lastMonth = y === endYear ? Number(p.endYm.slice(5, 7)) : 12;
    for (let m = 1; m <= lastMonth; m++) monthList.push(YM(y, m));
  }

  const select = (ym, year) => {
    const cand = [];
    for (const code of Object.keys(baseline.pool)) {
      const info = baseline.pool[code];
      if (!info) continue;
      if (/ST|退/.test(info.n || '')) continue;
      const px = priceOf(code, ym);
      if (!px || px <= 0) continue;
      if (monthsBefore(code, ym) < (p.minHistoryMonths ?? 24)) continue;
      const dps = prevDpsRef(baseline.dividends, code, year);
      if (!(dps > 0)) continue;
      if (consecutiveYears(code, year) < p.minDivYears) continue;
      const dy = (dps / px) * 100;
      if (dy < p.minDy) continue;
      if (dy > 15) continue;
      // 质量过滤（src/engine/backtest.js:97-107 口径）：eps>0、payout<85%、ocf/eps≥0.7、roe≥5
      if (p.quality !== false && finHistory) {
        const fin = (finHistory[code] || []).find((r) => r[0] === year - 1);
        if (!fin) continue;
        const eps = fin[1];
        const roe = fin[2];
        const ocfps = fin[5];
        if (!(eps > 0)) continue;
        if ((dps / eps) * 100 >= 85) continue;
        if (ocfps / eps < 0.7) continue;
        if (roe != null && roe < 5) continue;
      }
      cand.push({ code, name: info.n, dy, price: px, dps });
    }
    cand.sort((a, b) => b.dy - a.dy);
    return cand;
  };

  let nav = 1;
  const navSeries = [];
  const periods = [];
  const trades = [];
  let current = null;
  let totalTurnover = 0;

  for (let i = 0; i < monthList.length; i++) {
    const ym = monthList[i];
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));

    if (m === 4 && y >= p.startYear) {
      const picked = select(ym, y).slice(0, p.holdN);
      const n = picked.length;
      const items = picked.map((x) => ({ code: x.code, name: x.name, weight: n ? 1 / n : 0, dy: x.dy, dps: x.dps, price: x.price }));
      if (current) {
        const oldW = new Map(current.items.map((x) => [x.code, x.weight]));
        const newW = new Map(items.map((x) => [x.code, x.weight]));
        let turnover = 0;
        for (const [code, w] of oldW) turnover += Math.max(0, w - (newW.get(code) || 0));
        for (const [code, w] of newW) turnover += Math.max(0, w - (oldW.get(code) || 0));
        turnover /= 2;
        totalTurnover += turnover;
        nav *= 1 - turnover * p.cost * 2;
        trades.push({ ym, turnover, sold: current.items.filter((x) => !newW.has(x.code)).map((x) => x.code), bought: items.filter((x) => !oldW.has(x.code)).map((x) => x.code) });
      } else {
        nav *= 1 - p.cost;
        totalTurnover += 1;
      }
      current = { ym, year: y, items };
      periods.push({ ym, items: items.map((x) => ({ code: x.code, name: x.name, dy: x.dy })) });
    }

    // 该月收益：上月末 → 本月末（4 月调仓后，4 月收益按新持仓 × 3→4 月价格变动）
    if (current && i > 0) {
      const prevYm = monthList[i - 1];
      let ret = 0;
      let hit = 0;
      let wsum = 0;
      for (const item of current.items) {
        const p0 = priceOf(item.code, prevYm);
        const p1 = priceOf(item.code, ym);
        if (!p0 || !p1) continue;
        hit++;
        wsum += item.weight;
        const dps = prevDpsRef(baseline.dividends, item.code, current.year);
        ret += item.weight * (p1 / p0 - 1 + (dps > 0 ? dps / p0 / 12 : 0));
      }
      if (hit > 0 && wsum > 0 && wsum < 0.999) ret /= wsum;
      nav *= 1 + ret;
    }

    navSeries.push({ ym, nav });
  }

  const yearly = [];
  for (let y = p.startYear; y <= endYear; y++) {
    const a = y === p.startYear ? 1 : navSeries.find((x) => x.ym === YM(y - 1, 12))?.nav;
    const b = navSeries.find((x) => x.ym === YM(y, 12))?.nav ?? navSeries[navSeries.length - 1].nav;
    if (a && b) yearly.push({ year: y, ret: b / a - 1 });
  }

  const monthsCount = navSeries.length - 1;
  const yearsCount = monthsCount / 12;
  return {
    navSeries,
    yearly,
    periods,
    trades,
    total: nav - 1,
    cagr: yearsCount > 0 ? Math.pow(nav, 1 / yearsCount) - 1 : null,
    turnover: totalTurnover / Math.max(1, periods.length),
    finalNav: nav,
  };
}

/* ============================ 参考实现 2：组合回测 once ============================ */

/**
 * 独立重写 runPortfolioBacktest 的 once 模式（全部起点已上市、无月追加、无未上市、无基准）：
 *  - 起点：每只目标金额 = 本金 × weight%，按 100 股整手向下取整买入，剩余留现金
 *  - 日息：现金按 1.5%/365 × 自然日数，只对现金余额计息
 *  - 每年 4 月末：上一年度 DPS × 持股数进现金（复投口径 cash / 不复投口径 cashR）
 *  - 4/12 月末：按「当前总资产 × weight%」补缺口复投（100 股整手；缺口大的先买），只买不卖
 *  - 净值 = 现金 + 持仓市值；年末记录 nav0/nav1/div/cash
 * 口径来源：src/engine/portfolioBacktest.js:376-404 / :513-538 / :552-608 / :680-706
 */
function refPortfolioOnce({ dates, series, dividends, holdings, capital }) {
  const active = holdings.map((h) => ({ code: h.code, weight: Number(h.weight) }));
  const evPtrRef = new Map();
  const px = (code, date) => priceAtRef(series.get(code), date);
  const stockValue = (sh, date) => active.reduce((s, h) => s + (sh[h.code] || 0) * (px(h.code, date) || 0), 0);

  // 起点整手建仓
  const sh = {};
  const shR = {};
  let cash = capital;
  for (const h of active) {
    const p = px(h.code, dates[0]);
    if (!(p > 0)) continue;
    const n = Math.floor((capital * h.weight / 100) / p / 100) * 100;
    if (n > 0) {
      sh[h.code] = n;
      shR[h.code] = n;
      cash -= n * p;
    }
  }
  cash = Math.max(0, cash);
  let cashR = cash;

  const nav = [];
  const navR = [];
  const comp = [];
  const divByY = {};
  const divByCode = {};
  const yearly = [];
  let lastYear = null;
  let yearNav0 = capital;
  let yearDiv = 0;
  let yearCash = null;

  // 分红/利息复投：目标 = 当前总资产 × weight%，缺口大的先买；只有缺口>0 才买，只买不卖
  const reinvest = (date) => {
    const T = cash + stockValue(sh, date);
    const gaps = [];
    for (const h of active) {
      const p = px(h.code, date);
      if (!(p > 0)) continue;
      const target = T * h.weight / 100;
      const cur = (sh[h.code] || 0) * p;
      if (target - cur > 0) gaps.push({ code: h.code, p, gap: target - cur });
    }
    gaps.sort((a, b) => b.gap - a.gap);
    for (const g of gaps) {
      const n = Math.floor(Math.min(cash, g.gap) / g.p / 100) * 100;
      if (n <= 0) continue;
      sh[g.code] = (sh[g.code] || 0) + n;
      cash -= n * g.p;
    }
  };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEnd = isMonthEndRef(dates, i);
    const isAprEnd = monthEnd && date.slice(5, 7) === '04';
    const isDecEnd = monthEnd && date.slice(5, 7) === '12';

    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1][1], div: yearDiv, cash: yearCash ?? 0, invest: 0 });
      yearNav0 = nav[i - 1][1];
      yearDiv = 0;
    }
    lastYear = y;

    if (i > 0) {
      const days = daysBetween(dates[i - 1], date);
      if (cash > 0) cash *= 1 + DAY_RATE * days;
      if (cashR > 0) cashR *= 1 + DAY_RATE * days;
    }

    {
      // 每笔按真实除权除息日；没有 ev 就不派
      let paid = 0;
      for (const h of active) {
        const evs = dividends?.[h.code]?.ev || [];
        let ptr = evPtrRef.get(h.code);
        if (ptr === undefined) { ptr = 0; while (ptr < evs.length && evs[ptr][0] <= date) ptr++; evPtrRef.set(h.code, ptr); continue; }
        while (ptr < evs.length && evs[ptr][0] <= date) {
          const dps = evs[ptr][1];
          ptr++;
          if (!(dps > 0)) continue;
          const n = sh[h.code] || 0;
          if (n > 0) {
            cash += n * dps;
            paid += n * dps;
            divByCode[h.code] = (divByCode[h.code] || 0) + n * dps;
          }
          const nR = shR[h.code] || 0;
          if (nR > 0) cashR += nR * dps; // 不复投口径：分红只进现金
        }
        evPtrRef.set(h.code, ptr);
      }
      if (paid > 0) {
        divByY[y] = (divByY[y] || 0) + paid;
        yearDiv += paid;
      }
    }

    if (isAprEnd || isDecEnd) reinvest(date);

    const v = cash + stockValue(sh, date);
    const vR = cashR + stockValue(shR, date);
    nav.push([date, v]);
    navR.push([date, vR]);
    const row = { cash: +cash.toFixed(2) };
    for (const h of active) {
      const n = sh[h.code] || 0;
      if (n <= 0) continue;
      const p = px(h.code, date);
      if (p > 0) row[h.code] = +(n * p).toFixed(2);
    }
    comp.push([date, row]);
    yearCash = cash;
  }
  yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[nav.length - 1][1], div: yearDiv, cash: yearCash ?? 0, invest: 0 });

  const end = nav[nav.length - 1][1];
  const endR = navR[navR.length - 1][1];
  return {
    nav, navR, comp, divByY, divByCode, yearly, end, endR,
    totalDiv: Object.values(divByY).reduce((s, x) => s + x, 0),
    ret: end / capital - 1,
  };
}

/* ============================ 参考实现 3：个股回测 ============================ */

/**
 * 独立重写 runStockBacktest（单只、4/12 月末决策）：
 *  - 买入：质量过关（eps>0、roe≥5、ocf/eps≥0.7）+ 股息率≥minDy + 支付率<85% + 现金流覆盖≥0.7
 *  - 卖出：质量不过关，或上一年度分红比前一年下调 ≥5%
 *  - 分红：每年 4 月末按上一年度 DPS 进现金
 *  - 买入持有对照：起点整手买入，分红进现金不买入
 * 口径来源：src/engine/stockBacktest.js:52-55 / :81-90 / :103-152 / :154
 */
function refStockBacktest({ code, dates, series, dividends, finHistory, capital, minDy }) {
  const px = (date) => priceAtRef(series, date);
  let evPtrS = 0;
  let shares = 0;
  let cash = capital;
  const nav = [];
  const navHold = [];
  const trades = [];
  const divByY = {};
  const yearly = [];
  let lastYear = null;
  let yearNav0 = capital;
  let yearDiv = 0;
  let yearCash = capital;

  const p0 = px(dates[0]);
  const holdShares = p0 > 0 ? Math.floor(capital / p0 / 100) * 100 : 0;
  let holdCash = capital - holdShares * p0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEnd = isMonthEndRef(dates, i);
    const isAprEnd = monthEnd && date.slice(5, 7) === '04';
    const isDecEnd = monthEnd && date.slice(5, 7) === '12';

    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1][1], div: yearDiv, cash: yearCash, invest: 0 });
      yearNav0 = nav[i - 1][1];
      yearDiv = 0;
    }
    lastYear = y;

    if (i > 0) {
      const days = daysBetween(dates[i - 1], date);
      if (cash > 0) cash *= 1 + DAY_RATE * days;
      if (holdCash > 0) holdCash *= 1 + DAY_RATE * days;
    }

    {
      const evs = dividends?.[code]?.ev || [];
      while (evPtrS < evs.length && evs[evPtrS][0] <= date) {
        const dps = evs[evPtrS][1];
        evPtrS++;
        if (!(dps > 0)) continue;
        if (shares > 0) {
          const amt = shares * dps;
          cash += amt;
          const dy = Number(String(date).slice(0, 4));
          divByY[dy] = (divByY[dy] || 0) + amt;
          yearDiv += amt;
          trades.push({ date, type: '分红' });
        }
        if (holdShares > 0) holdCash += holdShares * dps;
      }
    }

    if (isAprEnd || isDecEnd) {
      const price = px(date);
      const fin = (finHistory[code] || []).find((r) => r[0] === y - 1) || null;
      const eps = fin ? fin[1] : null;
      const roe = fin ? fin[2] : null;
      const ocfps = fin ? fin[5] : null;
      const dpsNow = prevDpsRef(dividends, code, y);
      const dy = dpsNow > 0 && price > 0 ? (dpsNow / price) * 100 : null;
      const payout = dpsNow > 0 && eps > 0 ? (dpsNow / eps) * 100 : null;
      const cover = eps > 0 && ocfps != null ? ocfps / eps : null;
      // 质量（src/engine/market.js qualityOf，year=y-1）
      let ok = !!fin;
      if (fin) {
        if (!(eps > 0)) ok = false;
        else if (roe != null && roe < 5) ok = false;
        else if (ocfps != null && ocfps / eps < 0.7) ok = false;
      }
      const prev = prevDpsRef(dividends, code, y - 1); // years[y-2]
      const cur = prevDpsRef(dividends, code, y);      // years[y-1]
      const cut = prev > 0 && cur > 0 && cur < prev * 0.95;
      if (shares > 0) {
        if (!ok || cut) {
          cash += shares * price;
          trades.push({ date, type: '卖出' });
          shares = 0;
        }
      }
      if (shares === 0 && ok && dy != null && dy >= minDy) {
        const payoutBad = payout != null && payout >= 85;
        const coverBad = cover != null && cover < 0.7;
        if (!payoutBad && !coverBad) {
          const n = Math.floor(cash / price / 100) * 100;
          if (n > 0) {
            shares += n;
            cash -= n * price;
            trades.push({ date, type: '买入' });
          }
        }
      }
    }

    const price = px(date);
    nav.push([date, cash + shares * price]);
    navHold.push([date, holdCash + holdShares * price]);
    yearCash = cash;
  }
  yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[nav.length - 1][1], div: yearDiv, cash: yearCash, invest: 0 });

  const end = nav[nav.length - 1][1];
  const endHold = navHold[navHold.length - 1][1];
  return {
    nav, navHold, trades, divByY, yearly, end, endHold,
    totalDiv: Object.values(divByY).reduce((s, x) => s + x, 0),
  };
}

/* ============================ 固定夹具 ============================ */

/** 每月最后一个自然日（作为交易日；保证每月都是 month-end） */
function monthEndDates(fromYear, toYear) {
  const dates = [];
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) {
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      dates.push(`${y}-${String(m).padStart(2, '0')}-${String(dim).padStart(2, '0')}`);
    }
  }
  return dates;
}

/**
 * 计划回测夹具：8 只股票 + 4 年调仓，过滤条件全被触发到
 *  - A1/A2/A3：正常候选（股息率不同，按高低选前 2）
 *  - A4：股息率 >15%（异常）→ 被过滤
 *  - A5：股息率 <minDy → 被过滤
 *  - ST1：名字含 ST/退 → 被过滤
 *  - LATE：2015-01 才有价格 → 2015/2016 上市不满 24 个月被过滤，2017 满足
 *  - SHORT：只有 1 年分红 → 连续分红年数不足被过滤
 */
function planFixture() {
  const pool = {
    A1: { n: '甲' }, A2: { n: '乙' }, A3: { n: '丙' }, A4: { n: '丁' },
    A5: { n: '戊' }, ST1: { n: '*ST退' }, LATE: { n: '晚上市' }, SHORT: { n: '短分红' },
  };
  const ymList = [];
  for (let y = 2012; y <= 2017; y++) for (let m = 1; m <= 12; m++) ymList.push(`${y}-${String(m).padStart(2, '0')}`);
  const form = {
    A1: (i) => 10 * (1 + 0.004 * i),
    A2: (i) => 20 * (1 - 0.001 * i),
    A3: (i) => 8 * (1 + 0.002 * i),
    A4: () => 30,
    A5: () => 5,
    ST1: () => 10,
    LATE: () => 10,
    SHORT: () => 10,
  };
  const months = {};
  for (const code of Object.keys(pool)) {
    const rows = [];
    for (let i = 0; i < ymList.length; i++) {
      if (code === 'LATE' && ymList[i] < '2015-01') continue;
      rows.push([ymList[i], Math.round(form[code](i) * 100) / 100]);
    }
    months[code] = rows;
  }
  const dividends = {
    A1: { years: { 2012: 0.5, 2013: 0.6, 2014: 1.2, 2015: 1.0, 2016: 1.1 } },
    A2: { years: { 2012: 0.4, 2013: 0.4, 2014: 0.8, 2015: 0.9, 2016: 0.95 } },
    A3: { years: { 2012: 0.2, 2013: 0.2, 2014: 0.4, 2015: 0.5, 2016: 0.45 } },
    A4: { years: { 2012: 1, 2013: 1, 2014: 5, 2015: 5, 2016: 5 } }, // dy>15%
    A5: { years: { 2012: 0.1, 2013: 0.1, 2014: 0.1, 2015: 0.1, 2016: 0.1 } }, // dy<4%
    ST1: { years: { 2012: 1, 2013: 1, 2014: 1, 2015: 1, 2016: 1 } },
    LATE: { years: { 2014: 1, 2015: 1, 2016: 1 } },
    SHORT: { years: { 2016: 1 } },
  };
  return {
    baseline: { pool, dividends },
    months,
    params: { startYear: 2015, endYm: '2017-12', holdN: 2, minDy: 4, minDivYears: 3, cost: 0.002 },
  };
}

/** 组合回测夹具：3 只股票、4 年、价格有涨有跌、每年 4 月分红 */
function portfolioFixture(weights) {
  const dates = monthEndDates(2019, 2022);
  const mkSeries = (base, drift, amp, phase) => {
    const closes = dates.map((_, i) => Math.round(base * (1 + drift * i + amp * Math.sin((i + phase) / 5)) * 100) / 100);
    return { dates: ['2016-06-30', ...dates], closes: [base, ...closes] };
  };
  const series = new Map([
    ['AAA', mkSeries(10, 0.004, 0.05, 0)],
    ['BBB', mkSeries(20, -0.001, 0.08, 2)],
    ['CCC', mkSeries(5, 0.002, 0.10, 4)],
  ]);
  const dividends = withEv({
    AAA: { years: { 2018: 0.5, 2019: 0.6, 2020: 0.55, 2021: 0.7 } },
    BBB: { years: { 2018: 1.0, 2019: 1.2, 2020: 1.1, 2021: 1.3 } },
    CCC: { years: { 2018: 0.2, 2019: 0.25, 2020: 0.2, 2021: 0.3 } },
  });
  return {
    dates,
    series,
    dividends,
    holdings: weights.map(([code, weight]) => ({ code, weight })),
    capital: 1000000,
    monthlyAdd: 0,
    from: dates[0],
    to: dates.at(-1),
    mode: 'invest',
  };
}

/** 个股回测夹具：3 年月末交易日 + 指定价格函数/分红/财报 */
function stockFixture({ priceFn, dividends, finHistory }) {
  const dates = monthEndDates(2019, 2021);
  const closes = dates.map((_, i) => Math.round(priceFn(i) * 100) / 100);
  return {
    code: 'A',
    dates,
    series: { dates: ['2016-06-30', ...dates], closes: [Math.round(priceFn(-1) * 100) / 100, ...closes] },
    dividends: withEv(dividends),   // 引擎只认 ev：没有除权日的分红不计
    finHistory,
    capital: 1000000,
    monthlyAdd: 0,
    minDy: 5,
    from: dates[0],
    to: dates.at(-1),
  };
}

/* 固定种子随机（不依赖 Math.random / 时间） */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机组合夹具：3 只股票/3 年/随机价格与分红；权重用整数基点保证合计恰好 100.0 */
function randomPortfolioFixture(seed) {
  const rnd = mulberry32(seed);
  const dates = monthEndDates(2020, 2022);
  const codes = ['R1', 'R2', 'R3'];
  const series = new Map();
  for (const code of codes) {
    const base = 8 + rnd() * 20;
    let p = base;
    const closes = dates.map(() => {
      p = Math.max(1, p * (1 + (rnd() - 0.48) * 0.06));
      return Math.round(p * 100) / 100;
    });
    series.set(code, { dates: ['2017-06-30', ...dates], closes: [Math.round(base * 100) / 100, ...closes] });
  }
  const dividends = {};
  for (const code of codes) {
    const years = {};
    for (let y = 2018; y <= 2021; y++) if (rnd() < 0.85) years[y] = Math.round((0.2 + rnd() * 1.2) * 100) / 100;
    dividends[code] = { years };
  }
  Object.assign(dividends, withEv(dividends));
  const parts = [0, 1].map(() => Math.floor(80 + rnd() * 380));
  parts.push(1000 - parts[0] - parts[1]);
  const holdings = codes.map((code, i) => ({ code, weight: parts[i] / 10 }));
  return { dates, series, dividends, holdings, capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), mode: 'invest' };
}

/* ============================ 1. 计划回测差分 ============================ */

test('差分：计划回测的选股过滤/等权/换手成本与朴素参考实现一致', () => {
  const fixture = planFixture();
  const engine = runPlanBacktest(clone(fixture));
  const ref = refPlanBacktest(clone(fixture));

  // 选股结果一致（同时验证 5 类过滤条件都按口径生效）
  assert.deepEqual(engine.periods.map((x) => x.ym), ['2015-04', '2016-04', '2017-04']);
  assert.deepEqual(engine.periods.map((x) => x.items.map((it) => it.code)), [['A1', 'A3'], ['A1', 'A3'], ['LATE', 'A1']]);
  assert.equal(engine.periods.length, ref.periods.length, '调仓次数一致');
  for (let i = 0; i < engine.periods.length; i++) {
    assert.equal(engine.periods[i].ym, ref.periods[i].ym);
    assert.deepEqual(engine.periods[i].items.map((x) => x.code), ref.periods[i].items.map((x) => x.code), `第 ${i} 期选股`);
    assert.deepEqual(engine.periods[i].items.map((x) => x.name), ref.periods[i].items.map((x) => x.name));
    for (let j = 0; j < engine.periods[i].items.length; j++) {
      assertClose(engine.periods[i].items[j].dy, ref.periods[i].items[j].dy, `${engine.periods[i].ym} 第${j}只 dy`);
    }
  }

  // 换手成本：首次建仓 cost 一次；之后按单边换手 × cost × 2
  assert.equal(engine.trades.length, ref.trades.length, '调仓交易流水条数一致');
  for (let i = 0; i < engine.trades.length; i++) {
    assert.equal(engine.trades[i].ym, ref.trades[i].ym);
    assertClose(engine.trades[i].turnover, ref.trades[i].turnover, `${engine.trades[i].ym} 换手率`);
    assert.deepEqual(engine.trades[i].sold, ref.trades[i].sold, `${engine.trades[i].ym} 卖出名单`);
    assert.deepEqual(engine.trades[i].bought, ref.trades[i].bought, `${engine.trades[i].ym} 买入名单`);
  }
  assertClose(engine.stats.turnover, ref.turnover, '平均换手率');
});

test('差分：计划回测 nav 逐月 / 年度收益 / 最终净值 / CAGR 一致（相对误差 ≤1e-6）', () => {
  const fixture = planFixture();
  const engine = runPlanBacktest(clone(fixture));
  const ref = refPlanBacktest(clone(fixture));

  assert.equal(engine.nav.length, ref.navSeries.length, 'nav 长度一致');
  for (let i = 0; i < engine.nav.length; i++) {
    assert.equal(engine.nav[i].ym, ref.navSeries[i].ym);
    assertClose(engine.nav[i].nav, ref.navSeries[i].nav, `nav ${engine.nav[i].ym}`);
  }
  assert.equal(engine.yearly.length, ref.yearly.length, '年度收益条数一致');
  for (let i = 0; i < engine.yearly.length; i++) {
    assert.equal(engine.yearly[i].year, ref.yearly[i].year);
    assertClose(engine.yearly[i].ret, ref.yearly[i].ret, `${engine.yearly[i].year} 年度收益`);
  }
  assertClose(engine.stats.total, ref.total, '累计收益');
  assertClose(engine.nav.at(-1).nav, ref.finalNav, '最终净值');
  assertClose(engine.stats.cagr, ref.cagr, 'CAGR');
});

test('差分：计划回测质量过滤（支付率/ROE/现金流/缺财报）与参考实现一致', () => {
  const fixture = planFixture();
  // 质量过滤夹具（覆盖 4 条否决分支）：
  //  A1 2015 年：支付率 1.2/1.32 ≈ 91% ≥85% → 否决；2016/2017 年支付率降到 <85% 后恢复入选
  //  A2 ROE=4 <5 → 全程否决
  //  A3 eps/roe/现金流都过 → 全程入选
  //  LATE 缺财报行 → 否决；A4 dy>15、A5 dy<4、SHORT 连续分红不足 → 更早被否决
  fixture.finHistory = {
    A1: [[2014, 1.32, 12, 0, 0, 1.2], [2015, 1.32, 12, 0, 0, 1.2], [2016, 1.32, 12, 0, 0, 1.2]],
    A2: [[2014, 1.0, 4, 0, 0, 1.2], [2015, 1.0, 4, 0, 0, 1.2], [2016, 1.0, 4, 0, 0, 1.2]],
    A3: [[2014, 2.0, 6, 0, 0, 1.6], [2015, 2.0, 6, 0, 0, 1.6], [2016, 2.0, 6, 0, 0, 1.6]],
  };
  const engine = runPlanBacktest(clone(fixture));
  const ref = refPlanBacktest(clone(fixture));

  assert.deepEqual(engine.periods.map((x) => x.items.map((it) => it.code)), [['A3'], ['A1', 'A3'], ['A1', 'A3']], '质量过滤后的选股名单');
  assert.equal(engine.nav.length, ref.navSeries.length);
  for (let i = 0; i < engine.nav.length; i++) {
    assertClose(engine.nav[i].nav, ref.navSeries[i].nav, `质量过滤 nav ${engine.nav[i].ym}`);
  }
  assert.equal(engine.yearly.length, ref.yearly.length);
  for (let i = 0; i < engine.yearly.length; i++) {
    assertClose(engine.yearly[i].ret, ref.yearly[i].ret, `质量过滤 ${engine.yearly[i].year} 年收益`);
  }
  assertClose(engine.stats.total, ref.total, '质量过滤累计收益');
  assertClose(engine.stats.turnover, ref.turnover, '质量过滤换手率');
});

/* ============================ 2. 组合回测 once 差分 ============================ */

test('差分：组合回测 once（全上市/无月追加/100% 仓位）逐月 nav / navR / 分红 / 年末一致', () => {
  const fixture = portfolioFixture([['AAA', 40], ['BBB', 35], ['CCC', 25]]);
  const engine = runPortfolioBacktest(clone(fixture));
  const ref = refPortfolioOnce(clone(fixture));

  // 逐月净值（复投 + 不复投）
  assertSeriesClose(engine.nav, ref.nav, '组合 nav');
  assertSeriesClose(engine.navR, ref.navR, '组合 navR');
  assertClose(engine.end, ref.end, '期末净值');
  assertClose(engine.endR, ref.endR, '期末不复投净值');
  assertClose(engine.totalDiv, ref.totalDiv, '累计分红');
  assertClose(engine.stats.ret, ref.ret, '累计收益率');

  // 分红按年/按股票拆分
  assert.deepEqual(Object.keys(engine.divByY).sort(), Object.keys(ref.divByY).sort(), 'divByY 年份');
  for (const year of Object.keys(ref.divByY)) assertClose(engine.divByY[year], ref.divByY[year], `${year} 年分红`);
  assert.deepEqual(Object.keys(engine.divByCode).sort(), Object.keys(ref.divByCode).sort(), 'divByCode 股票');
  for (const code of Object.keys(ref.divByCode)) assertClose(engine.divByCode[code], ref.divByCode[code], `${code} 分红`);

  // 年末数据：nav0 / nav1 / div / cash（cash 是 round 到分的展示值）
  assert.equal(engine.yearly.length, ref.yearly.length, '年度条数一致');
  for (let i = 0; i < engine.yearly.length; i++) {
    const e = engine.yearly[i];
    const r = ref.yearly[i];
    assert.equal(e.year, r.year);
    assertClose(e.nav0, r.nav0, `${e.year} 年初净值`);
    assertClose(e.nav1, r.nav1, `${e.year} 年末净值`);
    assertClose(e.div, r.div, `${e.year} 年分红`);
    assertClose(e.cash, r.cash, `${e.year} 年末现金`, 1e-6, 0.01);
    assert.equal(e.invest, 0, '无月追加，invest 应为 0');
  }

  // 持仓构成（引擎 round 到分）
  assert.equal(engine.comp.length, ref.comp.length, '持仓构成条数一致');
  for (let i = 0; i < engine.comp.length; i++) {
    assert.equal(engine.comp[i][0], ref.comp[i][0]);
    const eRow = engine.comp[i][1];
    const rRow = ref.comp[i][1];
    assert.deepEqual(Object.keys(eRow).sort(), Object.keys(rRow).sort(), `${engine.comp[i][0]} 构成字段`);
    for (const key of Object.keys(rRow)) {
      assertClose(eRow[key], rRow[key], `comp ${engine.comp[i][0]} ${key}`, 1e-6, 0.01);
    }
  }
});

test('差分：组合回测 once 权重合计 80%（留 20% 现金）与参考实现一致', () => {
  const fixture = portfolioFixture([['AAA', 50], ['CCC', 30]]);
  const engine = runPortfolioBacktest(clone(fixture));
  const ref = refPortfolioOnce(clone(fixture));

  assertSeriesClose(engine.nav, ref.nav, '80% nav');
  assertSeriesClose(engine.navR, ref.navR, '80% navR');
  assertClose(engine.end, ref.end, '80% 期末净值');
  assertClose(engine.endR, ref.endR, '80% 期末不复投净值');
  assertClose(engine.totalDiv, ref.totalDiv, '80% 累计分红');
  assert.equal(engine.yearly.length, ref.yearly.length);
  for (let i = 0; i < engine.yearly.length; i++) {
    assertClose(engine.yearly[i].nav1, ref.yearly[i].nav1, `${engine.yearly[i].year} 年末净值`);
    assertClose(engine.yearly[i].cash, ref.yearly[i].cash, `${engine.yearly[i].year} 年末现金`, 1e-6, 0.01);
  }
  // 结构上仍保留 20% 现金：期末现金 > 0 且远大于 100% 仓位场景的零头
  assert.ok(engine.cashEnd > 100000, `留 20% 现金的期末现金应显著大于 0，实际 ${engine.cashEnd}`);
});

/* ============================ 3. 个股回测差分 ============================ */

const HEALTHY_FIN = {
  A: [
    [2018, 1.2, 12, 0, 0, 1.0],
    [2019, 1.2, 12, 0, 0, 1.0],
    [2020, 1.2, 12, 0, 0, 1.0],
  ],
};

function assertStockMatch(engine, ref, label) {
  assertSeriesClose(engine.nav, ref.nav, `${label} nav`);
  assertSeriesClose(engine.navHold, ref.navHold, `${label} navHold`);
  assertClose(engine.end, ref.end, `${label} end`);
  assertClose(engine.endHold, ref.endHold, `${label} endHold`);
  assertClose(engine.totalDiv, ref.totalDiv, `${label} totalDiv`);
  assert.deepEqual(engine.trades.map((t) => [t.date, t.type]), ref.trades.map((t) => [t.date, t.type]), `${label} 交易流水（日期+类型）`);
  assert.equal(engine.yearly.length, ref.yearly.length, `${label} 年度条数`);
  for (let i = 0; i < engine.yearly.length; i++) {
    assert.equal(engine.yearly[i].year, ref.yearly[i].year);
    assertClose(engine.yearly[i].nav0, ref.yearly[i].nav0, `${label} ${engine.yearly[i].year} 年初`);
    assertClose(engine.yearly[i].nav1, ref.yearly[i].nav1, `${label} ${engine.yearly[i].year} 年末`);
    assertClose(engine.yearly[i].div, ref.yearly[i].div, `${label} ${engine.yearly[i].year} 分红`);
  }
}

test('差分：个股回测 平稳价格 + 分红（买一次持有）与参考实现一致', () => {
  const fixture = stockFixture({
    priceFn: () => 10,
    dividends: { A: { years: { 2018: 1, 2019: 1, 2020: 1 } } },
    finHistory: HEALTHY_FIN,
  });
  const engine = runStockBacktest(clone(fixture));
  const ref = refStockBacktest(clone(fixture));
  assertStockMatch(engine, ref, '平稳');
  assert.equal(engine.stats.buys, 1, '应只买入一次（2019-04）');
  assert.equal(engine.stats.sells, 0, '质量过关 + 分红不下调 → 不卖');
  const buy = engine.trades.find((t) => t.type === '买入');
  assert.equal(buy.date, '2019-04-30');
  // 买入前现金已吃 3 个月日息，故股数 = floor((100 万+利息)/10/100)*100 = 100,300 股（不是恰好 10 万）
  assert.equal(buy.shares, 100300);
  // years 2018/2019/2020 摊成 2019/2020/2021 三个 6-30 除权日；2019-04 买入后三笔全收
  assert.equal(engine.totalDiv, 3 * buy.shares * 1, '2019/2020/2021 三个除权日各收到「持股数 × 1 元」分红');
});

test('差分：个股回测 线性上涨 + 分红下调 ≥5% 触发卖出，与参考实现一致', () => {
  const fixture = stockFixture({
    priceFn: (i) => 10 + i * 0.2,
    // 2021 年 4 月决策时：years[2020]=0.5 < 0.95 × years[2019]=1 → 分红下调卖出
    dividends: { A: { years: { 2018: 1, 2019: 1, 2020: 0.5 } } },
    finHistory: HEALTHY_FIN,
  });
  const engine = runStockBacktest(clone(fixture));
  const ref = refStockBacktest(clone(fixture));
  assertStockMatch(engine, ref, '上涨+分红下调');
  assert.equal(engine.stats.sells, 1, '分红下调 ≥5% → 卖出一次');
  assert.equal(engine.trades.filter((t) => t.type === '卖出')[0].date, '2021-04-30');
});

test('差分：个股回测 质量否决（EPS 转负）触发卖出，与参考实现一致', () => {
  const fixture = stockFixture({
    priceFn: () => 10,
    dividends: { A: { years: { 2018: 1, 2019: 1, 2020: 1 } } },
    finHistory: { A: [[2018, 1.2, 12, 0, 0, 1.0], [2019, 1.2, 12, 0, 0, 1.0], [2020, -0.1, 12, 0, 0, 1.0]] },
  });
  const engine = runStockBacktest(clone(fixture));
  const ref = refStockBacktest(clone(fixture));
  assertStockMatch(engine, ref, '质量否决');
  assert.equal(engine.stats.sells, 1, '2020 年报 EPS 转负 → 2021-04 卖出一次');
  assert.equal(engine.trades.filter((t) => t.type === '卖出')[0].date, '2021-04-30');
});

/* ============================ 4. 随机种子 / 纯函数性 / 复投对照 ============================ */

test('差分（固定种子 7/21/99）：随机价格与分红下组合回测 once 与参考实现一致', () => {
  for (const seed of [7, 21, 99]) {
    const fixture = randomPortfolioFixture(seed);
    const engine = runPortfolioBacktest(clone(fixture));
    const ref = refPortfolioOnce(clone(fixture));
    assert.equal(Math.round(fixture.holdings.reduce((s, h) => s + h.weight, 0)), 100, `seed${seed} 权重合计应=100`);
    assertSeriesClose(engine.nav, ref.nav, `seed${seed} nav`);
    assertSeriesClose(engine.navR, ref.navR, `seed${seed} navR`);
    assertClose(engine.end, ref.end, `seed${seed} end`);
    assertClose(engine.endR, ref.endR, `seed${seed} endR`);
    assertClose(engine.totalDiv, ref.totalDiv, `seed${seed} totalDiv`);
    assert.equal(engine.yearly.length, ref.yearly.length, `seed${seed} 年度条数`);
    for (let i = 0; i < engine.yearly.length; i++) {
      assertClose(engine.yearly[i].nav1, ref.yearly[i].nav1, `seed${seed} ${engine.yearly[i].year} 年末净值`);
      assertClose(engine.yearly[i].div, ref.yearly[i].div, `seed${seed} ${engine.yearly[i].year} 分红`);
    }
  }
});

test('纯函数性：同输入两次调用，组合/计划回测结果逐字节一致', () => {
  const fixture = portfolioFixture([['AAA', 40], ['BBB', 35], ['CCC', 25]]);
  const p1 = runPortfolioBacktest(clone(fixture));
  const p2 = runPortfolioBacktest(clone(fixture));
  assert.equal(JSON.stringify(p1), JSON.stringify(p2), '组合回测两次结果应逐字节一致');

  const plan = planFixture();
  const q1 = runPlanBacktest(clone(plan));
  const q2 = runPlanBacktest(clone(plan));
  assert.equal(JSON.stringify(q1), JSON.stringify(q2), '计划回测两次结果应逐字节一致');
});

test('对照：分红复投 vs 不复投——累计分红相同；本夹具上涨场景复投期末净值更高', () => {
  const fixture = portfolioFixture([['AAA', 40], ['BBB', 35], ['CCC', 25]]);
  const r = runPortfolioBacktest(clone(fixture));
  // 两条路径的现金分红金额是同一套持仓/年度数据，累计分红必须一致（引擎只在 N 口径统计 divByY，
  // 参考实现里 navR 的分红只进现金，总额相同）
  const ref = refPortfolioOnce(clone(fixture));
  assertClose(ref.totalDiv, r.totalDiv, '复投/不复投的累计分红应一致');
  // 该夹具整体上涨：分红复投（买更多股数）期末应高于分红躺现金
  assert.ok(r.end > r.endR, `上涨场景复投期末应更高：复投 ${r.end} vs 不复投 ${r.endR}`);
  assert.ok(r.endR > 0 && Number.isFinite(r.endR));
});
