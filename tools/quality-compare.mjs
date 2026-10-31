#!/usr/bin/env node
/**
 * 质量过滤前后对比：同一参数，quality on/off，输出 Markdown 到 report/QUALITY-FILTER.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { runPlanBacktest } from '../src/engine/backtest.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const baseline = read('baseline.json');
const months = read('monthly.json').months;
const benchmark = read('benchmark.json').bench;
const finHistory = read('finance-history.json').data;

const params = { startYear: 2013, endYm: '2026-10', holdN: 20, minDy: 4, minDivYears: 3, weight: 'equal', cost: 0.001 };
const off = runPlanBacktest({ baseline, months, benchmark, finHistory, params: { ...params, quality: false } });
const on = runPlanBacktest({ baseline, months, benchmark, finHistory, params: { ...params, quality: true } });

const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const lines = [];
lines.push('# 回测：加财务质量过滤前后');
lines.push('');
lines.push('过滤条件（用调仓年前一年年报，4 月调仓时已披露）：');
lines.push('- 股息率 4%–15%');
lines.push('- 支付率 < 85%');
lines.push('- 每股经营现金流 / EPS ≥ 0.7');
lines.push('- 加权 ROE ≥ 5%');
lines.push('');
lines.push('| 指标 | 无质量过滤 | 加质量过滤 | 变化 |');
lines.push('|---|---:|---:|---:|');
for (const [k, label] of [['total', '累计收益'], ['cagr', '年化'], ['mdd', '最大回撤'], ['sharpe', '夏普'], ['turnover', '年换手'], ['excess', '相对基准']]) {
  const a = off.stats[k], b = on.stats[k];
  const diff = a != null && b != null ? b - a : null;
  const fmt = k === 'sharpe' ? (v) => (v == null ? '—' : v.toFixed(2)) : pct;
  lines.push(`| ${label} | ${fmt(a)} | **${fmt(b)}** | ${diff == null ? '—' : (k === 'sharpe' ? (diff > 0 ? '+' : '') + diff.toFixed(2) : (diff > 0 ? '+' : '') + (diff * 100).toFixed(1) + 'pp')} |`);
}
lines.push('');
lines.push('最新一期持仓对比：');
lines.push('');
const offLast = off.periods.at(-1)?.items || [];
const onLast = on.periods.at(-1)?.items || [];
lines.push('| 无质量过滤 | 加质量过滤 |');
lines.push('|---|---|');
for (let i = 0; i < Math.max(offLast.length, onLast.length); i++) {
  const a = offLast[i] ? `${offLast[i].name}（${offLast[i].dy.toFixed(1)}%）` : '';
  const b = onLast[i] ? `${onLast[i].name}（${onLast[i].dy.toFixed(1)}%）` : '';
  lines.push(`| ${a} | ${b} |`);
}
lines.push('');
fs.writeFileSync(path.resolve(ROOT, '../report/QUALITY-FILTER.md'), lines.join('\n'));
console.log(lines.join('\n'));
