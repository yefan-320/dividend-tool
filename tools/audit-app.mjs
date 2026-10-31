#!/usr/bin/env node
/**
 * 数据 + 引擎体检：跑一遍全量数据的一致性检查，输出 report/AUDIT-APP.md。
 * 运行：node tools/audit-app.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

const quotes = read('quotes.json');
const baseline = read('baseline.json');
const monthly = read('monthly.json').months;
const finCur = read('finance-current.json');
const finHist = read('finance-history.json').data;
const bench = read('benchmark.json').bench;
const idx = read('index-daily.json');
const dailyMeta = read('daily/meta.json');

const issues = [];
const stats = {};
const push = (level, text) => { if (level !== 'ok') issues.push({ level, text }); };

/* 1. 覆盖 */
stats.quotes = Object.keys(quotes.quotes || {}).length;
stats.divs = Object.keys(baseline.dividends || {}).length;
stats.pool = Object.keys(baseline.pool || {}).length;
stats.finCurrent = Object.keys(finCur.data || {}).length;
stats.finHistory = Object.keys(finHist || {}).length;
stats.monthly = Object.keys(monthly).length;
stats.dailyFiles = dailyMeta.cal ? fs.readdirSync(path.join(DATA, 'daily')).filter((f) => /^\d{6}\.json$/.test(f)).length : 0;
stats.bench = Object.keys(bench).length;
stats.dailyCal = dailyMeta.cal.length;
stats.dailyRange = dailyMeta.cal[0] + ' ~ ' + dailyMeta.cal.at(-1);

/* 2. 行情时点 */
const dateCount = new Map();
for (const q of Object.values(quotes.quotes || {})) dateCount.set(q.date, (dateCount.get(q.date) || 0) + 1);
stats.quoteDates = [...dateCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
const stale = [...dateCount.entries()].filter(([d]) => d < (quotes.generated || '')).reduce((s, [, n]) => s + n, 0);
if (stale > stats.quotes * 0.01) push('warn', `行情有 ${stale} 只不是最新时点（${quotes.generated}）`);

/* 3. 股息率分布 + 异常值 */
const rows = [];
for (const [code, info] of Object.entries(baseline.pool || {})) {
  const q = quotes.quotes?.[code];
  if (!q?.p) continue;
  const years = baseline.dividends?.[code]?.years || {};
  const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
  if (!ys.length) continue;
  const dps = years[ys[ys.length - 1]];
  rows.push({ code, name: info.n || code, dy: dps / q.p * 100, dps, lastY: ys[ys.length - 1], price: q.p, st: /ST|退/.test(info.n || '') });
}
stats.dyRows = rows.length;
const buckets = { '<=0': 0, '0-2': 0, '2-4': 0, '4-6': 0, '6-10': 0, '10-15': 0, '>15': 0 };
for (const r of rows) {
  if (r.dy <= 0) buckets['<=0']++;
  else if (r.dy < 2) buckets['0-2']++;
  else if (r.dy < 4) buckets['2-4']++;
  else if (r.dy < 6) buckets['4-6']++;
  else if (r.dy < 10) buckets['6-10']++;
  else if (r.dy < 15) buckets['10-15']++;
  else buckets['>15']++;
}
stats.dyBuckets = buckets;
const abnormal = rows.filter((r) => r.dy > 15 && !r.st);
stats.abnormalDy = abnormal.length;
if (abnormal.length > rows.length * 0.02) push('warn', `有 ${abnormal.length} 只非 ST 股息率 >15%，前端默认已剔除`);
const topAbnormal = abnormal.sort((a, b) => b.dy - a.dy).slice(0, 8);
stats.topAbnormal = topAbnormal.map((r) => `${r.name}(${r.code}) 股息率 ${r.dy.toFixed(1)}% 分红 ${r.dps} 现价 ${r.price}`);

/* 3.5 数据拆分一致性：finance-core / finance-extra 必须与 finance-current 同覆盖、同口径 */
try {
  const core = read('finance-core.json');
  const extra = read('finance-extra.json');
  const full = finCur.data || {};
  const fullCodes = Object.keys(full);
  const r4 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
  const r0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  let mismatched = 0;
  for (const code of fullCodes) {
    const c = core.data?.[code];
    const e = extra.data?.[code];
    const a = full[code] || [];
    if (!c || !e) { mismatched++; continue; }
    if (r4(a[0]) !== c[0] || r4(a[1]) !== c[1] || r4(a[4]) !== c[2]) { mismatched++; continue; }
    if (r4(a[2]) !== e[0] || r4(a[3]) !== e[1] || r0(a[5]) !== e[2]) mismatched++;
  }
  stats.finSplit = { core: Object.keys(core.data || {}).length, extra: Object.keys(extra.data || {}).length, mismatched };
  if (stats.finSplit.core !== fullCodes.length) push('warn', `finance-core 覆盖 ${stats.finSplit.core} ≠ finance-current ${fullCodes.length}，需重跑 build-slim-data`);
  if (mismatched) push('warn', `finance-core/extra 与 finance-current 有 ${mismatched} 只不一致，需重跑 build-slim-data`);
} catch (e) {
  push('warn', 'finance-core/extra 缺失或损坏：' + e.message);
}

/* 4. 分红数据 sanity */
let maxDps = 0, maxDpsCode = '', futureYears = 0;
for (const [code, d] of Object.entries(baseline.dividends || {})) {
  for (const [y, v] of Object.entries(d.years || {})) {
    if (!(v > 0)) continue;
    if (v > maxDps) { maxDps = v; maxDpsCode = code; }
    if (+y > 2026) futureYears++;
  }
}
stats.maxDps = maxDps + ' (' + maxDpsCode + ')';
if (futureYears) push('warn', `分红里有 ${futureYears} 条年份 >2026`);
if (maxDps > 500) push('warn', `单股分红最大值 ${maxDps} 元，疑似单位问题`);

/* 5. 日 K（现在只常驻演示持仓；其余按需联网）与月线一致性 */
const keptDaily = fs.readdirSync(path.join(DATA, 'daily')).filter((f) => /^\d{6}\.json$/.test(f));
const keptCodes = keptDaily.map((f) => f.replace('.json', ''));
stats.dailyKept = keptDaily.length;
stats.dailyMode = '演示持仓常驻 + 其余按需联网（腾讯 newfqkline，IndexedDB 缓存）';
let dailyNoMonthly = 0, monthlyNoDaily = 0;
for (const code of keptCodes) if (!monthly[code]) dailyNoMonthly++;
for (const code of Object.keys(monthly)) if (!keptDaily.includes(code + '.json')) monthlyNoDaily++;
stats.dailyNoMonthly = dailyNoMonthly;
stats.monthlyNoDaily = monthlyNoDaily;
let mismatch = [];
let checked = 0;
for (const r of rows.slice(0, 30)) {
  const f = path.join(DATA, 'daily', r.code + '.json');
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const closes = j.c.filter((v) => v != null);
  if (!closes.length) continue;
  checked++;
  const last = closes[closes.length - 1];
  if (Math.abs(last / r.price - 1) > 0.02) mismatch.push(`${r.code} 日K ${last} vs 行情 ${r.price}`);
}
stats.dailyQuoteChecked = checked;
if (mismatch.length) push('warn', `日 K 与行情现价偏差 >2%：${mismatch.slice(0, 5).join('; ')}`);

/* 6. 未上市/次新（按月线首月判断；回测里走「未上市建仓」逻辑） */
const unlisted = [];
for (const [code, rows2] of Object.entries(monthly)) {
  if (!rows2.length) continue;
  const first = rows2[0][0] + '-01';
  if (first > '2018-01-01') unlisted.push({ code, name: baseline.pool?.[code]?.n || code, first });
}
stats.listedAfter2018Monthly = unlisted.length;
stats.unlistedSample = unlisted.slice(0, 6).map((x) => `${x.name}(${x.code}) ${x.first}`);

/* 7. 基准 */
const h922 = idx.h00922.rows;
stats.benchRange = h922[0][0] + ' ~ ' + h922.at(-1)[0] + ' · ' + h922.length + ' 天';
stats.benchMonthly = stats.bench;
if (h922.length < 5000) push('warn', '基准日线不足 5000 天');
const lastIdx = h922.at(-1)[0];
const benchLast = Object.keys(bench).sort().at(-1);
if (benchLast < lastIdx.slice(0, 7)) push('warn', '基准月线落后于日线');

/* 8. 引擎 sanity */
const { runPortfolioBacktest } = await import('../src/engine/portfolioBacktest.js');
const { buildSeries, buildTradingDates } = await import('../src/engine/market.js');
const codes = ['600941', '000333', '600036', '601398', '600066', '601318', '600887'];
const series = new Map();
for (const c of codes) {
  const j = read('daily/' + c + '.json');
  series.set(c, buildSeries({ cal: dailyMeta.cal, daily: { cal: dailyMeta.cal, ...j }, monthly: monthly[c] }));
}
const from = '2016-10-30', to = dailyMeta.cal.at(-1);
const dates = buildTradingDates({ indexRows: h922, dailyCal: dailyMeta.cal, monthly, from, to });
const benchRows = h922.filter(([d]) => d >= from && d <= to);
const r = runPortfolioBacktest({
  dates, series, dividends: baseline.dividends,
  holdings: codes.map((c) => ({ code: c, weight: 100 / codes.length })),
  capital: 1000000, monthlyAdd: 0, from, to, mode: 'invest', benchmarkSeries: benchRows,
});
stats.engine = {
  nav0: Math.round(r.nav[0][1]), end: Math.round(r.end), cagr: +(r.stats.cagr * 100).toFixed(2),
  mdd: +(r.stats.mdd * 100).toFixed(1), div: Math.round(r.totalDiv),
  builds: r.builds.map((b) => `${b.code} ${b.date} ${b.shares}股`),
};
if (Math.abs(r.nav[0][1] - 1000000) > 1) push('error', '组合回测起点净值不等于本金');
if (!Number.isFinite(r.end) || r.end <= 0) push('error', '组合回测期末净值异常');

/* 9. 报告 */
const md = `# 数据 + 引擎体检（自动生成）

> 运行：\`node tools/audit-app.mjs\` · 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}

## 覆盖

| 数据 | 数量 |
|---|---|
| 股票池 | ${stats.pool} |
| 最新行情 | ${stats.quotes}（${quotes.generated}） |
| 分红历史 | ${stats.divs} |
| 当前财报 | ${stats.finCurrent} |
| 历史财报 | ${stats.finHistory} |
| 月线 | ${stats.monthly} |
| 日 K 常驻 | ${stats.dailyKept} 只（演示持仓，离线兜底）；其余按需联网 |
| 基准月线 | ${stats.bench} 个月（${stats.benchRange.split(' · ')[0]}） |

## 股息率分布（全市场有股息率数据的 ${stats.dyRows} 只）

| 区间 | 只数 |
|---|---|
${Object.entries(stats.dyBuckets).map(([k, v]) => `| ${k}% | ${v} |`).join('\n')}

- 非 ST 且股息率 >15% 的异常值：**${stats.abnormalDy}** 只（前端默认剔除）
- 样例：${stats.topAbnormal.join('；') || '无'}

## 一致性

- 行情最新时点：${stats.quoteDates.map(([d, n]) => `${d}(${n})`).join(' · ')}
- 日 K 常驻：${stats.dailyKept} 只（${stats.dailyMode}）
- 月线有、日 K 常驻无（走按需联网）：${stats.monthlyNoDaily} 只
- 2018 年后上市/次新：${stats.listedAfter2018Monthly} 只（回测里会走「未上市建仓」逻辑）
- 样例：${stats.unlistedSample.join('；')}
- 常驻日 K 与最新行情抽查：${stats.dailyQuoteChecked} 只，偏差 >2%：${mismatch.length}
- 单股最大年度分红：${stats.maxDps}

## 基准

- 中证红利全收益日线：${stats.benchRange}
- 月线：${stats.benchMonthly} 个月
- 低波全收益：${idx.h30269.rows.length} 天（${idx.h30269.rows[0][0]} ~ ${idx.h30269.rows.at(-1)[0]}）

## 引擎回测自检（7 只等权，2016-10 → 2026-10）

| 指标 | 值 |
|---|---|
| 起点净值 | ${stats.engine.nav0} |
| 期末 | ${stats.engine.end} |
| 年化 | ${stats.engine.cagr}% |
| 最大回撤 | ${stats.engine.mdd}% |
| 累计分红 | ${stats.engine.div} |
| 未上市建仓 | ${stats.engine.builds.join(' · ')} |

## 问题

${issues.length ? issues.map((i) => `- [${i.level}] ${i.text}`).join('\n') : '- 无（全部检查通过）'}
`;
const reportDir = path.join(ROOT, '..', 'report');
fs.mkdirSync(reportDir, { recursive: true });
const out = path.join(reportDir, 'AUDIT-APP.md');
fs.writeFileSync(out, md);
fs.writeFileSync(path.join(reportDir, 'audit-app.json'), JSON.stringify({ stats, issues }, null, 2));
console.log(JSON.stringify(stats, null, 2));
console.log('\n问题：', issues.length ? issues : '无');
console.log('→ report/AUDIT-APP.md');
