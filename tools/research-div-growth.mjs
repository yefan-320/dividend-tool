#!/usr/bin/env node
/**
 * 研究脚本：未上市股票的建仓金额用「组合平均分红增长率」还是「组合净值增长率」？
 *
 * 场景：中国移动 20% / 中国平安 40% / 招商银行 40%，2020-01-02 投入 100 万；
 *       中国移动 2022-01-05 上市，按“上市满 6 个月”在 2022-07-05 建仓。
 *
 * 输出：
 *  1. 2020-2022 组合分红（固定股数 / 分红复投两口径）与平均年增长率
 *  2. 各口径的建仓买入金额、实际股数、建仓后权重
 *  3. 到 2026-10-30 的期末结果对照
 *
 * 运行：node tools/research-div-growth.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildSeries, buildTradingDates } from '../src/engine/market.js';
import { runPortfolioBacktest } from '../src/engine/portfolioBacktest.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const monthly = read('monthly.json').months;
const base = read('baseline.json');
const idx = read('index-daily.json');
const meta = read('daily/meta.json');

const CODES = ['600941', '601318', '600036'];
const series = new Map();
for (const c of CODES) {
  const j = read(`daily/${c}.json`);
  series.set(c, buildSeries({ cal: meta.cal, daily: { cal: meta.cal, ...j }, monthly: monthly[c] }));
}

const FROM = '2020-01-02';
const TO = '2026-10-30';
const BUILD = '2022-07-05'; // 移动 2022-01-05 上市 + 6 个月
const CAPITAL = 1000000;
const dates = buildTradingDates({ indexRows: idx.h00922.rows, dailyCal: meta.cal, monthly, from: FROM, to: TO });
const dps = (c, y) => base.dividends[c]?.years?.[y] || 0;

/* ---------- 1. 2020-2022 组合分红（平安 50 万 + 招行 50 万，整手） ---------- */
const P_PA = 86.12; // 2020-01-02 收盘
const P_ZJ = 38.88;
const SH_PA = Math.floor(500000 / P_PA / 100) * 100;
const SH_ZJ = Math.floor(500000 / P_ZJ / 100) * 100;
const divs = {};
for (const y of [2020, 2021, 2022]) {
  divs[y] = SH_PA * dps('601318', y - 1) + SH_ZJ * dps('600036', y - 1);
}
const g21 = divs[2021] / divs[2020] - 1;
const g22 = divs[2022] / divs[2021] - 1;
const gFixed = (g21 + g22) / 2;
const years = 2.5;

/* ---------- 2. 跑净值口径拿建仓前总资产 T ---------- */
function run(weights) {
  const holdings = Object.entries(weights).map(([code, weight]) => ({ code, weight }));
  return runPortfolioBacktest({
    dates, series, dividends: base.dividends, holdings,
    capital: CAPITAL, monthlyAdd: 0, from: FROM, to: TO, mode: 'invest',
  });
}
const probe = run({ 600941: 20, 601318: 40, 600036: 40 });
const T = probe.nav.find(([d]) => d === BUILD)[1];
const K = T / CAPITAL;

/* ---------- 3. 各口径买入金额 ---------- */
// 现金分红复投后的实际分红增长（用探针引擎的分红现金流，股数随复投增长）
const d0 = probe.divByY[2020];
const gReal21 = probe.divByY[2021] / probe.divByY[2020] - 1;
const gReal22 = probe.divByY[2022] / probe.divByY[2021] - 1;
const gReinvest = (gReal21 + gReal22) / 2;

const SLICE = CAPITAL * 0.2; // 20 万
const buys = {
  净值增长: SLICE * K,
  分红增长_固定股数: SLICE * (1 + gFixed * years),
  分红增长_含复投: SLICE * (1 + gReinvest * years),
  旧版固定: SLICE,
};

/* ---------- 4. 用结构权重模拟每种买入额（拖入引擎保持口径一致） ---------- */
const rows = [];
for (const [name, x] of Object.entries(buys)) {
  const w = (x / T) * 100;
  const other = (100 - w) / 2;
  const r = run({ 600941: w, 601318: other, 600036: other });
  const b = r.builds[0] || { shares: 0, price: 0 };
  const amount = (b.shares * b.price) / 10000;
  const last = r.comp[r.comp.length - 1][1];
  const tot = Object.values(last).reduce((a, v) => a + v, 0);
  const wM = ((last['600941'] || 0) / tot) * 100;
  rows.push({
    name,
    target: x / 10000,
    shares: b.shares,
    amount,
    weightAfter: (x / T) * 100,
    end: r.end / 10000,
    ret: r.stats.ret * 100,
    cagr: r.stats.cagr * 100,
    mdd: r.stats.mdd * 100,
    div: r.totalDiv / 10000,
    wM,
  });
}
const none = run({ 601318: 50, 600036: 50 });

/* ---------- 5. 打印 ---------- */
const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);
console.log('=== 起点（2020-01-02，100 万；移动 20% 摊给平安/招行）===');
console.log(`平安 ${SH_PA} 股 × ${P_PA} = ${f1((SH_PA * P_PA) / 1e4)} 万；招行 ${SH_ZJ} 股 × ${P_ZJ} = ${f1((SH_ZJ * P_ZJ) / 1e4)} 万`);
console.log('\n=== 2020–2022 组合分红（平安/招行 50/50）===');
console.log(`固定股数：2020 ${divs[2020].toFixed(0)} → 2021 ${divs[2021].toFixed(0)} (${(g21 * 100).toFixed(2)}%) → 2022 ${divs[2022].toFixed(0)} (${(g22 * 100).toFixed(2)}%)，平均 ${(gFixed * 100).toFixed(2)}%/年`);
console.log(`含分红复投：2020 ${d0.toFixed(0)} → 2021 ${probe.divByY[2021].toFixed(0)} (${(gReal21 * 100).toFixed(2)}%) → 2022 ${probe.divByY[2022].toFixed(0)} (${(gReal22 * 100).toFixed(2)}%)，平均 ${(gReinvest * 100).toFixed(2)}%/年`);
console.log(`\n=== 建仓日 ${BUILD}：移动上市满 6 个月，组合总值 ${f2(T / 1e4)} 万（K=${K.toFixed(3)}）===`);
console.log('\n口径                         买入金额(万)  实际股数   实际金额(万)  建仓后移动权重');
for (const r of rows) {
  console.log(`${r.name.padEnd(24)} ${f2(r.target).padStart(8)}  ${String(r.shares).padStart(8)}  ${f2(r.amount).padStart(10)}  ${f2(r.weightAfter).padStart(10)}%`);
}
console.log('\n=== 到 2026-10-30 ===');
console.log('口径                         期末(万)  收益%   年化%  回撤%   分红(万)  期末移动权重');
for (const r of rows) {
  console.log(`${r.name.padEnd(24)} ${f1(r.end).padStart(8)}  ${f1(r.ret).padStart(6)}  ${f1(r.cagr).padStart(6)}  ${f1(r.mdd).padStart(6)}  ${f1(r.div).padStart(7)}  ${f1(r.wM).padStart(8)}%`);
}
console.log(`${'完全不买移动（平安/招行 50/50）'.padEnd(24)} ${f1(none.end / 1e4).padStart(8)}  ${f1(none.stats.ret * 100).padStart(6)}  ${f1(none.stats.cagr * 100).padStart(6)}  ${f1(none.stats.mdd * 100).padStart(6)}  ${f1(none.totalDiv / 1e4).padStart(7)}  ${'—'.padStart(8)}`);
console.log('\n注：买入金额 = 100 万 × 20% × (1 + 增长率 × 2.5 年)；实际股数受整手和卖出取整影响。');
