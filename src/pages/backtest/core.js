/**
 * 回测页的状态与计算：btState / ctx、URL 与参数读写、数据加载、以及所有纯计算。
 * 不产生 HTML、不碰 DOM。ctx 与 compTimer 在这里持有，别处只读、改值走 setter
 * （ES module 的 import 是只读绑定，直接赋值会抛 TypeError）。
 */
import { db, loadCmpFin, loadDailyMany, loadDailyMeta, loadFinanceHistory, loadIndexDaily, loadMonthlyFor, quote } from '../../data.js';
import { loadCash, loadPlans, loadTxs } from '../../store.js';
import { buildSeries, buildTradingDates, monthEnd, priceAt } from '../../engine/market.js';
import { pct, pctSign } from '../../ui/format.js';
import { toast } from '../../ui/toast.js';

export const todayStr = () => db.generated || '2026-10-30';

export const DAY = 86400000;

export let rerenderHook = null;

export function setBacktestRerender(fn) { rerenderHook = fn; }

export const btState = {
  mode: 'port',           // port | stock | cmp
  portMode: 'invest',     // invest | replay
  from: null,
  to: null,
  capital: 1000000,
  monthlyAdd: 0,
  stock: '600036',      // 每次渲染时由 readBtUrl() 换成 d3:lastStock
  minDy: 5,
  quality: false,         // 个股回测质量筛选：默认关（只看走势，不拉财报）
  metric: 'nav',
  planId: 'current',
  cmpPlans: null,         // 组合对比里勾选的方案 id；null = 全选
  paramOpen: false,       // 参数抽屉：默认收起，先给结果，别让表单占满一屏
};

export let ctx = null;

export function setCtx(v) { ctx = v; }

export let compTimer = null;

export function setCompTimer(v) { compTimer = v; }

export function stopCompPlay() {
  if (compTimer) { clearInterval(compTimer); compTimer = null; }
  const btn = document.getElementById('compPlay');
  if (btn) btn.textContent = '播放 ▶';
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if ((location.hash || '').replace(/^#/, '').split('?')[0] !== 'backtest') stopCompPlay();
  });
  // e2e 用：确认换页后播放定时器确实停了
  window.__btDebug = () => ({ compTimer: !!compTimer });
}

export function addYears(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

export function clampFrom(f) {
  return f < '2012-01-01' ? '2012-01-01' : f;
}

export function structure() {
  if (btState.planId && btState.planId !== 'current') {
    const plan = loadPlans().find((p) => p.id === btState.planId);
    if (plan && plan.holdings?.length) {
      return {
        holdings: plan.holdings.map((h) => ({ code: h.code, weight: Number(h.weight) || 0 })),
        lots: [], cash: 0, total: 0, fallback: false, name: plan.name, plan: true,
        entry: plan.entry || { mode: 'once' }, capital: Number(plan.capital) || 0,
        cashPct: Math.max(0, 100 - plan.holdings.reduce((acc, h) => acc + (Number(h.weight) || 0), 0)),
      };
    }
  }
  const txs = loadTxs().filter((t) => t.side !== 'sell');
  const pos = new Map();
  for (const t of txs) {
    const code = String(t.code || '');
    if (!/^\d{6}$/.test(code)) continue;
    pos.set(code, (pos.get(code) || 0) + (Number(t.shares) || 0));
  }
  if (!pos.size) {
    const codes = (db.baseline?.holdings || []).filter((c) => quote(c));
    const use = codes.length ? codes : Object.keys(db.quotes).slice(0, 7);
    const w = 100 / Math.max(1, use.length);
    return { holdings: use.map((code) => ({ code, weight: w })), lots: [], cash: 0, total: 0, fallback: true, name: '演示持仓等权' };
  }
  const cash = loadCash();
  let total = cash;
  const vals = [];
  for (const [code, shares] of pos) {
    const q = quote(code);
    const v = (q?.p || 0) * shares;
    vals.push({ code, shares, v });
    total += v;
  }
  return {
    holdings: vals.map((x) => ({ code: x.code, weight: total > 0 ? (x.v / total) * 100 : 0 })),
    lots: vals.map((x) => ({ code: x.code, shares: x.shares })),
    cash,
    total,
    fallback: false,
    name: '当前持仓',
  };
}

function monthlyFromSeries(series) {
  if (!series || !series.dates || !series.dates.length) return [];
  const out = [];
  const { dates, closes } = series;
  for (let i = 0; i < dates.length; i++) {
    const ym = dates[i].slice(0, 7);
    const nextYm = i + 1 < dates.length ? dates[i + 1].slice(0, 7) : '';
    if (nextYm !== ym) out.push([ym, closes[i]]);
  }
  return out;
}

export async function loadMarket(codes, from, to, { finance = false, monthly = 'auto', marketWide = false, stockCode = null } = {}) {
  const dailyMeta = await loadDailyMeta();
  // 只有「起点早于日 K 起点（2014-06）」才需要月线补早期价格；
  // 而且只要当前这几只的月线分片（data/monthly/<code>.json，每只约 2.3KB），
  // 不再下 6.4MB 的整包 monthly.json——手机上那包要 48 秒，20 秒就超时了。
  const useMonthly = monthly !== false && from < dailyMeta.cal[0];
  const [monthsFull, index] = await Promise.all([useMonthly ? loadMonthlyFor(codes) : Promise.resolve(null), loadIndexDaily()]);
  // 历年财报按需：个股回测只拉目标股那一片（几 KB），不再下 1.9MB 的整包；
  // 对比模式的选股财报走 loadCmpFin()（约 257KB），不在这里出。
  // 拉不到就降级（不做质量筛选），不报错、不白屏。
  let finHistory = null;
  if (finance) {
    const finCodes = marketWide ? null : (stockCode ? [stockCode] : codes);
    finHistory = await loadFinanceHistory(finCodes);
  }
  const daily = await loadDailyMany(codes);
  const series = new Map();
  for (const c of codes) series.set(c, buildSeries({ cal: dailyMeta.cal, daily: daily.get(c), monthly: monthsFull ? monthsFull[c] : null }));
  // 没拉月线时用日 K 月末收盘顶替「月线」，只服务股息率分位/相似状态（拿到的其实是更细的日 K）
  const months = monthsFull || Object.fromEntries(codes.map((c) => [c, monthlyFromSeries(series.get(c))]));
  const dates = buildTradingDates({ indexRows: index.h00922.rows, dailyCal: dailyMeta.cal, monthly: monthsFull, from, to });
  return { months, marketMonths: monthsFull, finHistory, index, dailyMeta, daily, series, dates };
}

export function benchRows(index, benchmarkMonthly, from, to) {
  const rows = (index.h00922?.rows || []).filter(([d]) => d >= from && d <= to);
  const last = rows.length ? rows[rows.length - 1][0] : '';
  for (const [ym, v] of Object.entries(benchmarkMonthly || {})) {
    const d = monthEnd(ym);
    if (d > last && d <= to && v > 0) rows.push([d, v]);
  }
  return rows;
}

export function lowVolRows(index, from, to) {
  return (index.h30269?.rows || []).filter(([d]) => d >= from && d <= to);
}

function navAt(rows, date) {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? rows[ans][1] : null;
}

export function buyHoldNav(dates, series, holdings, capital, dividends) {
  const shares = new Map();
  const n = holdings.length || 1;
  let cash = capital;
  for (const h of holdings) shares.set(h.code, 0);
  const day0 = dates[0];
  for (const h of holdings) {
    const p = priceAt(series.get(h.code), day0);
    if (!(p > 0)) continue;
    const amt = capital / n;
    const sh = Math.floor(amt / p / 100) * 100;
    shares.set(h.code, sh);
    cash -= sh * p;
  }
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const y = Number(d.slice(0, 4));
    const monthEndDay = i === dates.length - 1 || dates[i + 1].slice(0, 7) !== d.slice(0, 7);
    if (monthEndDay && d.slice(5, 7) === '04') {
      for (const h of holdings) {
        const dps = dividends?.[h.code]?.years?.[y - 1];
        if (dps > 0) cash += (shares.get(h.code) || 0) * dps;
      }
    }
    let v = cash;
    for (const h of holdings) {
      const p = priceAt(series.get(h.code), d);
      if (p > 0) v += (shares.get(h.code) || 0) * p;
    }
    out.push([d, v]);
  }
  return out;
}

export function estimateAnnualDiv(holdings, series, lastDate, endValue) {
  let total = 0;
  for (const h of holdings) {
    const p = priceAt(series.get(h.code), lastDate);
    const years = db.baseline.dividends?.[h.code]?.years || {};
    const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => b - a);
    if (!ys.length || !(p > 0)) continue;
    total += (years[ys[0]] / p) * (h.weight / 100) * endValue;
  }
  return total;
}

export function dailyStart() {
  return ctx?.market?.dailyMeta?.cal?.[0] || '2018-07';
}

export function currentPortfolioPercentile(codes, months) {
  const vals = [];
  for (const code of codes) {
    const rows = months[code] || [];
    const years = db.baseline.dividends?.[code]?.years || {};
    const seq = [];
    for (const [ym, close] of rows) {
      const y = Number(ym.slice(0, 4));
      const dps = years[y - 1];
      if (dps > 0 && close > 0) seq.push((dps / close) * 100);
    }
    if (seq.length < 24) continue;
    const q = quote(code);
    const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
    if (!q?.p || !ys.length) continue;
    const cur = (years[ys[ys.length - 1]] / q.p) * 100;
    vals.push((seq.filter((v) => v <= cur).length / seq.length) * 100);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

export function cashPctOf(st) {
  const sum = (st.holdings || []).reduce((a, h) => a + (Number(h.weight) || 0), 0);
  return Math.max(0, 100 - sum);
}

export function envCompare(nav, bench, from, to) {
  const segs = [
    { name: '牛市段', f: '2014-06-01', t: '2015-06-30' },
    { name: '熊市段', f: '2015-06-30', t: '2016-02-29' },
    { name: '震荡段', f: '2016-03-01', t: '2019-12-31' },
    { name: '近年', f: '2020-01-01', t: to },
  ];
  const segRet = (rows, f, t) => {
    const a = navAt(rows, f);
    const b = navAt(rows, t);
    if (a == null || b == null) return null;
    return (b / a - 1) * 100;
  };
  const out = [];
  for (const s of segs) {
    const f = s.f < from ? from : s.f;
    const t = s.t > to ? to : s.t;
    if (f >= t || (Date.parse(t) - Date.parse(f)) / DAY < 150) continue;
    out.push({ name: s.name, rule: segRet(nav, f, t), bench: bench ? segRet(bench, f, t) : null });
  }
  return out;
}

export function similarStates(market, codes, nav, from, to) {
  const { months } = market;
  const per = codes.map((code) => {
    const rows = months[code] || [];
    const years = db.baseline.dividends?.[code]?.years || {};
    const seq = [];
    for (const [ym, close] of rows) {
      const y = Number(ym.slice(0, 4));
      const dps = years[y - 1];
      if (dps > 0 && close > 0) seq.push([ym, (dps / close) * 100]);
    }
    return seq;
  });
  const curVals = [];
  codes.forEach((code, i) => {
    const seq = per[i];
    if (seq.length < 24) return;
    const q = quote(code);
    const years = db.baseline.dividends?.[code]?.years || {};
    const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
    if (!q?.p || !ys.length) return;
    const cur = (years[ys[ys.length - 1]] / q.p) * 100;
    curVals.push((seq.filter(([, v]) => v <= cur).length / seq.length) * 100);
  });
  const cur = curVals.length ? curVals.reduce((a, b) => a + b, 0) / curVals.length : null;
  const points = [];
  if (cur != null) {
    const fromY = Number(from.slice(0, 4));
    const toY = Number(to.slice(0, 4));
    for (let y = fromY + 1; y <= toY - 1; y++) {
      const vals = [];
      for (const seq of per) {
        const upto = seq.filter(([ym]) => ym <= `${y}-04`);
        if (upto.length < 24) continue;
        const hit = upto[upto.length - 1];
        vals.push((upto.filter(([, v]) => v <= hit[1]).length / upto.length) * 100);
      }
      if (vals.length < 2) continue;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (Math.abs(avg - cur) > 18) continue;
      const a = navAt(nav, `${y}-04-30`);
      const b = navAt(nav, `${y + 1}-04-30`);
      // 0 也要挡：回放模式下账本为空时净值可能整段是 0，b/a 会算出 NaN/Infinity，
      // JSON 往返后变成 null，画图时 p.ret.toFixed 直接抛错（页面绑定报错）
      if (!(a > 0) || !(b > 0)) continue;
      points.push({ pct: +avg.toFixed(0), ret: (b / a - 1) * 100, year: y });
    }
  }
  points.sort((x, y) => x.pct - y.pct);
  const rets = points.map((p) => p.ret).sort((a, b) => a - b);
  const median = rets.length ? rets[Math.floor(rets.length / 2)] : null;
  const win = rets.length ? (rets.filter((x) => x > 0).length / rets.length) * 100 : null;
  let tip = '历史相似状态样本不足（需要至少 2 只股票有 24 个月以上的股息率序列）。';
  if (cur != null && points.length) {
    tip = `当前组合平均股息率分位 <b class="gold">${cur.toFixed(0)}%</b> · 历史相似状态 <b>${points.length}</b> 次 · 其后 12 个月：中位 <b class="${median >= 0 ? 'up' : 'down'}">${pctSign(median, 0)}</b> · 最差 <b class="down">${rets[0].toFixed(0)}%</b> · 最好 <b class="up">${rets[rets.length - 1].toFixed(0)}%</b> · 胜率 <b>${win.toFixed(0)}%</b><br>${median >= 8 ? '历史相似状态下，后面一年中位收益可观 → 按计划继续执行。' : median >= 0 ? '持有为主，等更便宜的股息率再加仓。' : '历史上相似状态后一年中位为负 → 减少加仓、保留现金。'}`;
  }
  return { cur, points, median, tip };
}

export function winYears(nav, bench) {
  if (!bench || !bench.length) return '—';
  const yearly = (rows) => {
    const out = {};
    for (const [d, v] of rows) {
      const y = d.slice(0, 4);
      if (!out[y]) out[y] = { f: v, l: v };
      out[y].l = v;
    }
    return out;
  };
  const a = yearly(nav);
  const b = yearly(bench);
  let win = 0;
  let total = 0;
  for (const y of Object.keys(a)) {
    if (!b[y] || !(b[y].f > 0) || !(a[y].f > 0)) continue;
    total++;
    if (a[y].l / a[y].f > b[y].l / b[y].f) win++;
  }
  return total ? `${win}/${total}年` : '—';
}

export function readBtUrl() {
  const qs = new URLSearchParams((location.hash.split('?')[1] || ''));
  const mode = qs.get('mode');
  if (['port', 'stock', 'cmp'].includes(mode)) btState.mode = mode;
  const code = qs.get('code');
  if (/^\d{6}$/.test(code || '')) btState.stock = code;
  else {
    // hash 没带 code：用最后在个股页看过的那只，省掉「手打 6 位代码」这一步
    try {
      const last = localStorage.getItem('d3:lastStock');
      if (/^\d{6}$/.test(last || '')) btState.stock = last;
    } catch (e) { /* 隐私模式下忽略 */ }
  }
  const plan = qs.get('plan');
  if (plan) {
    btState.planId = plan;
    const hit = loadPlans().find((p) => p.id === plan);
    if (hit && Number(hit.capital) > 0) btState.capital = Math.round(Number(hit.capital) / 10000) * 10000;
  }
}

export function readParams() {
  const from = document.getElementById('btFrom')?.value;
  const to = document.getElementById('btTo')?.value;
  const capEl = document.getElementById('btCap');
  // 持仓回放时本金框是置灰的（本金 = 起点市值），别把它当用户输入校验
  const capW = capEl && !capEl.disabled ? Number(capEl.value) : btState.capital / 10000;
  const mon = Number(document.getElementById('btMon')?.value);
  const minDyEl = document.getElementById('btMinDy');
  const minDy = minDyEl ? Number(minDyEl.value) : 5;
  const qualityEl = document.getElementById('btQuality');
  if (qualityEl) btState.quality = qualityEl.checked;
  // 非法参数给明确提示并阻止重跑，而不是静默丢弃（用户会以为已经按新参数跑过）
  if (!(from && to && from < to)) { toast('开始日期要早于结束日期'); return false; }
  if (!(Number.isFinite(capW) && capW > 0)) { toast('本金要大于 0（单位：万）'); return false; }
  if (!(Number.isFinite(mon) && mon >= 0)) { toast('月追加不能为负数'); return false; }
  if (minDyEl && !(Number.isFinite(minDy) && minDy >= 0 && minDy <= 10)) { toast('买入股息率门槛需在 0–10% 之间'); return false; }

  btState.from = clampFrom(from);
  btState.to = to;
  btState.capital = capW * 10000;
  btState.monthlyAdd = mon;
  if (minDyEl) btState.minDy = minDy;
  // 把归一化后的合法值回写输入框（日期会被 clamp 到有数据的起点）
  const fromEl = document.getElementById('btFrom');
  const toEl = document.getElementById('btTo');
  const monEl = document.getElementById('btMon');
  if (fromEl) fromEl.value = btState.from;
  if (toEl) toEl.value = btState.to;
  if (capEl && !capEl.disabled) capEl.value = btState.capital / 10000;
  if (monEl) monEl.value = btState.monthlyAdd;
  if (minDyEl) minDyEl.value = btState.minDy;
  if (rerenderHook) rerenderHook();
  return true;
}

export function drawdownOf(nav) {
  let peak = 0;
  const out = [];
  for (const [d, v] of nav) {
    if (v > peak) peak = v;
    out.push([d, peak > 0 ? (v / peak - 1) * 100 : 0]);
  }
  return out;
}

export function repayCurve(p, nav, capital) {
  const evs = (p.events || [])
    .filter((e) => e.type === '分红' && e.amount > 0)
    .map((e) => [e.date, e.amount])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let j = 0;
  let cum = 0;
  const rows = [];
  for (const [d] of nav) {
    while (j < evs.length && evs[j][0] <= d) { cum += evs[j][1]; j++; }
    rows.push([d, +((cum / capital) * 100).toFixed(2)]);
  }
  return rows;
}
