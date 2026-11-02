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
  baseline: { pool: {}, dividends: {}, f10: {}, holdings: [] },  // 按需填充：见 loadPool / ensureDividends
  benchmark: {},    // {ym: value}
  monthly: null,    // {code:[[ym,close]]}
  finance: null,    // {code:[eps,roe,nm,liab,ocfps,np]} 最近年报
  finYear: null,
  finHistory: null, // {code:[[year,eps,roe,nm,liab,ocfps],...]}（按分片累积）
  finDegraded: false, // 财报分片有拉失败的（慢网断流）→ 回测降级为不做质量筛选
  financeExtraLoaded: false, // 个股页按需加载的净利率/负债率/净利润是否已合并
  generated: '',
};

/**
 * 取 JSON。慢网下大文件会断流，所以带超时 + 一次重试；
 * 仍然失败就把原始错误抛给调用方，由调用方决定降级还是报错。
 */
async function getJson(f, { timeout = 20000, retry = 1 } = {}) {
  let last;
  for (let i = 0; i <= retry; i++) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeout) : undefined;
      const res = await fetch(dataUrl(f), { cache: 'no-cache', signal });
      if (!res.ok) throw new Error(`${f} HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < retry) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last;
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
  const [quotes, benchmark, finance] = await Promise.all([
    getJson('quotes.json'),
    getJson('benchmark.json'),
    // 首屏只要 eps/roe/ocfps（质量闸门），净利润/净利率/负债率由个股页按需加载
    getJson('finance-core.json').catch(() => getJson('finance-current.json').catch(() => ({ year: null, data: {} }))),
  ]);
  db.quotes = quotes.quotes || {};
  db.generated = quotes.generated || '';
  // baseline 不再整包加载：分红改成一只一个文件，按当前持仓/自选按需拉
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

/* ---------------- 历年财报：一只一个文件，要哪只拉哪只 ---------------- */

/** 已经装进 db.finHistory 的股票代码，不重复下。 */
const finDone = new Set();
let finAllPromise = null;

/**
 * 历年财报 {code: [[year,eps,roe,nm,liab,ocfps],...]}。
 *
 * 传 codes → **只拉这几只**：data/fin/<code>.json，一只约 0.5KB（gzip 471B）。
 *            个股回测 601398 就只下 601398 这一个文件；组合 8 只就下 8 个。
 * 不传     → 才下整包 finance-history.json（4.3MB）。只有对比模式的「红利策略 20 只」
 *            要从全市场 2800 只里筛，非它不可。
 * 任何一只失败都不抛错：返回已拿到的部分，db.finDegraded 置 true，由页面提示降级。
 */
export async function loadFinanceHistory(codes = null) {
  db.finHistory = db.finHistory || {};

  if (!codes || !codes.length) {
    if (!finAllPromise) {
      finAllPromise = getJson('finance-history.json', { timeout: 45000 })
        .then((j) => j.data || {})
        .catch(() => null);
    }
    const all = await finAllPromise;
    if (all) Object.assign(db.finHistory, all);
    else db.finDegraded = true;
    return db.finHistory;
  }

  const todo = [...new Set(codes.map(String))].filter((c) => /^\d{6}$/.test(c) && !finDone.has(c));
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async (c) => {
      try {
        const rows = await getJson(`fin/${c}.json`, { timeout: 12000 });
        if (Array.isArray(rows)) db.finHistory[c] = rows;
        finDone.add(c);
      } catch (e) {
        db.finDegraded = true;
      }
    }));
  }
  return db.finHistory;
}

/** 财报是否整包拿过（对比模式的全市场选股需要） */
export function financeHistoryComplete() {
  return !db.finDegraded && finDone.size > 0;
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
    const j = await getJson('monthly.json', { timeout: 120000 });
    // 空壳（网络失败被 SW 兜成 {}）不能当「加载成功」，否则会把空数据永久记进 db.monthly
    if (!j || !j.months || !Object.keys(j.months).length) throw new Error('返回的是空数据');
    db.monthly = j.months;
  } catch (e) {
    // 月线 6.4MB 不预缓存、也不进首屏：只有「对比模式的红利策略选股」和「起点早于 2014-06」才会用到它
    throw new Error('月线数据没加载成功：只有对比模式的全市场选股、或把回测起点拖到 2014-06 之前才需要这 6.5MB 月线。请联网后重试；只想看自己的组合用日 K 即可，不需要月线。原始错误：' + e.message);
  }
  return db.monthly;
}

/* ---------------- 组合对比专用的小数据 ----------------
   那个页面原来要 monthly 6.4MB + finance-history 4.3MB（gzip 3.3MB），
   手机 30KB/s 下 110 秒、20 秒就超时。其实它需要的只有三样，都由
   tools/build-cmp-data.mjs 生成：
     cmp-yearly.json  每年 4 月末收盘价（选股用）          gzip ≈ 78KB
     cmp-fin.json     选股用的 eps/roe/ocfps               gzip ≈ 257KB
     monthly/<code>.json  选中那几十只的完整月线（净值用）  每只 2.3KB
   合计 ≈ 400KB，快十倍。 */

const cmpCache = {};

/** 全市场「每年 4 月末收盘价」→ {code: [[ym, close]]}（稀疏，只服务选股） */
export async function loadCmpScreen() {
  if (cmpCache.screen) return cmpCache.screen;
  const j = await getJson('cmp-yearly.json', { timeout: 45000 });
  if (!j || !j.d) throw new Error('对比数据没加载成功（cmp-yearly.json）');
  const years = j.y || [];
  const out = {};
  for (const [code, arr] of Object.entries(j.d)) {
    const rows = [];
    for (let i = 0; i < arr.length; i++) if (arr[i] != null) rows.push([years[i] + '-04', arr[i]]);
    if (rows.length) out[code] = rows;
  }
  cmpCache.screen = out;
  return out;
}

/** 选股用的财报（只含 eps / roe / ocfps），格式与 finance-history 的 6 槽一致 */
export async function loadCmpFin() {
  if (cmpCache.fin) return cmpCache.fin;
  const j = await getJson('cmp-fin.json', { timeout: 45000 });
  if (!j || !j.c) throw new Error('对比数据没加载成功（cmp-fin.json）');
  const out = {};
  for (const [code, rows] of Object.entries(j.c)) {
    // [年, eps, roe, 净利率, 负债率, ocfps] —— 中间两槽选股用不到，占位 null
    out[code] = rows.map((r) => [r[0], r[1], r[2], null, null, r[3]]);
  }
  cmpCache.fin = out;
  return out;
}

/** 指定股票的完整月线（data/monthly/<code>.json，每只约 2.3KB）
 *
 * 返回的是「请求的这些股票里所有能拿到的」，不只是本次新下载的：
 * 页面重渲染时会再问一遍，若只回新下载的，第二次就全是空的（净值曲线会变成一条水平线）。 */
export async function loadMonthlyFor(codes) {
  const uniq = [...new Set((codes || []).map(String))].filter((c) => /^\d{6}$/.test(c));
  cmpCache.mon = cmpCache.mon || {};
  const todo = uniq.filter((c) => !cmpCache.mon[c]);
  for (let i = 0; i < todo.length; i += 12) {
    await Promise.all(todo.slice(i, i + 12).map(async (c) => {
      try { cmpCache.mon[c] = await getJson(`monthly/${c}.json`, { timeout: 15000 }); } catch (e) { /* 缺一只不影响整页 */ }
    }));
  }
  const out = {};
  for (const c of uniq) if (cmpCache.mon[c]) out[c] = cmpCache.mon[c];
  return out;
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
 * @returns {Promise<{cal:string[],c:number[]}|null>} 只有收盘价：回测和图表都只用收盘
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
      // 本地日 K 只存收盘：{ c: [...] }（对齐 meta.cal，停牌为 null）
      const j = await getJson(`daily/${key}.json`);
      if (j && Array.isArray(j.c)) out = { cal: meta.cal, c: j.c };
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

   ⚠ 失效判断必须用版本号，不能用对象身份：db.baseline 从不整体替换，
   只往 db.baseline.dividends 里塞属性（loadPool / ensureDividends），
   引用永远不变。以前判 `=== db.baseline`，索引就停在第一次建立那一刻——
   先看个股页（只加载 1 只分红）再进今天页，全市场候选会塌成 0 只。 */

let divIndexCache = null;
let divRev = 0;   // 每往 db.baseline.dividends 写一次就 +1

/** 分红数据变了：作废索引，下次取用重建 */
function touchDividends() {
  divRev++;
}

function divIndex() {
  // 两道判据都要过：版本号（属性追加，生产路径）与对象身份（整体替换，测试/重置路径）
  if (divIndexCache && divIndexCache.rev === divRev && divIndexCache.baseline === db.baseline) {
    return divIndexCache.map;
  }
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
  divIndexCache = { rev: divRev, baseline: db.baseline, map };
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

/* ---------------- 分红 / 股票池：一只一个文件，按当前持仓动态拉 ---------------- */

/** 已经拉过分红的股票（组合增删后只补新出现的，不重复下） */
const divDone = new Set();
let poolPromise = null;

/**
 * 全市场股票池（代码 → 名称/行业/市值）。只有今天页和选股页需要遍历全市场。
 * 返回 {pool, f10, holdings}；回测页/个股页不要调这个。
 */
export async function loadPool() {
  if (db.baseline.poolReady) return db.baseline;
  if (!poolPromise) {
    poolPromise = (async () => {
      const [pool, base] = await Promise.all([
        getJson('pool.json', { timeout: 30000 }).catch(() => ({})),
        getJson('baseline.json', { timeout: 45000 }).catch(() => null),
      ]);
      db.baseline.pool = pool || {};
      if (base) {
        db.baseline.f10 = base.f10 || {};
        db.baseline.holdings = base.holdings || [];
        // 今天页要全市场算股息率，全量分红还是要的；但只给这两个页面用。
        //
        // ⚠ baseline.json 里的 dividends 只有 years（年度合计），没有 ev（逐笔除权日）。
        // 回测引擎只认 ev，直接灌进来会让回测「一分分红都不算」。所以：
        //   · 已经有该股（ensureDividends 先拉过，带 ev）→ 一个字段都不许覆盖
        //   · 没有该股 → 灌 years 占位，ev 留给 ensureDividends 按需补
        const cur = db.baseline.dividends;
        for (const [code, d] of Object.entries(base.dividends || {})) {
          if (!cur[code]) cur[code] = d;
          else if (cur[code].years == null && d.years) cur[code].years = d.years;
        }
        touchDividends();
      }
      db.baseline.poolReady = true;
      return db.baseline;
    })();
  }
  return poolPromise;
}

/**
 * 按需拉分红：把当前持仓（或自选、或单只个股）的历年分红只拉这几只。
 *
 * 组合是会增删改的——所以这里每次按传入的 codes 算差集：
 * 已经拉过的跳过，新加的股票才发请求。用户改完组合再进回测，只会补下新增那几只。
 */
export async function ensureDividends(codes) {
  // 不要因为「池子加载过」就跳过：loadPool 灌进来的 years 没有 ev，
  // 而回测只认 ev。这里靠 divDone 去重，缺 ev 的照样补拉（每只几 KB）。
  const todo = [...new Set((codes || []).map(String))]
    .filter((c) => /^\d{6}$/.test(c) && !divDone.has(c) && !hasEv(c));
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async (c) => {
      try {
        const j = await getJson(`div/${c}.json`, { timeout: 12000 });
        // years 给股息率/质量用；ev 是每一笔的「除权除息日 + 每股派息」，个股定投靠它按日复投
        if (j && j.years) db.baseline.dividends[c] = { years: j.years, ev: j.ev };
        divDone.add(c);
        touchDividends();
      } catch (e) { /* 没有分红记录：页面按「无」处理 */ }
    }));
  }
  return db.baseline.dividends;
}

/** 这只股票的分红里是否已经有逐笔除权日（ev） */
function hasEv(code) {
  const d = db.baseline?.dividends?.[code];
  return !!(d && Array.isArray(d.ev) && d.ev.length);
}

/** 分红数据里有没有逐笔除权日——回测用它判断「这只到底取到明细没有」 */
export function hasDivEvents(code) {
  return hasEv(String(code));
}
