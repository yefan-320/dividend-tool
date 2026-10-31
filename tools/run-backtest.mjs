#!/usr/bin/env node
/**
 * 命令行跑回测，验证引擎输出。
 * 用法：node tools/run-backtest.mjs [holdN] [minDy] [quality=0|1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { runPlanBacktest } from '../src/engine/backtest.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f, fb = null) => {
  const p = path.join(ROOT, 'data', f);
  if (!fs.existsSync(p)) return fb;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

const baseline = read('baseline.json');
const months = read('monthly.json').months;
const benchmark = read('benchmark.json').bench;
const finHistory = read('finance-history.json', { data: {} }).data;

const holdN = Number(process.argv[2] || 20);
const minDy = Number(process.argv[3] || 4);
const quality = process.argv[4] === '0' ? false : true;
const t0 = Date.now();
const r = runPlanBacktest({
  baseline, months, benchmark, finHistory,
  params: { startYear: 2013, endYm: '2026-10', holdN, minDy, minDivYears: 3, weight: 'equal', quality },
});
console.log(`耗时 ${Date.now() - t0}ms  holdN=${holdN} minDy=${minDy}% quality=${quality}`);
console.log(JSON.stringify(r.stats, null, 1));
console.log('年度：', r.yearly.map((x) => `${x.year}:${(x.ret * 100).toFixed(1)}%`).join(' '));
console.log('调仓次数', r.periods.length, '首个', r.periods[0].ym, '最新', r.periods.at(-1).ym);
console.log('最新持仓', r.periods.at(-1).items.slice(0, 8));
console.log('final nav', r.nav.at(-1), 'bench', r.benchmark.at(-1));
