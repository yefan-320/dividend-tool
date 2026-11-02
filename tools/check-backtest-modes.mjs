#!/usr/bin/env node
/**
 * 回测页「组合对比 / 持仓回放」端到端检查（真机 DOM vs 引擎期望值）。
 *
 * 为什么需要它：单元测试只测引擎；组合对比（cmp）和持仓回放（replay）的
 * 页面接线（structureData → 引擎参数 → 指标卡 → 对比表）没有覆盖，
 * 一旦传错 lots/cash0/mode/capital，页面会画出「看起来合理」的错数。
 *
 * 检查内容：
 *  1. 投入回测：累计投入 / 总市值 / 年化 / 最大回撤 与 Node 侧引擎一致；
 *  2. 切「持仓回放」：起点市值 = 现金 + Σ 当前股数 × 起点价（独立公式），
 *     期末/年化/回撤与 replay 引擎一致；
 *  3. 改本金 50 万后重跑：指标卡跟着变，且仍与引擎一致；
 *  4. 组合对比：6 行（当前持仓 + 2 方案 + 红利精选 + 两条指数），
 *     方案行的期末/年化/回撤/分红与引擎逐项一致，且带图；
 *  5. 方案 >5 个时策略/指数行不会被 slice 挤掉（回归：rows.slice(0,8)）；
 *  6. 空账本（演示持仓）下不崩、不出 NaN / Infinity / undefined；
 *  7. 全程无 console.error / 未捕获异常。
 *
 * 前置：8766 静态服务 + Chrome 9222（D3_SITE / DSH_CDP_PORT / D3_CDP_PORT 可覆盖）。
 * 用法：node tools/check-backtest-modes.mjs   （失败 exit 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { cdpConnect, sleep } from './lib/cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));

const quotesData = readJson('quotes.json');
const quotes = quotesData.quotes;
const dividends = readJson('baseline.json').dividends;
const benchmarkMonthly = readJson('benchmark.json').bench;
const months = readJson('monthly.json').months;
const dailyCal = readJson('daily/meta.json').cal;
const indexDaily = readJson('index-daily.json');
const { buildSeries, buildTradingDates, priceAt, maxDrawdown, monthEnd } = await import(path.join(ROOT, 'src/engine/market.js'));
const { runPortfolioBacktest } = await import(path.join(ROOT, 'src/engine/portfolioBacktest.js'));
const { bigMoney, pct, pctSign } = await import(path.join(ROOT, 'src/ui/format.js'));

/* ---------- 固定输入（浏览器里用同样的账本/方案） ---------- */
/* 页面把「今天」定成 db.generated——它取的是行情里最新的 date 字段，
   而不是快照顶层 generated（盘后可能多一天）。这里必须同口径，否则末值差几个交易日。 */
const TODAY = (() => {
  let mx = quotesData.generated || '';
  for (const q of Object.values(quotesData.quotes || {})) {
    if (q && q.date && q.date > mx) mx = q.date;
  }
  return mx;
})();
const [ty, tm, td] = TODAY.split('-').map(Number);
const FROM = new Date(Date.UTC(ty - 10, tm - 1, td)).toISOString().slice(0, 10);
const TO = TODAY;
const CASH = 50000;
const LEDGER = [
  { id: 't1', date: '2023-06-15', code: '600036', side: 'buy', shares: 2000, price: 30.5, fee: 5 },
  { id: 't2', date: '2024-08-20', code: '601398', side: 'buy', shares: 5000, price: 7.2, fee: 5 },
  { id: 't3', date: '2025-03-05', code: '600036', side: 'buy', shares: 500, price: 38.0, fee: 5 },
];
const PLANS = [
  { id: 'p-e2e-a', name: '银行双雄', capital: 1000000, holdings: [{ code: '600036', weight: 60 }, { code: '601398', weight: 40 }], entry: { mode: 'once', months: 12, minDy: 5 }, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
  { id: 'p-e2e-b', name: '单押家电', capital: 1000000, holdings: [{ code: '000333', weight: 100 }], entry: { mode: 'once', months: 12, minDy: 5 }, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
];
const MANY_PLANS = [
  ...PLANS,
  ...['金融三傻', '消费白马', '高股息五只', '公用事业', '能源老登'].map((name, i) => ({
    id: 'p-e2e-x' + i, name, capital: 1000000,
    holdings: [{ code: ['601318', '600887', '600941', '600066', '601398'][i], weight: 100 }],
    entry: { mode: 'once', months: 12, minDy: 5 }, createdAt: '2026-01-01', updatedAt: '2026-01-01',
  })),
];

/* 页面 ensureDividends() 会把 data/div/<code>.json 的逐笔派息明细（ev）合进 dividends，
   引擎按真实除权除息日入账。这里必须同样补上，否则期望值会退回「每年 4 月末」的老口径。 */
{
  const all = [...new Set([
    ...LEDGER.map((t) => t.code),
    ...PLANS.flatMap((p) => p.holdings.map((h) => h.code)),
    ...MANY_PLANS.flatMap((p) => p.holdings.map((h) => h.code)),
  ])];
  for (const c of all) {
    try {
      const d = readJson('div/' + c + '.json');
      if (d && Array.isArray(d.ev) && d.ev.length) dividends[c] = { ...dividends[c], ev: d.ev };
    } catch (e) { /* 没有明细的股票走老口径兜底 */ }
  }
}

/* ---------- Node 侧期望值（与页面同口径，独立重算） ---------- */
function addYears(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}
function buildDates(from, to) {
  const set = new Set();
  for (const [d] of indexDaily.h00922.rows) if (d >= from && d <= to) set.add(d);
  for (const d of dailyCal) if (d >= from && d <= to) set.add(d);
  return [...set].sort();
}
function seriesOf(code) {
  const daily = readJson('daily/' + code + '.json');
  return buildSeries({ cal: dailyCal, daily: { ...daily, cal: dailyCal }, monthly: months[code] });
}
function benchRows(from, to) {
  const rows = indexDaily.h00922.rows.filter(([d]) => d >= from && d <= to);
  const last = rows.length ? rows[rows.length - 1][0] : '';
  for (const [ym, v] of Object.entries(benchmarkMonthly || {})) {
    const d = monthEnd(ym);
    if (d > last && d <= to && v > 0) rows.push([d, v]);
  }
  return rows;
}

const dates = buildDates(FROM, TO);
const codes = [...new Set([...LEDGER.map((t) => t.code), ...PLANS.flatMap((p) => p.holdings.map((h) => h.code)), ...MANY_PLANS.flatMap((p) => p.holdings.map((h) => h.code))])];
const series = new Map(codes.map((c) => [c, seriesOf(c)]));
const bench = benchRows(FROM, TO);
const lowVol = indexDaily.h30269.rows.filter(([d]) => d >= FROM && d <= TO);

// 当前持仓（与页面 structure() 同口径：买入聚合、最新价权重、现金）
const pos = new Map();
for (const t of LEDGER) pos.set(t.code, (pos.get(t.code) || 0) + t.shares);
const total = CASH + [...pos].reduce((s, [code, sh]) => s + sh * (quotes[code]?.p || 0), 0);
const holdings = [...pos].map(([code, shares]) => ({ code, shares, weight: (shares * (quotes[code]?.p || 0)) / total * 100 }));
const holdingsW = holdings.map((h) => ({ code: h.code, weight: h.weight }));
const lots = holdings.map((h) => ({ code: h.code, shares: h.shares }));

const run = (opts) => runPortfolioBacktest({
  dates, series, dividends, from: FROM, to: TO, monthlyAdd: 0,
  benchmarkSeries: bench, lowVolSeries: lowVol,
  ...opts,
});

const invest100 = run({ holdings: holdingsW, capital: 1000000, mode: 'invest', entry: { mode: 'once' } });
const invest50 = run({ holdings: holdingsW, capital: 500000, mode: 'invest', entry: { mode: 'once' } });
// 独立公式：持仓回放起点 = 现金 + 当前股数 × 起点价
const startValue = CASH + lots.reduce((s, l) => s + l.shares * (priceAt(series.get(l.code), dates[0]) || 0), 0);
const replay = run({ holdings: holdingsW, capital: startValue || 1000000, mode: 'replay', lots, cash0: CASH, entry: { mode: 'once' } });
const planRuns = PLANS.map((p) => ({ plan: p, r: run({ holdings: p.holdings, capital: 500000, mode: 'invest', entry: { mode: 'once' } }) }));
const expected = {
  invest100: { end: bigMoney(invest100.end), totalIn: bigMoney(1000000), cagr: pctSign(invest100.stats.cagr * 100, 1), mdd: pct(invest100.stats.mdd * 100, 1) },
  invest50: { end: bigMoney(invest50.end), totalIn: bigMoney(500000), cagr: pctSign(invest50.stats.cagr * 100, 1), mdd: pct(invest50.stats.mdd * 100, 1) },
  // 对比表回撤列是 0 位小数（指标卡 1 位），两种口径分开算
  invest50mdd0: pct(invest50.stats.mdd * 100, 0),
  invest100mdd0: pct(invest100.stats.mdd * 100, 0),
  replay: { start: bigMoney(replay.totalIn), end: bigMoney(replay.end), cagr: pctSign(replay.stats.cagr * 100, 1), mdd: pct(replay.stats.mdd * 100, 1) },
  startValue,
  bench50: { end: bigMoney(invest50.bench.end), cagr: pctSign(invest50.bench.cagr * 100, 1), mdd: pct(maxDrawdown(invest50.bench.rows).mdd * 100, 0) },
  lowVol50: { end: bigMoney(invest50.lowVol.end), cagr: pctSign(invest50.lowVol.cagr * 100, 1), mdd: pct(maxDrawdown(invest50.lowVol.rows).mdd * 100, 0) },
  plans50: planRuns.map(({ plan, r }) => ({
    name: plan.name, end: bigMoney(r.end), cagr: pctSign(r.stats.cagr * 100, 1),
    mdd: pct(r.stats.mdd * 100, 0), div: bigMoney(r.totalDiv),
  })),
};

/* ---------- CDP ---------- */
const errors = [];
const { send, evalJs, waitFor, clearStorage, close } = await cdpConnect({
  onEvent: (m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  },
});
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/* 清掉这个站点的 SW / IndexedDB 行情缓存：页面「今天」取的是行情里最新的 date，
   缓存把行情推到第二天，末值就会和 Node 侧按快照日算的期望差一两个交易日。 */
await clearStorage(SITE.replace(/\/[^/]*$/, ''));

const BASE = SITE + (SITE.includes('?') ? '&' : '?') + 'offline=1&nosw=1&theme=dark';
let navSeq = 0;
const failures = [];
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ' ' + detail : ''));
};

const seed = (txs, cash, plans) => evalJs(`(() => {
  localStorage.setItem('d3:txs', ${JSON.stringify(JSON.stringify(txs))});
  localStorage.setItem('d3:cash', ${JSON.stringify(JSON.stringify(cash))});
  localStorage.setItem('d3:plans', ${JSON.stringify(JSON.stringify(plans))});
  return true;
})()`);

const goto = async (hash) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 加个自增参数：只改 hash 的 Page.navigate 是「同文档导航」，不会重载模块，
    // 上一场景的 btState（mode/planId/capital）会串到下一场景。
    await send('Page.navigate', { url: BASE + '&r=' + (++navSeq) + hash });
    await sleep(300);
    try {
      await waitFor(`document.readyState === 'complete' && (document.getElementById('app')?.children.length || 0) > 0`, '页面就绪 ' + hash, 8000);
      await waitFor(`!!document.querySelector('.page-title')`, '页面标题 ' + hash, 8000);
      return;
    } catch (e) {
      // 快速连续导航偶尔会停在空白文档：重试
      if (attempt === 3) throw e;
    }
  }
};

const portState = async () => JSON.parse(await evalJs(`JSON.stringify({
  kicker: document.querySelector('.hero-kicker')?.textContent || '',
  desc: document.querySelector('.hero-desc')?.textContent || '',
  cards: [...document.querySelectorAll('.bt-metrics .bt-metric')].map((el) => ({
    k: (el.querySelector('.k')?.textContent || '').trim(),
    v: (el.querySelector('.v')?.textContent || '').trim(),
  })),
  canvas: document.querySelectorAll('canvas').length,
})`));
const cardMap = (cards) => Object.fromEntries(cards.map((c) => [norm(c.k), norm(c.v)]));

const readCompare = async () => JSON.parse(await evalJs(`(() => {
  // 页面上有多张表（交易流水/年度表等），按表头第一列「组合」定位指标对比表
  const table = [...document.querySelectorAll('table.table')]
    .find((t) => (t.querySelector('thead th')?.textContent || '').trim() === '组合');
  return JSON.stringify({
  hash: location.hash,
  // 单元格带 data-v 时用它：回撤格里除数字外还有「几个月修复」的小字，改文案不该让断言挂
  rows: table ? [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.dataset.v || td.textContent.replace(/\\s+/g, ' ').trim())) : [],
  canvas: !!document.querySelector('#cmpChart canvas'),
  text: (document.getElementById('app') || {}).innerText || '',
  banner: [...document.querySelectorAll('.banner.warn')].map((b) => b.textContent.trim()).join(' | '),
  });
})()`));

/* ---------- 1. 投入回测 ---------- */
await goto('#today');
await seed(LEDGER, CASH, PLANS);
await goto('#backtest');
await waitFor(`document.querySelectorAll('.hero-kicker').length === 1`, '回测页渲染');
await waitFor(`document.querySelectorAll('canvas').length >= 3`, '图表懒加载完成', 20000);

let st = await portState();
check('默认进入投入回测', norm(st.kicker).includes('投入回测'), norm(st.kicker).slice(0, 60));
let cm = cardMap(st.cards);
check('累计投入 = 100 万', cm['累计投入'] === expected.invest100.totalIn, `页面 ${cm['累计投入']} / 期望 ${expected.invest100.totalIn}`);
check('总市值与引擎一致', cm['总市值'] === expected.invest100.end, `页面 ${cm['总市值']} / 期望 ${expected.invest100.end}`);
check('年化与引擎一致', cm['年化'] === expected.invest100.cagr, `页面 ${cm['年化']} / 期望 ${expected.invest100.cagr}`);
check('最大回撤与引擎一致', cm['最大回撤'] === expected.invest100.mdd, `页面 ${cm['最大回撤']} / 期望 ${expected.invest100.mdd}`);
check('hero 期末金额与引擎一致', norm(st.desc).includes('期末 ' + expected.invest100.end), norm(st.desc).slice(0, 70));

/* ---------- 2. 持仓回放 ---------- */
await evalJs(`document.querySelector('[data-portmode="replay"]').click()`);
await waitFor(`[...document.querySelectorAll('.hero-kicker')].some((e) => e.textContent.includes('持仓回放'))`, '持仓回放渲染');
st = await portState();
cm = cardMap(st.cards);
check('切到持仓回放', norm(st.kicker).includes('持仓回放'), norm(st.kicker).slice(0, 60));
check('起点市值 = 现金 + 股数×起点价', cm['起点市值'] === expected.replay.start, `页面 ${cm['起点市值']} / 期望 ${expected.replay.start}（${Math.round(expected.startValue)} 元）`);
check('回放总市值与 replay 引擎一致', cm['总市值'] === expected.replay.end, `页面 ${cm['总市值']} / 期望 ${expected.replay.end}`);
check('回放年化与 replay 引擎一致', cm['年化'] === expected.replay.cagr, `页面 ${cm['年化']} / 期望 ${expected.replay.cagr}`);
check('回放最大回撤与 replay 引擎一致', cm['最大回撤'] === expected.replay.mdd, `页面 ${cm['最大回撤']} / 期望 ${expected.replay.mdd}`);

/* ---------- 3. 切回投入 + 改本金 50 万重跑 ---------- */
await evalJs(`document.querySelector('[data-portmode="invest"]').click()`);
await waitFor(`[...document.querySelectorAll('.hero-kicker')].some((e) => e.textContent.includes('投入回测'))`, '切回投入回测');
await evalJs(`document.getElementById('btCap').value = '50'; document.getElementById('btRun').click();`);
await sleep(500);
await waitFor(`!!document.querySelector('.hero-kicker') && document.querySelectorAll('.bt-metric').length > 0`, '50 万重跑完成');
st = await portState();
cm = cardMap(st.cards);
check('改本金后累计投入 = 50 万', cm['累计投入'] === expected.invest50.totalIn, `页面 ${cm['累计投入']} / 期望 ${expected.invest50.totalIn}`);
check('改本金后总市值与引擎一致', cm['总市值'] === expected.invest50.end, `页面 ${cm['总市值']} / 期望 ${expected.invest50.end}`);
check('改本金后年化与引擎一致', cm['年化'] === expected.invest50.cagr, `页面 ${cm['年化']} / 期望 ${expected.invest50.cagr}`);

/* ---------- 4. 组合对比 ---------- */
await evalJs(`document.querySelector('[data-btmode="cmp"]').click()`);
await waitFor(`!!document.querySelector('#cmpChart')`, '对比页渲染');
await waitFor(`!!document.querySelector('#cmpChart canvas')`, '对比图绘制', 20000);
await sleep(300);
let cmp = await readCompare();
check('tab 切换后 URL 带 mode=cmp', cmp.hash.includes('mode=cmp'), cmp.hash);
check('对比表 6 行（持仓 + 2 方案 + 策略 + 2 指数）', cmp.rows.length === 6, `实际 ${cmp.rows.length} 行：${cmp.rows.map((r) => r[0]).join(' / ')}`);
check('对比图已画出（echarts 按需加载）', cmp.canvas, cmp.canvas ? '' : '没有 #cmpChart canvas');

const rowByName = (rows, name) => rows.find((r) => norm(r[0]).includes(name));
const cur = rowByName(cmp.rows, '当前持仓');
check('当前持仓行：期末与引擎一致', cur && norm(cur[1]) === expected.invest50.end, cur ? `页面 ${cur[1]} / 期望 ${expected.invest50.end}` : '缺行');
check('当前持仓行：年化与引擎一致', cur && norm(cur[2]) === expected.invest50.cagr, cur ? `页面 ${cur[2]} / 期望 ${expected.invest50.cagr}` : '缺行');
check('当前持仓行：最大回撤与引擎一致', cur && norm(cur[3]) === expected.invest50mdd0, cur ? `页面 ${cur[3]} / 期望 ${expected.invest50mdd0}` : '缺行');
for (const exp of expected.plans50) {
  const row = rowByName(cmp.rows, exp.name);
  check(`方案「${exp.name}」行存在且期末一致`, !!row && norm(row[1]) === exp.end, row ? `页面 ${row[1]} / 期望 ${exp.end}` : '缺行');
  check(`方案「${exp.name}」年化/回撤/分红一致`, !!row && norm(row[2]) === exp.cagr && norm(row[3]) === exp.mdd && norm(row[4]) === exp.div,
    row ? `页面 ${row[2]} | ${row[3]} | ${row[4]} / 期望 ${exp.cagr} | ${exp.mdd} | ${exp.div}` : '缺行');
}
const benchRow = rowByName(cmp.rows, '中证红利全收益');
check('中证红利全收益行：期末/年化/回撤一致', !!benchRow && norm(benchRow[1]) === expected.bench50.end && norm(benchRow[2]) === expected.bench50.cagr && norm(benchRow[3]) === expected.bench50.mdd,
  benchRow ? `页面 ${benchRow[1]} | ${benchRow[2]} | ${benchRow[3]} / 期望 ${expected.bench50.end} | ${expected.bench50.cagr} | ${expected.bench50.mdd}` : '缺行');
const lowVolRow = rowByName(cmp.rows, '红利低波全收益');
check('红利低波全收益行：期末/年化/回撤一致', !!lowVolRow && norm(lowVolRow[1]) === expected.lowVol50.end && norm(lowVolRow[2]) === expected.lowVol50.cagr && norm(lowVolRow[3]) === expected.lowVol50.mdd,
  lowVolRow ? `页面 ${lowVolRow[1]} | ${lowVolRow[2]} | ${lowVolRow[3]} / 期望 ${expected.lowVol50.end} | ${expected.lowVol50.cagr} | ${expected.lowVol50.mdd}` : '缺行');
const ruleRow = rowByName(cmp.rows, '红利精选');
check('红利精选行存在且数值有效', !!ruleRow && norm(ruleRow[1]) !== '—' && !/NaN|Infinity|undefined/.test(norm(ruleRow[1])), ruleRow ? norm(ruleRow[1]) : '缺行');

/* ---------- 5. 方案很多时基准行不能被挤掉 ---------- */
await seed(LEDGER, CASH, MANY_PLANS);
await goto('#backtest');
await waitFor(`document.querySelectorAll('.hero-kicker').length === 1`, '多方案回测页');
await evalJs(`document.querySelector('[data-btmode="cmp"]').click()`);
await waitFor(`!!document.querySelector('#cmpChart')`, '多方案对比页渲染');
cmp = await readCompare();
const names = cmp.rows.map((r) => norm(r[0]));
check('7 个方案时对比表仍保留策略/两条指数行', names.some((n) => n.includes('红利精选')) && names.some((n) => n.includes('中证红利全收益')) && names.some((n) => n.includes('红利低波全收益')),
  `行：${names.join(' / ')}`);
check('7 个方案时最多 8 行（方案 5 个 + 策略/指数 3 行）', cmp.rows.length === 8, `实际 ${cmp.rows.length} 行`);

/* ---------- 6. 空账本（演示持仓）不崩 ---------- */
await seed([], 0, PLANS);
await goto('#backtest');
await waitFor(`document.querySelectorAll('.hero-kicker').length === 1`, '空账本回测页');
await waitFor(`document.querySelectorAll('canvas').length >= 3`, '空账本图表懒加载完成', 20000);
await evalJs(`document.querySelector('[data-portmode="replay"]').click()`);
await sleep(600);
st = await portState();
cm = cardMap(st.cards);
const replayText = JSON.stringify(st);
check('空账本持仓回放不崩、无 NaN/Infinity/undefined', !/NaN|Infinity|undefined/.test(replayText), norm(st.kicker).slice(0, 60));
check('空账本回放仍显示起点市值一行', !!cm['起点市值'], cm['起点市值'] || '缺行');

/* ---------- 7. 用户真实路径回归（补上以前抓不到的坑） ----------
   前面几组都自己构造 dividends 并注入 ev，绕过了真实数据加载路径，
   所以下面这三种「用户一定会走」的路坏了也抓不到。 */

// 7a. 先看个股页（只加载 1 只分红）→ 再进今天页：分红索引缓存必须失效，候选不能塌成 0
await seed(LEDGER, CASH, PLANS);
await goto('#stock?code=000001');
await waitFor(`!!document.querySelector('.page-title')`, '个股页渲染');
await goto('#today');
await waitFor(`/可买 \\d+/.test(document.querySelector('.hero-kicker')?.textContent || '')`, '今天页候选统计', 20000);
const todayKicker = norm(await evalJs(`document.querySelector('.hero-kicker')?.textContent || ''`));
const buyN = Number((todayKicker.match(/可买 (\d+)/) || [])[1] || 0);
check('先看个股再进今天页：候选不塌成 0', buyN >= 30, `${todayKicker}（可买 ${buyN} 只；塌成 0 = divIndex 缓存没失效）`);

// 7b. 今天页（全量分红已灌，但那份只有 years、没有 ev）→ 回测个股：分红必须真的算进去
await goto('#backtest?mode=stock&code=600036');
await waitFor(`!!document.querySelector('.hero-kicker')`, '个股回测渲染');
await sleep(2000);
const stockHero = norm(await evalJs(`document.querySelector('.hero')?.innerText.replace(/\\s+/g, ' ') || ''`));
const divM = stockHero.match(/分红\s*([\d.]+)\s*万/);
const divWan = divM ? Number(divM[1]) : 0;
check('经由今天页进个股回测：分红被算进去（不是 0）', divWan > 50, `分红 ${divWan} 万——0 说明只拿到 years、没拿到 ev`);
check('经由今天页进个股回测：没有假报「没取到派息明细」', !/没取到.*派息明细|没有派息明细/.test(stockHero), stockHero.slice(0, 80));

// 7c. 组合回测开月追加：年化不能虚高（现金流符号曾记反，20000/月 显示 +38.6%，真值 +9.8%）
await goto('#backtest');
await waitFor(`document.querySelectorAll('.hero-kicker').length === 1`, '回测页（定投回归）');
await evalJs(`document.getElementById('btMon').value = '20000'; document.getElementById('btRun').click();`);
await sleep(600);
await waitFor(`document.querySelectorAll('.bt-metric').length > 0`, '定投重跑完成', 20000);
await sleep(800);
const addHero = norm(await evalJs(`document.querySelector('.hero')?.innerText.replace(/\\s+/g, ' ') || ''`));
const cagrM = addHero.match(/年化\s*([+-][\d.]+)%/);
const cagrN = cagrM ? Number(cagrM[1]) : NaN;
check('月追加 2 万：年化落在合理区间（现金流符号没记反）', cagrN > 3 && cagrN < 20, `年化 ${cagrN}%；虚高到 30%+ 说明追加资金被记成了流入`);

check('全程无 console.error / 未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));

close();
console.log('');
if (failures.length) {
  console.log(`✗ 回测页组合对比/持仓回放检查失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('✓ 回测页组合对比 / 持仓回放端到端检查全部通过');
process.exit(0);
