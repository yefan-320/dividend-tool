/**
 * 差分测试补齐：replay 持仓回放 + buildBenchmark + market 工具边界。
 *
 * 原则：参考实现只 import 引擎/工具函数，按 src 注释口径独立重写；固定夹具、不依赖当前日期；
 * 容差 1e-6 相对误差（金额 / round 到分处 0.01 元）。
 *
 * 覆盖：
 *  A. runPortfolioBacktest(mode='replay')：lots + cash0 起点、4 月末分红（复投本股 / 不进股票）、
 *     现金日息、monthlyAdd；对照 nav/navR 逐点、comp、divByY/divByCode、yearly、cashEnd、
 *     end/endR、stats.ret/retR/cagr/cagrR、events、builds/pending；边界（cash0=0、空 lots、
 *     无行情代码、空 holdings、分红 0、重复 lots 合并）。
 *     口径来源：src/engine/portfolioBacktest.js:726-833（runReplay）、:185-245（wrapper 收益率/基准口径）。
 *  B. buildBenchmark：本金买指数 + 4/12 月末追加；对照 rows 逐点、end、cagr（flows / non-flows）。
 *     口径来源：src/engine/portfolioBacktest.js:120-150。
 *  C. market.js 纯工具：monthEnd / buildSeries / buildTradingDates / priceAt / isMonthEnd /
 *     lastDateOfMonth / prevDps / qualityOf / dyQuality / annualize / maxDrawdown / sharpeOf / xirr。
 *     口径来源：src/engine/market.js 全文件。
 *  D. replay 忽略 entry、builds/pending 语义回归。
 *
 * 运行：cd 红利工具 && node --test test/*.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runPortfolioBacktest, buildBenchmark } from '../src/engine/portfolioBacktest.js';
import {
  monthEnd, buildSeries, buildTradingDates, priceAt, isMonthEnd, lastDateOfMonth, prevDps,
  qualityOf, dyQuality, annualize, maxDrawdown, sharpeOf, xirr,
} from '../src/engine/market.js';

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
function refXirr(flows) {
  const list = flows.filter(([d, a]) => Number.isFinite(a) && a !== 0 && d);
  if (list.length < 2) return null;
  const t0 = Math.min(...list.map(([d]) => Date.parse(d)));
  const ts = list.map(([d, a]) => [(Date.parse(d) - t0) / MS / 365.25, a]);
  if (!(Math.max(...ts.map(([t]) => t)) > 0)) return null;
  const npv = (r) => ts.reduce((s, [t, a]) => s + a / Math.pow(1 + r, t), 0);
  let lo = -0.9999, hi = 10, flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2, f = npv(mid);
    if (Math.abs(f) < 1e-10) return mid;
    if (flo * f <= 0) { hi = mid; fhi = f; } else { lo = mid; flo = f; }
  }
  return (lo + hi) / 2;
}
function refAnnualize(totalRet, from, to) {
  if (!Number.isFinite(totalRet)) return null;
  const days = (Date.parse(to) - Date.parse(from)) / MS;
  if (!(days > 0)) return null;
  const v = Math.pow(1 + totalRet, 365.25 / days) - 1;
  return Number.isFinite(v) ? v : null;
}


/* ================= 参考实现 A：replay ================= */
function refReplay({ codes, dates, series, dividends = {}, lots = [], cash0 = 0, monthlyAdd = 0, capital, from, to, entry = null }) {
  const px = (code, date) => priceAtRef(series.get(code), date);
  const base = new Map();
  for (const lot of lots) {
    const c = lot.code;
    if (!c) continue;
    base.set(c, (base.get(c) || 0) + (Number(lot.shares) || 0));
  }
  for (const c of codes) if (!base.has(c)) base.set(c, 0);
  const shN = new Map(base);
  const shR = new Map(base);
  let cash = cash0, cashR = cash0;
  const codesAll = [...new Set([...codes, ...base.keys()])].filter((c) => (base.get(c) || 0) > 0);
  const valueAt = (date, shares) => codesAll.reduce((s, c) => {
    const n = shares.get(c) || 0;
    if (n <= 0) return s;
    const p = px(c, date);
    return p > 0 ? s + n * p : s;
  }, 0);
  const nav = [], navR = [], comp = [], events = [], yearly = [];
  const divByY = {}, divByCode = {};
  const flowsN = [[dates[0], -cash0]], flowsR = [[dates[0], -cash0]];
  const initValue = cash0 + valueAt(dates[0], shN);
  let lastYear = null, yearNav0 = initValue, yearDiv = 0, yearAdds = 0, yearCash = cash0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const y = Number(date.slice(0, 4));
    const monthEnd = isMonthEndRef(dates, i);
    const isAprEnd = monthEnd && date.slice(5, 7) === '04';
    const isDecEnd = monthEnd && date.slice(5, 7) === '12';
    if (lastYear != null && y !== lastYear) {
      yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[i - 1][1], div: yearDiv, cash: yearCash, invest: yearAdds });
      yearNav0 = nav[i - 1][1];
      yearDiv = 0; yearAdds = 0;
    }
    lastYear = y;
    if (i > 0) {
      const days = daysBetween(dates[i - 1], date);
      if (cash > 0) cash *= 1 + DAY_RATE * days;
      if (cashR > 0) cashR *= 1 + DAY_RATE * days;
    }
    if (isAprEnd) {
      for (const c of codesAll) {
        const dps = prevDpsRef(dividends, c, y);
        if (!(dps > 0)) continue;
        const n = shN.get(c) || 0;
        const amt = n * dps;
        const p = px(c, date);
        if (amt > 0 && p > 0) {
          const buy = Math.floor(amt / p / 100) * 100;
          shN.set(c, n + buy);
          cash += amt - buy * p;
        } else cash += amt;
        cashR += (shR.get(c) || 0) * dps;
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
      cash += amt; cashR += amt; yearAdds += amt;
      flowsN.push([date, amt]); flowsR.push([date, amt]);
      events.push({ date, type: '追加', amount: amt, why: '月追加（6 个月）' });
    }
    const v = cash + valueAt(date, shN);
    const vR = cashR + valueAt(date, shR);
    nav.push([date, v]); navR.push([date, vR]);
    const row = { cash: +cash.toFixed(2) };
    for (const c of codesAll) {
      const n = shN.get(c) || 0;
      const p = px(c, date);
      if (n > 0 && p > 0) row[c] = +(n * p).toFixed(2);
    }
    comp.push([date, row]);
    yearCash = cash;
  }
  yearly.push({ year: lastYear, nav0: yearNav0, nav1: nav[nav.length - 1][1], div: yearDiv, cash: yearCash, invest: yearAdds });
  const lastDate = dates[dates.length - 1];
  const end = nav[nav.length - 1][1];
  const endR = navR[navR.length - 1][1];
  const totalIn = capital + yearly.reduce((s, x) => s + (x.invest || 0), 0);
  const hasAdd = totalIn > capital;
  const ret = initValue > 0 ? end / initValue - 1 : null;
  const retR = initValue > 0 ? endR / initValue - 1 : null;
  const cagr = hasAdd ? refXirr(flowsN.concat([[lastDate, end]])) : (ret == null ? null : refAnnualize(ret, from ?? dates[0], to ?? lastDate));
  const cagrR = hasAdd ? refXirr(flowsR.concat([[lastDate, endR]])) : (retR == null ? null : refAnnualize(retR, from ?? dates[0], to ?? lastDate));
  return { nav, navR, comp, events, divByY, divByCode, yearly, cashEnd: cash, end, endR, ret, retR, cagr, cagrR, totalDiv: Object.values(divByY).reduce((s, x) => s + x, 0), totalIn };
}

/* ================= 参考实现 B：buildBenchmark ================= */
function refBuildBenchmark({ dates, rows, capital, monthlyAdd = 0, from, to, flows = false }) {
  const idx = new Map(rows);
  let first = null;
  for (const d of dates) if (idx.has(d)) { first = d; break; }
  if (!first) return null;
  const prices = [];
  let last = null;
  for (const d of dates) { if (idx.has(d)) last = idx.get(d); prices.push(last); }
  const p0 = prices[0];
  if (!(p0 > 0)) return null;
  let units = capital / p0;
  const flowsOut = [[dates[0], -capital]];
  const out = [[dates[0], capital]];
  for (let i = 1; i < dates.length; i++) {
    const d = dates[i];
    const p = prices[i];
    if (!(p > 0)) { out.push([d, units * p0]); continue; }
    const monthEnd = isMonthEndRef(dates, i);
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
    ? refXirr(flowsOut.concat([[dates[dates.length - 1], end]]))
    : refAnnualize(end / capital - 1, from, to);
  return { rows: out, end, cagr };
}


/* ============================ market 工具参考实现（独立重写） ============================ */

/** 月末日期：给定 YYYY-MM 取当月最后一天（Date.UTC(y, m, 0) 即 m 月 0 号 = m-1 月最后一天） */
function refMonthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** 月线 + 日 K 拼接：月线只保留 < 日 K 首日的点；日 K 丢弃 null/<=0；不做排序 */
function refBuildSeries({ cal, daily, monthly }) {
  const dates = [];
  const closes = [];
  const dailyStart = cal && cal.length ? cal[0] : null;
  for (const [ym, close] of monthly || []) {
    if (!(close > 0)) continue;
    const d = refMonthEnd(ym);
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

/** 回测日历：指数日线 ∪ 日 K 日历（区间过滤）；两者都空时用月线月末兜底 */
function refBuildTradingDates({ indexRows = [], dailyCal = [], monthly = {}, from, to }) {
  const set = new Set();
  for (const [d] of indexRows) if (d >= from && d <= to) set.add(d);
  for (const d of dailyCal) if (d >= from && d <= to) set.add(d);
  if (!set.size) {
    for (const rows of Object.values(monthly)) {
      for (const [ym] of rows) {
        const d = refMonthEnd(ym);
        if (d >= from && d <= to) set.add(d);
      }
    }
  }
  return [...set].sort();
}

/** 朴素价格查询：最后一个 <= date 的收盘（参考实现用线性扫描，不用引擎的二分） */
function refPriceAt(series, date) {
  if (!series || !series.dates.length) return null;
  let out = null;
  for (let i = 0; i < series.dates.length; i++) {
    if (series.dates[i] <= date) out = series.closes[i];
    else break;
  }
  return out;
}

/** 某年某月最后一个交易日（升序日历；超过 ym-31 就提前结束） */
function refLastDateOfMonth(dates, ym) {
  let hit = null;
  for (const d of dates) {
    if (d.slice(0, 7) === ym) hit = d;
    else if (d > ym + '-31') break;
  }
  return hit;
}

/** 财务质量（year 年报行 [year, eps, roe, nm, liab, ocfps, np]） */
function refQualityOf(finHistory, code, year) {
  const rows = finHistory?.[code] || [];
  const hit = rows.find((r) => r[0] === year);
  if (!hit) return { ok: false, why: '缺财报' };
  const eps = hit[1];
  const roe = hit[2];
  const ocfps = hit[5];
  if (!(eps > 0)) return { ok: false, why: '亏损' };
  if (roe != null && roe < 5) return { ok: false, why: 'ROE 偏低' };
  if (ocfps != null && eps > 0 && ocfps / eps < 0.7) return { ok: false, why: '现金流覆盖不足' };
  return { ok: true, why: '' };
}

/** 股息率/支付率/现金流覆盖（DPS 用上一年度；财报用 year-1 年报） */
function refDyQuality({ dividends, finHistory, code, year, price }) {
  const dps = prevDpsRef(dividends, code, year);
  if (!(dps > 0) || !(price > 0)) return { dy: null, payout: null, cover: null };
  const rows = finHistory?.[code] || [];
  const fin = rows.find((r) => r[0] === year - 1);
  const eps = fin ? fin[1] : null;
  const ocfps = fin ? fin[5] : null;
  return {
    dy: (dps / price) * 100,
    payout: eps > 0 ? (dps / eps) * 100 : null,
    cover: eps > 0 && ocfps != null ? ocfps / eps : null,
  };
}

/** 最大回撤（rows: [[date, value]]） */
function refMaxDrawdown(rows) {
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

/** 日收益年化夏普 */
function refSharpeOf(rows, riskFree = 0.02) {
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

/* ============================ A. replay 差分 ============================ */

/** 组合回测 replay 差分：逐点 nav/navR、comp、div、yearly、events、end/cashEnd、ret/cagr */
function diffReplay({ name, dates, series, dividends = {}, holdings = [], lots = [], cash0 = 0, monthlyAdd = 0, entry = null }) {
  // 与 UI 一致：replay 时 capital 传期初净值（只影响 hasAdd/基准口径；ret 基准是 nav[0]）
  const baseOpts = { dates, series, dividends, holdings, lots, cash0, monthlyAdd, from: dates[0], to: dates.at(-1), mode: 'replay', entry };
  const startValue = runPortfolioBacktest(clone(baseOpts)).nav[0][1];
  const engine = runPortfolioBacktest(clone({ ...baseOpts, capital: startValue }));
  const ref = refReplay({ codes: holdings.map((h) => h.code), dates, series, dividends, lots, cash0, monthlyAdd, capital: startValue, from: dates[0], to: dates.at(-1) });

  assert.equal(engine.nav.length, ref.nav.length, `${name}: nav 长度`);
  for (let i = 0; i < engine.nav.length; i++) {
    assert.equal(engine.nav[i][0], ref.nav[i][0], `${name}: nav 日期`);
    assertClose(engine.nav[i][1], ref.nav[i][1], `${name}: nav ${engine.nav[i][0]}`);
    assertClose(engine.navR[i][1], ref.navR[i][1], `${name}: navR ${engine.navR[i][0]}`);
  }
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
  assertClose(engine.cashEnd, ref.cashEnd, `${name}: cashEnd`, 1e-9, 0.01);
  assertClose(engine.totalDiv, ref.totalDiv, `${name}: totalDiv`);
  assertClose(engine.totalIn, ref.totalIn, `${name}: totalIn`, 1e-9, 1e-9);
  assert.deepEqual(engine.divByY, ref.divByY, `${name}: divByY`);
  assert.deepEqual(engine.divByCode, ref.divByCode, `${name}: divByCode`);
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
  assert.deepEqual(engine.events, ref.events, `${name}: events（分红/追加逐条）`);
  for (const k of ['ret', 'retR', 'cagr', 'cagrR']) {
    if (engine.stats[k] === null || ref[k] === null) {
      assert.equal(engine.stats[k], ref[k], `${name}: stats.${k} 空值一致性`);
    } else {
      assertClose(engine.stats[k], ref[k], `${name}: stats.${k}`, 1e-6, 1e-9);
    }
  }
  assert.deepEqual(engine.builds, [], `${name}: replay 不应有 builds`);
  assert.deepEqual(engine.pending, [], `${name}: replay 不应有 pending`);
  return engine;
}

const RP_DATES = monthEndDates(2019, 2021);
function rpSeries(spec) {
  const series = new Map();
  for (const [code, f] of Object.entries(spec)) {
    const closes = RP_DATES.map((_, i) => Math.round(f.fn(i) * 100) / 100);
    series.set(code, { dates: [f.pre, ...RP_DATES], closes: [Math.round(f.fn(-1) * 100) / 100, ...closes] });
  }
  return series;
}
const RP_SERIES = rpSeries({
  AAA: { pre: '2016-06-30', fn: (i) => 10 + i * 0.05 },
  BBB: { pre: '2016-06-30', fn: (i) => 20 + Math.sin(i / 3) * 2 },
  CCC: { pre: '2016-06-30', fn: (i) => 5 + (i % 4) * 0.3 },
});
const RP_DIVS = { AAA: { years: { 2018: 0.5, 2019: 0.6, 2020: 0.55 } }, BBB: { years: { 2018: 1, 2019: 1.1, 2020: 1.05 } } };

test('差分：replay 常规（lots+cash0+分红）——nav/navR/comp/div/yearly/events/ret 与参考一致', () => {
  const r = diffReplay({
    name: 'replay 常规',
    dates: RP_DATES, series: RP_SERIES, dividends: RP_DIVS,
    holdings: [{ code: 'AAA', weight: 50 }, { code: 'BBB', weight: 30 }],
    lots: [{ code: 'AAA', shares: 10000 }, { code: 'BBB', shares: 5000 }],
    cash0: 100000,
  });
  // 起点净值 = cash0 + lots 市值（持有 10000×AAA + 5000×BBB）
  const startValue = 100000 + 10000 * 10 + 5000 * 20;
  assert.equal(Math.round(r.nav[0][1]), startValue);
  assertClose(r.stats.ret, r.end / startValue - 1, 'ret 以期初净值为基准（replay 与 capital 无关）');
  assertClose(r.stats.retR, r.endR / startValue - 1, 'retR 同基准');
  assert.ok(r.events.some((e) => e.type === '分红' && e.code === 'AAA'));
  // 复盘口径：分红复投（nav）通常高于红利不进股票（navR）
  assert.ok(r.end > r.endR, `分红复投期末应更高：${r.end} vs ${r.endR}`);
});

test('差分：replay + 月追加——totalIn/追加事件/cagr（XIRR 分支）一致', () => {
  const r = diffReplay({
    name: 'replay+add',
    dates: RP_DATES, series: RP_SERIES, dividends: RP_DIVS,
    holdings: [{ code: 'AAA', weight: 50 }, { code: 'BBB', weight: 30 }],
    lots: [{ code: 'AAA', shares: 10000 }, { code: 'BBB', shares: 5000 }],
    cash0: 100000,
    monthlyAdd: 20000,
  });
  const startValue = 100000 + 10000 * 10 + 5000 * 20;
  // 2019/2020/2021 每年 4/12 月末：6 次 × 6 个月 × 2 万 = 72 万
  assert.equal(r.totalIn, startValue + 20000 * 6 * 6);
  assert.equal(r.events.filter((e) => e.type === '追加').length, 6);
  assert.ok(Number.isFinite(r.stats.cagr), 'XIRR 年化应为有限数');
  assert.ok(r.stats.cagr !== null);
});

test('差分：replay 边界 cash0=0 / 重复 lots 合并 —— 分红只够买整手、零头留现金', () => {
  const r = diffReplay({
    name: 'replay cash0=0',
    dates: RP_DATES, series: RP_SERIES, dividends: RP_DIVS,
    holdings: [{ code: 'AAA', weight: 100 }],
    lots: [{ code: 'AAA', shares: 6000 }, { code: 'AAA', shares: 4000 }], // 重复 lots → 合并 10000 股
    cash0: 0,
  });
  assert.equal(Math.round(r.nav[0][1]), 10000 * 10, '起点净值 = 合并后 10000 股 × 10 元');
  assert.equal(Math.round(r.nav[0][1]), 100000);
  // 分红复投本股是 100 股整手，零头留现金 → 期末现金很小但不为负
  assert.ok(r.cashEnd >= 0 && r.cashEnd < 10000, `现金零头应很小，实际 ${r.cashEnd}`);
});

test('差分：replay 其他边界（空 lots 纯现金 / 无行情代码 / 分红 0 / 空 holdings）', () => {
  // 空 lots：纯现金吃日息
  const r1 = diffReplay({
    name: 'replay 空 lots', dates: RP_DATES, series: RP_SERIES, dividends: RP_DIVS,
    holdings: [{ code: 'AAA', weight: 100 }], lots: [], cash0: 200000,
  });
  assertClose(r1.end, 200000 * Math.pow(1 + 0.015 / 365, 1), '空持仓时净值≈现金吃息（此处仅作合理性示意）', 0.2);
  assert.equal(r1.events.length, 0);
  assert.ok(r1.end > 200000);

  // lots 含无行情代码：该代码市值按 0 计、不崩；分红为 0 时无分红事件
  const r2 = diffReplay({
    name: 'replay 无行情代码', dates: RP_DATES, series: RP_SERIES, dividends: {},
    holdings: [{ code: 'AAA', weight: 50 }, { code: 'NODATA', weight: 50 }],
    lots: [{ code: 'AAA', shares: 5000 }, { code: 'NODATA', shares: 1000 }], cash0: 50000,
  });
  assert.equal(Math.round(r2.nav[0][1]), 50000 + 5000 * 10, '无行情代码市值按 0 计');
  assert.equal(r2.totalDiv, 0);
  assert.equal(r2.events.length, 0);

  // 空 holdings（wOf 空）+ 只有 lots：仍应按 lots 回放
  const r3 = diffReplay({
    name: 'replay 空 holdings', dates: RP_DATES, series: RP_SERIES, dividends: RP_DIVS,
    holdings: [], lots: [{ code: 'AAA', shares: 8000 }], cash0: 100000,
  });
  assert.equal(Math.round(r3.nav[0][1]), 100000 + 8000 * 10);
  assert.ok(r3.events.some((e) => e.type === '分红'));
});

test('回归：replay 忽略 entry（结果无效）、builds/pending 恒为空、entry 原样回显归一化参数', () => {
  const baseOpts = { dates: RP_DATES, series: RP_SERIES, dividends: RP_DIVS, holdings: [{ code: 'AAA', weight: 100 }], lots: [{ code: 'AAA', shares: 10000 }], cash0: 100000, monthlyAdd: 0, from: RP_DATES[0], to: RP_DATES.at(-1), mode: 'replay' };
  const a = runPortfolioBacktest(clone(baseOpts));
  const b = runPortfolioBacktest(clone({ ...baseOpts, entry: { mode: 'staged', months: 6 } }));
  const c = runPortfolioBacktest(clone({ ...baseOpts, entry: { mode: 'dip', minDy: 4 } }));
  for (const other of [b, c]) {
    assert.deepEqual(other.nav, a.nav, 'replay 的 nav 不应受 entry 影响');
    assert.deepEqual(other.navR, a.navR);
    assert.deepEqual(other.comp, a.comp);
    assert.deepEqual(other.events, a.events);
    assert.deepEqual(other.builds, []);
    assert.deepEqual(other.pending, []);
  }
  // entry 字段仍回显归一化参数（行为忽略但不丢弃参数——前端不用判空）
  assert.deepEqual(b.entry, { mode: 'staged', months: 6, minDy: 5.5, installments: [], triggered: {}, neverTriggered: [] });
  assert.deepEqual(c.entry, { mode: 'dip', months: 12, minDy: 4, installments: [], triggered: {}, neverTriggered: [] });
});

/* ============================ B. buildBenchmark 差分 ============================ */

function diffBench({ name, dates, rows, capital = 1000000, monthlyAdd = 0, from, to, flows }) {
  const engine = buildBenchmark(clone({ dates, rows, capital, monthlyAdd, from, to, flows }));
  const ref = refBuildBenchmark(clone({ dates, rows, capital, monthlyAdd, from, to, flows }));
  assert.equal(engine === null, ref === null, `${name}: null 一致性`);
  if (engine) {
    assert.equal(engine.rows.length, ref.rows.length, `${name}: rows 长度`);
    for (let i = 0; i < ref.rows.length; i++) {
      assert.equal(engine.rows[i][0], ref.rows[i][0], `${name}: rows ${i} 日期`);
      assertClose(engine.rows[i][1], ref.rows[i][1], `${name}: rows ${ref.rows[i][0]}`);
    }
    assertClose(engine.end, ref.end, `${name}: end`);
    if (engine.cagr === null || ref.cagr === null) assert.equal(engine.cagr, ref.cagr, `${name}: cagr 空值一致性`);
    else assertClose(engine.cagr, ref.cagr, `${name}: cagr`, 1e-6, 1e-9);
  }
  return { engine, ref };
}

test('差分：buildBenchmark non-flows 分支——rows/end/cagr 与参考一致（并对照回测 wrapper 的 bench）', () => {
  const dates = monthEndDates(2020, 2021);
  const rows = dates.map((d, i) => [d, 1000 + i * 3]);
  const { engine } = diffBench({ name: 'BM non-flows', dates, rows, capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), flows: false });
  assert.ok(engine !== null);
  assert.ok(engine.cagr !== null);

  // 回测 wrapper 的 bench 字段应与独立调用 buildBenchmark 结果一致
  const r = runPortfolioBacktest({
    dates, series: new Map([['AAA', { dates: ['2016-06-30', ...dates], closes: [10, ...dates.map(() => 10)] }]]),
    dividends: {}, holdings: [{ code: 'AAA', weight: 100 }], capital: 1000000, monthlyAdd: 0,
    from: dates[0], to: dates.at(-1), mode: 'invest', benchmarkSeries: rows,
  });
  const refBench = refBuildBenchmark({ dates, rows, capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), flows: false });
  assert.equal(r.bench.rows.length, refBench.rows.length);
  for (let i = 0; i < refBench.rows.length; i++) assertClose(r.bench.rows[i][1], refBench.rows[i][1], `wrapper bench ${refBench.rows[i][0]}`);
  assertClose(r.bench.end, refBench.end, 'wrapper bench end');
  assertClose(r.bench.cagr, refBench.cagr, 'wrapper bench cagr', 1e-6, 1e-9);
});

test('差分：buildBenchmark flows 分支——4/12 月末追加（XIRR）', () => {
  const dates = monthEndDates(2019, 2021);
  const rows = dates.map((d, i) => [d, 1000 + i * 2]);
  const { engine } = diffBench({ name: 'BM flows', dates, rows, capital: 1000000, monthlyAdd: 10000, from: dates[0], to: dates.at(-1), flows: true });
  // 4/12 月末共 6 次追加 → 指数份额增加
  assert.equal(engine.rows.length, dates.length);
  assert.equal(engine.rows[0][1], 1000000, '起点 = 本金');
  assert.ok(engine.end > 1000000);
  assert.ok(engine.cagr !== null);
});

test('差分：buildBenchmark 边界——起点缺指数点位 / 起点点位 0 / 中间缺日期沿用上一点位', () => {
  const dates = monthEndDates(2020, 2020);
  // 起点没有指数数据 → 无法起算，返回 null
  const miss = buildBenchmark({ dates, rows: dates.slice(3).map((d, i) => [d, 1000 + i]), capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), flows: false });
  assert.equal(miss, null);
  diffBench({ name: 'BM 起点缺失', dates, rows: dates.slice(3).map((d, i) => [d, 1000 + i]), capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), flows: false });
  // 起点点位 = 0 → 无法算份额，返回 null
  const zero = buildBenchmark({ dates, rows: dates.map((d, i) => [d, i === 0 ? 0 : 1000 + i]), capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), flows: false });
  assert.equal(zero, null);
  diffBench({ name: 'BM 起点0', dates, rows: dates.map((d, i) => [d, i === 0 ? 0 : 1000 + i]), capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), flows: false });
  // 中间缺日期：沿用上一点位（参考实现同样处理）
  diffBench({ name: 'BM 中间缺日期', dates, rows: dates.filter((_, i) => i % 7 !== 0).map((d, i) => [d, 1000 + i]), capital: 1000000, monthlyAdd: 0, from: dates[0], to: dates.at(-1), flows: false });
});

/* ============================ C. market 工具差分 ============================ */

test('差分：monthEnd / buildSeries——闰年 2 月末、跨年、月线与日 K 拼接优先级、0/负值/缺失丢弃', () => {
  // monthEnd：闰年 2 月 29 天、平年 28 天、12 月/1 月跨年
  for (const [ym, expected] of [['2020-02', '2020-02-29'], ['2019-02', '2019-02-28'], ['2021-12', '2021-12-31'], ['2022-01', '2022-01-31'], ['2019-01', '2019-01-31']]) {
    assert.equal(monthEnd(ym), expected, `monthEnd(${ym})`);
    assert.equal(monthEnd(ym), refMonthEnd(ym), `monthEnd(${ym}) 与参考一致`);
  }

  // 月线 + 日 K：月线日期 >= 日 K 首日 → 丢弃（日 K 优先）；日 K 的 null/0 丢弃；月线 <=0 丢弃
  const cases = [
    { cal: ['2019-01-02', '2019-01-03', '2019-01-04', '2019-01-07'], daily: { c: [10, null, 11, 0] }, monthly: [['2018-11', 8.5], ['2018-12', 9], ['2019-01', 99], ['2019-02', 12]] },
    { cal: ['2020-02-27', '2020-02-28', '2020-03-02'], daily: { c: [10, 10.5, 11] }, monthly: [['2020-01', 9], ['2020-02', 10], ['2020-03', 11]] },
    { cal: [], daily: null, monthly: [['2020-01', 9], ['2020-02', -1], ['2020-03', 11]] },
    { cal: null, daily: { c: [1, 2] }, monthly: [['2019-12', 9]] },
    { cal: ['2020-02-28'], daily: { c: [0] }, monthly: [['2020-02', 10], ['2020-03', 11], ['2020-04', 12]] },
  ];
  for (const [i, c] of cases.entries()) {
    const engine = buildSeries(clone(c));
    const ref = refBuildSeries(clone(c));
    assert.deepEqual(engine, ref, `buildSeries case${i}`);
  }
  // 显式断言拼接优先级：2019-01 的月线（日 K 首日所在月）必须被丢弃
  const merged = buildSeries(cases[0]);
  assert.ok(!merged.dates.includes('2019-01-31'), '日 K 覆盖的月份不用月线');
  assert.deepEqual(merged.dates.slice(0, 2), ['2018-11-30', '2018-12-31']);
});

test('差分：buildTradingDates——指数日线 ∪ 日 K 日历、区间过滤、空集时月线兜底', () => {
  const cases = [
    { indexRows: [['2019-12-30', 1], ['2019-12-31', 1], ['2020-01-02', 1]], dailyCal: ['2019-12-31', '2020-01-03'], monthly: {}, from: '2019-12-30', to: '2020-01-03' },
    { indexRows: [], dailyCal: [], monthly: { X: [['2019-12', 1], ['2020-01', 1], ['2020-02', 1]] }, from: '2020-01-01', to: '2020-01-31' },
    { indexRows: [], dailyCal: [], monthly: {}, from: '2020-01-01', to: '2020-12-31' },
    { indexRows: [['2019-01-01', 1]], dailyCal: ['2020-02-28', '2020-03-02'], monthly: {}, from: '2020-03-01', to: '2020-12-31' },
    { indexRows: [['2019-12-31', 1]], dailyCal: [], monthly: { X: [['2019-12', 1], ['2020-01', 1]] }, from: '2020-01-01', to: '2020-01-31' },
  ];
  for (const [i, c] of cases.entries()) {
    assert.deepEqual(buildTradingDates(clone(c)), refBuildTradingDates(clone(c)), `buildTradingDates case${i}`);
  }
  // 并集 + 排序去重
  assert.deepEqual(
    buildTradingDates({ indexRows: [['2020-01-03', 1], ['2020-01-02', 1]], dailyCal: ['2020-01-02', '2020-01-06'], monthly: {}, from: '2020-01-01', to: '2020-01-31' }),
    ['2020-01-02', '2020-01-03', '2020-01-06'],
  );
  // 无任何数据 → 空数组
  assert.deepEqual(buildTradingDates({ indexRows: [], dailyCal: [], monthly: {}, from: '2020-01-01', to: '2020-12-31' }), []);
});

test('差分：priceAt / isMonthEnd / lastDateOfMonth / prevDps——周末、停牌缺口、单点日历、跨年', () => {
  // priceAt：空序列 / 早于首点 / 周末与停牌（取不晚于的最近价）/ 精确命中 / 晚于末点
  const series = { dates: ['2020-01-02', '2020-01-03', '2020-01-07', '2020-02-03'], closes: [10, 10.5, 11, 12] };
  assert.equal(priceAt(null, '2020-01-02'), null);
  assert.equal(priceAt({ dates: [], closes: [] }, '2020-01-02'), null);
  for (const date of ['2019-12-31', '2020-01-02', '2020-01-04', '2020-01-06', '2020-01-07', '2020-01-20', '2020-02-03', '2020-03-01']) {
    assert.equal(priceAt(series, date), refPriceAt(series, date), `priceAt ${date}`);
  }
  assert.equal(priceAt(series, '2020-01-04'), 10.5, '周末取周五收盘（不晚于该日的最近价）');

  // isMonthEnd：月末交易日 / 月末遇周末（最后一个交易日）/ 跨年 12-31 / 单点日历（末点恒为月末）
  const cal = ['2020-01-30', '2020-01-31', '2020-02-03', '2020-02-27', '2020-02-28', '2020-03-02', '2020-12-31', '2021-01-04'];
  for (let i = 0; i < cal.length; i++) {
    assert.equal(isMonthEnd(cal, i), !cal[i + 1] || cal[i + 1].slice(0, 7) !== cal[i].slice(0, 7), `isMonthEnd ${cal[i]}`);
  }
  assert.equal(isMonthEnd(['2020-01-31'], 0), true);
  assert.equal(isMonthEnd(cal, 4), true, '2020-02-28 是 2 月最后一个交易日（周末顺延）');
  assert.equal(isMonthEnd(cal, 6), true, '跨年 2020-12-31');

  // lastDateOfMonth：正常月份 / 缺失月份 / 跨年日历
  for (const ym of ['2020-01', '2020-02', '2020-03', '2019-12', '2021-01']) {
    assert.equal(lastDateOfMonth(cal, ym), refLastDateOfMonth(cal, ym), `lastDateOfMonth(${ym})`);
  }
  assert.equal(lastDateOfMonth(cal, '2019-11'), null);

  // prevDps：上一年度为正才算；0 / 负数 / 缺失 → 0
  const divs = { X: { years: { 2019: 1, 2020: 0, 2021: -2, 2022: 0.5 } } };
  for (const y of [2020, 2021, 2022, 2023, 2024]) assert.equal(prevDps(divs, 'X', y), prevDpsRef(divs, 'X', y), `prevDps(${y})`);
  assert.equal(prevDps(divs, 'X', 2020), 1);
  assert.equal(prevDps(divs, 'X', 2023), 0.5);
  assert.equal(prevDps(null, 'X', 2020), 0);
});

test('差分：market 统计与质量工具（annualize/maxDrawdown/sharpeOf/xirr 有解/qualityOf/dyQuality）', () => {
  // annualize：正常年化 / 非有限 / 区间为 0
  assertClose(annualize(0.1, '2020-01-01', '2021-01-01'), refAnnualize(0.1, '2020-01-01', '2021-01-01'), 'annualize 正常', 1e-9, 1e-12);
  assert.equal(annualize(NaN, '2020-01-01', '2021-01-01'), null);
  assert.equal(annualize(0.1, '2021-01-01', '2020-01-01'), null);
  assert.equal(refAnnualize(NaN, '2020-01-01', '2021-01-01'), null);

  // maxDrawdown / sharpeOf：与独立实现逐字段一致
  const navRows = [['2020-01-31', 1], ['2020-02-29', 1.1], ['2020-03-31', 0.9], ['2020-04-30', 1.2], ['2020-05-31', 1.15]];
  assert.deepEqual(maxDrawdown(navRows), refMaxDrawdown(navRows));
  assertClose(sharpeOf(navRows), refSharpeOf(navRows), 'sharpeOf', 1e-9, 1e-12);
  assert.equal(sharpeOf([['d', 1], ['d2', 1]]), null, '样本不足 → null');
  assert.deepEqual(maxDrawdown([]), refMaxDrawdown([]));

  // xirr（有解）：引擎 Newton 与参考二分落在同一根上
  const flows1 = [['2020-01-01', -1000], ['2021-01-01', 1100]];
  const flows2 = [['2020-01-01', -1000], ['2020-07-01', -500], ['2021-01-01', 1600]];
  assertClose(xirr(flows1), refXirr(flows1), 'xirr 1 年 10%', 1e-6, 1e-9);
  assertClose(xirr(flows2), refXirr(flows2), 'xirr 多笔现金流', 1e-6, 1e-9);
  assert.equal(xirr([['2020-01-01', -100]]), null, '单笔现金流 → null');

  // qualityOf / dyQuality：与独立实现逐字段一致（含边界：eps=0 / roe<5 / 覆盖<0.7 / 缺财报 / 缺现金流）
  const fin = {
    X: [
      [2018, 1.2, 12, 0, 0, 1.0],
      [2019, 0, 12, 0, 0, 1.0],
      [2020, 1.2, 4, 0, 0, 1.0],
      [2021, 1.0, 12, 0, 0, 0.5],
      [2022, 1.0, 12, 0, 0, null],
    ],
  };
  for (const year of [2018, 2019, 2020, 2021, 2022, 2023]) {
    assert.deepEqual(qualityOf(fin, 'X', year), refQualityOf(fin, 'X', year), `qualityOf(${year})`);
  }
  assert.deepEqual(qualityOf({}, 'X', 2020), { ok: false, why: '缺财报' });

  const dividends = { X: { years: { 2023: 1.5, 2024: 1.6 } } };
  const dyCases = [
    { year: 2024, price: 30 },
    { year: 2025, price: 40 },
    { year: 2025, price: 0 },
    { year: 2026, price: 10 },
  ];
  for (const c of dyCases) {
    assert.deepEqual(
      dyQuality({ dividends, finHistory: fin, code: 'X', year: c.year, price: c.price }),
      refDyQuality({ dividends, finHistory: fin, code: 'X', year: c.year, price: c.price }),
      `dyQuality(${c.year}, ${c.price})`,
    );
  }
});

// BUG: market.js 的 xirr 缺少「无解 / 非法现金流」校验，返回天文数字或初值而不是 null。
// 位置：src/engine/market.js:188-207（Newton 迭代无最大 |npv|/收敛校验、不校验现金流时间跨度、不过滤非有限金额；
//      对比 src/engine/finance.js:14-32 的同名 xirr：过滤非法流、要求时间跨度>0、二分兜底返回 null）。
// 最小输入（纯函数）：
//   xirr([['2020-01-01', -1000], ['2021-01-01', -100]])      → 实际 6.137267767817306e+276，期望 null（全为负现金流，无 IRR 解）
//   xirr([['2020-01-01', -1000], ['2020-01-01', 1100]])      → 实际 0.1（初值），期望 null（同一天无法年化）
//   xirr([['2020-01-01', -1000], ['2021-01-01', NaN]])       → 实际 0.1（初值），期望 null（非法金额）
// 引擎可达路径：runPortfolioBacktest(invest, monthlyAdd>0) 且期末 nav=0（价格脏数据）时
//   stats.cagr 走 market.xirr → 返回 0.1 或天文数字，而不是 null（页面会显示荒谬年化）。
// 期望修复：参照 finance.js 的 xirr——过滤非有限/零金额、时间跨度<=0 返回 null、迭代后校验 |npv| 或加二分兜底。
test('// BUG: market.xirr 对无解 / 非法现金流返回天文数字或初值（应为 null）', () => {
  assert.equal(xirr([['2020-01-01', -1000], ['2021-01-01', -100]]), null, '全为负现金流无 IRR 解 → 期望 null');
  assert.equal(xirr([['2020-01-01', -1000], ['2020-01-01', 1100]]), null, '同一天现金流无法年化 → 期望 null');
  assert.equal(xirr([['2020-01-01', -1000], ['2021-01-01', NaN]]), null, '非法金额应被过滤 → 期望 null');
});
