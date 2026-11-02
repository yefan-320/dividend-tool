/**
 * 选股页：扫描榜 / 条件选股 / 多股对比 / 自选。
 * 数据全部来自本地 data/*.json；「分位」按需加载月线后计算。
 */
import { db, loadDailyMany, loadDyPct, nameOf, loadPool } from '../data.js';
import { evaluate, LEVEL as LV } from '../engine/verdict.js';
import { drawMultiLineChart } from '../charts.js';
import { loadWatch, toggleWatch, loadTxs } from '../store.js';
import { openBuyModal } from '../ui/buy.js';
import { toast } from '../ui/toast.js';
import { icon } from '../ui/icons.js';
import { esc, num, pctSign, upDown, payoutText, PAYOUT_CAP } from '../ui/format.js';
import { mountStockSearch } from '../ui/stockSearch.js';

const MAX_CMP = 4;

export const scanState = {
  view: 'scan',                 // scan | cond | cmp | watch
  sort: { key: 'level', dir: 1 },   // 结论优先：可买在最上面，不用翻过一堆被规则剔掉的怪股
  cmp: [],                      // 对比选中的代码
  filters: { minDy: 4, minConsec: 3, minPct: 0, minCap: 0, maxPayout: 100, minRoe: 0, qualityOnly: false },
  showST: false, showAbnormal: false,
  levelFilter: '',
};

let UNIVERSE = null;
let U_MAP = null;
let U_REV = -1;   // 建 UNIVERSE 时的行情版本，盯盘刷新后要重建，避免显示旧价
let PCT = null;
let PCT_PROMISE = null;
let CMP_READY = 0;
let sortPctRerendered = false;

/* ---------------- 全市场股票池（一次构建，模块内缓存） ---------------- */

function evalCtx() {
  return {
    quotes: db.quotes,
    dividends: db.baseline.dividends || {},
    f10: db.baseline.f10 || {},
    finance: db.finance || {},
    finYear: db.finYear,
  };
}

function buildUniverse() {
  if (UNIVERSE && U_REV === db.quoteRev) return UNIVERSE;
  const ctx = evalCtx();
  const pool = db.baseline.pool || {};
  const divs = db.baseline.dividends || {};
  const out = [];
  for (const [code, info] of Object.entries(pool)) {
    const q = db.quotes[code];
    if (!q?.p) continue;
    const years = divs[code]?.years || {};
    const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
    if (!ys.length) continue;
    const lastY = ys[ys.length - 1];
    let consec = 0;
    for (let y = lastY; y >= lastY - 40; y--) { if (years[y] > 0) consec++; else break; }
    const dps = years[lastY];
    const dy = (dps / q.p) * 100;
    const ev = evaluate(code, ctx);
    const m = ev.metrics;
    const quality = !!(m.hasFin && m.eps > 0
      && (m.payout == null || m.payout < 85)
      && (m.ocfCover == null || m.ocfCover >= 0.7)
      && (m.roe == null || m.roe >= 5));
    out.push({
      code, name: info.n || q.n || code, ind: info.ind || '', cap: info.cap || 0,
      price: q.p, dy, dps, lastY, consec, level: ev.level, reasons: ev.reasons,
      eps: m.eps, payout: m.payout, cover: m.ocfCover, roe: m.roe,
      hasFin: m.hasFin, quality, pct: null,
    });
  }
  if (PCT) for (const r of out) r.pct = PCT.get(r.code) ?? null;
  for (const r of out) r.score = scoreOf(r);
  out.sort((a, b) => b.dy - a.dy);
  UNIVERSE = out;
  U_MAP = new Map(out.map((r) => [r.code, r]));
  U_REV = db.quoteRev;
  return out;
}

/** 每个键的默认方向。「结论优先」是序不是升降（rank 小的在前），其它指标降序。
 *  以前两处切换都写死 -1，切一次再切回「结论优先」首屏就全是「回避」。 */
function sortDirOf(key) { return key === 'level' ? 1 : -1; }

/** 扫描榜用的综合分：股息率 + 连续分红 + 质量，0–100 */
function scoreOf(r) {
  const dyS = Math.min(8, r.dy) / 8 * 45;
  const cS = Math.min(10, r.consec) / 10 * 25;
  const qS = r.quality ? 20 : r.hasFin ? 8 : 0;
  const pS = r.pct == null ? 5 : (r.pct / 100) * 10;
  return Math.round(Math.min(100, dyS + cS + qS + pS));
}

function rowOf(code) {
  buildUniverse();
  return U_MAP.get(code) || null;
}

/* ---------------- 分位（按需加载月线，第一次约 0.3s） ---------------- */

async function ensurePct() {
  if (PCT) return PCT;
  if (PCT_PROMISE) return PCT_PROMISE;
  PCT_PROMISE = (async () => {
    const data = await loadDyPct();
    PCT = new Map(Object.entries(data));
    for (const r of UNIVERSE || []) r.pct = PCT.get(r.code) ?? null;
    return PCT;
  })();
  return PCT_PROMISE;
}

/* ---------------- 页面 ---------------- */

function viewTabs() {
  const views = [
    ['scan', '扫描榜'],
    ['cond', '条件选股'],
    ['cmp', '多股对比'],
    ['watch', `自选${loadWatch().length ? ' ' + loadWatch().length : ''}`],
  ];
  return `<div class="view-tabs">${views.map(([id, label]) => `<button class="view-tab ${scanState.view === id ? 'on' : ''}" data-view="${id}">${label}</button>`).join('')}</div>`;
}

function searchBar() {
  return `<div class="stock-search-wrap">
    <div class="stock-search">${icon('search')}<input id="scanSearch" placeholder="代码或名称，如 600519 / 茅台 / 银行" autocomplete="off" spellcheck="false"><kbd>Enter</kbd></div>
    <div id="scanSuggest" class="search-suggest" hidden></div>
  </div>`;
}

function levelPill(level) {
  const cls = { buy: 'buy', wait: 'wait', avoid: 'avoid', missing: 'na', hold: 'hold' }[level] || 'neutral';
  return `<span class="pill ${cls}">${LV[level] || level}</span>`;
}

function sortTh(key, label, cls = '') {
  const on = scanState.sort.key === key;
  const dir = on ? (scanState.sort.dir > 0 ? ' ▲' : ' ▼') : '';
  return `<th class="sortable ${on ? 'on' : ''} ${cls}" data-sort="${key}">${label}${dir}</th>`;
}

function watchBtn(code) {
  const has = loadWatch().includes(code);
  return `<button class="icon-star ${has ? 'on' : ''}" data-watch="${code}" title="${has ? '移出自选' : '加入自选'}">${has ? '★' : '☆'}</button>`;
}

function table(rows, { showPct = true } = {}) {
  const body = rows.map((r, i) => `<tr data-code="${r.code}">
    <td class="num dim">${i + 1}</td>
    <td class="name">${esc(r.name)}<span class="code">${r.code}</span></td>
    <td class="num ${r.dy >= 5 ? 'gold' : ''}">${num(r.dy, 2)}%</td>
    <td class="num">${r.consec} 年</td>
    <td class="num" ${showPct ? `data-pct="${r.code}"` : ''}>${r.pct == null ? '—' : r.pct + '%'}</td>
    <td class="num">${r.cap ? (r.cap / 1e8).toFixed(0) : '—'}</td>
    <td class="num">${payoutText(r.payout)}</td>
    <td class="num">${r.cover == null ? '—' : num(r.cover, 2)}</td>
    <td>${levelPill(r.level)}</td>
    <td class="ops">${watchBtn(r.code)}<button class="btn ghost sm" data-buy="${r.code}">买入</button></td>
  </tr>`).join('');
  return `<div class="table-wrap table-tall"><table class="table scan-table no-stack">
    <thead><tr>
      <th class="num">#</th><th>名称</th>
      ${sortTh('dy', '股息率')}${sortTh('consec', '连续分红')}${sortTh('pct', '分位')}${sortTh('cap', '市值(亿)')}
      ${sortTh('payout', '支付率')}<th>现金流覆盖</th><th>结论</th><th></th>
    </tr></thead>
    <tbody>${body || '<tr><td colspan="10" class="empty-cell">没有符合条件的股票，放宽条件试试</td></tr>'}</tbody>
  </table></div>`;
}

function baseUniverse() {
  const all = buildUniverse();
  if (scanState.showST && scanState.showAbnormal) return all;
  return all.filter((r) => (scanState.showST || !/ST|退/.test(r.name)) && (scanState.showAbnormal || r.dy <= 15));
}

function sortedUniverse() {
  const u = baseUniverse().slice();
  const { key, dir } = scanState.sort;
  // 结论优先：同一档里再按股息率降序（rank 放大后减去 dy，升序排就是「好的在前、同档息高的在前」）
  const RANK = { buy: 0, wait: 1, hold: 2, avoid: 3, missing: 4 };
  const val = (r) => {
    if (key === 'level') return (RANK[r.level] ?? 9) * 10000 - r.dy;
    if (key === 'pct') return r.pct == null ? -1 : r.pct;
    if (key === 'cap') return r.cap || 0;
    // 异常支付率（分母坏了）不参与排序，否则「按支付率排」的第一名永远是几千 %
    if (key === 'payout') return r.payout == null || r.payout > PAYOUT_CAP ? 999 : r.payout;
    if (key === 'consec') return r.consec;
    if (key === 'score') return r.score;
    return r.dy;
  };
  u.sort((a, b) => (val(a) - val(b)) * dir);
  return u;
}

/** 这两个开关一年改不了几次（默认排除 ST 和假高息本来就是对的），
 *  摊在首屏要占 140px，等于拿两行股票的位置换两个几乎不碰的复选框。收起来。 */
function toggleChips() {
  const off = !scanState.showST || !scanState.showAbnormal;
  return `<details class="scan-more" style="margin:0 0 12px"${off ? '' : ' open'}>
    <summary>筛选<span class="sm-note">默认排除 ST 与异常高股息（一次性分红 / 股价大跌的假象）</span></summary>
    <div class="chip-row" style="margin:8px 0 12px">
      <button class="chip ${scanState.showST ? 'on' : ''}" data-toggle="showST">${scanState.showST ? '☑' : '☐'} 含 ST / 退市</button>
      <button class="chip ${scanState.showAbnormal ? 'on' : ''}" data-toggle="showAbnormal">${scanState.showAbnormal ? '☑' : '☐'} 含股息率 &gt;15% 异常</button>
    </div>
  </details>`;
}

function levelChips(u) {
  const counts = { buy: 0, wait: 0, avoid: 0, missing: 0 };
  for (const r of u) counts[r.level] = (counts[r.level] || 0) + 1;
  // 「数据不足 0」这种 chip 占一整行不干别的事，0 就不显示
  const items = [['', '全部', u.length], ['buy', '可买', counts.buy], ['wait', '观察', counts.wait], ['avoid', '回避', counts.avoid]]
    .filter(([id, , n]) => id === '' || n > 0);
  if (counts.missing > 0) items.push(['missing', '数据不足', counts.missing]);
  return `<div class="chip-row" style="margin:8px 0 12px">${items.map(([id, label, n]) => `<button class="chip ${scanState.levelFilter === id ? 'on' : ''} ${id === 'buy' && n > 0 ? 'is-buy' : ''}" data-level="${id}">${label} <b class="num">${n}</b></button>`).join('')}</div>`;
}

const SORT_LABEL = { level: '结论优先', dy: '股息率', consec: '连续分红', pct: '分位', cap: '市值', payout: '支付率', score: '综合分' };

function scanView() {
  const all = baseUniverse();
  const u = scanState.levelFilter ? all.filter((r) => r.level === scanState.levelFilter) : all;
  const list = (u === all ? sortedUniverse() : u.slice().sort((a, b) => b.dy - a.dy)).slice(0, 100);
  // 筛到 0 只时不要整页 return ''：那样连筛选按钮一起没了，用户只能刷新
  if (!list.length) {
    return `${levelChips(all)}
  ${toggleChips()}
  <section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">扫描榜</span><span class="section-note">当前筛选 0 只</span></div>
    <div class="panel-body" style="padding:26px 12px;text-align:center;color:var(--text-3);font-size:13px">
      这个筛选条件下<b>一只都没有</b>。换个等级，或者点「全部」看 ${all.length} 只。
    </div>
  </section>`;
  }
  const maxScore = Math.max(...list.map((x) => x.score || 0), 1);
  const sortKey = scanState.sort.key;
  // 「结论优先」是一个序，不是升降；给它配箭头只会让人问「↑ 是好还是坏」
  const sortDir = sortKey === 'level' ? '' : (scanState.sort.dir > 0 ? '↑' : '↓');
  return `${levelChips(all)}
  ${toggleChips()}
  <section class="panel fade-in">
    <div class="panel-head">
      <span class="panel-title">扫描榜</span>
      <label class="scan-sort-inline">
        <span>排序</span>
        <select id="scanSort">${Object.entries(SORT_LABEL).map(([k, label]) => `<option value="${k}"${k === sortKey ? ' selected' : ''}>${label}${k === sortKey ? sortDir : ''}</option>`).join('')}</select>
      </label>
    </div>
    ${table(list)}
  </section>
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">综合分前 12</span><span class="section-note">股息率 45 + 连续分红 25 + 质量 20 + 分位 10</span></div>
    <div class="scan-cards">
      ${all.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 12).map((r) => `<div class="scan-card" data-code="${r.code}">
        <div class="sc-head"><span class="sc-name">${esc(r.name)}</span><span class="sc-code">${r.code}</span><span class="sc-score num">${r.score}</span></div>
        <div class="sc-bar"><i style="width:${Math.round((r.score / maxScore) * 100)}%"></i></div>
        <div class="sc-meta">股息 ${num(r.dy, 2)}% · 连续 ${r.consec} 年 · ${levelPill(r.level)}</div>
        <div class="sc-ops">${watchBtn(r.code)}<button class="btn ghost sm" data-buy="${r.code}">买入</button></div>
      </div>`).join('')}
    </div>
  </section>`;
}

function condView() {
  const u = baseUniverse();
  const f = scanState.filters;
  const rows = u.filter((r) => r.dy >= f.minDy
    && r.consec >= f.minConsec
    && (r.pct == null ? f.minPct <= 0 : r.pct >= f.minPct)
    && (r.cap / 1e8) >= f.minCap
    && (r.payout == null || r.payout <= f.maxPayout)
    && (r.roe == null || r.roe >= f.minRoe)
    && (!f.qualityOnly || r.quality));
  rows.sort((a, b) => b.dy - a.dy);
  return `<section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">条件选股</span><span class="section-note">改条件 → 点应用</span></div>
    ${toggleChips()}
    <div class="panel-body cond-bar">
      <label><span>股息率 ≥</span><input class="input" id="cfDy" type="number" step="0.5" min="0" max="15" value="${f.minDy}"><em>%</em></label>
      <label><span>连续分红 ≥</span><input class="input" id="cfConsec" type="number" step="1" min="0" max="20" value="${f.minConsec}"><em>年</em></label>
      <label><span>分位 ≥</span><input class="input" id="cfPct" type="number" step="5" min="0" max="100" value="${f.minPct}"><em>%</em></label>
      <label><span>市值 ≥</span><input class="input" id="cfCap" type="number" step="50" min="0" value="${f.minCap}"><em>亿</em></label>
      <label><span>支付率 ≤</span><input class="input" id="cfPayout" type="number" step="5" min="0" max="200" value="${f.maxPayout}"><em>%</em></label>
      <label><span>ROE ≥</span><input class="input" id="cfRoe" type="number" step="1" min="0" value="${f.minRoe}"><em>%</em></label>
      <label class="cond-check"><input type="checkbox" id="cfQuality" ${f.qualityOnly ? 'checked' : ''}> 只要质量过关</label>
      <button class="btn primary" id="cfApply">${icon('filter')} 应用</button>
    </div>
    <div class="panel-body" style="padding-top:0">
      <div class="cond-count">命中 <b class="num gold">${rows.length}</b> 只（按股息率降序，显示前 80）</div>
      ${table(rows.slice(0, 80))}
    </div>
  </section>`;
}

function cmpChips() {
  const watch = loadWatch();
  const hold = [...new Set(loadTxs().map((t) => t.code))];
  const hot = baseUniverse().slice().sort((a, b) => b.dy - a.dy).slice(0, 10).map((r) => r.code);
  const pool = [...new Set([...scanState.cmp, ...watch, ...hold, ...hot])].slice(0, 24);
  return pool.map((c) => {
    const on = scanState.cmp.includes(c);
    return `<button class="chip ${on ? 'on' : ''}" data-cmp="${c}">${esc(nameOf(c))}</button>`;
  }).join('');
}

function cmpTable() {
  const rows = scanState.cmp.map((code) => rowOf(code)).filter(Boolean);
  if (!rows.length) return '';
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>指标</th>${rows.map((r) => `<th class="num">${esc(r.name)}</th>`).join('')}</tr></thead>
    <tbody>
      <tr><td>现价</td>${rows.map((r) => `<td class="num">${num(r.price, 2)}</td>`).join('')}</tr>
      <tr><td>股息率</td>${rows.map((r) => `<td class="num gold">${num(r.dy, 2)}%</td>`).join('')}</tr>
      <tr><td>连续分红</td>${rows.map((r) => `<td class="num">${r.consec} 年</td>`).join('')}</tr>
      <tr><td>股息率分位</td>${rows.map((r) => `<td class="num" data-pct="${r.code}">${r.pct == null ? '—' : r.pct + '%'}</td>`).join('')}</tr>
      <tr><td>支付率</td>${rows.map((r) => `<td class="num">${payoutText(r.payout)}</td>`).join('')}</tr>
      <tr><td>现金流覆盖</td>${rows.map((r) => `<td class="num">${r.cover == null ? '—' : num(r.cover, 2)}</td>`).join('')}</tr>
      <tr><td>ROE</td>${rows.map((r) => `<td class="num">${r.roe == null ? '—' : num(r.roe, 1) + '%'}</td>`).join('')}</tr>
      <tr><td>结论</td>${rows.map((r) => `<td>${levelPill(r.level)}</td>`).join('')}</tr>
    </tbody>
  </table></div>`;
}

function cmpView() {
  return `<section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">多股对比</span><span class="section-note">最多选 ${MAX_CMP} 只 · 点下面标签切换</span></div>
    <div class="panel-body" style="padding-top:6px">
      <div class="chip-row">${cmpChips()}</div>
      ${scanState.cmp.length ? cmpTable() : '<div class="empty-block">先点上面的股票标签，选 2–4 只对比</div>'}
    </div>
  </section>
  ${scanState.cmp.length >= 2 ? `<section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">股价走势（归一 100）</span><span class="section-note">日 K · 不复权 · 2018 年起</span></div>
    <div class="panel-body" style="padding:8px 10px 4px"><div id="cmpChart" class="chart" style="height:320px"></div></div>
  </section>` : ''}`;
}

function watchView() {
  const list = loadWatch();
  if (!list.length) return `<section class="panel fade-in"><div class="empty-block">还没有自选。在「扫描榜 / 条件选股 / 个股页」点 ☆ 就能加入。</div></section>`;
  const rows = list.map((c) => rowOf(c)).filter(Boolean);
  if (!rows.length) return `<section class="panel fade-in"><div class="empty-block">自选里的股票缺少行情/分红数据。</div></section>`;
  return `<section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">自选</span><span class="section-note">${rows.length} 只 · 只存本地</span></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>名称</th><th class="num">现价</th><th class="num">股息率</th><th class="num">连续分红</th><th class="num">分位</th><th>结论</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-code="${r.code}">
        <td class="name">${esc(r.name)}<span class="code">${r.code}</span></td>
        <td class="num">${num(r.price, 2)}</td>
        <td class="num gold">${num(r.dy, 2)}%</td>
        <td class="num">${r.consec} 年</td>
        <td class="num" data-pct="${r.code}">${r.pct == null ? '—' : r.pct + '%'}</td>
        <td>${levelPill(r.level)}</td>
        <td class="ops">${watchBtn(r.code)}<button class="btn ghost sm" data-buy="${r.code}">买入</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

function syncHashView() {
  const view = scanState.view;
  const hash = '#scan' + (view && view !== 'scan' ? '?view=' + view : '');
  try { history.replaceState(null, '', hash); } catch (e) {}
}

function readUrlView() {
  const qs = new URLSearchParams((location.hash.split('?')[1] || ''));
  const v = qs.get('view');
  if (['scan', 'cond', 'cmp', 'watch'].includes(v)) scanState.view = v;
  const cmp = qs.get('cmp');
  if (cmp) scanState.cmp = cmp.split(',').filter((c) => /^\d{6}$/.test(c)).slice(0, MAX_CMP);
}

export async function renderScanPage() {
  // 选股要全市场池
  await loadPool();
  readUrlView();
  const body = scanState.view === 'cond' ? condView()
    : scanState.view === 'cmp' ? cmpView()
      : scanState.view === 'watch' ? watchView()
        : scanView();
  return `<div class="page-head fade-in">
    <div>
      <h1 class="page-title">选股</h1>
    </div>
  </div>
  ${searchBar()}
  ${viewTabs()}
  <div id="scanBody">${body}</div>`;
}

/* ---------------- 渲染后绑定 ---------------- */

export async function bindScan() {
  const rerender = () => window.__rerender?.();
  const root = document.getElementById('scanBody');
  if (!root) return;

  const search = document.getElementById('scanSearch');
  if (search) {
    mountStockSearch(search, {
      suggest: document.getElementById('scanSuggest'),
      onPick: (c) => { if (/^\d{6}$/.test(c || '')) location.hash = 'stock?code=' + c; },
    });
  }
  document.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => { scanState.view = b.dataset.view; syncHashView(); rerender(); };
  });
  document.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = () => { scanState[b.dataset.toggle] = !scanState[b.dataset.toggle]; rerender(); };
  });
  document.querySelectorAll('[data-level]').forEach((b) => {
    b.onclick = () => { scanState.levelFilter = b.dataset.level; rerender(); };
  });
  const sortSel = document.getElementById('scanSort');
  if (sortSel) {
    sortSel.onchange = () => {
      scanState.sort = { key: sortSel.value, dir: sortDirOf(sortSel.value) };
      rerender();
    };
  }
  document.querySelectorAll('[data-sort]').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      // 点「结论」列不翻转方向：这个键只有一个合理的序，翻了就是「回避在前」
      if (key === 'level') scanState.sort = { key, dir: 1 };
      else if (scanState.sort.key === key) scanState.sort.dir *= -1;
      else scanState.sort = { key, dir: sortDirOf(key) };
      rerender();
    };
  });
  document.querySelectorAll('[data-watch]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const added = toggleWatch(b.dataset.watch);
      b.classList.toggle('on', added);
      b.textContent = added ? '★' : '☆';
      toast(added ? '已加入自选' : '已移出自选');
      if (scanState.view === 'watch') rerender();
    };
  });
  document.querySelectorAll('[data-buy]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openBuyModal(b.dataset.buy); };
  });
  document.querySelectorAll('tr[data-code], .scan-card[data-code]').forEach((el) => {
    el.onclick = () => { location.hash = 'stock?code=' + el.dataset.code; };
  });
  const apply = document.getElementById('cfApply');
  if (apply) {
    apply.onclick = () => {
      scanState.filters = {
        minDy: Number(document.getElementById('cfDy')?.value) || 0,
        minConsec: Number(document.getElementById('cfConsec')?.value) || 0,
        minPct: Number(document.getElementById('cfPct')?.value) || 0,
        minCap: Number(document.getElementById('cfCap')?.value) || 0,
        maxPayout: Number(document.getElementById('cfPayout')?.value) || 100,
        minRoe: Number(document.getElementById('cfRoe')?.value) || 0,
        qualityOnly: !!document.getElementById('cfQuality')?.checked,
      };
      rerender();
    };
  }
  document.querySelectorAll('[data-cmp]').forEach((b) => {
    b.onclick = () => {
      const c = b.dataset.cmp;
      const i = scanState.cmp.indexOf(c);
      if (i >= 0) scanState.cmp.splice(i, 1);
      else if (scanState.cmp.length < MAX_CMP) scanState.cmp.push(c);
      else toast(`最多对比 ${MAX_CMP} 只`);
      rerender();
    };
  });

  // 分位：懒加载月线后回填
  const pctCells = () => document.querySelectorAll('[data-pct]');
  if (pctCells().length) {
    try {
      await ensurePct();
      pctCells().forEach((el) => {
        const v = PCT?.get(el.dataset.pct);
        if (v != null) el.textContent = v + '%';
      });
      if (scanState.sort.key === 'pct' && !sortPctRerendered) { sortPctRerendered = true; rerender(); }
    } catch (e) { console.error(e); }
  }

  // 多股对比图
  if (scanState.view === 'cmp' && scanState.cmp.length >= 2) {
    try {
      await drawCmpChart(scanState.cmp);
    } catch (e) { console.error(e); }
  }
  CMP_READY = (CMP_READY + 1) % 1000;
}

async function drawCmpChart(codes) {
  const el = document.getElementById('cmpChart');
  if (!el) return;
  const [daily] = await Promise.all([loadDailyMany(codes)]);
  const colors = ['#d8a84e', '#5b9cf5', '#ef5b60', '#35b57a'];
  const lines = [];
  codes.forEach((c, i) => {
    const d = daily.get(c);
    if (!d || !d.cal) return;
    const rows = [];
    for (let k = 0; k < d.cal.length; k++) if (d.c[k] != null) rows.push([d.cal[k], d.c[k]]);
    if (rows.length < 2) return;
    const base = rows[0][1];
    lines.push({
      name: nameOf(c),
      rows: rows.map(([date, v]) => [date, +((v / base) * 100).toFixed(1)]),
      color: colors[i % colors.length],
      width: 1.8,
    });
  });
  if (lines.length) drawMultiLineChart(el, lines, { yFmt: (v) => v.toFixed(0) });
}
