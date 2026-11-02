/**
 * 全站统一的股票搜索：代码 / 中文名 / 行业，三样都能搜。
 *
 * 数据源是 data/name-idx.txt（一行一只：600519|贵州茅台|白酒Ⅱ）。
 * 单独一份而不是 loadPool()：pool.json 带市值 369KB，个股页为了搜一只股票
 * 去下整包股票池不划算。这份 gzip 58KB，而且进来先后台预取，打字时基本已经在内存里。
 *
 * 规矩：
 *   - 输入 3 位以上数字 → 按代码前缀搜
 *   - 输入中文 → 名字「包含」就命中（茅台 → 贵州茅台），不要求开头
 *   - 名字里的空格先归一化（五 粮 液 → 五粮液）
 *   - 行业也能搜（白酒 → 白酒Ⅱ 整个板块）
 */

const IDX_URL = new URL('../../data/name-idx.txt', import.meta.url);

/** @type {{code:string,name:string,ind:string,norm:string,norml:string,indl:string,cap:number}[]|null} */
let ROWS = null;
let LOADING = null;

/**
 * 口语简称。股民嘴上不说「工商银行」说「工行」——
 * 这类简称在正式名字里一个字都对不上，光靠「名字包含」永远搜不到，得单独记一张表。
 * （茅台 / 格力 / 宁德 / 万科 这种名字里本来就有，不用写进来）
 */
const ALIAS = {
  工行: '601398', 建行: '601939', 农行: '601288', 中行: '601988',
  交行: '601328', 招行: '600036', 邮储: '601658',
  中石油: '601857', 中石化: '600028', 中神华: '601088',
  招蛇: '001979', 招保万金: '600048',
};

/** 代码 → 行，给简称表用 */
const BY_CODE = new Map();

function parse(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const p = line.split('|');
    if (p.length < 2) continue;
    const code = p[0];
    if (!/^\d{6}$/.test(code)) continue;
    const name = p[1];
    const ind = p[2] || '';
    // 名字里的空格先归一化（五 粮 液 → 五粮液）；小写化留给比较时做，免得丢原名
    const norm = name.replace(/\s+/g, '');
    out.push({ code, name, ind, norm, norml: norm.toLowerCase(), indl: ind.toLowerCase(), cap: p[3] === undefined ? 7 : Number(p[3]) });
  }
  BY_CODE.clear();
  for (const r of out) BY_CODE.set(r.code, r);
  return out;
}

/** 拉索引（并发只发一次）。失败不抛，搜索退化成「只有代码」。 */
export function loadNameIndex() {
  if (ROWS) return Promise.resolve(ROWS);
  if (!LOADING) {
    LOADING = fetch(IDX_URL, { cache: 'force-cache' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => { ROWS = parse(t); return ROWS; })
      .catch(() => { ROWS = ROWS || []; return ROWS; });
  }
  return LOADING;
}

/** 进来就在后台预取，别等用户打完字才去下。 */
export function primeNameIndex() {
  if (ROWS || LOADING) return;
  const run = () => loadNameIndex().catch(() => {});
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2500 });
  else setTimeout(run, 600);
}

export function nameIndexReady() {
  return !!ROWS && ROWS.length > 0;
}

/** 单只股票的静态信息（名字/行业/市值档），来自已经在内存里的索引，不额外下载。
    索引还没到位就返回 null，调用方降级显示。 */
export function stockMeta(code) {
  const r = BY_CODE.get(String(code || ''));
  return r ? { code: r.code, name: r.name, ind: r.ind, cap: r.cap } : null;
}

/** 归一化关键词：去空格、转小写 */
function normKey(kw) {
  return String(kw || '').trim().replace(/\s+/g, '');
}

/**
 * 同步搜索。索引没到位时返回 []（挂载层会先显示「正在载入」再重画）。
 *
 * 排序（分数从高到低）：
 *   1000 代码全等 · 950 简称（工行 → 工商银行）
 *    900 代码前缀
 *    880 名字全等
 *    800 名字前缀（同分比市值档：格力 → 格力电器，不是格力博）
 *    700 名字包含，越靠前越高
 *    560 行业前缀 / 500 行业包含
 * 同分按市值档 → 代码升序。
 */
export function searchStocks(kw, { limit = 8, exclude = [] } = {}) {
  const raw = normKey(kw);
  if (!raw || !ROWS) return [];
  const k = raw.toLowerCase();
  const isDigits = /^\d+$/.test(k);
  const skip = new Set((exclude || []).map(String));
  const hits = [];

  for (let i = 0; i < ROWS.length; i++) {
    const r = ROWS[i];
    if (skip.has(r.code)) continue;
    let s = 0;
    if (isDigits) {
      if (r.code === k) s = 1000;
      else if (r.code.startsWith(k)) s = 900;
      else if (r.code.includes(k)) s = 600;
    } else if (r.norml === k) {
      s = 880;
    } else if (r.norml.startsWith(k)) {
      s = 800;
    } else {
      const at = r.norml.indexOf(k);
      if (at >= 0) s = 700 - at * 6;
      else if (r.indl.startsWith(k)) s = 560;
      else if (r.indl.includes(k)) s = 500;
    }
    if (s > 0) {
      hits.push({ code: r.code, name: r.name, ind: r.ind, score: s, cap: r.cap });
      if (hits.length >= 300) break;
    }
  }

  // 简称排在所有名字匹配之前（工行 → 工商银行，别人抢不到第一位）
  const al = ALIAS[k];
  if (al && !skip.has(al)) {
    const r = BY_CODE.get(al);
    if (r) {
      const at = hits.findIndex((h) => h.code === al);
      const row = { code: r.code, name: r.name, ind: r.ind, score: 950, cap: r.cap };
      if (at >= 0) hits[at] = row;
      else hits.push(row);
    }
  }

  hits.sort((a, b) => b.score - a.score || a.cap - b.cap || a.code.localeCompare(b.code));
  return hits.slice(0, limit).map(({ code, name, ind }) => ({ code, name, ind }));
}

/** 给一个关键词，直接拿最可能的那只（Enter 用） */
export function firstPick(kw, opts) {
  const l = searchStocks(kw, { limit: 1, ...opts });
  return l[0] || null;
}

/**
 * 把输入框接上下拉建议。
 *
 * @param {HTMLInputElement|null} input
 * @param {{
 *   suggest: HTMLElement|null,
 *   onPick: (code:string, row:object)=>void,
 *   exclude?: string[],
 *   limit?: number,
 *   showDy?: (code:string)=>string,   // 右侧附加列（组合弹窗显示股息率）
 * }} opt
 */
export function mountStockSearch(input, opt = {}) {
  const { suggest, onPick, exclude = [], limit = 8, showDy } = opt;
  if (!input) return;
  let list = [];
  let active = -1;
  let pending = false;

  const paint = () => {
    if (!suggest) return;
    if (pending) {
      suggest.hidden = false;
      suggest.innerHTML = '<div class="sg-item sg-loading"><b>正在载入股票名…</b><span></span></div>';
      return;
    }
    if (!list.length) {
      const kw = input.value.trim();
      if (!kw) { suggest.hidden = true; suggest.innerHTML = ''; return; }
      // 有输入但一条没有：把话说清楚，别让用户以为「按了没反应」
      suggest.hidden = false;
      suggest.innerHTML = `<div class="sg-item sg-empty"><b>没找到「${esc(kw)}」</b><span>换个名字或 6 位代码</span></div>`;
      return;
    }
    suggest.hidden = false;
    suggest.innerHTML = list.map((r, i) => `<div class="sg-item ${i === active ? 'on' : ''}" data-code="${r.code}">
      <b>${esc(r.name)}</b>
      <span>${r.code}${showDy ? ' · ' + esc(showDy(r.code)) : r.ind ? ' · ' + esc(r.ind) : ''}</span>
    </div>`).join('');
  };

  const refresh = () => {
    const v = input.value.trim();
    if (!v) { list = []; active = -1; pending = false; paint(); return; }
    if (!nameIndexReady()) {
      pending = true;
      active = -1;
      paint();
      loadNameIndex().then(() => { pending = false; if (input.value.trim() === v) refresh(); });
      return;
    }
    pending = false;
    list = searchStocks(v, { limit, exclude });
    active = list.length ? 0 : -1;
    paint();
  };

  const pick = (row) => {
    if (!row) return;
    suggest && (suggest.hidden = true);
    onPick?.(row.code, row);
  };

  input.oninput = refresh;
  input.onfocus = () => { if (!nameIndexReady()) loadNameIndex(); if (input.value.trim()) refresh(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = list[active] || list[0] || firstPick(input.value, { exclude });
      if (row) pick(row);
    } else if (e.key === 'Escape') {
      list = []; active = -1; pending = false; paint();
    }
  };
  if (suggest) {
    suggest.onmousedown = (e) => {
      const it = e.target.closest('[data-code]');
      if (it) {
        e.preventDefault();
        pick({ code: it.dataset.code });
      }
    };
  }
  input.onblur = () => setTimeout(() => { list = []; active = -1; pending = false; paint(); }, 140);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
