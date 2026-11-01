/**
 * 数据层：加载 红利工具/data/*.json，浏览器内统一出口。
 *
 * - 核心数据（行情、分红、池子、基准）启动时加载，约 2.5MB
 * - 月线 6.5MB 只在回测页按需加载
 */
import {
  netCalendar, netDaily, fetchQuotes, maxQuoteDate, offline,
  cacheGetQuotes, cacheSetQuotes,
} from './net.js';

const dataUrl = (f) => new URL(`../data/${f}`, import.meta.url);

export const db = {
  ready: false,
  quotes: {},       // {code:{n,p,prev,o,hi,lo,date}}
  quoteRev: 0,      // 行情变更计数：页面级缓存用它判断是否需要重建（盯盘刷新后不显示旧价）
  baseline: null,   // {pool, dividends, f10, holdings}
  benchmark: {},    // {ym: value}
  monthly: null,    // {code:[[ym,close]]}
  finance: null,    // {code:[eps,roe,nm,liab,ocfps,np]} 最近年报
  finYear: null,
  finHistory: null, // {code:[[year,eps,roe,nm,liab,ocfps],...]}
  financeExtraLoaded: false, // 个股页按需加载的净利率/负债率/净利润是否已合并
  generated: '',
};

async function getJson(f) {
  const res = await fetch(dataUrl(f), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${f} HTTP ${res.status}`);
  return res.json();
}

/** 核心财务 [eps,roe,ocfps] → 统一 6 槽数组；兼容旧的 finance-current 6 槽格式 */
function hydrateFinance(data) {
  const out = {};
  for (const [code, a] of Object.entries(data || {})) {
    if (!Array.isArray(a)) continue;
    out[code] = a.length >= 6
      ? a
      : [a[0] ?? null, a[1] ?? null, null, null, a[2] ?? null, null];
  }
  return out;
}

export async function loadCore() {
  if (db.ready) return db;
  performance.mark?.('d3-core-start');
  const [quotes, baseline, benchmark, finance] = await Promise.all([
    getJson('quotes.json'),
    getJson('baseline.json'),
    getJson('benchmark.json'),
    // 首屏只要 eps/roe/ocfps（质量闸门），净利润/净利率/负债率由个股页按需加载
    getJson('finance-core.json').catch(() => getJson('finance-current.json').catch(() => ({ year: null, data: {} }))),
  ]);
  db.quotes = quotes.quotes || {};
  db.generated = quotes.generated || '';
  db.baseline = baseline;
  db.benchmark = benchmark.bench || {};
  db.finance = hydrateFinance(finance.data);
  db.finYear = finance.year || null;
  db.ready = true;
  performance.mark?.('d3-core-end');
  return db;
}

/**
 * 个股页按需加载财务附加字段（净利率/负债率/净利润），合并进 db.finance 后返回。
 * 失败不抛错：缺失字段页面用「—」兜底。
 */
let financeExtraPromise = null;
export async function loadFinanceExtra() {
  if (db.financeExtraLoaded) return db.finance;
  if (!financeExtraPromise) {
    financeExtraPromise = (async () => {
      const j = await getJson('finance-extra.json');
      for (const [code, a] of Object.entries(j.data || {})) {
        if (!Array.isArray(a)) continue;
        const row = db.finance[code] || [null, null, null, null, null, null];
        row[2] = a[0] ?? null;
        row[3] = a[1] ?? null;
        row[5] = a[2] ?? null;
        db.finance[code] = row;
      }
      db.financeExtraLoaded = true;
      return db.finance;
    })().catch(() => { financeExtraPromise = null; return db.finance; });
  }
  return financeExtraPromise;
}

export async function loadFinanceHistory() {
  if (db.finHistory) return db.finHistory;
  try {
    const j = await getJson('finance-history.json');
    db.finHistory = j.data || {};
  } catch (e) {
    throw new Error('历史财报数据没加载成功（离线时需先联网打开过一次回测）。原始错误：' + e.message);
  }
  return db.finHistory;
}

/** 最近年报财务：{eps, roe, nm, liab, ocfps, np, year}，没有返回 null */
export function finOf(code) {
  const a = db.finance?.[code];
  if (!a) return null;
  return { eps: a[0], roe: a[1], nm: a[2], liab: a[3], ocfps: a[4], np: a[5], year: db.finYear };
}

/** 历史年报财务：[{year, eps, roe, nm, liab, ocfps}, ...] */
export function finHistoryOf(code) {
  const rows = db.finHistory?.[code];
  if (!rows) return [];
  return rows.map(([year, eps, roe, nm, liab, ocfps]) => ({ year, eps, roe, nm, liab, ocfps }));
}

export async function loadMonthly() {
  if (db.monthly) return db.monthly;
  try {
    const j = await getJson('monthly.json');
    db.monthly = j.months || {};
  } catch (e) {
    // 月线 6.5MB 不预缓存、也不进首屏：只有「对比模式的红利策略选股」和「起点早于 2014-06」才会用到它
    throw new Error('月线数据没加载成功：只有对比模式的全市场选股、或把回测起点拖到 2014-06 之前才需要这 6.5MB 月线。请联网后重试；只想看自己的组合用日 K 即可，不需要月线。原始错误：' + e.message);
  }
  return db.monthly;
}

/* ---------------- 日 K（联网按需 + 本地回退） ---------------- */

let dailyMeta = null;
let dailyMetaPromise = null;
const dailyCache = new Map();

/** 交易日历：联网拉指数日线（缓存 6h），失败回退本地 daily/meta.json */
export async function loadDailyMeta() {
  if (dailyMeta) return dailyMeta;
  if (dailyMetaPromise) return dailyMetaPromise;
  dailyMetaPromise = (async () => {
    let cal = null;
    let source = 'local';
    try {
      cal = await netCalendar();
      if (cal && cal.length) source = 'network';
    } catch (e) { /* 离线 / 接口失败 */ }
    if (!cal || !cal.length) {
      const j = await getJson('daily/meta.json');
      cal = j.cal || [];
    }
    dailyMeta = { cal, source };
    return dailyMeta;
  })();
  return dailyMetaPromise;
}

/**
 * 单只股票日 K：先用联网（腾讯，不复权），失败回退本地 data/daily/<code>.json。
 * @returns {Promise<{cal:string[],o:number[],h:number[],l:number[],c:number[],v:number[]}|null>}
 */
export async function loadDaily(code) {
  const key = String(code);
  if (dailyCache.has(key)) return dailyCache.get(key);
  const meta = await loadDailyMeta();
  let out = null;
  try {
    out = await netDaily(key, meta.cal);
  } catch (e) { out = null; }
  if (!out) {
    try {
      const j = await getJson(`daily/${key}.json`);
      if (j && Array.isArray(j.c)) out = { cal: meta.cal, o: j.o, h: j.h, l: j.l, c: j.c, v: j.v };
    } catch (e) { out = null; }
  }
  if (out && out.network !== false) out = { ...out, source: out.cal === meta.cal ? 'network' : 'local' };
  dailyCache.set(key, out);
  return out;
}

/** 多只股票的日 K（并发；联网时每只一次请求，失败回退本地） */
export async function loadDailyMany(codes) {
  const uniq = [...new Set(codes.filter((c) => /^\d{6}$/.test(c)))];
  const arr = await Promise.all(uniq.map((c) => loadDaily(c).catch(() => null)));
  const map = new Map();
  uniq.forEach((c, i) => { if (arr[i]) map.set(c, arr[i]); });
  return map;
}

/* ---------------- 行情：快照 + 联网刷新 ---------------- */

function mergeQuotes(qmap) {
  let changed = false;
  for (const [code, q] of Object.entries(qmap || {})) {
    if (!q || !(q.p > 0)) continue;
    const cur = db.quotes[code] || {};
    const next = {
      ...cur,
      n: q.n || cur.n || '',
      p: q.p,
      prev: q.prev ?? cur.prev ?? null,
      date: q.date || cur.date || '',
      pct: q.pct ?? cur.pct ?? null,
    };
    if (next.p !== cur.p || next.prev !== cur.prev || next.n !== cur.n || next.date !== cur.date) changed = true;
    db.quotes[code] = next;
  }
  const d = maxQuoteDate(qmap);
  if (d && d > (db.generated || '')) { db.generated = d; changed = true; }
  if (changed) db.quoteRev++;
  return changed;
}

/** 启动早期：把 10 分钟内的行情缓存先铺上，避免首屏还是旧快照 */
export async function applyQuoteCache() {
  try {
    const hit = await cacheGetQuotes();
    if (!hit || !hit.quotes) return false;
    if (Date.now() - (hit.ts || 0) > 10 * 60 * 1000) return false;
    return mergeQuotes(hit.quotes);
  } catch (e) {
    return false;
  }
}

/**
 * 全市场行情刷新（批量）。成功返回 {ok, count, date, changed}。
 * 失败（离线 / 接口错误）返回 {ok:false}，页面继续用本地快照。
 */
export async function refreshQuotes() {
  if (offline()) return { ok: false, reason: 'offline' };
  const pool = Object.keys(db.baseline?.pool || {});
  const codes = [...new Set([...Object.keys(db.quotes || {}), ...pool])];
  if (!codes.length) return { ok: false, reason: 'empty' };
  try {
    const quotes = await fetchQuotes(codes);
    const count = Object.keys(quotes).length;
    if (!count) return { ok: false, reason: 'empty' };
    const changed = mergeQuotes(quotes);
    await cacheSetQuotes(quotes);
    return { ok: true, count, date: maxQuoteDate(quotes), changed };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 当前股息率分位（预计算，避免加载 6.5MB 月线） */
let dyPctCache = null;
export async function loadDyPct() {
  if (dyPctCache) return dyPctCache;
  dyPctCache = (await getJson('dy-pct.json')).data || {};
  return dyPctCache;
}

/** 中证红利全收益 + 低波全收益日线（2013 起，官方/理杏仁快照） */
let indexDaily = null;
export async function loadIndexDaily() {
  if (indexDaily) return indexDaily;
  indexDaily = await getJson('index-daily.json');
  return indexDaily;
}

export function quote(code) {
  return db.quotes[code] || null;
}

export function nameOf(code) {
  return db.quotes[code]?.n || db.baseline?.pool?.[code]?.n || code;
}

export function dividendsOf(code) {
  return db.baseline?.dividends?.[code] || null;
}

/* 分红索引：baseline.dividends 有 5400+ 只，今天页/选股页每次渲染都要扫全池。
   预先摊平成 Map（一次 O(n)），避免反复 Object.keys + filter + sort。
   baseline 对象被整体替换时自动重建。 */

let divIndexCache = null;

function divIndex() {
  if (divIndexCache && divIndexCache.baseline === db.baseline) return divIndexCache.map;
  const map = new Map();
  for (const [code, d] of Object.entries(db.baseline?.dividends || {})) {
    const years = d.years || {};
    const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
    if (!ys.length) {
      map.set(code, { years, nYears: 0, consecutive: 0, firstY: null, lastY: null, dps: 0 });
      continue;
    }
    const lastY = ys[ys.length - 1];
    let consecutive = 0;
    for (let y = lastY; y >= lastY - 30; y--) {
      if (years[y] > 0) consecutive++;
      else break;
    }
    map.set(code, { years, nYears: ys.length, consecutive, firstY: ys[0], lastY, dps: years[lastY] });
  }
  divIndexCache = { baseline: db.baseline, map };
  return map;
}

/** 分红索引条目（只读），没有该股票时返回 null */
export function divIndexEntry(code) {
  return divIndex().get(String(code)) || null;
}

/** 最近年度每股分红 */
export function lastDps(code) {
  const e = divIndexEntry(code);
  if (!e || e.lastY == null) return null;
  return { year: e.lastY, dps: e.dps };
}

/** 用最新价重算股息率（%） */
export function currentDy(code) {
  const q = quote(code);
  const e = divIndexEntry(code);
  if (!q?.p || !e?.dps) return null;
  return (e.dps / q.p) * 100;
}

/** 最近 N 年每股分红合计 / 连续年数 */
export function divSummary(code) {
  return divIndexEntry(code);
}

/** 数据源概况，给页面脚注 */
export function dataMeta() {
  return {
    quoteDate: db.generated,
    quoteCount: Object.keys(db.quotes).length,
    poolCount: Object.keys(db.baseline?.pool || {}).length,
    divCount: Object.keys(db.baseline?.dividends || {}).length,
    finCount: Object.keys(db.finance || {}).length || Object.keys(db.baseline?.f10 || {}).length,
    monthlyCount: db.monthly ? Object.keys(db.monthly).length : 0,
  };
}
