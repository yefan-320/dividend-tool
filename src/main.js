import { renderToday } from './pages/today.js';
import { renderStock, bindStock } from './pages/stock.js';
import { renderScanPage, bindScan } from './pages/scan.js';
import { renderBacktest, bindBacktest, setBacktestRerender } from './pages/backtest.js';
import { renderMine, bindMine } from './pages/mine.js';
import { icon } from './ui/icons.js';
import { applyTableLayout, refreshTableHints } from './ui/table.js';
import { loadCore, db, applyQuoteCache, refreshQuotes } from './data.js';
import { loadSettings } from './store.js';
import { toast } from './ui/toast.js';
import { closeModal } from './ui/modal.js';
import { primeNameIndex } from './ui/stockSearch.js';

const PAGES = [
  { id: 'today', label: '今天', icon: 'home', render: renderToday },
  { id: 'scan', label: '选股', icon: 'filter', render: renderScanPage, bind: bindScan },
  { id: 'stock', label: '个股', icon: 'search', render: renderStock, bind: bindStock },
  { id: 'backtest', label: '回测', icon: 'chart', render: renderBacktest, bind: bindBacktest },
  { id: 'mine', label: '我的', icon: 'user', render: renderMine, bind: bindMine },
];

/** 版本号：发版时跟 sw.js 的 SHELL_CACHE、package.json 一起升 */
const APP_VERSION = '1.8.0';

const app = document.getElementById('app');
const sidebar = document.getElementById('sidebar');
const tabbar = document.getElementById('tabbar');

function currentId() {
  const id = (location.hash || '').replace(/^#/, '').split('?')[0];
  return PAGES.some((p) => p.id === id) ? id : 'today';
}

/** 构建时间：拿 index.html 的 Last-Modified，就是这次部署的时间 */
function buildTime() {
  try {
    const d = new Date(document.lastModified);
    if (!Number.isFinite(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return ` · ${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return ''; }
}

function sidebarFooter() {
  const m = db;
  return `<div class="sidebar-foot">
    <div class="side-status"><span class="dot"></span> 按需联网 · 本地缓存</div>
    <div>行情 <b>${m.generated || '—'}</b><span class="quote-status" id="quoteStatus"></span></div>
    <div>财报 <b>${Object.keys(m.finance || {}).length || 5377}</b> · 分红 <b>按需</b>（已载 ${Object.keys(m.baseline?.dividends || {}).length} 只）</div>
    <div>日 K 按需联网 · 月线按需</div>
    <div class="side-ver" id="sideVer">v${APP_VERSION}<span class="ver-time">${buildTime()}</span></div>
  </div>`;
}

function renderSidebar(active) {
  sidebar.innerHTML = `
    <div class="brand">
      <div class="brand-mark">红</div>
      <div>
        <div class="brand-name">红利工具</div>
        <div class="brand-sub">DIVIDEND TOOL</div>
      </div>
    </div>
    <nav class="nav">
      ${PAGES.map((p) => `<a href="#${p.id}" data-id="${p.id}" class="${p.id === active ? 'active' : ''}">${icon(p.icon)}<span>${p.label}</span></a>`).join('')}
    </nav>
    ${sidebarFooter()}`;
}

function renderTabbar(active) {
  tabbar.innerHTML = PAGES.map((p) => `<a href="#${p.id}" class="${p.id === active ? 'active' : ''}">${icon(p.icon)}<span>${p.label}</span></a>`).join('');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('d3:theme', theme);
  // iOS 地址栏 / PWA 状态栏颜色跟着深浅色走（只更新 theme-color 标签，不重排）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
}

function bindCommon() {
  document.querySelectorAll('[data-code]').forEach((el) => {
    el.onclick = () => { location.hash = 'stock?code=' + el.dataset.code; };
    el.onkeydown = (e) => { if (e.key === 'Enter') location.hash = 'stock?code=' + el.dataset.code; };
  });
  document.querySelectorAll('#themeBtn,#themeBtn2').forEach((b) => {
    b.onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      renderPage();
    };
  });
}

function skeleton() {
  return `<div class="skeleton-page">
    <div class="skeleton sk-title"></div>
    <div class="skeleton sk-sub"></div>
    <div class="skeleton sk-hero"></div>
    <div class="skeleton-row"><div class="skeleton sk-card"></div><div class="skeleton sk-card"></div><div class="skeleton sk-card"></div></div>
    <div class="skeleton sk-chart"></div>
  </div>`;
}

let renderToken = 0;

/** 换页前销毁旧图表实例：否则每次切换都留一批 canvas + 监听在已摘掉的 DOM 上（内存只增不减） */
function disposeCharts() {
  const ec = window.echarts;
  if (!ec) return;
  document.querySelectorAll('.chart').forEach((el) => {
    try { const ch = ec.getInstanceByDom(el); if (ch) ch.dispose(); } catch (e) { /* 已销毁 */ }
  });
}

async function renderPage() {
  // 快速切换 tab 时，上一次异步 render 可能后返回；用 token 丢弃过期结果，避免旧页面覆盖新页面
  const token = ++renderToken;
  closeModal();
  const id = currentId();
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  document.title = `${page.label} · 红利工具`;
  renderSidebar(page.id);
  renderTabbar(page.id);
  const loadingTimer = setTimeout(() => { if (token === renderToken) app.innerHTML = skeleton(); }, 120);
  try {
    const html = await page.render();
    if (token !== renderToken) { clearTimeout(loadingTimer); return; }
    clearTimeout(loadingTimer);
    disposeCharts();
    app.innerHTML = html;
    try { applyTableLayout(app); } catch (e) { console.error('[表格布局]', e); }
  } catch (e) {
    clearTimeout(loadingTimer);
    if (token !== renderToken) return;
    console.error(e);
    disposeCharts();
    app.innerHTML = `<div class="banner warn" style="margin:24px">页面加载失败：${e.message}<br>请刷新重试，或确认网络后再打开。</div>`;
  }
  if (token !== renderToken) return;
  app.classList.remove('fade-in');
  void app.offsetWidth;
  app.classList.add('fade-in');
  // 所有页面右上角都有主题切换（今天页自带）
  const head = app.querySelector('.page-head');
  if (head && !head.querySelector('#themeBtn')) {
    let actions = head.querySelector('.page-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'page-actions';
      head.appendChild(actions);
    }
    const b = document.createElement('button');
    b.className = 'btn ghost icon-btn';
    b.id = 'themeBtn';
    b.title = '切换深浅色';
    actions.prepend(b);
  }
  bindCommon();
  if (page.bind) {
    try { await page.bind(); } catch (e) { console.error('[页面绑定]', e); }
  }
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', renderPage);
window.addEventListener('resize', () => {
  document.querySelectorAll('.chart').forEach((el) => {
    const ch = window.echarts?.getInstanceByDom(el);
    if (ch) ch.resize();
  });
  refreshTableHints();
});

window.__rerender = renderPage;
window.__toast = toast;

function setQuoteStatus(text) {
  const el = document.getElementById('quoteStatus');
  if (el) el.textContent = text ? ' · ' + text : '';
}

let refreshing = false;
/** 需要「实时价刷全市场」的页面：只有它们要遍历全池算候选。其余页用本地快照。 */
const autoQuotePages = new Set(['today', 'scan']);

async function refreshQuotesInBackground() {
  if (refreshing) return { ok: false };
  refreshing = true;
  setQuoteStatus('刷新中…');
  const r = await refreshQuotes().catch(() => ({ ok: false }));
  refreshing = false;
  if (r.ok) {
    const t = new Date();
    setQuoteStatus(`已更新 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} · ${r.count} 只`);
    if (r.changed) {
      toast(`行情已更新至 ${r.date}`);
      await renderPage();
      setQuoteStatus(`已更新 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`);
    }
  } else {
    setQuoteStatus(r.reason === 'offline' ? '离线 · 用本地快照' : '刷新失败 · 用本地快照');
  }
  return r;
}
window.__refreshQuotes = refreshQuotesInBackground;

async function boot() {
  const urlTheme = new URLSearchParams(location.search).get('theme');
  applyTheme(urlTheme === 'light' || urlTheme === 'dark' ? urlTheme : (localStorage.getItem('d3:theme') || 'dark'));
  // 首屏先画导航和骨架，不等 2.3MB 核心数据：弱网/手机上先有反馈，避免白屏
  const bootId = currentId();
  document.title = `${(PAGES.find((p) => p.id === bootId) || PAGES[0]).label} · 红利工具`;
  renderSidebar(bootId);
  renderTabbar(bootId);
  app.innerHTML = skeleton();
  // 搜索索引 58KB：等首屏数据落地了再补，不和核心数据抢带宽
  setTimeout(() => primeNameIndex(), 3000);
  try {
    await loadCore();
    performance.mark?.('d3-core-done');
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="banner warn" style="margin:24px">数据加载失败：${e.message}<br>请刷新重试，或检查网络后重新打开。</div>`;
    return;
  }
  setBacktestRerender(() => renderPage());
  try { await applyQuoteCache(); } catch (e) {}
  await renderPage();
  performance.mark?.('d3-first-render');
  // 首屏之后后台刷新全市场行情。
  //
  // ⚠ 只在「今天 / 选股」两个真要遍历全市场的页面刷：那是 5552 只、约 1.26MB，
  // 慢网下一开就把带宽吃光，别的页面（回测 / 组合对比）的数据全排它后面——
  // 组合对比在手机上打不开，一半是这个原因。其它页用本地快照，够用。
  if (autoQuotePages.has(currentId())) setTimeout(() => { refreshQuotesInBackground(); }, 800);
  warmChartsCache();
}

/** 让 SW 用空闲时间补下图表库（离线画图用）；省流量/2G/3G 不补，画图时再按需加载。
    首屏后 10 秒才动：那 327KB 在慢网上一开下，页面自己的数据就得排队。 */
function warmChartsCache() {
  try {
    const conn = navigator.connection || {};
    if (conn.saveData || /^(slow-)?[23]g$/.test(conn.effectiveType || '')) return;
    const post = () => {
      try { navigator.serviceWorker?.controller?.postMessage({ type: 'warm-charts' }); } catch (e) {}
    };
    setTimeout(() => {
      if (window.requestIdleCallback) window.requestIdleCallback(post, { timeout: 6000 });
      else post();
    }, 10000);
  } catch (e) { /* 不支持就只走按需加载 */ }
}

// PWA：注册 Service Worker（测试页面可用 ?nosw=1 跳过，避免缓存干扰）
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/nosw=1/.test(location.search)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // 有新版本装好了就告诉用户（否则他永远不知道页面是不是新的）
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast(`新版本已就绪（v${APP_VERSION}），刷新页面即可用`);
          }
        });
      });
    }).catch(() => {});
  });
}

boot();
