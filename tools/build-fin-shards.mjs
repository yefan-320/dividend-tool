#!/usr/bin/env node
/**
 * 把 data/finance-history.json（5513 只、4.3MB 整包）拆成「一只股票一个文件」。
 *
 * 为什么：回测哪几只，就只该下那几只的财报。
 *   · 个股回测 601398      → 只拉 data/fin/601398.json（约 0.5KB）
 *   · 组合 8 只            → 只拉这 8 个文件（约 4KB）
 *   · 对比模式全市场选股   → 才拉整包 finance-history.json（4.3MB）
 * 按代码前缀切「片」是不彻底的：片里 55 只，你只要 1 只也得把另外 54 只下下来。
 *
 * 产出：
 *   data/fin/<code>.json   每只：[[year,eps,roe,nm,liab,ocfps], ...]
 *
 * 用法：node tools/build-fin-shards.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'data', 'finance-history.json');
const OUT = path.join(ROOT, 'data', 'fin');

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const data = raw.data || {};

// 清空旧产物（旧的按前缀分片也要清掉）
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
let total = 0;
let maxBytes = 0;
let maxCode = '';
const codes = [];
for (const [code, rows] of Object.entries(data)) {
  if (!/^\d{6}$/.test(code)) continue;
  const json = JSON.stringify(rows);
  const file = path.join(OUT, code + '.json');
  fs.writeFileSync(file, json);
  codes.push(code);
  n++;
  total += json.length;
  if (json.length > maxBytes) { maxBytes = json.length; maxCode = code; }
}

// index.json 只用于「离线缓存全部」按钮；回测本身不需要它
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  generated: raw.generated || new Date().toISOString().slice(0, 10),
  count: n,
}));

console.log(`✓ ${n} 只，一只一个文件 · 合计 ${(total / 1024).toFixed(0)}KB · 平均 ${(total / n).toFixed(0)}B/只`);
console.log(`  最大 ${maxCode}.json ${maxBytes}B`);
