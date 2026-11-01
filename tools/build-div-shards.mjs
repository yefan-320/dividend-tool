#!/usr/bin/env node
/**
 * 把 baseline.json 里的分红历史按股票拆成「一只一个文件」。
 *
 * 为什么：baseline.json 254KB（gzip）里 70% 是 5406 只股票的分红历史，
 * 但回测你的组合只用得到组合里那几只。组合还会随时增删改——所以不能预先切死，
 * 只能每次按「当前持仓」算缺哪几只、补哪几只。
 *
 * 产出：
 *   data/div/<code>.json   { "years": { "2011": 0.2, ... } }
 *   data/pool.json         { "<code>": { n, ind, cap }, ... }   （今天/选股页要全市场池）
 *
 * 用法：node tools/build-div-shards.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'data', 'baseline.json');
const OUT = path.join(ROOT, 'data', 'div');

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const dividends = raw.dividends || {};
const pool = raw.pool || {};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
let total = 0;
for (const [code, info] of Object.entries(dividends)) {
  if (!/^\d{6}$/.test(code)) continue;
  const years = info && info.years ? info.years : info;
  const json = JSON.stringify({ years });
  fs.writeFileSync(path.join(OUT, code + '.json'), json);
  n++;
  total += json.length;
}

fs.writeFileSync(path.join(ROOT, 'data', 'pool.json'), JSON.stringify(pool));

console.log(`✓ 分红 ${n} 只 · 合计 ${(total / 1024).toFixed(0)}KB · 平均 ${(total / n).toFixed(0)}B/只`);
console.log(`✓ 股票池 pool.json ${(JSON.stringify(pool).length / 1024).toFixed(0)}KB · ${Object.keys(pool).length} 只`);
