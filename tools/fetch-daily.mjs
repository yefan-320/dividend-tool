#!/usr/bin/env node
/**
 * 抓取全市场日 K（不复权，近 2000 个交易日），写成 data/daily/<code>.json。
 *
 * 结构：
 *   data/daily/meta.json  { generated, bars, cal: ['2018-07-xx', ...] }
 *   data/daily/<code>.json { o:[], h:[], l:[], c:[], v:[] }   // 与 cal 对齐，停牌/未上市为 null
 *
 * 数据源：腾讯 newfqkline（day，不复权）。日历取上证指数（sh000001）交易日。
 * 用法：node tools/fetch-daily.mjs [--limit=50] [--bars=2000] [--conc=12]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'daily');
fs.mkdirSync(OUT, { recursive: true });

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? Number(hit.split('=')[1]) : def;
};
const BARS = arg('bars', 2000);
const CONC = arg('conc', 12);
const LIMIT = arg('limit', 0);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function qqCode(code) {
  const c = String(code).padStart(6, '0');
  if (/^[69]/.test(c)) return 'sh' + c;
  if (/^[0-3]/.test(c)) return 'sz' + c;
  return 'sh' + c;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function fmtDay(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchDay(code, bars) {
  const qc = qqCode(code);
  const rows = new Map();
  let end = null;
  let guard = 0;
  while (rows.size < bars && guard++ < 6) {
    const limit = Math.min(2000, bars - rows.size);
    const url = end
      ? `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${qc},day,1990-01-01,${end},${limit},`
      : `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${qc},day,,,${limit},`;
    const j = await getJson(url);
    const arr = j?.data?.[qc]?.day;
    if (!Array.isArray(arr) || !arr.length) break;
    for (const r of arr) {
      const d = String(r[0]).slice(0, 10);
      const o = Number(r[1]), c = Number(r[2]), h = Number(r[3]), l = Number(r[4]), v = Number(r[5]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || ![o, c, h, l].every((x) => Number.isFinite(x) && x > 0)) continue;
      rows.set(d, [Math.round(o * 100) / 100, Math.round(h * 100) / 100, Math.round(l * 100) / 100, Math.round(c * 100) / 100, Math.round(v)]);
    }
    const first = arr[0][0];
    if (!first || arr.length < 2) break;
    const d0 = new Date(first + 'T00:00:00Z');
    d0.setUTCDate(d0.getUTCDate() - 1);
    end = fmtDay(d0);
  }
  if (!rows.size) throw new Error('empty');
  return rows;
}

function pct(a, b) { return ((a / b - 1) * 100).toFixed(1) + '%'; }

async function main() {
  // 1. 日历：上证指数最近 BARS 个交易日
  const idx = await fetchDay('000001', BARS);
  const cal = [...idx.keys()].sort();
  console.log(`calendar ${cal.length} days ${cal[0]} → ${cal[cal.length - 1]}`);

  // 2. 股票池：月线覆盖的 2823 只 + 演示持仓 + 有分红且有行情的股票
  const monthly = JSON.parse(fs.readFileSync(path.join(DATA, 'monthly.json'), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(DATA, 'baseline.json'), 'utf8'));
  const quotes = JSON.parse(fs.readFileSync(path.join(DATA, 'quotes.json'), 'utf8'));
  const codes = new Set(Object.keys(monthly.months || {}));
  for (const c of baseline.holdings || []) codes.add(String(c));
  // 有分红的股票即使没有月线也补一日 K（新股/次新股常见）
  for (const c of Object.keys(baseline.dividends || {})) if (quotes.quotes?.[c]) codes.add(String(c));
  const list = [...codes].filter((c) => /^\d{6}$/.test(c));
  console.log(`daily targets: ${list.length}`);

  const metaPath = path.join(OUT, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), bars: cal.length, cal }));

  let idxPtr = 0, ok = 0, fail = 0, skip = 0, bytes = 0;
  const targets = LIMIT > 0 ? list.slice(0, LIMIT) : list;
  const fails = [];

  async function one(code) {
    const file = path.join(OUT, code + '.json');
    // 断点续传：已存在且最新一根就在日历末尾附近则跳过
    if (fs.existsSync(file)) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && Array.isArray(j.c) && j.c.length === cal.length && j.c[cal.length - 2] != null) { skip++; return; }
      } catch {}
    }
    let rows;
    try {
      rows = await fetchDay(code, BARS);
    } catch (e) {
      try { await sleep(350); rows = await fetchDay(code, BARS); } catch (e2) { fail++; fails.push(code); return; }
    }
    const o = [], h = [], l = [], c = [], v = [];
    for (const d of cal) {
      const r = rows.get(d);
      if (r) { o.push(r[0]); h.push(r[1]); l.push(r[2]); c.push(r[3]); v.push(r[4]); }
      else { o.push(null); h.push(null); l.push(null); c.push(null); v.push(null); }
    }
    const json = JSON.stringify({ o, h, l, c, v });
    fs.writeFileSync(file, json);
    bytes += json.length;
    ok++;
    if (ok % 100 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`daily ${ok + fail + skip}/${targets.length} ok=${ok} fail=${fail} skip=${skip} ${bytes / 1e6 | 0}MB ${el.toFixed(0)}s`);
    }
  }
  const t0 = Date.now();
  let ptr = 0;
  async function worker() {
    while (ptr < targets.length) {
      const code = targets[ptr++];
      await one(code);
      await sleep(8);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`DONE ok=${ok} fail=${fail} skip=${skip} size=${(bytes / 1e6).toFixed(1)}MB elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (fails.length) fs.writeFileSync(path.join(OUT, 'fails.json'), JSON.stringify(fails));
}

await main();
