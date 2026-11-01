/**
 * 搜索实测：真浏览器里往输入框打字，看下拉里有没有那只股票。
 *
 * 前置：本地服务 8766 + Chrome 调试口 9222
 *   node /tmp/nocache-gz.mjs <项目根> 8766
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox \
 *     --disable-gpu --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-search-prof about:blank
 *
 * 用法：node tools/check-search.mjs
 *
 * 跑两轮：
 *   1. 手挑的关键词（茅台 / 格力 / 银行 / 白酒 / 部分代码）
 *   2. 从 5552 只里随机抽 40 只，用「全名」和「名字后两个字」各搜一次
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8766';
const IDX = path.resolve(import.meta.dirname, '..', 'data', 'name-idx.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROWS = fs.readFileSync(IDX, 'utf8').split('\n').filter(Boolean).map((l) => {
  const [code, name, ind] = l.split('|');
  return { code, name, ind: ind || '' };
});

/* ---------------- 极简 CDP ---------------- */

let ws, send, evalJs, once;

async function connect() {
  const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用标签页');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) {
      for (const fn of listeners) fn(m);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  once = (method) => new Promise((res) => {
    const fn = (m) => { if (m.method === method) { listeners.delete(fn); res(m); } };
    listeners.add(fn);
  });
  evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
}

async function goto(url, waitMs = 7000) {
  await send('Page.enable');
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await Promise.race([loaded.catch(() => {}), sleep(20000)]);   // 别被一个永不触发的事件卡死
  await sleep(waitMs);
}

/** 等某个选择器出现（最多 ms） */
async function waitSel(sel, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evalJs(`!!document.querySelector(${JSON.stringify(sel)})`)) return true;
    await sleep(400);
  }
  return false;
}

/** 往输入框打完关键词，回来读建议项 */
async function suggest(sel, kw) {
  return evalJs(`(async () => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { err: 'no-input' };
    el.focus();
    el.value = ${JSON.stringify(kw)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const box = el.closest('.stock-search-wrap, .modal-card, .modal-body')?.querySelector('.search-suggest')
      || document.querySelector('#scanSuggest, #stockSuggest, #stSuggest');
    await new Promise(r => setTimeout(r, 60));
    // 索引没到时会有「正在载入」，多等一会儿再读
    for (let i = 0; i < 40; i++) {
      if (!/正在载入/.test(box?.textContent || '')) break;
      await new Promise(r => setTimeout(r, 150));
    }
    const items = [...(box ? box.querySelectorAll('.sg-item:not(.sg-empty):not(.sg-loading)') : [])];
    return {
      items: items.slice(0, 10).map(x => {
        const m = x.querySelector('b'); const s = x.querySelector('span');
        return { name: m ? m.textContent.trim() : x.textContent.trim(), meta: s ? s.textContent.trim() : '' };
      }),
      empty: !!document.querySelector('.sg-item.sg-empty'),
    };
  })()`);
}

/** 组合弹窗用的是常驻列表（.pick-item），单独读 */
async function pickList(kw) {
  return evalJs(`(async () => {
    const el = document.querySelector('#pickQ');
    if (!el) return { err: 'no-modal' };
    el.value = ${JSON.stringify(kw)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return [...document.querySelectorAll('#pickList .pick-item')].slice(0, 10).map(x => ({
      name: (x.querySelector('.pick-name') || x).textContent.trim(),
      meta: (x.querySelector('.pick-code') || { textContent: '' }).textContent.trim(),
    }));
  })()`);
}

/* ---------------- 断言 ---------------- */

const pass = [];
const fail = [];

function check(where, kw, got, wantCode, wantName, { first = false } = {}) {
  const hitCode = got.some((g) => g.meta.includes(wantCode) || g.name === wantName);
  const okFirst = first ? got.length > 0 && got[0].name === wantName : true;
  const tag = `${where} 「${kw}」→ ${wantName} ${wantCode}`;
  if (hitCode && okFirst) { pass.push(tag); if (pass.length <= 60) console.log('  ✓ ' + tag); }
  else {
    const line = `${tag}  实际: ${got.map((g) => g.name + '(' + g.meta + ')').join(' / ') || '（空）'}`;
    fail.push(line);
    console.log('  ✗ ' + line);
  }
}

/* ---------------- 主流程 ---------------- */

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rnd = (n) => {
  const out = [];
  const seen = new Set();
  while (out.length < n) {
    const r = pick(ROWS);
    if (seen.has(r.code) || r.name.length < 3) continue;
    seen.add(r.code);
    out.push(r);
  }
  return out;
};

const bom = `?theme=dark&nosw=1&t=${Date.now()}`;

async function main() {
  await connect();
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });   // 别让浏览器缓存骗人

  /* 预取索引：先开一页让 primeNameIndex 跑 */
  console.log('· 打开选股页');
  await goto(`${BASE}/${bom}#scan`, 9000);
  if (!(await waitSel('#scanSearch', 15000))) throw new Error('选股页搜索框没出来');

  /* ---- 1. 手挑关键词 ---- */
  const manual = [
    { kw: '茅台', code: '600519', name: '贵州茅台', first: true },
    { kw: '格力', code: '000651', name: '格力电器', first: true },
    { kw: '平安', code: '000001', name: '平安银行', first: true },
    { kw: '工行', code: '601398', name: '工商银行', first: true },
    { kw: '招行', code: '600036', name: '招商银行', first: true },
    { kw: '中石化', code: '600028', name: '中国石化', first: true },
    { kw: '建行', code: '601939', name: '建设银行', first: true },
    { kw: '招商银行', code: '600036', name: '招商银行', first: true },
    { kw: '白酒', code: '600519', name: '贵州茅台' },
    { kw: '宁德', code: '300750', name: '宁德时代', first: true },
    { kw: '600519', code: '600519', name: '贵州茅台', first: true },
    // '60051' 单独断言（见下），不按「目标必须在列表里」判
    { kw: '0519', code: '600519', name: '贵州茅台' },
  ];
  for (const m of manual) {
    if (!m.code) continue;                    // 「招行」只记录，不当断言（不在名字里）
    const r = await suggest('#scanSearch', m.kw);
    check('选股页', m.kw, r.items || [], m.code, m.name, { first: m.first });
  }
  // 打一半代码：前 8 条应该都是这个前缀（600519 排第 10，继续打一位就精确）
  const half = await suggest('#scanSearch', '60051');
  const halfOk = (half.items || []).length > 0 && (half.items || []).every((x) => x.meta.startsWith('60051'));
  (halfOk ? pass : fail).push(`选股页 「60051」（半截代码）→ ${(half.items || []).map((x) => x.meta.split(' ')[0]).join(' ')}`);

  /* ---- 2. 随机 40 只：全名 ---- */
  const samples = rnd(30);
  for (const r of samples) {
    const res = await suggest('#scanSearch', r.name);
    check('选股页·全名', r.name, res.items || [], r.code, r.name, { first: true });
  }

  /* ---- 3. 随机 30 只：名字后两个字 ----
     通用后缀（股份/科技/电子/化工…）全市场几十只，8 条上限里当然不一定有它——
     那种只验「能搜出东西」；只对独特后缀断言「必须命中目标」。 */
  const tailCount = new Map();
  for (const r of ROWS) {
    const t = r.name.replace(/\s+/g, '').slice(-2);
    tailCount.set(t, (tailCount.get(t) || 0) + 1);
  }
  for (const r of samples) {
    const tail = r.name.replace(/\s+/g, '').slice(-2);
    const res = await suggest('#scanSearch', tail);
    const items = res.items || [];
    if ((tailCount.get(tail) || 99) <= 6) check('选股页·后两字', tail, items, r.code, r.name);
    else {
      items.length
        ? pass.push(`选股页·后两字 「${tail}」（${tailCount.get(tail)} 只同名后缀）→ 有结果 ${items.length} 条`)
        : fail.push(`选股页·后两字 「${tail}」无结果（这个后缀全市场有 ${tailCount.get(tail)} 只）`);
    }
  }

  /* ---- 4. 行业 ---- */
  const ind = await suggest('#scanSearch', '白酒');
  const indOk = (ind.items || []).length > 0;
  (indOk ? pass : fail).push(`选股页 「白酒」（行业）→ ${ind.items.map((x) => x.name).slice(0, 3).join('/')}`);

  /* ---- 5. 个股页 ---- */
  console.log('· 打开个股页');
  await goto(`${BASE}/${bom}#stock?code=600519`, 8000);
  if (await waitSel('#stockSearch', 25000)) {
    const r = await suggest('#stockSearch', '茅台');
    check('个股页', '茅台', r.items || [], '600519', '贵州茅台', { first: true });
    const g = await suggest('#stockSearch', '格力');
    check('个股页', '格力', g.items || [], '000651', '格力电器', { first: true });
  } else fail.push('个股页 搜索框 25 秒没出来');

  /* ---- 6. 回测页 ---- */
  console.log('· 打开回测页');
  await goto(`${BASE}/${bom}#backtest?mode=stock&code=600519`, 9000);
  if (await waitSel('#stSearch', 25000)) {
    const r = await suggest('#stSearch', '茅台');
    check('回测页', '茅台', r.items || [], '600519', '贵州茅台', { first: true });
    const g = await suggest('#stSearch', '银行');
    (g.items || []).length ? pass.push(`回测页 「银行」→ ${g.items.map((x) => x.name).slice(0, 3).join('/')}`) : fail.push('回测页 「银行」无结果');
  } else fail.push('回测页 搜索框 25 秒没出来');

  /* ---- 7. 组合弹窗（常驻列表） ---- */
  console.log('· 打开组合编辑器');
  await goto(`${BASE}/${bom}#mine?view=plans`, 6000);
  const opened = await evalJs(`(() => {
    const b = document.querySelector('#newPlan, [data-plan-new], [data-new-plan]')
      || [...document.querySelectorAll('button')].find(x => /新建|新建组合|创建组合/.test(x.textContent));
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(1400);
  const addBtn = await evalJs(`(() => {
    const b = document.querySelector('#edAddStock');
    if (b) { b.click(); return true; } return false;
  })()`);
  await sleep(900);
  if (addBtn) {
    const l = await pickList('茅台');
    (Array.isArray(l) && l.some((x) => x.meta.includes('600519')))
      ? pass.push('组合弹窗 「茅台」→ 贵州茅台 600519')
      : fail.push(`组合弹窗 「茅台」  实际: ${JSON.stringify(l).slice(0, 200)}`);
  } else {
    fail.push(`组合编辑器没打开（newPlan=${opened} · edAddStock=${addBtn}）`);
  }

  /* ---- 汇总 ---- */
  console.log(`\n通过 ${pass.length} · 失败 ${fail.length}`);
  if (fail.length) {
    console.log('\n失败明细：');
    fail.forEach((f) => console.log('  ✗ ' + f));
  }
  console.log('\n抽样明细（前 12 条）：');
  pass.slice(0, 12).forEach((p) => console.log('  ✓ ' + p));

  try { ws.close(); } catch (e) {}
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
