/**
 * 回测页的视图层：HTML 片段、画图、事件绑定。
 * 只读 core 的状态与结果，不反过来被 core 依赖。
 */
import { bigMoney, esc, num, pctSign, upDown } from '../../ui/format.js';
import { loadPlans, savePlan } from '../../store.js';
import { icon } from '../../ui/icons.js';
import { db, nameOf, quote } from '../../data.js';
import { priceAt } from '../../engine/market.js';
import { chartColors, drawBarsVs, drawDivChart, drawDonut, drawEnvChart, drawLineMini, drawMultiLineChart, drawNavChart, drawPortfolioChart, drawPriceChart, drawSimilarChart, drawWaterfall } from '../../charts.js';
import { mountStockSearch } from '../../ui/stockSearch.js';
import { DAY, addYears, btState, clampFrom, compTimer, ctx, dailyStart, drawdownOf, envCompare, readParams, repayCurve, rerenderHook, setCompTimer, stopCompPlay, todayStr } from './core.js';

export function modeTabs() {
  const mk = (id, label, active) => `<button class="btn sm ${active ? 'primary' : 'ghost'}" data-btmode="${id}">${label}</button>`;
  return `<div class="row" style="gap:6px;flex-wrap:wrap">
    ${mk('port', '组合回测', btState.mode === 'port')}
    ${mk('stock', '个股回测', btState.mode === 'stock')}
    ${mk('cmp', '组合对比', btState.mode === 'cmp')}
  </div>`;
}

export function paramBar(opts = {}) {
  const from = clampFrom(btState.from);
  const activeQ = [3, 5, 10].find((y) => Math.abs((Date.parse(btState.to) - Date.parse(from)) / DAY / 365.25 - y) < 0.25);
  const tabs = opts.tabs === false || btState.planId !== 'current' ? '' : `<div class="bt-tabs" style="margin-left:auto;display:flex;gap:6px">
    <button class="btn sm ${btState.portMode === 'invest' ? 'primary' : 'ghost'}" data-portmode="invest">投入回测</button>
    <button class="btn sm ${btState.portMode === 'replay' ? 'primary' : 'ghost'}" data-portmode="replay">持仓回放</button>
  </div>`;
  const capW = Math.round(btState.capital / 10000);
  const addTxt = btState.monthlyAdd > 0 ? `月追 ${btState.monthlyAdd / 1000}千` : '不追加';
  const qTxt = activeQ ? `近 ${activeQ} 年` : `${from} → ${btState.to}`;
  const planTxt = btState.mode === 'port' && btState.planId !== 'current'
    ? ` · ${esc((loadPlans().find((p) => p.id === btState.planId) || {}).name || '方案')}` : '';
  const sumTxt = `${qTxt} · ${capW} 万 · ${addTxt}${btState.mode === 'stock' ? ` · 质量${btState.quality ? '开' : '关'}` : ''}${planTxt}`;
  return `<section class="panel fade-in bt-params">
    <div class="bt-bar">
      <button class="bt-summary${btState.paramOpen ? ' on' : ''}" id="btFold" aria-expanded="${btState.paramOpen ? 'true' : 'false'}">
        ${icon('filter')}<span>${sumTxt}</span><span class="bf-edit">${btState.paramOpen ? '收起' : '调整'}</span>
      </button>
      <button class="btn primary" id="btRun">${icon('play')} 运行回测</button>
    </div>
    <div class="bt-more" id="btMore"${btState.paramOpen ? '' : ' hidden'}>
    <div class="bt-param-row">
      <label class="bt-field"><span>开始</span><input class="input" type="date" id="btFrom" value="${from}" min="2012-01-01" max="${todayStr()}"></label>
      <label class="bt-field"><span>结束</span><input class="input" type="date" id="btTo" value="${btState.to}" min="2012-01-01" max="${todayStr()}"></label>
      ${opts.tabs === false || btState.mode !== 'port' ? '' : `<label class="bt-field"><span>组合</span><select class="input" id="btPlan" style="width:132px">
        <option value="current"${btState.planId === 'current' ? ' selected' : ''}>当前持仓（实时）</option>
        ${loadPlans().map((p) => `<option value="${p.id}"${btState.planId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select></label>`}
      ${btState.portMode === 'replay' && opts.tabs !== false && btState.mode === 'port'
        ? `<label class="bt-field" title="持仓回放的本金 = 起点那天的组合市值，不是这里填的数"><span>本金(万)</span><input class="input" type="number" id="btCap" value="—" disabled></label>
           <span class="bt-hint">持仓回放的本金 = 起点那天的市值（这笔本金框不生效）</span>`
        : `<label class="bt-field"><span>本金(万)</span><input class="input" type="number" id="btCap" min="1" step="10" value="${Math.round(btState.capital / 10000)}"></label>`}
      ${opts.useMktCap ? '<button class="btn sm ghost" id="btUseMktCap">用当前市值</button>' : ''}
      <label class="bt-field"><span>月追加(元)</span><input class="input" type="number" id="btMon" min="0" step="500" value="${btState.monthlyAdd}"></label>
      ${opts.minDy ? `<label class="bt-field"><span>买入股息率≥</span><input class="input" type="number" id="btMinDy" min="0" max="10" step="0.5" value="${btState.minDy}"></label>` : ''}
      ${opts.quality ? `<label class="bt-field bt-check"><input type="checkbox" id="btQuality"${btState.quality ? ' checked' : ''}><span>质量筛选（加载财报，较慢）</span></label>` : ''}
    </div>
    <div class="bt-param-row" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
      <span class="bt-hint">快捷区间</span>
      ${[3, 5, 10].map((y) => `<button class="bt-chip ${activeQ === y ? 'on' : ''}" data-q="${y}">近 ${y} 年</button>`).join('')}
      <span class="bt-hint" style="margin-left:12px">月追加快捷</span>
      ${[0, 5000, 10000, 20000].map((v) => `<button class="bt-chip ${btState.monthlyAdd === v ? 'on' : ''}" data-add="${v}">${v === 0 ? '不追加' : v / 1000 + '千'}</button>`).join('')}
      ${tabs}
    </div>
    ${btState.mode === 'cmp' ? cmpPlanPicker() : ''}
    <div class="bt-hint" style="margin-top:8px">${opts.stock
      ? `价格不复权 · 每月末定投 · 分红在除权除息日当天按收盘价再投 · 不判断买卖点`
      : `价格不复权 · 分红按真实除权除息日到账 · 未上市股票份额先摊给已上市、上市满 6 个月建仓 · 日 K 自 ${esc(dailyStart())}（更早用月线）`}</div>
    </div>
    <div class="bt-hint bt-footnote">日净值 · 不复权 · 分红按除息日到账 · 不含税 · 行情 ${esc(todayStr())}</div>
  </section>`;
}

function cmpPlanPicker() {
  const plans = loadPlans();
  if (!plans.length) {
    return `<div class="bt-param-row" style="margin-top:10px"><span class="bt-hint">你还没有保存的方案——去「我的 → 方案」建几个，这里就能拿来比。</span></div>`;
  }
  const picked = btState.cmpPlans;
  const on = (id) => !picked || picked.includes(id);
  return `<div class="bt-param-row" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
    <span class="bt-hint">对比哪些方案</span>
    <button class="bt-chip ${!picked ? 'on' : ''}" data-cmpplan="__all">全部 ${plans.length} 个</button>
    ${plans.map((p) => `<button class="bt-chip ${on(p.id) ? 'on' : ''}" data-cmpplan="${p.id}">${esc(p.name)}</button>`).join('')}
    <span class="bt-hint" style="margin-left:auto">当前持仓 · 红利策略 · 两条指数 始终在场</span>
  </div>`;
}

export function metricGrid(cards) {  return `<div class="bt-metrics">${cards.map((c) => `<div class="bt-metric ${c.on ? 'on' : ''}" ${c.key ? `data-metric="${c.key}"` : ''}>
      <div class="k">${esc(c.k)}</div><div class="v num ${c.cls || ''}">${c.v}</div><div class="s">${c.s || ''}</div>
    </div>`).join('')}</div>`;
}

export function hero(cfg) {
  const sub = cfg.chips
    ? `<div class="hero-chips">${cfg.chips.map((c) => `<span class="hchip ${c.cls || ''}">${c.t}</span>`).join('')}</div>`
    : `<div class="hero-desc">${cfg.desc}</div>`;
  return `<section class="hero fade-in">
    <div class="hero-main">
      <div class="hero-kicker">${cfg.kicker}</div>
      <div class="hero-line">${cfg.main}</div>
      ${sub}
    </div>
    <div class="stats">
      ${cfg.stats.map((s) => `<div class="stat"><div class="stat-label">${esc(s.k)}</div><div class="stat-value sm num ${s.cls || ''}">${s.v}</div><div class="stat-sub">${s.s || ''}</div></div>`).join('')}
    </div>
  </section>`;
}

export function fold(id, title, summary, content) {
  return `<details class="fold" data-fold="${id}">
    <summary><div><div class="fold-title">${title}</div><div class="fold-sum">${summary}</div></div><span class="fold-arrow">展开 ▸</span></summary>
    <div class="fold-body">${content}</div>
  </details>`;
}

export function investRules() {
  const R = [
    ['建仓', '第一天把首次本金全买进去（按 100 股整手，零头留现金）'],
    ['定投', btState.monthlyAdd > 0
      ? `每月 ${bigMoney(btState.monthlyAdd)}，月最后一个交易日全买`
      : '本次没开定投（月追加 = 0），只有第一天那笔本金'],
    ['分红', '每一笔分红在<b>除权除息日当天</b>按收盘价买回（那天价格已经除过息，用不复权收盘价才对）；不够一手就留在现金里'],
    ['一年分几次', '不做任何假设：<b>data/div/&lt;code&gt;.json 里记了几笔就派几笔</b>（实际数据里一年 1 笔 3448 只、2 笔 1513 只、3 笔 127 只、4 笔 12 只，最多的一只中国石化全部历史 50 笔）'],
    ['没取到派息明细的股票', '全市场 5406 只里有 5402 只有逐笔除权日；剩下 4 只（301139 / 601059 / 601198 / 000016）数据源查不到除权日——<b>它们在本页一律不计分红</b>，不猜日期、不编「4 月末」'],
    ['不判断买卖点', '不设股息率门槛、不看财报、不因为分红下调卖出——一分钱都不卖，也没有卖点'],
    ['费用', '不含佣金、不含红利税；现金零头不计息'],
    ['价格', '日 K 不复权，更早的区间用月线月末补齐'],
    ['基准', '中证红利全收益（H00922），同本金、同定投节奏'],
  ];
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>项目</th><th>规则</th></tr></thead>
    <tbody>${R.map(([k, v]) => `<tr><td class="em" style="white-space:nowrap">${esc(k)}</td><td style="text-align:left;white-space:normal">${v}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

export function rulesCard() {
  const R = [
    ['买入', '4/12 月末决策：股息率 ≥ 买入线，且质量过关（不亏损、支付率 &lt;85%、现金流覆盖 ≥0.7、ROE ≥5）'],
    ['未上市', '目标份额先平均摊给当时已上市的股票（资金不闲置）；上市满 6 个月后按目标权重卖出别的股票把它买回来，买入金额 = 初始份额 × 期间组合增长'],
    ['分红', '每笔按<b>真实除权除息日</b>到账（每股派息 × 当时持股），当天收盘价买回；组合口径复投，对照口径进现金。<b>没取到派息明细的股票一律不计分红</b>（不猜日期）'],
    ['卖出', '质量否决（亏损 / 现金流覆盖不足 / 支付率过高）或分红下调 ≥5% → 清仓'],
    ['现金', '现金年息 1.5%，日计'],
    ['月追加', '4 月末 / 12 月末各入账 6 个月追加额（定投节奏，跟分红无关）'],
    ['费用', '不含佣金、不含红利税'],
    ['价格', '日 K 不复权（2018-07 起），更早用月线月末；分红单独计现金'],
    ['基准', '中证红利全收益（H00922）日线；最后的月末之后用月线补齐'],
  ];
  return `<div class="table-wrap"><table class="table"><tbody>${R.map(([k, v]) => `<tr><td class="name" style="width:70px;color:var(--accent-2)">${k}</td><td style="white-space:normal;color:var(--text-2)">${v}</td></tr>`).join('')}</tbody></table></div>`;
}

export function flowTable(events) {
  const rows = [...events].reverse().slice(0, 500).map((e) => {
    if (e.type === '买入' || e.type === '建仓' || e.type === '定投') {
      return `<tr><td class="num">${esc(e.date)}</td><td class="name">${esc(nameOf(e.code))}<span class="code">${esc(e.code)}</span></td><td class="up">${esc(e.type)}</td><td class="num">${num(e.price, 2)}</td><td class="num">${num(e.shares, 0)}</td><td class="num">${((e.shares * e.price) / 10000).toFixed(1)}</td><td class="muted">${esc(e.why || '')}</td></tr>`;
    }
    if (e.type === '卖出') {
      return `<tr><td class="num">${esc(e.date)}</td><td class="name">${esc(nameOf(e.code))}<span class="code">${esc(e.code)}</span></td><td class="down">卖出</td><td class="num">${num(e.price, 2)}</td><td class="num">${num(e.shares, 0)}</td><td class="num">${((e.shares * e.price) / 10000).toFixed(1)}</td><td class="muted">${esc(e.why || '')}</td></tr>`;
    }
    return `<tr><td class="num">${esc(e.date)}</td><td class="name">—</td><td>${esc(e.type)}</td><td class="num">—</td><td class="num">—</td><td class="num">${(e.amount / 10000).toFixed(2)}</td><td class="muted">${esc(e.why || '')}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>日期</th><th>股票</th><th>类型</th><th>价格</th><th>股数</th><th>金额(万)</th><th>依据</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">区间内没有交易</td></tr>'}</tbody></table></div>`;
}

export function yearSection(r) {
  const years = r.yearly.filter((y) => y.nav1 > 0);
  const capital = r.nav[0]?.[1] || 1;
  let cumDiv = 0;
  const tbl = years.map((y) => {
    const ret = y.nav0 > 0 ? (y.nav1 / y.nav0 - 1) * 100 : null;
    const cashPct = y.nav1 > 0 ? (y.cash / y.nav1) * 100 : null;
    cumDiv += y.div;
    const repay = (cumDiv / Math.max(1, capital)) * 100;
    return `<tr><td class="num">${y.year}</td><td class="num">${(y.nav0 / 10000).toFixed(1)}</td><td class="num">${(y.nav1 / 10000).toFixed(1)}</td><td class="num ${upDown(ret)}">${pctSign(ret, 1)}</td><td class="num">${(y.div / 10000).toFixed(2)}</td><td class="num">${(cumDiv / 10000).toFixed(2)}</td><td class="num">${repay.toFixed(0)}%</td><td class="num">${pctSign(cashPct, 0)}</td><td class="num">${(y.invest / 10000).toFixed(1)}</td></tr>`;
  }).join('');
  return `<div class="bt-year-grid">
    <div class="bt-year-cell"><div class="bt-year-title">累计收益</div><div id="chYear" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">分红</div><div id="chDiv" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">回本率（累计分红 ÷ 本金）</div><div id="chRepay" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">现金占比</div><div id="chCash" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">年度收益：组合 vs 指数</div><div id="chVsIdx" class="chart" style="height:240px"></div></div>
  </div>
  <div class="table-wrap" style="margin-top:10px"><table class="table">
    <thead><tr><th>年</th><th>年初(万)</th><th>年末(万)</th><th>今年收益</th><th>分红(万)</th><th>分红累计(万)</th><th>回本%</th><th>年末现金%</th><th>追加(万)</th></tr></thead>
    <tbody>${tbl}</tbody>
  </table></div>`;
}

export function stockCards(r, structureData, market) {
  const last = r.comp[r.comp.length - 1]?.[1] || {};
  const total = Object.values(last).reduce((s, v) => s + v, 0) || 1;
  const cards = [];
  for (const h of structureData.holdings) {
    const code = h.code;
    const mv = (last[code] || 0) / 10000;
    const w = ((last[code] || 0) / total) * 100;
    const div = (r.divByCode[code] || 0) / 10000;
    const buys = r.events.filter((e) => e.type === '买入' && e.code === code).length;
    const p0 = priceAt(market.series.get(code), market.dates[0]);
    const p1 = priceAt(market.series.get(code), market.dates[market.dates.length - 1]);
    const ret = p0 > 0 && p1 > 0 ? (p1 / p0 - 1) * 100 : null;
    cards.push(`<div class="ph-card fade-in" data-scard="${code}">
      <div class="ph-row"><span class="ph-name">${esc(nameOf(code))} <em>${esc(code)}</em></span><span class="num ${upDown(ret)}">${pctSign(ret, 1)}</span></div>
      <div class="ph-wbar"><i style="width:${Math.min(100, w)}%"></i><b>占组合 ${w.toFixed(1)}%</b></div>
      <div class="ph-grid"><span><em>市值</em>${mv.toFixed(1)}万</span><span><em>分红</em><b class="gold">${div.toFixed(2)}万</b></span><span><em>买点</em>${buys}次</span><span><em>现价</em>${num(quote(code)?.p, 2)}</span></div>
      <div class="ph-foot"><span class="bt-hint">展开看日 K / 分红</span><span style="flex:1"></span><button class="btn sm ghost" data-sbt="${code}">进个股回测</button></div>
    </div>
    <div class="scard-body" id="scard-${code}" style="display:none"><div id="sdChart-${code}" class="chart" style="height:260px"></div></div>`);
  }
  return cards.join('');
}

export function yearSectionStock(r) {
  const years = r.yearly.filter((y) => y.nav1 > 0);
  const capital = r.nav[0]?.[1] || 1;
  let cumDiv = 0;
  const tbl = years.map((y) => {
    const ret = y.nav0 > 0 ? (y.nav1 / y.nav0 - 1) * 100 : null;
    const cashPct = y.nav1 > 0 ? (y.cash / y.nav1) * 100 : null;
    cumDiv += y.div;
    const repay = (cumDiv / Math.max(1, capital)) * 100;
    return `<tr><td class="num">${y.year}</td><td class="num">${(y.nav0 / 10000).toFixed(1)}</td><td class="num">${(y.nav1 / 10000).toFixed(1)}</td><td class="num ${upDown(ret)}">${pctSign(ret, 1)}</td><td class="num divc">${(y.div / 10000).toFixed(2)}</td><td class="num divc">${(cumDiv / 10000).toFixed(2)}</td><td class="num">${repay.toFixed(0)}%</td><td class="num">${pctSign(cashPct, 0)}</td><td class="num">${(y.invest / 10000).toFixed(1)}</td></tr>`;
  }).join('');
  return `<div class="bt-year-grid">
    <div class="bt-year-cell"><div class="bt-year-title">累计收益</div><div id="syYear" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">分红</div><div id="syDiv" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">回本率（累计分红 ÷ 本金）</div><div id="syRepay" class="chart" style="height:240px"></div></div>
    <div class="bt-year-cell"><div class="bt-year-title">当年股息率（分红 ÷ 年末市值）</div><div id="syCash" class="chart" style="height:240px"></div></div>
  </div>
  <div class="table-wrap" style="margin-top:10px"><table class="table">
    <thead><tr><th>年</th><th>年初(万)</th><th>年末(万)</th><th>今年收益</th><th>分红(万)</th><th>分红累计(万)</th><th>回本%</th><th>年末现金%</th><th>追加(万)</th></tr></thead>
    <tbody>${tbl}</tbody>
  </table></div>`;
}

function drawStockYearCharts() {
  const r = ctx.stock;
  if (!r) return;
  const capital = r.nav[0]?.[1] || btState.capital;
  const nav = r.nav;
  drawLineMini(document.getElementById('syYear'), nav.map(([d, v]) => [d, +((v / capital - 1) * 100).toFixed(2)]), { yFmt: (v) => v.toFixed(0) + '%', markLine: { silent: true, symbol: 'none', lineStyle: { color: '#65707e' }, data: [{ yAxis: 0 }] } });
  drawDivChart(document.getElementById('syDiv'), r.divByY);
  {
    // 阶梯点直接由 yearly 累出来，不再逐日扫：年末跳一档，最后一年补到区间最后一天
    const ys = r.yearly.filter((y) => y.nav1 > 0);
    const lastDate = nav[nav.length - 1][0];
    let cum = 0;
    const rows = [[nav[0][0], 0]];
    for (const y of ys) {
      if (y.div > 0) {
        rows.push([`${y.year}-01-01`, +((cum / capital) * 100).toFixed(2)]);
        cum += y.div;
        rows.push([`${y.year}-12-31`, +((cum / capital) * 100).toFixed(2)]);
      }
    }
    rows.push([lastDate, +((cum / capital) * 100).toFixed(2)]);
    drawLineMini(document.getElementById('syRepay'), rows, { yFmt: (v) => v.toFixed(0) + '%', color: chartColors().div });
  }
  // 当年股息率：分红 ÷ 年末市值。比「现金占比」有用得多——个股页现金本来就是零头
  drawLineMini(document.getElementById('syCash'), r.yearly.filter((y) => y.nav1 > 0).map((y) => [`${y.year}-12-31`, +(y.nav1 > 0 ? (y.div / y.nav1) * 100 : 0).toFixed(2)]), { yFmt: (v) => v.toFixed(1) + '%', color: chartColors().buy });
}

export function divSectionStock(r) {
  const rows = r.trades.filter((t) => t.type === '分红复投' || t.type === '分红');
  const byY = new Map();
  for (const t of rows) {
    const y = t.date.slice(0, 4);
    if (!byY.has(y)) byY.set(y, { n: 0, amt: 0, shares: 0, dps: 0 });
    const o = byY.get(y);
    o.n += 1;
    o.amt += t.div != null ? t.div : (t.amount || 0);
    o.shares += t.type === '分红复投' ? (t.shares || 0) : 0;
    o.dps += t.dps || 0;
  }
  const years = [...byY.keys()].sort();
  const yTbl = years.map((y) => {
    const o = byY.get(y);
    return `<tr><td class="num">${y}</td><td class="num">${o.n} 笔</td><td class="num">${o.dps.toFixed(4)}</td><td class="num divc">${(o.amt / 10000).toFixed(2)}</td><td class="num">${o.shares.toLocaleString('zh-CN')}</td></tr>`;
  }).join('');
  const dTbl = rows.slice().reverse().map((t) => `<tr><td class="num">${t.date}</td><td class="num">${(t.dps || 0).toFixed(4)}</td><td class="num divc">${(((t.div != null ? t.div : t.amount) || 0) / 10000).toFixed(2)}</td><td class="num">${t.type === '分红复投' ? (t.shares || 0).toLocaleString('zh-CN') : '<span class="dim">不够一手</span>'}</td><td class="num">${t.price ? t.price.toFixed(2) : '—'}</td></tr>`).join('');
  return `<div class="panel-body" style="padding:8px 10px 4px"><div id="stDivChart" class="chart" style="height:280px"></div></div>
  <div class="table-wrap" style="margin-top:6px"><table class="table">
    <thead><tr><th>年</th><th>派息次数</th><th>每股合计(元)</th><th>到账(万)</th><th>再投股数</th></tr></thead>
    <tbody>${yTbl}</tbody>
  </table></div>
  <div class="table-wrap" style="margin-top:14px"><table class="table">
    <thead><tr><th>除权除息日</th><th>每股派(元)</th><th>到账(万)</th><th>再投股数</th><th>再投价</th></tr></thead>
    <tbody>${dTbl}</tbody>
  </table></div>`;
}

export function strategyPanel() {
  const st = ctx?.cmpStrategy;
  if (!st || !st.periods || !st.periods.length) return '';
  const last = st.periods[st.periods.length - 1];
  const items = last.items || [];
  if (!items.length) return '';
  const pool = db.baseline.pool || {};
  const avgDy = items.reduce((a, x) => a + (Number(x.dy) || 0), 0) / items.length;
  const inds = new Map();
  for (const x of items) {
    const g = pool[x.code]?.ind || '其他';
    if (!inds.has(g)) inds.set(g, []);
    inds.get(g).push(x);
  }
  const maxInd = [...inds.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const chips = [...inds.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([g, list]) => `
      <div class="st-ind">
        <div class="st-ind-head">${esc(g)}<span>${list.length}</span></div>
        <div class="st-ind-body">${list.map((x) => {
          // pool 里的名字是上游截断过的，还带 XD/XR/DR 除权前缀（「XD海尔智」）；
          // 行情里的名字是完整的，优先用它
          const nm = db.quotes?.[x.code]?.n || String(x.name || '').replace(/^(XD|XR|DR)/, '');
          return `<span class="st-chip" data-code="${esc(x.code)}" title="${esc(nm)} 股息率 ${(Number(x.dy) || 0).toFixed(1)}%">${esc(nm)}<i>${(Number(x.dy) || 0).toFixed(1)}%</i></span>`;
        }).join('')}</div>
      </div>`).join('');

  return `
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">红利精选 · 最新一期成分</span><span class="section-note">${esc(last.ym)} 调仓 · ${items.length} 只等权</span></div>
    <div class="panel-body" style="padding:12px 14px 14px">
      <div class="st-meta">
        <div><span class="k">平均股息率</span><b class="num gold">${avgDy.toFixed(1)}%</b></div>
        <div><span class="k">覆盖行业</span><b class="num">${inds.size}</b></div>
        <div><span class="k">最大行业</span><b class="num">${esc(maxInd ? maxInd[0] : '—')}</b><span class="d">${maxInd ? maxInd[1].length + ' 只' : ''}</span></div>
      </div>
      <div class="st-inds">${chips}</div>
      <div class="bt-hint" style="margin-top:10px">规则：连续分红 ≥5 年 · 派息率 10%–80% · 股息率 4%–8% · 经营现金流覆盖 ≥0.7 · 同行业最多 3 只。股息率上限不是越高越好——8% 以上多半是市场在说这次分红撑不住。</div>
    </div>
  </section>`;
}

export function bindBacktest() {
  if (!ctx) return;
  stopCompPlay();
  const rerender = () => { if (rerenderHook) rerenderHook(); };
  const syncUrl = () => {
    try {
      const q = [];
      if (btState.mode !== 'port') q.push('mode=' + btState.mode);
      if (btState.mode === 'stock' && btState.stock) q.push('code=' + btState.stock);
      history.replaceState(null, '', '#backtest' + (q.length ? '?' + q.join('&') : ''));
    } catch (e) {}
  };
  const rerenderUrl = () => { syncUrl(); rerender(); };
  document.querySelectorAll('[data-btmode]').forEach((b) => {
    b.onclick = () => { btState.mode = b.dataset.btmode; rerenderUrl(); };
  });
  document.querySelectorAll('[data-portmode]').forEach((b) => {
    b.onclick = () => { btState.portMode = b.dataset.portmode; rerender(); };
  });
  const run = document.getElementById('btRun');
  if (run) run.onclick = () => readParams();
  // 参数抽屉：只切 DOM，不重跑回测（改完点「运行回测」才重算）
  const fold = document.getElementById('btFold');
  const more = document.getElementById('btMore');
  if (fold && more) {
    fold.onclick = () => {
      more.hidden = !more.hidden;
      btState.paramOpen = !more.hidden;
      fold.classList.toggle('on', btState.paramOpen);
      fold.setAttribute('aria-expanded', btState.paramOpen ? 'true' : 'false');
      const ed = fold.querySelector('.bf-edit');
      if (ed) ed.textContent = btState.paramOpen ? '收起' : '调整';
    };
  }
  const planSel = document.getElementById('btPlan');
  if (planSel) planSel.onchange = () => {
    btState.planId = planSel.value;
    if (btState.planId !== 'current') {
      btState.portMode = 'invest';
      const hit = loadPlans().find((p) => p.id === btState.planId);
      if (hit && Number(hit.capital) > 0) btState.capital = Math.round(Number(hit.capital) / 10000) * 10000;
    }
    rerender();
  };
  const saveBtn = document.getElementById('btSavePlan');
  if (saveBtn) saveBtn.onclick = () => {
    const name = window.prompt('方案名称（例如：红利五虎）', '我的方案');
    if (!name) return;
    const st = ctx.structure;
    const saved = savePlan({
      name: name.slice(0, 20),
      capital: btState.capital,
      holdings: st.holdings.map((h) => ({ code: h.code, weight: Math.round(h.weight * 10) / 10 })),
      entry: { mode: 'once' },
    });
    btState.planId = saved?.id || 'current';
    rerender();
  };
  const useCap = document.getElementById('btUseMktCap');
  if (useCap) useCap.onclick = () => {
    const s = ctx.structure;
    if (s && s.total > 0) { btState.capital = Math.round(s.total / 10000) * 10000; rerender(); }
  };
  document.querySelectorAll('[data-q]').forEach((b) => {
    // 先收下没提交的输入，否则刚改的本金/日期会被这一步重渲染悄悄冲掉
    b.onclick = () => { readParams(); btState.from = addYears(btState.to, -Number(b.dataset.q)); rerender(); };
  });
  document.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => { readParams(); btState.monthlyAdd = Number(b.dataset.add); rerender(); };
  });
  document.querySelectorAll('[data-cmpplan]').forEach((b) => {
    b.onclick = () => {
      const all = loadPlans().map((p) => p.id);
      const id = b.dataset.cmpplan;
      if (id === '__all') { btState.cmpPlans = null; rerender(); return; }
      const cur = btState.cmpPlans ? [...btState.cmpPlans] : [...all];
      const i = cur.indexOf(id);
      if (i >= 0) cur.splice(i, 1); else cur.push(id);
      btState.cmpPlans = cur.length === all.length ? null : cur;
      rerender();
    };
  });
  const search = document.getElementById('stSearch');
  if (search) {
    mountStockSearch(search, {
      suggest: document.getElementById('stSuggest'),
      onPick: (c) => {
        if (!/^\d{6}$/.test(c || '') || c === btState.stock) return;
        btState.stock = c;
        rerenderUrl();
      },
    });
  }
  // 日 K 折叠着：展开那一刻再画（藏在 display:none 里画出来是 0 宽）
  const klineFold = document.querySelector('[data-fold="kline"]');
  if (klineFold) {
    klineFold.addEventListener('toggle', () => {
      if (!klineFold.open) return;
      const box = document.getElementById('stChart');
      const inst = window.echarts?.getInstanceByDom(box);
      if (inst) inst.resize();
      else drawStockKline();
    });
  }
  document.querySelectorAll('[data-metric]').forEach((card) => {
    card.onclick = () => {
      btState.metric = card.dataset.metric;
      document.querySelectorAll('[data-metric]').forEach((c) => c.classList.toggle('on', c === card));
      if (btState.mode === 'stock') renderStockMetric(card.dataset.metric);
      else renderMetric(card.dataset.metric);
    };
  });

  const p = ctx.port;
  if (p && p.comp && p.comp.length) {
    const range = document.getElementById('compRange');
    const dateEl = document.getElementById('compDate');
    const listEl = document.getElementById('compList');
    const denEl = document.getElementById('compDonut');
    const play = document.getElementById('compPlay');
    const COLORS = ['#d8a84e', '#ef5b60', '#5b9cf5', '#35b57a', '#a78bfa', '#e8a33d', '#22b8cf', '#f783ac', '#94d82d'];
    let idx = p.comp.length - 1;
    const paint = () => {
      const [d, row] = p.comp[idx];
      const entries = Object.entries(row).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]).map(([code, v], i) => ({
        name: code === 'cash' ? '现金' : nameOf(code),
        value: +(v / 10000).toFixed(2),
        color: code === 'cash' ? '#8b93a1' : COLORS[i % COLORS.length],
      }));
      const total = entries.reduce((s, e) => s + e.value, 0);
      drawDonut(denEl, entries);
      if (dateEl) dateEl.innerHTML = `持仓构成 · <b>${d}</b> · 总资产 <b class="num">${total.toFixed(1)}万</b>`;
      if (listEl) listEl.innerHTML = entries.map((e) => `<span class="comp-item"><i style="background:${e.color}"></i>${esc(e.name)} <b class="num">${e.value.toFixed(1)}万</b><em>${((e.value / (total || 1)) * 100).toFixed(0)}%</em></span>`).join('');
    };
    if (range) {
      range.max = String(p.comp.length - 1);
      range.value = String(idx);
      range.oninput = () => { idx = Math.min(p.comp.length - 1, Math.max(0, Number(range.value) || 0)); paint(); };
    }
    if (play) play.onclick = () => {
      if (compTimer) { stopCompPlay(); return; }
      // 滑轨默认停在最后一天：这时候点「播放」原地就结束，看着像按钮坏了。从头播。
      if (idx >= p.comp.length - 1) { idx = 0; if (range) range.value = '0'; paint(); }
      play.textContent = '暂停 ⏸';
      setCompTimer(setInterval(() => {
        idx++;
        if (idx >= p.comp.length) { idx = p.comp.length - 1; stopCompPlay(); }
        if (range) range.value = String(idx);
        paint();
      }, 55));
    };
    paint();
  }

  if (p) {
    drawPortfolioChart(document.getElementById('portChart'), {
      nav: p.nav, navR: p.navR, bench: p.bench, lowVol: p.lowVol, dd: p.dd,
      divByY: p.divByY, capital: btState.portMode === 'replay' ? (p.nav[0]?.[1] || 1) : btState.capital,
    });
    const wfBase = btState.portMode === 'replay' ? (p.nav[0]?.[1] || 1) : btState.capital;
    // 个股页传了 add，组合页没传——10 年追加的钱全被记成「价格涨出来的」，和同页「累计投入」自相矛盾
    drawWaterfall(document.getElementById('wfChart'), { capital: wfBase, add: Math.max(0, (p.totalIn || wfBase) - wfBase), div: p.totalDiv, end: p.end });
    drawEnvChart(document.getElementById('envChart'), envCompare(p.nav, ctx.benchRows, clampFrom(btState.from), btState.to));
    const simData = document.getElementById('simData');
    if (simData) {
      const pts = JSON.parse(simData.dataset.json || '[]');
      const cur = simData.dataset.cur ? Number(simData.dataset.cur) : null;
      const med = simData.dataset.med ? Number(simData.dataset.med) : null;
      const nowEl = document.getElementById('nowChart');
      if (cur != null && pts.length) drawSimilarChart(nowEl, pts, cur, med);
      else if (nowEl) nowEl.innerHTML = '<div class="bt-hint" style="padding:30px;text-align:center">历史相似状态样本不足</div>';
    }
    document.querySelectorAll('[data-scard]').forEach((card) => {
      card.onclick = (e) => {
        if (e.target.closest('[data-sbt]')) return;
        const code = card.dataset.scard;
        const body = document.getElementById('scard-' + code);
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        if (!open) drawStockManual(code);
      };
    });
    document.querySelectorAll('[data-sbt]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); btState.stock = b.dataset.sbt; btState.mode = 'stock'; rerender(); };
    });
  }

  if (btState.mode === 'stock' && ctx.stock) {
    drawStockPageCharts();
    if (btState.metric && btState.metric !== 'nav') renderStockMetric(btState.metric);   // nav 就是上面那张大图，别再画一遍、也别滚屏
  }
  if (btState.mode === 'cmp' && ctx.compareRows) drawCompareChart();

  document.querySelectorAll('details.fold').forEach((d) => {
    d.addEventListener('toggle', () => {
      const ar = d.querySelector('.fold-arrow');
      if (ar) ar.textContent = d.open ? '收起 ▾' : '展开 ▸';
      if (!d.open) return;
      const id = d.dataset.fold;
      if (id === 'divhist' && ctx.port) drawDivChart(document.getElementById('divHist'), ctx.port.divByY);
      if (id === 'year') drawYearCharts();
      if (id === 'syear') drawStockYearCharts();
      if (id === 'sdiv') drawDivChart(document.getElementById('stDivChart'), ctx.stock?.divByY);
    });
  });
}

function drawStockPageCharts() {
  const r = ctx.stock;
  if (!r) return;
  // 净值曲线是重点，直接画；日 K 在折叠里，展开时才画（见 bindBacktest 的 toggle）
  drawNavChart(document.getElementById('stNav'), {
    // 回撤区必须走单位净值（剥离追加）：用总资产算，开了定投同页会出现两个「最大回撤」
    nav: r.nav, bench: r.bench, lowVol: r.lowVol, dd: drawdownOf(r.unitNav || r.nav),
    divByY: r.divByY, capital: btState.capital,
  });
  const wfEl = document.getElementById('wfChart');
  if (wfEl) drawWaterfall(wfEl, { capital: btState.capital, add: Math.max(0, r.totalIn - btState.capital), div: r.totalDiv, end: r.end });
  const klineFold = document.querySelector('[data-fold="kline"]');
  if (klineFold && klineFold.open) drawStockKline();
}

function drawStockKline() {
  const r = ctx.stock;
  if (!r) return;
  const daily = ctx.market.daily.get(btState.stock);
  const marks = [];
  for (const t of r.trades) {
    if (t.type === '建仓' || t.type === '定投') marks.push({ date: t.date, price: t.price, kind: 'buy', why: t.why });
    else if (t.type === '分红复投' || t.type === '分红') marks.push({ date: t.date, price: t.price, kind: 'div', why: t.why });
  }
  const candleRows = [];
  if (daily && daily.cal && daily.cal.length) {
    for (let i = 0; i < daily.cal.length; i++) {
      const d = daily.cal[i];
      if (d < clampFrom(btState.from) || d > btState.to) continue;
      if (daily.c[i] == null) continue;
      candleRows.push([d, daily.c[i]]);
    }
  } else {
    const s = ctx.market.series.get(btState.stock);
    for (const [d, c] of s.dates.map((d, i) => [d, s.closes[i]])) {
      if (d >= clampFrom(btState.from)) candleRows.push([d, c]);
    }
  }
  drawPriceChart(document.getElementById('stChart'), candleRows, { marks });
}

function drawStockManual(code) {
  const r = ctx.port;
  if (!r) return;
  const daily = ctx.market.daily.get(code);
  const rows = [];
  if (daily && daily.cal) {
    for (let i = 0; i < daily.cal.length; i++) {
      if (daily.c[i] == null) continue;
      rows.push([daily.cal[i], daily.c[i]]);
    }
  }
  const marks = r.events.filter((e) => e.type === '买入' && e.code === code).map((e) => ({ date: e.date, price: e.price, kind: 'buy', why: e.why }));
  drawPriceChart(document.getElementById('sdChart-' + code), rows, { marks, ma: [20] });
}

function renderStockMetric(key) {
  const box = document.getElementById('metricDetail');
  const r = ctx.stock;
  if (!box || !r) return;
  // 「期末」那张卡对应的就是上面的大图，别在下面再画一条一样的
  if (key === 'nav') {
    box.innerHTML = '';
    document.getElementById('stNav')?.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const perYearAdd = btState.monthlyAdd * 12;
  const navW = (arr) => arr.map(([d, v]) => [d, +(v / 10000).toFixed(1)]);
  const base = (title, note) => `<section class="panel"><div class="panel-head"><span class="panel-title">${title}</span><span class="section-note">${note}</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="msChart" class="chart" style="height:300px"></div></div></section>`;
  let html = '';
  let drawFn = null;
  if (key === 'fund') {
    html = base('累计投入', '本金 + 每次定投，逐笔累加');
    drawFn = () => {
      let acc = 0;
      const rows = r.nav.map(([d]) => [d, 0]);
      // 累计投入曲线：按交易把这笔钱加上去
      const byDate = new Map();
      for (const t of r.trades) {
        const amt = t.type === '建仓' ? btState.capital : t.type === '定投' ? t.amount : 0;
        if (amt > 0) byDate.set(t.date, (byDate.get(t.date) || 0) + amt);
      }
      acc = 0;
      const out = r.nav.map(([d]) => { acc += byDate.get(d) || 0; return [d, +(acc / 10000).toFixed(1)]; });
      drawMultiLineChart(document.getElementById('msChart'), [{ name: '累计投入(万)', rows: out, color: chartColors().buy }], { yFmt: (v) => v.toFixed(0) });
    };
  } else if (key === 'ann') {
    html = base('收益 vs 投入', '总资产 ÷ 累计投入 − 1');
    drawFn = () => {
      const byDate = new Map();
      for (const t of r.trades) {
        const amt = t.type === '建仓' ? btState.capital : t.type === '定投' ? t.amount : 0;
        if (amt > 0) byDate.set(t.date, (byDate.get(t.date) || 0) + amt);
      }
      let acc = 0;
      const out = r.nav.map(([d, v]) => { acc += byDate.get(d) || 0; return [d, acc > 0 ? +((v / acc - 1) * 100).toFixed(1) : 0]; });
      drawMultiLineChart(document.getElementById('msChart'), [{ name: '相对投入的盈亏%', rows: out, color: chartColors().nav }], { yFmt: (v) => v.toFixed(0) + '%' });
    };
  } else if (key === 'dd') {
    html = base('回撤（水下）', '距历史最高点');
    drawFn = () => drawMultiLineChart(document.getElementById('msChart'), [{ name: '回撤%', rows: drawdownOf(r.unitNav || r.nav), color: chartColors().dd }], { yFmt: (v) => v.toFixed(0) + '%' });
  } else if (key === 'div') {
    html = base('年度分红', '按除权除息日真实到账日复投，不够一手留现金');
    drawFn = () => drawDivChart(document.getElementById('msChart'), r.divByY);
  } else if (key === 'hold') {
    html = base('分红再投 vs 不复投', '同本金、同区间；不复投那份分红进现金');
    drawFn = () => drawMultiLineChart(document.getElementById('msChart'), [
      { name: '分红再投', rows: navW(r.nav), color: chartColors().nav },
      { name: '分红不复投', rows: navW(r.navHold || []), color: chartColors().buy, opacity: 0.85 },
    ], { yFmt: (v) => v.toFixed(0) });
  } else if (key === 'bench') {
    html = base('这只股票 vs 两条红利指数', `同本金、同${perYearAdd > 0 ? '定投节奏' : '区间'}`);
    drawFn = () => {
      const C = chartColors();
      const series = [
        { name: nameOf(r.code), rows: navW(r.nav), color: C.nav },
        { name: '中证红利全收益', rows: (r.bench?.rows || []).map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: C.bench },
      ];
      if (r.lowVol?.rows?.length) series.push({ name: '中证红利低波全收益', rows: r.lowVol.rows.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: C.lowvol });
      drawMultiLineChart(document.getElementById('msChart'), series, { yFmt: (v) => v.toFixed(0) });
    };
  } else if (key === 'payback') {
    html = base('回本进度', '累计分红 ÷ 本金，越过 100% 就是分红把本金还完了');
    drawFn = () => {
      let cum = 0;
      const rows = r.nav.map(([d]) => {
        const y = d.slice(0, 4);
        const hit = r.divByY?.[y];
        if (hit && d.slice(5, 10) >= '12-30') { cum += hit; }
        return [d, +((cum / Math.max(1, btState.capital)) * 100).toFixed(2)];
      });
      drawMultiLineChart(document.getElementById('msChart'), [{ name: '回本%', rows, color: chartColors().div }], {
        yFmt: (v) => v.toFixed(0) + '%',
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#65707e', opacity: 0.5 }, data: [{ yAxis: 100 }] },
      });
    };
  }
  box.innerHTML = html;
  // 后台标签页里 rAF 会被暂停，图就是空的（和弹层那次同一个坑）：rAF 只当加速，定时器兜底。
  if (drawFn) {
    let drawn = false;
    const run = () => { if (drawn) return; drawn = true; drawFn(); };
    requestAnimationFrame(() => setTimeout(run, 20));
    setTimeout(run, 160);
  }
}

function renderMetric(key) {
  const box = document.getElementById('metricDetail');
  if (!box) return;
  const p = ctx.port;
  if (!p) return;
  const capital = btState.portMode === 'replay' ? (p.nav[0]?.[1] || 1) : btState.capital;
  const nav = p.nav;
  let html = '';
  let drawFn = null;
  if (key === 'nav') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">总资产曲线</span><span class="section-note">持仓市值 + 现金（含分红）</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '总资产(万)', rows: nav.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().nav }], { yFmt: (v) => v.toFixed(0) + '万' });
  } else if (key === 'ann') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">累计收益</span><span class="section-note">(净值 ÷ 本金 − 1)</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '累计收益%', rows: nav.map(([d, v]) => [d, +((v / capital - 1) * 100).toFixed(1)]), color: chartColors().nav }], { yFmt: (v) => v.toFixed(0) + '%' });
  } else if (key === 'navR') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">分红不复投</span><span class="section-note">分红全部留现金、不再买入</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [
      { name: '复投(万)', rows: p.nav.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().nav },
      { name: '不复投(万)', rows: p.navR.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().sub, opacity: 0.8 },
    ], { yFmt: (v) => v.toFixed(0) });
  } else if (key === 'dd') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">回撤（水下）</span><span class="section-note">距历史最高点</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '回撤%', rows: p.dd, color: chartColors().dd }], { yFmt: (v) => v.toFixed(0) + '%' });
  } else if (key === 'fund' || key === 'net') {
    // 这两张卡以前没有 data-metric：外观和别的卡一样，点了不亮、不弹、不滚。
    const adds = (p.events || []).filter((e) => e.type === '追加' && e.amount > 0)
      .map((e) => [e.date, e.amount]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    let j = 0;
    let cum = capital;
    const inRows = [];
    const netRows = [];
    for (const [d, v] of nav) {
      while (j < adds.length && adds[j][0] <= d) { cum += adds[j][1]; j++; }
      inRows.push([d, +(cum / 10000).toFixed(1)]);
      netRows.push([d, +((v - cum) / 10000).toFixed(1)]);
    }
    if (key === 'fund') {
      html = `<section class="panel"><div class="panel-head"><span class="panel-title">累计投入</span><span class="section-note">本金 + 每次追加（按到账日累计）</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
      drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '累计投入(万)', rows: inRows, color: chartColors().buy }], { yFmt: (v) => v.toFixed(0) + '万' });
    } else {
      html = `<section class="panel"><div class="panel-head"><span class="panel-title">净赚金额</span><span class="section-note">净值 − 累计投入（负数就是还亏着）</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
      drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '净赚(万)', rows: netRows, color: chartColors().up }], { yFmt: (v) => v.toFixed(0) + '万' });
    }
  } else if (key === 'div') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">年度分红</span><span class="section-note">按真实除权除息日到账 · 柱 + 累计线</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawDivChart(document.getElementById('mChart'), p.divByY);
  } else if (key === 'repay') {
    const rows = repayCurve(p, nav, capital);
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">回本率</span><span class="section-note">累计分红 ÷ 本金 · 按真实除权除息日到账</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [{ name: '回本率%', rows, color: chartColors().div }], { yFmt: (v) => v.toFixed(0) + '%' });
  } else if (key === 'hold') {
    html = `<section class="panel"><div class="panel-head"><span class="panel-title">组合 vs 买入持有 vs 指数</span><span class="section-note">同一本金、同一区间</span></div><div class="panel-body" style="padding:8px 10px 4px"><div id="mChart" class="chart" style="height:300px"></div></div></section>`;
    drawFn = () => drawMultiLineChart(document.getElementById('mChart'), [
      { name: '我的组合', rows: nav.map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().nav },
      { name: '买入持有', rows: (ctx.holdNav || []).map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().buy, opacity: 0.85 },
      { name: '中证红利全收益', rows: (p.bench?.rows || []).map(([d, v]) => [d, +(v / 10000).toFixed(1)]), color: chartColors().bench, opacity: 0.9 },
    ], { yFmt: (v) => v.toFixed(0) });
  }
  box.innerHTML = html;
  // 后台标签页里 requestAnimationFrame 会被浏览器暂停：点了指标卡、图是空的，
  // 切回来也不会补——和弹层那次同一个坑（rAF 只当加速，兜底走定时器）。
  if (drawFn) {
    let drawn = false;
    const run = () => { if (drawn) return; drawn = true; drawFn(); };
    requestAnimationFrame(() => setTimeout(run, 20));
    setTimeout(run, 160);
  }
}

function drawYearCharts() {
  const p = ctx.port;
  if (!p) return;
  const capital = btState.portMode === 'replay' ? (p.nav[0]?.[1] || 1) : btState.capital;
  const nav = p.nav;
  const draws = {
    chYear: () => drawLineMini(document.getElementById('chYear'), nav.map(([d, v]) => [d, +((v / capital - 1) * 100).toFixed(2)]), { yFmt: (v) => v.toFixed(0) + '%', markLine: { silent: true, symbol: 'none', lineStyle: { color: '#65707e' }, data: [{ yAxis: 0 }] } }),
    chDiv: () => drawDivChart(document.getElementById('chDiv'), p.divByY),
    chRepay: () => {
      // 按引擎记的真实分红到账日累加（不假设 4 月末，也不做年度阶梯）
      const rows = repayCurve(p, nav, capital);
      drawLineMini(document.getElementById('chRepay'), rows, { yFmt: (v) => v.toFixed(0) + '%', color: chartColors().div });
    },
    chCash: () => {
      const rows = p.comp.map(([d, row]) => {
        const total = Object.values(row).reduce((s, v) => s + v, 0);
        return [d, +(total > 0 ? (row.cash / total) * 100 : 0).toFixed(1)];
      });
      drawLineMini(document.getElementById('chCash'), rows, { yFmt: (v) => v.toFixed(0) + '%', color: '#5b9cf5' });
    },
    chVsIdx: () => {
      const years = p.yearly.filter((y) => y.nav1 > 0);
      const benchYearly = {};
      for (const [d, v] of ctx.benchRows) {
        const y = d.slice(0, 4);
        if (!benchYearly[y]) benchYearly[y] = { f: v, l: v };
        benchYearly[y].l = v;
      }
      drawBarsVs(document.getElementById('chVsIdx'),
        years.map((y) => y.year),
        years.map((y) => +(((y.nav1 / y.nav0 - 1) * 100)).toFixed(1)),
        years.map((y) => (benchYearly[y.year] ? +(((benchYearly[y.year].l / benchYearly[y.year].f - 1) * 100)).toFixed(1) : null)));
    },
  };
  for (const k of Object.keys(draws)) {
    if (document.getElementById(k)) draws[k]();
  }
}

function drawCompareChart() {
  const rows = ctx.compareRows || [];
  const lines = rows.map((x) => ({
    name: x.name,
    rows: x.nav.map(([d, v]) => [d, +(v / 10000).toFixed(1)]),
    color: x.color,
    width: x.width || 1.4,
  }));
  drawMultiLineChart(document.getElementById('cmpChart'), lines, { yFmt: (v) => v.toFixed(0) + '万' });
}
