import { db, loadDaily, loadMonthly, loadDyPct, quote, nameOf, divSummary, dataMeta } from '../data.js';
import { drawCandleChart } from '../charts.js';
import { isWatched, toggleWatch } from '../store.js';
import { openBuyModal } from '../ui/buy.js';
import { toast } from '../ui/toast.js';
import { evaluate } from '../engine/verdict.js';
import { icon } from '../ui/icons.js';
import { esc, num, pctSign, levelPill, upDown } from '../ui/format.js';

const LV = { buy: '可买', wait: '观察', avoid: '回避', hold: '持有', missing: '数据不足' };
const CHIPS = ['000333', '600036', '601318', '600887', '600941', '601398', '600066'];

function codeFromHash() {
  const qs = (location.hash.split('?')[1] || '');
  const c = new URLSearchParams(qs).get('code');
  return /^\d{6}$/.test(c || '') ? c : '000333';
}

function verdict(code, q, d, pctile) {
  const ev = evaluate(code, { quotes: db.quotes, dividends: db.baseline.dividends || {}, f10: db.baseline.f10 || {}, finance: db.finance || {}, finYear: db.finYear });
  return { ev, cur: ev.metrics.dy, pctile, hasFin: ev.metrics.hasFin };
}

function searchBar() {
  return `<div class="stock-search-wrap fade-in">
    <div class="stock-search">
      ${icon('search')}
      <input id="stockSearch" placeholder="输入 6 位代码，如 000333" autocomplete="off" spellcheck="false">
      <kbd>Enter</kbd>
    </div>
  </div>`;
}

function chips(active) {
  return `<div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:14px">
    ${CHIPS.map((c) => `<button class="btn sm ${c === active ? 'primary' : 'ghost'}" data-code="${c}">${esc(nameOf(c))}</button>`).join('')}
  </div>`;
}

function verdictPanel(code, q, d, v) {
  const dps = d?.years?.[d.lastY] || 0;
  const low = dps > 0 ? dps / 0.065 : null;
  const high = dps > 0 ? dps / 0.05 : null;
  const ev = v.ev;
  return `<section class="panel fade-in">
    <div class="verdict">
      <div class="verdict-main">
        <div class="row" style="gap:10px;align-items:baseline;flex-wrap:wrap">
          <span class="verdict-word ${ev.level}">${LV[ev.level]}</span>
          <span style="font-size:17px;font-weight:650">${esc(q.n)}</span>
          <span class="mono" style="font-size:11px;color:var(--text-3)">${esc(code)}</span>
        </div>
        <div class="verdict-sub">${esc(ev.reasons[0])}</div>
        <div class="verdict-tags">
          <span class="tag">股息率 ${num(v.cur, 1)}%</span>
          <span class="tag">连续分红 ${d ? d.consecutive : 0} 年</span>
          <span class="tag">财报 ${v.hasFin ? '已导入' : '缺失'}</span>
          ${ev.metrics.payout != null ? `<span class="tag" style="color:${ev.metrics.payout > 90 ? 'var(--warn)' : 'var(--text-2)'}">支付率 ${num(ev.metrics.payout, 0)}%</span>` : ''}
          ${ev.metrics.ocfCover != null ? `<span class="tag">现金流覆盖 ${num(ev.metrics.ocfCover, 2)}×</span>` : ''}
          ${v.pctile != null ? `<span class="tag" style="color:var(--accent-2);border-color:var(--accent-line)">股息率分位 ${num(v.pctile, 0)}%</span>` : ''}
        </div>
        <div class="kv-grid">
          <div class="kv"><div class="k">现价</div><div class="v num">${num(q.p, 2)}</div><div class="s ${upDown(q.p - q.prev)}">${pctSign(q.prev ? (q.p / q.prev - 1) * 100 : null)}</div></div>
          <div class="kv"><div class="k">股息率</div><div class="v num">${num(v.cur, 1)}%</div><div class="s">按 ${d?.lastY || '—'} 年度分红</div></div>
          <div class="kv"><div class="k">股息率分位</div><div class="v num">${v.pctile == null ? '—' : num(v.pctile, 0) + '%'}</div><div class="s">${v.pctile == null ? '样本不足（上市不足 2 年）' : '2012 年至今 · 按月线计算'} </div></div>
        </div>
      </div>
      <div class="verdict-side">
        <div class="section-title" style="margin-bottom:8px">买入价区间（绝对股息率）</div>
        <div class="target-line"><span class="l">6.5% 股息率</span><span class="r num">${num(low, 2)}</span></div>
        <div class="target-line" style="margin-top:6px"><span class="l">5.0% 股息率</span><span class="r num">${num(high, 2)}</span></div>
        <div class="target-line" style="margin-top:6px"><span class="l">现价</span><span class="r num" style="color:var(--accent-2)">${num(q.p, 2)}</span></div>
        <div class="banner" style="margin-top:12px;font-size:10.5px">买入区 = 最近年度每股分红 ÷ 目标股息率。不再用「分位 ≥90%」这种没有统计依据的阈值。</div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
          <div class="row row-between" style="font-size:11px"><span class="muted">最近分红年</span><span>${d?.lastY || '—'}</span></div>
          <div class="row row-between" style="font-size:11px;margin-top:6px"><span class="muted">每股分红</span><span class="num">${num(dps, 3)}</span></div>
          <div class="row row-between" style="font-size:11px;margin-top:6px"><span class="muted">财报</span><span>${v.hasFin ? '已导入' : '缺失'}</span></div>
        </div>
      </div>
    </div>
  </section>`;
}

function finLatest(code) {
  const a = db.finance?.[code];
  if (a) {
    return { eps: a[0], roe: a[1], netMargin: a[2], liabilityRatio: a[3], ocfps: a[4], netProfit: a[5], year: db.finYear };
  }
  const fin = db.baseline.f10?.[code];
  if (!fin) return null;
  const ys = Object.keys(fin.years || {}).filter((y) => fin.years[y]?.reportDate).sort();
  if (!ys.length) return null;
  const y = ys[ys.length - 1];
  const f = fin.years[y];
  return { year: y, eps: f.eps, roe: f.roe, netMargin: f.netMargin, liabilityRatio: f.liabilityRatio, ocfps: null, netProfit: f.netProfit };
}

function factorsPanel(code, q, d, v) {
  const fin = finLatest(code);
  const dps = d?.years?.[d.lastY] || 0;
  const payout = fin?.eps ? (dps / fin.eps) * 100 : null;
  const rows = [
    { k: '分红可持续', v: d ? Math.min(10, (d.consecutive / 10) * 10) : null, note: d ? `连续 ${d.consecutive} 年 · 最近 ${d.lastY} 年每股 ${num(dps, 3)}` : '无分红记录' },
    { k: '盈利质量', v: fin?.roe != null ? Math.min(10, Math.max(0, fin.roe / 2.5)) : null, note: fin ? `ROE ${num(fin.roe, 1)}% · 净利率 ${num(fin.netMargin, 1)}% · 负债率 ${num(fin.liabilityRatio, 1)}%` : '缺财报，无法计算' },
    { k: '价格 / 估值', v: v.cur != null ? Math.min(10, Math.max(0, v.cur)) : null, note: `股息率 ${num(v.cur, 1)}% · 分位 ${v.pctile == null ? '—' : num(v.pctile, 0)}%` },
    { k: '支付率', v: payout != null ? (payout >= 30 && payout <= 80 ? 8 : payout > 100 ? 2 : 5) : null, note: fin ? `分红 / EPS = ${num(payout, 0)}%（40–70% 为佳）` : '缺 EPS，无法计算' },
  ];
  return `<section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">四层因子</span><span class="section-note">0–10 · 财报缺失的项不填分</span></div>
    <div class="panel-body" style="padding-top:8px">
      ${rows.map((f) => {
        const cls = f.v == null ? 'low' : f.v >= 7 ? '' : f.v >= 5 ? 'mid' : 'low';
        return `<div class="factor">
          <div class="factor-head"><span class="factor-name">${esc(f.k)}</span><span class="factor-score num">${f.v == null ? '—' : num(f.v, 1)}</span></div>
          <div class="factor-bar"><div class="factor-fill ${cls}" style="width:${f.v == null ? 0 : f.v * 10}%"></div></div>
          <div class="factor-note">${esc(f.note)}</div>
        </div>`;
      }).join('')}
    </div>
  </section>`;
}

function divHistory(d) {
  if (!d) return '<div class="banner">没有分红记录</div>';
  const years = Object.keys(d.years).map(Number).filter((y) => d.years[y] > 0).sort((a, b) => b - a).slice(0, 10);
  return `<section class="panel fade-in">
    <div class="panel-head"><span class="panel-title">分红历史</span><span class="section-note">每股分红（元，税前）</span></div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>年度</th><th>每股分红</th><th>同比</th></tr></thead>
        <tbody>${years.map((y, i) => {
          const prev = d.years[years[i + 1]];
          const chg = prev ? ((d.years[y] / prev - 1) * 100) : null;
          return `<tr><td class="num">${y}</td><td class="num">${num(d.years[y], 3)}</td><td class="num ${upDown(chg)}">${chg == null ? '—' : pctSign(chg, 0)}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

function chartPanel(code, days, source = '日 K') {
  const rows = (days || []).map((d) => [d[0], d[1]]);
  window.__stockDailyRows = days || [];
  const lastD = days && days.length ? days[days.length - 1][0] : '—';
  return `<section class="panel fade-in" style="margin-top:14px">
    <div class="panel-head">
      <span class="panel-title">日 K</span>
      <span class="section-note">${esc(source)} · 蜡烛 + 成交量 · MA20/MA60 · 不复权 · 至 ${esc(lastD)}</span>
    </div>
    <div class="panel-body" style="padding:10px 10px 4px">
      <div class="stock-range">
        ${[['1', '近 1 年'], ['3', '近 3 年'], ['5', '近 5 年'], ['all', '全部']].map(([v, l]) => `<button class="bt-chip ${v === '3' ? 'on' : ''}" data-range="${v}">${l}</button>`).join('')}
      </div>
      <div id="klineChart" class="chart" style="height:340px"></div>
      <div class="row row-between" style="font-size:10px;color:var(--text-3);padding:2px 4px 6px">
        <span>数据 ${days ? days.length : 0} 根 · ${days && days.length ? days[0][0] : '—'} 起</span>
        <span>虚线 = 股息率参考价</span>
      </div>
    </div>
  </section>`;
}

/** 渲染后绑定：日 K 绘制 + 周期切换 + 搜索 */
export function bindStock() {
  const rows = window.__stockDailyRows || [];
  const marks = (window.__stockMarks || []).map((m) => ({ value: m.value, label: m.label }));
  const draw = (range) => {
    const el = document.getElementById('klineChart');
    if (!el) return;
    const ch = window.echarts?.getInstanceByDom(el);
    if (ch) ch.dispose();
    let list = rows;
    if (range && range !== 'all') {
      const years = Number(range);
      const d = new Date((db.generated || '2026-10-30') + 'T00:00:00');
      d.setFullYear(d.getFullYear() - years);
      const from = d.toISOString().slice(0, 10);
      list = rows.filter((r) => r[0] >= from);
    }
    drawCandleChart(el, list, { lines: marks });
  };
  draw('3');
  document.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('[data-range]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      draw(b.dataset.range);
    };
  });
  const search = document.getElementById('stockSearch');
  if (search) {
    search.onkeydown = (e) => {
      if (e.key === 'Enter' && /^\d{6}$/.test(search.value.trim())) location.hash = 'stock?code=' + search.value.trim();
    };
  }
  const code = codeFromHash();
  const watch = document.getElementById('addWatch');
  if (watch) {
    watch.onclick = () => {
      const added = toggleWatch(code);
      watch.textContent = added ? '★ 已自选' : '☆ 自选';
      watch.classList.toggle('is-on', added);
      toast(added ? '已加入自选（选股页可看）' : '已移出自选');
    };
  }
  const addPort = document.getElementById('addPort');
  if (addPort) addPort.onclick = () => openBuyModal(code);
}

export async function renderStock() {
  const code = codeFromHash();
  const q = quote(code);
  if (!q) {
    return `<div class="page-head"><h1 class="page-title">个股</h1><div class="page-sub">${esc(code)} 没有行情（可能退市/停牌）</div></div>${searchBar()}`;
  }
  const d = divSummary(code);
  const pctData = await loadDyPct().catch(() => ({}));
  const daily = await loadDaily(code);
  let days = daily && daily.cal ? daily.cal.map((d, i) => (daily.c[i] == null ? null : [d, daily.o[i], daily.h[i], daily.l[i], daily.c[i], daily.v[i] || 0])).filter(Boolean) : [];
  let chartSource = days.length ? '日 K' : '';
  if (!days.length) {
    // 离线且没有本地日 K：用月线近似，保证图不白
    try {
      const months = await loadMonthly();
      const rows = months[code] || [];
      days = rows.map(([ym, close]) => [ym + '-28', close, close, close, close, 0]);
      chartSource = '月线（离线近似）';
    } catch (e) { chartSource = ''; }
  }
  const v = verdict(code, q, d, pctData[code] ?? null);
  const dps = d?.years?.[d.lastY] || 0;
  const high = dps > 0 ? dps / 0.05 : null;
  window.__stockMarks = dps > 0 ? [
    { value: dps / 0.065, label: '6.5% 股息率' },
    { value: dps / 0.05, label: '5.0% 股息率' },
  ] : [];
  const realChart = `${chartPanel(code, days, chartSource)}`;
  return `<div class="page-head fade-in">
    <div>
      <h1 class="page-title">个股</h1>
      <div class="page-sub">真实行情 ${esc(db.generated)} · 分红历史 · 财报 ${v.hasFin ? '已导入' : '缺失'}</div>
    </div>
    <div class="page-actions">
      <button class="btn ghost ${isWatched(code) ? 'is-on' : ''}" id="addWatch">${isWatched(code) ? '★ 已自选' : '☆ 自选'}</button>
      <button class="btn primary" id="addPort">${icon('plus')} 加入组合</button>
    </div>
  </div>
  ${searchBar()}
  ${chips(code)}
  ${verdictPanel(code, q, d, v)}
  <div class="split" style="margin-top:14px">
    ${factorsPanel(code, q, d, v)}
    ${divHistory(d)}
  </div>
  ${realChart}
  <div style="margin-top:14px" class="banner">
    ${icon('info')}
    <div>财报覆盖 ${dataMeta().finCount} / ${dataMeta().poolCount}。没有财报的股票，四层因子只算分红、价格两项，结论固定「数据不足」，不输出买卖。</div>
  </div>`;
}
