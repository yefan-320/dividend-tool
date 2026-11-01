#!/usr/bin/env node
/**
 * 把 data/finance-history.json（5513 只、4.3MB）按股票代码前 4 位切成小片。
 *
 * 为什么：个股回测只需要一只股票的历年财报，却要下 4.3MB（gzip 1.9MB）。
 * 切片后 601398 只拉 data/fin/6013.json（16KB，gzip 约 5KB）。
 *
 * 产出：
 *   data/fin/<前4位>.json   { "<code>": [[year,eps,roe,nm,liab,ocfps], ...] }
 *   data/fin/index.json     { generated, count, shards: ["0000", ...] }
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
fs.mkdirSync(OUT, { recursive: true });

const shards = {};
for (const [code, rows] of Object.entries(data)) {
  if (!/^\d{6}$/.test(code)) continue;
  const key = code.slice(0, 4);
  (shards[key] ||= {})[code] = rows;
}

// 清掉旧片，避免改名后留垃圾
for (const f of fs.readdirSync(OUT)) {
  if (/^\d{4}\.json$/.test(f)) fs.unlinkSync(path.join(OUT, f));
}

let total = 0;
for (const [key, obj] of Object.entries(shards)) {
  const json = JSON.stringify(obj);
  fs.writeFileSync(path.join(OUT, key + '.json'), json);
  total += json.length;
}

const keys = Object.keys(shards).sort();
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
  generated: raw.generated || new Date().toISOString().slice(0, 10),
  count: Object.keys(data).length,
  shards: keys,
}));

console.log(`✓ ${keys.length} 片 · ${Object.keys(data).length} 只 · ${(total / 1024).toFixed(0)}KB`);
console.log(`  最大片 ${keys.map((k) => [k, fs.statSync(path.join(OUT, k + '.json')).size]).sort((a, b) => b[1] - a[1])[0].map((v) => (typeof v === 'number' ? (v / 1024).toFixed(0) + 'KB' : v)).join(' ')}`);
