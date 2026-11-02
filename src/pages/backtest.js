/**
 * 回测页：组合回测 / 个股回测 / 组合对比（三个 tab，共用同一套日 K + 月线数据）。
 *
 * 数据口径：日 K 不复权（2018-07 起，2000 根交易日），更早区间用月线月末补齐；
 * 分红只有一个来源：data/div/<code>.json 的 ev（每笔真实除权除息日 + 每股派息），按当天收盘价复投。
 * 没有 ev 的股票在回测里一律不计分红——不猜日期、不编「4 月末」。不含税、不含佣金。
 */
import { icon } from '../ui/icons.js';
import { bigMoney, esc, num, pct, pctSign, upDown } from '../ui/format.js';
import { ddReport, maxDrawdown, monthEnd, priceAt } from '../engine/market.js';
import { runPortfolioBacktest } from '../engine/portfolioBacktest.js';
import { db, ensureDividends, loadCmpFin, loadCmpScreen, loadMonthlyFor, loadPool, nameOf } from '../data.js';
import { loadPlans, loadSettings } from '../store.js';
import { entryLabel } from '../engine/plan.js';
import { runInvestBacktest } from '../engine/stockBacktest.js';
import { stockMeta } from '../ui/stockSearch.js';
import { chartColors } from '../charts.js';
import { runPlanBacktest } from '../engine/backtest.js';
import { divSectionStock, flowTable, fold, hero, investRules, metricGrid, modeTabs, paramBar, rulesCard, stockCards, strategyPanel, yearSection, yearSectionStock } from './backtest/view.js';
import { addYears, benchRows, btState, buyHoldNav, cashPctOf, clampFrom, ctx, currentPortfolioPercentile, dailyStart, estimateAnnualDiv, loadMarket, lowVolRows, readBtUrl, setCtx, similarStates, structure, todayStr, winYears } from './backtest/core.js';

/* 页面路由与其它页要用的入口：拆分后仍从这里取，调用方不用改。 */
export { btState, setBacktestRerender, setCtx, setCompTimer } from './backtest/core.js';
export { bindBacktest } from './backtest/view.js';

function ddPanel(r, s, structureData) {
  const eps = (Array.isArray(r.episodes) ? r.episodes : []).slice().sort((a, b) => a.depth - b.depth);
  if (!eps.length) return '';
  const worst = eps[0];
  const dp = (d) => `${d.slice(2, 4)}-${d.slice(5, 7)}`;
  const upDays = worst.upDays;
  const downDays = worst.downDays;
  const fill = worst.fill;
  const ddDiv = worst.divReal || 0;
  const deeper = eps.filter((e) => e.depth <= -0.15);
  const holdings = (structureData.holdings || []).length;
  const benchMdd = s.benchMdd;

  // 集中度：同一套选股规则，持 1 只 −51.7% / 3 只 −40.0% / 5 只 −24.3% / 8 只 −24.1% / 15 只 −24.1%
  // 5 只是拐点：过了它，剩下的回撤是大盘给的，再分散也不会更抗跌
  const concWarn = holdings > 0 && holdings < 5
    ? `<div class="dd-warn">${icon('alert')}<div>现在只有 <b>${holdings}</b> 只股票。同样一套选股规则：持 1 只回撤 −51.7%、3 只 −40.0%、<b>5 只就已经降到 −24.3%</b>（8 只 −24.1%、15 只 −24.1）——5 只是拐点，过了它剩下的回撤归大盘管，不归你选股管。</div></div>`
    : '';

  // 分红填坑进度条：0–100%，超过 40% 就算「这轮跌得值」
  const barW = fill == null ? 0 : Math.max(1, Math.min(100, fill * 100));

  // 列表只放「其它几次」——最惨那次已经是大数字，不重复
  const others = deeper.slice(1, 5);
  const rows = others.map((e) => `
    <div class="dd-row">
      <b class="num ddc">${pct(e.depth * 100, 1)}</b>
      <span class="dd-when">${esc(dp(e.peak))} → ${esc(dp(e.trough))}</span>
      <span class="dd-fix ${e.ongoing ? 'down' : ''}">${e.ongoing ? '还没爬回来' : `修复 ${num(e.upDays / 30.4, 1)} 个月`}</span>
    </div>`).join('');

  // 填坑率按档说话：13% 说成「真正抗跌」是自欺欺人
  const fillPct = fill == null ? null : fill * 100;
  let verdict = '';
  if (fillPct == null) verdict = '';
  else if (fillPct >= 20) verdict = `跌的时候现金一直在进来——红利抗跌最大的底牌就是这个。`;
  else if (fillPct >= 10) verdict = `分红只填掉 ${fillPct.toFixed(0)}%，不多。但这一跌快两年，钱一直在进账，等于逼你别在最低点割。`;
  else verdict = `这一轮分红几乎没帮上忙——红利股一年也就发一两次钱，短期急跌指望分红补是不现实的，能救你的只有分散和仓位。`;
  if (benchMdd != null && s.mdd < 0) {
    const better = s.mdd - benchMdd;
    verdict += better > 0
      ? ` 同期中证红利全收益回撤 ${pct(benchMdd * 100, 1)}，组合少跌 <b class="num up">${(better * 100).toFixed(1)}pp</b>。`
      : ` 同期中证红利全收益回撤 ${pct(benchMdd * 100, 1)}，组合多跌 <b class="num down">${(-better * 100).toFixed(1)}pp</b>——这轮持仓没吃到红利那股抗跌的劲。`;
  }
  const cashNote = s.mddCash != null && Math.abs(s.mddCash - s.mdd) > 0.005
    ? `回撤按剥离追加后的净值算（含追加会虚低到 ${pct(s.mddCash * 100, 1)}）`
    : '';

  return `
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">回撤体检</span><span class="section-note">${cashNote || '跌了多少 · 分红补了多少 · 多久爬回来'}</span></div>
    <div class="panel-body" style="padding:14px">
      ${concWarn}
      <div class="dd-hero">
        <div class="dd-k">最深回撤</div>
        <div class="dd-v num">${pct(worst.depth * 100, 1)}</div>
        <div class="dd-s">${esc(worst.peak)} 见顶 → ${esc(worst.trough)} 见底 · 跌了 <b>${num(downDays / 30.4, 1)} 个月</b>${worst.ongoing ? '，<b class="down">现在还在水下</b>' : `，<b>${num(upDays / 30.4, 1)} 个月</b>才爬回前高`}</div>
      </div>
      <div class="dd-fill">
        <div class="dd-fh"><span>跌的时候分红填掉</span><b class="num gold">${fill == null ? '—' : (fill * 100).toFixed(0) + '%'}</b></div>
        <div class="dd-bar"><i style="width:${barW.toFixed(1)}%"></i></div>
        <div class="dd-fs">期间到账 <b class="num divc">${bigMoney(ddDiv)}</b>，全拿去再投</div>
      </div>
      ${rows ? `<div class="dd-list"><div class="dd-lh">历史上跌超 15% 的一共 ${deeper.length} 次 · 最深那次就是上面那个数</div>${rows}</div>` : ''}
      ${verdict ? `<div class="dd-note">${verdict}</div>` : ''}
    </div>
  </section>`;
}

function stockDdPanel(r, st, name) {
  const eps = (Array.isArray(r.episodes) ? r.episodes : []).slice().sort((a, b) => a.depth - b.depth);
  if (!eps.length) return '';
  const worst = eps[0];
  const dp = (d) => `${d.slice(2, 4)}-${d.slice(5, 7)}`;
  const fill = worst.fill;
  const deeper = eps.filter((e) => e.depth <= -0.15);
  const others = deeper.slice(1, 5);
  const barW = fill == null ? 0 : Math.max(1, Math.min(100, fill * 100));
  const rows = others.map((e) => `
    <div class="dd-row">
      <b class="num ddc">${pct(e.depth * 100, 1)}</b>
      <span class="dd-when">${esc(dp(e.peak))} → ${esc(dp(e.trough))}</span>
      <span class="dd-fix ${e.ongoing ? 'down' : ''}">${e.ongoing ? '还没爬回来' : `修复 ${num(e.upDays / 30.4, 1)} 个月`}</span>
    </div>`).join('');

  const benchMdd = st.benchMdd;
  const gap = benchMdd != null ? worst.depth - benchMdd : null;
  let verdict = '';
  if (gap != null) {
    verdict = `同一段行情，中证红利全收益跌 ${pct(benchMdd * 100, 1)}，${esc(name)} 跌 ${pct(worst.depth * 100, 1)}，多跌 <b class="num down">${(-gap * 100).toFixed(1)}pp</b>。单只股票内部无从分散——要压回撤，只有「多买几只」和「少买一点」两条路，选股本身救不了你。`;
  } else {
    verdict = `单只股票的回撤没法靠内部消化，只能靠仓位和别的股票分摊。`;
  }
  const cashNote = st.mddCash != null && Math.abs(st.mddCash - st.mdd) > 0.005
    ? `回撤按剥离定投后的净值算（含定投会虚低到 ${pct(st.mddCash * 100, 1)}）`
    : '';

  return `
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">回撤体检</span><span class="section-note">${cashNote || '跌了多少 · 分红补了多少 · 多久爬回来'}</span></div>
    <div class="panel-body" style="padding:14px">
      <div class="dd-hero">
        <div class="dd-k">最深回撤</div>
        <div class="dd-v num">${pct(worst.depth * 100, 1)}</div>
        <div class="dd-s">${esc(worst.peak)} 见顶 → ${esc(worst.trough)} 见底 · 跌了 <b>${num(worst.downDays / 30.4, 1)} 个月</b>${worst.ongoing ? `，<b class="down">到现在还没爬回来（还差 ${pct(Math.abs((worst.nowDepth || 0) * 100), 1)}）</b>` : `，<b>${num(worst.upDays / 30.4, 1)} 个月</b>才爬回前高`}</div>
      </div>
      <div class="dd-fill">
        <div class="dd-fh"><span>跌的时候分红填掉</span><b class="num divc">${fill == null ? '—' : (fill * 100).toFixed(0) + '%'}</b></div>
        <div class="dd-bar"><i style="width:${barW.toFixed(1)}%"></i></div>
        <div class="dd-fs">期间到账 <b class="num divc">${bigMoney(worst.divReal || 0)}</b>，按除息日当天买回</div>
      </div>
      ${rows ? `<div class="dd-list"><div class="dd-lh">历史上跌超 15% 的一共 ${deeper.length} 次 · 最深那次就是上面那个数</div>${rows}</div>` : ''}
      <div class="dd-note">${verdict}</div>
    </div>
  </section>`;
}

function renderPort(market, structureData) {
  const { dates, series } = market;
  const displayPlan = !structureData.plan && !structureData.fallback;
  const from = clampFrom(btState.from);
  const to = btState.to;
  const useReplay = btState.portMode === 'replay' && !structureData.plan;
  const startValue = structureData.cash + structureData.lots.reduce((s, l) => s + l.shares * (priceAt(series.get(l.code), dates[0]) || 0), 0);
  const capital = useReplay ? startValue : btState.capital;
  const r = runPortfolioBacktest({
    dates,
    series,
    dividends: db.baseline.dividends || {},
    holdings: structureData.holdings,
    capital: capital || 1000000,
    monthlyAdd: btState.monthlyAdd,
    from,
    to,
    mode: useReplay ? 'replay' : 'invest',
    lots: structureData.lots,
    cash0: useReplay ? structureData.cash : 0,
    entry: structureData.entry || { mode: 'once' },
    benchmarkSeries: ctx.benchRows,
    lowVolSeries: ctx.lowVolRows,
  });
  ctx.port = r;
  ctx.holdNav = buyHoldNav(dates, series, structureData.holdings, capital || 1000000, db.baseline.dividends || {});
  ctx.nav = r.nav;
  const s = r.stats;
  const hasAdd = r.totalIn > capital;
  const divEst = estimateAnnualDiv(structureData.holdings, series, dates[dates.length - 1], r.end);
  // 月支出必须 ≥100 元：旧版设置可能存了负数/0，不再静默兜成 1（会算出 65 万 % 这种荒谬结论）
  const expenseRaw = Number(loadSettings().expense);
  const expenseOk = Number.isFinite(expenseRaw) && expenseRaw >= 100 && expenseRaw <= 1e7;
  const expense = expenseOk ? expenseRaw : 4000;
  const cov = (divEst / 12 / expense) * 100;
  const avgPct = currentPortfolioPercentile(structureData.holdings.map((h) => h.code), market.months);
  const retBase = hasAdd ? s.retFund || 0 : s.ret;
  const retTxt = pctSign(retBase * 100, 1);
  const vc = retBase >= 0 ? 'up' : 'down';
  const excess = s.excess != null ? s.excess * 100 : null;
  const totalDiv = r.totalDiv;
  const yearly = r.yearly;
  const cashNow = r.cashEnd;
  const divCagr = (() => {
    const ds = yearly.filter((y) => y.div > 0).map((y) => y.div);
    if (ds.length < 2 || ds[0] <= 0) return null;
    return (Math.pow(ds[ds.length - 1] / ds[0], 1 / (ds.length - 1)) - 1) * 100;
  })();
  const sim = similarStates(market, structureData.holdings.map((h) => h.code), r.nav, from, to);

  const cards = [
    { k: '总市值', v: bigMoney(r.end), cls: 'gold', s: `现金 ${bigMoney(cashNow)} · 仓位 ${((1 - cashNow / (r.end || 1)) * 100).toFixed(0)}%`, key: 'nav', on: btState.metric === 'nav' },
    { k: useReplay ? '起点市值' : '累计投入', v: bigMoney(r.totalIn), cls: 'fund', s: hasAdd ? `本金 ${bigMoney(capital)} + 追加 ${bigMoney(r.totalIn - capital)}` : (useReplay ? '当前股数 × 起点价 + 现金' : '起点本金'), key: 'fund', on: btState.metric === 'fund' },
    { k: '净赚金额', v: bigMoney(r.end - r.totalIn), cls: upDown(r.end - r.totalIn), s: `期末 ${bigMoney(r.end)} − 投入 ${bigMoney(r.totalIn)}`, key: 'net', on: btState.metric === 'net' },
    { k: '年化', v: pctSign(s.cagr == null ? null : s.cagr * 100, 1), cls: vc, s: `${num(s.years, 1)} 年 · ${hasAdd ? 'XIRR' : '复利'}`, key: 'ann', on: btState.metric === 'ann' },
    { k: '红利不复投', v: bigMoney(r.endR), cls: 'fund', s: `年化 ${pctSign(s.cagrR == null ? null : s.cagrR * 100, 1)}`, key: 'navR', on: btState.metric === 'navR' },
    { k: '最大回撤', v: pct(s.mdd * 100, 1), cls: 'ddc', s: `${esc(s.mddPeak)} → ${esc(s.mddTrough)}`, key: 'dd', on: btState.metric === 'dd' },
    { k: '年分红(估)', v: bigMoney(divEst), cls: 'divc', s: '当前持仓 × 最新年度每股分红', key: 'div', on: btState.metric === 'div' },
    { k: '月覆盖', v: expenseOk ? (cov > 999 ? '>999%' : cov.toFixed(0) + '%') : '—', s: expenseOk ? `年分红 ÷ 12 ÷ 月支出 ${expense.toLocaleString('zh-CN')}` : '月支出设置无效（需 100 元–1000 万/月），请到「我的 → 设置」修正', key: 'repay', on: btState.metric === 'repay' },
    { k: 'vs 指数', v: excess == null ? '—' : (excess >= 0 ? '+' : '') + excess.toFixed(1) + 'pp', cls: upDown(excess), s: 'vs 中证红利全收益 年化', key: 'hold', on: btState.metric === 'hold' },
  ];

  return `
  ${paramBar({ useMktCap: !useReplay })}
  ${(r.divMissing || []).length ? `<div class="banner" style="margin-bottom:12px">${icon('alert')}<div><b>${r.divMissing.length} 只股票没取到派息明细</b>（${r.divMissing.map(esc).join('、')}）——它们在本次回测里不计分红，不猜除权日。</div></div>` : ''}
  ${hero({
    kicker: `组合回测 · ${structureData.name || '当前持仓'} · ${useReplay ? '持仓回放（当前股数）' : '投入回测'}${structureData.plan ? ' · ' + entryLabel(structureData.entry) : ''} · ${from} → ${to} · ${num(s.years, 1)} 年`,
    main: `组合 <b class="num gold">${retTxt}</b> <span class="thin">，年化 ${pctSign(s.cagr == null ? null : s.cagr * 100, 1)}</span>`,
    desc: `期末 ${bigMoney(r.end)}（${useReplay ? '起点' : '投入'} ${bigMoney(r.totalIn)}）· 总分红 ${bigMoney(totalDiv)} · ${structureData.plan ? '方案「' + esc(structureData.name) + '」· 现金 ' + structureData.cashPct.toFixed(0) + '%' : structureData.fallback ? '账本为空，按演示持仓等权' : '市值权重（股 ' + (100 - cashPctOf(structureData)).toFixed(0) + '% + 现金 ' + cashPctOf(structureData).toFixed(0) + '%）'}`,
    stats: [
      { k: '累计收益', v: retTxt, cls: vc, s: hasAdd ? '扣追加资金' : '起点本金' },
      { k: '年化', v: pctSign(s.cagr == null ? null : s.cagr * 100, 1), cls: vc, s: hasAdd ? 'XIRR 资金加权' : '复利折算' },
      { k: '最大回撤', v: pct(s.mdd * 100, 1), cls: 'ddc', s: `基准 ${pct(s.benchMdd == null ? null : s.benchMdd * 100, 1)}` },
      { k: '总分红', v: bigMoney(totalDiv), cls: 'gold', s: divCagr == null ? '—' : '增速 ' + pctSign(divCagr, 1) + '/年' },
    ],
  })}
  ${(r.builds && r.builds.length) || (r.pending && r.pending.length) ? `<div class="bt-buildnote">${(r.builds || []).map((b) => `<div>🏗 <b>${esc(nameOf(b.code))}</b> ${esc(b.date)} 建仓 ${num(b.shares, 0)} 股 @ ${num(b.price, 2)}（初始份额 × 期间组合增长；建仓前份额摊给已上市持仓）</div>`).join('')}${(r.pending || []).map((p) => `<div>⏳ <b>${esc(nameOf(p.code))}</b> 期末仍未建仓：${esc(p.reason)}${p.weight ? '（目标 ' + num(p.weight, 1) + '%）' : ''}</div>`).join('')}</div>` : ''}
  ${metricGrid(cards)}
  <div id="metricDetail" style="margin-top:12px"></div>
  ${ddPanel(r, s, structureData)}
  ${displayPlan ? `<div class="row" style="gap:8px;margin-top:10px;align-items:center"><button class="btn sm ghost" id="btSavePlan">把当前结构存为方案</button><span class="bt-hint">存的是「代码 + 目标权重」，可切回对比</span></div>` : ''}

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">组合状态总览</span><span class="section-note">红=组合 · 金=不复投 · 蓝=中证红利全收益 · 紫=红利低波</span></div>
    <div class="panel-body" style="padding:8px 10px 2px">
      <div class="bt-mini-stats">
        <div><div class="k">累计收益</div><div class="v num ${vc}">${retTxt}</div></div>
        <div><div class="k">当前回撤</div><div class="v num">${pct(r.dd.at(-1)?.[1] ?? 0, 1)}</div></div>
        <div><div class="k">组合分位</div><div class="v num">${avgPct == null ? '—' : avgPct.toFixed(0) + '%'}</div></div>
        <div><div class="k">历史分红</div><div class="v num gold">${bigMoney(totalDiv)}</div></div>
      </div>
      <div id="portChart" class="chart" style="height:560px"></div>
      <div class="bt-hint" style="padding:4px 4px 8px">主图：组合复投 / 红利不复投 / 两条全收益指数 · 中段：回撤 · 下段：年度分红柱 + 增速</div>
    </div>
  </section>

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">持仓构成（精确到天）</span><span class="section-note">滑轨 / 播放看每天的钱在哪</span></div>
    <div class="panel-body" style="padding:10px">
      <div class="bt-comp">
        <div id="compDonut" class="chart" style="width:200px;height:200px;flex:0 0 200px"></div>
        <div style="flex:1;min-width:240px">
          <div id="compDate" class="comp-date">—</div>
          <div id="compList" class="comp-list"></div>
          <div class="bt-slider">
            <span class="bt-hint">滑轨</span>
            <input id="compRange" type="range" min="0" max="100" step="1" value="100">
            <button class="btn sm ghost" id="compPlay">播放 ▶</button>
          </div>
        </div>
      </div>
    </div>
  </section>

  ${fold('divhist', '分红（组合现金流）', `总分红 <b class="num gold">${bigMoney(totalDiv)}</b> · 年均 ${bigMoney(totalDiv / Math.max(1, yearly.length))} · 增速 ${divCagr == null ? '—' : pctSign(divCagr, 1) + '/年'} · 分红率 ${pct((totalDiv / Math.max(1, r.totalIn)) * 100, 1)} · 回本 ${pct((totalDiv / Math.max(1, capital)) * 100, 0)}`, '<div id="divHist" class="chart" style="height:280px"></div>')}

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">钱从哪来：收益拆解</span><span class="section-note">本金 → 分红 → 价格 → 期末</span></div>
    <div class="panel-body" style="padding:8px 10px 6px"><div id="wfChart" class="chart" style="height:220px"></div></div>
  </section>

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">什么时候该信规则：分环境对比</span><span class="section-note">我的组合 vs 中证红利全收益 · 同区间涨跌幅</span></div>
    <div class="panel-body" style="padding:8px 10px 6px"><div id="envChart" class="chart" style="height:220px"></div></div>
  </section>

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">我现在该怎么做：历史相似状态</span><span class="section-note">组合平均股息率分位接近当下时，其后 12 个月发生了什么</span></div>
    <div class="panel-body" style="padding:8px 10px 8px">
      <div id="nowChart" class="chart" style="height:220px"></div>
      <div id="nowTip" class="banner" style="margin-top:10px;font-size:11px;display:block;line-height:1.7">${sim.tip}</div>
    </div>
  </section>

  ${fold('year', '年度数据', '累计收益 / 分红 / 回本 / 现金占比 / 年度收益 · 5 图 + 7 列明细', yearSection(r))}
  ${fold('stocks', `个股明细（${structureData.holdings.length} 只）`, '占比 / 市值 / 分红 / 买点 · 展开看日 K', stockCards(r, structureData, market))}
  ${fold('flow', '交易流水', `${r.events.length} 笔 · 每笔带依据`, flowTable(r.events))}
  ${fold('rules', '本次回测规则', '8 条 · 可审计', rulesCard())}
  <div id="simData" data-json="${esc(JSON.stringify(sim.points))}" data-cur="${sim.cur == null ? '' : sim.cur.toFixed(1)}" data-med="${sim.median == null ? '' : sim.median.toFixed(1)}" style="display:none"></div>
  `;
}

function renderStockPage(market, structureData) {
  const code = btState.stock;
  const s = market.series.get(code);
  if (!s || !s.dates.length) {
    return `${paramBar({ tabs: false, stock: true })}<div class="banner">${esc(code)} 没有日线数据（可能退市/停牌）</div>`;
  }
  /* 个股回测不判断买卖点：本金第一天全买，之后按时定投，分红当天再投。
     不设股息率门槛、不看财报、不因为分红下调卖出。 */
  const r = runInvestBacktest({
    code,
    dates: market.dates,
    series: s,
    dividends: db.baseline.dividends || {},
    capital: btState.capital,
    monthlyAdd: btState.monthlyAdd,
    benchmarkSeries: ctx.benchRows,
    lowVolSeries: ctx.lowVolRows,
    from: clampFrom(btState.from),
    to: btState.to,
  });
  ctx.stock = r;
  const st = r.stats;
  const vc = st.cagr >= 0 ? 'up' : 'down';
  const perYearAdd = btState.monthlyAdd * 12;
  // 开了定投还用「期末 ÷ 本金」算收益，等于把追加的钱算成赚的（组合页早就改用 retFund）。
  const hasAdd = r.totalIn > btState.capital;
  const retBase = hasAdd ? (st.retFund ?? st.ret) : st.ret;
  const meta = stockMeta(code);
  const divTrades = r.trades.filter((t) => t.type === '分红复投' || t.type === '分红');
  const divRate = r.totalIn > 0 ? (r.totalDiv / r.totalIn) * 100 : null;
  const y0 = Number(String(clampFrom(btState.from)).slice(0, 4));
  const payYear = st.paybackYear == null ? null : st.paybackYear - y0 + 1;
  const divYears = Object.keys(r.divByY || {}).filter((y) => r.divByY[y] > 0).length;
  return `
  <section class="sym-bar fade-in">
    <div class="sym-main">
      <div class="sym-title">
        <b class="sym-name">${esc(nameOf(code))}</b>
        <span class="sym-code">${esc(code)}</span>
        ${meta && meta.ind ? `<span class="sym-tag">${esc(meta.ind)}</span>` : ''}
      </div>
      <div class="sym-meta">日 K 自 ${esc(dailyStart())} · 行情 ${esc(todayStr())} · 不复权 · 分红 ${divTrades.length} 笔</div>
    </div>
    <div class="sym-pick">
      <div class="stock-search">${icon('search')}<input id="stSearch" placeholder="换一只：代码 / 名称" autocomplete="off" spellcheck="false"></div>
      <div id="stSuggest" class="search-suggest" hidden></div>
    </div>
  </section>

  ${paramBar({ tabs: false, stock: true })}

  ${st.divMissing ? `<div class="banner" style="margin-bottom:12px">${icon('alert')}<div><b>没取到 ${esc(nameOf(code))}（${esc(code)}）的派息明细</b>　可能是数据源里查不到它的除权除息日，也可能是这次没联上——<b>本次回测一分分红都没算</b>，不猜日子。分红那几张图是空的，不代表它不分红。</div></div>` : ''}
  ${hero({
    kicker: `个股定投 · ${esc(nameOf(code))} ${esc(code)} · ${clampFrom(btState.from)} → ${btState.to}`,
    main: `${bigMoney(r.totalIn)} <span class="thin">→</span> <b class="num gold">${bigMoney(r.end)}</b><span class="thin">，年化 ${pctSign(st.cagr == null ? null : st.cagr * 100, 1)}</span>`,
    chips: [
      { t: '不判买卖点' },
      { t: perYearAdd > 0 ? `每月追 ${bigMoney(btState.monthlyAdd)}` : '不再追加' },
      { t: '分红当天再投' },
      { t: '卖出 0 次' },
      { t: `vs 红利 ${pctSign(st.excess == null ? null : st.excess * 100, 1)}`, cls: 'bench' },
      { t: `vs 低波 ${pctSign(st.excessLowVol == null ? null : st.excessLowVol * 100, 1)}`, cls: 'lowvol' },
    ],
    stats: [
      { k: '累计收益', v: pctSign(retBase == null ? null : retBase * 100, 1), cls: vc, s: `${num(st.years, 1)} 年 · ${hasAdd ? '扣除追加' : '本金口径'}` },
      { k: '年化', v: pctSign(st.cagr == null ? null : st.cagr * 100, 1), cls: vc, s: perYearAdd > 0 ? 'XIRR 资金加权' : '复利折算' },
      { k: '最大回撤', v: pct(st.mdd * 100, 1), cls: 'ddc', s: `${esc(st.mddPeak)} → ${esc(st.mddTrough)}` },
      { k: '分红', v: bigMoney(r.totalDiv), cls: 'divc', s: `全部再投，滚了 ${st.reinvest} 次` },
    ],
  })}

  ${stockDdPanel(r, st, nameOf(code))}

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">净值曲线</span><span class="section-note">终值 <b style="color:var(--c-nav)">${num(st.navLast, 2)}</b> · <b style="color:var(--c-bench)">${num(st.benchLast, 2)}</b> · <b style="color:var(--c-lowvol)">${num(st.lowVolLast, 2)}</b>　|　中段回撤 · 下段每年分红</span></div>
    <div class="panel-body" style="padding:8px 10px 4px"><div id="stNav" class="chart chart-tall"></div></div>
  </section>

  ${metricGrid([
    { k: '期末', v: bigMoney(r.end), cls: 'gold', s: '持仓市值 + 零钱', key: 'nav', on: btState.metric === 'nav' || !btState.metric },
    { k: '累计投入', v: bigMoney(r.totalIn), cls: 'fund', s: perYearAdd > 0 ? `本金 + 定投 ${bigMoney(r.totalIn - btState.capital)}` : '只有本金', key: 'fund' },
    { k: '年化', v: pctSign(st.cagr == null ? null : st.cagr * 100, 1), cls: vc, s: perYearAdd > 0 ? 'XIRR 资金加权' : '复利折算', key: 'ann' },
    { k: '最大回撤', v: pct(st.mdd * 100, 1), cls: 'ddc', s: `${esc(st.mddPeak)} → ${esc(st.mddTrough)}`, key: 'dd' },
    { k: '分红', v: bigMoney(r.totalDiv), cls: 'divc', s: `再投 ${st.reinvest} 次，一分没取`, key: 'div' },
    { k: '买入持有', v: bigMoney(r.endHold), cls: 'fund', s: `年化 ${pctSign(st.cagrHold == null ? null : st.cagrHold * 100, 1)} · 分红不复投`, key: 'hold' },
    { k: '回本', v: payYear == null ? '还没' : `第 ${payYear} 年`, cls: payYear == null ? '' : 'divc', s: payYear == null ? `累计分红 ${pct(divRate, 0)} 本金` : `${st.paybackYear} 年分红盖过本金`, key: 'payback' },
    { k: 'vs 指数', v: pctSign(st.excess == null ? null : st.excess * 100, 1), cls: upDown(st.excess), s: `vs 红利 · 低波 ${pctSign(st.excessLowVol == null ? null : st.excessLowVol * 100, 1)}`, key: 'bench' },
  ])}
  <div id="metricDetail" style="margin-top:12px"></div>

  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">钱从哪来</span><span class="section-note">本金 + 分红到账 + 价格涨跌 = 期末</span></div>
    <div class="panel-body" style="padding:8px 10px 6px"><div id="wfChart" class="chart" style="height:220px"></div></div>
  </section>

  ${fold('kline', '日 K · 建仓 / 分红复投', `收盘线 + MA20/MA60 · 蓝▲建仓/定投 · 红◆分红复投（除权除息日当天买回）· 不卖，没有卖点`, '<div class="panel-body" style="padding:8px 10px 4px"><div id="stChart" class="chart" style="height:380px"></div></div>')}

  ${fold('syear', '年度数据', `${r.yearly.filter((y) => y.nav1 > 0).length} 年 · 累计收益 / 分红 / 回本率 / 年度 vs 指数 · 4 图 + 明细`, yearSectionStock(r))}

  ${fold('sdiv', '分红明细', `总分红 <b class="num divc">${bigMoney(r.totalDiv)}</b> · ${divTrades.length} 笔 · ${divYears} 个年度 · 增速 ${st.divCagr == null ? '—' : pctSign(st.divCagr * 100, 1) + '/年'} · 分红率 ${pct(divRate, 1)} · 回报本金 ${pct((r.totalDiv / Math.max(1, btState.capital)) * 100, 0)}`, divSectionStock(r))}

  ${fold('flow', '买入流水', `${r.trades.length} 笔 · 每一次买入的日期、股数、价格`, flowTable(r.trades))}
  ${fold('rules', '本次回测规则', '4 条 · 可审计', investRules())}`;
}

function renderCompare(market, structureData) {
  const from = clampFrom(btState.from);
  const to = btState.to;
  const rows = (ctx.compareRows || []).filter((x) => !x.empty);   // 没选出股票的组合不参与排名
  const bench = ctx.compareBench;
  const benchCagr = bench ? bench.cagr : null;
  const best = rows.length ? [...rows].sort((a, b) => b.end - a.end)[0] : null;
  const safest = rows.length ? [...rows].sort((a, b) => b.mdd - a.mdd)[0] : null;
  // 回撤条：同一个尺度上比，一眼看出谁跌得狠
  const maxMdd = Math.max(...rows.map((x) => Math.abs(x.mdd || 0)), 0.01);
  const table = rows.map((x) => {
    // 基准行不跟自己比：vs 指数、跑赢年数都留空
    const excess = x.isIndex ? null : (benchCagr != null && x.cagr != null ? (x.cagr - benchCagr) * 100 : null);
    const win = x.isIndex ? '—' : winYears(x.nav, bench?.rows);
    const barW = (Math.abs(x.mdd || 0) / maxMdd) * 100;
    // 回撤只给一个百分比不够：跌 -17% 半年回来，和跌 -27% 三年没回来，是两种人生
    // 注意：episodes 是按时间顺序的，第一段不是最深的
    const epsAll = ddReport(x.unitNav || x.nav || [], [], []);
    const worst = epsAll.length ? epsAll.reduce((a, b) => (b.depth < a.depth ? b : a)) : null;
    const fix = !worst ? ''
      : worst.ongoing ? `还没回来 · 差 ${Math.abs((worst.nowDepth || 0) * 100).toFixed(0)}%`
      : `${num(worst.upDays / 30.4, 0)} 个月修复`;
    return `<tr>
      <td class="name"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${x.color};margin-right:6px"></span>${esc(x.name)}</td>
      <td class="num">${bigMoney(x.end)}</td>
      <td class="num ${upDown(x.cagr)}">${pctSign(x.cagr == null ? null : x.cagr * 100, 1)}</td>
      <td class="num ddcell down" data-v="${pct(x.mdd * 100, 0)}"><i style="width:${barW.toFixed(1)}%"></i><span>${pct(x.mdd * 100, 0)}<em>${fix}</em></span></td>
      <td class="num">${x.div == null ? '—' : bigMoney(x.div)}</td>
      <td class="num ${upDown(excess)}">${excess == null ? '—' : (excess >= 0 ? '+' : '') + excess.toFixed(1) + 'pp'}</td>
      <td class="num">${win}</td>
    </tr>`;
  }).join('');
  return `
  ${paramBar({ tabs: false })}
  ${ctx.compareNote ? `<div class="banner" style="margin-bottom:12px">${icon('alert')}<div>${esc(ctx.compareNote)}</div></div>` : ''}
  <section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">组合对比</span><span class="section-note">同一本金 ${bigMoney(btState.capital)} · 同一区间 · 同一口径</span></div>
    <div class="panel-body" style="padding:10px 10px 4px">
      <div id="cmpChart" class="chart" style="height:380px"></div>
      <div class="bt-hint" style="padding:4px">每个方案按自己的目标权重复投；红利精选为每年 4 月末按规则选 15 只等权买入、持有一年不中途再平衡（分红按上一年度合计均摊 12 个月再投）；指数为全收益口径；曲线为月末净值</div>
    </div>
  </section>
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">指标对比</span><span class="section-note">期末 / 年化 / 最大回撤 / 分红 / vs 指数 / 跑赢年数</span></div>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>组合</th><th>期末</th><th>年化</th><th>最大回撤</th><th>总分红</th><th>vs 指数</th><th>跑赢年数</th></tr></thead>
      <tbody>${table}</tbody>
    </table></div>
  </section>
  ${strategyPanel()}
  <section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head"><span class="panel-title">结论</span><span class="section-note">谁在牛市更赚 · 谁在熊市更抗跌 · 分红谁更多</span></div>
    <div class="panel-body" style="padding:12px 14px 14px">
      <div class="cmp-winner">
        ${best ? `<div class="cw"><span class="k">历史最赚</span><b class="num gold">${esc(best.name)}</b><span class="s">${bigMoney(best.end)} · 年化 ${pctSign(best.cagr * 100, 1)}</span></div>` : ''}
        ${safest ? `<div class="cw"><span class="k">最抗跌</span><b class="num ddc">${esc(safest.name)}</b><span class="s">回撤 ${pct(safest.mdd * 100, 0)}</span></div>` : ''}
        ${bench ? `<div class="cw"><span class="k">中证红利全收益</span><b class="num bnc">${bigMoney(bench.end)}</b><span class="s">年化 ${pctSign(bench.cagr * 100, 1)}</span></div>` : ''}
      </div>
    </div>
  </section>`;
}

export async function renderBacktest() {
  readBtUrl();
  if (!btState.to) {
    btState.to = todayStr();
    btState.from = addYears(btState.to, -10);
  }
  const s = structure();
  // 组合对比要从全市场里选股（红利策略那一行），没有股票池就一个也选不出来，
  // 以前这里没调 loadPool，pool 是空的 → 策略静默变成空组合 → 99.9 万 / -0.0%。
  if (btState.mode === 'cmp') await loadPool();
  const planCodes = btState.mode === 'cmp' ? loadPlans().flatMap((p) => (p.holdings || []).map((h) => h.code)) : [];
  const codes = [...new Set([...s.holdings.map((h) => h.code), ...planCodes, btState.stock])];
  // 只拉当前组合/方案里那几只的分红；组合增删改后再进来，这里会补下新增那几只
  await ensureDividends(codes);
  const needFinance = btState.mode === 'stock' && btState.quality;
  const market = await loadMarket(codes, clampFrom(btState.from), btState.to, {
    finance: needFinance,
    monthly: 'auto',
    marketWide: btState.mode === 'cmp',
    stockCode: btState.mode === 'stock' ? btState.stock : null,
  });
  const bench = benchRows(market.index, db.benchmark, clampFrom(btState.from), btState.to);
  const lv = lowVolRows(market.index, clampFrom(btState.from), btState.to);
  setCtx({ market, structure: s, benchRows: bench, lowVolRows: lv });

  let body = '';
  if (btState.mode === 'stock') {
    body = renderStockPage(market, s);
  } else if (btState.mode === 'cmp') {
    // 勾了哪几个方案才画哪几个（btState.cmpPlans === null 表示全选）
    const want = (id) => !btState.cmpPlans || btState.cmpPlans.includes(id);
    const plans = [{ id: 'current', name: s.name || '当前持仓', holdings: s.holdings, lots: s.lots, cash: s.cash }];
    for (const p of loadPlans()) {
      if (p.id === btState.planId) continue;
      if (!want(p.id)) continue;
      plans.push({ id: p.id, name: p.name, holdings: p.holdings.map((h) => ({ code: h.code, weight: Number(h.weight) || 0 })), lots: [], cash: 0 });
    }
    if (btState.planId !== 'current' && want(btState.planId)) {
      const hit = loadPlans().find((p) => p.id === btState.planId);
      if (hit) plans.unshift({ id: hit.id, name: hit.name, holdings: hit.holdings.map((h) => ({ code: h.code, weight: Number(h.weight) || 0 })), lots: [], cash: 0 });
    }
    const uniqPlans = [];
    const seen = new Set();
    for (const p of plans) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      uniqPlans.push(p);
    }
    // 方案色：第 1 个是当前持仓，用「净值红」当主角；其余避开语义色（红/青/紫），
    // 免得跟两条指数搅在一起。红利策略单独用「辅助金」——它是规则不是持仓。
    const CC = chartColors();
    const COLORS = [CC.nav, '#5b9cf5', '#35b57a', '#f783ac', '#22b8cf', '#a3e635', '#f9a8a8'];
    const rows = [];
    const b0 = runPortfolioBacktest({
      dates: market.dates, series: market.series, dividends: db.baseline.dividends || {},
      holdings: uniqPlans[0].holdings, capital: btState.capital, monthlyAdd: btState.monthlyAdd,
      from: clampFrom(btState.from), to: btState.to, mode: 'invest',
      benchmarkSeries: bench, lowVolSeries: lv,
    });
    uniqPlans.forEach((p, i) => {
      const r = i === 0 ? b0 : runPortfolioBacktest({
        dates: market.dates, series: market.series, dividends: db.baseline.dividends || {},
        holdings: p.holdings, capital: btState.capital, monthlyAdd: btState.monthlyAdd,
        from: clampFrom(btState.from), to: btState.to, mode: 'invest',
      });
      rows.push({ kind: 'plan', name: p.name, color: COLORS[i % COLORS.length], nav: r.nav, unitNav: r.unitNav, end: r.end, cagr: r.stats.cagr, mdd: r.stats.mdd, div: r.totalDiv, width: 2 });
    });
    // 红利策略：选股用「每年 4 月末收盘价」（cmp-yearly，78KB）跑一遍，
    // 拿到 10 年选中的成分股，再只拉这几十只的完整月线（每只 2.3KB）算净值。
    // 这样净值/回撤是月频精确的，而不用下 6.4MB 全市场月线。
    // 高稳定分红模型（研究见 tools/research/README.md）：
    // 连续分红 5 年 + 派息率 10–80% + 股息率 4–8% + 同行业最多 3 只 + 持 15 只。
    // 8% 上限砍掉「异常高息」那一段——不设它，2024 年会全仓煤炭地产，单年跑输 16 个点。
    const strategyParams = {
      startYear: Number(clampFrom(btState.from).slice(0, 4)) + 1,
      endYm: btState.to.slice(0, 7),
      holdN: 15, minDy: 4, maxDy: 8, minDivYears: 5,
      minPayout: 10, maxPayout: 80, minRoe: 8, minCover: 0.7,
      indCap: 3, quality: true,
    };
    const screenMonths = await loadCmpScreen();
    const cmpFin = await loadCmpFin();
    const pass1 = runPlanBacktest({
      baseline: db.baseline, months: screenMonths, screenMonths, benchmark: db.benchmark,
      finHistory: cmpFin, params: strategyParams,
    });
    const picked = [...new Set(pass1.periods.flatMap((x) => (x.items || []).map((it) => it.code)))];
    const fullMonths = await loadMonthlyFor(picked);
    const plan = runPlanBacktest({
      baseline: db.baseline, months: fullMonths, screenMonths, benchmark: db.benchmark,
      finHistory: cmpFin, params: strategyParams,
    });
    const noPick = !pass1.periods.length || pass1.periods.every((x) => !x.items.length);
    rows.push({
      kind: 'rule',
      name: `红利精选(${plan.params.holdN}只)`, color: chartColors().sub,
      nav: plan.nav.map((pt) => [monthEnd(pt.ym), +(btState.capital * pt.nav).toFixed(2)]),
      unitNav: plan.nav.map((pt) => [monthEnd(pt.ym), pt.nav]),
      end: btState.capital * (1 + plan.stats.total), cagr: plan.stats.cagr, mdd: plan.stats.mdd, div: null, width: 1.6,
      empty: noPick,
    });
    if (b0.bench) rows.push({ kind: 'bench', name: '中证红利全收益', color: chartColors().bench, nav: b0.bench.rows, end: b0.bench.end, cagr: b0.bench.cagr, mdd: maxDrawdown(b0.bench.unitNav || b0.bench.rows).mdd, unitNav: b0.bench.unitNav, div: null, width: 1.3, isIndex: true });
    if (b0.lowVol) rows.push({ kind: 'bench', name: '红利低波全收益', color: chartColors().lowvol, nav: b0.lowVol.rows, end: b0.lowVol.end, cagr: b0.lowVol.cagr, mdd: maxDrawdown(b0.lowVol.unitNav || b0.lowVol.rows).mdd, unitNav: b0.lowVol.unitNav, div: null, width: 1.4, isIndex: true });
    // 方案很多时给策略/指数留位置：最多 5 个方案，其余名额归基准行
    const planRows = rows.filter((r) => r.kind === 'plan');
    const restRows = rows.filter((r) => r.kind !== 'plan');
    ctx.compareRows = [...planRows.slice(0, 5), ...restRows].slice(0, 8);
    ctx.compareBench = b0.bench;
    ctx.compareLowVol = b0.lowVol;
    ctx.cmpStrategy = { periods: plan.periods, params: plan.params, yearly: plan.yearly, stats: plan.stats };
    ctx.compareNote = noPick
      ? '红利策略这一行没选出任何股票（股票池或选股财报没加载成功），所以是一条水平线，不代表策略本身不赚钱。'
      : '';
    body = renderCompare(market, s);
  } else {
    body = renderPort(market, s);
  }

  // 财报拉不全（慢网断流）时不白屏：用不含质量筛选的结果继续跑，并在顶部说明
  const finWarn = market.finHistory && db.finDegraded
    ? `<div class="banner warn" style="margin:0 0 12px">历史财报只拉到一部分（慢网断流），本次回测<b>未启用质量筛选</b>，数值会略有差异。刷新一次可补下其余分片。</div>`
    : '';

  return `<div class="page-head fade-in">
    <div>
      <h1 class="page-title">回测</h1>
      <div class="page-sub">组合回测 / 个股回测 / 组合对比 · 日 K + 月线 · 基准中证红利 / 红利低波</div>
    </div>
    <div class="page-actions">${modeTabs()}</div>
  </div>
  ${finWarn}${body}`;
}
