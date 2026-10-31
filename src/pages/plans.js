/**
 * 「我的组合 → 组合方案」页：方案的增删改查 + 执行清单。
 *
 * 设计目标（2026-11 重做）：
 *  - 方案不是只读的标签：能自由加/删股票、改比例或金额、设本金、设建仓节奏
 *  - 「执行清单」把方案和当前账本对起来：目标市值 vs 现在市值 → 该买/该卖多少股
 *  - 买入时机：一次性 / 分批 N 期 / 股息率门槛（显示触发价）
 *  - 改了就用，全存 localStorage（d3:plans），不联网
 */
import { db, quote, nameOf } from '../data.js';
import {
  loadTxs, loadCash, loadPlans, savePlan, removePlan, duplicatePlan,
} from '../store.js';
import {
  normalizePlan, makePlan, planStockTotal, planCashPct, planStockAmount,
  equalWeights, normalizeToFull, roundWeights, relockToTotal, estimatePlanDiv, planActionRows,
  entryLabel, entryDetail, stagedBudget, lastDpsOf,
  MAX_MONTHS, LOT,
} from '../engine/plan.js';
import { openModal, confirmDialog, closeModal } from '../ui/modal.js';
import { btState } from './backtest.js';
import { openBuyModal } from '../ui/buy.js';
import { icon } from '../ui/icons.js';
import { esc, num } from '../ui/format.js';
import { toast } from '../ui/toast.js';

const state = { mode: 'list', editing: null, detailId: null, unit: 'pct' };
const HUES = [38, 188, 265, 146, 6, 320, 96, 210, 174, 286];
const colorFor = (i) => `hsl(${HUES[i % HUES.length]} 58% 52%)`;
const dividends = () => db.baseline?.dividends || {};
const quotes = () => db.quotes || {};
const rerender = () => window.__rerender?.();

/* ---------------- 通用 ---------------- */

/** 当前账本持仓：{code: shares}，按买入减卖出合并 */
function positionsMap() {
  const map = new Map();
  for (const t of loadTxs()) {
    const code = String(t.code || '');
    if (!/^\d{6}$/.test(code)) continue;
    const n = Number(t.shares) || 0;
    map.set(code, (map.get(code) || 0) + (t.side === 'sell' ? -n : n));
  }
  for (const [code, n] of map) if (!(n > 0)) map.delete(code);
  return map;
}

function nextPlanName() {
  const names = new Set(loadPlans().map((p) => p.name));
  for (let i = 1; i < 999; i++) if (!names.has('方案' + i)) return '方案' + i;
  return '方案';
}

function latestList() {
  return loadPlans();
}

/* ---------------- URL / 状态 ---------------- */

function goList() {
  state.mode = 'list';
  state.editing = null;
  state.detailId = null;
  history.replaceState(null, '', '#mine?view=plans');
  rerender();
}

function goEdit(plan) {
  state.editing = normalizePlan(plan);
  state.mode = 'edit';
  state.detailId = null;
  const exists = loadPlans().some((p) => p.id === state.editing.id);
  history.replaceState(null, '', '#mine?view=plans&mode=edit' + (exists ? '&plan=' + state.editing.id : '&new=1'));
  rerender();
}

function goDetail(id) {
  state.mode = 'detail';
  state.detailId = id;
  state.editing = null;
  history.replaceState(null, '', '#mine?view=plans&mode=detail&plan=' + id);
  rerender();
}

function readState() {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const mode = qs.get('mode') || 'list';
  const pid = qs.get('plan') || '';
  if (mode === 'edit') {
    const keep = state.editing && ((pid && state.editing.id === pid) || (!pid && qs.get('new') === '1'));
    if (!keep) {
      const src = pid ? latestList().find((p) => p.id === pid) : null;
      state.editing = src ? normalizePlan(src) : makePlan({ name: nextPlanName() });
    }
    state.mode = 'edit';
    state.detailId = null;
  } else if (mode === 'detail' && pid) {
    state.mode = 'detail';
    state.detailId = pid;
    state.editing = null;
  } else {
    state.mode = 'list';
    state.editing = null;
    state.detailId = null;
  }
}

/* ---------------- 列表 ---------------- */

function planCard(p) {
  const divEst = estimatePlanDiv(p, quotes(), dividends());
  const total = planStockTotal(p);
  const cash = planCashPct(p);
  const segs = (p.holdings || []).map((h, i) => `<i style="width:${h.weight}%;background:${colorFor(i)}" title="${esc(nameOf(h.code))} ${num(h.weight, 1)}%"></i>`).join('');
  const tags = (p.holdings || []).map((h, i) => `<span class="plan-tag"><b style="color:${colorFor(i)}">${esc(nameOf(h.code))}</b> ${num(h.weight, 1)}%</span>`).join('');
  return `<article class="plan-card">
    <div class="plan-head">
      <div class="plan-title-wrap">
        <span class="plan-name">${esc(p.name)}</span>
        <span class="plan-badge">${esc(entryLabel(p.entry))}</span>
        <span class="plan-date">更新 ${esc(p.updatedAt || p.createdAt || '')}</span>
      </div>
      <div class="plan-ops">
        <button class="btn sm ghost" data-plan-bt="${esc(p.id)}">回测</button>
        <button class="btn sm primary" data-plan-use="${esc(p.id)}">执行清单 ${icon('right')}</button>
        <button class="btn sm ghost" data-plan-edit="${esc(p.id)}">编辑</button>
        <button class="btn sm ghost icon-btn" data-plan-copy="${esc(p.id)}" title="复制方案">${icon('copy')}</button>
        <button class="btn sm ghost danger-text icon-btn" data-plan-del="${esc(p.id)}" title="删除方案">${icon('trash')}</button>
      </div>
    </div>
    <div class="plan-meta">
      <span>本金 <b>${num(p.capital / 1e4, 0)}</b> 万</span>
      <span>${p.holdings.length} 只 · 股票 <b>${num(total, 1)}%</b></span>
      <span>现金 <b>${num(cash, 1)}%</b></span>
      <span>年分红约 <b>${num(divEst.annualDiv / 1e4, 1)}</b> 万</span>
      <span>组合股息率 <b>${divEst.dyOnStock == null ? '—' : num(divEst.dyOnStock, 2) + '%'}</b></span>
    </div>
    <div class="plan-stack">${segs}${cash > 0.01 ? `<i class="cash" style="width:${cash}%" title="现金 ${num(cash, 1)}%"></i>` : ''}</div>
    <div class="plan-tags">${tags}${cash > 0.01 ? `<span class="plan-tag cash">现金 <b>${num(cash, 1)}%</b></span>` : ''}</div>
  </article>`;
}

function emptyState() {
  return `<div class="plan-empty">
    <div class="plan-empty-mark">${icon('chart')}</div>
    <div class="plan-empty-title">还没有组合方案</div>
    <div class="plan-empty-desc">方案 = 你想长期持有的股票 + 目标比例 + 建仓节奏。建好之后：回测页可以直接选它跑历史收益，这里也能生成「今天该买多少」的执行清单。</div>
    <div class="row" style="gap:8px;justify-content:center">
      <button class="btn primary" id="planCreate">${icon('plus')} 新建方案</button>
      <button class="btn ghost" id="planFromHoldings">从当前持仓生成</button>
    </div>
  </div>`;
}

function listView() {
  const plans = latestList();
  return `<section class="panel fade-in">
    <div class="panel-head">
      <span class="panel-title">组合方案</span>
      <span class="section-note">代码 + 目标比例 + 建仓节奏 · 存本地</span>
    </div>
    <div class="panel-body">
      <div class="plan-toolbar">
        <button class="btn primary" id="planCreate">${icon('plus')} 新建方案</button>
        <button class="btn ghost" id="planFromHoldings">从当前持仓生成</button>
        <span class="section-note">方案可改代码 / 比例或金额 / 本金 / 建仓节奏；回测页「组合」下拉框直接选</span>
      </div>
      ${plans.length ? plans.map(planCard).join('') : emptyState()}
    </div>
  </section>`;
}

/* ---------------- 编辑器 ---------------- */

function entryOptions(p) {
  const e = p.entry;
  if (e.mode === 'staged') {
    return `<label class="ed-inline">
      <span>分</span>
      <input class="input" id="edMonths" type="number" min="1" max="${MAX_MONTHS}" step="1" value="${e.months}">
      <span>期</span><em>每期约 ${num(stagedBudget(p) / 1e4, 1)} 万</em>
    </label>`;
  }
  if (e.mode === 'dip') {
    return `<label class="ed-inline">
      <span>股息率 ≥</span>
      <input class="input" id="edMinDy" type="number" min="0" max="20" step="0.1" value="${e.minDy}">
      <span>% 才买</span><em>不到就留现金等</em>
    </label>`;
  }
  return `<span class="ed-hint">股票部分一次买齐（回测里相当于起点满仓）</span>`;
}

function editorRow(h, i, unit, capital, maxW) {
  const w = Number(h.weight) || 0;
  const val = unit === 'amt' ? Math.round((capital * w / 100 / 1e4) * 10) / 10 : Math.round(w * 10) / 10;
  const barW = maxW > 0 ? (w / maxW) * 100 : 0;
  return `<div class="plan-edit-row" data-row="${esc(h.code)}">
    <div class="per-name-wrap">
      <span class="per-dot" style="background:${colorFor(i)}"></span>
      <div><div class="per-name">${esc(nameOf(h.code))}</div><div class="per-code">${esc(h.code)}</div></div>
    </div>
    <label class="per-w">
      <input class="input" type="number" min="0" step="${unit === 'amt' ? 0.5 : 0.5}" value="${val}" data-w="${esc(h.code)}" inputmode="decimal">
      <em>${unit === 'amt' ? '万' : '%'}</em>
    </label>
    <div class="per-bar"><i style="width:${barW}%;background:${colorFor(i)}" data-bar="${esc(h.code)}"></i></div>
    <button class="btn ghost sm danger-text icon-btn" data-row-del="${esc(h.code)}" title="移除">${icon('x')}</button>
  </div>`;
}

function amountHint(p) {
  return `股票 ${num(planStockAmount(p) / 1e4, 1)} 万 / 本金 ${num(p.capital / 1e4, 0)} 万`;
}

function editorSummary(p) {
  const divEst = estimatePlanDiv(p, quotes(), dividends());
  return `股票合计 <b id="edStockTotal">${num(planStockTotal(p), 1)}%</b>
    <span class="ed-sum-sep">·</span> 现金 <b id="edCashPct">${num(planCashPct(p), 1)}%</b>
    <span id="edAmountHint">${amountHint(p)}</span>
    <span class="ed-sum-sep">·</span> 年分红约 <b id="edDiv">${num(divEst.annualDiv / 1e4, 2)}</b> 万
    <span class="ed-sum-sep">·</span> 组合股息率 <b id="edDy">${divEst.dyOnStock == null ? '—' : num(divEst.dyOnStock, 2) + '%'}</b>`;
}

function editorView() {
  const p = state.editing || makePlan({ name: nextPlanName() });
  state.editing = p;
  const unit = state.unit;
  const maxW = Math.max(1, ...p.holdings.map((h) => Number(h.weight) || 0));
  const isNew = !latestList().some((x) => x.id === p.id);
  const over = planStockTotal(p) > 100.5;
  return `<section class="panel fade-in">
    <div class="panel-head editor-head">
      <button class="btn ghost sm" id="planBack">${icon('arrowLeft')} 返回</button>
      <span class="panel-title">${isNew ? '新建组合方案' : '编辑组合方案'}</span>
      <span class="section-note" style="margin-left:auto">改动不会立刻生效，点「保存方案」才写入</span>
    </div>
    <div class="panel-body">
      <div class="editor-basics">
        <label class="ed-field"><span>方案名称</span><input class="input" id="edName" maxlength="20" value="${esc(p.name)}" placeholder="例如：红利五虎"></label>
        <label class="ed-field"><span>计划本金</span><span class="ed-inline"><input class="input" id="edCapital" type="number" min="1" step="10" value="${num(p.capital / 1e4, 0)}" inputmode="decimal"><em>万</em></span></label>
      </div>

      <div class="ed-block">
        <div class="ed-label">建仓节奏 <span class="ed-label-sub">决定资金怎么进市场</span></div>
        <div class="seg" id="edEntryMode">
          <button class="seg-btn ${p.entry.mode === 'once' ? 'on' : ''}" data-entry="once">一次性</button>
          <button class="seg-btn ${p.entry.mode === 'staged' ? 'on' : ''}" data-entry="staged">分批</button>
          <button class="seg-btn ${p.entry.mode === 'dip' ? 'on' : ''}" data-entry="dip">股息率门槛</button>
        </div>
        <div class="ed-entry-opt">${entryOptions(p)}</div>
        <div class="ed-hint">${esc(entryDetail(p.entry))}</div>
      </div>

      <div class="ed-block">
        <div class="ed-block-head">
          <div class="ed-label">股票与配比</div>
          <div class="seg sm" id="edUnit">
            <button class="seg-btn ${unit === 'pct' ? 'on' : ''}" data-unit="pct">比例 %</button>
            <button class="seg-btn ${unit === 'amt' ? 'on' : ''}" data-unit="amt">金额 万</button>
          </div>
        </div>
        <div class="plan-edit-list" id="edRows">
          ${p.holdings.length ? p.holdings.map((h, i) => editorRow(h, i, unit, p.capital, maxW)).join('') : '<div class="plan-edit-empty">还没有股票，点下面「添加股票」搜代码或名称</div>'}
        </div>
        <div class="ed-row-tools">
          <button class="btn ghost sm" id="edAddStock">${icon('plus')} 添加股票</button>
          <button class="btn ghost sm" id="edEqual">均分</button>
          <button class="btn ghost sm" id="edNorm">归一化到 100%</button>
          <button class="btn ghost sm" id="edFromHoldings">用当前持仓填充</button>
          <button class="btn ghost sm danger-text" id="edClear">清空</button>
        </div>
        <div class="ed-hint">比例是「占总资产」的百分比，合计不到 100% 的部分自动留现金（回测里也是现金仓位）。</div>
      </div>

      <div class="editor-sum ${over ? 'over' : ''}" id="edSummary">${editorSummary(p)}</div>
      ${over ? '<div class="banner warn" style="font-size:11px">股票合计超过 100%，先点「归一化到 100%」或调小比例。</div>' : ''}
      <div class="editor-actions">
        <button class="btn primary" id="edSave">${icon('check')} 保存方案</button>
        <button class="btn ghost" id="edCancel">取消</button>
      </div>
    </div>
  </section>`;
}

/* ---------------- 执行清单 ---------------- */

function statCell(k, v, s = '', cls = '') {
  return `<div class="pstat"><div class="pstat-k">${esc(k)}</div><div class="pstat-v ${cls}">${v}</div>${s ? `<div class="pstat-s">${s}</div>` : ''}</div>`;
}

function detailTable(act, plan) {
  const isDip = plan.entry.mode === 'dip';
  const rows = act.rows.map((r) => {
    const name = nameOf(r.code);
    const hasPrice = r.price > 0;
    const sugText = !hasPrice ? '<span class="muted">无行情</span>'
      : isDip && !r.triggered && r.sugShares === 0
        ? '<span class="muted">等触发价</span>'
        : r.sugShares > 0
          ? `<span class="${r.sugSide === 'buy' ? 'up' : 'down'}">${r.sugSide === 'buy' ? '买' : '卖'} ${num(r.sugShares, 0)} 股</span><div class="sug-amt">${num((r.sugShares * r.price) / 1e4, 1)} 万</div>`
          : '<span class="muted">—</span>';
    const dipCell = isDip
      ? (r.triggered
        ? `<span class="pill buy">已触发</span>`
        : `<span class="pill wait">等 ≥${num(plan.entry.minDy, 1)}%</span><div class="pstat-s">触发价 ${r.triggerPrice ? num(r.triggerPrice, 2) : '—'}</div>`)
      : '';
    const gapCls = r.delta > 0.5 ? 'up' : r.delta < -0.5 ? 'down' : '';
    const buyBtn = r.sugSide === 'buy' && r.sugShares > 0 && (!isDip || r.triggered)
      ? `<button class="btn sm primary" data-buy="${esc(r.code)}" data-shares="${r.sugShares}" data-price="${num(r.price, 2)}">记一笔</button>`
      : '';
    return `<tr>
      <td class="name">${esc(name)}<span class="code">${esc(r.code)}</span></td>
      <td class="num">${num(r.weight, 1)}%<div class="pstat-s">现 ${num(r.weightNow, 1)}%</div></td>
      <td class="num">${num(r.target / 1e4, 1)}</td>
      <td class="num">${hasPrice ? num(r.price, 2) : '—'}</td>
      <td class="num">${num(r.shares, 0)}</td>
      <td class="num">${num(r.current / 1e4, 1)}</td>
      <td class="num ${gapCls}">${r.delta >= 0 ? '+' : ''}${num(r.delta / 1e4, 1)}</td>
      <td class="num">${sugText}</td>
      <td class="num">${r.dy == null ? '—' : num(r.dy, 2) + '%'}</td>
      ${isDip ? `<td>${dipCell}</td>` : ''}
      <td class="ops">${buyBtn}</td>
    </tr>`;
  }).join('');

  return `<div class="table-wrap plan-exec-wrap">
    <table class="table plan-exec-table">
      <thead><tr>
        <th>股票</th><th>目标权重</th><th>目标(万)</th><th>现价</th><th>持股</th><th>当前(万)</th><th>差额(万)</th><th>建议</th><th>股息率</th>${isDip ? '<th>买点</th>' : ''}<th></th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="10" class="empty-cell">方案里还没有股票，先去编辑</td></tr>'}</tbody>
    </table>
  </div>`;
}

/** 手机宽度下的执行清单卡片：表格太宽，改成一条一只 */
function detailCards(act, plan) {
  const isDip = plan.entry.mode === 'dip';
  return `<div class="plan-exec-cards">${act.rows.map((r) => {
    const hasPrice = r.price > 0;
    const gapCls = r.delta > 0.5 ? 'up' : r.delta < -0.5 ? 'down' : '';
    const sug = !hasPrice ? '<span class="muted">无行情</span>'
      : isDip && !r.triggered && r.sugShares === 0
        ? '<span class="muted">等触发价</span>'
        : r.sugShares > 0
          ? `<b class="${r.sugSide === 'buy' ? 'up' : 'down'}">${r.sugSide === 'buy' ? '买' : '卖'} ${num(r.sugShares, 0)} 股</b><span class="muted"> · ${num((r.sugShares * r.price) / 1e4, 1)} 万</span>`
          : '<span class="muted">—</span>';
    const dip = isDip
      ? (r.triggered ? '<span class="pill buy">已触发</span>' : `<span class="pill wait">等 ≥${num(plan.entry.minDy, 1)}%</span>${r.triggerPrice ? `<span class="pec-trigger">触发价 ${num(r.triggerPrice, 2)}</span>` : ''}`)
      : '';
    const buyBtn = r.sugSide === 'buy' && r.sugShares > 0 && (!isDip || r.triggered)
      ? `<button class="btn sm primary" data-buy="${esc(r.code)}" data-shares="${r.sugShares}" data-price="${num(r.price, 2)}">记一笔</button>` : '';
    return `<div class="pec-row">
      <div class="pec-top">
        <div class="pec-name">${esc(nameOf(r.code))}<span class="per-code">${esc(r.code)}</span></div>
        <div class="pec-w">${num(r.weight, 1)}%<em>现 ${num(r.weightNow, 1)}%</em></div>
      </div>
      <div class="pec-mid">目标 ${num(r.target / 1e4, 1)} 万 · 当前 ${num(r.current / 1e4, 1)} 万 · <span class="${gapCls}">差额 ${r.delta >= 0 ? '+' : ''}${num(r.delta / 1e4, 1)} 万</span></div>
      <div class="pec-bottom">
        <div class="pec-sug">${sug}${r.dy != null ? `<span class="muted"> · 股息率 ${num(r.dy, 2)}%</span>` : ''}${dip ? ' ' + dip : ''}</div>
        ${buyBtn}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function detailView() {
  const plan = latestList().find((p) => p.id === state.detailId);
  if (!plan) {
    state.mode = 'list';
    return listView();
  }
  const buyCap = plan.entry.mode === 'staged' ? stagedBudget(plan) : null;
  const act = planActionRows({ plan, positions: positionsMap(), quotes: quotes(), dividends: dividends(), buyCap });
  const s = act.summary;
  const isDip = plan.entry.mode === 'dip';
  const isStaged = plan.entry.mode === 'staged';
  const triggered = act.rows.filter((r) => r.triggered).length;
  const needCash = act.rows.filter((r) => r.sugSide === 'buy' && r.sugShares > 0 && (!isDip || r.triggered))
    .reduce((acc, r) => acc + r.sugShares * r.price, 0);
  const sellCash = act.rows.filter((r) => r.sugSide === 'sell' && r.sugShares > 0)
    .reduce((acc, r) => acc + r.sugShares * r.price, 0);
  const cashNow = loadCash();
  const shortfall = Math.max(0, needCash - (cashNow + sellCash));
  const entryUse = isDip
    ? `已触发 ${triggered}/${act.rows.length} 只 · 门槛 ${num(plan.entry.minDy, 1)}%`
    : isStaged
      ? `每期约 ${num(s.stagedBudget / 1e4, 1)} 万 · 共 ${plan.entry.months} 期`
      : '一次性买齐';
  return `<section class="panel fade-in">
    <div class="panel-head">
      <button class="btn ghost sm" id="detailBack">${icon('arrowLeft')} 返回</button>
      <span class="panel-title" style="margin-left:4px">${esc(plan.name)} · 执行清单</span>
      <div class="plan-ops" style="margin-left:auto">
        <button class="btn sm ghost" id="detailEdit">编辑方案</button>
        <button class="btn sm ghost" id="detailBt">回测此方案</button>
      </div>
    </div>
    <div class="panel-body">
      <div class="plan-exec-hero">
        ${statCell('计划本金', `${num(s.capital / 1e4, 0)} 万`, `${plan.holdings.length} 只 · 股票 ${num(planStockTotal(plan), 1)}% + 现金 ${num(planCashPct(plan), 1)}%`)}
        ${statCell('目标市值', `${num(s.targetStock / 1e4, 1)} 万`, `现金 ${num(s.cashPlan / 1e4, 1)} 万`)}
        ${statCell('当前持仓', `${num(s.currentStock / 1e4, 1)} 万`, `${act.rows.filter((r) => r.shares > 0).length} 只 · 含方案外 ${num(s.outsideValue / 1e4, 1)} 万`)}
        ${statCell('本轮买入', `${num(needCash / 1e4, 1)} 万`, isDip && needCash === 0 ? '都没到门槛，继续等' : isStaged ? `按 ${plan.entry.months} 期拆开买` : `卖出 ${num(sellCash / 1e4, 1)} 万`, needCash > 0 ? 'gold' : '')}
        ${statCell('年分红(估)', `${num(s.annualDiv / 1e4, 2)} 万`, `股息率 ${s.dyOnStock == null ? '—' : num(s.dyOnStock, 2) + '%'}`, 'gold')}
        ${statCell('建仓节奏', esc(entryLabel(plan.entry)), entryUse)}
      </div>
      <div class="plan-exec-note">
        建议股数 = 把当前持仓调到「方案目标市值」的差额，按 100 股整手向下取整。
        ${isDip ? '股息率没到门槛的股票先不买，等价格跌到触发价。' : ''}
        ${isStaged ? `分批方案的本轮建议已经按「每期约 ${num(s.stagedBudget / 1e4, 1)} 万」拆好，下个月再执行一次。` : ''}
      </div>
      ${shortfall > 0.5 ? `<div class="banner warn" style="font-size:11.5px">按整手算需要 ${num(needCash / 1e4, 1)} 万现金，账本现金只有 ${num(cashNow / 1e4, 1)} 万${sellCash > 0 ? `（另有卖出回收 ${num(sellCash / 1e4, 1)} 万）` : ''}，差 ${num(shortfall / 1e4, 1)} 万。可以先卖后买，或者调小方案本金。</div>` : ''}
      ${detailTable(act, plan)}
      ${detailCards(act, plan)}
      ${act.outside.length ? `<div class="plan-outside">
        <div class="ed-label">方案外持仓 <span class="ed-label-sub">不在目标结构里，清单不会动它们</span></div>
        <div class="plan-outside-list">${act.outside.map((x) => `<span class="plan-tag">${esc(nameOf(x.code))} ${esc(x.code)} · ${num(x.shares, 0)} 股 · ${num(x.value / 1e4, 1)} 万</span>`).join('')}</div>
      </div>` : ''}
      <div class="banner" style="margin-top:12px;font-size:10.5px">清单只是按现价折算的参考，不含佣金和税；「记一笔」会把这次买入写进总账（只存本地）。</div>
    </div>
  </section>`;
}

/* ---------------- 渲染入口 ---------------- */

export function plansView() {
  readState();
  if (state.mode === 'edit') return editorView();
  if (state.mode === 'detail') return detailView();
  return listView();
}

/* ---------------- 绑定 ---------------- */

function commitEdit() {
  // 把编辑器 DOM 里的最新值写回草稿，避免用户没失焦就点保存 / 切单位
  const p = state.editing;
  if (!p) return p;
  // 行内权重/金额：按当前单位换算回 weight
  document.querySelectorAll('[data-w]').forEach((el) => {
    const row = p.holdings.find((h) => h.code === el.dataset.w);
    if (!row) return;
    const v = Number(el.value);
    if (!(v >= 0)) return;
    row.weight = state.unit === 'amt'
      ? Math.round(((v * 1e4) / Math.max(1, p.capital)) * 1000) / 10
      : Math.round(v * 10) / 10;
  });
  const nameEl = document.getElementById('edName');
  if (nameEl) p.name = (nameEl.value || '').trim().slice(0, 20) || '我的方案';
  const capEl = document.getElementById('edCapital');
  if (capEl) {
    const v = Number(capEl.value);
    if (v > 0) p.capital = Math.max(1000, Math.round(v * 1e4));
  }
  return p;
}

function refreshEditorSummary() {
  const p = state.editing;
  if (!p) return;
  const total = planStockTotal(p);
  const sumEl = document.getElementById('edSummary');
  if (sumEl) sumEl.innerHTML = editorSummary(p);
  const over = total > 100.5;
  sumEl?.classList.toggle('over', over);
  const maxW = Math.max(1, ...p.holdings.map((h) => Number(h.weight) || 0));
  for (const h of p.holdings) {
    const bar = document.querySelector(`[data-bar="${h.code}"]`);
    if (bar) bar.style.width = `${((Number(h.weight) || 0) / maxW) * 100}%`;
  }
  // 现金/合计超过 100 时给输入框一点颜色提示
  document.querySelectorAll('[data-w]').forEach((el) => el.classList.toggle('bad', over));
}

function addStockFromPicker() {
  const p = state.editing;
  if (!p) return;
  const exclude = p.holdings.map((h) => h.code);
  openStockPicker({
    exclude,
    onPick: (code) => {
      if (p.holdings.some((h) => h.code === code)) return toast('这只已经在方案里了');
      const total = planStockTotal(p);
      const n = p.holdings.length;
      if (!n) {
        p.holdings.push({ code, weight: 100 });   // 第一只给满，后面加会按比例腾位置
      } else if (total >= 99.5) {
        // 已经配满：按「等权」给新股票腾位置（新股票 100/(n+1)，老股票等比压缩）
        const each = Math.round((100 / (n + 1)) * 10) / 10;
        p.holdings = relockToTotal(p.holdings, 100 - each, 1);
        p.holdings.push({ code, weight: each });
        toast(`已按等权重新分配：新股票占 ${each}%（可以再手动改比例）`);
      } else {
        p.holdings.push({ code, weight: Math.max(1, Math.min(30, Math.round((100 - total) * 10) / 10)) });
      }
      rerender();
    },
  });
}

/** 用账本持仓 + 期初现金生成一个方案（不落盘） */
function planFromHoldings(name) {
  const map = positionsMap();
  if (!map.size) { toast('当前账本还没有持仓，先去「总账」加一笔买入'); return null; }
  const cash = loadCash();
  let stockValue = 0;
  const rows = [];
  for (const [code, shares] of map) {
    const price = quote(code)?.p || 0;
    const v = shares * price;
    if (!(v > 0)) continue;
    stockValue += v;
    rows.push({ code, v });
  }
  if (!rows.length) { toast('持仓没有可用行情，无法按市值折算'); return null; }
  const capital = Math.max(1000, Math.round(stockValue + cash));
  const holdings = rows.map((r) => ({ code: r.code, weight: Math.round((r.v / capital) * 1000) / 10 }));
  const plan = makePlan({ name: name || nextPlanName(), capital, holdings });
  toast(`已按当前市值折算：${holdings.length} 只 · 本金 ${num(capital / 1e4, 0)} 万`);
  return plan;
}

export function bindPlans() {
  const rerender2 = () => window.__rerender?.();

  // ---- 列表 ----
  const onCreate = document.getElementById('planCreate');
  if (onCreate) onCreate.onclick = () => goEdit(makePlan({ name: nextPlanName() }));
  const onFromHoldings = document.getElementById('planFromHoldings');
  if (onFromHoldings) {
    onFromHoldings.onclick = () => {
      const p = planFromHoldings();
      if (p) goEdit(p);
    };
  }

  const gotoBacktest = (id) => {
    btState.planId = id;
    btState.mode = 'port';
    btState.portMode = 'invest';
    const p = latestList().find((x) => x.id === id);
    if (p && Number(p.capital) > 0) btState.capital = Math.round(Number(p.capital) / 10000) * 10000;
    location.hash = 'backtest?plan=' + encodeURIComponent(id);
  };
  document.querySelectorAll('[data-plan-bt]').forEach((b) => {
    b.onclick = () => gotoBacktest(b.dataset.planBt);
  });
  document.querySelectorAll('[data-plan-use]').forEach((b) => {
    b.onclick = () => goDetail(b.dataset.planUse);
  });
  document.querySelectorAll('[data-plan-edit]').forEach((b) => {
    b.onclick = () => {
      const p = latestList().find((x) => x.id === b.dataset.planEdit);
      if (p) goEdit(p);
    };
  });
  document.querySelectorAll('[data-plan-copy]').forEach((b) => {
    b.onclick = () => {
      const copy = duplicatePlan(b.dataset.planCopy);
      if (!copy) return toast('复制失败，方案可能已被删除');
      toast(`已复制为「${copy.name}」`);
      rerender2();
    };
  });
  document.querySelectorAll('[data-plan-del]').forEach((b) => {
    b.onclick = async () => {
      const p = latestList().find((x) => x.id === b.dataset.planDel);
      const ok = await confirmDialog({
        title: '删除这个方案？',
        message: `「${p?.name || ''}」只删除方案，不影响当前账本持仓，也不会动回测结果。`,
        okLabel: '删除', danger: true,
      });
      if (!ok) return;
      removePlan(b.dataset.planDel);
      toast('方案已删除');
      rerender2();
    };
  });

  // ---- 编辑器 ----
  const back = document.getElementById('planBack');
  if (back) back.onclick = () => goList();
  const cancel = document.getElementById('edCancel');
  if (cancel) cancel.onclick = () => goList();

  const capEl = document.getElementById('edCapital');
  if (capEl) {
    capEl.onchange = () => {
      const v = Number(capEl.value);
      if (!(v > 0)) { toast('本金要大于 0'); return; }
      state.editing.capital = Math.max(1000, Math.round(v * 1e4));
      rerender2();
    };
  }
  const nameEl = document.getElementById('edName');
  if (nameEl) nameEl.oninput = () => { state.editing.name = (nameEl.value || '').slice(0, 20); };

  document.querySelectorAll('[data-entry]').forEach((b) => {
    b.onclick = () => {
      commitEdit();
      state.editing.entry = { ...state.editing.entry, mode: b.dataset.entry };
      rerender2();
    };
  });
  const monthsEl = document.getElementById('edMonths');
  if (monthsEl) {
    monthsEl.onchange = () => {
      const v = Math.round(Number(monthsEl.value) || 0);
      if (!(v >= 1)) { toast('期数至少 1 期'); return; }
      state.editing.entry.months = Math.min(MAX_MONTHS, v);
      rerender2();
    };
  }
  const minDyEl = document.getElementById('edMinDy');
  if (minDyEl) {
    minDyEl.onchange = () => {
      const v = Number(minDyEl.value);
      if (!(v >= 0)) { toast('门槛不能是负数'); return; }
      state.editing.entry.minDy = Math.min(20, Math.round(v * 100) / 100);
      rerender2();
    };
  }

  document.querySelectorAll('[data-unit]').forEach((b) => {
    b.onclick = () => {
      commitEdit();
      state.unit = b.dataset.unit;
      rerender2();
    };
  });

  // 行内权重/金额：input 时只更新草稿和汇总，不整页重渲染（不丢焦点）
  document.querySelectorAll('[data-w]').forEach((el) => {
    const code = el.dataset.w;
    const handler = () => {
      const p = state.editing;
      const row = p?.holdings.find((h) => h.code === code);
      if (!row) return;
      const v = Number(el.value);
      if (!(v >= 0)) return;
      row.weight = state.unit === 'amt'
        ? Math.round(((v * 1e4) / Math.max(1, p.capital)) * 1000) / 10
        : Math.round(v * 10) / 10;
      refreshEditorSummary();
    };
    el.oninput = handler;
    el.onchange = () => { handler(); rerender2(); }; // 失焦后按当前单位重新格式化
  });

  document.querySelectorAll('[data-row-del]').forEach((b) => {
    b.onclick = () => {
      commitEdit();
      state.editing.holdings = state.editing.holdings.filter((h) => h.code !== b.dataset.rowDel);
      rerender2();
    };
  });

  const addStock = document.getElementById('edAddStock');
  if (addStock) addStock.onclick = () => { commitEdit(); addStockFromPicker(); };
  const equal = document.getElementById('edEqual');
  if (equal) {
    equal.onclick = () => {
      commitEdit();
      const codes = state.editing.holdings.map((h) => h.code);
      if (!codes.length) return toast('先添加股票');
      state.editing.holdings = equalWeights(codes, 100);
      rerender2();
    };
  }
  const norm = document.getElementById('edNorm');
  if (norm) {
    norm.onclick = () => {
      commitEdit();
      if (!state.editing.holdings.length) return toast('先添加股票');
      state.editing.holdings = normalizeToFull(state.editing.holdings);
      rerender2();
    };
  }
  const fromHold = document.getElementById('edFromHoldings');
  if (fromHold) {
    fromHold.onclick = async () => {
      commitEdit();
      const ok = await confirmDialog({
        title: '用当前持仓填充？',
        message: '会用账本里的持仓 + 期初现金重算本金和比例，覆盖现在编辑的股票列表。',
        okLabel: '填充',
      });
      if (!ok) return;
      const fresh = planFromHoldings(state.editing?.name || nextPlanName());
      if (!fresh) return;
      const keepId = state.editing?.id;
      state.editing = { ...fresh, id: keepId || fresh.id };
      rerender2();
    };
  }
  const clear = document.getElementById('edClear');
  if (clear) {
    clear.onclick = async () => {
      commitEdit();
      if (!state.editing.holdings.length) return;
      const ok = await confirmDialog({ title: '清空股票列表？', message: '只清空当前编辑里的列表，保存后才会生效。', okLabel: '清空', danger: true });
      if (!ok) return;
      state.editing.holdings = [];
      rerender2();
    };
  }

  const save = document.getElementById('edSave');
  if (save) {
    save.onclick = () => {
      const p = commitEdit();
      if (!p) return;
      if (!p.holdings.length) return toast('先添加至少一只股票');
      if (planStockTotal(p) > 100.5) return toast('股票合计超过 100%，先归一化或调小比例');
      const totalW0 = planStockTotal(p);
      p.holdings = roundWeights(p.holdings, 1);
      if (Math.abs(totalW0 - 100) < 0.06) p.holdings = relockToTotal(p.holdings, 100, 1);
      const saved = savePlan(p);
      toast(`方案「${saved.name}」已保存`);
      goList();
    };
  }

  // ---- 执行清单 ----
  const dBack = document.getElementById('detailBack');
  if (dBack) dBack.onclick = () => goList();
  const dEdit = document.getElementById('detailEdit');
  if (dEdit) {
    dEdit.onclick = () => {
      const p = latestList().find((x) => x.id === state.detailId);
      if (p) goEdit(p);
    };
  }
  const dBt = document.getElementById('detailBt');
  if (dBt) dBt.onclick = () => gotoBacktest(state.detailId);
  document.querySelectorAll('[data-buy]').forEach((b) => {
    b.onclick = () => {
      openBuyModal(b.dataset.buy, {
        shares: Number(b.dataset.shares) || LOT,
        price: Number(b.dataset.price) || 0,
        onDone: () => { rerender2(); },
      });
    };
  });
}

/* ---------------- 选股弹层 ---------------- */

export function openStockPicker({ exclude = [], onPick } = {}) {
  const pool = Object.keys(db.baseline?.pool || {});
  const all = [...new Set([...Object.keys(db.quotes || {}), ...pool])];
  const renderList = (kw) => {
    const q = String(kw || '').trim();
    const out = [];
    for (const code of all) {
      if (exclude.includes(code)) continue;
      const name = nameOf(code);
      if (q && !code.includes(q) && !String(name).includes(q)) continue;
      out.push({ code, name });
      if (out.length >= 30) break;
    }
    if (!out.length) return '<div class="pick-empty">没找到，换个代码或名称试试</div>';
    return out.map(({ code, name }) => `<button class="pick-item" data-pick="${esc(code)}">
      <span class="pick-name">${esc(name)}</span>
      <span class="pick-code">${esc(code)}</span>
      <span class="pick-dy">${(() => { const d = lastDpsOf(dividends()[code]); const p = quote(code)?.p; return d && p ? num((d / p) * 100, 2) + '%' : '—'; })()}</span>
    </button>`).join('');
  };
  openModal({
    title: '添加股票',
    width: '560px',
    body: `<input class="input" id="pickQ" placeholder="输入代码或名称，例如 600036 / 银行" autocomplete="off">
      <div class="pick-list" id="pickList"></div>
      <div class="modal-hint">按代码或名称搜索；右侧是当前股息率</div>`,
    actions: [{ label: '取消', kind: 'ghost' }],
    onMount: (root) => {
      const input = root.querySelector('#pickQ');
      const list = root.querySelector('#pickList');
      const paint = () => { list.innerHTML = renderList(input.value); };
      input.oninput = paint;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          const first = list.querySelector('[data-pick]');
          if (first) first.click();
        }
      };
      list.onclick = (e) => {
        const btn = e.target.closest('[data-pick]');
        if (!btn) return;
        const code = btn.dataset.pick;
        closeModal();
        setTimeout(() => onPick?.(code), 20);
      };
      paint();
      setTimeout(() => input.focus(), 80);
    },
  });
}
