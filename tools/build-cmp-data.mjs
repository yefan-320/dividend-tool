#!/usr/bin/env node
/**
 * 生成「组合对比」专用的小数据文件，替掉 6.4MB 的 monthly.json + 4.3MB 的 finance-history.json。
 *
 * 为什么：组合对比在手机上要下 3.3MB（gzip），30KB/s 下 110 秒，20 秒超时直接挂。
 * 但那个页面真正需要的东西小得多：
 *   ① 选股：每年 4 月末的收盘价（2823 只 × 15 年）        → cmp-yearly.json  ≈ 78KB gz
 *   ② 选股用的财报：上一年度的 eps / roe / ocfps          → cmp-fin.json     ≈ 257KB gz
 *   ③ 净值：只有被选中的那几十只的完整月线               → data/monthly/<code>.json
 *
 * 产出：
 *   data/monthly/<code>.json   [[ym, close], ...]   每只一个文件 ≈ 2.3KB
 *   data/cmp-yearly.json       { y:[年份], d:{code:[4月末价|null]} }
 *   data/cmp-fin.json          { c:{code:[[年, eps, roe, ocfps], ...]} }
 *
 * 用法：node tools/build-cmp-data.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT_MONTHLY = path.join(DATA, 'monthly');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const gz = (s) => zlib.gzipSync(Buffer.from(s), { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(0) + 'KB';

const monthly = readJson(path.join(DATA, 'monthly.json'));
const months = monthly.months || {};
const codes = Object.keys(months);

/* ---------- ① 月线分片 ---------- */
fs.rmSync(OUT_MONTHLY, { recursive: true, force: true });
fs.mkdirSync(OUT_MONTHLY, { recursive: true });
let shardBytes = 0;
for (const code of codes) {
  const rows = months[code].map(([ym, p]) => [ym, Math.round(p * 100) / 100]);
  const s = JSON.stringify(rows);
  shardBytes += s.length;
  fs.writeFileSync(path.join(OUT_MONTHLY, code + '.json'), s);
}
console.log(`① 月线分片 ${codes.length} 个，原始合计 ${kb(shardBytes)}（单只平均 ${(shardBytes / codes.length / 1024).toFixed(1)}KB）`);

/* ---------- ② 每年 4 月末收盘价（选股用） ---------- */
const yearSet = new Set();
for (const rows of Object.values(months)) for (const [ym] of rows) yearSet.add(Number(ym.slice(0, 4)));
const years = [...yearSet].sort();
const d = {};
for (const code of codes) {
  const byY = {};
  for (const [ym, p] of months[code]) if (ym.slice(5, 7) === '04') byY[Number(ym.slice(0, 4))] = Math.round(p * 100) / 100;
  d[code] = years.map((y) => (byY[y] ?? null));
}
const yearlyStr = JSON.stringify({ generated: monthly.generated, y: years, d });
fs.writeFileSync(path.join(DATA, 'cmp-yearly.json'), yearlyStr);
console.log(`② cmp-yearly.json  原始 ${kb(yearlyStr.length)}  gzip ${kb(gz(yearlyStr))}  （${codes.length} 只 × ${years.length} 年）`);

/* ---------- ③ 选股用财报 ---------- */
const finRaw = readJson(path.join(DATA, 'finance-history.json'));
const finAll = finRaw.data || finRaw;
const r2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const c = {};
let finCodes = 0;
for (const code of codes) {
  const rows = finAll[code];
  if (!Array.isArray(rows) || !rows.length) continue;
  // 只留 2010 以后（回测最早从 2012 开始，选股看的是「上一年度」）
  c[code] = rows.filter((r) => r[0] >= 2010).map((r) => [r[0], r2(r[1]), r2(r[2]), r2(r[5])]);
  finCodes++;
}
const finStr = JSON.stringify({ generated: finRaw.generated || monthly.generated, c });
fs.writeFileSync(path.join(DATA, 'cmp-fin.json'), finStr);
console.log(`③ cmp-fin.json     原始 ${kb(finStr.length)}  gzip ${kb(gz(finStr))}  （${finCodes} 只）`);

const total = gz(yearlyStr) + gz(finStr);
console.log(`\n组合对比冷启动增量：${kb(total)} gzip（原来 monthly+finance-history = ${kb(gz(JSON.stringify(monthly)) + gz(JSON.stringify(finRaw)))}）`);
