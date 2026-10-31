/**
 * 联网层：按需拉取行情 / 日 K，可选的 IndexedDB 缓存。
 *
 * 设计：
 *  - 日 K 不再预存全市场，用到哪只拉哪只（腾讯 newfqkline，CORS 已开）；
 *  - 交易日历从 sh000001 日线拉，缓存 6 小时；失败回退本地 data/daily/meta.json；
 *  - 行情用 qt.gtimg.cn 批量（80 只/次，GBK 解码），缓存 10 分钟；
 *  - 用 `?offline=1` 可在页面里强制离线（走本地快照）。
 *
 * 这里只做网络与解析，业务口径在 data.js / engine 里。
 */

const IDB_NAME = 'd3-cache';
const IDB_STORE = 'kv';
const TTL = {
  calendar: 6 * 3600 * 1000,
  daily: 6 * 3600 * 1000,
  quotes: 10 * 60 * 1000,
};

let dbPromise = null;
function idb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

async function cacheGet(key) {
  const store = await idb();
  if (!store) return null;
  return new Promise((resolve) => {
    try {
      const tx = store.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

async function cacheSet(key, value) {
  const store = await idb();
  if (!store) return;
  return new Promise((resolve) => {
    try {
      const tx = store.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch (e) {
      resolve();
    }
  });
}

export function qqCode(code) {
  const c = String(code).padStart(6, '0');
  if (/^[69]/.test(c)) return 'sh' + c;
  if (/^[0-3]/.test(c)) return 'sz' + c;
  return 'sh' + c;
}

export function offline() {
  try {
    return new URLSearchParams(location.search).get('offline') === '1' || navigator.onLine === false;
  } catch (e) {
    return false;
  }
}

async function getJsonCors(url, timeout = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function getText(url, timeout = 12000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return new TextDecoder().decode(buf); }
}

/* ---------------- 日 K ---------------- */

/** 拉一只股票的日 K（不复权）：[{d,o,h,l,c,v}, ...] */
export async function fetchDailyRaw(code, bars = 3000) {
  const qc = qqCode(code);
  const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${qc},day,,,${bars},`;
  const j = await getJsonCors(url);
  const arr = j?.data?.[qc]?.day;
  if (!Array.isArray(arr) || !arr.length) throw new Error('无日线');
  const out = [];
  for (const r of arr) {
    const d = String(r[0]).slice(0, 10);
    const o = Number(r[1]), c = Number(r[2]), h = Number(r[3]), l = Number(r[4]), v = Number(r[5]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || ![o, c, h, l].every((x) => Number.isFinite(x) && x > 0)) continue;
    out.push({ d, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  if (!out.length) throw new Error('无日线');
  return out;
}

/** 交易日历：上证指数近 3000 根日线 dates */
export async function fetchCalendar(bars = 3000) {
  const rows = await fetchDailyRaw('000001', bars);
  return rows.map((r) => r.d);
}

/** 把一只股票的日线对齐到交易日历：返回 {cal,o,h,l,c,v}（缺省 null） */
export function alignDaily(rows, cal) {
  const map = new Map(rows.map((r) => [r.d, r]));
  const o = [], h = [], l = [], c = [], v = [];
  for (const d of cal) {
    const r = map.get(d);
    if (r) { o.push(r.o); h.push(r.h); l.push(r.l); c.push(r.c); v.push(r.v); }
    else { o.push(null); h.push(null); l.push(null); c.push(null); v.push(null); }
  }
  return { cal, o, h, l, c, v };
}

/** 带缓存的日历（失败返回 null） */
export async function netCalendar() {
  if (offline()) return null;
  const hit = await cacheGet('calendar');
  if (hit && Date.now() - hit.ts < TTL.calendar && Array.isArray(hit.cal) && hit.cal.length) return hit.cal;
  try {
    const cal = await fetchCalendar();
    if (cal.length) {
      await cacheSet('calendar', { ts: Date.now(), cal });
      return cal;
    }
  } catch (e) {
    if (hit?.cal?.length) return hit.cal;
  }
  return hit?.cal || null;
}

/** 带缓存的单只日 K（对齐到 cal）；失败返回 null */
export async function netDaily(code, cal) {
  if (offline()) return null;
  const key = 'daily:' + code;
  const hit = await cacheGet(key);
  const last = cal && cal.length ? cal[cal.length - 1] : '';
  if (hit && hit.calLast === last && Date.now() - hit.ts < TTL.daily && Array.isArray(hit.c) && hit.c.length === (cal || []).length) {
    return { cal: hit.cal || cal, o: hit.o, h: hit.h, l: hit.l, c: hit.c, v: hit.v };
  }
  try {
    const rows = await fetchDailyRaw(code);
    if (!cal || !cal.length) return null;
    const aligned = alignDaily(rows, cal);
    await cacheSet(key, { ts: Date.now(), calLast: last, ...aligned });
    return aligned;
  } catch (e) {
    if (hit && hit.c && hit.c.length === (cal || []).length) return { cal: hit.cal || cal, o: hit.o, h: hit.h, l: hit.l, c: hit.c, v: hit.v };
    return null;
  }
}

/* ---------------- 行情 ---------------- */

/** 解析 qt.gtimg.cn 返回文本：v_sh600036="1~招商银行~..."; */
export function parseQuotesText(text) {
  const out = {};
  const re = /v_([a-z]{2})(\d{6})="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const code = m[2];
    const p = m[3].split('~');
    if (p.length < 33) continue;
    const price = Number(p[3]);
    if (!(price > 0)) continue;
    const prev = Number(p[4]);
    const date = /^\d{8}/.test(p[30] || '') ? `${p[30].slice(0, 4)}-${p[30].slice(4, 6)}-${p[30].slice(6, 8)}` : '';
    out[code] = {
      n: p[1] || '',
      p: price,
      prev: Number.isFinite(prev) && prev > 0 ? prev : null,
      date,
      pct: Number(p[32]) || null,
    };
  }
  return out;
}

/** 批量拉行情：codes → {code:{n,p,prev,date,pct}} */
export async function fetchQuotes(codes, { chunk = 80, concurrency = 5 } = {}) {
  if (offline()) return {};
  const list = codes.filter((c) => /^\d{6}$/.test(c));
  const chunks = [];
  for (let i = 0; i < list.length; i += chunk) chunks.push(list.slice(i, i + chunk));
  const out = {};
  let idx = 0;
  async function worker() {
    while (idx < chunks.length) {
      const part = chunks[idx++];
      const url = 'https://qt.gtimg.cn/q=' + part.map(qqCode).join(',');
      try {
        const text = await getText(url);
        Object.assign(out, parseQuotesText(text));
      } catch (e) { /* 单批失败不影响其他 */ }
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

/** 行情批量：同一批 80 只做并发，返回最大日期 */
export function maxQuoteDate(quotes) {
  let d = '';
  for (const q of Object.values(quotes || {})) if (q.date && q.date > d) d = q.date;
  return d;
}

export const quoteCacheKey = 'quotes:v1';

export async function cacheGetQuotes() {
  const hit = await cacheGet(quoteCacheKey);
  if (!hit || !hit.ts || !hit.quotes) return null;
  return hit;
}

export async function cacheSetQuotes(quotes) {
  await cacheSet(quoteCacheKey, { ts: Date.now(), quotes });
}
