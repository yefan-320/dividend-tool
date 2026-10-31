import { renderToday } from './pages/today.js';
import { renderStock, bindStock } from './pages/stock.js';
import { renderScanPage, bindScan } from './pages/scan.js';
import { renderBacktest, bindBacktest, setBacktestRerender } from './pages/backtest.js';
import { renderMine, bindMine } from './pages/mine.js';
import { icon } from './ui/icons.js';
import { loadCore, db, applyQuoteCache, refreshQuotes } from './data.js';
import { toast } from './ui/toast.js';
import { closeModal } from './ui/modal.js';

const PAGES = [
  { id: 'today', label: '今天', icon: 'home', render: renderToday },
  { id: 'scan', label: '选股', icon: 'filter', render: renderScanPage, bind: bindScan },
  { id: 'stock', label: '个股', icon: 'search', render: renderStock, bind: bindStock },
  { id: 'backtest', label: '回测', icon: 'chart', render: renderBacktest, bind: bindBacktest },
  { id: 'mine', label: '我的', icon: 'user', render: renderMine, bind: bindMine },
];

const app = document.getElementById('app');
const sidebar = document.getElementById('sidebar');
const tabbar = document.getElementById('tabbar');

function currentId() {
  const id = (location.hash || '').replace(/^#/, '').split('?')[0];
  return PAGES.some((p) => p.id === id) ? id : 'today';
}

function sidebarFooter() {
  const m = db;
  return `<div class="sidebar-foot">
    <div class="side-status"><span class="dot"></span> 按需联网 · 本地缓存</div>
    <div>行情 <b>${m.generated || '—'}</b><span class="quote-status" id="quoteStatus"></span></div>
    <div>财报 <b>${Object.keys(m.finance || {}).length || 5377}</b> · 分红 <b>${Object.keys(m.baseline?.dividends || {}).length || 5406}</b></div>
    <div>日 K 按需联网 · 月线 <b>2823</b></div>
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

async function renderPage() {
  closeModal();
  const id = currentId();
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  document.title = `${page.label} · 红利工具`;
  renderSidebar(page.id);
  renderTabbar(page.id);
  const loadingTimer = setTimeout(() => { app.innerHTML = skeleton(); }, 120);
  try {
    const html = await page.render();
    clearTimeout(loadingTimer);
    app.innerHTML = html;
  } catch (e) {
    clearTimeout(loadingTimer);
    console.error(e);
    app.innerHTML = `<div class="banner warn" style="margin:24px">页面加载失败：${e.message}<br>请刷新重试，或确认通过 http://127.0.0.1:8766 打开。</div>`;
  }
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
    const ch = echarts.getInstanceByDom(el);
    if (ch) ch.resize();
  });
});

window.__rerender = renderPage;
window.__toast = toast;

function setQuoteStatus(text) {
  const el = document.getElementById('quoteStatus');
  if (el) el.textContent = text ? ' · ' + text : '';
}

let refreshing = false;
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
  try {
    await loadCore();
    performance.mark?.('d3-core-done');
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="banner warn" style="margin:24px">数据加载失败：${e.message}<br>请确认通过 http://127.0.0.1:8766 打开（file:// 不能 fetch json）。</div>`;
    return;
  }
  setBacktestRerender(() => renderPage());
  try { await applyQuoteCache(); } catch (e) {}
  await renderPage();
  performance.mark?.('d3-first-render');
  // 首屏之后后台刷新全市场行情（失败不影响页面）
  setTimeout(() => { refreshQuotesInBackground(); }, 500);
}

// PWA：注册 Service Worker（测试页面可用 ?nosw=1 跳过，避免缓存干扰）
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/nosw=1/.test(location.search)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

boot();
