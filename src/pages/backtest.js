/**
 * 回测页：组合回测 / 个股回测 / 组合对比（三个 tab，共用同一套日 K + 月线数据）。
 *
 * 数据口径：日 K 不复权（2018-07 起，2000 根交易日），更早区间用月线月末补齐；
 * 分红只有一个来源：data/div/<code>.json 的 ev（每笔真实除权除息日 + 每股派息），按当天收盘价复投。
 * 没有 ev 的股票在回测里一律不计分红——不猜日期、不编「4 月末」。不含税、不含佣金。
 */
import {
  db, loadMonthly, loadMonthlyFor, loadCmpScreen, loadCmpFin, loadPool,
  loadFinanceHistory, loadDailyMeta, loadDailyMany, loadIndexDaily,
  nameOf, quote, ensureDividends,
} from '../data.js';
import { buildSeries, buildTradingDates, monthEnd, priceAt, maxDrawdown, prevDps } from '../engine/market.js';
import { runPortfolioBacktest } from '../engine/portfolioBacktest.js';
import { runStockBacktest, runInvestBacktest } from '../engine/stockBacktest.js';
import { runPlanBacktest } from '../engine/backtest.js';
import { entryLabel } from '../engine/plan.js';
import { loadTxs, loadCash, loadPlans, savePlan, loadSettings } from '../store.js';
import {
  drawPortfolioChart, drawPriceChart, drawNavChart, drawDonut, drawWaterfall,
  drawEnvChart, drawDivChart, drawSimilarChart, drawLineMini, drawBarsVs, drawMultiLineChart,
  chartColors,
} from '../charts.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { esc, num, pct, pctSign, upDown, bigMoney } from '../ui/format.js';
import { mountStockSearch, stockMeta } from '../ui/stockSearch.js';

const todayStr = () => db.generated || '2026-10-30';
const DAY = 86400000;
let rerenderHook = null;

export function setBacktestRerender(fn) { rerenderHook = fn; }

export const btState = {
  mode: 'port',           // port | stock | cmp
  portMode: 'invest',     // invest | replay
  from: null,
  to: null,
  capital: 1000000,
  monthlyAdd: 0,
  stock: '600036',      // 默认招商银行：打开就能看到一套真实跑起来的回测
  minDy: 5,
  quality: false,         // 个股回测质量筛选：默认关（只看走势，不拉财报）
  metric: 'nav',
  planId: 'current',
  cmpPlans: null,         // 组合对比里勾选的方案 id；null = 全选
};

let ctx = null;

/* 持仓构成「播放」用的定时器：必须在换页/重渲染时清掉，
   否则 interval 会一直往已经摘掉的 DOM 上画图（内存与 CPU 只增不减）。 */
let compTimer = null;
function stopCompPlay() {
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

/* ---------------- 基础工具 ---------------- */

function addYears(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

function clampFrom(f) {
  return f < '2012-01-01' ? '2012-01-01' : f;
}

function structure() {
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

/** 日 K 序列 → [[ym, 月末收盘], ...]（没拉月线时，给股息率分位/相似状态模块兜底；日 K 比月线更细） */
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

async function loadMarket(codes, from, to, { finance = false, monthly = 'auto', marketWide = false, stockCode = null } = {}) {
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

function benchRows(index, benchmarkMonthly, from, to) {
  const rows = (index.h00922?.rows || []).filter(([d]) => d >= from && d <= to);
  const last = rows.length ? rows[rows.length - 1][0] : '';
  for (const [ym, v] of Object.entries(benchmarkMonthly || {})) {
    const d = monthEnd(ym);
    if (d > last && d <= to && v > 0) rows.push([d, v]);
  }
  return rows;
}

function lowVolRows(index, from, to) {
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

/** 买入持有对照：起点等权买入、分红进现金、不再平衡 */
function buyHoldNav(dates, series, holdings, capital, dividends) {
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

/* ---------------- 页面外壳 ---------------- */

function modeTabs() {
  const mk = (id, label, active) => `<button class="btn sm ${active ? 'primary' : 'ghost'}" data-btmode="${id}">${label}</button>`;
  return `<div class="row" style="gap:6px;flex-wrap:wrap">
    ${mk('port', '组合回测', btState.mode === 'port')}
    ${mk('stock', '个股回测', btState.mode === 'stock')}
    ${mk('cmp', '组合对比', btState.mode === 'cmp')}
  </div>`;
}

function paramBar(opts = {}) {
  const from = clampFrom(btState.from);
  const activeQ = [3, 5, 10].find((y) => Math.abs((Date.parse(btState.to) - Date.parse(from)) / DAY / 365.25 - y) < 0.25);
  const tabs = opts.tabs === false || btState.planId !== 'current' ? '' : `<div class="bt-tabs" style="margin-left:auto;display:flex;gap:6px">
    <button class="btn sm ${btState.portMode === 'invest' ? 'primary' : 'ghost'}" data-portmode="invest">投入回测</button>
    <button class="btn sm ${btState.portMode === 'replay' ? 'primary' : 'ghost'}" data-portmode="replay">持仓回放</button>
  </div>`;
  return `<section class="panel fade-in bt-params">
    <div class="bt-param-row">
      <label class="bt-field"><span>开始</span><input class="input" type="date" id="btFrom" value="${from}" min="2012-01-01" max="${todayStr()}"></label>
      <label class="bt-field"><span>结束</span><input class="input" type="date" id="btTo" value="${btState.to}" min="2012-01-01" max="${todayStr()}"></label>
      ${opts.tabs === false || btState.mode !== 'port' ? '' : `<label class="bt-field"><span>组合</span><select class="input" id="btPlan" style="width:132px">
        <option value="current"${btState.planId === 'current' ? ' selected' : ''}>当前持仓（实时）</option>
        ${loadPlans().map((p) => `<option value="${p.id}"${btState.planId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></label>`}
      ${btState.portMode === 'replay' && opts.tabs !== false && btState.mode === 'port'
        ? `<label class="bt-field" title="持仓回放的本金 = 起点那天的组合市值，不是这里填的数"><span>本金(万)</span><input class="input" type="number" id="btCap" value="—" disabled></label>
           <span class="bt-hint">持仓回放的本金 = 起点那天的市值（这笔本金框不生效）</span>`
        : `<label class="bt-field"><span>本金(万)</span><input class="input" type="number" id="btCap" min="1" step="10" value="${Math.round(btState.capital / 10000)}"></label>`}
      ${opts.useMktCap ? '<button class="btn sm ghost" id="btUseMktCap">用当前市值</button>' : ''}
      <label class="bt-field"><span>月追加(元)</span><input class="input" type="number" id="btMon" min="0" step="500" value="${btState.monthlyAdd}"></label>
      ${opts.minDy ? `<label class="bt-field"><span>买入股息率≥</span><input class="input" type="number" id="btMinDy" min="0" max="10" step="0.5" value="${btState.minDy}"></label>` : ''}
      ${opts.quality ? `<label class="bt-field bt-check"><input type="checkbox" id="btQuality"${btState.quality ? ' checked' : ''}><span>质量筛选（加载财报，较慢）</span></label>` : ''}
    </div>
    <div class="bt-param-row" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
      <span class="bt-hint">快捷区间</span>
      ${[3, 5, 10].map((y) => `<button class="bt-chip ${activeQ === y ? 'on' : ''}" data-q="${y}">近 ${y} 年</button>`).join('')}
      <span class="bt-hint" style="margin-left:12px">月追加快捷</span>
      ${[0, 5000, 10000, 20000].map((v) => `<button class="bt-chip ${btState.monthlyAdd === v ? 'on' : ''}" data-add="${v}">${v === 0 ? '不追加' : v / 1000 + '千'}</button>`).join('')}
      ${tabs}
      <button class="btn primary" id="btRun" style="margin-left:auto">${icon('play')} 运行回测</button>
    </div>
    ${btState.mode === 'cmp' ? cmpPlanPicker() : ''}
    <div class="bt-hint" style="margin-top:8px">${opts.stock
      ? `日级净值 · 价格不复权 · 每月末定投 · 分红在除权除息日当天按收盘价再投 · 不判断买卖点 · 不含税`
      : `日级净值 · 价格不复权 · 分红按真实除权除息日到账 · 未上市股票份额先摊给已上市、上市满 6 个月建仓 · 不含税 · 行情 <b>${esc(todayStr())}</b> · 日 K 自 ${esc(dailyStart())}（更早用月线）`}</div>
  </section>`;
}

/** 组合对比：选哪几个方案上场。
 *  以前这个页面根本没有选择入口——所有方案一股脑画进去，超过 5 个再被静默截断，
 *  用户既不知道该看谁，也不知道少了谁。 */
function cmpPlanPicker() {
  const plans = loadPlans();
  if (!plans.length) {
    return `<div class="bt-param-row" style="margin-top:10px"><span class="bt-hint">你还没有保存的方案——去「我的 → 方案」建几个，这里就能拿来比。</span></div>`;
  }
  const picked = btState.cmpPlans;
  const on = (id) => !picked || picked.includes(id);
  return `<div class="bt-param-row" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
    <span class="bt-hint">对比哪些方案</span>
    <button class="bt-chip ${!picked ? 'on' : ''}" data-cmpplan="__all">全部 ${plans.length} 个</button>
    ${plans.map((p) => `<button class="bt-chip ${on(p.id) ? 'on' : ''}" data-cmpplan="${p.id}">${esc(p.name)}</button>`).join('')}
    <span class="bt-hint" style="margin-left:auto">当前持仓 · 红利策略 · 两条指数 始终在场</span>
  </div>`;
}

function metricGrid(cards) {  return `<div class="bt-metrics">${cards.map((c) => `<div class="bt-metric ${c.on ? 'on' : ''}" ${c.key ? `data-metric="${c.key}"` : ''}>
      <div class="k">${esc(c.k)}</div><div class="v num ${c.cls || ''}">${c.v}</div><div class="s">${c.s || ''}</div>
    </div>`).join('')}</div>`;
}

function hero(cfg) {
  const sub = cfg.chips
    ? `<div class="hero-chips">${cfg.chips.map((c) => `<span class="hchip ${c.cls || ''}">${c.t}</span>`).join('')}</div>`
    : `<div class="hero-desc">${cfg.desc}</div>`;
  return `<section class="hero fade-in">
    <div class="hero-main">
      <div class="hero-kicker">${cfg.kicker}</div>
      <div class="hero-line">${cfg.main}</div>
      ${sub}
    </div>
    <div class="stats">
      ${cfg.stats.map((s) => `<div class="stat"><div class="stat-label">${esc(s.k)}</div><div class="stat-value sm num ${s.cls || ''}">${s.v}</div><div class="stat-sub">${s.s || ''}</div></div>`).join('')}
    </div>
  </section>`;
}

function fold(id, title, summary, content) {
  return `<details class="fold" data-fold="${id}">
    <summary><div><div class="fold-title">${title}</div><div class="fold-sum">${summary}</div></div><span class="fold-arrow">展开 ▸</span></summary>
    <div class="fold-body">${content}</div>
  </details>`;
}

function investRules() {
  const R = [
    ['建仓', '第一天把首次本金全买进去（按 100 股整手，零头留现金）'],
    ['定投', btState.monthlyAdd > 0
      ? `每月 ${bigMoney(btState.monthlyAdd)}，月最后一个交易日全买`
      : '本次没开定投（月追加 = 0），只有第一天那笔本金'],
    ['分红', '每一笔分红在<b>除权除息日当天</b>按收盘价买回（那天价格已经除过息，用不复权收盘价才对）；不够一手就留在现金里'],
    ['一年分几次', '不做任何假设：<b>data/div/&lt;code&gt;.json 里记了几笔就派几笔</b>（实际数据里一年 1 笔 3448 只、2 笔 1513 只、3 笔 127 只、4 笔 12 只，最多的一只中国石化全部历史 50 笔）'],
    ['没取到派息明细的股票', '全市场 5406 只里有 5402 只有逐笔除权日；剩下 4 只（301139 / 601059 / 601198 / 000016）数据源查不到除权日——<b>它们在本页一律不计分红</b>，不猜日期、不编「4 月末」'],
    ['不判断买卖点', '不设股息率门槛、不看财报、不因为分红下调卖出——一分钱都不卖，也没有卖点'],
    ['费用', '不含佣金、不含红利税；现金零头不计息'],
    ['价格', '日 K 不复权，更早的区间用月线月末补齐'],
    ['基准', '中证红利全收益（H00922），同本金、同定投节奏'],
  ];
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>项目</th><th>规则</th></tr></thead>
    <tbody>${R.map(([k, v]) => `<tr><td class="em" style="white-space:nowrap">${esc(k)}</td><td style="text-align:left;white-space:normal">${v}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function rulesCard() {
  const R = [
    ['买入', '4/12 月末决策：股息率 ≥ 买入线，且质量过关（不亏损、支付率 &lt;85%、现金流覆盖 ≥0.7、ROE ≥5）'],
    ['未上市', '目标份额先平均摊给当时已上市的股票（资金不闲置）；上市满 6 个月后按目标权重卖出别的股票把它买回来，买入金额 = 初始份额 × 期间组合增长'],
    ['分红', '每笔按<b>真实除权除息日</b>到账（每股派息 × 当时持股），当天收盘价买回；组合口径复投，对照口径进现金。<b>没取到派息明细的股票一律不计分红</b>（不猜日期）'],
    ['卖出', '质量否决（亏损 / 现金流覆盖不足 / 支付率过高）或分红下调 ≥5% → 清仓'],
    ['现金', '现金年息 1.5%，日计'],
    ['月追加', '4 月末 / 12 月末各入账 6 个月追加额（定投节奏，跟分红无关）'],
    ['费用', '不含佣金、不含红利税'],
    ['价格', '日 K 不复权（2018-07 起），更早用月线月末；分红单独计现金'],
    ['基准', '中证红利全收益（H00922）日线；最后的月末之后用月线补齐'],
  ];
  return `<div class="table-wrap"><table class="table"><tbody>${R.map(([k, v]) => `<tr><td class="name" style="width:70px;color:var(--accent-2)">${k}</td><td style="white-space:normal;color:var(--text-2)">${v}</td></tr>`).join('')}</tbody></table></div>`;
}

function flowTable(events) {
  const rows = [...events].reverse().slice(0, 500).map((e) => {
    if (e.type === '买入' || e.type === '建仓' || e.type === '定投') {
      return `<tr><td class="num">${esc(e.date)}</td><td class="name">${esc(nameOf(e.code))}<span class="code">${esc(e.code)}</span></td><td class="up">${esc(e.type)}</td><td class="num">${num(e.price, 2)}</td><td class="num">${num(e.shares, 0)}</td><td class="num">${((e.shares * e.price) / 10000).toFixed(1)}</td><td class="muted">${esc(e.why || '')}</td></tr>`;
    }
    if (e.type === '卖出') {
      return `<tr><td class="num">${esc(e.date)}</td><td class="name">${esc(nameOf(e.code))}<span class="code">${esc(e.code)}</span></td><td class="down">卖出</td><td class="num">${num(e.price, 2)}</td><td class="num">${num(e.shares, 0)}</td><td class="num">${((e.shares * e.price) / 10000).toFixed(1)}</td><td class="muted">${esc(e.why || '')}</td></tr>`;
    }
    return `<tr><td class="num">${esc(e.date)}</td><td class="name">—</td><td>${esc(e.type)}</td><td class="num">—</td><td class="num">—</td><td class="num">${(e.amount / 10000).toFixed(2)}</td><td class="muted">${esc(e.why || '')}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>日期</th><th>股票</th><th>类型</th><th>价格</th><th>股数</th><th>金额(万)</th><th>依据</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">区间内没有交易</td></tr>'}</tbody></table></div>`;
}

/* ---------------- 组合回测 ---------------- */

function estimateAnnualDiv(holdings, series, lastDate, endValue) {
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

function dailyStart() {
  return ctx?.market?.dailyMeta?.cal?.[0] || '2018-07';
}

function currentPortfolioPercentile(codes, months) {
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

function cashPctOf(st) {
  const sum = (st.holdings || []).reduce((a, h) => a + (Number(h.weight) || 0), 0);
  return Math.max(0, 100 - sum);
}

function envCompare(nav, bench, from, to) {
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

function similarStates(market, codes, nav, from, to) {
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

function yearSection(r) {
  const years = r.yearly.filter((y) => y.nav1 > 0);
  const capital = r.nav[0]?.[1] || 1;
  let cumDiv = 0;
  const tbl = years.map((y) => {
    const ret = y.nav0 > 0 ? (y.nav1 / y.nav0 - 1) * 100 : null;
    const cashPct = y.nav1 > 0 ? (y.cash / y.nav1) * 100 : null;
    cumDiv += y.div;
    const repay = (cumDiv / Math.max(1, capital)) * 100;
    return `<tr><td class="num">${y.year}</td><td class="num">${(y.nav0 / 10000).toFixed(1)}</td><td class="num">${(y.nav1 / 10000).toFixed(1)}</td><td class="num ${upDown(ret)}">${pctSign(ret, 1)}</td><td class="num">${(y.div / 10000).toFixed(2)}</td><td class="num">${(cumDiv / 10000).toFixed(2)}</td><td class="num">${repay.toFixed(0)}%</td><td class="num">${pctSign(cashPct, 0)}</td><td class="num">${(y.invest / 10000).toFixed(1)}</td></tr>`;
  }).join('');
  return `<div class="bt-year-grid">
    <div class="bt-year-cell"><div class="bt-year-title">累计收益</div><div id="chYear" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">分红</div><div id="chDiv" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">回本率（累计分红 ÷ 本金）</div><div id="chRepay" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">现金占比</div><div id="chCash" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">年度收益：组合 vs 指数</div><div id="chVsIdx" class="chart" style="height:240px"></div></div>
  </div>
  <div class="table-wrap" style="margin-top:10px"><table class="table">
    <thead><tr><th>年</th><th>年初(万)</th><th>年末(万)</th><th>今年收益</th><th>分红(万)</th><th>分红累计(万)</th><th>回本%</th><th>年末现金%</th><th>追加(万)</th></tr></thead>
    <tbody>${tbl}</tbody>
  </table></div>`;
}

function stockCards(r, structureData, market) {
  const last = r.comp[r.comp.length - 1]?.[1] || {};
  const total = Object.values(last).reduce((s, v) => s + v, 0) || 1;
  const cards = [];
  for (const h of structureData.holdings) {
    const code = h.code;
    const mv = (last[code] || 0) / 10000;
    const w = ((last[code] || 0) / total) * 100;
    const div = (r.divByCode[code] || 0) / 10000;
    const buys = r.events.filter((e) => e.type === '买入' && e.code === code).length;
    const p0 = priceAt(market.series.get(code), market.dates[0]);
    const p1 = priceAt(market.series.get(code), market.dates[market.dates.length - 1]);
    const ret = p0 > 0 && p1 > 0 ? (p1 / p0 - 1) * 100 : null;
    cards.push(`<div class="ph-card fade-in" data-scard="${code}">
      <div class="ph-row"><span class="ph-name">${esc(nameOf(code))} <em>${esc(code)}</em></span><span class="num ${upDown(ret)}">${pctSign(ret, 1)}</span></div>
      <div class="ph-wbar"><i style="width:${Math.min(100, w)}%"></i><b>占组合 ${w.toFixed(1)}%</b></div>
      <div class="ph-grid"><span><em>市值</em>${mv.toFixed(1)}万</span><span><em>分红</em><b class="gold">${div.toFixed(2)}万</b></span><span><em>买点</em>${buys}次</span><span><em>现价</em>${num(quote(code)?.p, 2)}</span></div>
      <div class="ph-foot"><span class="bt-hint">展开看日 K / 分红</span><span style="flex:1"></span><button class="btn sm ghost" data-sbt="${code}">进个股回测</button></div>
    </div>
    <div class="scard-body" id="scard-${code}" style="display:none"><div id="sdChart-${code}" class="chart" style="height:260px"></div></div>`);
  }
  return cards.join('');
}


/** 回撤体检：跌了多少、跌的时候分红补了多少、多久爬回来。
 *
 * 研究（tools/research/README.md）里最反直觉的一条：红利策略抗跌不是因为跌得少，
 * 是因为跌的时候还在发钱——2018 年指数跌 21.5%，同期分红率 5.7%，相当于把坑填掉四分之一。
 * 只给一个「最大回撤 −24%」看不出来这件事，所以单独拆一块。 */
function ddPanel(r, s, structureData, totalDiv) {
  const navs = r.nav || [];
  if (navs.length < 3 || !s.mddPeak || !s.mddTrough) return '';
  const peakDate = s.mddPeak, troughDate = s.mddTrough;
  const peakV = navs.find(([d]) => d === peakDate)?.[1] || 0;
  const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const ddDiv = (r.events || [])
    .filter((e) => e.type === '分红' && e.date >= peakDate && e.date <= troughDate)
    .reduce((a, e) => a + (e.amount || 0), 0);
  const fill = peakV > 0 && s.mdd < 0 ? (ddDiv / peakV / Math.abs(s.mdd)) * 100 : null;
  // 修复：跌到底之后第一次回到前高
  const ti = navs.findIndex(([d]) => d === troughDate);
  let recoverDate = null;
  for (let i = ti; i >= 0 && i < navs.length; i++) {
    if (navs[i][1] >= peakV) { recoverDate = navs[i][0]; break; }
  }
  const stillUnder = !recoverDate;
  const downDays = days(peakDate, troughDate);
  const upDays = recoverDate ? days(troughDate, recoverDate) : days(troughDate, navs.at(-1)[0]);
  const holdings = (structureData.holdings || []).length;
  const benchMdd = s.benchMdd;

  const cells = [
    { k: '最大回撤', v: pct(s.mdd * 100, 1), cls: 'ddc', s: `${esc(peakDate)} → ${esc(troughDate)}` },
    { k: '下跌用时', v: `${downDays} 天`, s: `${num(downDays / 30.4, 1)} 个月见底` },
    { k: stillUnder ? '还在水下' : '爬回前高', v: stillUnder ? '未修复' : `${upDays} 天`, cls: stillUnder ? 'down' : 'up', s: stillUnder ? `距高点 ${num(upDays / 30.4, 1)} 个月` : `${num(upDays / 30.4, 1)} 个月修复` },
    { k: '跌时收到的分红', v: bigMoney(ddDiv), cls: 'gold', s: fill == null ? '—' : `填掉回撤的 ${fill.toFixed(0)}%` },
  ];

  let verdict = '';
  const downMonths = Math.max(1, Math.round(downDays / 30.4));
  if (fill != null && fill > 5) {
    verdict = `这一轮跌了 ${downMonths} 个月，期间分红到账 <b class="num gold">${bigMoney(ddDiv)}</b>，相当于把 ${Math.abs(s.mdd * 100).toFixed(1)}% 的坑填掉 <b>${fill.toFixed(0)}%</b>。红利真正抗跌的地方就在这儿：股价在跌，现金还在进来。`;
  } else if (fill != null) {
    verdict = `这一轮跌了 ${downMonths} 个月，期间只碰到 ${bigMoney(ddDiv)} 分红，几乎没帮上忙——红利股一年也就发一两次钱，短期急跌指望分红补是不现实的。`;
  }
  if (benchMdd != null && s.mdd < 0) {
    const better = s.mdd - benchMdd;
    verdict += better > 0
      ? ` 同期中证红利全收益回撤 ${pct(benchMdd * 100, 1)}，组合少跌 <b class="num up">${(better * 100).toFixed(1)}pp</b>。`
      : ` 同期中证红利全收益回撤 ${pct(benchMdd * 100, 1)}，组合多跌 <b class="num down">${(-better * 100).toFixed(1)}pp</b>——这轮的分散做得不够。`;
  }

  // 集中度：研究里 1 只 −51.7%、3 只 −40.0%、15 只 −24.1%，回撤几乎由持仓数决定
  const concWarn = holdings > 0 && holdings < 5
    ? `<div class="dd-warn">${icon('alert')}<div>现在只有 <b>${holdings}</b> 只股票。研究样本里同样一套选股规则：持 1 只回撤 −51.7%、3 只 −40.0%、15 只 −24.1%——<b>回撤由分散度决定，不由选股决定</b>。加到 5 只以上再谈回测数字。</div></div>`
    : '';

  return `
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">回撤体检</span><span class="section-note">跌了多少 · 分红补了多少 · 多久爬回来</span></div>
    <div class="panel-body" style="padding:10px">
      ${concWarn}
      <div class="bt-mini-stats dd-stats">
        ${cells.map((c) => `<div><div class="k">${c.k}</div><div class="v num ${c.cls || ''}">${c.v}</div><div class="dk">${c.s}</div></div>`).join('')}
      </div>
      ${verdict ? `<div class="dd-note">${verdict}</div>` : ''}
    </div>
  </section>`;
}

function renderPort(market, structureData) {
  const { dates, series } = market;
  const displayPlan = !structureData.plan && !structureData.fallback;
  const from = clampFrom(btState.from);
  const to = btState.to;
  const useReplay = btState.portMode === 'replay' && !structureData.plan;
  const startValue = structureData.cash + structureData.lots.reduce((s, l) => s + l.shares * (priceAt(series.get(l.code), dates[0]) || 0), 0);
  const capital = useReplay ? startValue : btState.capital;
  const r = runPortfolioBacktest({
    dates,
    series,
    dividends: db.baseline.dividends || {},
    holdings: structureData.holdings,
    capital: capital || 1000000,
    monthlyAdd: btState.monthlyAdd,
    from,
    to,
    mode: useReplay ? 'replay' : 'invest',
    lots: structureData.lots,
    cash0: useReplay ? structureData.cash : 0,
    entry: structureData.entry || { mode: 'once' },
    benchmarkSeries: ctx.benchRows,
    lowVolSeries: ctx.lowVolRows,
  });
  ctx.port = r;
  ctx.holdNav = buyHoldNav(dates, series, structureData.holdings, capital || 1000000, db.baseline.dividends || {});
  ctx.nav = r.nav;
  const s = r.stats;
  const hasAdd = r.totalIn > capital;
  const divEst = estimateAnnualDiv(structureData.holdings, series, dates[dates.length - 1], r.end);
  // 月支出必须 ≥100 元：旧版设置可能存了负数/0，不再静默兜成 1（会算出 65 万 % 这种荒谬结论）
  const expenseRaw = Number(loadSettings().expense);
  const expenseOk = Number.isFinite(expenseRaw) && expenseRaw >= 100 && expenseRaw <= 1e7;
  const expense = expenseOk ? expenseRaw : 4000;
  const cov = (divEst / 12 / expense) * 100;
  const avgPct = currentPortfolioPercentile(structureData.holdings.map((h) => h.code), market.months);
  const retBase = hasAdd ? s.retFund || 0 : s.ret;
  const retTxt = pctSign(retBase * 100, 1);
  const vc = retBase >= 0 ? 'up' : 'down';
  const excess = s.excess != null ? s.excess * 100 : null;
  const totalDiv = r.totalDiv;
  const yearly = r.yearly;
  const lastNav = r.nav[r.nav.length - 1];
  const cashNow = r.cashEnd;
  const divCagr = (() => {
    const ds = yearly.filter((y) => y.div > 0).map((y) => y.div);
    if (ds.length < 2 || ds[0] <= 0) return null;
    return (Math.pow(ds[ds.length - 1] / ds[0], 1 / (ds.length - 1)) - 1) * 100;
  })();
  const sim = similarStates(market, structureData.holdings.map((h) => h.code), r.nav, from, to);

  const cards = [
    { k: '总市值', v: bigMoney(r.end), cls: 'gold', s: `现金 ${bigMoney(cashNow)} · 仓位 ${((1 - cashNow / (r.end || 1)) * 100).toFixed(0)}%`, key: 'nav', on: btState.metric === 'nav' },
    { k: useReplay ? '起点市值' : '累计投入', v: bigMoney(r.totalIn), cls: 'fund', s: hasAdd ? `本金 ${bigMoney(capital)} + 追加 ${bigMoney(r.totalIn - capital)}` : (useReplay ? '当前股数 × 起点价 + 现金' : '起点本金') },
    { k: '净赚金额', v: bigMoney(r.end - r.totalIn), cls: upDown(r.end - r.totalIn), s: `期末 ${bigMoney(r.end)} − 投入 ${bigMoney(r.totalIn)}` },
    { k: '年化', v: pctSign(s.cagr == null ? null : s.cagr * 100, 1), cls: vc, s: `${num(s.years, 1)} 年 · ${hasAdd ? 'XIRR' : '复利'}`, key: 'ann', on: btState.metric === 'ann' },
    { k: '红利不复投', v: bigMoney(r.endR), cls: 'fund', s: `年化 ${pctSign(s.cagrR == null ? null : s.cagrR * 100, 1)}`, key: 'navR', on: btState.metric === 'navR' },
    { k: '最大回撤', v: pct(s.mdd * 100, 1), cls: 'ddc', s: `${esc(s.mddPeak)} → ${esc(s.mddTrough)}`, key: 'dd', on: btState.metric === 'dd' },
    { k: '年分红(估)', v: bigMoney(divEst), cls: 'divc', s: '当前持仓 × 最新年度每股分红', key: 'div', on: btState.metric === 'div' },
    { k: '月覆盖', v: expenseOk ? (cov > 999 ? '>999%' : cov.toFixed(0) + '%') : '—', s: expenseOk ? `年分红 ÷ 12 ÷ 月支出 ${expense.toLocaleString('zh-CN')}` : '月支出设置无效（需 100 元–1000 万/月），请到「我的 → 设置」修正', key: 'repay', on: btState.metric === 'repay' },
    { k: 'vs 指数', v: excess == null ? '—' : (excess >= 0 ? '+' : '') + excess.toFixed(1) + 'pp', cls: upDown(excess), s: 'vs 中证红利全收益 年化', key: 'hold', on: btState.metric === 'hold' },
  ];

  return `
  ${paramBar({ useMktCap: !useReplay })}
  ${(r.divMissing || []).length ? `<div class="banner" style="margin-bottom:12px">${icon('alert')}<div><b>${r.divMissing.length} 只股票没取到派息明细</b>（${r.divMissing.map(esc).join('、')}）——它们在本次回测里不计分红，不猜除权日。</div></div>` : ''}
  ${hero({
    kicker: `组合回测 · ${structureData.name || '当前持仓'} · ${useReplay ? '持仓回放（当前股数，假设自起点持有）' : '投入回测（本金按目标结构买入）'}${structureData.plan ? ' · ' + entryLabel(structureData.entry) : ''} · ${from} → ${to} · ${num(s.years, 1)} 年`,
    main: `组合 <b class="num gold">${retTxt}</b> <span class="thin">，年化 ${pctSign(s.cagr == null ? null : s.cagr * 100, 1)} · 基准 ${pctSign(s.benchCagr == null ? null : s.benchCagr * 100, 1)}</span>`,
    desc: `期末 ${bigMoney(r.end)}（${useReplay ? '起点' : '投入'} ${bigMoney(r.totalIn)}）· 最大回撤 ${pct(s.mdd * 100, 1)}（基准 ${pct(s.benchMdd == null ? null : s.benchMdd * 100, 1)}）· 总分红 ${bigMoney(totalDiv)} · ${structureData.plan ? '结构 = 方案「' + esc(structureData.name) + '」 · 建仓 = ' + esc(entryLabel(structureData.entry)) + ' · 现金 ' + structureData.cashPct.toFixed(0) + '%' : structureData.fallback ? '账本为空，按演示持仓等权' : '结构 = 当前组合市值权重（股票 ' + (100 - cashPctOf(structureData)).toFixed(0) + '% + 现金 ' + cashPctOf(structureData).toFixed(0) + '%）'}`,
    stats: [
      { k: '累计收益', v: retTxt, cls: vc, s: hasAdd ? '扣追加资金' : '起点本金' },
      { k: '年化', v: pctSign(s.cagr == null ? null : s.cagr * 100, 1), cls: vc, s: hasAdd ? 'XIRR 资金加权' : '复利折算' },
      { k: '最大回撤', v: pct(s.mdd * 100, 1), cls: 'down', s: `基准 ${pct(s.benchMdd == null ? null : s.benchMdd * 100, 1)}` },
      { k: '总分红', v: bigMoney(totalDiv), cls: 'gold', s: divCagr == null ? '—' : '增速 ' + pctSign(divCagr, 1) + '/年' },
    ],
  })}
  ${(r.builds && r.builds.length) || (r.pending && r.pending.length) ? `<div class="bt-buildnote">${(r.builds || []).map((b) => `<div>🏗 <b>${esc(nameOf(b.code))}</b> ${esc(b.date)} 建仓 ${num(b.shares, 0)} 股 @ ${num(b.price, 2)}（初始份额 × 期间组合增长；建仓前份额摊给已上市持仓）</div>`).join('')}${(r.pending || []).map((p) => `<div>⏳ <b>${esc(nameOf(p.code))}</b> 期末仍未建仓：${esc(p.reason)}${p.weight ? '（目标 ' + num(p.weight, 1) + '%）' : ''}</div>`).join('')}</div>` : ''}
  ${metricGrid(cards)}
  <div id="metricDetail" style="margin-top:12px"></div>
  ${ddPanel(r, s, structureData, totalDiv)}
  ${displayPlan ? `<div class="row" style="gap:8px;margin-top:10px;align-items:center"><button class="btn sm ghost" id="btSavePlan">把当前结构存为方案</button><span class="bt-hint">存的是「代码 + 目标权重」，可切回对比</span></div>` : ''}

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">组合状态总览</span><span class="section-note">红=组合 · 金=不复投 · 蓝=中证红利全收益 · 紫=红利低波</span></div>
    <div class="panel-body" style="padding:8px 10px 2px">
      <div class="bt-mini-stats">
        <div><div class="k">累计收益</div><div class="v num ${vc}">${retTxt}</div></div>
        <div><div class="k">当前回撤</div><div class="v num">${pct(r.dd.at(-1)?.[1] ?? 0, 1)}</div></div>
        <div><div class="k">组合分位</div><div class="v num">${avgPct == null ? '—' : avgPct.toFixed(0) + '%'}</div></div>
        <div><div class="k">历史分红</div><div class="v num gold">${bigMoney(totalDiv)}</div></div>
      </div>
      <div id="portChart" class="chart" style="height:560px"></div>
      <div class="bt-hint" style="padding:4px 4px 8px">主图：组合复投 / 红利不复投 / 两条全收益指数 · 中段：回撤 · 下段：年度分红柱 + 增速</div>
    </div>
  </section>

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">持仓构成（精确到天）</span><span class="section-note">滑轨 / 播放看每天的钱在哪</span></div>
    <div class="panel-body" style="padding:10px">
      <div class="bt-comp">
        <div id="compDonut" class="chart" style="width:200px;height:200px;flex:0 0 200px"></div>
        <div style="flex:1;min-width:240px">
          <div id="compDate" class="comp-date">—</div>
          <div id="compList" class="comp-list"></div>
          <div class="bt-slider">
            <span class="bt-hint">滑轨</span>
            <input id="compRange" type="range" min="0" max="100" step="1" value="100">
            <button class="btn sm ghost" id="compPlay">播放 ▶</button>
          </div>
        </div>
      </div>
    </div>
  </section>

  ${fold('divhist', '分红（组合现金流）', `总分红 <b class="num gold">${bigMoney(totalDiv)}</b> · 年均 ${bigMoney(totalDiv / Math.max(1, yearly.length))} · 增速 ${divCagr == null ? '—' : pctSign(divCagr, 1) + '/年'} · 分红率 ${pct((totalDiv / Math.max(1, r.totalIn)) * 100, 1)} · 回本 ${pct((totalDiv / Math.max(1, capital)) * 100, 0)}`, '<div id="divHist" class="chart" style="height:280px"></div>')}

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">钱从哪来：收益拆解</span><span class="section-note">本金 → 分红 → 价格 → 期末</span></div>
    <div class="panel-body" style="padding:8px 10px 6px"><div id="wfChart" class="chart" style="height:220px"></div></div>
  </section>

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">什么时候该信规则：分环境对比</span><span class="section-note">我的组合 vs 中证红利全收益 · 同区间涨跌幅</span></div>
    <div class="panel-body" style="padding:8px 10px 6px"><div id="envChart" class="chart" style="height:220px"></div></div>
  </section>

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">我现在该怎么做：历史相似状态</span><span class="section-note">组合平均股息率分位接近当下时，其后 12 个月发生了什么</span></div>
    <div class="panel-body" style="padding:8px 10px 8px">
      <div id="nowChart" class="chart" style="height:220px"></div>
      <div id="nowTip" class="banner" style="margin-top:10px;font-size:11px;display:block;line-height:1.7">${sim.tip}</div>
    </div>
  </section>

  ${fold('year', '年度数据', '累计收益 / 分红 / 回本 / 现金占比 / 年度收益 · 5 图 + 7 列明细', yearSection(r))}
  ${fold('stocks', `个股明细（${structureData.holdings.length} 只）`, '占比 / 市值 / 分红 / 买点 · 展开看日 K', stockCards(r, structureData, market))}
  ${fold('flow', '交易流水', `${r.events.length} 笔 · 每笔带依据`, flowTable(r.events))}
  ${fold('rules', '本次回测规则', '8 条 · 可审计', rulesCard())}
  <div id="simData" data-json="${esc(JSON.stringify(sim.points))}" data-cur="${sim.cur == null ? '' : sim.cur.toFixed(1)}" data-med="${sim.median == null ? '' : sim.median.toFixed(1)}" style="display:none"></div>
  `;
}

/* ---------------- 个股回测 ---------------- */

/** 区间内股息率最高值（%）。按年取 4/12 月末价格，每股分红用上一年度 —— 跟引擎同一口径。 */
function rangePeakDy(code, from, to) {
  const s = ctx.market?.series?.get(code);
  if (!s) return 0;
  const divs = db.baseline.dividends || {};
  const y0 = Number(String(from || '').slice(0, 4));
  const y1 = Number(String(to || '').slice(0, 4));
  let best = 0;
  for (let y = y0; y <= y1; y++) {
    const dps = prevDps(divs, code, y);
    if (!(dps > 0)) continue;
    for (const md of ['-04-30', '-12-31']) {
      const day = `${y}${md}`;
      // 采样点必须落在区间内：否则「第一次买入之前」会把买入之后那段
      // （股息率已经够线、早就买了的日子）算进来，算出的峰值比门槛还高，自相矛盾
      if (to && day > to) continue;
      if (from && day < from) continue;
      const p = priceAt(s, day);
      if (p > 0) best = Math.max(best, (dps / p) * 100);
    }
  }
  return best;
}

function renderStockPage(market, structureData) {
  const code = btState.stock;
  const s = market.series.get(code);
  if (!s || !s.dates.length) {
    return `${paramBar({ tabs: false, stock: true })}<div class="banner">${esc(code)} 没有日线数据（可能退市/停牌）</div>`;
  }
  /* 个股回测不判断买卖点：本金第一天全买，之后按时定投，分红当天再投。
     不设股息率门槛、不看财报、不因为分红下调卖出。 */
  const r = runInvestBacktest({
    code,
    dates: market.dates,
    series: s,
    dividends: db.baseline.dividends || {},
    capital: btState.capital,
    monthlyAdd: btState.monthlyAdd,
    benchmarkSeries: ctx.benchRows,
    lowVolSeries: ctx.lowVolRows,
    from: clampFrom(btState.from),
    to: btState.to,
  });
  ctx.stock = r;
  const st = r.stats;
  const vc = st.cagr >= 0 ? 'up' : 'down';
  const perYearAdd = btState.monthlyAdd * 12;
  const meta = stockMeta(code);
  const divTrades = r.trades.filter((t) => t.type === '分红复投' || t.type === '分红');
  const divRate = r.totalIn > 0 ? (r.totalDiv / r.totalIn) * 100 : null;
  const y0 = Number(String(clampFrom(btState.from)).slice(0, 4));
  const payYear = st.paybackYear == null ? null : st.paybackYear - y0 + 1;
  const divYears = Object.keys(r.divByY || {}).filter((y) => r.divByY[y] > 0).length;
  return `
  <section class="sym-bar fade-in">
    <div class="sym-main">
      <div class="sym-title">
        <b class="sym-name">${esc(nameOf(code))}</b>
        <span class="sym-code">${esc(code)}</span>
        ${meta && meta.ind ? `<span class="sym-tag">${esc(meta.ind)}</span>` : ''}
      </div>
      <div class="sym-meta">日 K 自 ${esc(dailyStart())} · 行情 ${esc(todayStr())} · 不复权 · 分红 ${divTrades.length} 笔</div>
    </div>
    <div class="sym-pick">
      <div class="stock-search">${icon('search')}<input id="stSearch" placeholder="换一只：代码 / 名称" autocomplete="off" spellcheck="false"></div>
      <div id="stSuggest" class="search-suggest" hidden></div>
    </div>
  </section>

  ${paramBar({ tabs: false, stock: true })}

  ${st.divMissing ? `<div class="banner" style="margin-bottom:12px">${icon('alert')}<div><b>没取到 ${esc(nameOf(code))}（${esc(code)}）的派息明细</b>　可能是数据源里查不到它的除权除息日，也可能是这次没联上——<b>本次回测一分分红都没算</b>，不猜日子。分红那几张图是空的，不代表它不分红。</div></div>` : ''}
  ${hero({
    kicker: `个股定投 · ${esc(nameOf(code))} ${esc(code)} · ${clampFrom(btState.from)} → ${btState.to}`,
    main: `${bigMoney(r.totalIn)} <span class="thin">→</span> <b class="num gold">${bigMoney(r.end)}</b><span class="thin">，年化 ${pctSign(st.cagr == null ? null : st.cagr * 100, 1)}</span>`,
    chips: [
      { t: '不判买卖点' },
      { t: perYearAdd > 0 ? `每月追 ${bigMoney(btState.monthlyAdd)}` : '不再追加' },
      { t: '分红当天再投' },
      { t: '卖出 0 次' },
      { t: `vs 红利 ${pctSign(st.excess == null ? null : st.excess * 100, 1)}`, cls: 'bench' },
      { t: `vs 低波 ${pctSign(st.excessLowVol == null ? null : st.excessLowVol * 100, 1)}`, cls: 'lowvol' },
    ],
    stats: [
      { k: '累计收益', v: pctSign(st.ret == null ? null : st.ret * 100, 1), cls: vc, s: `${num(st.years, 1)} 年 · 本金口径` },
      { k: '年化', v: pctSign(st.cagr == null ? null : st.cagr * 100, 1), cls: vc, s: perYearAdd > 0 ? 'XIRR 资金加权' : '复利折算' },
      { k: '最大回撤', v: pct(st.mdd * 100, 1), cls: 'ddc', s: `${esc(st.mddPeak)} → ${esc(st.mddTrough)}` },
      { k: '分红', v: bigMoney(r.totalDiv), cls: 'divc', s: `全部再投，滚了 ${st.reinvest} 次` },
    ],
  })}

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">净值曲线</span><span class="section-note">终值 <b style="color:var(--c-nav)">${num(st.navLast, 2)}</b> · <b style="color:var(--c-bench)">${num(st.benchLast, 2)}</b> · <b style="color:var(--c-lowvol)">${num(st.lowVolLast, 2)}</b>　|　中段回撤 · 下段每年分红</span></div>
    <div class="panel-body" style="padding:8px 10px 4px"><div id="stNav" class="chart chart-tall"></div></div>
  </section>

  ${metricGrid([
    { k: '期末', v: bigMoney(r.end), cls: 'gold', s: '持仓市值 + 零钱', key: 'nav', on: btState.metric === 'nav' || !btState.metric },
    { k: '累计投入', v: bigMoney(r.totalIn), cls: 'fund', s: perYearAdd > 0 ? `本金 + 定投 ${bigMoney(r.totalIn - btState.capital)}` : '只有本金', key: 'fund' },
    { k: '年化', v: pctSign(st.cagr == null ? null : st.cagr * 100, 1), cls: vc, s: perYearAdd > 0 ? 'XIRR 资金加权' : '复利折算', key: 'ann' },
    { k: '最大回撤', v: pct(st.mdd * 100, 1), cls: 'ddc', s: `${esc(st.mddPeak)} → ${esc(st.mddTrough)}`, key: 'dd' },
    { k: '分红', v: bigMoney(r.totalDiv), cls: 'divc', s: `再投 ${st.reinvest} 次，一分没取`, key: 'div' },
    { k: '买入持有', v: bigMoney(r.endHold), cls: 'fund', s: `年化 ${pctSign(st.cagrHold == null ? null : st.cagrHold * 100, 1)} · 分红不复投`, key: 'hold' },
    { k: '回本', v: payYear == null ? '还没' : `第 ${payYear} 年`, cls: payYear == null ? '' : 'divc', s: payYear == null ? `累计分红 ${pct(divRate, 0)} 本金` : `${st.paybackYear} 年分红盖过本金`, key: 'payback' },
    { k: 'vs 指数', v: pctSign(st.excess == null ? null : st.excess * 100, 1), cls: upDown(st.excess), s: `vs 红利 · 低波 ${pctSign(st.excessLowVol == null ? null : st.excessLowVol * 100, 1)}`, key: 'bench' },
  ])}
  <div id="metricDetail" style="margin-top:12px"></div>

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">钱从哪来</span><span class="section-note">本金 + 分红到账 + 价格涨跌 = 期末</span></div>
    <div class="panel-body" style="padding:8px 10px 6px"><div id="wfChart" class="chart" style="height:220px"></div></div>
  </section>

  ${fold('kline', '日 K · 建仓 / 分红复投', `收盘线 + MA20/MA60 · 蓝▲建仓/定投 · 红◆分红复投（除权除息日当天买回）· 不卖，没有卖点`, '<div class="panel-body" style="padding:8px 10px 4px"><div id="stChart" class="chart" style="height:380px"></div></div>')}

  ${fold('syear', '年度数据', `${r.yearly.filter((y) => y.nav1 > 0).length} 年 · 累计收益 / 分红 / 回本率 / 年度 vs 指数 · 4 图 + 明细`, yearSectionStock(r))}

  ${fold('sdiv', '分红明细', `总分红 <b class="num divc">${bigMoney(r.totalDiv)}</b> · ${divTrades.length} 笔 · ${divYears} 个年度 · 增速 ${st.divCagr == null ? '—' : pctSign(st.divCagr * 100, 1) + '/年'} · 分红率 ${pct(divRate, 1)} · 回报本金 ${pct((r.totalDiv / Math.max(1, btState.capital)) * 100, 0)}`, divSectionStock(r))}

  ${fold('flow', '买入流水', `${r.trades.length} 笔 · 每一次买入的日期、股数、价格`, flowTable(r.trades))}
  ${fold('rules', '本次回测规则', '4 条 · 可审计', investRules())}`;
}

/* ---- 个股页：年度数据（4 图 + 明细） ---- */

function yearSectionStock(r) {
  const years = r.yearly.filter((y) => y.nav1 > 0);
  const capital = r.nav[0]?.[1] || 1;
  let cumDiv = 0;
  const tbl = years.map((y) => {
    const ret = y.nav0 > 0 ? (y.nav1 / y.nav0 - 1) * 100 : null;
    const cashPct = y.nav1 > 0 ? (y.cash / y.nav1) * 100 : null;
    cumDiv += y.div;
    const repay = (cumDiv / Math.max(1, capital)) * 100;
    return `<tr><td class="num">${y.year}</td><td class="num">${(y.nav0 / 10000).toFixed(1)}</td><td class="num">${(y.nav1 / 10000).toFixed(1)}</td><td class="num ${upDown(ret)}">${pctSign(ret, 1)}</td><td class="num divc">${(y.div / 10000).toFixed(2)}</td><td class="num divc">${(cumDiv / 10000).toFixed(2)}</td><td class="num">${repay.toFixed(0)}%</td><td class="num">${pctSign(cashPct, 0)}</td><td class="num">${(y.invest / 10000).toFixed(1)}</td></tr>`;
  }).join('');
  return `<div class="bt-year-grid">
    <div class="bt-year-cell"><div class="bt-year-title">累计收益</div><div id="syYear" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">分红</div><div id="syDiv" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">回本率（累计分红 ÷ 本金）</div><div id="syRepay" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">当年股息率（分红 ÷ 年末市值）</div><div id="syCash" class="chart" style="height:240px"></div></div>
  </div>
  <div class="table-wrap" style="margin-top:10px"><table class="table">
    <thead><tr><th>年</th><th>年初(万)</th><th>年末(万)</th><th>今年收益</th><th>分红(万)</th><th>分红累计(万)</th><th>回本%</th><th>年末现金%</th><th>追加(万)</th></tr></thead>
    <tbody>${tbl}</tbody>
  </table></div>`;
}

function drawStockYearCharts() {
  const r = ctx.stock;
  if (!r) return;
  const capital = r.nav[0]?.[1] || btState.capital;
  const nav = r.nav;
  drawLineMini(document.getElementById('syYear'), nav.map(([d, v]) => [d, +((v / capital - 1) * 100).toFixed(2)]), { yFmt: (v) => v.toFixed(0) + '%', markLine: { silent: true, symbol: 'none', lineStyle: { color: '#65707e' }, data: [{ yAxis: 0 }] } });
  drawDivChart(document.getElementById('syDiv'), r.divByY);
  {
    // 阶梯点直接由 yearly 累出来，不再逐日扫：年末跳一档，最后一年补到区间最后一天
    const ys = r.yearly.filter((y) => y.nav1 > 0);
    const lastDate = nav[nav.length - 1][0];
    let cum = 0;
    const rows = [[nav[0][0], 0]];
    for (const y of ys) {
      if (y.div > 0) {
        rows.push([`${y.year}-01-01`, +((cum / capital) * 100).toFixed(2)]);
        cum += y.div;
        rows.push([`${y.year}-12-31`, +((cum / capital) * 100).toFixed(2)]);
      }
    }
    rows.push([lastDate, +((cum / capital) * 100).toFixed(2)]);
    drawLineMini(document.getElementById('syRepay'), rows, { yFmt: (v) => v.toFixed(0) + '%', color: chartColors().div });
  }
  // 当年股息率：分红 ÷ 年末市值。比「现金占比」有用得多——个股页现金本来就是零头
  drawLineMini(document.getElementById('syCash'), r.yearly.filter((y) => y.nav1 > 0).map((y) => [`${y.year}-12-31`, +(y.nav1 > 0 ? (y.div / y.nav1) * 100 : 0).toFixed(2)]), { yFmt: (v) => v.toFixed(1) + '%', color: chartColors().buy });
}

/* ---- 个股页：分红明细（年度汇总 + 逐笔） ---- */

function divSectionStock(r) {
  const rows = r.trades.filter((t) => t.type === '分红复投' || t.type === '分红');
  const byY = new Map();
  for (const t of rows) {
    const y = t.date.slice(0, 4);
    if (!byY.has(y)) byY.set(y, { n: 0, amt: 0, shares: 0, dps: 0 });
    const o = byY.get(y);
    o.n += 1;
    o.amt += t.div != null ? t.div : (t.amount || 0);
    o.shares += t.type === '分红复投' ? (t.shares || 0) : 0;
    o.dps += t.dps || 0;
  }
  const years = [...byY.keys()].sort();
  const yTbl = years.map((y) => {
    const o = byY.get(y);
    return `<tr><td class="num">${y}</td><td class="num">${o.n} 笔</td><td class="num">${o.dps.toFixed(4)}</td><td class="num divc">${(o.amt / 10000).toFixed(2)}</td><td class="num">${o.shares.toLocaleString('zh-CN')}</td></tr>`;
  }).join('');
  const dTbl = rows.slice().reverse().map((t) => `<tr><td class="num">${t.date}</td><td class="num">${(t.dps || 0).toFixed(4)}</td><td class="num divc">${(((t.div != null ? t.div : t.amount) || 0) / 10000).toFixed(2)}</td><td class="num">${t.type === '分红复投' ? (t.shares || 0).toLocaleString('zh-CN') : '<span class="dim">不够一手</span>'}</td><td class="num">${t.price ? t.price.toFixed(2) : '—'}</td></tr>`).join('');
  return `<div class="panel-body" style="padding:8px 10px 4px"><div id="stDivChart" class="chart" style="height:280px"></div></div>
  <div class="table-wrap" style="margin-top:6px"><table class="table">
    <thead><tr><th>年</th><th>派息次数</th><th>每股合计(元)</th><th>到账(万)</th><th>再投股数</th></tr></thead>
    <tbody>${yTbl}</tbody>
  </table></div>
  <div class="table-wrap" style="margin-top:14px"><table class="table">
    <thead><tr><th>除权除息日</th><th>每股派(元)</th><th>到账(万)</th><th>再投股数</th><th>再投价</th></tr></thead>
    <tbody>${dTbl}</tbody>
  </table></div>`;
}

/* ---------------- 组合对比 ---------------- */


/** 红利精选的最新一期成分：模型现在到底选了什么，抄给人看。
 *
 * 光有一行净值曲线看不出这套规则选股选在哪，所以把最近一次调仓的成分、行业分布、
 * 平均股息率摆出来——用户能对着自己的持仓判断这事靠不靠谱。 */
function strategyPanel() {
  const st = ctx?.cmpStrategy;
  if (!st || !st.periods || !st.periods.length) return '';
  const last = st.periods[st.periods.length - 1];
  const items = last.items || [];
  if (!items.length) return '';
  const pool = db.baseline.pool || {};
  const avgDy = items.reduce((a, x) => a + (Number(x.dy) || 0), 0) / items.length;
  const inds = new Map();
  for (const x of items) {
    const g = pool[x.code]?.ind || '其他';
    if (!inds.has(g)) inds.set(g, []);
    inds.get(g).push(x);
  }
  const maxInd = [...inds.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const chips = [...inds.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([g, list]) => `
      <div class="st-ind">
        <div class="st-ind-head">${esc(g)}<span>${list.length}</span></div>
        <div class="st-ind-body">${list.map((x) => `<span class="st-chip" data-code="${esc(x.code)}" title="${esc(x.name)} 股息率 ${(Number(x.dy) || 0).toFixed(1)}%">${esc(x.name)}<i>${(Number(x.dy) || 0).toFixed(1)}%</i></span>`).join('')}</div>
      </div>`).join('');

  return `
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">红利精选 · 最新一期成分</span><span class="section-note">${esc(last.ym)} 调仓 · ${items.length} 只等权</span></div>
    <div class="panel-body" style="padding:12px 14px 14px">
      <div class="st-meta">
        <div><span class="k">平均股息率</span><b class="num gold">${avgDy.toFixed(1)}%</b></div>
        <div><span class="k">覆盖行业</span><b class="num">${inds.size}</b></div>
        <div><span class="k">最大行业</span><b class="num">${esc(maxInd ? maxInd[0] : '—')}</b><span class="d">${maxInd ? maxInd[1].length + ' 只' : ''}</span></div>
      </div>
      <div class="st-inds">${chips}</div>
      <div class="bt-hint" style="margin-top:10px">规则：连续分红 ≥5 年 · 派息率 10%–80% · 股息率 4%–8% · 经营现金流覆盖 ≥0.7 · 同行业最多 3 只。股息率上限不是越高越好——8% 以上多半是市场在说这次分红撑不住。</div>
    </div>
  </section>`;
}

function renderCompare(market, structureData) {
  const from = clampFrom(btState.from);
  const to = btState.to;
  const rows = (ctx.compareRows || []).filter((x) => !x.empty);   // 没选出股票的组合不参与排名
  const bench = ctx.compareBench;
  const benchCagr = bench ? bench.cagr : null;
  const best = rows.length ? [...rows].sort((a, b) => b.end - a.end)[0] : null;
  const safest = rows.length ? [...rows].sort((a, b) => b.mdd - a.mdd)[0] : null;
  // 回撤条：同一个尺度上比，一眼看出谁跌得狠
  const maxMdd = Math.max(...rows.map((x) => Math.abs(x.mdd || 0)), 0.01);
  const table = rows.map((x) => {
    // 基准行不跟自己比：vs 指数、跑赢年数都留空
    const excess = x.isIndex ? null : (benchCagr != null && x.cagr != null ? (x.cagr - benchCagr) * 100 : null);
    const win = x.isIndex ? '—' : winYears(x.nav, bench?.rows);
    const barW = (Math.abs(x.mdd || 0) / maxMdd) * 100;
    return `<tr>
      <td class="name"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${x.color};margin-right:6px"></span>${esc(x.name)}</td>
      <td class="num">${bigMoney(x.end)}</td>
      <td class="num ${upDown(x.cagr)}">${pctSign(x.cagr == null ? null : x.cagr * 100, 1)}</td>
      <td class="num ddcell down"><i style="width:${barW.toFixed(1)}%"></i><span>${pct(x.mdd * 100, 0)}</span></td>
      <td class="num">${x.div == null ? '—' : bigMoney(x.div)}</td>
      <td class="num ${upDown(excess)}">${excess == null ? '—' : (excess >= 0 ? '+' : '') + excess.toFixed(1) + 'pp'}</td>
      <td class="num">${win}</td>
    </tr>`;
  }).join('');
  return `
  ${paramBar({ tabs: false })}
  ${ctx.compareNote ? `<div class="banner" style="margin-bottom:12px">${icon('alert')}<div>${esc(ctx.compareNote)}</div></div>` : ''}
  <section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">组合对比</span><span class="section-note">同一本金 ${bigMoney(btState.capital)} · 同一区间 · 同一口径</span></div>
    <div class="panel-body" style="padding:10px 10px 4px">
      <div id="cmpChart" class="chart" style="height:380px"></div>
      <div class="bt-hint" style="padding:4px">每个方案按自己的目标权重复投；红利精选为每年 4 月末按规则选 15 只等权买入、持有一年不中途再平衡（分红按上一年度合计均摊 12 个月再投）；指数为全收益口径；曲线为月末净值</div>
    </div>
  </section>
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">指标对比</span><span class="section-note">期末 / 年化 / 最大回撤 / 分红 / vs 指数 / 跑赢年数</span></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>组合</th><th>期末</th><th>年化</th><th>最大回撤</th><th>总分红</th><th>vs 指数</th><th>跑赢年数</th></tr></thead>
      <tbody>${table}</tbody>
    </table></div>
  </section>
  ${strategyPanel()}
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">结论</span><span class="section-note">谁在牛市更赚 · 谁在熊市更抗跌 · 分红谁更多</span></div>
    <div class="panel-body" style="padding:12px 14px 14px">
      <div class="cmp-winner">
        ${best ? `<div class="cw"><span class="k">历史最赚</span><b class="num gold">${esc(best.name)}</b><span class="s">${bigMoney(best.end)} · 年化 ${pctSign(best.cagr * 100, 1)}</span></div>` : ''}
        ${safest ? `<div class="cw"><span class="k">最抗跌</span><b class="num ddc">${esc(safest.name)}</b><span class="s">回撤 ${pct(safest.mdd * 100, 0)}</span></div>` : ''}
        ${bench ? `<div class="cw"><span class="k">中证红利全收益</span><b class="num bnc">${bigMoney(bench.end)}</b><span class="s">年化 ${pctSign(bench.cagr * 100, 1)}</span></div>` : ''}
      </div>
    </div>
  </section>`;
}

function winYears(nav, bench) {
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

/* ---------------- 入口 ---------------- */

function readBtUrl() {
  const qs = new URLSearchParams((location.hash.split('?')[1] || ''));
  const mode = qs.get('mode');
  if (['port', 'stock', 'cmp'].includes(mode)) btState.mode = mode;
  const code = qs.get('code');
  if (/^\d{6}$/.test(code || '')) btState.stock = code;
  const plan = qs.get('plan');
  if (plan) {
    btState.planId = plan;
    const hit = loadPlans().find((p) => p.id === plan);
    if (hit && Number(hit.capital) > 0) btState.capital = Math.round(Number(hit.capital) / 10000) * 10000;
  }
}

export async function renderBacktest() {
  readBtUrl();
  if (!btState.to) {
    btState.to = todayStr();
    btState.from = addYears(btState.to, -10);
  }
  const s = structure();
  // 组合对比要从全市场里选股（红利策略那一行），没有股票池就一个也选不出来，
  // 以前这里没调 loadPool，pool 是空的 → 策略静默变成空组合 → 99.9 万 / -0.0%。
  if (btState.mode === 'cmp') await loadPool();
  const planCodes = btState.mode === 'cmp' ? loadPlans().flatMap((p) => (p.holdings || []).map((h) => h.code)) : [];
  const codes = [...new Set([...s.holdings.map((h) => h.code), ...planCodes, btState.stock])];
  // 只拉当前组合/方案里那几只的分红；组合增删改后再进来，这里会补下新增那几只
  await ensureDividends(codes);
  const needFinance = btState.mode === 'stock' && btState.quality;
  const market = await loadMarket(codes, clampFrom(btState.from), btState.to, {
    finance: needFinance,
    monthly: 'auto',
    marketWide: btState.mode === 'cmp',
    stockCode: btState.mode === 'stock' ? btState.stock : null,
  });
  const bench = benchRows(market.index, db.benchmark, clampFrom(btState.from), btState.to);
  const lv = lowVolRows(market.index, clampFrom(btState.from), btState.to);
  ctx = { market, structure: s, benchRows: bench, lowVolRows: lv };

  let body = '';
  if (btState.mode === 'stock') {
    body = renderStockPage(market, s);
  } else if (btState.mode === 'cmp') {
    // 勾了哪几个方案才画哪几个（btState.cmpPlans === null 表示全选）
    const want = (id) => !btState.cmpPlans || btState.cmpPlans.includes(id);
    const plans = [{ id: 'current', name: s.name || '当前持仓', holdings: s.holdings, lots: s.lots, cash: s.cash }];
    for (const p of loadPlans()) {
      if (p.id === btState.planId) continue;
      if (!want(p.id)) continue;
      plans.push({ id: p.id, name: p.name, holdings: p.holdings.map((h) => ({ code: h.code, weight: Number(h.weight) || 0 })), lots: [], cash: 0 });
    }
    if (btState.planId !== 'current' && want(btState.planId)) {
      const hit = loadPlans().find((p) => p.id === btState.planId);
      if (hit) plans.unshift({ id: hit.id, name: hit.name, holdings: hit.holdings.map((h) => ({ code: h.code, weight: Number(h.weight) || 0 })), lots: [], cash: 0 });
    }
    const uniqPlans = [];
    const seen = new Set();
    for (const p of plans) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      uniqPlans.push(p);
    }
    // 方案色：第 1 个是当前持仓，用「净值红」当主角；其余避开语义色（红/青/紫），
    // 免得跟两条指数搅在一起。红利策略单独用「辅助金」——它是规则不是持仓。
    const CC = chartColors();
    const COLORS = [CC.nav, '#5b9cf5', '#35b57a', '#f783ac', '#22b8cf', '#a3e635', '#f9a8a8'];
    const rows = [];
    const b0 = runPortfolioBacktest({
      dates: market.dates, series: market.series, dividends: db.baseline.dividends || {},
      holdings: uniqPlans[0].holdings, capital: btState.capital, monthlyAdd: btState.monthlyAdd,
      from: clampFrom(btState.from), to: btState.to, mode: 'invest',
      benchmarkSeries: bench, lowVolSeries: lv,
    });
    uniqPlans.forEach((p, i) => {
      const r = i === 0 ? b0 : runPortfolioBacktest({
        dates: market.dates, series: market.series, dividends: db.baseline.dividends || {},
        holdings: p.holdings, capital: btState.capital, monthlyAdd: btState.monthlyAdd,
        from: clampFrom(btState.from), to: btState.to, mode: 'invest',
      });
      rows.push({ kind: 'plan', name: p.name, color: COLORS[i % COLORS.length], nav: r.nav, end: r.end, cagr: r.stats.cagr, mdd: r.stats.mdd, div: r.totalDiv, width: 2 });
    });
    // 红利策略：选股用「每年 4 月末收盘价」（cmp-yearly，78KB）跑一遍，
    // 拿到 10 年选中的成分股，再只拉这几十只的完整月线（每只 2.3KB）算净值。
    // 这样净值/回撤是月频精确的，而不用下 6.4MB 全市场月线。
    // 高稳定分红模型（研究见 tools/research/README.md）：
    // 连续分红 5 年 + 派息率 10–80% + 股息率 4–8% + 同行业最多 3 只 + 持 15 只。
    // 8% 上限砍掉「异常高息」那一段——不设它，2024 年会全仓煤炭地产，单年跑输 16 个点。
    const strategyParams = {
      startYear: Number(clampFrom(btState.from).slice(0, 4)) + 1,
      endYm: btState.to.slice(0, 7),
      holdN: 15, minDy: 4, maxDy: 8, minDivYears: 5,
      minPayout: 10, maxPayout: 80, minRoe: 8, minCover: 0.7,
      indCap: 3, quality: true,
    };
    const screenMonths = await loadCmpScreen();
    const cmpFin = await loadCmpFin();
    const pass1 = runPlanBacktest({
      baseline: db.baseline, months: screenMonths, screenMonths, benchmark: db.benchmark,
      finHistory: cmpFin, params: strategyParams,
    });
    const picked = [...new Set(pass1.periods.flatMap((x) => (x.items || []).map((it) => it.code)))];
    const fullMonths = await loadMonthlyFor(picked);
    const plan = runPlanBacktest({
      baseline: db.baseline, months: fullMonths, screenMonths, benchmark: db.benchmark,
      finHistory: cmpFin, params: strategyParams,
    });
    const noPick = !pass1.periods.length || pass1.periods.every((x) => !x.items.length);
    rows.push({
      kind: 'rule',
      name: `红利精选(${plan.params.holdN}只)`, color: chartColors().sub,
      nav: plan.nav.map((pt) => [monthEnd(pt.ym), +(btState.capital * pt.nav).toFixed(2)]),
      end: btState.capital * (1 + plan.stats.total), cagr: plan.stats.cagr, mdd: plan.stats.mdd, div: null, width: 1.6,
      empty: noPick,
    });
    if (b0.bench) rows.push({ kind: 'bench', name: '中证红利全收益', color: chartColors().bench, nav: b0.bench.rows, end: b0.bench.end, cagr: b0.bench.cagr, mdd: maxDrawdown(b0.bench.rows).mdd, div: null, width: 1.3, isIndex: true });
    if (b0.lowVol) rows.push({ kind: 'bench', name: '红利低波全收益', color: chartColors().lowvol, nav: b0.lowVol.rows, end: b0.lowVol.end, cagr: b0.lowVol.cagr, mdd: maxDrawdown(b0.lowVol.rows).mdd, div: null, width: 1.4, isIndex: true });
    // 方案很多时给策略/指数留位置：最多 5 个方案，其余名额归基准行
    const planRows = rows.filter((r) => r.kind === 'plan');
    const restRows = rows.filter((r) => r.kind !== 'plan');
    ctx.compareRows = [...planRows.slice(0, 5), ...restRows].slice(0, 8);
    ctx.compareBench = b0.bench;
    ctx.compareLowVol = b0.lowVol;
    ctx.cmpStrategy = { periods: plan.periods, params: plan.params, yearly: plan.yearly, stats: plan.stats };
    ctx.compareNote = noPick
      ? '红利策略这一行没选出任何股票（股票池或选股财报没加载成功），所以是一条水平线，不代表策略本身不赚钱。'
      : '';
    body = renderCompare(market, s);
  } else {
    body = renderPort(market, s);
  }

  // 财报拉不全（慢网断流）时不白屏：用不含质量筛选的结果继续跑，并在顶部说明
  const finWarn = market.finHistory && db.finDegraded
    ? `<div class="banner warn" style="margin:0 0 12px">历史财报只拉到一部分（慢网断流），本次回测<b>未启用质量筛选</b>，数值会略有差异。刷新一次可补下其余分片。</div>`
    : '';

  return `<div class="page-head fade-in">
    <div>
      <h1 class="page-title">回测</h1>
      <div class="page-sub">组合回测 / 个股回测 / 组合对比 · 日 K + 月线 · 基准中证红利 / 红利低波</div>
    </div>
    <div class="page-actions">${modeTabs()}</div>
  </div>
  ${finWarn}${body}`;
}

/* ---------------- 渲染后绑定 ---------------- */

export function bindBacktest() {
  if (!ctx) return;
  stopCompPlay();
  const rerender = () => { if (rerenderHook) rerenderHook(); };
  const syncUrl = () => {
    try {
      const q = [];
      if (btState.mode !== 'port') q.push('mode=' + btState.mode);
      if (btState.mode === 'stock' && btState.stock) q.push('code=' + btState.stock);
      history.replaceState(null, '', '#backtest' + (q.length ? '?' + q.join('&') : ''));
    } catch (e) {}
  };
  const rerenderUrl = () => { syncUrl(); rerender(); };
  document.querySelectorAll('[data-btmode]').forEach((b) => {
    b.onclick = () => { btState.mode = b.dataset.btmode; rerenderUrl(); };
  });
  document.querySelectorAll('[data-portmode]').forEach((b) => {
    b.onclick = () => { btState.portMode = b.dataset.portmode; rerender(); };
  });
  const run = document.getElementById('btRun');
  if (run) run.onclick = () => readParams();
  const planSel = document.getElementById('btPlan');
  if (planSel) planSel.onchange = () => {
    btState.planId = planSel.value;
    if (btState.planId !== 'current') {
      btState.portMode = 'invest';
      const hit = loadPlans().find((p) => p.id === btState.planId);
      if (hit && Number(hit.capital) > 0) btState.capital = Math.round(Number(hit.capital) / 10000) * 10000;
    }
    rerender();
  };
  const saveBtn = document.getElementById('btSavePlan');
  if (saveBtn) saveBtn.onclick = () => {
    const name = window.prompt('方案名称（例如：红利五虎）', '我的方案');
    if (!name) return;
    const st = ctx.structure;
    const saved = savePlan({
      name: name.slice(0, 20),
      capital: btState.capital,
      holdings: st.holdings.map((h) => ({ code: h.code, weight: Math.round(h.weight * 10) / 10 })),
      entry: { mode: 'once' },
    });
    btState.planId = saved?.id || 'current';
    rerender();
  };
  const useCap = document.getElementById('btUseMktCap');
  if (useCap) useCap.onclick = () => {
    const s = ctx.structure;
    if (s && s.total > 0) { btState.capital = Math.round(s.total / 10000) * 10000; rerender(); }
  };
  document.querySelectorAll('[data-q]').forEach((b) => {
    // 先收下没提交的输入，否则刚改的本金/日期会被这一步重渲染悄悄冲掉
    b.onclick = () => { readParams(); btState.from = addYears(btState.to, -Number(b.dataset.q)); rerender(); };
  });
  document.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => { readParams(); btState.monthlyAdd = Number(b.dataset.add); rerender(); };
  });
  document.querySelectorAll('[data-cmpplan]').forEach((b) => {
    b.onclick = () => {
      const all = loadPlans().map((p) => p.id);
      const id = b.dataset.cmpplan;
      if (id === '__all') { btState.cmpPlans = null; rerender(); return; }
      const cur = btState.cmpPlans ? [...btState.cmpPlans] : [...all];
      const i = cur.indexOf(id);
      if (i >= 0) cur.splice(i, 1); else cur.push(id);
      btState.cmpPlans = cur.length === all.length ? null : cur;
      rerender();
    };
  });
  const search = document.getElementById('stSearch');
  if (search) {
    mountStockSearch(search, {
      suggest: document.getElementById('stSuggest'),
      onPick: (c) => {
        if (!/^\d{6}$/.test(c || '') || c === btState.stock) return;
        btState.stock = c;
        rerenderUrl();
      },
    });
  }
  // 日 K 折叠着：展开那一刻再画（藏在 display:none 里画出来是 0 宽）
  const klineFold = document.querySelector('[data-fold="kline"]');
  if (klineFold) {
    klineFold.addEventListener('toggle', () => {
      if (!klineFold.open) return;
      const box = document.getElementById('stChart');
      const inst = window.echarts?.getInstanceByDom(box);
      if (inst) inst.resize();
      else drawStockKline();
    });
  }
  document.querySelectorAll('[data-metric]').forEach((card) => {
    card.onclick = () => {
      btState.metric = card.dataset.metric;
      document.querySelectorAll('[data-metric]').forEach((c) => c.classList.toggle('on', c === card));
      if (btState.mode === 'stock') renderStockMetric(card.dataset.metric);
      else renderMetric(card.dataset.metric);
    };
  });

  const p = ctx.port;
  if (p && p.comp && p.comp.length) {
    const range = document.getElementById('compRange');
    const dateEl = document.getElementById('compDate');
    const listEl = document.getElementById('compList');
    const denEl = document.getElementById('compDonut');
    const play = document.getElementById('compPlay');
    const COLORS = ['#d8a84e', '#ef5b60', '#5b9cf5', '#35b57a', '#a78bfa', '#e8a33d', '#22b8cf', '#f783ac', '#94d82d'];
    let idx = p.comp.length - 1;
    const paint = () => {
      const [d, row] = p.comp[idx];
      const entries = Object.entries(row).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).map(([code, v], i) => ({
        name: code === 'cash' ? '现金' : nameOf(code),
        value: +(v / 10000).toFixed(2),
        color: code === 'cash' ? '#8b93a1' : COLORS[i % COLORS.length],
      }));
      const total = entries.reduce((s, e) => s + e.value, 0);
      drawDonut(denEl, entries);
      if (dateEl) dateEl.innerHTML = `持仓构成 · <b>${d}</b> · 总资产 <b class="num">${total.toFixed(1)}万</b>`;
      if (listEl) listEl.innerHTML = entries.map((e) => `<span class="comp-item"><i style="background:${e.color}"></i>${esc(e.name)} <b class="num">${e.value.toFixed(1)}万</b><em>${((e.value / (total || 1)) * 100).toFixed(0)}%</em></span>`).join('');
    };
    if (range) {
      range.max = String(p.comp.length - 1);
      range.value = String(idx);
      range.oninput = () => { idx = Math.min(p.comp.length - 1, Math.max(0, Number(range.value) || 0)); paint(); };
    }
    if (play) play.onclick = () => {
      if (compTimer) { stopCompPlay(); return; }
      // 滑轨默认停在最后一天：这时候点「播放」原地就结束，看着像按钮坏了。从头播。
      if (idx >= p.comp.length - 1) { idx = 0; if (range) range.value = '0'; paint(); }
      play.textContent = '暂停 ⏸';
      compTimer = setInterval(() => {
        idx++;
        if (idx >= p.comp.length) { idx = p.comp.length - 1; stopCompPlay(); }
        if (range) range.value = String(idx);
        paint();
      }, 55);
    };
    paint();
  }

  if (p) {
    drawPortfolioChart(document.getElementById('portChart'), {
      nav: p.nav, navR: p.navR, bench: p.bench, lowVol: p.lowVol, dd: p.dd,
      divByY: p.divByY, capital: btState.portMode === 'replay' ? (p.nav[0]?.[1] || 1) : btState.capital,
    });
    drawWaterfall(document.getElementById('wfChart'), { capital: btState.portMode === 'replay' ? (p.nav[0]?.[1] || 1) : btState.capital, div: p.totalDiv, end: p.end });
    drawEnvChart(document.getElementById('envChart'), envCompare(p.nav, ctx.benchRows, clampFrom(btState.from), btState.to));
    const simData = document.getElementById('simData');
    if (simData) {
      const pts = JSON.parse(simData.dataset.json || '[]');
      const cur = simData.dataset.cur ? Number(simData.dataset.cur) : null;
      const med = simData.dataset.med ? Number(simData.dataset.med) : null;
      const nowEl = document.getElementById('nowChart');
      if (cur != null && pts.length) drawSimilarChart(nowEl, pts, cur, med);
      else if (nowEl) nowEl.innerHTML = '<div class="bt-hint" style="padding:30px;text-align:center">历史相似状态样本不足</div>';
    }
    document.querySelectorAll('[data-scard]').forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest('[data-sbt]')) return;
        const code = card.dataset.scard;
        const body = document.getElementById('scard-' + code);
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        if (!open) drawStockManual(code);
      };
    });
    document.querySelectorAll('[data-sbt]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); btState.stock = b.dataset.sbt; btState.mode = 'stock'; rerender(); };
    });
  }

  if (btState.mode === 'stock' && ctx.stock) {
    drawStockPageCharts();
    if (btState.metric && btState.metric !== 'nav') renderStockMetric(btState.metric);   // nav 就是上面那张大图，别再画一遍、也别滚屏
  }
  if (btState.mode === 'cmp' && ctx.compareRows) drawCompareChart();

  document.querySelectorAll('details.fold').forEach((d) => {
    d.addEventListener('toggle', () => {
      const ar = d.querySelector('.fold-arrow');
      if (ar) ar.textContent = d.open ? '收起 ▾' : '展开 ▸';
      if (!d.open) return;
      const id = d.dataset.fold;
      if (id === 'divhist' && ctx.port) drawDivChart(document.getElementById('divHist'), ctx.port.divByY);
      if (id === 'year') drawYearCharts();
      if (id === 'syear') drawStockYearCharts();
      if (id === 'sdiv') drawDivChart(document.getElementById('stDivChart'), ctx.stock?.divByY);
    });
  });
}

function readParams() {
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

function drawStockPageCharts() {
  const r = ctx.stock;
  if (!r) return;
  // 净值曲线是重点，直接画；日 K 在折叠里，展开时才画（见 bindBacktest 的 toggle）
  drawNavChart(document.getElementById('stNav'), {
    nav: r.nav, bench: r.bench, lowVol: r.lowVol, dd: drawdownOf(r.nav),
    divByY: r.divByY, capital: btState.capital,
  });
  const wfEl = document.getElementById('wfChart');
  if (wfEl) drawWaterfall(wfEl, { capital: btState.capital, add: Math.max(0, r.totalIn - btState.capital), div: r.totalDiv, end: r.end });
  const klineFold = document.querySelector('[data-fold="kline"]');
  if (klineFold && klineFold.open) drawStockKline();
}

function drawStockKline() {
  const r = ctx.stock;
  if (!r) return;
  const daily = ctx.market.daily.get(btState.stock);
  const marks = [];
  for (const t of r.trades) {
    if (t.type === '建仓' || t.type === '定投') marks.push({ date: t.date, price: t.price, kind: 'buy', why: t.why });
    else if (t.type === '分红复投' || t.type === '分红') marks.push({ date: t.date, price: t.price, kind: 'div', why: t.why });
  }
  const candleRows = [];
  if (daily && daily.cal && daily.cal.length) {
    for (let i = 0; i < daily.cal.length; i++) {
      const d = daily.cal[i];
      if (d < clampFrom(btState.from) || d > btState.to) continue;
      if (daily.c[i] == null) continue;
      candleRows.push([d, daily.c[i]]);
    }
  } else {
    const s = ctx.market.series.get(btState.stock);
    for (const [d, c] of s.dates.map((d, i) => [d, s.closes[i]])) {
      if (d >= clampFrom(btState.from)) candleRows.push([d, c]);
    }
  }
  drawPriceChart(document.getElementById('stChart'), candleRows, { marks });
}

function drawStockManual(code) {
  const r = ctx.port;
  if (!r) return;
  const daily = ctx.market.daily.get(code);
  const rows = [];
  if (daily && daily.cal) {
    for (let i = 0; i < daily.cal.length; i++) {
      if (daily.c[i] == null) continue;
      rows.push([daily.cal[i], daily.c[i]]);
    }
  }
  const marks = r.events.filter((e) => e.type === '买入' && e.code === code).map((e) => ({ date: e.date, price: e.price, kind: 'buy', why: e.why }));
  drawPriceChart(document.getElementById('sdChart-' + code), rows, { marks, ma: [20] });
}

function renderStockMetric(key) {
  const box = document.getElementById('metricDetail');
  const r = ctx.stock;
  if (!box || !r) return;
  // 「期末」那张卡对应的就是上面的大图，别在下面再画一条一样的
  if (key === 'nav') {
    box.innerHTML = '';
    document.getElementById('stNav')?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const perYearAdd = btState.monthlyAdd * 12;
  const navW = (arr) => arr.map(([d, v]) => [d, +(v / 10000).toFixed(1)]);
  const base = (title, note) => `<section class="panel"><div class="panel-head"><span class="panel-title">${title}</span><span class="section-note">${note}</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="msChart" class="chart" style="height:300px"></div></div></section>`;
  let html = '';
  let drawFn = null;
  if (key === 'fund') {
    html = base('累计投入', '本金 + 每次定投，逐笔累加');
    drawFn = () => {
      let acc = 0;
      const rows = r.nav.map(([d]) => [d, 0]);
      // 累计投入曲线：按交易把这笔钱加上去
      const byDate = new Map();
      for (const t of r.trades) {
        const amt = t.type === '建仓' ? btState.capital : t.type === '定投' ? t.amount : 0;
        if (amt > 0) byDate.set(t.date, (byDate.get(t.date) || 0) + amt);
      }
      acc = 0;
      const out = r.nav.map(([d]) => { acc += byDate.get(d) || 0; return [d, +(acc / 10000).toFixed(1)]; });
      drawMultiLineChart(document.getElementById('msChart'), [{ name: '累计投入(万)', rows: out, color: chartColors().buy }], { yFmt: (v) => v.toFixed(0) });
    };
  } else if (key === 'ann') {
    html = base('收益 vs 投入', '总资产 ÷ 累计投入 − 1');
    drawFn = () => {
      const byDate = new Map();
      for (const t of r.trades) {
        const amt = t.type === '建仓' ? btState.capital : t.type === '定投' ? t.amount : 0;
        if (amt > 0) byDate.set(t.date, (byDate.get(t.date) || 0) + amt);
      }
      let acc = 0;
      const out = r.nav.map(([d, v]) => { acc += byDate.get(d) || 0; return [d, acc > 0 ? +((v / acc - 1) * 100).toFixed(1) : 0]; });
      drawMultiLineChart(document.getElementById('msChart'), [{ name: '相对投入的盈亏%', rows: out, color: chartColors().nav }], { yFmt: (v) => v.toFixed(0) + '%' });
    };
  } else if (key === 'dd') {
    html = base('回撤（水下）', '距历史最高点');
    drawFn = () => drawMultiLineChart(document.getElementById('msChart'), [{ name: '回撤%', rows: drawdownOf(r.nav), color: chartColors().dd }], { yFmt: (v) => v.toFixed(0) + '%' });
  } else if (key === 'div') {
    html = base('年度分红', '按除权除息日真实到账日复投，不够一手留现金');
    drawFn = () => drawDivChart(document.getElementById('msChart'), r.divByY);
  } else if (key === 'hold') {
    html = base('分红再投 vs 不复投', '同本金、同区间；不复投那份分红进现金');
    drawFn = () => drawMultiLineChart(document.getElementById('msChart'), [
      { name: '分红再投', rows: navW(r.nav), color: chartColors().nav },
      { name: '分红不复投', rows: navW(r.navHold || []), color: chartColors().buy, opacity: 0.85 },
    ], { yFmt: (v) => v.toFixed(0) });
  } else if (key === 'bench') {
    html = base('这只股票 vs 两条红利指数', `同本金、同${perYearAdd > 0 ? '定投节奏' : '区间'}`);
    drawFn = () => {
      const C = chartColors();
      const series = [
        { name: nameOf(r.code), rows: navW(r.nav), color: C.nav },
        { name: '中证红利全收益', rows: (r.bench?.rows || []).map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: C.bench },
      ];
      if (r.lowVol?.rows?.length) series.push({ name: '中证红利低波全收益', rows: r.lowVol.rows.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: C.lowvol });
      drawMultiLineChart(document.getElementById('msChart'), series, { yFmt: (v) => v.toFixed(0) });
    };
  } else if (key === 'payback') {
    html = base('回本进度', '累计分红 ÷ 本金，越过 100% 就是分红把本金还完了');
    drawFn = () => {
      let cum = 0;
      const rows = r.nav.map(([d]) => {
        const y = d.slice(0, 4);
        const hit = r.divByY?.[y];
        if (hit && d.slice(5, 10) >= '12-30') { cum += hit; }
        return [d, +((cum / Math.max(1, btState.capital)) * 100).toFixed(2)];
      });
      drawMultiLineChart(document.getElementById('msChart'), [{ name: '回本%', rows, color: chartColors().div }], {
        yFmt: (v) => v.toFixed(0) + '%',
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#65707e', opacity: 0.5 }, data: [{ yAxis: 100 }] },
      });
    };
  }
  box.innerHTML = html;
  if (drawFn) requestAnimationFrame(() => setTimeout(drawFn, 20));
}

function drawdownOf(nav) {
  let peak = 0;
  const out = [];
  for (const [d, v] of nav) {
    if (v > peak) peak = v;
    out.push([d, peak > 0 ? (v / peak - 1) * 100 : 0]);
  }
  return out;
}

/** 回本率曲线：按引擎记的「真实分红到账日」累加。
    不假设 4 月末、不按年度阶梯——events 里 type==='分红' 的 date 就是除权除息日。 */
function repayCurve(p, nav, capital) {
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

function renderMetric(key) {
  const box = document.getElementById('metricDetail');
  if (!box) return;
  const p = ctx.port;
  if (!p) return;
  const capital = btState.portMode === 'replay' ? (p.nav[0]?.[1] || 1) : btState.capital;
  const nav = p.nav;
  let html = '';
  let drawFn = null;
  if (key === 'nav') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">总资产曲线</span><span class="section-note">持仓市值 + 现金（含分红）</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '总资产(万)', rows: nav.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().nav }], { yFmt: (v) => v.toFixed(0) + '万' });
  } else if (key === 'ann') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">累计收益</span><span class="section-note">(净值 ÷ 本金 − 1)</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '累计收益%', rows: nav.map(([d, v]) => [d, +((v / capital - 1) * 100).toFixed(1)]), color: chartColors().nav }], { yFmt: (v) => v.toFixed(0) + '%' });
  } else if (key === 'navR') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">分红不复投</span><span class="section-note">分红全部留现金、不再买入</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [
      { name: '复投(万)', rows: p.nav.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().nav },
      { name: '不复投(万)', rows: p.navR.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().sub, opacity: 0.8 },
    ], { yFmt: (v) => v.toFixed(0) });
  } else if (key === 'dd') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">回撤（水下）</span><span class="section-note">距历史最高点</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '回撤%', rows: p.dd, color: chartColors().dd }], { yFmt: (v) => v.toFixed(0) + '%' });
  } else if (key === 'div') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">年度分红</span><span class="section-note">按真实除权除息日到账 · 柱 + 累计线</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawDivChart(document.getElementById('mChart'), p.divByY);
  } else if (key === 'repay') {
    const rows = repayCurve(p, nav, capital);
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">回本率</span><span class="section-note">累计分红 ÷ 本金 · 按真实除权除息日到账</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '回本率%', rows, color: chartColors().div }], { yFmt: (v) => v.toFixed(0) + '%' });
  } else if (key === 'hold') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">组合 vs 买入持有 vs 指数</span><span class="section-note">同一本金、同一区间</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [
      { name: '我的组合', rows: nav.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().nav },
      { name: '买入持有', rows: (ctx.holdNav || []).map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().buy, opacity: 0.85 },
      { name: '中证红利全收益', rows: (p.bench?.rows || []).map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().bench, opacity: 0.9 },
    ], { yFmt: (v) => v.toFixed(0) });
  }
  box.innerHTML = html;
  if (drawFn) requestAnimationFrame(() => setTimeout(drawFn, 20));
}

function drawYearCharts() {
  const p = ctx.port;
  if (!p) return;
  const capital = btState.portMode === 'replay' ? (p.nav[0]?.[1] || 1) : btState.capital;
  const nav = p.nav;
  const draws = {
    chYear: () => drawLineMini(document.getElementById('chYear'), nav.map(([d, v]) => [d, +((v / capital - 1) * 100).toFixed(2)]), { yFmt: (v) => v.toFixed(0) + '%', markLine: { silent: true, symbol: 'none', lineStyle: { color: '#65707e' }, data: [{ yAxis: 0 }] } }),
    chDiv: () => drawDivChart(document.getElementById('chDiv'), p.divByY),
    chRepay: () => {
      // 按引擎记的真实分红到账日累加（不假设 4 月末，也不做年度阶梯）
      const rows = repayCurve(p, nav, capital);
      drawLineMini(document.getElementById('chRepay'), rows, { yFmt: (v) => v.toFixed(0) + '%', color: chartColors().div });
    },
    chCash: () => {
      const rows = p.comp.map(([d, row]) => {
        const total = Object.values(row).reduce((s, v) => s + v, 0);
        return [d, +(total > 0 ? (row.cash / total) * 100 : 0).toFixed(1)];
      });
      drawLineMini(document.getElementById('chCash'), rows, { yFmt: (v) => v.toFixed(0) + '%', color: '#5b9cf5' });
    },
    chVsIdx: () => {
      const years = p.yearly.filter((y) => y.nav1 > 0);
      const benchYearly = {};
      for (const [d, v] of ctx.benchRows) {
        const y = d.slice(0, 4);
        if (!benchYearly[y]) benchYearly[y] = { f: v, l: v };
        benchYearly[y].l = v;
      }
      drawBarsVs(document.getElementById('chVsIdx'),
        years.map((y) => y.year),
        years.map((y) => +(((y.nav1 / y.nav0 - 1) * 100)).toFixed(1)),
        years.map((y) => (benchYearly[y.year] ? +(((benchYearly[y.year].l / benchYearly[y.year].f - 1) * 100)).toFixed(1) : null)));
    },
  };
  for (const k of Object.keys(draws)) {
    if (document.getElementById(k)) draws[k]();
  }
}

function drawCompareChart() {
  const rows = ctx.compareRows || [];
  const lines = rows.map((x) => ({
    name: x.name,
    rows: x.nav.map(([d, v]) => [d, +(v / 10000).toFixed(1)]),
    color: x.color,
    width: x.width || 1.4,
  }));
  drawMultiLineChart(document.getElementById('cmpChart'), lines, { yFmt: (v) => v.toFixed(0) + '万' });
}
