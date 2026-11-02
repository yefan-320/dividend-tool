/**
 * 高稳定分红模型研究脚本（离线跑，不进前端包）
 *
 * 目的：用一个「简单、可解释」的筛选模型精选 A 股长期高分红股，
 * 回测 2014-2026，看清它的收益来源与回撤形状。
 *
 * 用法：node tools/research/model.mjs [--n=10] [--dy=4] [--years=5] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const D = (p) => path.join(ROOT, p);
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const NUM = (k, d) => Number(arg(k, d));

const CFG = {
  n: NUM('n', 10),
  minDy: NUM('dy', 4),
  minYears: NUM('years', 5),
  maxPayout: NUM('maxpayout', 80),
  minPayout: NUM('minpayout', 10),
  minRoe: NUM('roe', 8),
  minCover: NUM('cover', 0.7),
  maxDy: NUM('maxdy', 12),
  minHist: NUM('hist', 24),
  startYear: NUM('start', 2014),
  endYear: NUM('end', 2026),
  cost: NUM('cost', 0.002),
  rebalanceMonth: NUM('month', 4),
  indCap: NUM('indcap', 3),
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ---------- 载入 ----------
const pool = readJson(D('data/pool.json'));
const monthlyCodes = fs
  .readdirSync(D('data/monthly'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, 6));

const prices = new Map();
const firstYm = new Map();
for (const code of monthlyCodes) {
  const rows = readJson(D(`data/monthly/${code}.json`));
  if (!Array.isArray(rows) || !rows.length) continue;
  prices.set(code, new Map(rows));
  firstYm.set(code, rows[0][0]);
}

const divs = new Map();
const fins = new Map();
for (const code of prices.keys()) {
  const dp = D(`data/div/${code}.json`);
  if (fs.existsSync(dp)) divs.set(code, readJson(dp));
  const fp = D(`data/fin/${code}.json`);
  if (fs.existsSync(fp)) fins.set(code, readJson(fp));
}

const index = readJson(D('data/index.json')).index;
const bench = readJson(D('data/benchmark.json')).bench;

const YM = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const isST = (name = '') => /ST|退/.test(name);
const monthsBetween = (a, b) => {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return by * 12 + bm - (ay * 12 + am);
};

/** 某月末收盘；缺月回溯到最近一期 */
function pxAt(code, ym) {
  const m = prices.get(code);
  if (!m) return null;
  const v = m.get(ym);
  if (v) return v;
  let best = null, bestYm = null;
  for (const [k, p] of m) {
    if (k <= ym && (!bestYm || k > bestYm)) { best = p; bestYm = k; }
  }
  return best;
}

// ---------- 筛选 ----------
const finAt = (code, year) => (fins.get(code) || []).find((r) => r[0] === year) || null;
const dpsYear = (code, year) => divs.get(code)?.years?.[year] ?? null;

function consecutiveYears(code, year) {
  let n = 0;
  for (let y = year; y >= year - 30; y--) {
    if (dpsYear(code, y) > 0) n++;
    else break;
  }
  return n;
}

function selectAt(year, ym) {
  const out = [];
  for (const code of prices.keys()) {
    const info = pool[code];
    if (!info || isST(info.n)) continue;
    const px = prices.get(code).get(ym);
    if (!(px > 0)) continue;
    if (monthsBetween(firstYm.get(code), ym) < CFG.minHist) continue;

    const dps = dpsYear(code, year - 1);
    if (!(dps > 0)) continue;
    if (consecutiveYears(code, year - 1) < CFG.minYears) continue;

    const fin = finAt(code, year - 1);
    if (!fin) continue;
    const [, eps, roe, , , ocfps] = fin;
    if (!(eps > 0)) continue;
    const payout = (dps / eps) * 100;
    if (payout > CFG.maxPayout || payout < CFG.minPayout) continue;
    if (ocfps != null && ocfps / eps < CFG.minCover) continue;
    if (roe != null && roe < CFG.minRoe) continue;

    const dy = (dps / px) * 100;
    if (dy < CFG.minDy || dy > CFG.maxDy) continue;

    out.push({ code, name: info.n, ind: info.ind, dy, price: px, dps, eps, roe, payout });
  }
  out.sort((a, b) => b.dy - a.dy);
  const byInd = {};
  const picked = [];
  for (const s of out) {
    byInd[s.ind] = (byInd[s.ind] || 0) + 1;
    if (byInd[s.ind] > CFG.indCap) continue;
    picked.push(s);
    if (picked.length >= CFG.n) break;
  }
  return { cands: out, picked };
}

// ---------- 回测 ----------
const allMonths = Object.keys(bench).sort();
const months = allMonths.filter((m) => {
  const y = Number(m.slice(0, 4));
  return y >= CFG.startYear && y <= CFG.endYear;
});

const divByMonth = new Map(); // code -> Map(ym -> dps)
for (const [code, d] of divs) {
  const m = new Map();
  for (const [date, v] of d.ev || []) {
    const ym = date.slice(0, 7);
    m.set(ym, (m.get(ym) || 0) + v);
  }
  divByMonth.set(code, m);
}

function runBacktest({ reinvest = true, cashWhenSparse = true }) {
  const navs = [];
  let hold = [];
  let cash = 1;
  let divTotal = 0;
  let costPaid = 0;
  const divByYear = {};
  const divByYM = {};
  const cashByYear = {};
  const log = [];

  for (const ym of months) {
    // 1) 收当月分红
    for (const h of hold) {
      const dps = divByMonth.get(h.code)?.get(ym) || 0;
      if (dps <= 0) continue;
      const amt = h.shares * dps;
      divTotal += amt;
      const y = ym.slice(0, 4);
      divByYear[y] = (divByYear[y] || 0) + amt;
      divByYM[ym] = (divByYM[ym] || 0) + amt;
      if (reinvest) {
        const px = pxAt(h.code, ym);
        if (px > 0) h.shares += amt / px;
        else cash += amt;
      } else cash += amt;
    }

    // 2) 4 月末调仓
    const isRebal = ym.slice(5) === String(CFG.rebalanceMonth).padStart(2, '0');
    if (isRebal) {
      const year = Number(ym.slice(0, 4));
      const { picked, cands } = selectAt(year, ym);
      let total = hold.reduce((s, h) => s + h.shares * (pxAt(h.code, ym) || 0), 0) + cash;
      const sellCost = total * CFG.cost;
      costPaid += sellCost;
      total -= sellCost;
      log.push({ ym, year, cands: cands.length, picked: picked.length });

      if (!picked.length) {
        hold = [];
        cash = total;
      } else {
        const each = total / picked.length;
        const bought = [];
        let left = total;
        for (const s of picked) {
          const px = pxAt(s.code, ym);
          if (!(px > 0)) continue;
          const amt = each;
          const c = amt * CFG.cost;
          costPaid += c;
          left -= amt;
          bought.push({ code: s.code, shares: (amt - c) / px });
        }
        hold = bought;
        cash = left;
      }
    }

    const value = hold.reduce((s, h) => s + h.shares * (pxAt(h.code, ym) || 0), 0) + cash;
    cashByYear[ym.slice(0, 4)] = cash;
    navs.push({ ym, nav: value, cash, held: hold.length });
  }
  return { navs, divTotal, costPaid, log, divByYear, divByYM, cashByYear };
}

// ---------- 指标 ----------
function maxDrawdown(navs) {
  let peak = navs[0].nav, peakYm = navs[0].ym;
  let mdd = 0, ddPeak = peakYm, ddTrough = peakYm;
  for (const p of navs) {
    if (p.nav > peak) { peak = p.nav; peakYm = p.ym; }
    const dd = p.nav / peak - 1;
    if (dd < mdd) { mdd = dd; ddPeak = peakYm; ddTrough = p.ym; }
  }
  let longest = 0, longestFrom = null, longestTo = null, underFrom = null;
  let pk = navs[0].nav, pkYm = navs[0].ym;
  for (const p of navs) {
    if (p.nav >= pk) {
      if (underFrom) {
        const len = monthsBetween(underFrom, p.ym);
        if (len > longest) { longest = len; longestFrom = underFrom; longestTo = p.ym; }
        underFrom = null;
      }
      pk = p.nav;
      pkYm = p.ym;
    } else if (!underFrom) underFrom = pkYm;
  }
  if (underFrom) {
    const len = monthsBetween(underFrom, navs.at(-1).ym);
    if (len > longest) { longest = len; longestFrom = underFrom; longestTo = navs.at(-1).ym; }
  }
  return { mdd, ddPeak, ddTrough, longestUnderwater: longest, longestFrom, longestTo };
}

function stats(navs) {
  const first = navs[0], last = navs.at(-1);
  const yrs = monthsBetween(first.ym, last.ym) / 12;
  const cagr = Math.pow(last.nav / first.nav, 1 / yrs) - 1;
  const rets = [];
  for (let i = 1; i < navs.length; i++) rets.push(navs[i].nav / navs[i - 1].nav - 1);
  const dd = maxDrawdown(navs);
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1));
  const vol = sd * Math.sqrt(12);
  const yearly = {};
  const byYear = {};
  for (const p of navs) {
    const y = p.ym.slice(0, 4);
    if (!byYear[y]) byYear[y] = { first: p.nav, last: p.nav };
    byYear[y].last = p.nav;
  }
  for (const [y, v] of Object.entries(byYear)) yearly[y] = v.last / v.first - 1;
  return { cagr, vol, sharpe: (cagr - 0.02) / vol, ...dd, yearly, navs, calmar: cagr / Math.abs(dd.mdd) };
}

// ---------- 跑 ----------
const reinv = runBacktest({ reinvest: true });
const noRev = runBacktest({ reinvest: false });
const s1 = stats(reinv.navs);
const s2 = stats(noRev.navs);
const mkSeries = (m) => months.map((ym) => ({ ym, nav: m[ym] })).filter((p) => Number.isFinite(p.nav));
const sb = stats(mkSeries(bench));
const sh = stats(mkSeries(Object.fromEntries(index.sh000300 || [])));
const sc = stats(mkSeries(Object.fromEntries(index.sh000905 || [])));

const fmtPct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
console.log('配置', JSON.stringify(CFG));
console.log(`期数 ${months.length}  ${months[0]} → ${months.at(-1)}`);
console.log('');
for (const [name, s] of [
  ['复投组合', s1],
  ['不复投组合', s2],
  ['中证红利全收益', sb],
  ['沪深300', sh],
  ['中证500', sc],
]) {
  console.log(
    `${name.padEnd(12)} 年化 ${fmtPct(s.cagr).padStart(7)} 波动 ${fmtPct(s.vol).padStart(6)} 夏普 ${s.sharpe.toFixed(2)} 最大回撤 ${fmtPct(s.mdd).padStart(7)}(${s.ddPeak}→${s.ddTrough}) 卡玛 ${s.calmar.toFixed(2)} 最长水下 ${s.longestUnderwater}月(${s.longestFrom}→${s.longestTo})`
  );
}
console.log('');
console.log('年度收益      复投     不复投   中证红利   沪深300   分红/市值');
for (const y of [...new Set(months.map((m) => m.slice(0, 4)))]) {
  const navAt = (s) => {
    const rows = s.navs.filter((p) => p.ym.startsWith(y));
    return rows.length ? rows.at(-1).nav : null;
  };
  const base = (s) => {
    const rows = s.navs.filter((p) => p.ym.startsWith(y));
    const prev = s.navs.find((p) => p.ym === `${Number(y) - 1}-12`);
    return rows.length && prev ? rows.at(-1).nav / prev.nav - 1 : null;
  };
  const mid = navAt(s1);
  const dy = mid ? (reinv.divByYear[y] || 0) / mid : 0;
  console.log(
    `${y}     ${fmtPct(s1.yearly[y]).padStart(7)}  ${fmtPct(s2.yearly[y]).padStart(7)}  ${fmtPct(sb.yearly[y]).padStart(7)}  ${fmtPct(sh.yearly[y]).padStart(7)}  ${fmtPct(dy).padStart(7)}`
  );
}
console.log('');
console.log('调仓记录');
for (const r of reinv.log) {
  const { picked } = selectAt(r.year, r.ym);
  console.log(`${r.ym} 候选 ${String(r.cands).padStart(3)} → 持 ${r.picked} 只: ` + picked.map((s) => `${s.name}${s.dy.toFixed(1)}%`).join(' '));
}
console.log('');
const yrs = monthsBetween(months[0], months.at(-1)) / 12;
const dyList = Object.keys(reinv.divByYear).map((y) => {
  const end = reinv.navs.filter((p) => p.ym.startsWith(y)).at(-1);
  return end ? reinv.divByYear[y] / end.nav : 0;
});
const dyAvg = dyList.reduce((a, b) => a + b, 0) / dyList.length;
console.log(`累计分红 ${(reinv.divTotal * 100).toFixed(0)}%（占初始本金，${yrs.toFixed(1)}年）；年均分红收益率 ${(dyAvg * 100).toFixed(1)}%`);
console.log(`分红再投多赚 ${((s1.cagr - s2.cagr) * 100).toFixed(2)} 个百分点/年`);
console.log(`累计成本 ${(reinv.costPaid * 100).toFixed(2)}%`);
console.log(`复投终值 ${reinv.navs.at(-1).nav.toFixed(2)}  不复投终值 ${noRev.navs.at(-1).nav.toFixed(2)}`);

// 回撤期分红：最大回撤那段里，净值跌了多少、分红补了多少
const ddFrom = s1.ddPeak, ddTo = s1.ddTrough;
const divInDd = Object.entries(reinv.divByYM)
  .filter(([ym]) => ym >= ddFrom && ym <= ddTo)
  .reduce((s, [, v]) => s + v, 0);
console.log(`\n最大回撤段 ${ddFrom} → ${ddTo}：期间分红累计 ${(divInDd * 100).toFixed(1)}%（占期初净值），相当于回撤被补掉 ${((divInDd / Math.abs(s1.mdd)) * 100).toFixed(0)}%`);

// 与基准的相关性 + 下行捕获
const monthly = (s) => {
  const o = {};
  for (let i = 1; i < s.navs.length; i++) o[s.navs[i].ym] = s.navs[i].nav / s.navs[i - 1].nav - 1;
  return o;
};
const r1 = monthly(s1), rb = monthly(sb);
const common = Object.keys(r1).filter((k) => k in rb);
const downM = common.filter((k) => rb[k] < 0);
const upM = common.filter((k) => rb[k] > 0);
const sum = (o, ks) => ks.reduce((s, k) => s + o[k], 0);
console.log(`下行月捕获 ${(sum(r1, downM) / sum(rb, downM) * 100).toFixed(0)}%  上行月捕获 ${(sum(r1, upM) / sum(rb, upM) * 100).toFixed(0)}%  月度胜率 ${(common.filter((k) => r1[k] > rb[k]).length / common.length * 100).toFixed(0)}%`);

if (arg('json', '')) {
  fs.mkdirSync(D('tools/research/out'), { recursive: true });
  fs.writeFileSync(
    D('tools/research/out/model.json'),
    JSON.stringify(
      {
        cfg: CFG,
        reinv: { ...s1, divTotal: reinv.divTotal, costPaid: reinv.costPaid, divByYear: reinv.divByYear },
        noRev: { ...s2, divTotal: noRev.divTotal },
        bench: sb,
        hs300: sh,
      },
      null,
      1
    )
  );
  console.log('已写 tools/research/out/model.json');
}
