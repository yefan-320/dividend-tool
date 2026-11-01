#!/usr/bin/env node
/**
 * 招商银行(600036) 分红复投快测：按「分红到账当天（=除息日）除权后的股价」买入，是否可行、效果如何。
 *
 * 数据：本地不复权日线 data/daily/600036.json（收盘）+ 区间内 4 次真实分红（东财 EX_DIVIDEND_DATE，
 *       除息日开/收盘与腾讯日 K 核对一致）。招行 A 股现金红利发放日 = 除权除息日。
 *
 * 用法：
 *   node tools/quick-cmb-reinvest.mjs            # 免税（持股>1年）
 *   node tools/quick-cmb-reinvest.mjs 0.10       # 扣 10% 红利税（持股 1 个月~1 年）
 *   node tools/quick-cmb-reinvest.mjs 0.20       # 扣 20%（持股<=1个月）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/daily/meta.json'), 'utf8'));
const daily = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/daily/600036.json'), 'utf8'));
const cal = meta.cal;
const close = daily.c;

const START = '2023-11-01';   // 近 3 年
const END = '2026-10-30';
const SH0 = 10000;            // 初始 10,000 股（可改）
const LOT = 100;              // A 股最小买入单位：1 手
const TAX = Number(process.argv[2] ?? 0);

// 区间内招行真实分红（每股税前、除息日、除息日前收/开盘/收盘）
const EVENTS = [
  { date: '2024-07-11', dps: 1.972, prev: 34.68, open: 33.08, close: 32.90, note: '2023 年度' },
  { date: '2025-07-11', dps: 2.000, prev: 48.24, open: 46.28, close: 45.64, note: '2024 年度' },
  { date: '2026-01-16', dps: 1.013, prev: 40.11, open: 39.49, close: 38.72, note: '2025 中期' },
  { date: '2026-07-10', dps: 1.003, prev: 37.55, open: 36.61, close: 36.88, note: '2025 年度' },
];

const i0 = cal.indexOf(START);
const i1 = cal.indexOf(END);
if (i0 < 0 || i1 < 0) throw new Error('区间端点不在交易日历里');
const px = (i) => close[i];
const cost0 = SH0 * px(i0);
const fmt = (x) => x.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 买入时点：open=除息日开盘 / close=除息日收盘 / next=次日收盘 */
function reinvest(mode) {
  let shares = SH0;
  let cash = 0;
  const rows = [];
  for (const e of EVENTS) {
    const ie = cal.indexOf(e.date);
    const price = mode === 'open' ? e.open : mode === 'close' ? e.close : px(Math.min(ie + 1, i1));
    const net = shares * e.dps * (1 - TAX);
    const budget = cash + net;
    const buy = Math.floor(budget / price / LOT) * LOT;
    cash = budget - buy * price;
    shares += buy;
    rows.push({ ...e, price, net, buy, cash, shares });
  }
  const mv = shares * px(i1) + cash;
  return { rows, shares, cash, mv, ret: mv / cost0 - 1 };
}

console.log(`招商银行 600036 · ${START} ~ ${END} · 初始 ${SH0} 股 @ ${px(i0).toFixed(2)} 元 = ${fmt(cost0)} 元 · 红利税 ${(TAX * 100).toFixed(0)}%`);
console.log('\n除息日核对（开盘价 ≈ 前收 − 每股分红，即除权参考价）：');
for (const e of EVENTS) {
  const ref = e.prev - e.dps;
  console.log(`  ${e.date} ${e.note}: 前收 ${e.prev} − 分红 ${e.dps} = ${ref.toFixed(3)}，开盘 ${e.open}（${((e.open / ref - 1) * 100).toFixed(2)}%），收盘 ${e.close}`);
}

const openBuy = reinvest('open');
const closeBuy = reinvest('close');
const holdCash = EVENTS.reduce((s, e) => s + SH0 * e.dps * (1 - TAX), 0);
const noReMV = SH0 * px(i1) + holdCash;

console.log('\n分红到账当天复投（100 股整数倍，余钱留现金）：');
for (const r of openBuy.rows) {
  console.log(`  ${r.date}: 分红 ${fmt(r.net)} 元 → 按开盘 ${r.price} 买 ${r.buy} 股，累计 ${r.shares} 股，余 ${fmt(r.cash)} 元`);
}
console.log(`\n复投(开盘买)  期末 ${openBuy.shares} 股 + 现金 ${fmt(openBuy.cash)} = ${fmt(openBuy.mv)} 元，总收益 ${(openBuy.ret * 100).toFixed(2)}%`);
console.log(`复投(收盘买)  期末 ${closeBuy.shares} 股 + 现金 ${fmt(closeBuy.cash)} = ${fmt(closeBuy.mv)} 元，总收益 ${(closeBuy.ret * 100).toFixed(2)}%`);
console.log(`不复投        期末 ${SH0} 股 + 现金 ${fmt(holdCash)} = ${fmt(noReMV)} 元，总收益 ${((noReMV / cost0 - 1) * 100).toFixed(2)}%`);
console.log(`纯股价        ${px(i0).toFixed(2)} → ${px(i1).toFixed(2)} = ${((px(i1) / px(i0) - 1) * 100).toFixed(2)}%`);
console.log(`复投增强      ${((openBuy.ret - (noReMV / cost0 - 1)) * 100).toFixed(2)} 个百分点`);

// 买点敏感性：每次分红延后 N 个交易日再买
console.log('\n买点敏感性（分红到账后延 N 个交易日再买）：');
for (const delay of [0, 1, 3, 5, 10, 20]) {
  let sh = SH0;
  let ca = 0;
  for (const e of EVENTS) {
    const j = Math.min(cal.indexOf(e.date) + delay, i1);
    const net = sh * e.dps * (1 - TAX);
    const budget = ca + net;
    const p = px(j);
    const buy = Math.floor(budget / p / LOT) * LOT;
    ca = budget - buy * p;
    sh += buy;
  }
  const mv = sh * px(i1) + ca;
  console.log(`  延 ${String(delay).padStart(2)} 日: ${sh} 股，市值 ${fmt(mv)}，收益 ${((mv / cost0 - 1) * 100).toFixed(2)}%`);
}
