#!/usr/bin/env node
/**
 * 页面「点了之后对不对」的端到端检查。
 *
 * 为什么需要它：181 个单测全在测引擎，冒烟只测「页面能不能渲染出来」，
 * 中间那一层——用户点完之后结果对不对——过去一条断言都没有。
 * 于是这类问题全从这个缝里漏出去：
 *   · 排序切走再切回「结论优先」，榜单反向，首屏全是「回避」
 *   · 9 张指标卡里 2 张没有 data-metric，点了不亮、不弹、不滚
 *   · 回撤体检写「一共 3 次」，下面只列 2 行
 *   · 弹层连开关几次之后，rAF 回调读已置空的引用，控制台红字
 *   · 个股回测开了定投，「累计收益」还按「期末 ÷ 本金」算，把追加的钱算成收益
 *
 * 检查内容：
 *  1. 扫描榜：切到别的排序再切回「结论优先」，首行必须是「可买」；
 *  2. 扫描榜：按支付率排序，第一行不能是分母坏掉的异常值（>500%）；
 *  3. 回测页：每张指标卡都有 data-metric，点下去都要出图；
 *  4. 回撤体检：声明「一共 N 次」时，列表行数 = min(N-1, 4)，且文案说清最深那次在哪；
 *  5. 弹层：连续开关 5 次不抛异常；
 *  6. 个股回测：开月追加后，「累计收益」不再等于「期末 ÷ 本金」。
 *
 * 前置：8766 静态服务 + Chrome 9222（D3_SITE / D3_CDP_PORT 可覆盖）。
 * 用法：node tools/check-ui-state.mjs   （失败 exit 1）
 */
import { cdpConnect, sleep } from './lib/cdp.mjs';

const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const BASE = SITE + (SITE.includes('?') ? '&' : '?') + 'offline=1&nosw=1&theme=dark';

/* ---------- CDP ---------- */
const errors = [];
const { send, evalJs, close } = await cdpConnect({
  onEvent: (m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  },
});
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const failures = [];
const check = (name, ok, detail) => {
  if (ok) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name}${detail ? ' · ' + detail : ''}`); failures.push(name); }
};

let seq = 0;
async function goto(hash, wait = 2600) {
  const url = BASE + '&_t=' + Date.now() + '-' + (++seq) + '#' + hash;
  await send('Page.navigate', { url });
  await sleep(wait);
}

/* ---------- 1·2 扫描榜 ---------- */
console.log('\n[1/6] 扫描榜排序');
await goto('scan', 3200);
await new Promise((r) => setTimeout(r, 300));

const sortState = await evalJs(`(async () => {
  const S = (ms) => new Promise(r => setTimeout(r, ms));
  const first = () => {
    const tr = document.querySelector('tbody tr[data-code]');
    const pill = tr && tr.querySelector('.pill');
    return { pill: pill ? pill.textContent.trim() : null, name: tr ? tr.querySelector('.name')?.textContent.trim() : null };
  };
  const out = { initial: first() };
  const sel = document.getElementById('scanSort');
  if (!sel) return { error: '没有排序下拉框' };
  sel.value = 'dy'; sel.dispatchEvent(new Event('change')); await S(1100);
  out.afterDy = first();
  const sel2 = document.getElementById('scanSort');
  sel2.value = 'level'; sel2.dispatchEvent(new Event('change')); await S(1100);
  out.backToLevel = first();
  out.state = typeof scanState !== 'undefined' ? scanState.sort : null;
  return out;
})()`);

check('默认首行是「可买」', sortState?.initial?.pill === '可买', `实际 ${sortState?.initial?.pill} / ${sortState?.initial?.name}`);
check('切到「股息率」后首行变化（说明排序真的生效）', sortState?.afterDy?.pill !== sortState?.initial?.pill,
  `切前 ${sortState?.initial?.pill} 切后 ${sortState?.afterDy?.pill}`);
check('切回「结论优先」首行仍是「可买」', sortState?.backToLevel?.pill === '可买',
  `实际 ${sortState?.backToLevel?.pill} / ${sortState?.backToLevel?.name}——这就是「切一次排序就永久反向」的老 bug`);

console.log('\n[2/6] 支付率排序不吃坏数据');
const payoutState = await evalJs(`(async () => {
  const S = (ms) => new Promise(r => setTimeout(r, ms));
  const sel = document.getElementById('scanSort');
  if (!sel) return { error: '没有排序下拉框' };
  sel.value = 'payout'; sel.dispatchEvent(new Event('change')); await S(1200);
  const rows = [...document.querySelectorAll('tbody tr[data-code]')].slice(0, 5);
  return rows.map(tr => {
    const tds = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
    return { name: tr.querySelector('.name')?.textContent.trim(), tds };
  });
})()`);
const payoutCells = Array.isArray(payoutState)
  ? payoutState.map((r) => r.tds.find((t) => /%$|异常|^—$/.test(t)) || '')
  : [];
const badPayout = /\d{4,}%/.test(JSON.stringify(payoutState || ''));
check('按支付率排序时前 5 行没有四位数以上的支付率', !badPayout,
  '第一行支付率是 ' + (payoutState?.[0] ? JSON.stringify(payoutState[0].tds) : '?') + '（EPS 接近 0 时分母会炸）');

/* ---------- 3 指标卡 ---------- */
console.log('\n[3/6] 回测页指标卡逐张可点');
await goto('backtest?mode=port', 3600);
await sleep(1400);
const metricState = await evalJs(`(async () => {
  const S = (ms) => new Promise(r => setTimeout(r, ms));
  const cards = [...document.querySelectorAll('.bt-metric')];
  const noKey = cards.filter(c => !c.dataset.metric).map(c => c.querySelector('.k')?.textContent.trim());
  const dead = [];
  for (const c of cards) {
    if (!c.dataset.metric) continue;
    // 换一张卡之前先清掉上一张的详情，不然「有内容」可能来自上一张
    const box = document.getElementById('metricDetail');
    if (box) box.innerHTML = '';
    c.click();
    await S(700);
    const b = document.getElementById('metricDetail');
    if (!b || !b.querySelector('canvas')) dead.push(c.querySelector('.k')?.textContent.trim());
  }
  return { total: cards.length, noKey, dead };
})()`);
check('每张指标卡都有 data-metric', (metricState?.noKey || []).length === 0,
  '没有 data-metric 的是：' + JSON.stringify(metricState?.noKey));
check('每张指标卡点下去都出图', (metricState?.dead || []).length === 0,
  '点了没出图：' + JSON.stringify(metricState?.dead));

/* ---------- 4 回撤体检 ---------- */
console.log('\n[4/6] 回撤体检：说几次就列几行');
const ddState = await evalJs(`(() => {
  const lh = document.querySelector('.dd-lh');
  if (!lh) return { missing: true };
  const text = lh.textContent.trim();
  const m = text.match(/一共\\s*(\\d+)\\s*次/);
  const list = lh.parentElement;
  const rows = list.querySelectorAll('.dd-row').length;
  return { text, n: m ? Number(m[1]) : null, rows };
})()`);
if (ddState?.missing) {
  check('回撤体检存在（本区间至少一次跌超 15%）', false, '没找到 .dd-lh，可能是区间太短或单边上涨');
} else {
  check('声明的次数与列表行数对得上', ddState.n != null && ddState.rows === Math.min(ddState.n - 1, 4),
    `写着 ${ddState.n} 次，列了 ${ddState.rows} 行（最深那次是上面的大数字，不该重复列）`);
  check('文案说清最深那次在哪', /最深那次|上面/.test(ddState.text), `实际文案：「${ddState.text}」`);
}

/* ---------- 5 弹层连续开关 ---------- */
console.log('\n[5/6] 弹层连续开关不抛异常');
const beforeErr = errors.length;
await goto('scan', 3200);
await sleep(500);
const modalState = await evalJs(`(async () => {
  const S = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('tbody tr[data-code] [data-buy]');
  if (!btn) return { error: '找不到买入按钮' };
  let opened = 0;
  for (let i = 0; i < 5; i++) {
    btn.click();
    await S(40);                       // 故意在 rAF / 60ms 聚焦定时器还没跑完时就关掉
    const close = document.querySelector('.modal-close');
    if (close) close.click();
    await S(320);                      // 关闭有 200ms 收尾动画，等它把节点摘掉
    if (!document.querySelector('.modal')) opened++;
  }
  return { opened };
})()`);
check('连续开关 5 次全部关闭干净', modalState?.opened === 5, JSON.stringify(modalState));
const modalErrs = errors.slice(beforeErr).filter((e) => /classList|null|modal/i.test(e));
check('开关弹层不抛异常', modalErrs.length === 0, modalErrs.slice(0, 2).join(' | '));

/* ---------- 6 个股回测的收益口径 ---------- */
console.log('\n[6/6] 个股回测：开定投后收益口径');
await goto('backtest?mode=stock&code=000333', 4200);
await sleep(1200);
const stockState = await evalJs(`(async () => {
  const S = (ms) => new Promise(r => setTimeout(r, ms));
  const numOf = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/-?\\d+(\\.\\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const readHero = () => {
    const cards = [...document.querySelectorAll('.stat')];
    const ret = cards.find(c => /累计收益/.test(c.querySelector('.stat-label')?.textContent || ''));
    return { ret: ret ? ret.querySelector('.stat-value')?.textContent.trim() : null,
             sub: ret ? ret.querySelector('.stat-sub')?.textContent.trim() : null };
  };
  const readCards = () => {
    const out = {};
    for (const c of document.querySelectorAll('.bt-metric')) {
      const k = c.querySelector('.k')?.textContent.trim();
      const v = c.querySelector('.v')?.textContent.trim();
      const s = c.querySelector('.s')?.textContent.trim();
      out[k] = { v, s };
    }
    return out;
  };
  const noAdd = { hero: readHero(), cards: readCards() };

  // 打开参数抽屉，点「5千」月追加快捷
  const more = document.getElementById('btMore');
  if (more) { more.click(); await S(500); }
  const chip = [...document.querySelectorAll('button')].find(b => /^5千$/.test(b.textContent.trim()));
  if (!chip) return { error: '找不到「5千」月追加快捷', noAdd };
  chip.click();
  await S(3200);
  const withAdd = { hero: readHero(), cards: readCards() };
  return { noAdd, withAdd };
})()`);

if (stockState?.error) {
  check('个股回测能开月追加', false, stockState.error);
} else {
  const w = stockState.withAdd;
  const heroRet = Number(String(w.hero.ret || '').replace(/[+%]/g, ''));
  const totalIn = Number(String(w.cards['累计投入']?.v || '').replace(/[^\d.-]/g, ''));
  const end = Number(String(w.cards['期末']?.v || '').replace(/[^\d.-]/g, ''));
  const deduct = totalIn > 0 ? ((end - totalIn) / totalIn) * 100 : null;
  // 旧口径：期末 ÷ 本金 − 1；新口径：期末 ÷ 总投入 − 1。两者在开了定投之后差很多。
  const gap = deduct == null || !isFinite(heroRet) ? null : Math.abs(heroRet - deduct);
  check('开了定投后「累计收益」按总投入算（不是期末÷本金）', gap != null && gap <= 2.5,
    `hero 显示 ${w.hero.ret}，按「期末−投入 / 投入」应是 ${deduct == null ? '?' : deduct.toFixed(1)}%，差 ${gap == null ? '?' : gap.toFixed(1)}pp`);
  check('卡片副标题说清了计算口径', /扣除追加|本金口径/.test(w.hero.sub || ''), `实际副标题：「${w.hero.sub}」`);
  const grew = Number(String(w.cards['累计投入']?.v || '').replace(/[^\d.-]/g, '')) >
    Number(String(stockState.noAdd.cards['累计投入']?.v || '').replace(/[^\d.-]/g, ''));
  check('月追加真的进了「累计投入」', grew, `不追加 ${stockState.noAdd.cards['累计投入']?.v} → 追加后 ${w.cards['累计投入']?.v}`);
}

/* ---------- 汇总 ---------- */
const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
check('全程无 console.error / 未捕获异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length} 项失败：`);
  for (const f of failures) console.error('  · ' + f);
  close();
  process.exit(1);
}
console.log('页面交互状态检查全部通过。');
close();
process.exit(0);
