#!/usr/bin/env node
/**
 * 把旧快照里可复用的基础数据导入 红利工具/data/baseline.json
 * 运行时只读 红利工具/data，不依赖 repo/。
 *
 * 导出：
 *  - pool: {code:{n,ind,cap,dy}} 股票名称/行业/市值/旧股息率
 *  - dividends: {code:{years:{Y:dps}, nYears, consecutive, lastY}}
 *  - f10: 持仓 7 只的财务（原样）
 *  - holdings: 当前持仓
 *  - hs300: 沪深300 半年点位
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(ROOT, '../repo');
const DATA = path.join(ROOT, 'data');

const code = fs.readFileSync(path.join(REPO, 'data/snapshot-data.js'), 'utf8');
const ctx = { window: {} };
vm.runInNewContext(code, ctx);
const S = ctx.window.__SNAP__;

const pool = {};
for (const [c, v] of Object.entries(S.pool || {})) {
  pool[c] = { n: v.n, ind: v.ind, cap: v.cap, dy: v.dy };
}

const dividends = {};
for (const [c, v] of Object.entries(S.dividends || {})) {
  dividends[c] = {
    years: v.years || {},
    nYears: v.nYears ?? Object.keys(v.years || {}).length,
    consecutive: v.consecutive ?? 0,
    lastY: v.lastY ?? Number(Object.keys(v.years || {}).sort().pop() || 0),
  };
}

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'repo/data/snapshot-data.js',
  pool,
  dividends,
  f10: S.f10 || {},
  holdings: S.holdings || [],
  hs300: S.hs300 || {},
};

fs.writeFileSync(path.join(DATA, 'baseline.json'), JSON.stringify(payload));
console.log(
  `baseline: pool=${Object.keys(pool).length} dividends=${Object.keys(dividends).length} f10=${Object.keys(payload.f10).length} ` +
    `size=${(fs.statSync(path.join(DATA, 'baseline.json')).size / 1e6).toFixed(1)}MB`
);
