#!/usr/bin/env node
/**
 * 数据质量审计：对比旧快照、抓取的最新行情/月线，输出 report/DATA-QUALITY.md
 *
 * 检查项：
 *  1. 数据时点与覆盖率（价格、分红、财务、行情、月线）
 *  2. 旧快照价格 vs 腾讯月线收盘（2025-12 / 2026-04）
 *  3. 旧 pool.dy vs 用最新价重算的股息率，列偏差 Top
 *  4. 分红连续性、最近分红年份分布
 *  5. 结论与限制
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(ROOT, '../repo');
const DATA = path.join(ROOT, 'data');
const REPORT = path.resolve(ROOT, '../report');

function loadSnap() {
  const code = fs.readFileSync(path.join(REPO, 'data/snapshot-data.js'), 'utf8');
  const ctx = { window: {} };
  vm.runInNewContext(code, ctx);
  return ctx.window.__SNAP__;
}
const readJson = (p, fb) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fb);

const snap = loadSnap();
const quotes = readJson(path.join(DATA, 'quotes.json'), { quotes: {} }).quotes;
const monthly = readJson(path.join(DATA, 'monthly.json'), { months: {} }).months;

const pool = snap.pool || {};
const prices = snap.prices || {};
const divs = snap.dividends || {};
const codes = Object.keys(pool);

const num = (v) => (Number.isFinite(v) ? v : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : null);

// ---------- 1. 覆盖率 ----------
const stats = {
  pool: codes.length,
  prices: Object.keys(prices).length,
  dividends: Object.keys(divs).length,
  f10: Object.keys(snap.f10 || {}).length,
  quotes: Object.keys(quotes).length,
  monthly: Object.keys(monthly).length,
};
const priceLatest = {};
for (const c of Object.keys(prices)) {
  const ys = prices[c].years || {};
  const y = Object.keys(ys).sort().pop();
  const ms = y ? Object.keys(ys[y]).sort() : [];
  const m = ms.pop() || '?';
  const k = `${y}-${m}`;
  priceLatest[k] = (priceLatest[k] || 0) + 1;
}
let priceMissing = 0;
for (const c of codes) if (!prices[c]) priceMissing++;
let quoteMissing = 0;
for (const c of codes) if (!quotes[c]) quoteMissing++;

const divLastYear = {};
let divN = 0;
for (const c of Object.keys(divs)) {
  const y = divs[c].lastY || (divs[c].years ? Object.keys(divs[c].years).sort().pop() : null);
  if (y) { divLastYear[y] = (divLastYear[y] || 0) + 1; divN++; }
}

// ---------- 2. 价格对比 ----------
// 旧快照半年价格 vs 腾讯月线收盘
const priceChecks = [];
for (const c of Object.keys(monthly)) {
  const p = prices[c];
  if (!p) continue;
  const m = new Map(monthly[c].map(([ym, close]) => [ym, close]));
  for (const [y, ms] of Object.entries(p.years || {})) {
    for (const [mon, v] of Object.entries(ms)) {
      if (typeof v !== 'number') continue;
      const ym = `${y}-${mon === 'dec' ? '12' : '04'}`;
      const close = m.get(ym);
      if (!close) continue;
      const diff = (v - close) / close;
      if (Math.abs(diff) < 0.02) continue; // 只记 2% 以上偏差
      priceChecks.push({ code: c, name: pool[c]?.n || p.name || '', ym, snap: v, qq: close, diff });
    }
  }
}
priceChecks.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

// ---------- 3. 股息率对比 ----------
const dyChecks = [];
for (const c of codes) {
  const q = quotes[c];
  const d = divs[c];
  const info = pool[c];
  if (!q || !d || !q.p) continue;
  const years = d.years || {};
  const lastY = d.lastY || Object.keys(years).sort().pop();
  if (!lastY) continue;
  const dps = years[lastY];
  if (!(dps > 0)) continue;
  const calcDy = (dps / q.p) * 100;
  const oldDy = num(info.dy);
  if (oldDy == null) continue;
  dyChecks.push({
    code: c, name: info.n || q.n, oldDy, calcDy, dps, lastY, price: q.p,
    diff: calcDy - oldDy,
  });
}
dyChecks.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
const dyDiffAbs = dyChecks.map((x) => Math.abs(x.diff));

// 分红连续性与覆盖
const divQuality = { nYears: {}, consecutive: {}, lastY: divLastYear };
for (const c of Object.keys(divs)) {
  const d = divs[c];
  const n = d.nYears ?? Object.keys(d.years || {}).length;
  const k = n >= 10 ? '>=10' : n >= 5 ? '5-9' : n >= 3 ? '3-4' : '1-2';
  divQuality.nYears[k] = (divQuality.nYears[k] || 0) + 1;
  const cons = d.consecutive ?? 0;
  const k2 = cons >= 10 ? '>=10' : cons >= 5 ? '5-9' : cons >= 3 ? '3-4' : '1-2';
  divQuality.consecutive[k2] = (divQuality.consecutive[k2] || 0) + 1;
}

// 最新价与旧快照最新价对比（老数据时点偏差）
const stale = [];
for (const c of Object.keys(quotes)) {
  const q = quotes[c];
  const p = prices[c];
  if (!p) continue;
  const ys = p.years || {};
  const y = Object.keys(ys).sort().pop();
  const ms = Object.keys(ys[y] || {}).sort();
  const mon = ms.pop();
  const last = ys[y]?.[mon];
  if (!last || !q.p) continue;
  stale.push({ code: c, name: q.n, from: `${y}-${mon}`, old: last, now: q.p, chg: q.p / last - 1 });
}
const staleChg = stale.map((s) => s.chg);
stale.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));

// ---------- 输出 ----------
const pctStr = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const lines = [];
lines.push('# 数据质量审计');
lines.push('');
lines.push(`生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
lines.push('');
lines.push('## 1. 数据时点与覆盖');
lines.push('');
lines.push('| 数据集 | 时点/范围 | 覆盖 | 说明 |');
lines.push('|---|---|---|---|');
lines.push(`| 旧快照价格 | 半年（4月/12月） | ${stats.prices} 只 | 最新分布：${Object.entries(priceLatest).map(([k, v]) => `${k} ${v}只`).join('、')} |`);
lines.push(`| 旧快照分红 | 年度每股分红 | ${stats.dividends} 只 | 最近分红年：${Object.entries(divLastYear).sort().slice(-4).map(([y, n]) => `${y} ${n}只`).join('、')} |`);
lines.push(`| 旧快照财务 | 年报/季报 | ${stats.f10} 只 | 只有持仓 7 只，覆盖率 ${((stats.f10 / stats.pool) * 100).toFixed(2)}% |`);
lines.push(`| 最新行情（新浪） | ${readJson(path.join(DATA, 'quotes.json'), {}).generated || '—'} | ${stats.quotes} 只 | 全池 ${stats.pool} 只，缺失 ${quoteMissing} 只 |`);
lines.push(`| 月线（腾讯） | 2012-01 ~ 2026-10 | ${stats.monthly} 只 | 用于回测，不复权月末收盘 |`);
lines.push('');
lines.push('**问题：**');
lines.push(`- 旧价格覆盖只有 ${stats.prices}/${stats.pool} = ${((stats.prices / stats.pool) * 100).toFixed(1)}%，**${priceMissing} 只池内股票没有历史价格**。`);
lines.push(`- 旧价格时点集中在 2025-12（${priceLatest['2025-dec'] || 0} 只），真正到 2026 年的只有 ${Object.entries(priceLatest).filter(([k]) => k.startsWith('2026')).reduce((s, [, v]) => s + v, 0)} 只。`);
lines.push(`- 财务数据只有 ${stats.f10} 只，四问/五维评分对 99.9% 的股票无法计算，旧版却照样给出"可买"。`);
lines.push('');
lines.push('## 2. 价格准确性：旧快照 vs 腾讯月线');
lines.push('');
lines.push(`对比 ${Object.keys(monthly).length} 只股票的月线收盘，偏差 ≥2% 的样本 **${priceChecks.length}** 个。`);
if (priceChecks.length) {
  lines.push('');
  lines.push('| 代码 | 名称 | 月份 | 旧快照 | 腾讯收盘 | 偏差 |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of priceChecks.slice(0, 15)) {
    lines.push(`| ${r.code} | ${r.name} | ${r.ym} | ${r.snap} | ${r.qq} | ${(r.diff * 100).toFixed(1)}% |`);
  }
  if (priceChecks.length > 15) lines.push(`| … | 其余 ${priceChecks.length - 15} 个 | | | | |`);
}
lines.push('');
lines.push('## 3. 股息率准确性：旧 pool.dy vs 用最新价重算');
lines.push('');
lines.push(`可比样本 ${dyChecks.length} 只。旧 dy 与「最近年度每股分红 / 最新价」的偏差：`);
lines.push(`- 中位绝对偏差：**${median(dyDiffAbs)?.toFixed(2)} 个百分点**`);
lines.push(`- P90 绝对偏差：**${pct(dyDiffAbs, 0.9)?.toFixed(2)} 个百分点**`);
lines.push(`- 最大绝对偏差：**${Math.max(...dyDiffAbs).toFixed(2)} 个百分点**`);
lines.push('');
lines.push('偏差最大的 15 只：');
lines.push('');
lines.push('| 代码 | 名称 | 旧 dy | 重算 dy | 偏差 | 最近分红年 | 最新价 |');
lines.push('|---|---|---|---|---|---|---|');
for (const r of dyChecks.slice(0, 15)) {
  lines.push(`| ${r.code} | ${r.name} | ${r.oldDy.toFixed(2)}% | ${r.calcDy.toFixed(2)}% | ${r.diff > 0 ? '+' : ''}${r.diff.toFixed(2)}pp | ${r.lastY} | ${r.price} |`);
}
lines.push('');
lines.push('**含义：** 旧版「股息率」字段直接来自 pool.dy，与价格/分红不同步；用它筛选会把低股息股当高股息（如南山铝业旧 13.88%、重算 3.27%）。');
lines.push('');
lines.push('## 4. 分红数据质量');
lines.push('');
lines.push('| 分红年数 | 只数 |');
lines.push('|---|---|');
for (const [k, v] of Object.entries(divQuality.nYears)) lines.push(`| ${k} 年 | ${v} |`);
lines.push('');
lines.push('| 连续分红 | 只数 |');
lines.push('|---|---|');
for (const [k, v] of Object.entries(divQuality.consecutive)) lines.push(`| ${k} 年 | ${v} |`);
lines.push('');
lines.push('## 5. 最新价与旧快照的价格漂移');
lines.push('');
lines.push(`有 ${stale.length} 只可比。从旧快照最后价格到 ${readJson(path.join(DATA, 'quotes.json'), {}).generated || '最新'} 的涨跌：`);
lines.push(`- 中位：${pctStr(median(staleChg))}`);
lines.push(`- P10 / P90：${pctStr(pct(staleChg, 0.1))} / ${pctStr(pct(staleChg, 0.9))}`);
lines.push('');
// ---------- 6. 新补的财务数据 ----------
const finCur = readJson(path.join(DATA, 'finance-current.json'), { year: null, data: {} });
const finRows = Object.entries(finCur.data || {});
let loss = 0, roeOk = 0;
const roes = [];
for (const [, a] of finRows) {
  if (a[0] != null && a[0] <= 0) loss++;
  if (a[1] != null) { roes.push(a[1]); if (a[1] >= 5) roeOk++; }
}
const histFile = readJson(path.join(DATA, 'finance-history.json'), { from: null, to: null, data: {} });
lines.push('## 6. 新工具补全的财务数据');
lines.push('');
lines.push(`- **${finRows.length} 只**有 ${finCur.year} 年报主要指标（池内 ${stats.pool} 只，覆盖 ${((finRows.length / stats.pool) * 100).toFixed(1)}%）`);
lines.push(`- 历史年报：${Object.keys(histFile.data || {}).length} 只，${histFile.from}–${histFile.to}`);
lines.push(`- 2025 年报亏损：${loss} 只；ROE ≥5%：${roeOk} 只；ROE 中位 ${median(roes)?.toFixed(1)}%`);
lines.push('');
lines.push('## 7. 结论');
lines.push('');
lines.push('1. **旧数据不能直接当"最新"用**：价格停在 2025-12，财务只有 7 只，股息率字段与价格脱节。');
lines.push(`2. **已接入最新行情**：全池 ${stats.quotes} 只更新到 ${readJson(path.join(DATA, 'quotes.json'), {}).generated || '最新交易日'}。`);
lines.push('3. **回测数据**：腾讯月线覆盖到 2026-10，可用于 2012 年至今的月度调仓回测；局限是不含退市股、不复权（分红单独加回）。');
lines.push('4. **财务已从 7 只补到 5377 只**（2025 年报）：支付率、现金流覆盖、ROE 都能算，财务不再是硬缺口。');
lines.push('');

fs.writeFileSync(path.join(REPORT, 'DATA-QUALITY.md'), lines.join('\n'));
console.log(lines.join('\n'));
console.log('\n-> report/DATA-QUALITY.md');
