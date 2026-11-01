/**
 * 全站冒烟测试：5 个页面 + 选股 4 视图 + 我的 3 视图 + 个股自选/买入 + 回测 3 tab + 深浅色 + 移动端。
 * 运行前先启动 8766 与 Chrome 9222：node tools/smoke-all.mjs
 * 用 ?offline=1 强制走本地快照：冒烟只验证页面/交互/渲染，不依赖外网；
 * 否则腾讯日 K 请求一旦挂起（最长 12s 超时），对比图这类按需联网的图表会随机超时。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../report/design');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.resolve(OUT, '..'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:8766/?theme=dark&nosw=1&offline=1';
let bust = 0;
let ws = null;
let send = null;
let evalJs = null;
const results = [];
const errors = [];

async function connect() {
  const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  send = (method, params = {}) => new Promise((res, rej) => {
    const my = ++id;
    pending.set(my, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
}

async function waitReady(timeout = 18000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const ok = await evalJs("!!document.querySelector('.page-title') && (document.getElementById('app')||{}).innerHTML.length > 300");
      if (ok) return Date.now() - t0;
    } catch {}
    await sleep(150);
  }
  return -1;
}

async function nav(hash, retry = 1) {
  for (let attempt = 0; attempt <= retry; attempt++) {
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: BASE + '&t=' + (++bust) + hash });
    const ms = await waitReady();
    if (ms > 0) {
      await sleep(800);
      return ms;
    }
    // 超时：记录现场，刷新后再试一次
    try {
      const diag = await evalJs("document.body.innerText.slice(0, 200)");
      console.log('  [nav retry]', hash, 'body=', String(diag).replace(/\s+/g, ' ').slice(0, 80));
    } catch {}
    if (attempt < retry) {
      await send('Page.reload', { ignoreCache: true });
      const ms2 = await waitReady();
      if (ms2 > 0) { await sleep(800); return ms2; }
    }
  }
  return -1;
}

function ok(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log((pass ? '✓' : '✗'), name, detail);
}

async function scenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(name, false, e.message);
  }
}

async function main() {
  await connect();
  // 清掉 Service Worker / Cache，避免测到旧代码；?nosw=1 会阻止本次注册
  try {
    await send('Page.navigate', { url: BASE + '&t=0#today' });
    await sleep(2500);
    await evalJs("(async()=>{ if(navigator.serviceWorker){const rs=await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r=>r.unregister()));} if(window.caches){const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k)));} return true;})()");
  } catch (e) {}
  // 备份本地数据，测试结束还原
  const backup = await evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('d3:')).map(k=>[k,localStorage.getItem(k)])))`);
  const restore = async () => {
    await evalJs(`(()=>{const keep=${JSON.stringify(backup)}; for(let i=localStorage.length-1;i>=0;i--){const k=localStorage.key(i); if(k&&k.startsWith('d3:')) localStorage.removeItem(k);} const obj=JSON.parse(keep||'{}'); for(const k in obj) localStorage.setItem(k,obj[k]); })()`);
  };

  // ---------- 1. 五个页面 ----------
  for (const [hash, title] of [['#today', '今天'], ['#scan', '选股'], ['#stock?code=600036', '个股'], ['#backtest', '回测'], ['#mine', '我的组合']]) {
    await scenario('页面 ' + title, async () => {
      const ms = await nav(hash);
      const t = await evalJs("(document.querySelector('.page-title')||{}).textContent");
      ok('页面 ' + title, t === title && ms > 0, `title=${t} load=${ms}ms`);
    });
  }

  // ---------- 2. 选股四视图 ----------
  await nav('#scan');
  await scenario('扫描榜', async () => {
    const rows = await evalJs("document.querySelectorAll('.scan-table tbody tr').length");
    ok('扫描榜 100 行', rows === 100, `rows=${rows}`);
    const stars = await evalJs("document.querySelectorAll('.icon-star').length");
    ok('自选按钮', stars > 10, `stars=${stars}`);
  });
  await scenario('排序', async () => {
    await evalJs("document.querySelector('[data-sort=\"consec\"]').click()");
    await sleep(2500);
    const first = await evalJs("document.querySelector('.scan-table tbody tr td:nth-child(4)')?.textContent");
    ok('按连续分红排序', /\d+ 年/.test(first || ''), `first=${first}`);
  });
  await scenario('条件选股', async () => {
    await nav('#scan');
    await evalJs("document.querySelector('[data-view=\"cond\"]').click()");
    await sleep(2500);
    const has = await evalJs("!!document.getElementById('cfApply')");
    ok('条件面板', has);
    await evalJs("document.getElementById('cfDy').value='6'; document.getElementById('cfApply').click()");
    await sleep(2500);
    const count = await evalJs("document.querySelector('.cond-count')?.textContent || ''");
    ok('条件过滤生效', /命中/.test(count), count.trim());
  });
  await scenario('多股对比', async () => {
    // 对比标签池 = 已选 + 自选 + 持仓 + 热榜；先塞两只「本地有日 K」的自选，
    // 保证对比图不依赖外网（离线快照里只带 7 只演示股的日 K）
    await evalJs(`localStorage.setItem('d3:watch', JSON.stringify(['600036','601398','601318']))`);
    await nav('#scan?view=cmp');
    await sleep(1200);
    const chips = await evalJs("document.querySelectorAll('[data-cmp]').length");
    ok('对比标签', chips > 0, `chips=${chips}`);
    await evalJs(`(()=>{for(const c of ['600036','601398']){const b=document.querySelector('[data-cmp="'+c+'"]'); if(b) b.click();}})()`);
    // 等图表出现（最多 12s），不靠固定 sleep 赌加载速度
    let canvas = 0;
    for (let i = 0; i < 60; i++) {
      canvas = await evalJs("document.querySelectorAll('#cmpChart canvas').length");
      if (canvas > 0) break;
      await sleep(200);
    }
    ok('对比图', canvas > 0, `canvas=${canvas}`);
    // 还原自选，后面的「自选」场景默认从空列表开始
    await evalJs(`localStorage.removeItem('d3:watch')`);
  });
  await scenario('自选', async () => {
    await nav('#scan');
    // 在扫描榜给第一只加自选
    await evalJs("document.querySelector('.scan-table tbody tr .icon-star').click()");
    await sleep(1800);
    await evalJs("document.querySelector('[data-view=\"watch\"]').click()");
    await sleep(2500);
    const rows = await evalJs("document.querySelectorAll('#scanBody .table tbody tr').length");
    ok('自选列表', rows >= 1, `rows=${rows}`);
    // 移除
    await evalJs("document.querySelector('#scanBody .icon-star')?.click()");
    await sleep(1800);
    const empty = await evalJs("(document.querySelector('.empty-block')||{}).textContent || ''");
    ok('自选可移除', /还没有自选/.test(empty), empty.trim().slice(0, 20));
  });

  // ---------- 3. 个股：自选 + 买入弹层 ----------
  await nav('#stock?code=600036');
  await scenario('个股自选', async () => {
    const before = await evalJs("(document.getElementById('addWatch')||{}).textContent");
    await evalJs("document.getElementById('addWatch').click()");
    await sleep(600);
    const after = await evalJs("(document.getElementById('addWatch')||{}).textContent");
    ok('个股加自选', after.includes('已自选') && before !== after, `${before}→${after}`);
    await evalJs("document.getElementById('addWatch').click()");
  });
  await scenario('买入弹层', async () => {
    const n0 = await evalJs("JSON.parse(localStorage.getItem('d3:txs')||'[]').length");
    await evalJs("document.getElementById('addPort').click()");
    await sleep(600);
    const shown = await evalJs("!!document.querySelector('.modal.show')");
    ok('买入弹层弹出', shown);
    await evalJs("document.getElementById('buyShares').value='200'; document.getElementById('buyPrice').value='43.55';");
    await evalJs("document.querySelector('.modal [data-act=\"1\"]').click()");
    await sleep(2500);
    const n1 = await evalJs("JSON.parse(localStorage.getItem('d3:txs')||'[]').length");
    ok('买入写入账本', n1 === n0 + 1, `txs ${n0}→${n1}`);
    await restore();
    await sleep(1200);
  });

  // ---------- 4. 回测三 tab ----------
  await nav('#backtest');
  await scenario('回测-组合', async () => {
    const charts = await evalJs("document.querySelectorAll('.chart canvas').length");
    const hero = await evalJs("(document.querySelector('.hero-line')||{}).textContent || ''");
    ok('组合回测图', charts >= 4, `canvas=${charts} hero=${hero.slice(0, 30)}`);
  });
  await scenario('回测-个股', async () => {
    await evalJs("document.querySelector('[data-btmode=\"stock\"]').click()");
    await sleep(6000);
    const charts = await evalJs("document.querySelectorAll('.chart canvas').length");
    ok('个股回测图', charts >= 2, `canvas=${charts}`);
  });
  await scenario('回测-对比', async () => {
    await evalJs("document.querySelector('[data-btmode=\"cmp\"]').click()");
    await sleep(7000);
    const rows = await evalJs("document.querySelectorAll('.table tbody tr').length");
    const canvas = await evalJs("document.querySelectorAll('#cmpChart canvas').length");
    ok('组合对比', rows >= 3 && canvas > 0, `rows=${rows} canvas=${canvas}`);
  });

  // ---------- 5. 我的三视图 ----------
  await nav('#mine');
  await scenario('我的-总账', async () => {
    const rows = await evalJs("document.querySelectorAll('.lot-table tbody tr').length");
    const tabs = await evalJs("document.querySelectorAll('[data-mview]').length");
    ok('账本与 tab', rows >= 1 && tabs === 3, `rows=${rows} tabs=${tabs}`);
  });
  await scenario('我的-方案', async () => {
    await evalJs("document.querySelector('[data-mview=\"plans\"]').click()");
    await sleep(1500);
    await evalJs("document.getElementById('planCreate').click()");
    await sleep(900);
    const inEditor = await evalJs("!!document.querySelector('.editor-basics')");
    ok('方案编辑器', inEditor);
    for (const code of ['600036', '601398']) {
      await evalJs("document.getElementById('edAddStock').click()");
      await sleep(250);
      await evalJs(`(()=>{const i=document.getElementById('pickQ'); i.value='${code}'; i.dispatchEvent(new Event('input')); return true;})()`);
      await sleep(200);
      await evalJs(`document.querySelector('[data-pick="${code}"]').click()`);
      await sleep(700);
    }
    const rows = await evalJs("document.querySelectorAll('.plan-edit-row').length");
    ok('添加股票到方案', rows === 2, `rows=${rows}`);
    await evalJs("document.querySelector('[data-entry=\"staged\"]').click()");
    await sleep(500);
    await evalJs("(()=>{const i=document.getElementById('edMonths'); i.value='12'; i.dispatchEvent(new Event('change')); return true;})()");
    await sleep(500);
    const months = await evalJs("document.getElementById('edMonths')?.value");
    ok('建仓节奏分批', String(months) === '12', `months=${months}`);
    await evalJs("(()=>{const i=document.getElementById('edName'); i.value='冒烟方案'; i.dispatchEvent(new Event('input')); return true;})()");
    await evalJs("document.getElementById('edSave').click()");
    await sleep(1300);
    const n = await evalJs("document.querySelectorAll('.plan-card').length");
    const saved = await evalJs("[...document.querySelectorAll('.plan-name')].some(e=>e.textContent==='冒烟方案')");
    ok('保存方案', n >= 1 && saved, `plans=${n} saved=${saved}`);
    const card = "[...document.querySelectorAll('.plan-card')].find(c=>c.querySelector('.plan-name')?.textContent==='冒烟方案')";
    await evalJs(`(${card}).querySelector('[data-plan-use]').click()`);
    await sleep(1200);
    const execRows = await evalJs("document.querySelectorAll('.plan-exec-table tbody tr').length");
    const stats = await evalJs("document.querySelectorAll('.pstat').length");
    ok('执行清单', execRows === 2 && stats === 6, `rows=${execRows} stats=${stats}`);
    const batch = await evalJs("[...document.querySelectorAll('.pstat')].find(x=>x.textContent.includes('本轮买入'))?.textContent.includes('按 12 期拆开买')");
    ok('分批本轮预算', batch);
    await evalJs("document.getElementById('detailBack').click()");
    await sleep(900);
    await evalJs(`(${card}).querySelector('[data-plan-del]').click()`);
    await sleep(400);
    await evalJs("document.querySelector('.modal [data-act=\"1\"]').click()");
    await sleep(1200);
    const n2 = await evalJs("document.querySelectorAll('.plan-card').length");
    ok('删除方案', n2 === n - 1, `plans ${n}→${n2}`);
  });
  await scenario('我的-设置', async () => {
    await evalJs("document.querySelector('[data-mview=\"settings\"]').click()");
    await sleep(2000);
    await evalJs("document.getElementById('setExpense').value='5000'; document.getElementById('setExpense').dispatchEvent(new Event('change'))");
    await sleep(400);
    const v = await evalJs("JSON.parse(localStorage.getItem('d3:settings')||'{}').expense");
    ok('月支出保存', Number(v) === 5000, `expense=${v}`);
    const cells = await evalJs("document.querySelectorAll('.health-cell').length");
    ok('数据健康', cells >= 6, `cells=${cells}`);
    await restore();
  });

  // ---------- 6. 深浅色 ----------
  await nav('#today');
  await scenario('浅色主题', async () => {
    for (let i = 0; i < 20; i++) {
      if (await evalJs("!!document.getElementById('themeBtn')")) break;
      await sleep(250);
    }
    await evalJs("document.getElementById('themeBtn').click()");
    await sleep(2000);
    const theme = await evalJs("document.documentElement.dataset.theme");
    const bg = await evalJs("getComputedStyle(document.body).backgroundColor");
    ok('切浅色', theme === 'light', `theme=${theme} bg=${bg}`);
    await evalJs("document.getElementById('themeBtn').click()");
    await sleep(800);
  });

  // ---------- 7. 移动端 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  for (const [hash, title] of [['#today', '今天'], ['#scan', '选股'], ['#stock?code=600036', '个股'], ['#backtest', '回测'], ['#mine', '我的组合']]) {
    await scenario('移动端 ' + title, async () => {
      await nav(hash);
      let t = '';
      for (let i = 0; i < 40; i++) {
        t = await evalJs("(document.querySelector('.page-title')||{}).textContent");
        if (t === title) break;
        await sleep(250);
      }
      const overflow = await evalJs("document.documentElement.scrollWidth - window.innerWidth");
      ok('移动端 ' + title, t === title && overflow <= 2, `title=${t} overflow=${overflow}px`);
      // 移动端截图由 tools/shot.js 统一产出，冒烟只检查不落盘
    });
  }
  await send('Emulation.clearDeviceMetricsOverride');

  // ---------- 汇总 ----------
  await restore();
  const failed = results.filter((r) => !r.pass);
  const realErrors = errors.filter((e) => !/favicon|ERR_/.test(e));
  console.log('\n=== 结果 ===');
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(' ✗', f.name, f.detail);
  }
  if (realErrors.length) {
    console.log('控制台错误：');
    for (const e of realErrors.slice(0, 10)) console.log(' ', e);
  } else {
    console.log('控制台错误：none');
  }
  fs.writeFileSync(path.join(OUT, '../smoke-all.json'), JSON.stringify({ results, errors: realErrors }, null, 2));
  ws.close();
  if (failed.length || realErrors.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
