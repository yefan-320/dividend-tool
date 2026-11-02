/* 图表：统一主题、去网格、直接标注。只用 ECharts，不引入别的库。 */
const css = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();

function theme() {
  return {
    text: css('--text') || '#e9edf2',
    text2: css('--text-2') || '#9aa6b5',
    text3: css('--text-3') || '#65707e',
    line: css('--line') || 'rgba(255,255,255,.065)',
    surface: css('--surface') || '#14191f',
    accent: css('--accent') || '#d8a84e',
    accent2: css('--accent-2') || '#f0c97a',
    up: css('--up') || '#ef5b60',
    down: css('--down') || '#35b57a',
    info: css('--info') || '#5b9cf5',
  };
}

/* 全站统一语义色：同一个东西，不管出现在哪张图里都是同一个颜色。
   色值在 tokens.css 里（--c-*），深浅主题各一套，这里只负责读。
   按色相拉开、不按明度——深色底上金和灰明度接近会糊成一片。 */
function Cd() {
  return {
    nav: css('--c-nav') || '#e8b64c',      // 净值 / 策略（主角）
    bench: css('--c-bench') || '#2ec5f0',  // 中证红利全收益（青）
    lowvol: css('--c-lowvol') || '#a78bfa',// 中证红利低波全收益（紫）
    div: css('--c-div') || '#ef5b60',      // 分红（红）
    dd: css('--c-dd') || '#f0883e',        // 回撤（橙：红留给分红，别抢）
    buy: css('--c-fund') || '#5b9cf5',     // 买入 / 定投 / 投入（蓝）
    sell: css('--c-dd') || '#f0883e',      // 卖出（跟回撤同语义：钱出去）
    sub: css('--c-sub') || '#e8b64c',      // 辅助线（增速等派生量）
  };
}

/** 给页面层取同一套语义色（HTML 里的图例、色块用） */
export const chartColors = () => Cd();

const chart = (el) => (el ? echarts.getInstanceByDom(el) || echarts.init(el, null, { renderer: 'canvas' }) : null);

function baseTooltip(t) {
  return {
    trigger: 'axis',
    confine: true,
    backgroundColor: t.surface,
    borderColor: t.line,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: t.text, fontSize: 11 },
    axisPointer: { type: 'line', lineStyle: { color: t.text3, width: 1 } },
  };
}

function baseAxis(t) {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: t.text3, fontSize: 9.5 },
    splitLine: { show: false },
  };
}

/* ---------------- 价格走势：收盘线 + 均线 + 买卖/分红标注（不要蜡烛、不要成交量） ---------------- */

function drawPriceChartImpl(el, rows, opts = {}) {
  if (!el || typeof echarts === 'undefined' || !rows || rows.length < 2) return null;
  const t = theme();
  const C = Cd();
  const ch = chart(el);
  const dates = rows.map((r) => r[0]);
  const closes = rows.map((r) => r[1]);
  const ma = opts.ma || [20, 60];
  const maSeries = ma.map((n, idx) => ({
    name: 'MA' + n,
    type: 'line',
    showSymbol: false,
    smooth: false,
    data: closes.map((_, i) => {
      if (i < n - 1) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += closes[j];
      return +(s / n).toFixed(2);
    }),
    lineStyle: { width: 1, color: idx === 0 ? t.accent2 : t.info, opacity: 0.5 },
    z: 4,
  }));
  const marks = opts.marks || [];
  const buyPts = marks.filter((m) => m.kind === 'buy').map((m) => ({ value: [m.date, m.price], name: m.why || '买入' }));
  const sellPts = marks.filter((m) => m.kind === 'sell').map((m) => ({ value: [m.date, m.price], name: m.why || '卖出' }));
  const divPts = marks.filter((m) => m.kind === 'div').map((m) => ({ value: [m.date, m.price], name: m.why || '分红' }));
  const lines = opts.lines || [];
  const first = closes.find((v) => v > 0) || 0;
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 8, right: 52, top: 12, bottom: 30, containLabel: true },
    tooltip: {
      ...baseTooltip(t),
      formatter: (ps) => {
        const i = ps[0]?.dataIndex;
        if (i == null) return '';
        const c = closes[i];
        const pctv = first > 0 ? (c / first - 1) * 100 : null;
        const extra = marks.filter((m) => m.date === dates[i]).map((m) => `<div style="font-size:10.5px;color:${m.kind === 'sell' ? C.sell : m.kind === 'div' ? C.div : C.buy}">${m.why || m.kind}</div>`).join('');
        return `<div style="font-family:var(--mono);font-size:10px;color:${t.text3};margin-bottom:4px">${dates[i]}</div>` +
          `<div style="font-size:11px;line-height:1.75">收盘 <b>${c}</b>${pctv == null ? '' : `　区间 <b class="${pctv >= 0 ? 'up' : 'down'}">${pctv >= 0 ? '+' : ''}${pctv.toFixed(1)}%</b>`}</div>` + extra;
      },
    },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false, ...baseAxis(t),
      axisLabel: { color: t.text3, fontSize: 9, hideOverlap: true, interval: 'auto', formatter: (v) => String(v).slice(2).replace('-', '/') },
    },
    yAxis: {
      type: 'value', scale: true, position: 'right', ...baseAxis(t),
      axisLabel: { color: t.text3, fontSize: 9.5, formatter: (v) => v.toFixed(v >= 100 ? 0 : 2) },
      splitLine: { show: true, lineStyle: { color: t.line } },
    },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
    series: [
      {
        name: '收盘', type: 'line', data: closes, showSymbol: false, smooth: false, z: 3,
        lineStyle: { width: 1.6, color: t.accent },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(216,168,78,.18)' }, { offset: 1, color: 'rgba(216,168,78,0)' },
        ]) },
        markLine: lines.length ? {
          silent: true, symbol: 'none',
          lineStyle: { color: t.accent, width: 1, opacity: 0.35 },
          label: { color: t.accent, fontSize: 9, position: 'insideEndTop', formatter: (p) => p.name },
          data: lines.map((l) => ({ yAxis: l.value, name: l.label })),
        } : undefined,
      },
      ...maSeries,
      { name: '买入', type: 'scatter', data: buyPts, symbol: 'triangle', symbolSize: 9, itemStyle: { color: C.buy, borderColor: '#fff', borderWidth: 1 }, z: 6 },
      { name: '卖出', type: 'scatter', data: sellPts, symbol: 'triangle', symbolRotate: 180, symbolSize: 9, itemStyle: { color: C.sell, borderColor: '#fff', borderWidth: 1 }, z: 6 },
      { name: '分红', type: 'scatter', data: divPts, symbol: 'diamond', symbolSize: 7, itemStyle: { color: C.div, borderColor: '#fff', borderWidth: 1 }, z: 5 },
    ],
  });
  return ch;
}

/* ---------------- 组合回测主图：资产 + 回撤 + 分红 ---------------- */

function drawPortfolioChartImpl(el, { nav, navR, bench, lowVol, dd, divByY, capital }) {
  if (!el || typeof echarts === 'undefined' || !nav || nav.length < 2) return null;
  const t = theme();
  const C = Cd();
  const ch = chart(el);
  const W = (v) => +(v / 10000).toFixed(1);
  const capW = +(capital / 10000).toFixed(1);
  const years = Object.keys(divByY || {}).map(Number).filter((y) => divByY[y] > 0).sort();
  const divVals = years.map((y) => +(divByY[y] / 10000).toFixed(2));
  const divGrowth = years.map((y, i) => (i > 0 && divVals[i - 1] > 0 ? +(((divVals[i] - divVals[i - 1]) / divVals[i - 1]) * 100).toFixed(0) : null));
  const pad = (arr, f) => (arr || []).map(([d, v]) => [d, f(v)]);
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: [
      { left: 6, right: 52, top: 34, height: 300, containLabel: true },
      { left: 6, right: 52, top: 350, height: 60, containLabel: true },
      { left: 6, right: 52, top: 426, height: 94, containLabel: true },
    ],
    legend: { top: 0, left: 0, textStyle: { color: t.text2, fontSize: 11.5 }, itemWidth: 18, itemHeight: 3, itemGap: 18 },
    tooltip: { ...baseTooltip(t), valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(1)) },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [
      { type: 'time', gridIndex: 0, ...baseAxis(t), axisLabel: { show: false } },
      { type: 'time', gridIndex: 1, ...baseAxis(t), axisLabel: { show: false } },
      { type: 'category', gridIndex: 2, data: years, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9 } },
    ],
    yAxis: [
      { type: 'value', scale: true, gridIndex: 0, position: 'right', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9.5, formatter: (v) => v.toFixed(0) + '万' }, splitLine: { show: true, lineStyle: { color: t.line } } },
      { type: 'value', gridIndex: 1, position: 'right', max: 0, min: 'dataMin', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 8, formatter: '{value}%' }, splitLine: { show: false } },
      { type: 'value', gridIndex: 2, position: 'right', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 8, formatter: '{value}万' }, splitLine: { show: false } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], height: 14, bottom: 2, borderColor: t.line, backgroundColor: 'transparent', fillerColor: 'rgba(216,168,78,.12)', textStyle: { color: t.text3, fontSize: 8 } },
    ],
    series: [
      { name: '组合(复投)', type: 'line', data: pad(nav, W), xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, sampling: 'lttb', lineStyle: { width: 2.2, color: C.nav }, z: 5, markLine: { silent: true, symbol: 'none', lineStyle: { color: t.text3, width: 1, opacity: 0.35 }, label: { color: t.text3, fontSize: 9, formatter: '本金 ' + capW + '万' }, data: [{ yAxis: capW }] } },
      { name: '红利不复投', type: 'line', data: pad(navR, W), xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.3, color: C.nav, opacity: 0.55 }, z: 4 },
      bench ? { name: '中证红利全收益', type: 'line', data: pad(bench.rows, W), xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.3, color: C.bench }, z: 3 } : null,
      lowVol ? { name: '红利低波全收益', type: 'line', data: pad(lowVol.rows, W), xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.6, color: C.lowvol }, z: 2 } : null,
      { name: '回撤', type: 'line', data: dd || [], xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, lineStyle: { width: 1, color: C.dd, opacity: 0.85 }, areaStyle: { color: 'rgba(240,136,62,.13)' }, z: 3 },
      { name: '年度分红', type: 'bar', data: divVals, xAxisIndex: 2, yAxisIndex: 2, barMaxWidth: 26, itemStyle: { color: C.div, opacity: 0.75, borderRadius: [3, 3, 0, 0] }, label: { show: true, position: 'insideTop', offset: [0, 3], fontSize: 9, color: '#fff', formatter: (p) => p.value + '万' }, z: 2 },
      { name: '分红增速', type: 'line', data: divGrowth, xAxisIndex: 2, yAxisIndex: 2, showSymbol: true, symbolSize: 4, lineStyle: { width: 1.5, color: C.div }, itemStyle: { color: C.div }, label: { show: true, position: 'top', fontSize: 8, color: C.div, formatter: (p) => (p.value == null ? '' : (p.value >= 0 ? '+' : '') + p.value + '%') }, z: 3 },
    ].filter(Boolean),
  });
  return ch;
}

/* ---------------- 个股回测：净值 + 两条基准 + 回撤 + 年度分红 ---------------- */

const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const tsOf = (d) => new Date(d + 'T00:00:00').getTime();
const dsOf = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
/** 在 [[date, v]] 里找离 ts 最近的一条（lttb 采样后原始点会缺席，不能用精确匹配） */
function nearestVal(arr, ts) {
  if (!arr || !arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tsOf(arr[mid][0]) < ts) lo = mid + 1; else hi = mid;
  }
  let best = lo;
  if (lo > 0 && Math.abs(tsOf(arr[lo - 1][0]) - ts) <= Math.abs(tsOf(arr[lo][0]) - ts)) best = lo - 1;
  return arr[best][1];
}

function drawNavChartImpl(el, { nav, bench, lowVol, dd, divByY, hold, capital }) {
  if (!el || typeof echarts === 'undefined' || !nav || nav.length < 2) return null;
  const t = theme();
  const C = Cd();
  const ch = chart(el);
  const nav0 = nav[0][1] || capital;
  const norm = (arr) => (arr || []).map(([d, v]) => [d, +((v / nav0) * 100).toFixed(2)]);
  const navN = norm(nav);
  const benchN = bench ? norm(bench.rows) : null;
  const lowVolN = lowVol ? norm(lowVol.rows) : null;
  const holdN = hold ? norm(hold) : null;
  const lastTs = tsOf(navN[navN.length - 1][0]);
  // 年份要连续：没分红的年份摆 0，别让坐标轴跳着走
  const dy0 = Number(String(navN[0][0]).slice(0, 4));
  const dy1 = Number(String(navN[navN.length - 1][0]).slice(0, 4));
  const dy = divByY || {};
  const divRows = [];
  const divGrowth = [];
  for (let y = dy0; y <= dy1; y++) {
    divRows.push([`${y}-12-31`, +((dy[y] || 0) / 10000).toFixed(2)]);
    const prev = dy[y - 1];
    const cur = dy[y];
    divGrowth.push([`${y}-12-31`, prev > 0 && cur != null ? +(((cur / prev) - 1) * 100).toFixed(1) : null]);
  }

  const f2 = (v) => (v == null ? '—' : Number(v).toFixed(2));
  const row = (c, name, val) => `<div style="display:flex;gap:14px;justify-content:space-between;line-height:1.65;white-space:nowrap">
      <span style="color:${t.text2}"><i style="background:${c};width:7px;height:7px;border-radius:2px;display:inline-block;margin-right:6px;vertical-align:1px"></i>${name}</span>
      <b style="font-variant-numeric:tabular-nums;color:${t.text}">${val}</b></div>`;

  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: [
      { left: 8, right: 78, top: 30, height: '44%' },      // 净值
      { left: 8, right: 78, top: '56%', height: '12%' },   // 回撤
      { left: 8, right: 78, top: '72%', height: '13%' },   // 年度分红
    ],
    legend: {
      top: 0, left: 0,
      textStyle: { color: t.text2, fontSize: 11.5 },
      itemWidth: 18, itemHeight: 3, itemGap: 18,
      inactiveColor: t.text3,
    },
    tooltip: {
      ...baseTooltip(t),
      formatter: (ps) => {
        const av = ps && ps.length ? ps[0].axisValue : null;
        if (av == null) return '';
        const ts = typeof av === 'number' ? av : tsOf(String(av).slice(0, 10));
        const lines = [row(C.nav, '规则净值', f2(nearestVal(navN, ts)))];
        if (benchN) lines.push(row(C.bench, '中证红利', f2(nearestVal(benchN, ts))));
        if (lowVolN) lines.push(row(C.lowvol, '红利低波', f2(nearestVal(lowVolN, ts))));
        if (holdN) lines.push(row(C.buy, '买入持有', f2(nearestVal(holdN, ts))));
        const d = nearestVal(dd, ts);
        if (d != null) lines.push(row(C.dd, '回撤', f2(d) + '%'));
        const dv = nearestVal(divRows, tsOf(String(new Date(ts).getFullYear()) + '-12-31'));
        if (dv) lines.push(row(C.div, `${new Date(ts).getFullYear()} 年分红`, f2(dv) + ' 万'));
        const gy = new Date(ts).getFullYear();
        const gPrev = (divByY || {})[gy - 1];
        const gCur = (divByY || {})[gy];
        if (gPrev > 0 && gCur != null) lines.push(row(C.sub, '分红增速', ((gCur / gPrev - 1) * 100 >= 0 ? '+' : '') + ((gCur / gPrev - 1) * 100).toFixed(2) + '%'));
        return `<div style="font-family:var(--mono);font-size:10px;color:${t.text3};margin-bottom:5px">${dsOf(ts)}</div>${lines.join('')}`;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: 'rgba(255,255,255,.28)', width: 1 } },
    xAxis: [
      { type: 'time', gridIndex: 0, ...baseAxis(t), axisLabel: { show: false } },
      { type: 'time', gridIndex: 1, ...baseAxis(t), axisLabel: { show: false } },
      { type: 'time', gridIndex: 2, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9.5, formatter: (v) => (v > lastTs ? '' : String(new Date(v).getFullYear())) } },
    ],
    yAxis: [
      { type: 'value', scale: true, gridIndex: 0, position: 'right', splitNumber: 4, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 10, formatter: (v) => v.toFixed(0) }, splitLine: { show: true, lineStyle: { color: 'rgba(255,255,255,.04)' } } },
      { type: 'value', gridIndex: 1, position: 'right', max: 0, min: 'dataMin', splitNumber: 3, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 8.5, formatter: (v) => v.toFixed(0) + '%' }, splitLine: { show: false } },
      { type: 'value', gridIndex: 2, position: 'right', splitNumber: 2, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 8.5, formatter: (v) => v.toFixed(0) + '万' }, splitLine: { show: false } },
      { type: 'value', gridIndex: 2, position: 'left', show: false, scale: true },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2], start: 0, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1, 2], height: 15, bottom: 2, borderColor: 'transparent', backgroundColor: 'rgba(255,255,255,.05)', fillerColor: 'rgba(232,182,76,.22)', handleStyle: { color: 'rgba(232,182,76,.65)', borderColor: 'transparent' }, moveHandleStyle: { color: 'rgba(232,182,76,.35)' }, textStyle: { color: t.text3, fontSize: 8 } },
    ],
    series: [
      { name: '规则净值', type: 'line', data: navN, showSymbol: false, sampling: 'lttb', lineStyle: { width: 2.2, color: C.nav }, itemStyle: { color: C.nav }, z: 6 },
      benchN ? { name: '中证红利', type: 'line', data: benchN, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.3, color: C.bench }, itemStyle: { color: C.bench }, z: 4 } : null,
      lowVolN ? { name: '红利低波', type: 'line', data: lowVolN, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.6, color: C.lowvol }, itemStyle: { color: C.lowvol }, z: 3 } : null,
      holdN ? { name: '买入持有', type: 'line', data: holdN, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.2, color: C.buy, opacity: 0.75 }, itemStyle: { color: C.buy }, z: 5 } : null,
      { name: '回撤', type: 'line', data: dd || [], xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, lineStyle: { width: 1, color: C.dd, opacity: 0.85 }, areaStyle: { color: 'rgba(240,136,62,.14)' }, z: 3 },
      { name: '年度分红', type: 'bar', data: divRows, xAxisIndex: 2, yAxisIndex: 2, barMaxWidth: 16, itemStyle: { color: C.div, opacity: 0.85, borderRadius: [2, 2, 0, 0] }, z: 3 },
      { name: '分红增速', type: 'line', data: divGrowth, xAxisIndex: 2, yAxisIndex: 3, showSymbol: true, symbolSize: 3, lineStyle: { width: 1.6, color: C.sub }, itemStyle: { color: C.sub }, connectNulls: false, z: 4 },
    ].filter(Boolean),
  });
  return ch;
}

/* ---------------- 持仓构成环形图 ---------------- */

function drawDonutImpl(el, entries) {
  if (!el || typeof echarts === 'undefined') return null;
  const t = theme();
  const ch = chart(el);
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item', confine: true, backgroundColor: t.surface, borderColor: t.line, textStyle: { color: t.text, fontSize: 11 }, formatter: (p) => `${p.name}<br>${p.value} 万 · ${p.percent}%` },
    series: [{
      type: 'pie', radius: ['54%', '80%'], center: ['50%', '50%'],
      itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
      label: { show: false }, labelLine: { show: false },
      data: entries.map((e) => ({ name: e.name, value: e.value, itemStyle: { color: e.color } })),
    }],
  });
  return ch;
}

/* ---------------- 收益拆解瀑布 ---------------- */

function drawWaterfallImpl(el, { capital, add = 0, div, end }) {
  if (!el || typeof echarts === 'undefined') return null;
  const t = theme();
  const C = Cd();
  const ch = chart(el);
  const cap = capital / 10000;
  const ad = add / 10000;
  const dv = div / 10000;
  const priceGain = (end - capital - add - div) / 10000;
  const fin = end / 10000;
  // 只有开了定投才多一段，组合页那套口径不变
  const cats = ['本金', ...(ad > 0 ? ['定投'] : []), '分红到账', '价格收益', '期末'];
  const steps = [
    { name: '本金', value: cap, color: C.buy },
    ...(ad > 0 ? [{ name: '定投', value: ad, color: C.buy }] : []),
    { name: '分红到账', value: dv, color: C.div },
    { name: '价格收益', value: priceGain, color: '#8b93a1' },
    { name: '期末', value: fin, color: C.nav },
  ];
  let run = 0;
  const bottoms = steps.map((x, i) => {
    if (i === steps.length - 1) return 0;
    const b = run;
    run += x.value;
    return b;
  });
  // 负值那一段（价格亏损）要从上方往下长
  const baseData = steps.map((x, i) => (i === steps.length - 1 ? 0 : (x.value >= 0 ? bottoms[i] : bottoms[i] + x.value)));
  const valData = steps.map((x, i) => (i === steps.length - 1 ? x.value : Math.abs(x.value)));
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 8, right: 12, top: 22, bottom: 6, containLabel: true },
    tooltip: { trigger: 'item', confine: true, backgroundColor: t.surface, borderColor: t.line, textStyle: { color: t.text, fontSize: 11 }, formatter: (p) => `${p.name}<br><b>${p.value} 万</b>` },
    xAxis: { type: 'category', data: cats, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 10 } },
    yAxis: { type: 'value', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9, formatter: '{value}万' }, splitLine: { show: true, lineStyle: { color: t.line } } },
    series: [
      { name: 'base', type: 'bar', stack: 'wf', barWidth: '46%', itemStyle: { color: 'transparent' }, data: baseData.map((v) => +v.toFixed(1)), tooltip: { show: false }, z: 1 },
      {
        name: 'wf', type: 'bar', stack: 'wf', barWidth: '46%', z: 2,
        data: steps.map((x, i) => ({ name: x.name, value: +valData[i].toFixed(1), itemStyle: { color: x.color, borderRadius: [3, 3, 0, 0] } })),
        label: { show: true, position: 'top', fontSize: 10, color: t.text2, formatter: (p) => ((p.dataIndex > 0 && p.dataIndex < steps.length - 1 && p.value >= 0) ? '+' : '') + p.value + '万' },
      },
    ],
  });
  return ch;
}

/* ---------------- 分环境对比 ---------------- */

function drawEnvChartImpl(el, rows) {
  if (!el || typeof echarts === 'undefined') return null;
  const t = theme();
  const C = Cd();
  const ch = chart(el);
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 8, right: 8, top: 26, bottom: 4, containLabel: true },
    legend: { top: 0, textStyle: { color: t.text3, fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
    tooltip: { trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.line, textStyle: { color: t.text, fontSize: 11 }, axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: rows.map((x) => x.name), ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 10 } },
    yAxis: { type: 'value', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9, formatter: '{value}%' }, splitLine: { show: true, lineStyle: { color: t.line } } },
    series: [
      { name: '我的组合', type: 'bar', data: rows.map((x) => (x.rule == null ? null : +x.rule.toFixed(1))), barWidth: '32%', itemStyle: { color: C.nav, borderRadius: [3, 3, 0, 0] }, label: { show: true, position: 'top', fontSize: 9, color: t.text3, formatter: (p) => (p.value == null ? '' : p.value + '%') } },
      { name: '中证红利全收益', type: 'bar', data: rows.map((x) => (x.bench == null ? null : +x.bench.toFixed(1))), barWidth: '32%', itemStyle: { color: C.bench, borderRadius: [3, 3, 0, 0] }, label: { show: true, position: 'top', fontSize: 9, color: t.text3, formatter: (p) => (p.value == null ? '' : p.value + '%') } },
    ],
  });
  return ch;
}

/* ---------------- 年度分红（柱 + 累计线） ---------------- */

function drawDivChartImpl(el, divByY) {
  if (!el || typeof echarts === 'undefined') return null;
  const t = theme();
  const C = Cd();
  const ch = chart(el);
  const years = Object.keys(divByY || {}).map(Number).filter((y) => divByY[y] > 0).sort();
  let cum = 0;
  const cumVals = years.map((y) => { cum += divByY[y]; return +(cum / 10000).toFixed(2); });
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 8, right: 12, top: 18, bottom: 6, containLabel: true },
    tooltip: { trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.line, textStyle: { color: t.text, fontSize: 11 }, axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: years, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9 } },
    yAxis: { type: 'value', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9, formatter: '{value}万' }, splitLine: { show: true, lineStyle: { color: t.line } } },
    series: [
      { name: '年度分红', type: 'bar', data: years.map((y) => +(divByY[y] / 10000).toFixed(2)), barMaxWidth: 30, itemStyle: { color: C.div, opacity: 0.75, borderRadius: [3, 3, 0, 0] }, label: { show: true, position: 'top', fontSize: 9, color: t.text3, formatter: (p) => p.value + '万' } },
      { name: '累计', type: 'line', data: cumVals, showSymbol: true, symbolSize: 4, lineStyle: { width: 2, color: C.div }, itemStyle: { color: C.div }, areaStyle: { color: 'rgba(239,91,96,.10)' } },
    ],
  });
  return ch;
}

/* ---------------- 历史相似状态散点 ---------------- */

function drawSimilarChartImpl(el, points, curPct, median) {
  if (!el || typeof echarts === 'undefined') return null;
  // dataset 走的是 JSON 往返：NaN/Infinity 会变成 null，这里再兜一层，别让 toFixed 抛错
  points = (points || []).filter((p) => p && Number.isFinite(p.pct) && Number.isFinite(p.ret));
  const t = theme();
  const ch = chart(el);
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 8, right: 12, top: 18, bottom: 6, containLabel: true },
    tooltip: { trigger: 'item', confine: true, backgroundColor: t.surface, borderColor: t.line, textStyle: { color: t.text, fontSize: 11 }, formatter: (p) => `组合分位 ${p.data[0]}%<br>其后 12 个月 <b>${p.data[1]}%</b>` },
    xAxis: { type: 'value', name: '分位%', nameTextStyle: { color: t.text3, fontSize: 9 }, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9 }, splitLine: { show: true, lineStyle: { color: t.line } } },
    yAxis: { type: 'value', name: '未来12月%', nameTextStyle: { color: t.text3, fontSize: 9 }, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9 }, splitLine: { show: true, lineStyle: { color: t.line } } },
    series: [{
      type: 'scatter', symbolSize: 12,
      data: points.map((p) => [p.pct, +p.ret.toFixed(1)]),
      itemStyle: { color: 'rgba(216,168,78,.7)', borderColor: t.accent, borderWidth: 1 },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: t.up, width: 1, opacity: 0.5 }, label: { formatter: '当前 ' + curPct + '%', color: t.text3, fontSize: 9 }, data: [{ xAxis: curPct }] },
      markPoint: median != null ? { symbol: 'circle', symbolSize: 10, itemStyle: { color: t.accent }, label: { show: true, position: 'top', formatter: '中位 ' + median.toFixed(0) + '%', color: t.accent, fontSize: 9 }, data: [{ coord: [curPct, +median.toFixed(1)] }] } : undefined,
    }],
  });
  return ch;
}

/* ---------------- 年度数据小图 ---------------- */

function drawLineMiniImpl(el, rows, opts = {}) {
  if (!el || typeof echarts === 'undefined' || !rows || rows.length < 2) return null;
  const t = theme();
  const ch = chart(el);
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 6, right: 46, top: 10, bottom: 18, containLabel: true },
    tooltip: { ...baseTooltip(t) },
    xAxis: { type: 'time', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 8 } },
    yAxis: { type: 'value', scale: true, position: 'right', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 8, formatter: opts.yFmt || ((v) => v.toFixed(0)) }, splitLine: { show: true, lineStyle: { color: t.line } } },
    series: [{ type: 'line', data: rows, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.7, color: opts.color || t.accent }, areaStyle: opts.area === false ? undefined : { color: 'rgba(216,168,78,.08)' }, markLine: opts.markLine }],
  });
  return ch;
}

function drawBarsVsImpl(el, years, a, b) {
  if (!el || typeof echarts === 'undefined') return null;
  const t = theme();
  const ch = chart(el);
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 6, right: 46, top: 20, bottom: 4, containLabel: true },
    legend: { top: 0, textStyle: { color: t.text3, fontSize: 9 }, itemWidth: 12, itemHeight: 7 },
    tooltip: { trigger: 'axis', confine: true, backgroundColor: t.surface, borderColor: t.line, textStyle: { color: t.text, fontSize: 11 }, axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: years, ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9 } },
    yAxis: { type: 'value', position: 'right', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 8, formatter: '{value}%' }, splitLine: { show: true, lineStyle: { color: t.line } } },
    series: [
      { name: '组合', type: 'bar', data: a, barWidth: '34%', itemStyle: { color: t.accent, borderRadius: [2, 2, 0, 0] } },
      { name: '指数', type: 'bar', data: b, barWidth: '34%', itemStyle: { color: t.info, borderRadius: [2, 2, 0, 0] } },
    ],
  });
  return ch;
}

/* ---------------- 多线对比（组合对比 / 对照图） ---------------- */

function drawMultiLineChartImpl(el, series, opts = {}) {
  if (!el || typeof echarts === 'undefined' || !series || !series.length) return null;
  const t = theme();
  const ch = chart(el);
  ch.setOption({
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 6, right: 50, top: 30, bottom: 26, containLabel: true },
    legend: { top: 0, left: 0, textStyle: { color: t.text2, fontSize: 11.5 }, itemWidth: 18, itemHeight: 3, itemGap: 18 },
    tooltip: { ...baseTooltip(t), valueFormatter: (v) => (v == null ? '—' : Number(v).toFixed(2)) },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: { type: 'time', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9 } },
    yAxis: { type: 'value', scale: true, position: 'right', ...baseAxis(t), axisLabel: { color: t.text3, fontSize: 9, formatter: opts.yFmt || ((v) => v.toFixed(0)) }, splitLine: { show: true, lineStyle: { color: t.line } } },
    dataZoom: [{ type: 'inside', start: 0, end: 100 }],
    series: series.map((s, i) => ({
      name: s.name, type: 'line', data: s.rows, showSymbol: false, sampling: 'lttb',
      lineStyle: { width: s.width || 1.6, color: s.color || t.accent, opacity: s.opacity == null ? 0.95 : s.opacity }, z: s.z || 3,
      ...(i === 0 && opts.markLine ? { markLine: opts.markLine } : {}),
    })),
  });
  return ch;
}

/* ---------------- ECharts 按需加载 ----------------
   首屏（今天 / 我的 / 选股扫描榜）不需要图表库，1MB 的 echarts 不再用同步 <script> 加载，
   第一次真正画图时再注入；Service Worker 仍会预缓存它，离线画图不受影响。 */
let echartsPromise = null;

export function ensureEcharts() {
  if (typeof globalThis.echarts !== 'undefined') return Promise.resolve(globalThis.echarts);
  if (!echartsPromise) {
    echartsPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/echarts.min.js', import.meta.url).href;
      s.onload = () => resolve(globalThis.echarts);
      s.onerror = () => { echartsPromise = null; resolve(null); };
      document.head.appendChild(s);
    });
  }
  return echartsPromise;
}

function deferred(fn) {
  return function (...args) {
    if (typeof globalThis.echarts !== 'undefined') return fn.apply(this, args);
    ensureEcharts().then(() => fn.apply(null, args));
    return null;
  };
}

export const drawPriceChart = deferred(drawPriceChartImpl);
export const drawPortfolioChart = deferred(drawPortfolioChartImpl);
export const drawNavChart = deferred(drawNavChartImpl);
export const drawDonut = deferred(drawDonutImpl);
export const drawWaterfall = deferred(drawWaterfallImpl);
export const drawEnvChart = deferred(drawEnvChartImpl);
export const drawDivChart = deferred(drawDivChartImpl);
export const drawSimilarChart = deferred(drawSimilarChartImpl);
export const drawLineMini = deferred(drawLineMiniImpl);
export const drawBarsVs = deferred(drawBarsVsImpl);
export const drawMultiLineChart = deferred(drawMultiLineChartImpl);
