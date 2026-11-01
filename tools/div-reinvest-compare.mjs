#!/usr/bin/env node
/**
 * 多股票分红复投快测：验证「按除息日（=分红到账日）收盘价买入」是否可行、效果如何。
 *
 * 口径：
 *  - 起点 2023-11-01 收盘一次性买入 10 万元（100 股整数倍，零钱留现金）
 *  - 每次除息日把现金红利按当日收盘价买入（100 股整数倍，零钱留现金）
 *  - 持股 > 1 年免红利税（招行公告口径）；可传参改税率
 *  - 对照：同一笔本金、分红只留现金不再投
 *  - 买点对比：除息日开盘 / 收盘 / 次日收盘 / 延后 5 日收盘
 *
 * 数据：
 *  - 日 K（不复权，含开盘）：腾讯 newfqkline，区间一次拉全
 *  - 除息日与每股派息：东方财富 RPT_SHAREBONUS_DET（只取已实施）
 *
 * 用法：
 *   node tools/div-reinvest-compare.mjs              # 默认 6 只：工行/移动/美的/平安/伊利/招行
 *   node tools/div-reinvest-compare.mjs 601398 600519  # 指定代码
 *   TAX=0.10 node tools/div-reinvest-compare.mjs     # 扣 10% 红利税
 */
const START = '2023-11-01';
const END = '2026-10-30';
const CAP = 100000;
const LOT = 100;
const TAX = Number(process.env.TAX ?? 0);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

const DEFAULT = [
  ['601398', '工商银行'],
  ['600941', '中国移动'],
  ['000333', '美的集团'],
  ['601318', '中国平安'],
  ['600887', '伊利股份'],
  ['600036', '招商银行'],
];
const args = process.argv.slice(2).filter((a) => /^\d{6}$/.test(a));
const STOCKS = args.length ? args.map((c) => [c, c]) : DEFAULT;

const fmt = (x) => Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function qqCode(code) {
  return (/^[69]/.test(code) ? 'sh' : 'sz') + code;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fetchBars(code) {
  const qc = qqCode(code);
  const j = await getJson(`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${qc},day,${START},${END},900,`);
  const arr = j?.data?.[qc]?.day;
  if (!Array.isArray(arr) || !arr.length) throw new Error(code + ' 无日 K');
  return arr
    .map((r) => ({ date: r[0], open: Number(r[1]), close: Number(r[2]) }))
    .filter((b) => b.close > 0 && b.date >= START && b.date <= END); // 腾讯会多给前置数据，裁掉
}

async function fetchDividends(code) {
  const j = await getJson(
    `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=-1&pageSize=100&pageNumber=1&reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE%3D%22${code}%22)`
  );
  const rows = (j?.result?.data || []).filter((r) => r.EX_DIVIDEND_DATE && r.PRETAX_BONUS_RMB);
  const byDate = new Map();
  for (const r of rows) {
    const d = r.EX_DIVIDEND_DATE.slice(0, 10);
    if (d <= START || d > END) continue;
    byDate.set(d, (byDate.get(d) || 0) + Number(r.PRETAX_BONUS_RMB) / 10); // 10 派 X 元 → 每股
  }
  return [...byDate.entries()].map(([date, dps]) => ({ date, dps })).sort((a, b) => a.date.localeCompare(b.date));
}

function run(bars, events, mode) {
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const p0 = bars[0].close;
  const startSh = Math.floor(CAP / p0 / LOT) * LOT;
  let sh = startSh;
  const idle = CAP - sh * p0;   // 初始凑不满一手的零钱：两边都只留现金，不参与复投
  let divCash = 0;              // 分红现金池：只由分红补充，凑满一手才买
  const rows = [];
  for (const e of events) {
    const i = idx.get(e.date);
    if (i == null) { rows.push({ ...e, skipped: true }); continue; }
    const price = mode === 'open' ? bars[i].open
      : mode === 'next' ? bars[Math.min(i + 1, bars.length - 1)].close
      : mode === 'd5' ? bars[Math.min(i + 5, bars.length - 1)].close
      : bars[i].close;
    const net = sh * e.dps * (1 - TAX);
    divCash += net;
    const budget = divCash;
    const buy = Math.floor(budget / price / LOT) * LOT;
    divCash = budget - buy * price;
    sh += buy;
    rows.push({ ...e, price, net, buy, sh, divCash });
  }
  const endPx = bars[bars.length - 1].close;
  return { rows, sh, idle, divCash, mv: sh * endPx + idle + divCash, startSh, p0, endPx };
}

const summary = [];
for (const [code, name] of STOCKS) {
  const bars = await fetchBars(code);
  const events = await fetchDividends(code);
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const r = run(bars, events, 'close');
  const rOpen = run(bars, events, 'open');
  const rNext = run(bars, events, 'next');
  const rD5 = run(bars, events, 'd5');
  let holdCash = 0;
  for (const e of events) holdCash += r.startSh * e.dps * (1 - TAX);
  const noReMV = r.startSh * r.endPx + r.idle + holdCash;
  const ret = r.mv / CAP - 1;
  const retHold = noReMV / CAP - 1;

  console.log(`\n===== ${name} ${code} =====`);
  console.log(`期初 ${bars[0].date} 收盘 ${r.p0.toFixed(2)}，期末 ${r.endPx.toFixed(2)}，纯股价 ${pct(r.endPx / r.p0 - 1)}；初始 ${fmt(r.startSh)} 股`);
  console.log('除息日核对（参考价 = 前收 − 每股分红）：');
  for (const e of events) {
    const i = idx.get(e.date);
    if (i == null) { console.log(`  ${e.date} 每股 ${e.dps.toFixed(4)} ⚠ 不在日 K 中`); continue; }
    const prev = bars[i - 1].close;
    const ref = prev - e.dps;
    console.log(`  ${e.date}  每股 ${e.dps.toFixed(4)}  前收 ${prev.toFixed(2)} 参考价 ${ref.toFixed(3)}  开盘 ${bars[i].open.toFixed(2)}(${pct(bars[i].open / ref - 1)})  收盘 ${bars[i].close.toFixed(2)}(${pct(bars[i].close / ref - 1)})`);
  }
  console.log(`分红 ${events.length} 次，累计 ${fmt(holdCash)} 元`);
  console.log(`复投(收盘买) ${r.sh} 股 + 分红池现金 ${fmt(r.divCash)} + 初始零钱 ${fmt(r.idle)} = ${fmt(r.mv)} 元，收益 ${pct(ret)}`);
  console.log(`不复投      ${r.startSh} 股 + 分红现金 ${fmt(holdCash)} + 初始零钱 ${fmt(r.idle)} = ${fmt(noReMV)} 元，收益 ${pct(retHold)}`);
  console.log(`买点对比：开盘 ${pct(rOpen.mv / CAP - 1)} | 收盘 ${pct(ret)} | 次日 ${pct(rNext.mv / CAP - 1)} | 延5日 ${pct(rD5.mv / CAP - 1)}`);

  summary.push({ name, code, p0: r.p0, endPx: r.endPx, priceRet: r.endPx / r.p0 - 1, n: events.length, div: holdCash, ret, retHold, rOpen: rOpen.mv / CAP - 1, rNext: rNext.mv / CAP - 1, rD5: rD5.mv / CAP - 1, startSh: r.startSh, endSh: r.sh });
  await sleep(300);
}

console.log(`\n========== 汇总（本金 ${fmt(CAP)} 元，收盘买，红利税 ${(TAX * 100).toFixed(0)}%） ==========`);
console.log('股票      代码    期初价 期末价  股价涨跌  分红次数 累计分红  复投收益  不复投   复投增强');
for (const s of summary) {
  console.log(`${s.name.padEnd(5, '　')} ${s.code}  ${s.p0.toFixed(2).padStart(6)} ${s.endPx.toFixed(2).padStart(6)}  ${pct(s.priceRet).padStart(8)}  ${String(s.n).padStart(4)}  ${fmt(s.div).padStart(7)}  ${pct(s.ret).padStart(8)}  ${pct(s.retHold).padStart(8)}  ${pct(s.ret - s.retHold).padStart(8)}`);
}
const avg = summary.reduce((a, s) => a + (s.ret - s.retHold), 0) / summary.length;
console.log(`\n平均复投增强：${pct(avg)}（${summary.filter((s) => s.ret > s.retHold).length}/${summary.length} 只增强）`);
console.log('\n买点敏感性（复投收益）：');
console.log('股票      开盘买    收盘买    次日买    延5日买   收盘−开盘');
for (const s of summary) {
  console.log(`${s.name.padEnd(5, '　')} ${pct(s.rOpen).padStart(8)}  ${pct(s.ret).padStart(8)}  ${pct(s.rNext).padStart(8)}  ${pct(s.rD5).padStart(8)}  ${pct(s.ret - s.rOpen).padStart(8)}`);
}
