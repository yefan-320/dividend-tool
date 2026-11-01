import { portfolioStats } from '../engine/portfolio.js';
import { db, quote, currentDy, divSummary, dataMeta } from '../data.js';
import {
  loadTxs, loadCash, saveCash, loadSettings, saveSettings,
} from '../store.js';
import { plansView, bindPlans } from './plans.js';
import { icon } from '../ui/icons.js';
import { esc, num, money, wan, moneyParts, bigMoney, pct, pctSign, upDown } from '../ui/format.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';

const today = () => db.generated || '2026-10-30';

export const mineState = { view: 'account' }; // account | plans | settings

function signedMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + money(v);
}

/* ---------------- 总账 ---------------- */

function hero(r, cash) {
  const total = r.totalValue + cash;
  const pnl = r.totalPnl + r.realizedPnl;
  const totalRet = r.totalCost > 0 ? pnl / r.totalCost : null;
  const pos = total > 0 ? (r.totalValue / total) * 100 : 0;
  const annualDiv = r.lots.reduce((s, x) => {
    const d = divSummary(x.code);
    const dps = d?.years?.[d.lastY] || 0;
    return s + dps * x.shares;
  }, 0);
  return `<section class="hero fade-in">
    <div class="account-hero">
      <div class="hero-kicker">我的组合 · ${r.lots.length} 笔买入 · ${new Set(r.lots.map((x) => x.code)).size} 只股票</div>
      <div class="account-total num">${moneyParts(total).v}<small> ${moneyParts(total).u}</small></div>
      <div class="hero-desc">持仓 ${bigMoney(r.totalValue)} · 现金 ${bigMoney(cash)} · 仓位 ${pos.toFixed(0)}% · 年分红 ${bigMoney(annualDiv)}</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-label">总盈亏</div><div class="stat-value sm num ${upDown(pnl)}">${signedMoney(pnl)}</div><div class="stat-sub">含已实现 ${signedMoney(r.realizedPnl)}</div></div>
      <div class="stat"><div class="stat-label">累计收益率</div><div class="stat-value sm num ${upDown(totalRet)}">${pctSign(totalRet == null ? null : totalRet * 100, 1)}</div><div class="stat-sub">按总成本 ${wan(r.totalCost, 1)} 万</div></div>
      <div class="stat"><div class="stat-label">组合年化 XIRR</div><div class="stat-value sm num gold">${pctSign(r.xirr == null ? null : r.xirr * 100, 1)}</div><div class="stat-sub">现金流内部收益率</div></div>
      <div class="stat"><div class="stat-label">累计分红</div><div class="stat-value sm num">${wan(r.totalDiv, 2)} 万</div><div class="stat-sub">已实施 ${r.lots.reduce((s, x) => s + x.dividends.length, 0)} 次</div></div>
    </div>
  </section>`;
}

function lotTable(r) {
  const rows = r.lots.map((x) => {
    const ret = x.ret != null ? x.ret * 100 : null;
    const w = Math.min(100, Math.abs(ret ?? 0) * 2.5);
    return `<tr>
      <td class="num" style="white-space:nowrap">${esc(x.date)}</td>
      <td class="name">${esc(x.name)}<span class="code">${esc(x.code)}</span></td>
      <td class="num">${num(x.shares, 0)}</td>
      <td class="num">${num(x.price, 2)}</td>
      <td class="num em">${num(x.nowPrice, 2)}</td>
      <td class="num">${num(x.marketValue, 0)}</td>
      <td class="num">${x.divCash > 0 ? num(x.divCash, 0) : '—'}</td>
      <td class="num ${upDown(x.pnl)}">${signedMoney(x.pnl)}<div class="ret-bar"><i class="${ret >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></i></div></td>
      <td class="num ${upDown(ret)}">${pctSign(ret, 1)}</td>
      <td class="num ${upDown(x.annualized)}">${pctSign(x.annualized == null ? null : x.annualized * 100, 1)}</td>
      <td><button class="btn ghost sm" data-del="${esc(x.id)}" title="删除这笔买入">×</button></td>
    </tr>`;
  }).join('');
  return `<section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">买入记录 · 每笔收益率</span><span class="section-note">按买入时间排序 · 分红按年度估算</span></div>
    <div class="table-wrap">
      <table class="table lot-table">
        <thead><tr><th>买入日</th><th>股票</th><th>股数</th><th>成本价</th><th>现价</th><th>市值</th><th>累计分红</th><th>盈亏</th><th>收益率</th><th>年化</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="11" class="empty-cell">还没有买入记录，在下方添加第一笔</td></tr>'}</tbody>
      </table>
    </div>
  </section>`;
}

function positionTable(r) {
  const map = new Map();
  for (const lot of r.lots) {
    const p = map.get(lot.code) || { code: lot.code, name: lot.name, shares: 0, cost: 0, value: 0, div: 0 };
    p.shares += lot.shares;
    p.cost += lot.cost;
    p.value += lot.marketValue || 0;
    p.div += lot.divCash;
    map.set(lot.code, p);
  }
  const totalValue = r.totalValue || 1;
  const rows = [...map.values()].sort((a, b) => b.value - a.value).map((p) => {
    const pnl = p.value + p.div - p.cost;
    const ret = p.cost > 0 ? (pnl / p.cost) * 100 : null;
    return `<tr>
      <td class="name">${esc(p.name)}<span class="code">${esc(p.code)}</span></td>
      <td class="num">${num(p.shares, 0)}</td>
      <td class="num">${num(p.cost / Math.max(1, p.shares), 2)}</td>
      <td class="num">${num(p.value, 0)}</td>
      <td class="num">${pct((p.value / totalValue) * 100, 1)}</td>
      <td class="num ${upDown(pnl)}">${signedMoney(pnl)}</td>
      <td class="num ${upDown(ret)}">${pctSign(ret, 1)}</td>
      <td>${num(currentDy(p.code), 2)}%</td>
    </tr>`;
  }).join('');
  return `<section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">持仓结构</span><span class="section-note">同代码多笔买入自动合并</span></div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>股票</th><th>股数</th><th>摊薄成本</th><th>市值</th><th>占比</th><th>盈亏</th><th>收益率</th><th>当前股息率</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="empty-cell">暂无持仓</td></tr>'}</tbody>
      </table>
    </div>
  </section>`;
}

function yearBars(r) {
  if (!r.byYear.length) return '';
  const max = Math.max(...r.byYear.map((y) => Math.abs((y.pnl / (y.cost || 1)) * 100)), 1);
  const rows = r.byYear.map((y) => {
    const ret = (y.pnl / (y.cost || 1)) * 100;
    const w = Math.min(100, (Math.abs(ret) / max) * 100);
    return `<div class="year-row">
      <span class="yr">${esc(y.year)}</span>
      <span class="cnt">${y.count} 笔</span>
      <div class="year-bar"><i class="${ret >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></i></div>
      <span class="num ${upDown(ret)}">${pctSign(ret, 1)}</span>
      <span class="num" style="color:var(--text-3)">${wan(y.cost, 1)} 万</span>
    </div>`;
  }).join('');
  return `<section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">不同时间买入的收益率</span><span class="section-note">按买入年份汇总 · 含分红</span></div>
    <div class="panel-body" style="padding-top:6px">
      ${rows}
      <div class="banner" style="margin-top:10px;font-size:10.5px">同一只股票，买入时点不同，收益率可以差很多。这张图就是用来回答“我什么时候买的、赚了多少”。</div>
    </div>
  </section>`;
}

function addForm() {
  const q = quote('000333');
  return `<section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">添加买入</span><span class="section-note">存本地 · 不联网</span></div>
    <div class="panel-body">
      <div class="tx-form">
        <label><span>日期</span><input class="input" type="date" id="txDate" value="${today()}"></label>
        <label><span>代码</span><input class="input" id="txCode" placeholder="6 位代码" maxlength="6" value="000333"></label>
        <label><span>股数</span><input class="input" type="number" id="txShares" step="100" min="1" value="1000"></label>
        <label><span>成本价</span><input class="input" type="number" id="txPrice" step="0.01" min="0" value="${q?.p ?? 0}"></label>
        <button class="btn" id="addTxBtn">${icon('plus')} 计入组合</button>
      </div>
      <div class="banner" style="margin-top:10px;font-size:10.5px">收益率 =（市值 + 累计分红 − 成本）÷ 成本；年化按持有天数复利折算；组合 XIRR 把所有现金流放在同一条时间轴上算。加仓、清仓都只是新的买入/删除记录。</div>
    </div>
  </section>`;
}

/* ---------------- 设置 ---------------- */

function settingsView() {
  const m = dataMeta();
  const st = loadSettings();
  const cash = loadCash();
  return `<section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">设置</span><span class="section-note">只存本地</span></div>
    <div class="panel-body">
      <div class="settings-row">
        <div><div class="settings-k">月支出</div><div class="settings-s">用于回测的「月覆盖」：年分红 ÷ 12 ÷ 月支出</div></div>
        <div class="settings-in"><input class="input" id="setExpense" type="number" step="500" min="100" max="10000000" value="${Number(st.expense) || 4000}"><em>元/月</em></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-k">期初现金</div><div class="settings-s">「我的组合」与回测「用当前市值」会用这笔现金</div></div>
        <div class="settings-in"><input class="input" id="setCash" type="number" step="10000" min="0" max="1000000000000" value="${Math.round(cash)}"><em>元</em></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-k">离线回测数据</div><div class="settings-s">回测需要月线 ~9MB + 历史财报 ~4.4MB + 指数日线；缓存后可离线回测</div></div>
        <div class="settings-in"><span class="section-note" id="cacheStatus">检查中…</span><button class="btn ghost" id="prefetchCacheBtn">${icon('download')} 缓存回测数据</button></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-k">行情更新</div><div class="settings-s">打开页面会自动在后台拉一次全市场行情；也可以手动刷新（失败自动用本地快照）</div></div>
        <div class="settings-in"><span class="section-note" id="quoteRefreshInfo">行情 ${esc(db.generated || '—')}</span><button class="btn ghost" id="refreshQuotesBtn">${icon('refresh')} 立即刷新</button></div>
      </div>
      <div class="settings-row">
        <div><div class="settings-k">备份 / 恢复</div><div class="settings-s">持仓、自选、方案、设置全部在浏览器本地；换浏览器可导出再导入</div></div>
        <div class="settings-in"><button class="btn ghost" id="setExport">${icon('download')} 导出 JSON</button><button class="btn ghost" id="setImport">${icon('upload')} 导入</button><input type="file" id="setFile" accept=".json" style="display:none"></div>
      </div>
    </div>
  </section>
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">数据健康</span><span class="section-note">行情 ${esc(m.quoteDate)}</span></div>
    <div class="panel-body">
      <div class="health-grid">
        <div class="health-cell"><div class="k">最新行情</div><div class="v num">${m.quoteCount}</div><div class="s">只 · ${esc(m.quoteDate)}</div></div>
        <div class="health-cell"><div class="k">分红历史</div><div class="v num">${m.divCount}</div><div class="s">只 · 年度每股</div></div>
        <div class="health-cell"><div class="k">财报</div><div class="v num">${m.finCount}</div><div class="s">只 · 年报指标</div></div>
        <div class="health-cell"><div class="k">月线</div><div class="v num">${m.monthlyCount || 2823}</div><div class="s">回测用</div></div>
        <div class="health-cell"><div class="k">日 K</div><div class="v num">5098</div><div class="s">只 · 3000 根</div></div>
        <div class="health-cell"><div class="k">基准</div><div class="v num">2</div><div class="s">中证红利 / 低波全收益</div></div>
      </div>
      <div class="banner" style="margin-top:12px;font-size:10.5px">财报覆盖 ${m.finCount} / ${m.poolCount}。没有财报的股票，结论固定「数据不足」，不输出买卖建议。分红按年度估算，实际除权日可能差几天。</div>
    </div>
  </section>
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">关于</span></div>
    <div class="panel-body settings-about">
      <div>红利工具 <b>v1.0.0</b> · 本地离线版</div>
      <div>数据源：新浪行情 / 腾讯日 K 月线 / 东财财报 / 中证指数全收益基准</div>
      <div>决策框架：质量闸门（亏损、支付率、现金流覆盖、股息率异常）→ 股息率门槛，不给预测、只给条件。</div>
      <div>回测口径：不复权价格 + 现金分红、4 月末到账、不含税与佣金；组合回测含未上市建仓规则。</div>
    </div>
  </section>`;
}

/* ---------------- 页面 ---------------- */

function tabs() {
  const items = [['account', '总账'], ['plans', '组合方案'], ['settings', '设置']];
  return `<div class="view-tabs">${items.map(([id, label]) => `<button class="view-tab ${mineState.view === id ? 'on' : ''}" data-mview="${id}">${label}</button>`).join('')}</div>`;
}

function readMineUrl() {
  const qs = new URLSearchParams((location.hash.split('?')[1] || ''));
  const v = qs.get('view');
  if (['account', 'plans', 'settings'].includes(v)) mineState.view = v;
}

function syncMineUrl() {
  try { history.replaceState(null, '', '#mine' + (mineState.view && mineState.view !== 'account' ? '?view=' + mineState.view : '')); } catch (e) {}
}

export function renderMine() {
  readMineUrl();
  mineState.view = mineState.view || 'account';
  const txs = loadTxs();
  const cash = loadCash();
  const r = portfolioStats(txs, db.quotes, db.baseline?.dividends || {}, today());
  const body = mineState.view === 'plans' ? plansView()
    : mineState.view === 'settings' ? settingsView()
      : `${hero(r, cash)}${lotTable(r)}${yearBars(r)}${positionTable(r)}${addForm()}${m.emptyHint()}`;
  return `<div class="page-head fade-in">
    <div>
      <h1 class="page-title">我的组合</h1>
      <div class="page-sub">每笔买入独立算收益率 · 组合整体算 XIRR · 数据存本地</div>
    </div>
    <div class="page-actions">${mineState.view === 'account' ? '<button class="btn ghost" id="resetTxs">重置演示</button>' : ''}</div>
  </div>
  ${tabs()}
  ${body}`;
}

/* 数据健康卡在总账里保留一份（设置里还有完整版） */
const m = {
  emptyHint() {
    return `<section class="panel fade-in" style="margin-top:14px">
      <div class="panel-head"><span class="panel-title">数据健康</span><span class="section-note">行情 ${esc(dataMeta().quoteDate)}</span></div>
      <div class="panel-body">
        <div class="health-grid">
          <div class="health-cell"><div class="k">最新行情</div><div class="v num">${dataMeta().quoteCount}</div><div class="s">只 · ${esc(dataMeta().quoteDate)}</div></div>
          <div class="health-cell"><div class="k">分红历史</div><div class="v num">${dataMeta().divCount}</div><div class="s">只 · 年度每股</div></div>
          <div class="health-cell"><div class="k">财报</div><div class="v num">${dataMeta().finCount}</div><div class="s">只 · 年报</div></div>
          <div class="health-cell"><div class="k">日 K</div><div class="v num">5098</div><div class="s">只 · 3000 根</div></div>
        </div>
        <div class="banner" style="margin-top:12px;font-size:10.5px">财报覆盖 ${dataMeta().finCount} / ${dataMeta().poolCount}；没有财报的股票只给「数据不足」。</div>
      </div>
    </section>`;
  },
};

/* ---------------- 绑定 ---------------- */

export function bindMine() {
  const rerender = () => window.__rerender?.();
  document.querySelectorAll('[data-mview]').forEach((b) => {
    b.onclick = () => { mineState.view = b.dataset.mview; syncMineUrl(); rerender(); };
  });

  if (mineState.view === 'plans') { bindPlans(); return; }

  // 总账：添加/删除/重置
  const addBtn = document.getElementById('addTxBtn');
  if (addBtn) {
    addBtn.onclick = async () => {
      const date = document.getElementById('txDate')?.value;
      const code = (document.getElementById('txCode')?.value || '').trim();
      const shares = Number(document.getElementById('txShares')?.value);
      const price = Number(document.getElementById('txPrice')?.value);
      if (!/^\d{6}$/.test(code)) return toast('请填 6 位股票代码');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return toast('请选择买入日期');
      if (!(shares > 0) || !(price > 0)) return toast('股数和成本价要大于 0');
      const { addTx } = await import('../store.js');
      addTx({ date, code, side: 'buy', shares, price, fee: 5 });
      toast('已计入组合');
      rerender();
    };
  }
  document.querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({ title: '删除这笔买入？', message: '只删除本地记录，可以重新添加。', okLabel: '删除', danger: true });
      if (!ok) return;
      const { removeTx } = await import('../store.js');
      removeTx(el.dataset.del);
      toast('已删除');
      rerender();
    };
  });
  const reset = document.getElementById('resetTxs');
  if (reset) {
    reset.onclick = async () => {
      const ok = await confirmDialog({ title: '重置演示组合？', message: '会清掉当前所有买入记录，恢复 7 笔演示数据。', okLabel: '重置', danger: true });
      if (!ok) return;
      const { resetTxs } = await import('../store.js');
      resetTxs();
      toast('已重置演示组合');
      rerender();
    };
  }

  // 设置：行情刷新
  const refreshBtn = document.getElementById('refreshQuotesBtn');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '刷新中…';
      const r = await (window.__refreshQuotes?.() || Promise.resolve({ ok: false }));
      refreshBtn.disabled = false;
      refreshBtn.textContent = '立即刷新';
      const info = document.getElementById('quoteRefreshInfo');
      if (info) info.textContent = `行情 ${db.generated || '—'}`;
      if (!r?.ok) toast('刷新失败，继续用本地快照');
    };
  }

  const expense = document.getElementById('setExpense');
  if (expense) {
    expense.onchange = () => {
      const raw = Number(expense.value);
      const v = Math.min(1e7, Math.max(100, Math.round(Number.isFinite(raw) ? raw : 4000)));
      if (v !== raw) toast('月支出需在 100 元–1000 万元/月之间，已按 ' + v + ' 保存');
      else toast('月支出已保存');
      expense.value = v;
      saveSettings({ expense: v });
    };
  }
  const cash = document.getElementById('setCash');
  if (cash) {
    cash.onchange = () => {
      const raw = Number(cash.value);
      const v = Math.min(1e12, Math.max(0, Math.round(Number.isFinite(raw) ? raw : 0)));
      if (v !== raw) toast('期初现金需在 0–1 万亿元之间，已按 ' + v + ' 保存');
      else toast('期初现金已保存');
      cash.value = v;
      saveCash(v);
    };
  }
  const exp = document.getElementById('setExport');
  if (exp) {
    exp.onclick = () => {
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('d3:')) data[k] = localStorage.getItem(k);
      }
      const blob = new Blob([JSON.stringify({ app: '红利工具', exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `红利工具备份-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('已导出备份');
    };
  }
  const imp = document.getElementById('setImport');
  const file = document.getElementById('setFile');
  if (imp && file) {
    imp.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const data = j?.data;
        if (!data || typeof data !== 'object') throw new Error('文件格式不对');
        let n = 0;
        for (const [k, v] of Object.entries(data)) {
          if (!k.startsWith('d3:') || typeof v !== 'string') continue;
          localStorage.setItem(k, v);
          n++;
        }
        toast(`已导入 ${n} 项数据`);
        setTimeout(() => location.reload(), 300);
      } catch (e) {
        toast('导入失败：' + e.message);
      }
    };
  }

  // 离线回测数据：把月线 / 历史财报 / 指数日线缓存进 Service Worker，之后断网也能回测
  const prefetchBtn = document.getElementById('prefetchCacheBtn');
  const cacheStatus = document.getElementById('cacheStatus');
  const OFFLINE_FILES = ['data/monthly.json', 'data/finance-history.json', 'data/index-daily.json'];
  const offlineUrls = () => OFFLINE_FILES.map((f) => new URL('../../' + f, import.meta.url).href);
  const refreshCacheStatus = async () => {
    if (!cacheStatus) return;
    if (!('caches' in window)) { cacheStatus.textContent = '不支持离线缓存'; return; }
    if (!navigator.serviceWorker?.controller) { cacheStatus.textContent = '刷新页面一次后可用'; return; }
    try {
      const hits = await Promise.all(offlineUrls().map((u) => caches.match(u, { ignoreSearch: true }).then(Boolean)));
      const done = hits.filter(Boolean).length;
      cacheStatus.textContent = done === hits.length ? '已缓存 · 可离线回测' : `未缓存 ${hits.length - done}/${hits.length}`;
    } catch (e) { cacheStatus.textContent = '状态未知'; }
  };
  if (prefetchBtn) {
    refreshCacheStatus();
    prefetchBtn.onclick = async () => {
      if (!navigator.serviceWorker?.controller) { toast('请先刷新页面一次（离线缓存需要 Service Worker 生效）'); return; }
      prefetchBtn.disabled = true;
      const urls = offlineUrls();
      let done = 0;
      for (const [i, u] of urls.entries()) {
        if (cacheStatus) cacheStatus.textContent = `缓存中… ${i}/${urls.length}`;
        try {
          const res = await fetch(u, { cache: 'reload' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          await res.arrayBuffer(); // 确保完整下载，SW 会顺手写入缓存
          done++;
        } catch (e) { /* 单个失败继续，最后统一提示 */ }
      }
      prefetchBtn.disabled = false;
      toast(done === urls.length ? '回测数据已缓存，可离线使用' : `缓存未完成 ${done}/${urls.length}，请检查网络后重试`);
      refreshCacheStatus();
    };
  }
}
