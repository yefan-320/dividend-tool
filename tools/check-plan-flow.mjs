#!/usr/bin/env node
/**
 * 执行清单端到端检查（真机 + 引擎交叉验证）：
 *
 *  1. 用真实行情/分红数据，在 Node 侧用 engine/plan.js 独立算出「方案 → 执行清单」的期望值
 *     （目标/差额/建议股数/本轮买入/现金缺口）；
 *  2. 浏览器里写入同一方案与账本，打开「我的 → 组合方案 → 执行清单」，
 *     逐项核对页面渲染数值与引擎期望一致；
 *  3. 覆盖三种节奏（once / dip 未触发）+ 现金充足/不足两种账本 + 「记一笔」落账。
 *
 * 前置：8766 静态服务 + Chrome 9222（D3_SITE / D3_CDP_PORT 可覆盖）。
 * 用法：node tools/check-plan-flow.mjs   （失败 exit 1）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const PORT = process.env.D3_CDP_PORT || '9222';

const readData = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const quotesData = readData('quotes.json').quotes;
const dividendsData = readData('baseline.json').dividends;
const { planActionRows, normalizePlan } = await import(path.join(ROOT, 'src/engine/plan.js'));

/* ---------- 期望值（Node 侧独立计算） ---------- */
function buildPlan(extra = {}) {
  return normalizePlan({
    id: 'p-e2e',
    name: 'E2E 测试方案',
    capital: 1000000,
    holdings: [{ code: '600036', weight: 50 }, { code: '601398', weight: 50 }],
    entry: { mode: 'once', months: 12, minDy: 5.5 },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...extra,
  });
}
const oncePlan = buildPlan();
const dipPlan = buildPlan({ entry: { mode: 'dip', months: 12, minDy: 20 } });
const onceAct = planActionRows({ plan: oncePlan, positions: new Map(), quotes: quotesData, dividends: dividendsData, buyCap: null });
const needCash = onceAct.rows
  .filter((r) => r.sugSide === 'buy' && r.sugShares > 0)
  .reduce((s, r) => s + r.sugShares * r.price, 0);
const expected = {
  rows: onceAct.rows.map((r) => ({ code: r.code, side: r.sugSide, shares: r.sugShares, price: r.price })),
  needCashWan: (needCash / 1e4).toFixed(1),
};
const cashLow = 100000;
const shortfallWan = ((Math.max(0, needCash - cashLow)) / 1e4).toFixed(1);

/* ---------- CDP 连接 ---------- */
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('找不到 Chrome 页面 target，请确认 Chrome 已启动'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const send = (method, params = {}) => new Promise((res, rej) => {
  const my = ++id;
  pending.set(my, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id: my, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

const BASE = SITE + (SITE.includes('?') ? '&' : '?') + 'nosw=1&theme=dark';
const failures = [];
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ' ' + detail : ''));
};

// 备份 localStorage 的 d3:*
await send('Page.navigate', { url: BASE + '#mine' });
await sleep(1500);
const backup = await evalJs(`(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('d3:')) o[k] = localStorage.getItem(k); } return JSON.stringify(o); })()`);

async function seed({ plans, txs, cash }) {
  await evalJs(`(() => {
    localStorage.setItem('d3:plans', ${JSON.stringify(JSON.stringify(plans))});
    localStorage.setItem('d3:txs', ${JSON.stringify(JSON.stringify(txs))});
    localStorage.setItem('d3:cash', ${JSON.stringify(String(cash))});
    return 1;
  })()`);
}
async function openDetail(planId = 'p-e2e') {
  await send('Page.navigate', { url: BASE + '&t=' + Date.now() + '#mine?view=plans' });
  await sleep(3500);
  const clicked = await evalJs(`(() => { const b = document.querySelector('[data-plan-use="${planId}"]'); if (!b) return false; b.click(); return true; })()`);
  await sleep(1200);
  return clicked;
}
async function readDetail() {
  return JSON.parse(await evalJs(`(() => {
    const hero = [...document.querySelectorAll('.plan-exec-hero .pstat')].map((p) => ({
      k: p.querySelector('.pstat-k')?.textContent.trim(),
      v: p.querySelector('.pstat-v')?.textContent.trim(),
      s: p.querySelector('.pstat-s')?.textContent.trim() || '',
    }));
    const rows = [...document.querySelectorAll('.plan-exec-table tbody tr')].map((tr) => ({
      cells: [...tr.children].map((td) => (td.textContent || '').replace(/\\s+/g, ' ').trim()),
    }));
    const buys = [...document.querySelectorAll('.plan-exec-table [data-buy]')].map((b) => ({
      code: b.dataset.buy, shares: Number(b.dataset.shares), price: Number(b.dataset.price),
    }));
    const warn = [...document.querySelectorAll('.banner.warn')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim());
    return JSON.stringify({ hero, rows, buys, warn });
  })()`));
}
const heroOf = (hero, key) => hero.find((h) => h.k === key) || null;

try {
  /* ---------- 1) once：现金不足 ---------- */
  await seed({ plans: [oncePlan], txs: [], cash: cashLow });
  const okOpen = await openDetail();
  check('执行清单可打开', okOpen);
  const d1 = await readDetail();
  check('清单行数 = 方案成分数', d1.rows.length === expected.rows.length, `${d1.rows.length} vs ${expected.rows.length}`);
  for (const exp of expected.rows) {
    const buy = d1.buys.find((b) => b.code === exp.code);
    const row = d1.rows.find((r) => r.cells[0]?.includes(exp.code) || r.cells[0]?.includes(quotesData[exp.code]?.n || ''));
    const cellText = row ? row.cells[7] : '';
    const uiShares = buy ? buy.shares : null;
    const sideText = exp.side === 'buy' ? '买' : exp.side === 'sell' ? '卖' : '—';
    const sharesOk = uiShares === exp.shares && cellText.includes(String(exp.shares));
    check(`建议 ${exp.code} ${sideText} ${exp.shares} 股（引擎交叉验证）`, sharesOk, `UI=${uiShares} cell="${cellText}"`);
  }
  const heroBuy = heroOf(d1.hero, '本轮买入');
  check('本轮买入金额与引擎一致', !!heroBuy && heroBuy.v.startsWith(expected.needCashWan), `UI=${heroBuy?.v} 期望≈${expected.needCashWan} 万`);
  const shortfallBanner = d1.warn.find((t) => t.includes('差 '));
  check('现金不足提示出现且金额正确', !!shortfallBanner && shortfallBanner.includes(shortfallWan + ' 万'), shortfallBanner || '无 warn banner');

  /* ---------- 2) once：现金充足 ---------- */
  await seed({ plans: [oncePlan], txs: [], cash: 2000000 });
  await openDetail();
  const d2 = await readDetail();
  const warn2 = d2.warn.filter((t) => t.includes('差 '));
  check('现金充足时不再提示缺口', warn2.length === 0, warn2.join(' | '));
  check('本轮买入金额不变', (heroOf(d2.hero, '本轮买入')?.v || '').startsWith(expected.needCashWan), `UI=${heroOf(d2.hero, '本轮买入')?.v}`);

  /* ---------- 3) 「记一笔」落账 ---------- */
  const firstBuy = d2.buys[0];
  check('存在可买入的建议行', !!firstBuy, JSON.stringify(firstBuy));
  if (firstBuy) {
    await evalJs(`(() => { const b = document.querySelector('.plan-exec-table [data-buy="${firstBuy.code}"]'); b.click(); return 1; })()`);
    await sleep(600);
    const modal = JSON.parse(await evalJs(`JSON.stringify({
      open: !!document.querySelector('.modal.show'),
      shares: document.getElementById('buyShares')?.value,
      price: document.getElementById('buyPrice')?.value,
    })`));
    check('买入弹层预填建议股数/价格', modal.open && Number(modal.shares) === firstBuy.shares && Number(modal.price) === firstBuy.price, JSON.stringify(modal));
    await evalJs(`(() => { const b = document.querySelector('.modal-actions [data-act="1"]'); if (!b) return false; b.click(); return true; })()`);
    await sleep(800);
    const txs = JSON.parse(await evalJs(`localStorage.getItem('d3:txs') || '[]'`));
    check('「记一笔」写入账本且股数/价格正确', txs.length === 1 && txs[0].code === firstBuy.code && txs[0].shares === firstBuy.shares && txs[0].price === firstBuy.price, JSON.stringify(txs[0] || null));
  }

  /* ---------- 4) dip 未触发 ---------- */
  await seed({ plans: [dipPlan], txs: [], cash: 2000000 });
  await openDetail();
  const d3 = await readDetail();
  check('dip 未触发时没有买入按钮', d3.buys.length === 0, `buys=${d3.buys.length}`);
  const dipHero = heroOf(d3.hero, '建仓节奏');
  check('dip 显示「股息率门槛」节奏', !!dipHero && dipHero.v.includes('股息率'), dipHero?.v);
  const dipBuy = heroOf(d3.hero, '本轮买入');
  check('dip 未触发时本轮买入为 0', !!dipBuy && /0(\.0)? 万/.test(dipBuy.v), dipBuy?.v);
} finally {
  try {
    await evalJs(`(() => {
      const keep = JSON.parse(${JSON.stringify(backup || '{}')});
      for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('d3:') && !(k in keep)) localStorage.removeItem(k); }
      for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v);
      return 1;
    })()`);
  } catch (e) { /* ignore */ }
  ws.close();
}

if (failures.length) {
  console.log('\n✗ 执行清单端到端检查失败：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\n✓ 执行清单端到端检查通过（引擎期望 vs 页面渲染一致，含现金缺口与落账）。');
