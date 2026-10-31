#!/usr/bin/env node
/**
 * 派生数据：当前股息率分位（避免页面为了分位去加载 6.5MB 月线）。
 * 输出 data/dy-pct.json：{ generated, data: { code: 0-100 } }
 * 运行：node tools/build-derivatives.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

const monthly = read('monthly.json').months;
const quotes = read('quotes.json').quotes;
const divs = read('baseline.json').dividends || {};

const out = {};
let n = 0;
for (const [code, rows] of Object.entries(monthly)) {
  const q = quotes[code];
  const years = divs[code]?.years || {};
  const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
  if (!q?.p || !ys.length) continue;
  const cur = (years[ys[ys.length - 1]] / q.p) * 100;
  const seq = [];
  for (const [ym, close] of rows) {
    const y = Number(ym.slice(0, 4));
    const dps = years[y - 1];
    if (dps > 0 && close > 0) seq.push((dps / close) * 100);
  }
  if (seq.length < 24) continue;
  out[code] = Math.round((seq.filter((v) => v <= cur).length / seq.length) * 100);
  n++;
}

const payload = { generated: new Date().toISOString().slice(0, 10), count: n, data: out };
fs.writeFileSync(path.join(DATA, 'dy-pct.json'), JSON.stringify(payload));
console.log(`dy-pct: ${n} 只 → data/dy-pct.json (${(fs.statSync(path.join(DATA, 'dy-pct.json')).size / 1024).toFixed(1)} KB)`);
