#!/usr/bin/env node
/**
 * 抓取全 A 股年度财务主要指标（东财数据中心），生成：
 *  - data/finance-current.json  最近年报（2025）全市场指标，首页/个股用，约 0.5MB
 *  - data/finance-history.json  2011–2024 年度指标，回测质量过滤用，约 4MB
 *
 * 字段：eps 基本每股收益、roe 加权ROE、nm 销售净利率、liab 资产负债率、
 *       ocfps 每股经营现金流、np 归母净利润
 *
 * 用法：node tools/fetch-finance.mjs [起始年] [结束年]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const START = Number(process.argv[2] || 2011);
const END = Number(process.argv[3] || 2025);
const FIELDS = 'SECUCODE,REPORT_DATE,EPSJB,ROEJQ,XSJLL,ZCFZL,MGJYXJJE,PARENTNETPROFIT';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchPage(base, p, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const j = await getJson(base + p);
      return j?.result?.data || [];
    } catch (e) {
      if (t === tries - 1) console.error(`  page ${p} failed: ${e.message}`);
      await sleep(500 * (t + 1));
    }
  }
  return [];
}

async function fetchYear(year) {
  const rows = new Map();
  const base = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=${encodeURIComponent(FIELDS)}&filter=${encodeURIComponent(`(REPORT_DATE='${year}-12-31')`)}&pageSize=500&sortColumns=SECUCODE&sortTypes=1&pageNumber=`;
  const first = await getJson(base + '1');
  const pages = first?.result?.pages || 0;
  const collect = (list) => {
    for (const r of list || []) {
      const code = String(r.SECUCODE || '').slice(0, 6);
      if (!/^\d{6}$/.test(code)) continue;
      const num = (v) => (Number.isFinite(v) ? v : null);
      const item = {
        eps: num(r.EPSJB),
        roe: num(r.ROEJQ),
        nm: num(r.XSJLL),
        liab: num(r.ZCFZL),
        ocfps: num(r.MGJYXJJE),
        np: num(r.PARENTNETPROFIT),
      };
      if (item.eps == null && item.roe == null) continue;
      rows.set(code, item);
    }
  };
  collect(first?.result?.data);
  const tasks = [];
  for (let p = 2; p <= pages; p++) tasks.push(p);
  const CONC = 5;
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const p = tasks[idx++];
      collect(await fetchPage(base, p));
      await sleep(40);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`  ${year}: ${rows.size} 只 (${pages} 页)`);
  return rows;
}

// 只保留股票池内的代码（与 baseline.json 对齐），控制文件体积
const poolCodes = new Set(
  Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'baseline.json'), 'utf8')).pool || {})
);

const all = {};
for (let y = START; y <= END; y++) {
  const rows = await fetchYear(y);
  for (const [code, item] of rows) {
    if (poolCodes.size && !poolCodes.has(code)) continue;
    (all[code] ||= {})[y] = item;
  }
  await sleep(200);
}

// 拆分：最近年报 vs 历史（历史与已有文件合并，不覆盖旧年份）
const latestYear = END;
const current = { generated: new Date().toISOString().slice(0, 10), year: latestYear, data: {} };
const historyPath = path.join(DATA, 'finance-history.json');
let existingHistory = {};
if (fs.existsSync(historyPath)) {
  try { existingHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8')).data || {}; } catch { /* ignore */ }
}
const history = { generated: new Date().toISOString().slice(0, 10), from: 2011, to: END, data: { ...existingHistory } };

for (const [code, years] of Object.entries(all)) {
  const cur = years[latestYear];
  if (cur) current.data[code] = [cur.eps, cur.roe, cur.nm, cur.liab, cur.ocfps, cur.np];
  const map = new Map((history.data[code] || []).map((r) => [r[0], r]));
  for (let y = START; y <= END; y++) {
    const it = years[y];
    if (!it) continue;
    map.set(y, [y, it.eps, it.roe, it.nm, it.liab, it.ocfps]);
  }
  if (map.size) history.data[code] = [...map.values()].sort((a, b) => a[0] - b[0]);
}

fs.writeFileSync(path.join(DATA, 'finance-current.json'), JSON.stringify(current));
fs.writeFileSync(historyPath, JSON.stringify(history));
console.log(`current: ${Object.keys(current.data).length} 只 ${(fs.statSync(path.join(DATA, 'finance-current.json')).size / 1e6).toFixed(2)}MB`);
console.log(`history: ${Object.keys(history.data).length} 只 ${(fs.statSync(historyPath).size / 1e6).toFixed(2)}MB`);
