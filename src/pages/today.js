import { portfolioStats } from '../engine/portfolio.js';
import { db, quote, nameOf, divSummary, dataMeta } from '../data.js';
import { evaluate } from '../engine/verdict.js';
import { loadTxs, loadCash } from '../store.js';
import { icon } from '../ui/icons.js';
import { esc, num, money, wan, moneyParts, bigMoney, pctSign, upDown, levelPill, dot } from '../ui/format.js';

const LV = { buy: '可买', wait: '观察', avoid: '回避', hold: '持有', missing: '数据不足' };

/** 全市场候选：股息率 ≥5%、连续分红 ≥5 年、非 ST；按决策等级分组，各组取前几只 */
function candidates() {
  const ctx = {
    quotes: db.quotes,
    dividends: db.baseline.dividends || {},
    f10: db.baseline.f10 || {},
    finance: db.finance || {},
    finYear: db.finYear,
  };
  const groups = { buy: [], wait: [], avoid: [], missing: [] };
  for (const [code, info] of Object.entries(db.baseline.pool || {})) {
    const q = db.quotes[code];
    if (!q?.p || /ST|退/.test(info.n || '')) continue;
    const d = divSummary(code);
    if (!d || d.consecutive < 5) continue;
    const dps = d.years[d.lastY];
    if (!(dps > 0)) continue;
    const dy = (dps / q.p) * 100;
    if (dy < 4.5) continue;
    const ev = evaluate(code, ctx);
    if (ev.level === 'missing' && dy > 15) continue;
    groups[ev.level].push(ev);
  }
  const byDy = (a, b) => (b.metrics.dy || 0) - (a.metrics.dy || 0);
  for (const k of Object.keys(groups)) groups[k].sort(byDy);
  const top = [
    ...groups.buy.slice(0, 8),
    ...groups.wait.slice(0, 3),
    ...groups.avoid.slice(0, 2),
    ...groups.missing.slice(0, 3),
  ];
  return {
    top,
    counts: {
      total: Object.values(groups).reduce((s, x) => s + x.length, 0),
      buy: groups.buy.length,
      wait: groups.wait.length,
      avoid: groups.avoid.length,
      missing: groups.missing.length,
    },
  };
}

function portfolio() {
  const txs = loadTxs();
  const cash = loadCash();
  return { r: portfolioStats(txs, db.quotes, db.baseline?.dividends || {}, db.generated || '2026-10-30'), cash, txs };
}

function hero(cands, p) {
  const { r, cash } = p;
  const { buy, wait, avoid, missing } = cands.counts;
  const total = r.totalValue + cash;
  const pnl = r.totalPnl + r.realizedPnl;
  const annualDiv = r.lots.reduce((s, x) => {
    const d = divSummary(x.code);
    return s + (d?.years?.[d.lastY] || 0) * x.shares;
  }, 0);
  return `<section class="hero fade-in">
    <div class="hero-main">
      <div class="hero-kicker">${dot()} 今天 可买 ${buy} · 观察 ${wait} · 回避 ${avoid} · 数据不足 ${missing}</div>
      <div class="hero-line">先看财报质量，再看股息率</div>
      <div class="hero-desc">亏损、支付率 ≥85%、经营现金流覆盖不足、股息率异常（&gt;15%）的直接回避——股息率再高也不买。只有财务健康、股息率 ≥5%、连续分红 ≥5 年的才给「可买」。</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-label">总资产</div><div class="stat-value num">${moneyParts(total).v}<span style="font-size:13px;color:var(--text-2);font-weight:500"> ${moneyParts(total).u}</span></div><div class="stat-sub">现金 ${bigMoney(cash)}</div></div>
      <div class="stat"><div class="stat-label">仓位</div><div class="stat-value num">${total > 0 ? Math.round(r.totalValue / total * 100) : 0}<span style="font-size:13px;color:var(--text-2);font-weight:500">%</span></div><div class="stat-sub">股票 ${bigMoney(r.totalValue)}</div></div>
      <div class="stat"><div class="stat-label">累计收益率</div><div class="stat-value num ${upDown(pnl)}">${pctSign(r.totalCost > 0 ? (pnl / r.totalCost) * 100 : null, 1)}</div><div class="stat-sub">盈亏 ${bigMoney(pnl)}</div></div>
      <div class="stat"><div class="stat-label">组合 XIRR</div><div class="stat-value num gold">${pctSign(r.xirr == null ? null : r.xirr * 100, 1)}</div><div class="stat-sub">年分红 ${bigMoney(annualDiv)}</div></div>
    </div>
  </section>`;
}

function decisionRow(c) {
  const q = quote(c.code);
  const chg = q?.prev ? (q.p / q.prev - 1) * 100 : null;
  const pos = c.level === 'buy' ? '1/3' : '0';
  const lv = c.level;
  return `<div class="decision-row" data-code="${c.code}" role="button" tabindex="0">
    <div class="grow">
      <div class="decision-name"><b>${esc(c.name)}</b><span class="code">${c.code}</span>${levelPill(lv, LV[lv])}${!c.metrics.hasFin ? '<span class="tag">缺财报</span>' : ''}${c.metrics.payout != null && c.metrics.payout > 90 ? '<span class="tag" style="color:var(--warn)">支付率 ' + c.metrics.payout.toFixed(0) + '%</span>' : ''}</div>
      <div class="decision-why">${esc(c.reasons[0])}</div>
    </div>
    <div class="decision-price">
      <div class="px num">${num(q?.p, 2)}</div>
      <div class="chg num ${upDown(chg)}">${pctSign(chg)}</div>
      <div class="m-only" style="font-size:10px;color:var(--text-3);margin-top:2px">${pos === '0' ? '不建仓' : '建议 ' + pos}</div>
    </div>
    <div class="decision-action">
      <div style="font-size:11px;color:var(--text-2)">${pos === '0' ? '不建仓' : '建议 ' + pos + ' 仓'}</div>
      <div class="pos">股息 ${num(c.metrics.dy, 1)}%</div>
    </div>
  </div>`;
}

function decisionsPanel(cands) {
  return `<section class="panel decision-panel fade-in">
    <div class="panel-head">
      <span class="panel-title">今天做什么</span>
      <span class="section-note">全市场 ${cands.counts.total} 只候选 · 财报覆盖 ${Object.keys(db.finance || {}).length} 只</span>
    </div>
    <div class="decision-list">${cands.top.map(decisionRow).join('') || '<div class="banner">没有满足条件的候选</div>'}</div>
  </section>`;
}

function holdingRow(x) {
  const pnl = (x.marketValue || 0) + x.divCash - x.cost;
  const ret = x.cost > 0 ? (pnl / x.cost) * 100 : null;
  return `<div class="hold-row" data-code="${x.code}" role="button" tabindex="0">
    <div class="n">${esc(x.name)}<span class="code">${x.code}</span></div>
    <div class="v hide-m">${num(x.shares, 0)} 股</div>
    <div class="v hide-m">成本 ${num(x.price, 2)}</div>
    <div class="v"><b>${num(x.nowPrice, 2)}</b><div style="font-size:10px" class="${upDown(ret)}">${pctSign(ret, 1)}</div></div>
    <div class="v">${levelPill('hold', '持有')}</div>
  </div>`;
}

function holdingsPanel(r, cash) {
  const total = r.totalValue + cash;
  return `<section class="panel fade-in" style="margin-top:16px">
    <div class="panel-head">
      <span class="panel-title">持仓</span>
      <span class="section-note">市值 ${wan(r.totalValue, 1)} 万 · 占 ${total > 0 ? Math.round(r.totalValue / total * 100) : 0}%</span>
    </div>
    ${r.lots.map(holdingRow).join('') || '<div class="banner" style="margin:10px">还没有持仓，去「我的组合」添加买入</div>'}
  </section>`;
}

function calendarPanel(r) {
  // 按持仓估算年度分红，统一按 6 月除权（A 股多数在 5–7 月）
  const months = Array(12).fill(0);
  let total = 0;
  for (const x of r.lots) {
    const d = divSummary(x.code);
    const dps = d?.years?.[d.lastY] || 0;
    const cashAmt = dps * x.shares;
    months[5] += cashAmt;
    total += cashAmt;
  }
  const max = Math.max(...months, 1);
  const bars = months.map((v, i) => `<div class="cal-month">
    <div class="cal-bar-wrap"><div class="cal-bar ${v ? '' : 'dim'}" style="height:${Math.max(2, (v / max) * 76)}px" title="${Math.round(v)} 元"></div></div>
    <div class="cal-label">${i + 1}</div>
  </div>`).join('');
  return `<section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">分红日历</span><span class="section-note">按当前股数估算 · 6 月除权</span></div>
    <div class="panel-body">
      <div class="next-div">
        <div style="width:34px;height:34px;border-radius:10px;background:rgba(216,168,78,.14);display:grid;place-items:center;color:var(--accent-2);flex-shrink:0">${icon('chart')}</div>
        <div class="grow">
          <div style="font-size:11px;color:var(--text-2)">预计全年分红</div>
          <div class="amount num">约 ${money(total)} 元</div>
          <div class="meta">按最近年度每股分红 × 当前股数 · 实际以除权日为准</div>
        </div>
      </div>
      <div class="calendar">${bars}</div>
      <div class="row row-between" style="margin-top:8px;font-size:10.5px;color:var(--text-3)">
        <span>月度到账（元，估算）</span><span>全年 ${money(total)} 元</span>
      </div>
    </div>
  </section>`;
}

function dataPanel() {
  const m = dataMeta();
  return `<section class="panel fade-in" style="margin-top:16px">
    <div class="panel-head"><span class="panel-title">数据</span><span class="section-note">${esc(m.quoteDate)} 更新</span></div>
    <div class="panel-body" style="padding-top:10px">
      <div class="src-row"><span>最新行情</span><span class="s">${m.quoteCount} 只 · ${esc(m.quoteDate)}</span></div>
      <div class="src-row"><span>月线</span><span class="s">${m.monthlyCount || '按需'} 只 · 2012 起</span></div>
      <div class="src-row"><span>财报</span><span class="s" style="color:var(--warn)">${m.finCount} / ${m.poolCount} · 缺 ${m.poolCount - m.finCount}</span></div>
      <div class="src-row"><span>分红</span><span class="s">${m.divCount} 只 · 年度每股</span></div>
    </div>
  </section>`;
}

export function renderToday() {
  const cands = candidates();
  const p = portfolio();
  return `<div class="page-head fade-in">
    <div>
      <h1 class="page-title">今天</h1>
      <div class="page-sub">${esc(db.generated || '2026-10-30')} 收盘 <span class="dim">·</span> ${dot()} 真实行情 · 财报 ${dataMeta().finCount} 只</div>
    </div>
    <div class="page-actions">
      <button class="theme-toggle" id="themeBtn" title="切换深浅色">${icon('sun')}</button>
    </div>
  </div>
  ${hero(cands, p)}
  <div class="today-grid" style="margin-top:16px">
    <div>${decisionsPanel(cands)}${holdingsPanel(p.r, p.cash)}</div>
    <div>${calendarPanel(p.r)}${dataPanel()}</div>
  </div>`;
}
