#!/usr/bin/env node
/**
 * 抓取最新行情与月线，写到 红利工具/data/。
 *
 * 数据源：
 *  - 新浪行情（批量 100 只/次，GBK）：最新价、开高低、成交量
 *  - 腾讯月线（前复权关闭，不复权）：每月末收盘，2012-01 起
 *  - 腾讯指数月线：sh000922 中证红利、sh000300 沪深300、sh000905 中证500
 *
 * 用法：
 *   node tools/fetch-data.mjs quotes   # 只抓最新行情（快）
 *   node tools/fetch-data.mjs monthly  # 抓月线（慢，可后台）
 *   node tools/fetch-data.mjs index    # 抓指数月线
 *   node tools/fetch-data.mjs all
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 返回抓取所需的基础数据（股票池 / 历史月线 / 持仓）。
 * 旧 2.0 的 snapshot-data.js 已删除：有就继续兼容，没有就退回当前 data/ 下的文件，
 * 这样 `npm run fetch` 在不依赖旧仓库的情况下也能用。
 */
export function loadSnap() {
  const legacy = path.resolve(ROOT, '../repo/data/snapshot-data.js');
  if (fs.existsSync(legacy)) {
    const code = fs.readFileSync(legacy, 'utf8');
    const ctx = { window: {} };
    vm.runInNewContext(code, ctx);
    return ctx.window.__SNAP__;
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(DATA, 'baseline.json'), 'utf8'));
  const prices = {};
  try {
    const monthly = JSON.parse(fs.readFileSync(path.join(DATA, 'monthly.json'), 'utf8'));
    for (const code of Object.keys(monthly.months || {})) prices[code] = {};
  } catch (e) { /* 首次抓取时还没有 monthly.json */ }
  return {
    pool: baseline.pool || {},
    dividends: baseline.dividends || {},
    f10: baseline.f10 || {},
    holdings: baseline.holdings || [],
    prices,
    hs300: baseline.hs300 || {},
  };
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

async function getText(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder('gbk').decode(buf);
}

async function getJson(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** 6/9 开头 → sh，0/2/3 开头 → sz */
export function qqCode(code) {
  const c = String(code).padStart(6, '0');
  if (/^[69]/.test(c)) return 'sh' + c;
  if (/^[0-3]/.test(c)) return 'sz' + c;
  return 'sh' + c; // 兜底
}

async function fetchQuotes(snap) {
  const pool = snap.pool || {};
  const codes = Object.keys(pool);
  const out = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < codes.length; i += 100) {
    const batch = codes.slice(i, i + 100);
    const url = 'https://hq.sinajs.cn/list=' + batch.map(qqCode).join(',');
    let text;
    try {
      text = await getText(url, 'https://finance.sina.com.cn');
    } catch (e) {
      fail += batch.length;
      continue;
    }
    const lines = text.split('\n');
    for (const line of lines) {
      const m = line.match(/hq_str_(sh|sz)(\d{6})="([^"]*)"/);
      if (!m) continue;
      const [, , code, body] = m;
      if (!body) { fail++; continue; }
      const f = body.split(',');
      // 0 名称 1 今开 2 昨收 3 最新 4 最高 5 最低 6 买一 7 卖一 8 量 9 额 ... 30 日期 31 时间
      const num = (v) => (v === '' || v === '-' ? null : Number(v));
      const q = {
        n: f[0],
        prev: num(f[2]), p: num(f[3]),
        date: f[30] || '',
      };
      if (q.p) { out[code] = q; ok++; } else fail++;
    }
    if (i % 500 === 0) process.stdout.write(`quotes ${i}/${codes.length}\r`);
    await sleep(60);
  }
  const generated = Object.values(out).map((q) => q.date).sort().pop() || '';
  const payload = { generated, source: 'sina', count: ok, quotes: out };
  fs.writeFileSync(path.join(DATA, 'quotes.json'), JSON.stringify(payload));
  console.log(`\nquotes ok=${ok} fail=${fail} generated=${generated} -> data/quotes.json`);
  return payload;
}

async function fetchMonthly(snap) {
  const prices = snap.prices || {};
  const holdings = snap.holdings || [];
  // 有历史价格的全部股票 + 当前持仓（即使无历史价格）
  const codes = [...new Set([...Object.keys(prices), ...holdings])]
    .filter((c) => /^\d{6}$/.test(c));
  console.log(`monthly targets: ${codes.length}`);

  const months = {};
  let done = 0, ok = 0, fail = 0;
  const CONCURRENCY = 12;

  async function one(code) {
    const qc = qqCode(code);
    const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${qc},month,2011-12-01,2026-12-31,400,`;
    try {
      const j = await getJson(url, 'https://gu.qq.com/');
      const arr = j?.data?.[qc]?.month;
      if (!Array.isArray(arr) || !arr.length) { fail++; return; }
      const rows = [];
      for (const r of arr) {
        const d = String(r[0]).slice(0, 7); // YYYY-MM
        const c = Number(r[2]);
        if (!d || !Number.isFinite(c) || c <= 0) continue;
        if (d < '2012-01') continue;
        rows.push([d, Math.round(c * 100) / 100]);
      }
      if (rows.length) { months[code] = rows; ok++; } else fail++;
    } catch {
      fail++;
    } finally {
      done++;
      if (done % 100 === 0) process.stdout.write(`monthly ${done}/${codes.length} ok=${ok} fail=${fail}\r`);
    }
  }

  let idx = 0;
  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      await one(code);
      await sleep(15);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const payload = { generated: new Date().toISOString().slice(0, 10), source: 'tencent', count: ok, months };
  fs.writeFileSync(path.join(DATA, 'monthly.json'), JSON.stringify(payload));
  console.log(`\nmonthly ok=${ok} fail=${fail} -> data/monthly.json (${(fs.statSync(path.join(DATA, 'monthly.json')).size / 1e6).toFixed(1)} MB)`);
  return payload;
}

async function fetchIndex() {
  const out = {};
  for (const qc of ['sh000922', 'sh000300', 'sh000905', 'sh000932']) {
    try {
      const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${qc},month,2011-12-01,2026-12-31,400,`;
      const j = await getJson(url, 'https://gu.qq.com/');
      const arr = j?.data?.[qc]?.month;
      if (!Array.isArray(arr)) { console.log(qc, 'EMPTY'); continue; }
      const rows = arr
        .map((r) => [String(r[0]).slice(0, 7), Number(r[2])])
        .filter(([d, c]) => d >= '2012-01' && Number.isFinite(c) && c > 0);
      out[qc] = rows;
      console.log(qc, rows.length, rows[0], rows[rows.length - 1]);
    } catch (e) {
      console.log(qc, 'ERR', e.message);
    }
  }
  fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), source: 'tencent', index: out }));
  console.log('-> data/index.json');
}

// 只有直接运行才抓取；被 import 时只暴露 loadSnap 等纯函数，方便测试
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const cmd = process.argv[2] || 'all';
  const snap = loadSnap();
  if (cmd === 'quotes' || cmd === 'all') await fetchQuotes(snap);
  if (cmd === 'monthly' || cmd === 'all') await fetchMonthly(snap);
  if (cmd === 'index' || cmd === 'all') await fetchIndex();
}
