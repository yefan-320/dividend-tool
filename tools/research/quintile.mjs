/**
 * 股息率分档测试：每年 4 月末，把过筛候选按当期股息率分 5 档，
 * 等权持有 12 个月（含分红），看每档的真实年收益。
 * 用来回答：单纯「股息率越高越好」到底成不成立。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const D = (p) => path.join(ROOT, p);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const pool = readJson(D('data/pool.json'));
const bench = readJson(D('data/benchmark.json')).bench;
const codes = fs.readdirSync(D('data/monthly')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 6));

const prices = new Map();
const firstYm = new Map();
for (const code of codes) {
  const rows = readJson(D(`data/monthly/${code}.json`));
  if (!rows?.length) continue;
  prices.set(code, new Map(rows));
  firstYm.set(code, rows[0][0]);
}
const divs = new Map();
const fins = new Map();
for (const code of prices.keys()) {
  if (fs.existsSync(D(`data/div/${code}.json`))) divs.set(code, readJson(D(`data/div/${code}.json`)));
  if (fs.existsSync(D(`data/fin/${code}.json`))) fins.set(code, readJson(D(`data/fin/${code}.json`)));
}

const YM = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const isST = (n = '') => /ST|退/.test(n);
const mb = (a, b) => {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return by * 12 + bm - (ay * 12 + am);
};
const pxAt = (code, ym) => {
  const m = prices.get(code);
  const v = m?.get(ym);
  if (v) return v;
  let best = null, bestYm = null;
  for (const [k, p] of m) if (k <= ym && (!bestYm || k > bestYm)) { best = p; bestYm = k; }
  return best;
};
const dpsYear = (c, y) => divs.get(c)?.years?.[y] ?? null;
function consecutiveYears(code, year) {
  let n = 0;
  for (let y = year; y >= year - 30; y--) { if (dpsYear(code, y) > 0) n++; else break; }
  return n;
}

const MIN_DY = 4, MIN_YEARS = 5, MAX_PAYOUT = 80, MIN_PAYOUT = 10, MIN_ROE = 8, MIN_COVER = 0.7;

function candidates(year) {
  const ym = YM(year, 4);
  const out = [];
  for (const code of prices.keys()) {
    const info = pool[code];
    if (!info || isST(info.n)) continue;
    const px = prices.get(code).get(ym);
    if (!(px > 0)) continue;
    if (mb(firstYm.get(code), ym) < 24) continue;
    const dps = dpsYear(code, year - 1);
    if (!(dps > 0)) continue;
    if (consecutiveYears(code, year - 1) < MIN_YEARS) continue;
    const fin = (fins.get(code) || []).find((r) => r[0] === year - 1);
    if (!fin) continue;
    const [, eps, roe, , , ocfps] = fin;
    if (!(eps > 0)) continue;
    const payout = (dps / eps) * 100;
    if (payout > MAX_PAYOUT || payout < MIN_PAYOUT) continue;
    if (ocfps != null && ocfps / eps < MIN_COVER) continue;
    if (roe != null && roe < MIN_ROE) continue;
    const dy = (dps / px) * 100;
    if (dy < MIN_DY) continue;
    out.push({ code, name: info.n, dy, px });
  }
  return out;
}

/** 持有 12 个月收益：价格变化 + 分红/买入价 */
function fwdReturn(code, ym) {
  const [y] = ym.split('-').map(Number);
  const end = YM(y + 1, 4);
  const p0 = pxAt(code, ym);
  const p1 = pxAt(code, end);
  if (!(p0 > 0) || !(p1 > 0)) return null;
  let div = 0;
  for (const [d, v] of divs.get(code)?.ev || []) {
    if (d.slice(0, 7) > ym && d.slice(0, 7) <= end) div += v;
  }
  return p1 / p0 - 1 + div / p0;
}

const years = [];
for (let y = 2014; y <= 2025; y++) years.push(y);
const QUINT = 5;
const buckets = Array.from({ length: QUINT }, () => []);
const byYear = {};

for (const y of years) {
  const c = candidates(y).sort((a, b) => b.dy - a.dy);
  if (c.length < QUINT * 2) continue;
  byYear[y] = [];
  for (let q = 0; q < QUINT; q++) {
    const lo = Math.floor((c.length * q) / QUINT), hi = Math.floor((c.length * (q + 1)) / QUINT);
    const grp = c.slice(lo, hi);
    const rs = grp.map((s) => fwdReturn(s.code, YM(y, 4))).filter((v) => v != null);
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    buckets[q].push(avg);
    byYear[y][q] = { avg, dyLow: grp.at(-1).dy, dyHigh: grp[0].dy, n: grp.length };
  }
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const geo = (arr) => Math.pow(arr.reduce((s, v) => s * (1 + v), 1), 1 / arr.length) - 1;
const benchFwd = (ym) => {
  const [y] = ym.split('-').map(Number);
  return bench[YM(y + 1, 4)] / bench[ym] - 1;
};
const nY = Object.keys(byYear).length;

console.log(`样本 ${nY} 年（每年 4 月末调仓，持有 12 个月，等权、含分红）`);
console.log('');
console.log('五等分          股息率区间       算术均值   几何年化   跑赢基准');
for (let q = 0; q < QUINT; q++) {
  const all = buckets[q];
  const lows = Object.values(byYear).map((r) => r[q]?.dyLow).filter(Number.isFinite);
  const highs = Object.values(byYear).map((r) => r[q]?.dyHigh).filter(Number.isFinite);
  const wins = Object.entries(byYear).filter(([y, r]) => r[q] && r[q].avg > benchFwd(YM(Number(y), 4))).length;
  console.log(
    `第${q + 1}档(最高到最低)  ${(highs.reduce((a, b) => a + b, 0) / highs.length).toFixed(1)}%–${(lows.reduce((a, b) => a + b, 0) / lows.length).toFixed(1)}%`.padEnd(24) +
    `${pct(all.reduce((a, b) => a + b, 0) / all.length).padStart(8)}   ${pct(geo(all)).padStart(7)}   ${wins}/${nY}`
  );
}

// 固定区间
const EDGES = [4, 4.5, 5, 5.5, 6, 6.5, 7, 8, 9, 99];
const fixed = EDGES.slice(0, -1).map(() => []);
const fixedN = EDGES.slice(0, -1).map(() => 0);
for (const y of years) {
  const c = candidates(y);
  for (const s of c) {
    const r = fwdReturn(s.code, YM(y, 4));
    if (r == null) continue;
    let i = EDGES.findIndex((e, k) => k < EDGES.length - 1 && s.dy >= e && s.dy < EDGES[k + 1]);
    if (i < 0) continue;
    fixed[i].push(r);
    fixedN[i]++;
  }
}
console.log('');
console.log('固定区间      样本数(股票·年)   算术均值   几何年化');
for (let i = 0; i < fixed.length; i++) {
  if (!fixed[i].length) continue;
  const a = fixed[i].reduce((x, y) => x + y, 0) / fixed[i].length;
  console.log(
    `${EDGES[i]}%–${EDGES[i + 1] === 99 ? '∞' : EDGES[i + 1] + '%'}`.padEnd(14) +
    `${String(fixedN[i]).padStart(8)}        ${pct(a).padStart(7)}   ${pct(geo(fixed[i])).padStart(7)}`
  );
}

console.log('');
console.log('逐年（第1档=股息率最高）');
console.log('年份   ' + Array.from({ length: QUINT }, (_, i) => `第${i + 1}档`.padStart(8)).join('') + '    基准');
for (const y of Object.keys(byYear)) {
  const r = byYear[y];
  console.log(`${y}  ` + r.map((x) => pct(x.avg).padStart(8)).join('') + '  ' + pct(benchFwd(YM(Number(y), 4))).padStart(7));
}
