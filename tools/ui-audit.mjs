/**
 * 真机浏览器审计（无头 Chrome CDP，默认端口 9223，可用 D3_CDP_PORT 覆盖）。
 *
 * 用法：
 *   node tools/ui-audit.mjs routes mobile forms dirty offline evidence theme probe verify offline-real
 *   不带参数 = 全部跑。结果 JSON / 截图写入 ../report/design/audit/。
 *
 * 前置：8766 静态服务在跑；9223 上是**专用**无头 Chrome（独立 --user-data-dir）。
 * 注意：脚本会真实读写该浏览器的 localStorage(d3:*) 和 Service Worker，用于测试脏数据/离线；
 * 结束时（含异常退出）会把 d3:* 恢复为运行前快照，但请勿对日常使用的浏览器 profile 运行。
 * 产物（_results-*.json / *.png）建议加入 .gitignore，不要随代码提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'report/design/audit');
fs.mkdirSync(OUT, { recursive: true });

const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHASES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const RUN_ALL = PHASES.length === 0;
const want = (p) => RUN_ALL || PHASES.includes(p);

let bust = 0;
let view = { w: 1280, h: 1000, mobile: false, dpr: 1 };

/* ------------------------------------------------------------------ */
/* 页面内注入的审计工具（导航前注入，刷新不丢）                        */
/* ------------------------------------------------------------------ */

function auditHelpers() {
  const vis = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    for (let i = 0; i < 5 && cur && cur !== document.body && cur.nodeType === 1; i++) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) { p += '#' + cur.id; parts.unshift(p); break; }
      const cls = [...cur.classList].slice(0, 2).map((c) => '.' + c).join('');
      p += cls;
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((x) => x.tagName === cur.tagName);
        if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(p);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const scrollableAncestor = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflowY)) return p;
      p = p.parentElement;
    }
    return null;
  };
  const parse = (c) => {
    const m = String(c || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (el) => {
    let cur = el;
    const stack = [];
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c && c.a > 0.01) { stack.push(c); if (c.a >= 0.99) break; }
      cur = cur.parentElement;
    }
    let out = { r: 10, g: 13, b: 16, a: 1 };
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    if (bodyBg && bodyBg.a > 0.5) out = blend(bodyBg, out);
    for (let i = stack.length - 1; i >= 0; i--) out = blend(stack[i], out);
    return out;
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };

  window.__audit = {
    sel, vis, scrollableAncestor,
    styleOf(selector) {
      const el = document.querySelector(selector);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      const bg = bgOf(el);
      const eff = fg && fg.a < 1 ? blend(fg, bg) : fg;
      const cr = fg ? ratio(eff, bg) : null;
      return {
        sel: selector,
        text: (el.textContent || '').trim().slice(0, 40),
        color: cs.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        fontSize: parseFloat(cs.fontSize) || null,
        ratio: cr == null ? null : Math.round(cr * 100) / 100,
      };
    },
    cssVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    },
    media(expr) { try { return matchMedia(expr).matches; } catch (e) { return null; } },
    mobile() {
      const iw = window.innerWidth;
      const docOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - iw;
      const overflowing = [];
      const clipped = [];
      const smallTargets = [];
      const charts = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        const sc = scrollableAncestor(el);
        if (!sc && (r.right > iw + 1 || r.left < -1)) {
          overflowing.push({
            sel: sel(el), left: Math.round(r.left), right: Math.round(r.right),
            w: Math.round(r.width), h: Math.round(r.height),
            over: Math.round(r.right - iw), area: Math.round((r.right - iw) * r.height),
            text: (el.textContent || '').trim().slice(0, 40),
          });
        }
        const cs = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 2 && !/(auto|scroll)/.test(cs.overflowX) && el.clientWidth > 100 && (el.textContent || '').trim().length > 3) {
          clipped.push({ sel: sel(el), scrollW: el.scrollWidth, clientW: el.clientWidth, overflowX: cs.overflowX, text: (el.textContent || '').trim().slice(0, 60) });
        }
        if (el.scrollHeight > el.clientHeight + 3 && !/(auto|scroll)/.test(cs.overflowY) && el.clientHeight > 24 && (el.textContent || '').trim().length > 3) {
          clipped.push({ sel: sel(el), scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: cs.overflowY, text: (el.textContent || '').trim().slice(0, 60) });
        }
        const tag = el.tagName;
        const interactive = tag === 'BUTTON' || tag === 'A' || el.getAttribute('role') === 'button'
          || (tag === 'INPUT' && el.type !== 'hidden' && el.type !== 'file')
          || el.classList.contains('view-tab') || el.classList.contains('chip') || el.classList.contains('icon-star')
          || el.classList.contains('pick-item') || el.classList.contains('tab');
        if (interactive && (r.width < 32 || r.height < 32)) {
          smallTargets.push({
            sel: sel(el),
            text: (el.textContent || el.value || el.getAttribute('aria-label') || el.title || '').trim().slice(0, 30),
            w: Math.round(r.width), h: Math.round(r.height),
          });
        }
        if (tag === 'CANVAS' || el.classList.contains('chart')) {
          charts.push({ sel: sel(el), w: Math.round(r.width), h: Math.round(r.height), containerW: el.parentElement ? Math.round(el.parentElement.getBoundingClientRect().width) : 0, canvasW: el.width || 0 });
        }
      }
      overflowing.sort((a, b) => b.area - a.area);
      return {
        iw, docOverflow, overflowCount: overflowing.length, overflowing: overflowing.slice(0, 12),
        clippedCount: clipped.length, clipped: clipped.slice(0, 12),
        smallTargetCount: smallTargets.length, smallTargets: smallTargets.slice(0, 12), charts,
      };
    },
    badText() {
      const t = document.body.innerText || '';
      const hits = [];
      const re = /NaN|Infinity|undefined|\[object Object\]/g;
      let m;
      while ((m = re.exec(t))) {
        const s = Math.max(0, m.index - 40);
        hits.push(t.slice(s, m.index + 30).replace(/\s+/g, ' ').trim());
        if (hits.length >= 8) break;
      }
      return hits;
    },
    contrast() {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!vis(el)) continue;
        const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (!direct) continue;
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        if (!fg || fg.a === 0) continue;
        const bg = bgOf(el);
        const eff = fg.a < 1 ? blend(fg, bg) : fg;
        const size = parseFloat(cs.fontSize) || 14;
        const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const cr = ratio(eff, bg);
        if (cr < (large ? 3 : 4.5)) {
          out.push({
            sel: sel(el), text: (el.textContent || '').trim().slice(0, 50), color: cs.color,
            bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
            size, bold, ratio: Math.round(cr * 100) / 100, large,
          });
        }
      }
      out.sort((a, b) => a.ratio - b.ratio);
      return out.slice(0, 20);
    },
  };
}
const HELPER_SRC = `(${auditHelpers.toString()})();`;

/* ------------------------------------------------------------------ */
/* CDP 连接                                                            */
/* ------------------------------------------------------------------ */

let ws = null;
let sendRaw = null;
let evalJs = null;
const ev = {
  console: [],
  warnings: [],
  exceptions: [],
  httpErrors: [],
  failed: [],
  logs: [],
};
const reqUrl = new Map();

function fmtArg(a) {
  if (!a) return '';
  if ('value' in a) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return a.description || a.type || '';
}

async function connect() {
  const PORT = process.env.D3_CDP_PORT || '9223';
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on ' + PORT);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map(fmtArg).join(' ');
      if (m.params.type === 'error') ev.console.push(text);
      else if (m.params.type === 'warning') ev.warnings.push(text);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      ev.exceptions.push((d.exception?.description || d.text || '') + (d.url ? ` @${d.url}:${(d.lineNumber ?? 0) + 1}` : ''));
    }
    if (m.method === 'Network.requestWillBeSent') reqUrl.set(m.params.requestId, m.params.request.url);
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400) ev.httpErrors.push({ url: r.url, status: r.status, type: m.params.type });
    }
    if (m.method === 'Network.loadingFailed') {
      const url = reqUrl.get(m.params.requestId) || '';
      if (m.params.errorText !== 'net::ERR_ABORTED') ev.failed.push({ url, error: m.params.errorText });
      reqUrl.delete(m.params.requestId);
    }
    if (m.method === 'Log.entryAdded') {
      const en = m.params.entry || {};
      if (en.level === 'error') ev.logs.push({ text: en.text, url: en.url, source: en.source });
    }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  sendRaw = (method, params = {}, timeout = 25000) => new Promise((res, rej) => {
    const my = ++id;
    const t = setTimeout(() => { pending.delete(my); rej(new Error(method + ' timeout')); }, timeout);
    pending.set(my, (m) => { clearTimeout(t); if (m.error) rej(new Error(method + ': ' + JSON.stringify(m.error))); else res(m.result); });
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  evalJs = async (expression, timeout = 20000) => {
    const r = await sendRaw('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  await sendRaw('Page.enable');
  await sendRaw('Runtime.enable');
  await sendRaw('Network.enable');
  await sendRaw('Log.enable');
  await sendRaw('Network.setCacheDisabled', { cacheDisabled: true });
  await sendRaw('Page.addScriptToEvaluateOnNewDocument', { source: HELPER_SRC });
}

const mark = () => ({ c: ev.console.length, w: ev.warnings.length, e: ev.exceptions.length, h: ev.httpErrors.length, f: ev.failed.length, l: ev.logs.length });
const isLocalUrl = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u || '');
function collect(m) {
  const localHttp = ev.httpErrors.slice(m.h).filter((x) => isLocalUrl(x.url));
  const extHttp = ev.httpErrors.slice(m.h).filter((x) => !isLocalUrl(x.url));
  const localFail = ev.failed.slice(m.f).filter((x) => isLocalUrl(x.url));
  const extFail = ev.failed.slice(m.f).filter((x) => !isLocalUrl(x.url));
  return {
    console: ev.console.slice(m.c),
    warnings: ev.warnings.slice(m.w),
    exceptions: ev.exceptions.slice(m.e),
    httpErrors: localHttp,
    extHttpErrors: extHttp,
    failed: localFail,
    extFailed: extFail,
    logs: ev.logs.slice(m.l),
  };
}
function errorsOf(r) {
  return r.console.length + r.exceptions.length + r.httpErrors.length + r.failed.length + r.logs.length;
}
function fmtErrors(r, n = 4) {
  return [...r.console, ...r.exceptions, ...r.httpErrors.map((x) => `HTTP ${x.status} ${x.url}`), ...r.failed.map((x) => `FAIL ${x.error} ${x.url}`), ...r.logs.map((x) => `LOG ${x.text}`)].slice(0, n);
}

/* ------------------------------------------------------------------ */
/* 页面操作                                                            */
/* ------------------------------------------------------------------ */

function siteUrl(hash, { theme = 'dark', nosw = true } = {}) {
  return `${SITE}?theme=${theme}${nosw ? '&nosw=1' : ''}&t=${++bust}${hash}`;
}

async function setViewport(w, h, mobile = false, dpr = 1) {
  view = { w, h, mobile, dpr };
  await sendRaw('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
  // 移动端同时启用触摸仿真，让 CSS 的 @media (pointer: coarse) 生效（点击区域/悬停态）
  try {
    await sendRaw('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 0 });
  } catch (e) { /* 老版本 Chrome 忽略 */ }
}

const WAIT_PAGE = `!!document.querySelector('.page-title') || !!document.querySelector('.banner.warn')`;

async function waitFor(expr, timeout = 25000, poll = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evalJs(expr, 5000)) return Date.now() - t0; } catch (e) { /* context may be destroyed */ }
    await sleep(poll);
  }
  return -1;
}

async function navigate(hash, { theme = 'dark', nosw = true, waitExpr = null, settle = 600, timeout = 25000 } = {}) {
  const m = mark();
  const t0 = Date.now();
  let attempts = 0;
  let ok = false;
  for (; attempts < 3 && !ok; attempts++) {
    if (attempts === 0) {
      await sendRaw('Page.navigate', { url: siteUrl(hash, { theme, nosw }) }, timeout);
    } else {
      // 偶发本地连接重置（node http.server / headless 环境）→ 整页重载再等
      console.log(`   [retry ${attempts}] ${hash}`);
      try { await sendRaw('Page.reload', { ignoreCache: true }, timeout); } catch (e) {}
    }
    await waitFor(WAIT_PAGE, attempts === 0 ? timeout : Math.min(15000, timeout));
    ok = await evalJs(`!!document.querySelector('.page-title') || !!document.querySelector('.banner.warn')`).catch(() => false);
    if (ok && waitExpr) {
      const r = await waitFor(waitExpr, 15000);
      if (r < 0) ok = false;
    }
  }
  if (settle) await sleep(settle);
  return { ms: Date.now() - t0, mark: m, attempts, retried: attempts > 1 };
}

async function pageInfo() {
  return evalJs(`(()=>{
    const app = document.getElementById('app');
    const warn = document.querySelector('.banner.warn');
    return {
      pageTitle: (document.querySelector('.page-title')||{}).textContent || '',
      docTitle: document.title,
      appLen: (app && app.innerHTML || '').length,
      textLen: (document.body.innerText || '').trim().length,
      warn: warn ? warn.textContent.trim().slice(0, 200) : '',
      body: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
      scrollH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    };
  })()`);
}

async function screenshot(name, { fullPage = false, h } = {}) {
  try {
    let height = view.h;
    if (fullPage || h) {
      const contentH = h || await evalJs('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)').catch(() => view.h);
      height = Math.min(6000, Math.max(view.h, Number(contentH) || view.h));
      await sendRaw('Emulation.setDeviceMetricsOverride', { width: view.w, height, deviceScaleFactor: view.dpr, mobile: view.mobile });
      await sleep(350);
      await evalJs('window.scrollTo(0,0)').catch(() => {});
      await sleep(250);
    }
    let shot = null;
    for (let i = 0; i < 3; i++) {
      try { shot = await sendRaw('Page.captureScreenshot', { format: 'png' }, 20000); } catch (e) { shot = null; }
      if (shot?.data && shot.data.length > 5000) break;
      await sleep(500);
    }
    if (shot?.data) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
    if (height !== view.h) {
      await sendRaw('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: view.dpr, mobile: view.mobile });
      await sleep(250);
    }
    return !!shot?.data;
  } catch (e) {
    console.log('  screenshot failed', name, e.message);
    return false;
  }
}

async function setVal(sel, value) {
  return evalJs(`(()=>{
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOEL';
    el.focus?.();
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
}

async function clickSel(sel) {
  return evalJs(`(()=>{
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOEL';
    el.click();
    return 'ok';
  })()`);
}

async function toastText() {
  return evalJs(`(document.getElementById('toast')?.textContent || '').trim()`);
}

async function toastState() {
  return evalJs(`(()=>{const el=document.getElementById('toast'); return {text:(el?.textContent||'').trim(), visible: !!el && el.classList.contains('show')};})()`);
}

async function readLS(key) {
  return evalJs(`(()=>{ try { return localStorage.getItem(${JSON.stringify(key)}); } catch(e) { return null; } })()`);
}
async function setLS(key, value) {
  return evalJs(`(()=>{ localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; })()`);
}
async function writeJSON(name, data) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
}

/* ------------------------------------------------------------------ */
/* 阶段 1：路由全覆盖                                                  */
/* ------------------------------------------------------------------ */

const ROUTES = [
  { hash: '#today', name: 'today', title: '今天', wait: `document.querySelectorAll('.chart canvas, .hero').length>0 || (document.querySelector('.page-title')||{}).textContent==='今天'` },
  { hash: '#scan', name: 'scan', title: '选股', wait: `document.querySelectorAll('.scan-table tbody tr').length>10` },
  { hash: '#scan?view=cond', name: 'scan-cond', title: '选股', wait: `!!document.getElementById('cfApply')` },
  { hash: '#scan?view=cmp&cmp=600036,601318,600941', name: 'scan-cmp', title: '选股', wait: `document.querySelectorAll('[data-cmp]').length>0` },
  { hash: '#scan?view=watch', name: 'scan-watch', title: '选股', wait: `(document.querySelector('.page-title')||{}).textContent==='选股'` },
  { hash: '#stock?code=600036', name: 'stock', title: '个股', wait: `document.querySelectorAll('.chart canvas').length>0` },
  { hash: '#backtest', name: 'backtest', title: '回测', wait: `document.querySelectorAll('.chart canvas').length>0` },
  { hash: '#backtest?mode=stock&code=601398', name: 'backtest-stock', title: '回测', wait: `document.querySelectorAll('.chart canvas').length>0` },
  { hash: '#backtest?mode=cmp', name: 'backtest-cmp', title: '回测', wait: `(document.querySelector('.page-title')||{}).textContent==='回测'` },
  { hash: '#mine', name: 'mine', title: '我的组合', wait: `document.querySelectorAll('[data-mview]').length>0` },
  { hash: '#mine?view=plans', name: 'mine-plans', title: '我的组合', wait: `document.querySelectorAll('[data-mview]').length>0` },
  { hash: '#mine?view=holdings', name: 'mine-holdings', title: '我的组合', wait: `document.querySelectorAll('[data-mview]').length>0` },
  { hash: '#mine?view=settings', name: 'mine-settings', title: '我的组合', wait: `!!document.getElementById('setCash')` },
];

const routeExtra = {
  today: `(()=>({sections: document.querySelectorAll('.panel').length, hero: (document.querySelector('.hero-num, .hero')||{}).textContent||''}))()`,
  scan: `(()=>({rows: document.querySelectorAll('.scan-table tbody tr').length, stars: document.querySelectorAll('.icon-star').length}))()`,
  'scan-cond': `(()=>({condCount: (document.querySelector('.cond-count')||{}).textContent||''}))()`,
  'scan-cmp': `(()=>({chips: document.querySelectorAll('[data-cmp]').length, canvas: document.querySelectorAll('#cmpChart canvas').length}))()`,
  'scan-watch': `(()=>({empty: (document.querySelector('.empty-block')||{}).textContent||''}))()`,
  stock: `(()=>({name: (document.querySelector('.page-title')||{}).textContent||'', canvas: document.querySelectorAll('.chart canvas').length, addWatch: !!document.getElementById('addWatch'), addPort: !!document.getElementById('addPort')}))()`,
  backtest: `(()=>({canvas: document.querySelectorAll('.chart canvas').length, tabs: document.querySelectorAll('[data-btmode]').length, hero: (document.querySelector('.hero-line')||{}).textContent||''}))()`,
  'backtest-stock': `(()=>({canvas: document.querySelectorAll('.chart canvas').length, kicker: (document.querySelector('.kicker, .bt-kicker')||{}).textContent||''}))()`,
  'backtest-cmp': `(()=>({canvas: document.querySelectorAll('.chart canvas').length, rows: document.querySelectorAll('.table tbody tr').length}))()`,
  mine: `(()=>({tabs: document.querySelectorAll('[data-mview]').length, lots: document.querySelectorAll('.lot-table tbody tr').length, hero: (document.querySelector('.hero-num, .hero')||{}).textContent||''}))()`,
  'mine-plans': `(()=>({tabs: document.querySelectorAll('[data-mview]').length, cards: document.querySelectorAll('.plan-card').length, empty: (document.querySelector('.empty-block')||{}).textContent||''}))()`,
  'mine-holdings': `(()=>({tabs: document.querySelectorAll('[data-mview]').length, body: (document.getElementById('app')||{}).className||''}))()`,
  'mine-settings': `(()=>({health: document.querySelectorAll('.health-cell').length}))()`,
};

async function phaseRoutes() {
  await setViewport(1280, 1000, false, 1);
  const out = [];
  for (const r of ROUTES) {
    let res = { name: r.name, hash: r.hash };
    try {
      const nav = await navigate(r.hash, { waitExpr: r.wait, timeout: 35000, settle: 500 });
      const info = await pageInfo();
      const extra = routeExtra[r.name] ? await evalJs(routeExtra[r.name]).catch((e) => ({ evalError: e.message })) : null;
      const errors = collect(nav.mark);
      const white = !info.pageTitle && !info.warn;
      res = { ...res, loadMs: nav.ms, info, extra, errors, white };
      if (white || errorsOf(errors) > 0) await screenshot('route-' + r.name);
    } catch (e) {
      res.error = e.message;
      res.white = true;
      await screenshot('route-' + r.name + '-crash');
    }
    console.log(`${res.white ? 'P0' : 'OK '} ${r.name.padEnd(16)} title=${JSON.stringify(res.info?.pageTitle || '')} load=${res.loadMs ?? '-'}ms errs=${res.errors ? errorsOf(res.errors) : (res.error ? 'EXC' : '?')} ${res.extra ? JSON.stringify(res.extra).slice(0, 120) : ''}`);
    if (res.errors && errorsOf(res.errors)) console.log('    ', fmtErrors(res.errors, 3));
    out.push(res);
  }
  await writeJSON('_results-routes.json', out);
  return out;
}

/* ------------------------------------------------------------------ */
/* 阶段 2：移动端 390x844                                              */
/* ------------------------------------------------------------------ */

const MOBILE_PAGES = [
  { hash: '#today', name: 'today', wait: `document.querySelectorAll('.panel').length>0` },
  { hash: '#scan', name: 'scan', wait: `document.querySelectorAll('.scan-table tbody tr').length>10` },
  { hash: '#scan?view=cmp&cmp=600036,601318,600941', name: 'scan-cmp', wait: `document.querySelectorAll('[data-cmp]').length>0` },
  { hash: '#stock?code=600036', name: 'stock', wait: `!!document.getElementById('addPort')` },
  { hash: '#backtest', name: 'backtest', wait: `document.querySelectorAll('.chart canvas').length>0` },
  { hash: '#backtest?mode=stock&code=601398', name: 'backtest-stock', wait: `document.querySelectorAll('.chart canvas').length>0` },
  { hash: '#mine', name: 'mine', wait: `document.querySelectorAll('[data-mview]').length>0` },
  { hash: '#mine?view=plans', name: 'mine-plans', wait: `document.querySelectorAll('[data-mview]').length>0` },
  { hash: '#mine?view=settings', name: 'mine-settings', wait: `!!document.getElementById('setCash')` },
];

async function phaseMobile() {
  await setViewport(390, 844, true, 1);
  const out = [];
  for (const p of MOBILE_PAGES) {
    let res = { name: p.name, hash: p.hash };
    try {
      const nav = await navigate(p.hash, { waitExpr: p.wait, timeout: 35000, settle: 700 });
      const info = await pageInfo();
      const m = await evalJs('__audit.mobile()');
      const bad = await evalJs('__audit.badText()');
      const errors = collect(nav.mark);
      await screenshot('mobile-' + p.name, { fullPage: true });
      res = { ...res, info, mobile: m, badText: bad, errors, white: !info.pageTitle && !info.warn };
    } catch (e) {
      res.error = e.message;
      res.white = true;
      await screenshot('mobile-' + p.name + '-crash', { fullPage: true });
    }
    console.log(`${res.white ? 'P0' : 'OK '} mobile ${p.name.padEnd(14)} overflow=${res.mobile?.docOverflow ?? '?'}px flatCount=${res.mobile?.overflowCount ?? '?'} clipped=${res.mobile?.clippedCount ?? '?'} small=${res.mobile?.smallTargetCount ?? '?'} errs=${res.errors ? errorsOf(res.errors) : (res.error ? 'EXC' : '?')}`);
    if (res.mobile?.overflowing?.length) {
      for (const o of res.mobile.overflowing.slice(0, 3)) console.log(`     溢出 ${o.sel} right=${o.right} over=${o.over}px text=${JSON.stringify(o.text.slice(0, 20))}`);
    }
    if (res.mobile?.smallTargets?.length) {
      for (const o of res.mobile.smallTargets.slice(0, 3)) console.log(`     小目标 ${o.sel} ${o.w}x${o.h} text=${JSON.stringify(o.text)}`);
    }
    out.push(res);
  }
  await sendRaw('Emulation.clearDeviceMetricsOverride');
  view = { w: 1280, h: 1000, mobile: false, dpr: 1 };
  await writeJSON('_results-mobile.json', out);
  return out;
}

/* ------------------------------------------------------------------ */
/* 阶段 3：表单极端输入                                                */
/* ------------------------------------------------------------------ */

const results = [];

async function scenario(name, fn) {
  const m = mark();
  let out = { name };
  try {
    const r = await fn();
    out = { ...out, ...(r || {}) };
  } catch (e) {
    out.error = e.message;
  }
  const errs = collect(m);
  out.errors = errs;
  out.badText = await evalJs('__audit.badText()').catch(() => []);
  if (errorsOf(errs) || out.badText.length) {
    out.screenshot = await screenshot('form-' + name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_'));
  }
  results.push(out);
  console.log(`${out.error || errorsOf(errs) || out.badText.length ? '✗' : '·'} ${name.padEnd(28)} ${out.note || ''} ${out.error ? 'EXC:' + out.error : ''} ${out.badText?.length ? 'badText:' + JSON.stringify(out.badText[0]).slice(0, 80) : ''}`);
  if (errorsOf(errs)) console.log('    ', fmtErrors(errs, 2));
  return out;
}

async function openStockPage(code = '600036') {
  await navigate(`#stock?code=${code}`, { waitExpr: `!!document.getElementById('addPort')`, timeout: 25000, settle: 400 });
}

async function phaseForms() {
  await setViewport(1280, 1000, false, 1);
  const backup = await evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('d3:')).map(k=>[k,localStorage.getItem(k)])))`);
  const restore = async () => {
    await evalJs(`(()=>{ for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&(k.startsWith('d3:')||/^\d+$/.test(k))) localStorage.removeItem(k);} const o=JSON.parse(${JSON.stringify(backup)}); for(const k in o) localStorage.setItem(k,o[k]); return true; })()`);
  };

  // ---------- A. 买入弹层 ----------
  const buyCases = [
    { label: '负股数', shares: '-100', price: '10.00' },
    { label: '0股', shares: '0', price: '10.00' },
    { label: '空股数', shares: '', price: '10.00' },
    { label: '非数字股数', shares: 'abc', price: '10.00' },
    { label: '1e12股', shares: '1000000000000', price: '10.00' },
    { label: '0价', shares: '100', price: '0' },
    { label: '负价', shares: '100', price: '-5' },
    { label: '空价', shares: '100', price: '' },
    { label: '1e9价', shares: '100', price: '1000000000' },
    { label: '未来日期', shares: '100', price: '10.00', date: '2030-01-01' },
    { label: '正常买入', shares: '100', price: '10.00' },
  ];
  for (const c of buyCases) {
    await openStockPage();
    await scenario('买入/' + c.label, async () => {
      await clickSel('#addPort');
      await sleep(500);
      if (c.date) await setVal('#buyDate', c.date);
      await setVal('#buyShares', c.shares);
      await setVal('#buyPrice', c.price);
      const n0 = await evalJs(`JSON.parse(localStorage.getItem('d3:txs')||'[]').length`);
      await clickSel('.modal [data-act="1"]');
      await sleep(700);
      const toast = await toastText();
      const modalOpen = await evalJs(`!!document.querySelector('.modal.show')`);
      const txs = await evalJs(`JSON.parse(localStorage.getItem('d3:txs')||'[]')`);
      const last = txs[txs.length - 1];
      const note = `toast=${JSON.stringify(toast)} modal=${modalOpen} txs=${n0}->${txs.length} last=${last ? JSON.stringify([last.date, last.code, last.shares, last.price]) : '-'}`;
      await restore();
      await evalJs(`document.querySelector('.modal-close')?.click()`).catch(() => {});
      await sleep(200);
      return { note, toast, modalOpen, txsDelta: txs.length - n0, last };
    });
  }

  // ---------- B. 现金 / 支出设置 ----------
  for (const c of [
    { label: '现金-负数', id: 'setCash', v: '-100', key: 'd3:cash' },
    { label: '现金-超大', id: 'setCash', v: '1e15', key: 'd3:cash' },
    { label: '现金-1e20', id: 'setCash', v: '100000000000000000000', key: 'd3:cash' },
    { label: '现金-非数字', id: 'setCash', v: 'abc', key: 'd3:cash' },
    { label: '现金-空', id: 'setCash', v: '', key: 'd3:cash' },
    { label: '月支出-负数', id: 'setExpense', v: '-500', key: 'd3:settings' },
    { label: '月支出-1e15', id: 'setExpense', v: '1000000000000000', key: 'd3:settings' },
    { label: '月支出-非数字', id: 'setExpense', v: 'abc', key: 'd3:settings' },
  ]) {
    await navigate('#mine?view=settings', { waitExpr: `!!document.getElementById('setCash')`, settle: 400 });
    await scenario('设置/' + c.label, async () => {
      const setTo = await setVal('#' + c.id, c.v);
      await sleep(400);
      const stored = await readLS(c.key);
      const toast = await toastText();
      await navigate('#mine', { settle: 900 });
      const mineText = await evalJs('document.body.innerText');
      const mineBad = await evalJs('__audit.badText()');
      const hero = await evalJs(`(document.querySelector('.hero')||{}).innerText||''`);
      await navigate('#today', { settle: 1200 });
      const todayBad = await evalJs('__audit.badText()');
      const hasNaN = /NaN|Infinity/.test(mineText + todayBad.join(' '));
      await restore();
      return {
        note: `set="${setTo}" stored=${JSON.stringify(stored)} toast=${JSON.stringify(toast)} mineBad=${JSON.stringify(mineBad)} todayBad=${JSON.stringify(todayBad)} hero=${JSON.stringify(hero.slice(0, 80))} hasNaN=${hasNaN}`,
        setTo, stored, toast, mineBad, todayBad, hero, hasNaN,
      };
    });
  }

  // ---------- C. 方案编辑器 ----------
  const seedPlan = (plan) => setLS('d3:plans', JSON.stringify([plan]));

  async function openEditor(codes = ['600036', '601398']) {
    await navigate('#mine?view=plans', { waitExpr: `!!document.getElementById('planCreate')`, settle: 400 });
    await clickSel('#planCreate');
    await sleep(600);
    for (const code of codes) {
      await clickSel('#edAddStock');
      await sleep(350);
      await setVal('#pickQ', code);
      await sleep(350);
      const el = await clickSel(`[data-pick="${code}"]`);
      await sleep(700);
      if (el !== 'ok') throw new Error('picker missing ' + code);
    }
    return evalJs(`document.querySelectorAll('.plan-edit-row').length`);
  }

  // C1 正常保存（30+30）
  await scenario('方案/保存30+30', async () => {
    await openEditor();
    await setVal('[data-w="600036"]', '30');
    await setVal('[data-w="601398"]', '30');
    await clickSel('#edSave');
    await sleep(1000);
    const plansRaw = await readLS('d3:plans');
    const plans = plansRaw ? JSON.parse(plansRaw) : [];
    const p = plans[plans.length - 1];
    const note = `plans=${plans.length} total=${p ? p.holdings.reduce((s, h) => s + h.weight, 0) : '-'} entry=${JSON.stringify(p?.entry)}`;
    await restore();
    return { note, plans };
  });

  // C2 权重和 > 100
  await scenario('方案/权重和160', async () => {
    await openEditor();
    await setVal('[data-w="600036"]', '80');
    await setVal('[data-w="601398"]', '80');
    const summary = await evalJs(`(document.getElementById('edSummary')||{}).textContent||''`);
    await clickSel('#edSave');
    await sleep(900);
    const toast = await toastText();
    const inEditor = await evalJs(`!!document.querySelector('.editor-basics')`);
    const plansRaw = await readLS('d3:plans');
    await restore();
    return { note: `toast=${JSON.stringify(toast)} stillEditor=${inEditor} summary=${JSON.stringify(summary.slice(0, 60))} plans=${plansRaw}`, toast, inEditor, summary };
  });

  // C3 空权重（清空输入）后保存
  await scenario('方案/空权重保存', async () => {
    await openEditor();
    await setVal('[data-w="600036"]', '');
    await setVal('[data-w="601398"]', '');
    await clickSel('#edSave');
    await sleep(1000);
    const toast = await toastText();
    const plansRaw = await readLS('d3:plans');
    const plans = plansRaw ? JSON.parse(plansRaw) : [];
    const p = plans[plans.length - 1];
    const cards = await evalJs(`document.querySelectorAll('.plan-card').length`);
    const hasBad = /NaN|Infinity/.test(await evalJs('document.body.innerText'));
    await screenshot('form-plan-empty-weight');
    await restore();
    return { note: `toast=${JSON.stringify(toast)} plans=${plans.length} holdings=${JSON.stringify(p?.holdings)} cards=${cards} badText=${hasBad}`, toast, plans, p };
  });

  // C4 本金 0 / 负数 / 1e15万
  for (const c of [{ label: '本金0', v: '0' }, { label: '本金负数', v: '-5' }, { label: '本金1e15万', v: '1000000000000000' }]) {
    await scenario('方案/' + c.label, async () => {
      await openEditor();
      await setVal('#edCapital', c.v);
      await sleep(500);
      const toast = await toastText();
      const capShown = await evalJs(`document.getElementById('edCapital')?.value`);
      const summary = await evalJs(`(document.getElementById('edSummary')||{}).textContent||''`);
      let savedNote = '';
      if (c.label.includes('1e15')) {
        await clickSel('#edSave');
        await sleep(1200);
        const plansRaw = await readLS('d3:plans');
        const plans = plansRaw ? JSON.parse(plansRaw) : [];
        const p = plans[plans.length - 1];
        const bad = await evalJs('__audit.badText()');
        await navigate('#mine?view=plans', { settle: 900 });
        const cards = await evalJs(`document.querySelectorAll('.plan-card').length`);
        const cardText = await evalJs(`[...document.querySelectorAll('.plan-card')].map(c=>c.innerText.replace(/\\s+/g,' ').slice(0,80))`);
        savedNote = ` savedCapital=${p?.capital} cards=${cards} cardText=${JSON.stringify(cardText)} badText=${JSON.stringify(bad)}`;
        await screenshot('form-plan-capital-huge');
      }
      await restore();
      return { note: `set="${c.v}" toast=${JSON.stringify(toast)} shown=${JSON.stringify(capShown)} summary=${JSON.stringify((summary || '').slice(0, 60))}${savedNote}`, toast, capShown };
    });
  }

  // C5 建仓节奏 months / minDy 极端
  const entryCases = [
    { label: 'months0', entry: 'staged', id: 'edMonths', v: '0' },
    { label: 'months61', entry: 'staged', id: 'edMonths', v: '61' },
    { label: 'months负数', entry: 'staged', id: 'edMonths', v: '-3' },
    { label: 'minDy负数', entry: 'dip', id: 'edMinDy', v: '-1' },
    { label: 'minDy20', entry: 'dip', id: 'edMinDy', v: '20' },
    { label: 'minDy100', entry: 'dip', id: 'edMinDy', v: '100' },
  ];
  for (const c of entryCases) {
    await scenario('方案/' + c.label, async () => {
      await openEditor();
      await clickSel(`[data-entry="${c.entry}"]`);
      await sleep(500);
      const exists = await evalJs(`!!document.getElementById(${JSON.stringify(c.id)})`);
      if (!exists) return { note: `输入框 ${c.id} 不存在（entry=${c.entry}）`, missing: true };
      await setVal('#' + c.id, c.v);
      await sleep(600);
      const toast = await toastText();
      const shown = await evalJs(`document.getElementById(${JSON.stringify(c.id)})?.value`);
      const entryText = await evalJs(`document.querySelectorAll('.entry-card, [data-entry]').length ? document.body.innerText.match(/分批建仓[^\\n]*|股息率[^\\n]*/g)?.slice(0,3) : null`);
      await restore();
      return { note: `set="${c.v}" toast=${JSON.stringify(toast)} shown=${JSON.stringify(shown)} entryText=${JSON.stringify(entryText)}`, toast, shown };
    });
  }

  // C6 清空成分后保存
  await scenario('方案/清空成分保存', async () => {
    await openEditor();
    await evalJs(`document.querySelectorAll('[data-row-del]').forEach(b=>b.click())`);
    await sleep(700);
    const rows = await evalJs(`document.querySelectorAll('.plan-edit-row').length`);
    await clickSel('#edSave');
    await sleep(700);
    const toast = await toastText();
    const plansRaw = await readLS('d3:plans');
    await restore();
    return { note: `rows=${rows} toast=${JSON.stringify(toast)} plans=${plansRaw}`, toast, rows };
  });

  // C7 重复股票：先存 600036，再添加同代码
  await scenario('方案/重复股票', async () => {
    await openEditor(['600036']);
    await clickSel('#edAddStock');
    await sleep(400);
    await setVal('#pickQ', '600036');
    await sleep(400);
    const pickExists = await evalJs(`!!document.querySelector('[data-pick="600036"]')`);
    const pickCount = await evalJs(`document.querySelectorAll('[data-pick]').length`);
    await clickSel('.modal-close, .modal [data-act="0"]');
    await sleep(300);
    const rows = await evalJs(`document.querySelectorAll('.plan-edit-row').length`);
    await restore();
    return { note: `重复代码可被再次选择=${pickExists} (候选数=${pickCount}) rows=${rows}`, pickExists, rows };
  });

  // ---------- D. 回测表单 ----------
  async function openBacktest(hash = '#backtest') {
    await navigate(hash, { waitExpr: `document.querySelectorAll('.chart canvas').length>0`, timeout: 40000, settle: 500 });
  }
  const btCases = [
    { label: '起止倒置', from: '2025-01-01', to: '2020-01-01' },
    { label: '起止相同', from: '2020-01-01', to: '2020-01-01' },
    { label: '极早起点1990', from: '1990-01-01', to: '2026-01-01' },
    { label: '本金0', cap: '0' },
    { label: '本金负数', cap: '-100' },
    { label: '本金1e15', cap: '1000000000000000' },
    { label: '月追加负数', mon: '-5000' },
    { label: '月追加NaN', mon: 'abc' },
    { label: '股息率门槛20', minDy: '20' },
    { label: '股息率门槛负数', minDy: '-5' },
  ];
  for (const c of btCases) {
    await scenario('回测/' + c.label, async () => {
      await openBacktest('#backtest');
      if (c.from !== undefined) {
        await setVal('#btFrom', c.from);
        await setVal('#btTo', c.to);
      }
      if (c.cap !== undefined) await setVal('#btCap', c.cap);
      if (c.mon !== undefined) await setVal('#btMon', c.mon);
      if (c.minDy !== undefined) await setVal('#btMinDy', c.minDy);
      await clickSel('#btRun');
      await sleep(2500);
      const vals = await evalJs(`({from: document.getElementById('btFrom')?.value, to: document.getElementById('btTo')?.value, cap: document.getElementById('btCap')?.value, mon: document.getElementById('btMon')?.value, minDy: document.getElementById('btMinDy')?.value})`);
      const bad = await evalJs('__audit.badText()');
      const text = await evalJs(`(document.getElementById('app')||{}).innerText||''`);
      const charts = await evalJs(`document.querySelectorAll('.chart canvas').length`);
      const toast = await toastText();
      if (bad.length) await screenshot('form-backtest-' + c.label.replace(/[^\w-]+/g, '_'));
      return { note: `afterRun=${JSON.stringify(vals)} charts=${charts} toast=${JSON.stringify(toast)} badText=${JSON.stringify(bad)} appLen=${text.length}`, vals, charts, toast, badText: bad };
    });
  }
  for (const hash of ['#backtest?mode=stock&code=999999', '#backtest?mode=stock&code=abc', '#stock?code=999999', '#stock?code=abc', '#stock', '#backtest?mode=cmp']) {
    await scenario('路由/' + hash, async () => {
      const nav = await navigate(hash, { waitExpr: WAIT_PAGE, timeout: 30000, settle: 1500 });
      const info = await pageInfo();
      const bad = await evalJs('__audit.badText()');
      const errors = collect(nav.mark);
      await screenshot('route-edge-' + hash.replace(/[^\w-]+/g, '_'));
      return { note: `title=${JSON.stringify(info.pageTitle)} warn=${JSON.stringify(info.warn.slice(0, 80))} badText=${JSON.stringify(bad)} errs=${errorsOf(errors)}`, info, badText: bad, errors };
    });
  }

  await writeJSON('_results-forms.json', results);
}

/* ------------------------------------------------------------------ */
/* 阶段 4：localStorage 脏数据                                         */
/* ------------------------------------------------------------------ */

const DIRTY = [
  { key: 'd3:txs', vals: [
    ['非法JSON', '{bad json'],
    ['对象而非数组', '{"a":1}'],
    ['null', 'null'],
    ['元素为垃圾', '[1,2,3]'],
    ['字段类型错误', '[{"id":"x","date":"2030-01-01","code":"999999","shares":-100,"price":"abc","fee":null}]'],
    ['NaN价格', '[{"id":"x","date":"2024-01-01","code":"600036","shares":100,"price":null}]'],
  ] },
  { key: 'd3:plans', vals: [
    ['非法JSON', '{bad'],
    ['对象而非数组', '{"p":1}'],
    ['字段类型错误', '[{"id":"bad","name":123,"holdings":"x","capital":"abc","entry":{"mode":"nope","months":"x","minDy":99}}]'],
    ['重复代码负权重', '[{"id":"bad2","name":"脏","capital":1e30,"holdings":[{"code":"600036","weight":150},{"code":"600036","weight":-5},{"code":"abc","weight":50}],"entry":{"mode":"staged","months":999,"minDy":99}}]'],
  ] },
  { key: 'd3:cash', vals: [
    ['非数字', 'abc'],
    ['负数', '-100'],
    ['Infinity', '1e999'],
    ['NaN', 'NaN'],
  ] },
  { key: 'd3:watch', vals: [
    ['非法JSON', '{bad'],
    ['对象', '{}'],
    ['混合类型', '["abc","600036",null,123]'],
  ] },
  { key: 'd3:settings', vals: [
    ['非法JSON', '{bad'],
    ['null', 'null'],
    ['数组', '[]'],
    ['负数支出', '{"expense":-5000}'],
  ] },
];
const DIRTY_ROUTES = {
  'd3:txs': ['#mine', '#today'],
  'd3:plans': ['#mine?view=plans', '#mine?view=plans&mode=detail&plan=bad2'],
  'd3:cash': ['#mine', '#today'],
  'd3:watch': ['#scan?view=watch'],
  'd3:settings': ['#mine?view=settings', '#today'],
};

async function phaseDirty() {
  await setViewport(1280, 1000, false, 1);
  const backup = await evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('d3:')).map(k=>[k,localStorage.getItem(k)])))`);
  const restore = async () => {
    await evalJs(`(()=>{ for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&(k.startsWith('d3:')||/^\d+$/.test(k))) localStorage.removeItem(k);} const o=JSON.parse(${JSON.stringify(backup)}); for(const k in o) localStorage.setItem(k,o[k]); return true; })()`);
  };
  const out = [];
  for (const grp of DIRTY) {
    for (const [label, val] of grp.vals) {
      for (const route of DIRTY_ROUTES[grp.key]) {
        const rec = { key: grp.key, label, val, route };
        try {
          await setLS(grp.key, val);
          const nav = await navigate(route, { waitExpr: WAIT_PAGE, timeout: 30000, settle: 1500 });
          const info = await pageInfo();
          const bad = await evalJs(`(()=>{try{return __audit.badText();}catch(e){return ['AUDIT_MISSING']}})()`);
          const after = await readLS(grp.key);
          const errors = collect(nav.mark);
          const white = !info.pageTitle && !info.warn;
          Object.assign(rec, {
            white, pageTitle: info.pageTitle, appLen: info.appLen, textLen: info.textLen,
            warn: info.warn, badText: bad, repaired: after !== val, after: String(after).slice(0, 120),
            errors: fmtErrors(errors, 3), errCount: errorsOf(errors),
          });
          if (white) await screenshot(`dirty-${grp.key.replace(':', '_')}-${label.replace(/\W+/g, '_')}-${route.replace(/[^\w-]+/g, '_')}`);
          await restore();
        } catch (e) {
          rec.error = e.message;
          rec.white = true;
          await screenshot(`dirty-crash-${grp.key.replace(':', '_')}-${label.replace(/\W+/g, '_')}`);
          await restore().catch(() => {});
        }
        out.push(rec);
        console.log(`${rec.white ? 'P0' : rec.errCount || rec.badText?.length ? '✗ ' : '· '} ${grp.key}=${label} @${route} white=${rec.white} repaired=${rec.repaired} bad=${JSON.stringify((rec.badText || []).slice(0, 1))} errs=${rec.errCount ?? '-'} title=${JSON.stringify(rec.pageTitle || '')}`);
      }
    }
  }
  await writeJSON('_results-dirty.json', out);
}

/* ------------------------------------------------------------------ */
/* 阶段 5：离线（Service Worker）                                      */
/* ------------------------------------------------------------------ */

async function phaseOffline() {
  await setViewport(1280, 1000, false, 1);
  const backup = await evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('d3:')).map(k=>[k,localStorage.getItem(k)])))`);
  const out = {};
  // 1) 注册 SW（不带 nosw）
  const m0 = mark();
  await sendRaw('Page.navigate', { url: siteUrl('#today', { nosw: false }) }, 30000);
  await waitFor(`!!document.querySelector('.page-title')`, 30000);
  const reg = await evalJs(`(async()=>{
    if (!('serviceWorker' in navigator)) return {supported:false};
    try {
      const r = await Promise.race([navigator.serviceWorker.ready, new Promise((_,rej)=>setTimeout(()=>rej(new Error('ready timeout')), 20000))]);
      const keys = window.caches ? await caches.keys() : [];
      const info = {};
      for (const k of keys) { const c = await caches.open(k); info[k] = (await c.keys()).length; }
      return {supported:true, scope:r.scope, controller:!!navigator.serviceWorker.controller, caches:info};
    } catch (e) { return {supported:true, error:e.message, controller:!!navigator.serviceWorker.controller}; }
  })()`).catch((e) => ({ error: e.message }));
  out.sw = reg;
  await sleep(2500);
  await sendRaw('Page.reload', { ignoreCache: false });
  await waitFor(`!!document.querySelector('.page-title')`, 30000);
  out.controlled = await evalJs(`!!navigator.serviceWorker.controller`);
  out.cacheAfterReload = await evalJs(`(async()=>{const out={};for(const k of await caches.keys()){const c=await caches.open(k);out[k]=(await c.keys()).length;}return out;})()`);
  out.echartsCached = await evalJs(`(async()=>{ try { return !!(await caches.match(location.origin + '/vendor/echarts.min.js')); } catch(e){ return 'err:'+e.message; } })()`);
  out.monthlyCached = await evalJs(`(async()=>{ try { return !!(await caches.match(location.origin + '/data/monthly.json')); } catch(e){ return 'err:'+e.message; } })()`);
  console.log('SW caches:', JSON.stringify(out.cacheAfterReload), 'echartsPrecached=', out.echartsCached, 'monthlyCached=', out.monthlyCached);
  await sleep(1200);

  async function offlineRoute(hash, name) {
    const m = mark();
    await sendRaw('Page.navigate', { url: siteUrl(hash, { nosw: false }) }, 30000);
    const ms = await waitFor(WAIT_PAGE, 20000);
    await sleep(1500);
    const info = await pageInfo();
    // 图表库是懒加载的，等 3.5s 看它能不能在离线时加载出来
    await sleep(3500);
    const charts = await evalJs(`({
      echarts: typeof window.echarts,
      chartDivs: document.querySelectorAll('.chart').length,
      canvases: document.querySelectorAll('canvas').length,
      canvasInCharts: document.querySelectorAll('.chart canvas').length,
    })`).catch(() => ({ error: 'eval failed' }));
    const bad = await evalJs('__audit.badText()').catch(() => []);
    const errors = collect(m);
    const white = !info.pageTitle && !info.warn;
    const rec = {
      hash, name, white, ms, pageTitle: info.pageTitle, warn: info.warn,
      textLen: info.textLen, appLen: info.appLen, body: info.body, badText: bad, charts,
      localFailed: errors.failed.map((f) => f.url + ' ' + f.error).slice(0, 6),
      httpErrors: errors.httpErrors.map((x) => x.status + ' ' + x.url).slice(0, 6),
      console: errors.console.slice(0, 4), exceptions: errors.exceptions.slice(0, 3),
      localFailCount: errors.failed.length,
    };
    await screenshot(name);
    console.log(`${white ? 'P0' : rec.localFailCount ? '✗ ' : 'OK '} offline ${name.padEnd(14)} title=${JSON.stringify(info.pageTitle)} textLen=${info.textLen} charts=${JSON.stringify(charts)} warn=${JSON.stringify(info.warn.slice(0, 60))} failed=${rec.localFailCount} ${bad.length ? 'badText=' + JSON.stringify(bad[0]) : ''}`);
    return rec;
  }

  // 2) 切离线（先清浏览器 HTTP 缓存，确保只靠 Service Worker 缓存，避免 HTTP 缓存掩盖缺项）
  await sendRaw('Network.clearBrowserCache');
  await sendRaw('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await sleep(500);
  out.offline = {};
  out.offline.today = await offlineRoute('#today', 'offline-today');
  out.offline.scan = await offlineRoute('#scan', 'offline-scan');
  out.offline.stock = await offlineRoute('#stock?code=600036', 'offline-stock');
  out.offline.backtest = await offlineRoute('#backtest', 'offline-backtest');

  // 3) 恢复在线
  await sendRaw('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(800);
  const m2 = mark();
  await sendRaw('Page.navigate', { url: siteUrl('#today', { nosw: false }) }, 30000);
  await waitFor(`!!document.querySelector('.page-title')`, 30000);
  await sleep(2500);
  const info = await pageInfo();
  const errors = collect(m2);
  out.online = {
    pageTitle: info.pageTitle, textLen: info.textLen, warn: info.warn,
    failures: errors.failed.slice(0, 5).map((f) => f.url + ' ' + f.error),
    console: errors.console.slice(0, 3),
  };
  await screenshot('online-restored-today');
  console.log(`OK  online restored title=${JSON.stringify(info.pageTitle)} textLen=${info.textLen} localFailures=${errors.failed.length}`);

  // 4) 清理 SW / 缓存 / 本地数据
  await evalJs(`(async()=>{ try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r=>r.unregister())); } catch(e){} try { for (const k of await caches.keys()) await caches.delete(k); } catch(e){} return true; })()`).catch(() => {});
  await evalJs(`(()=>{ for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&(k.startsWith('d3:')||/^\d+$/.test(k))) localStorage.removeItem(k);} const o=JSON.parse(${JSON.stringify(backup)}); for(const k in o) localStorage.setItem(k,o[k]); return true; })()`);
  await writeJSON('_results-offline.json', out);
}

/* ------------------------------------------------------------------ */
/* 阶段 6：补充证据（移动端特写 / 极端数据影响 / 布局量测）            */
/* ------------------------------------------------------------------ */

async function phaseEvidence() {
  const backup = await evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('d3:')).map(k=>[k,localStorage.getItem(k)])))`);
  const restore = async () => {
    await evalJs(`(()=>{ for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&(k.startsWith('d3:')||/^\\d+$/.test(k))) localStorage.removeItem(k);} const o=JSON.parse(${JSON.stringify(backup)}); for(const k in o) localStorage.setItem(k,o[k]); return true; })()`);
  };
  const out = {};
  const headProbe = `(()=>{
    const r=(el)=>{const b=el.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height),right:Math.round(b.right)};};
    const h=document.querySelector('.page-head'); if(!h) return null;
    const sub=h.querySelector('.page-sub');
    const subCs = sub ? getComputedStyle(sub) : null;
    return {
      head: r(h),
      kids: [...h.children].map(el=>({cls:String(el.className).slice(0,40), ...r(el)})),
      sub: sub ? { ...r(sub), lines: Math.round(sub.getBoundingClientRect().height / (parseFloat(subCs.lineHeight) || 16)) } : null,
      mainPadding: getComputedStyle(document.querySelector('.main')).padding,
      docW: document.documentElement.scrollWidth, iw: window.innerWidth,
    };
  })()`;

  // E1: 移动端视口特写（问题页）
  await setViewport(390, 844, true, 1);
  out.mobileShots = {};
  for (const p of [
    { hash: '#backtest', name: 'backtest', wait: `document.querySelectorAll('.chart canvas').length>0` },
    { hash: '#stock?code=600036', name: 'stock', wait: `!!document.getElementById('addPort')` },
    { hash: '#scan', name: 'scan', wait: `document.querySelectorAll('.scan-table tbody tr').length>10` },
    { hash: '#mine', name: 'mine', wait: `document.querySelectorAll('[data-mview]').length>0` },
  ]) {
    await navigate(p.hash, { waitExpr: p.wait, timeout: 35000, settle: 600 });
    await screenshot('mobile-viewport-' + p.name);
    const hp = await evalJs(headProbe).catch(() => null);
    out.mobileShots[p.name] = { head: hp };
    if (p.name === 'backtest' || p.name === 'mine' || p.name === 'scan') {
      out.mobileShots[p.name].tables = await evalJs(`[...document.querySelectorAll('.table-wrap')].map(w=>({scrollW:w.scrollWidth, clientW:w.clientWidth, over:w.scrollWidth-w.clientWidth, cols: w.querySelectorAll('thead th').length}))`).catch(() => []);
    }
    console.log(`· mobile-viewport ${p.name} head=${JSON.stringify(hp?.head)} sub=${JSON.stringify(hp?.sub)} tables=${JSON.stringify(out.mobileShots[p.name].tables || '')}`);
  }
  await sendRaw('Emulation.clearDeviceMetricsOverride');
  view = { w: 1280, h: 1000, mobile: false, dpr: 1 };
  await setViewport(1280, 1000, false, 1);

  // E2: 负数月支出 → 回测「月覆盖」
  for (const [label, settings] of [['负支出', '{"expense":-500}'], ['正常4000', '{"expense":4000}']]) {
    await setLS('d3:settings', settings);
    await navigate('#backtest', { waitExpr: `document.querySelectorAll('.chart canvas').length>0`, timeout: 40000, settle: 800 });
    const metric = await evalJs(`(()=>{const m=[...document.querySelectorAll('.bt-metric')].find(x=>x.innerText.includes('月覆盖')); return m?m.innerText.replace(/\\n/g,' | '):'';})()`);
    const allText = await evalJs(`(document.querySelector('.bt-metrics')||{}).innerText||''`);
    const covText = await evalJs(`[...document.querySelectorAll('*')].filter(e=>e.children.length===0 && /月覆盖|%/.test(e.textContent)&&e.textContent.trim().length<20).slice(0,40).map(e=>e.textContent.trim()).join(' ; ')`);
    await screenshot('evidence-expense-' + (label === '负支出' ? 'negative' : 'normal'));
    out['expense-' + label] = { metric, allText: allText.slice(0, 400), covText: covText.slice(0, 300) };
    console.log(`· 月支出[${label}] metric=${JSON.stringify(metric)}`);
  }
  await restore();

  // E3: 未来日期买入 → 我的组合统计
  const futTx = { id: 'fut', date: '2030-01-01', code: '600036', side: 'buy', shares: 100, price: 10, fee: 5 };
  await navigate('#mine', { waitExpr: `document.querySelectorAll('[data-mview]').length>0`, settle: 600 });
  const baseText = await evalJs(`(document.querySelector('.hero')||{}).innerText||''`);
  const txs = JSON.parse(await readLS('d3:txs') || '[]');
  await setLS('d3:txs', JSON.stringify([...txs, futTx]));
  await navigate('#mine', { waitExpr: `document.querySelectorAll('[data-mview]').length>0`, settle: 1200 });
  const futText = await evalJs(`(document.querySelector('.hero')||{}).innerText||''`);
  const futBad = await evalJs('__audit.badText()');
  const futRow = await evalJs(`(()=>{const t=[...document.querySelectorAll('table tr')].find(r=>r.innerText.includes('2030-01-01')); return t?t.innerText.replace(/\\n/g,' | '):'';})()`);
  await screenshot('evidence-future-tx');
  out.futureTx = { baseHero: baseText.slice(0, 500), futureHero: futText.slice(0, 500), badText: futBad, row: futRow };
  console.log(`· 未来日期买入 hero变化=${JSON.stringify(futText.slice(0, 120))} badText=${JSON.stringify(futBad)}`);
  await restore();

  // E4: 超大现金 / 超大字股数 → 我的组合 & 今天
  await setLS('d3:cash', '1000000000000000');
  const hugeTx = { id: 'huge', date: '2024-01-01', code: '600036', side: 'buy', shares: 1000000000000, price: 10, fee: 5 };
  await setLS('d3:txs', JSON.stringify([...JSON.parse(await readLS('d3:txs') || '[]'), hugeTx]));
  await navigate('#mine', { waitExpr: `document.querySelectorAll('[data-mview]').length>0`, settle: 1200 });
  const hugeHero = await evalJs(`(document.querySelector('.hero')||{}).innerText||''`);
  const hugeBad = await evalJs('__audit.badText()');
  await screenshot('evidence-huge-cash-shares');
  out.huge = { hero: hugeHero.slice(0, 600), badText: hugeBad };
  console.log(`· 超大现金+1e12股 hero=${JSON.stringify(hugeHero.slice(0, 200))} badText=${JSON.stringify(hugeBad)}`);
  await navigate('#today', { settle: 1200 });
  out.huge.todayBad = await evalJs('__audit.badText()');
  out.huge.todayText = (await evalJs('document.body.innerText')).slice(0, 300);
  await screenshot('evidence-huge-cash-today');
  await restore();

  // E7: 空成分方案（编辑器清空权重后保存）在详情 / 回测里的表现
  const emptyPlan = {
    id: 'empty-plan', name: '空方案', capital: 1000000, holdings: [],
    entry: { mode: 'once', months: 12, minDy: 5.5 }, createdAt: '2026-11-01', updatedAt: '2026-11-01',
  };
  await setLS('d3:plans', JSON.stringify([emptyPlan]));
  await navigate('#mine?view=plans&mode=detail&plan=empty-plan', { waitExpr: WAIT_PAGE, timeout: 30000, settle: 1500 });
  const emptyDetail = await evalJs(`({title: (document.querySelector('.page-title')||{}).textContent, text: (document.getElementById('app')||{}).innerText?.slice(0,500)||'', bad: (()=>{try{return __audit.badText()}catch(e){return []}})()})`);
  await screenshot('evidence-empty-plan-detail');
  await navigate('#backtest?plan=empty-plan', { waitExpr: WAIT_PAGE, timeout: 40000, settle: 1500 });
  const emptyBt = await pageInfo();
  const emptyBtBad = await evalJs('__audit.badText()').catch(() => []);
  await screenshot('evidence-empty-plan-backtest');
  out.emptyPlan = { detail: emptyDetail, backtest: { title: emptyBt.pageTitle, warn: emptyBt.warn, body: emptyBt.body, bad: emptyBtBad } };
  console.log(`· 空方案 详情title=${JSON.stringify(emptyBt.pageTitle)} 详情坏值=${JSON.stringify(emptyDetail.bad)} 回测warn=${JSON.stringify(emptyBt.warn)} 回测bad=${JSON.stringify(emptyBtBad)}`);
  await restore();

  // E5: 无效个股代码 → 静默回退
  await navigate('#stock?code=999999', { waitExpr: WAIT_PAGE, settle: 1200 });
  out.invalidStock = await evalJs(`({hash: location.hash, title: (document.querySelector('.page-title')||{}).textContent, name: (document.querySelector('.verdict-word')?.nextElementSibling?.textContent||document.querySelector('.verdict')?.innerText?.slice(0,80)||''), search: document.getElementById('stockSearch')?.value})`);
  console.log(`· 无效个股代码 999999 →`, JSON.stringify(out.invalidStock));
  await screenshot('evidence-invalid-stock');

  // E6: 移动端 page-actions 溢出量测
  await setViewport(390, 844, true, 1);
  await navigate('#backtest', { waitExpr: `document.querySelectorAll('.chart canvas').length>0`, timeout: 40000, settle: 600 });
  out.actionsProbe = await evalJs(`(()=>{
    const r=(el)=>{const b=el.getBoundingClientRect();return {x:Math.round(b.left),w:Math.round(b.width),right:Math.round(b.right),h:Math.round(b.height)};};
    const acts=document.querySelector('.page-actions'); const head=document.querySelector('.page-head');
    const out={iw:innerWidth, scrollW:document.documentElement.scrollWidth, bodyScrollW:document.body.scrollWidth, actions: acts?r(acts):null, head: head?r(head):null, main: (()=>{const m=document.querySelector('.main'); const b=m.getBoundingClientRect(); return {x:Math.round(b.left),w:Math.round(b.width),right:Math.round(b.right),pad:getComputedStyle(m).padding};})()};
    out.kids = acts ? [...acts.children].map(c=>({t:(c.textContent||'').trim().slice(0,10), ...r(c)})) : [];
    out.svgPaths = [...document.querySelectorAll('.page-actions svg path')].map(p=>r(p));
    return out;
  })()`);
  console.log('· page-actions probe', JSON.stringify(out.actionsProbe));
  await sendRaw('Emulation.clearDeviceMetricsOverride');
  view = { w: 1280, h: 1000, mobile: false, dpr: 1 };
  await writeJSON('_results-evidence.json', out);
  await restore();
}

/* ------------------------------------------------------------------ */
/* 探针：移动端被挤扁的 panel-head / page-head 精确量测                */
/* ------------------------------------------------------------------ */

async function phaseProbe() {
  const out = {};
  await setViewport(390, 844, true, 1);
  await navigate('#stock?code=600036', { waitExpr: `!!document.getElementById('addPort')`, timeout: 35000, settle: 1200 });
  out.stock = await evalJs(`(()=>{
    const r=(el)=>{const b=el.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)};};
    const heads=[...document.querySelectorAll('.panel-head')].map(h=>({
      title: (h.querySelector('.panel-title')||{}).textContent||'',
      titleRect: h.querySelector('.panel-title')?r(h.querySelector('.panel-title')):null,
      note: (h.querySelector('.section-note')||{}).textContent||'',
      noteRect: h.querySelector('.section-note')?r(h.querySelector('.section-note')):null,
      headRect: r(h),
    }));
    return heads.filter(h=>h.title.includes('日 K'));
  })()`);
  await screenshot('probe-mobile-stock-kline');
  await navigate('#backtest', { waitExpr: `document.querySelectorAll('.chart canvas').length>0`, timeout: 40000, settle: 1000 });
  out.backtest = await evalJs(`(()=>{
    const r=(el)=>{const b=el.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)};};
    const head=document.querySelector('.page-head'); const sub=document.querySelector('.page-sub'); const acts=document.querySelector('.page-actions');
    return { head:r(head), sub: sub?{...r(sub), text:(sub.textContent||'').trim(), fontSize:getComputedStyle(sub).fontSize, lineHeight:getComputedStyle(sub).lineHeight}:null, actions: acts?r(acts):null, scrollW: document.documentElement.scrollWidth, iw: innerWidth };
  })()`);
  console.log('PROBE stock kline heads:', JSON.stringify(out.stock));
  console.log('PROBE backtest head:', JSON.stringify(out.backtest));
  await sendRaw('Emulation.clearDeviceMetricsOverride');
  view = { w: 1280, h: 1000, mobile: false, dpr: 1 };
  await writeJSON('_results-probe.json', out);
}

/* ------------------------------------------------------------------ */
/* 诊断：Network.emulateNetworkConditions 是否真的断网                 */
/* ------------------------------------------------------------------ */

async function phaseDiag() {
  await setViewport(1280, 1000, false, 1);
  await navigate('#today', { nosw: true, settle: 800 });
  const before = await evalJs(`fetch('/index.html?diag=' + Date.now(), {cache:'no-store'}).then(r=>'HTTP '+r.status).catch(e=>'ERR '+e.message)`);
  await sendRaw('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await sleep(600);
  const selfFetch = await evalJs(`Promise.all([
    fetch('/index.html?diag=' + Date.now(), {cache:'no-store'}).then(r=>'HTTP '+r.status).catch(e=>'ERR '+e.message),
    fetch('https://example.com/', {cache:'no-store'}).then(r=>'HTTP '+r.status).catch(e=>'ERR '+e.message),
  ])`);
  const onlineState = await evalJs(`({onLine: navigator.onLine})`);
  let byRule = 'not-tried';
  try {
    await sendRaw('Network.emulateNetworkConditionsByRule', { offline: true, matchedNetworkConditions: [{ urlPattern: '', connectionType: 'none' }] });
    await sleep(500);
    byRule = await evalJs(`fetch('/index.html?diag=' + Date.now(), {cache:'no-store'}).then(r=>'HTTP '+r.status).catch(e=>'ERR '+e.message)`);
    await sendRaw('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [] });
  } catch (e) { byRule = 'api-err:' + e.message; }
  const after = await evalJs(`fetch('/index.html?diag=' + Date.now(), {cache:'no-store'}).then(r=>'HTTP '+r.status).catch(e=>'ERR '+e.message)`);
  await sendRaw('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(400);
  const restored = await evalJs(`fetch('/index.html?diag=' + Date.now(), {cache:'no-store'}).then(r=>'HTTP '+r.status).catch(e=>'ERR '+e.message)`);
  // 进一步：注册 SW 后清 HTTP 缓存再离线，看 echarts 到底从哪来
  let swDeep = null;
  let swDeep2 = null;
  try {
    await sendRaw('Page.navigate', { url: siteUrl('#today', { nosw: false }) }, 30000);
    await waitFor(WAIT_PAGE, 30000);
    await evalJs(`(async()=>{try{await navigator.serviceWorker.ready;}catch(e){} return true;})()`);
    await sleep(2500);
    await sendRaw('Page.reload', { ignoreCache: false });
    await waitFor(WAIT_PAGE, 30000);
    await sleep(1200);
    const cacheUrls = await evalJs(`(async()=>{const out=[];for(const k of await caches.keys()){const c=await caches.open(k);for(const r of await c.keys())out.push(r.url);}return out;})()`);
    // 关键：Network.emulateNetworkConditions 只作用于被 attach 的 target。
    // Service Worker 是独立 target，必须单独把它也设为离线，否则 SW 里的 fetch 仍能上网（伪离线）。
    const swTarget = (await fetch('http://127.0.0.1:' + (process.env.D3_CDP_PORT || '9223') + '/json/list').then((r) => r.json())).find((t) => /service_worker|worker/.test(t.type) && /sw\.js/.test(t.url || '')) 
      || (await fetch('http://127.0.0.1:' + (process.env.D3_CDP_PORT || '9223') + '/json/list').then((r) => r.json())).find((t) => /service_worker|worker/.test(t.type));
    let swWs = null;
    if (swTarget) {
      swWs = new WebSocket(swTarget.webSocketDebuggerUrl);
      let sid = 0; const sp = new Map();
      swWs.addEventListener('message', (e2) => { const m2 = JSON.parse(e2.data); if (m2.id && sp.has(m2.id)) { const f = sp.get(m2.id); sp.delete(m2.id); f(m2); } });
      await new Promise((res, rej) => { swWs.addEventListener('open', res); swWs.addEventListener('error', rej); });
      const ssend = (method, params = {}) => new Promise((res, rej) => { const my = ++sid; sp.set(my, (m2) => (m2.error ? rej(new Error(method + ': ' + JSON.stringify(m2.error))) : res(m2.result))); swWs.send(JSON.stringify({ id: my, method, params })); });
      await ssend('Network.enable');
      await ssend('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      swDeep2 = { swTarget: swTarget.type + ' ' + swTarget.url };
    }
    const echInCache = (cacheUrls || []).filter((u) => /echarts/.test(u));
    const maybeExtra = (cacheUrls || []).filter((u) => !/\.(json|js|css|png|webmanifest)$/.test(u)).slice(0, 10);
    await sendRaw('Network.clearBrowserCache');
    await sendRaw('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await sleep(500);
    await sendRaw('Page.navigate', { url: siteUrl('#stock?code=600036', { nosw: false }) }, 30000);
    await waitFor(WAIT_PAGE, 20000);
    await sleep(4000);
    const stockState = await evalJs(`({
      echType: typeof window.echarts,
      echIsNull: window.echarts === null,
      echVer: window.echarts && window.echarts.version,
      scripts: [...document.scripts].map(s=>s.src).filter(Boolean),
      canvases: [...document.querySelectorAll('canvas')].map(c=>({w:c.width,h:c.height,parent:c.parentElement && c.parentElement.className})),
      chartDivs: document.querySelectorAll('.chart').length,
      canvasInCharts: document.querySelectorAll('.chart canvas').length,
      onLine: navigator.onLine,
    })`);
    const fetchEch = await evalJs(`fetch('/vendor/echarts.min.js', {cache:'no-store'}).then(r=>'HTTP '+r.status+' '+(r.headers.get('content-type')||'')).catch(e=>'ERR '+e.message)`);
    swDeep = { cacheUrlsCount: (cacheUrls || []).length, echInCache, maybeExtra, stockState, fetchEch, swDeep2 };
    console.log('DIAG sw-deep:', JSON.stringify(swDeep).slice(0, 2500));
    await sendRaw('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await evalJs(`(async()=>{try{const rs=await navigator.serviceWorker.getRegistrations();await Promise.all(rs.map(r=>r.unregister()));}catch(e){} try{for(const k of await caches.keys())await caches.delete(k);}catch(e){} return true;})()`).catch(() => {});
  } catch (e) { swDeep = { error: e.message }; }
  const out = { before, selfFetch, onlineState, byRule, after, restored, swDeep };
  console.log('DIAG offline-emulation:', JSON.stringify(out).slice(0, 4000));
  await writeJSON('_results-diag.json', out);
}

/* ------------------------------------------------------------------ */
/* 阶段 7：深浅主题                                                    */
/* ------------------------------------------------------------------ */

async function phaseTheme() {
  await setViewport(1280, 1000, false, 1);
  const out = [];
  for (const theme of ['dark', 'light']) {
    for (const p of [
      { hash: '#today', name: 'today', wait: `document.querySelectorAll('.panel').length>0` },
      { hash: '#scan', name: 'scan', wait: `document.querySelectorAll('.scan-table tbody tr').length>10` },
      { hash: '#stock?code=600036', name: 'stock', wait: `!!document.getElementById('addPort')` },
      { hash: '#backtest', name: 'backtest', wait: `document.querySelectorAll('.chart canvas').length>0` },
    ]) {
      const rec = { theme, name: p.name };
      try {
        const nav = await navigate(p.hash, { theme, waitExpr: p.wait, timeout: 35000, settle: 800 });
        rec.themeApplied = await evalJs(`document.documentElement.dataset.theme`);
        rec.bg = await evalJs(`getComputedStyle(document.body).backgroundColor`);
        rec.fg = await evalJs(`getComputedStyle(document.body).color`);
        rec.contrast = await evalJs('__audit.contrast()');
        rec.errors = fmtErrors(collect(nav.mark), 3);
        await screenshot(`theme-${theme}-${p.name}`, { fullPage: true });
        console.log(`· ${theme.padEnd(5)} ${p.name.padEnd(8)} theme=${rec.themeApplied} bg=${rec.bg} lowContrast=${rec.contrast.length} ${rec.contrast[0] ? JSON.stringify([rec.contrast[0].sel, rec.contrast[0].ratio, rec.contrast[0].text]) : ''}`);
      } catch (e) {
        rec.error = e.message;
        console.log('✗ theme', theme, p.name, e.message);
      }
      out.push(rec);
    }
  }
  await writeJSON('_results-theme.json', out);
}

/* ------------------------------------------------------------------ */
/* 阶段 8：修复复验（P1/P2 逐项重放 + 改后实测数字）                    */
/* ------------------------------------------------------------------ */

async function phaseVerify() {
  await setViewport(1280, 1000, false, 1);
  const backup = await evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('d3:')).map(k=>[k,localStorage.getItem(k)])))`);
  const restore = async () => {
    await evalJs(`(()=>{ for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&(k.startsWith('d3:')||/^\d+$/.test(k))) localStorage.removeItem(k);} const o=JSON.parse(${JSON.stringify(backup)}); for(const k in o) localStorage.setItem(k,o[k]); return true; })()`);
  };
  const out = {};
  const charts = () => evalJs(`document.querySelectorAll('.chart canvas').length`);
  const heroText = () => evalJs(`(document.querySelector('.hero-line')||document.querySelector('.hero')||{}).textContent||''`);

  async function openEditor(codes = ['600036', '601398']) {
    await navigate('#mine?view=plans', { waitExpr: `!!document.getElementById('planCreate')`, settlement: 0, settle: 400 }).catch(() => {});
    await clickSel('#planCreate');
    await sleep(600);
    for (const code of codes) {
      await clickSel('#edAddStock');
      await sleep(350);
      await setVal('#pickQ', code);
      await sleep(350);
      await clickSel(`[data-pick="${code}"]`);
      await sleep(700);
    }
    return evalJs(`document.querySelectorAll('.plan-edit-row').length`);
  }

  // ---------- V1 P1-1 空成分方案 ----------
  await openEditor();
  await setVal('[data-w="600036"]', '');
  await setVal('[data-w="601398"]', '');
  await clickSel('#edSave');
  await sleep(900);
  out.v1_emptyWeight = {
    toast: await toastText(),
    stillEditor: await evalJs(`!!document.querySelector('.editor-basics')`),
    plans: await readLS('d3:plans'),
  };
  await screenshot('verify-plan-empty-weight');
  await restore();
  // V1b 全 0 权重（显式 0）
  await openEditor();
  await setVal('[data-w="600036"]', '0');
  await setVal('[data-w="601398"]', '0');
  await clickSel('#edSave');
  await sleep(900);
  out.v1_zeroWeight = { toast: await toastText(), stillEditor: await evalJs(`!!document.querySelector('.editor-basics')`), plans: await readLS('d3:plans') };
  await restore();

  // ---------- V2 P1-2 回测非法参数 + 合法重跑 ----------
  async function openBacktest() {
    await navigate('#backtest', { waitExpr: `document.querySelectorAll('.chart canvas').length>0`, timeout: 40000, settle: 500 });
  }
  const readBtInputs = () => evalJs(`({from:document.getElementById('btFrom')?.value,to:document.getElementById('btTo')?.value,cap:document.getElementById('btCap')?.value,mon:document.getElementById('btMon')?.value,minDy:document.getElementById('btMinDy')?.value})`);
  out.v2_invalid = [];
  for (const c of [
    { label: '日期倒置', set: { btFrom: '2025-01-01', btTo: '2020-01-01' } },
    { label: '日期相同', set: { btFrom: '2020-01-01', btTo: '2020-01-01' } },
    { label: '本金0', set: { btCap: '0' } },
    { label: '本金负数', set: { btCap: '-100' } },
    { label: '月追加负数', set: { btMon: '-5000' } },
    { label: '月追加NaN', set: { btMon: 'abc' } },
    { label: '门槛20', set: { btMinDy: '20' } },
    { label: '门槛负数', set: { btMinDy: '-5' } },
  ]) {
    await openBacktest();
    const c0 = await charts();
    const h0 = await heroText();
    for (const [id, v] of Object.entries(c.set)) await setVal('#' + id, v);
    await clickSel('#btRun');
    await sleep(1000);
    out.v2_invalid.push({
      label: c.label,
      toast: await toastText(),
      inputs: await readBtInputs(),
      charts: await charts(),
      heroSame: (await heroText()) === h0 && c0 === (await charts()),
    });
  }
  // 合法参数：应正常重跑、出图、日期归一化回写
  await openBacktest();
  const h0 = await heroText();
  for (const [id, v] of Object.entries({ btFrom: '2023-01-01', btTo: '2026-01-01', btCap: '50', btMon: '1000', btMinDy: '5' })) await setVal('#' + id, v);
  await clickSel('#btRun');
  await sleep(6000);
  out.v2_valid = {
    toast: await toastText(),
    inputs: await readBtInputs(),
    charts: await charts(),
    hero: (await heroText()).slice(0, 160),
    heroChanged: (await heroText()) !== h0,
  };
  await screenshot('verify-backtest-valid-rerun');
  await restore();

  // ---------- V2b 个股回测模式的门槛校验（minDy 输入框只在个股模式出现） ----------
  await navigate('#backtest?mode=stock&code=601398', { waitExpr: `document.querySelectorAll('.chart canvas').length>0`, timeout: 40000, settle: 500 });
  out.v2b_minDyExists = await evalJs(`!!document.getElementById('btMinDy')`);
  if (out.v2b_minDyExists) {
    await setVal('#btMinDy', '20');
    await clickSel('#btRun');
    await sleep(900);
    out.v2b_invalidMinDy = { toast: await toastState(), shown: await evalJs(`document.getElementById('btMinDy')?.value`), charts: await charts() };
    await setVal('#btMinDy', '6');
    await clickSel('#btRun');
    await sleep(4000);
    out.v2b_validMinDy = { toast: await toastState(), shown: await evalJs(`document.getElementById('btMinDy')?.value`), charts: await charts(), hero: (await heroText()).slice(0, 120) };
    await screenshot('verify-backtest-stock-minDy');
  }
  await restore();

  // ---------- V3 P1-3 月支出/现金/本金 ----------
  await navigate('#mine?view=settings', { waitExpr: `!!document.getElementById('setCash')`, settle: 500 });
  await setVal('#setExpense', '-500');
  await sleep(500);
  out.v3_expenseNeg = { shown: await evalJs(`document.getElementById('setExpense')?.value`), toast: await toastText(), stored: await readLS('d3:settings') };
  await openBacktest();
  await sleep(2500);
  out.v3_coverageAfterClamp = await evalJs(`(()=>{const m=[...document.querySelectorAll('.bt-metric')].find(x=>x.innerText.includes('月覆盖')); return m?m.innerText.replace(/\\n/g,' | '):'';})()`);
  // 旧版脏设置（绕过 UI 的负数）→ loadSettings 读取时归一，月覆盖应回到 163%
  await setLS('d3:settings', '{"expense":-500}');
  await openBacktest();
  await sleep(2500);
  out.v3_legacyExpense = {
    storedAfterLoad: await readLS('d3:settings'),
    coverage: await evalJs(`(()=>{const m=[...document.querySelectorAll('.bt-metric')].find(x=>x.innerText.includes('月覆盖')); return m?m.innerText.replace(/\\n/g,' | '):'';})()`),
  };
  await restore();
  // 现金 clamp
  await navigate('#mine?view=settings', { waitExpr: `!!document.getElementById('setCash')`, settle: 400 });
  await setVal('#setCash', '-100');
  await sleep(500);
  out.v3_cashNeg = { shown: await evalJs(`document.getElementById('setCash')?.value`), toast: await toastText(), stored: await readLS('d3:cash') };
  await setVal('#setCash', '100000000000000000000');
  await sleep(500);
  out.v3_cashHuge = { shown: await evalJs(`document.getElementById('setCash')?.value`), toast: await toastText(), stored: await readLS('d3:cash') };
  await navigate('#mine', { waitExpr: `document.querySelectorAll('[data-mview]').length>0`, settle: 1000 });
  out.v3_cashHero = (await heroText()).slice(0, 300);
  await screenshot('verify-cash-clamp');
  await restore();
  // 方案本金上限
  await openEditor(['600036']);
  await setVal('#edCapital', '1000000000000000');
  await sleep(700);
  out.v3_planCapitalEdit = { shown: await evalJs(`document.getElementById('edCapital')?.value`), summary: (await evalJs(`(document.getElementById('edSummary')||{}).textContent||''`)).slice(0, 80) };
  await clickSel('#edSave');
  await sleep(1000);
  const plansRaw = await readLS('d3:plans');
  out.v3_planCapitalSaved = { plans: plansRaw ? JSON.parse(plansRaw).map((x) => ({ capital: x.capital, holdings: x.holdings.length })) : null, toast: await toastText() };
  await screenshot('verify-plan-capital-clamp');
  await restore();

  // ---------- V4 P2-8 未来日期 / 超大股数 ----------
  const openStock = () => navigate('#stock?code=600036', { waitExpr: `!!document.getElementById('addPort')`, settle: 400 });
  await openStock();
  await clickSel('#addPort');
  await sleep(500);
  await setVal('#buyDate', '2030-01-01');
  await setVal('#buyShares', '100');
  await setVal('#buyPrice', '10');
  await clickSel('.modal [data-act="1"]');
  await sleep(700);
  out.v4_futureDate = { toast: await toastText(), modalOpen: await evalJs(`!!document.querySelector('.modal.show')`), txs: JSON.parse(await readLS('d3:txs') || '[]').length };
  await evalJs(`document.querySelector('.modal-close')?.click()`).catch(() => {});
  await sleep(300);
  await clickSel('#addPort');
  await sleep(500);
  await setVal('#buyShares', '1000000000000');
  await setVal('#buyPrice', '10');
  await clickSel('.modal [data-act="1"]');
  await sleep(700);
  out.v4_hugeShares = { toast: await toastText(), modalOpen: await evalJs(`!!document.querySelector('.modal.show')`), txs: JSON.parse(await readLS('d3:txs') || '[]').length };
  await evalJs(`document.querySelector('.modal-close')?.click()`).catch(() => {});
  await restore();

  // ---------- V5 主题对比度实测 ----------
  out.theme = {};
  for (const theme of ['dark', 'light']) {
    await navigate('#today', { theme, waitExpr: `document.querySelectorAll('.panel').length>0`, settle: 900 });
    out.theme[theme] = await evalJs(`({
      text3: __audit.cssVar('--text-3'),
      text2: __audit.cssVar('--text-2'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      pillHold: __audit.styleOf('.pill.hold'),
      pillAvoid: __audit.styleOf('.pill.avoid'),
      note: __audit.styleOf('.panel .section-note'),
      pageSub: __audit.styleOf('.page-sub'),
      heroLabel: __audit.styleOf('.hero .stat-label, .hero .stat .k'),
    })`);
    await screenshot('verify-theme-' + theme + '-today');
  }
  const themeErrs = [];
  await navigate('#scan', { theme: 'light', waitExpr: `document.querySelectorAll('.scan-table tbody tr').length>10`, settle: 800 });
  out.theme.lightScan = await evalJs(`({pillAvoid: __audit.styleOf('.pill.avoid'), pillWait: __audit.styleOf('.pill.wait'), lowContrastCount: __audit.contrast().length})`);
  await screenshot('verify-theme-light-scan');
  await restore();

  // ---------- V6 移动端实测（含触摸仿真 pointer:coarse） ----------
  await setViewport(390, 844, true, 1);
  await navigate('#backtest', { waitExpr: `document.querySelectorAll('.chart canvas').length>0`, timeout: 40000, settle: 800 });
  out.mobile_backtest = await evalJs(`(()=>{
    const r=(el)=>{const b=el.getBoundingClientRect();return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)};};
    const head=document.querySelector('.page-head'); const sub=document.querySelector('.page-sub'); const acts=document.querySelector('.page-actions');
    let small=0; for(const el of document.querySelectorAll('button,a,.icon-star,.chip,.view-tab')){const b=el.getBoundingClientRect(); if(b.width>0&&b.height>0&&(b.width<32||b.height<32)) small++;}
    return { head:r(head), sub: sub?{...r(sub), lines: Math.round(sub.getBoundingClientRect().height/(parseFloat(getComputedStyle(sub).lineHeight)||16))}:null, actions: acts?r(acts):null, docOverflow: Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth, coarse: matchMedia('(pointer: coarse)').matches, smallTargets: small };
  })()`);
  await screenshot('verify-mobile-backtest');
  await navigate('#stock?code=600036', { waitExpr: `!!document.getElementById('addPort')`, settle: 900 });
  out.mobile_stock = await evalJs(`(()=>{ const heads=[...document.querySelectorAll('.panel-head')].map(h=>{ const t=h.querySelector('.panel-title'); const n=h.querySelector('.section-note'); const b=(e)=>e?{w:Math.round(e.getBoundingClientRect().width),h:Math.round(e.getBoundingClientRect().height)}:null; return {title:(t||{}).textContent||'', titleRect:b(t), noteRect:b(n)}; }); return {kline: heads.filter(h=>h.title.includes('日 K')), docOverflow: Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth}; })()`);
  await screenshot('verify-mobile-stock');
  await navigate('#scan', { waitExpr: `document.querySelectorAll('.scan-table tbody tr').length>10`, settle: 600 });
  out.mobile_scan = await evalJs(`(()=>{ let small=0; for(const el of document.querySelectorAll('button,a,.icon-star,.chip,.view-tab')){const b=el.getBoundingClientRect(); if(b.width>0&&b.height>0&&(b.width<32||b.height<32)) small++;} const star=document.querySelector('.icon-star'); const sb=star?star.getBoundingClientRect():null; const chip=document.querySelector('.chip'); const cb=chip?chip.getBoundingClientRect():null; return { docOverflow: Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth, smallTargets: small, star: sb?{w:Math.round(sb.width),h:Math.round(sb.height)}:null, chip: cb?{w:Math.round(cb.width),h:Math.round(cb.height)}:null }; })()`);
  await screenshot('verify-mobile-scan');
  await sendRaw('Emulation.clearDeviceMetricsOverride');
  view = { w: 1280, h: 1000, mobile: false, dpr: 1 };
  await setViewport(1280, 1000, false, 1);

  // ---------- V7 正常路由回归抽查 ----------
  out.routes = [];
  for (const hash of ['#today', '#scan', '#backtest']) {
    const nav = await navigate(hash, { waitExpr: WAIT_PAGE, timeout: 35000, settle: 1200 });
    const info = await pageInfo();
    const errs = collect(nav.mark);
    out.routes.push({ hash, title: info.pageTitle, warn: info.warn, console: errs.console.slice(0, 2), exceptions: errs.exceptions.slice(0, 2), http: errs.httpErrors.length, failed: errs.failed.length });
  }
  await restore();
  await writeJSON('_results-verify.json', out);
  console.log('VERIFY V1', JSON.stringify(out.v1_emptyWeight), JSON.stringify(out.v1_zeroWeight));
  console.log('VERIFY V2 invalid', JSON.stringify(out.v2_invalid));
  console.log('VERIFY V2 valid', JSON.stringify(out.v2_valid));
  console.log('VERIFY V3', JSON.stringify({ expenseNeg: out.v3_expenseNeg, coverage: out.v3_coverageAfterClamp, legacy: out.v3_legacyExpense, cashNeg: out.v3_cashNeg, cashHuge: out.v3_cashHuge, cashHero: out.v3_cashHero, planCap: out.v3_planCapitalSaved }));
  console.log('VERIFY V4', JSON.stringify(out.v4_futureDate), JSON.stringify(out.v4_hugeShares));
  console.log('VERIFY V5', JSON.stringify(out.theme));
  console.log('VERIFY V6', JSON.stringify(out.mobile_backtest), JSON.stringify(out.mobile_stock), JSON.stringify(out.mobile_scan));
  console.log('VERIFY V7', JSON.stringify(out.routes));
}

/* ------------------------------------------------------------------ */
/* 阶段 9：真断网（页面 target + Service Worker target 同时离线）      */
/* ------------------------------------------------------------------ */

function openWs(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    let sock;
    const timer = setTimeout(() => { try { sock?.close(); } catch (e) {} reject(new Error('ws open timeout')); }, timeout);
    try { sock = new WebSocket(url); } catch (e) { clearTimeout(timer); reject(e); return; }
    sock.addEventListener('open', () => { clearTimeout(timer); resolve(sock); });
    sock.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws open error')); });
  });
}

function wsSend(sock, method, params = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error(method + ' timeout')), timeout);
    const onMsg = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id !== id) return;
      clearTimeout(timer);
      sock.removeEventListener('message', onMsg);
      if (m.error) reject(new Error(method + ': ' + JSON.stringify(m.error)));
      else resolve(m.result);
    };
    sock.addEventListener('message', onMsg);
    sock.send(JSON.stringify({ id, method, params }));
  });
}

async function phaseOfflineReal() {
  await setViewport(1280, 1000, false, 1);
  const backup = await evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('d3:')).map(k=>[k,localStorage.getItem(k)])))`);
  const restore = async () => {
    await evalJs(`(()=>{ for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&(k.startsWith('d3:')||/^\d+$/.test(k))) localStorage.removeItem(k);} const o=JSON.parse(${JSON.stringify(backup)}); for(const k in o) localStorage.setItem(k,o[k]); return true; })()`);
  };
  const out = {};
  let swSock = null;
  let swOk = false;
  try {
    // 0) 冷启动：注销 SW / 清缓存，联网打开一次并等 ready（模拟新用户首次打开）
    await sendRaw('Page.navigate', { url: siteUrl('#today', { nosw: true }) });
    await sleep(2000);
    await evalJs(`(async()=>{ try { const rs=await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r=>r.unregister())); } catch(e){} try { for(const k of await caches.keys()) await caches.delete(k); } catch(e){} return true; })()`).catch(() => {});
    await sendRaw('Page.navigate', { url: siteUrl('#today', { nosw: false }) }, 30000);
    await waitFor(WAIT_PAGE, 30000);
    await evalJs(`(async()=>{ try { await navigator.serviceWorker.ready; } catch(e){} return true; })()`);
    await sleep(3000);
    await sendRaw('Page.reload', { ignoreCache: false });
    await waitFor(WAIT_PAGE, 30000);
    await sleep(1500);
    const cacheUrls = await evalJs(`(async()=>{const out=[];for(const k of await caches.keys()){const c=await caches.open(k);for(const r of await c.keys())out.push(r.url);}return out;})()`);
    out.caches = { total: (cacheUrls || []).length, hasEcharts: (cacheUrls || []).some((u) => /echarts\.min\.js/.test(u)), hasMonthly: (cacheUrls || []).some((u) => /monthly\.json/.test(u)), hasIndex: (cacheUrls || []).some((u) => /index\.html/.test(u)) };
    out.controlled = await evalJs(`!!navigator.serviceWorker.controller`);

    // 1) 连上 Service Worker target，并把它也设为离线（CDP 的页面 target 断网不覆盖 SW 自身 fetch）
    const list = await fetch(`http://127.0.0.1:${process.env.D3_CDP_PORT || '9223'}/json/list`).then((r) => r.json());
    const swTarget = list.find((t) => t.type === 'service_worker' && /sw\.js/.test(t.url || '')) || list.find((t) => t.type === 'service_worker');
    if (!swTarget) throw new Error('no service_worker target');
    swSock = await openWs(swTarget.webSocketDebuggerUrl, 6000);
    await wsSend(swSock, 'Network.enable', {}, 6000);
    await wsSend(swSock, 'Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, 6000);
    swOk = true;
    out.swTargetOffline = true;

    // 2) 页面 target 一起断网 + 清 HTTP 缓存
    await sendRaw('Network.clearBrowserCache');
    await sendRaw('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await sleep(500);

    // 3) 个股页：echarts 已预缓存，应该有图
    // 注意：SW 外壳缓存按完整 URL 匹配，只能用无查询参数的入口（真实用户从桌面图标进入也是无参数）
    await sendRaw('Page.navigate', { url: SITE + '#stock?code=600036' }, 30000);
    await waitFor(WAIT_PAGE, 25000);
    await sleep(6000);
    out.offlineStock = await evalJs(`({
      title: (document.querySelector('.page-title')||{}).textContent||'',
      warn: (document.querySelector('.banner.warn')||{}).textContent||'',
      echarts: typeof window.echarts,
      charts: document.querySelectorAll('.chart canvas').length,
      textLen: (document.body.innerText||'').trim().length,
      onLine: navigator.onLine,
    })`);
    await screenshot('verify-offline-real-stock');

    // 4) 回测页：monthly.json 未预缓存，应给中文提示而不是 503 裸报错
    await sendRaw('Page.navigate', { url: SITE + '#backtest' }, 30000);
    await waitFor(WAIT_PAGE, 25000);
    await sleep(5000);
    out.offlineBacktest = await pageInfo();
    out.offlineBacktest.hasChineseOfflineHint = /月线|联网|加载失败/.test(out.offlineBacktest.warn || '');
    await screenshot('verify-offline-real-backtest');

    // 4b) 带查询参数的入口（如书签 ?theme=light）离线会 miss SW 外壳缓存
    await sendRaw('Page.navigate', { url: SITE + '?theme=dark&t=999#today' }, 30000);
    await sleep(4000);
    out.offlineQueryUrl = await evalJs(`({title: document.title, body: (document.body.innerText||'').trim().slice(0,80)})`).catch((e) => ({ error: e.message }));

    // 5) 恢复
    await sendRaw('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    try { await wsSend(swSock, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, 6000); } catch (e) {}
    await sleep(800);
    const m2 = mark();
    await sendRaw('Page.navigate', { url: SITE + '#today' }, 30000);
    await waitFor(WAIT_PAGE, 30000);
    await sleep(1200);
    const info = await pageInfo();
    out.restored = { title: info.pageTitle, textLen: info.textLen, localFailures: collect(m2).failed.length };
  } catch (e) {
    out.error = e.message;
    try { await sendRaw('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); } catch (e2) {}
    console.log('OFFLINE-REAL failed:', e.message);
  } finally {
    try { swSock?.close(); } catch (e) {}
    await evalJs(`(async()=>{ try { const rs=await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r=>r.unregister())); } catch(e){} try { for(const k of await caches.keys()) await caches.delete(k); } catch(e){} return true; })()`).catch(() => {});
    await restore();
  }
  await writeJSON('_results-offline-real.json', out);
  console.log('OFFLINE-REAL:', JSON.stringify(out).slice(0, 2500));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let GLOBAL_BACKUP = null;

async function restoreAll() {
  if (!GLOBAL_BACKUP) return;
  try {
    await evalJs(`(()=>{ for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&(k.startsWith('d3:')||/^\\d+$/.test(k))) localStorage.removeItem(k);} const o=JSON.parse(${JSON.stringify(GLOBAL_BACKUP)}); for(const k in o) localStorage.setItem(k,o[k]); return true; })()`);
  } catch (e) { console.log('  [restoreAll] failed:', e.message); }
}

async function setup() {
  await connect();
  // 清 SW / 缓存（截图/路由阶段用 ?nosw=1，避免旧缓存），并记录初始 localStorage
  await sendRaw('Page.navigate', { url: siteUrl('#today') });
  await sleep(2500);
  try {
    await evalJs(`(async()=>{ if(navigator.serviceWorker){const rs=await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r=>r.unregister()));} if(window.caches){for(const k of await caches.keys()) await caches.delete(k);} return true;})()`);
  } catch (e) {}
  GLOBAL_BACKUP = await evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('d3:')).map(k=>[k,localStorage.getItem(k)])))`);
  console.log('localStorage baseline:', GLOBAL_BACKUP && GLOBAL_BACKUP.length > 4 ? GLOBAL_BACKUP.slice(0, 300) : '(empty)', '\n');
}

(async () => {
  const t0 = Date.now();
  await setup();
  try {
    if (want('routes')) { console.log('\n=== 1. 路由全覆盖 ==='); await phaseRoutes(); }
    if (want('mobile')) { console.log('\n=== 2. 移动端 390x844 ==='); await phaseMobile(); }
    if (want('probe')) { console.log('\n=== 2b. 布局探针 ==='); await phaseProbe(); }
    if (want('forms')) { console.log('\n=== 3. 表单极端输入 ==='); await phaseForms(); }
    if (want('dirty')) { console.log('\n=== 4. localStorage 脏数据 ==='); await phaseDirty(); }
    if (want('offline')) { console.log('\n=== 5. 离线 ==='); await phaseOffline(); }
    if (want('evidence')) { console.log('\n=== 6. 补充证据 ==='); await phaseEvidence(); }
    if (want('theme')) { console.log('\n=== 7. 深浅主题 ==='); await phaseTheme(); }
    if (want('verify')) { console.log('\n=== 8. 修复复验 ==='); await phaseVerify(); }
    if (want('offline-real')) { console.log('\n=== 9. 真断网（含 SW target） ==='); await phaseOfflineReal(); }
    if (want('diag')) { console.log('\n=== diag ==='); await phaseDiag(); }
  } finally {
    await restoreAll();
  }
  console.log(`\n总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
  ws.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
