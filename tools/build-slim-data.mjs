#!/usr/bin/env node
/**
 * 数据瘦身 / 拆分（幂等，可重复跑）：
 *
 * 1. data/baseline.json：
 *    - 去掉运行时不用的派生字段：pool[*].dy、dividends[*].nYears / consecutive / lastY、hs300
 *      （nYears/consecutive/lastY 由 src/data.js 的 divIndexEntry 从 years 重算；pool.dy 没有任何运行时读取）
 *    - 保留 generated / source / pool(n,ind,cap) / dividends(years) / f10 / holdings
 * 2. data/finance-current.json → 拆成：
 *    - data/finance-core.json：year + data[code]=[eps, roe, ocfps]（首屏/今天/选股/回测质量闸门用）
 *    - data/finance-extra.json：data[code]=[nm, liab, np]（只有个股页展示净利率/负债率/净利润，按需加载）
 *    注意：finance-current.json 仍保留原样，audit-app / fetch-finance 继续用它。
 *
 * 用法：node tools/build-slim-data.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const write = (f, obj) => {
  const p = path.join(DATA, f);
  fs.writeFileSync(p, JSON.stringify(obj));
  return fs.statSync(p).size;
};

/* ---------- 1. baseline 瘦身 ---------- */
const base = read('baseline.json');
const pool = {};
for (const [code, info] of Object.entries(base.pool || {})) {
  const row = { n: info.n };
  if (info.ind) row.ind = info.ind;
  if (info.cap) row.cap = info.cap;
  pool[code] = row;
}
const dividends = {};
let droppedFields = 0;
for (const [code, d] of Object.entries(base.dividends || {})) {
  const years = d.years || {};
  dividends[code] = { years };
  if ('nYears' in d || 'consecutive' in d || 'lastY' in d) droppedFields++;
}
const slim = {
  generated: base.generated || '',
  source: base.source || '',
  pool,
  dividends,
  f10: base.f10 || {},
  holdings: base.holdings || [],
};
const sizeBefore = fs.statSync(path.join(DATA, 'baseline.json')).size;
const sizeAfter = write('baseline.json', slim);

/* ---------- 2. finance 拆分 ---------- */
const fin = read('finance-current.json');
const round = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const finCore = { year: fin.year ?? null, data: {} };
const finExtra = { year: fin.year ?? null, data: {} };
let finCount = 0;
for (const [code, a] of Object.entries(fin.data || {})) {
  if (!Array.isArray(a)) continue;
  // 保留 4 位小数足够展示与质量闸门；净利润按元取整（页面按亿/万展示）
  finCore.data[code] = [round(a[0], 4), round(a[1], 4), round(a[4], 4)];
  finExtra.data[code] = [round(a[2], 4), round(a[3], 4), round(a[5], 0)];
  finCount++;
}
const coreSize = write('finance-core.json', finCore);
const extraSize = write('finance-extra.json', finExtra);
const fullSize = fs.statSync(path.join(DATA, 'finance-current.json')).size;

console.log('baseline.json :', (sizeBefore / 1024).toFixed(0) + 'KB →', (sizeAfter / 1024).toFixed(0) + 'KB',
  `(pool ${Object.keys(pool).length} 只 / dividends ${Object.keys(dividends).length} 只 / 清理派生字段 ${droppedFields} 条)`);
console.log('finance       :', (fullSize / 1024).toFixed(0) + 'KB → core',
  (coreSize / 1024).toFixed(0) + 'KB + extra', (extraSize / 1024).toFixed(0) + 'KB',
  `(${finCount} 只)`);
