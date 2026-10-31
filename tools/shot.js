/* 视觉稿截图：node shot.js */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 截图用的演示方案（不依赖浏览器里已有的数据；截完不动用户数据，因为只写 d3:plans 一次）
const DEMO_PLAN = JSON.stringify([{
  id: 'demo-plan', name: '红利五虎', capital: 1000000,
  holdings: [
    { code: '600036', weight: 20 }, { code: '601398', weight: 20 }, { code: '601318', weight: 15 },
    { code: '600887', weight: 15 }, { code: '601088', weight: 15 }, { code: '600900', weight: 15 },
  ],
  entry: { mode: 'staged', months: 12, minDy: 5.5 },
  createdAt: '2026-11-01', updatedAt: '2026-11-01',
}]);
const seedPlans = `localStorage.setItem('d3:plans', ${JSON.stringify(DEMO_PLAN)});`;

const scenes = [
  { name: 'today-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=1#today', w: 1280, h: 900, wait: 4000 },
  { name: 'scan-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=2#scan', w: 1280, h: 1000, wait: 7500 },
  { name: 'scan-cond-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=3#scan?view=cond', w: 1280, h: 1000, wait: 7500 },
  { name: 'scan-cmp-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=4#scan?view=cmp&cmp=600036,601318,600941', w: 1280, h: 1000, wait: 8000 },
  { name: 'stock-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=5#stock?code=600036', w: 1280, h: 1000, wait: 5000 },
  { name: 'backtest-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=6#backtest', w: 1280, h: 1000, wait: 8000 },
  { name: 'backtest-stock-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=7#backtest?mode=stock&code=601398', w: 1280, h: 1000, wait: 8000 },
  { name: 'backtest-cmp-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=8#backtest?mode=cmp', w: 1280, h: 1000, wait: 9000 },
  { name: 'mine-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=9#mine', w: 1280, h: 1000, wait: 4500 },
  { name: 'mine-plans-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=10#mine?view=plans', w: 1280, h: 1000, wait: 4500,
    act: seedPlans + "location.hash='#mine?view=plans&s=1';", after: 1600 },
  { name: 'mine-plans-editor-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=18#mine?view=plans', w: 1280, h: 1100, wait: 4500,
    act: seedPlans + "location.hash='#mine?view=plans&mode=edit&plan=demo-plan';", after: 1600 },
  { name: 'mine-plans-detail-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=19#mine?view=plans', w: 1280, h: 1100, wait: 4500,
    act: seedPlans + "location.hash='#mine?view=plans&mode=detail&plan=demo-plan';", after: 1800 },
  { name: 'mine-settings-desktop', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=11#mine?view=settings', w: 1280, h: 1000, wait: 4500 },
  { name: 'today-mobile', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=12#today', w: 390, h: 844, wait: 4000 },
  { name: 'scan-mobile', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=13#scan', w: 390, h: 844, wait: 7500 },
  { name: 'stock-mobile', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=14#stock?code=600036', w: 390, h: 844, wait: 5000 },
  { name: 'backtest-mobile', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=15#backtest', w: 390, h: 844, wait: 8000 },
  { name: 'mine-mobile', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=16#mine', w: 390, h: 844, wait: 4500 },
  { name: 'mine-plans-mobile', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=20#mine?view=plans', w: 390, h: 900, wait: 4500,
    act: seedPlans + "location.hash='#mine?view=plans&s=1';", after: 1600 },
  { name: 'mine-plans-detail-mobile', url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=21#mine?view=plans', w: 390, h: 900, wait: 4500,
    act: seedPlans + "location.hash='#mine?view=plans&mode=detail&plan=demo-plan';", after: 1800 },
  { name: 'today-light', url: 'http://127.0.0.1:8766/?theme=light&nosw=1&t=17#today', w: 1280, h: 900, wait: 4000 }
];

(async () => {
  const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') events.push('console.error');
    if (m.method === 'Runtime.exceptionThrown') events.push(m.params.exceptionDetails.text + ': ' + (m.params.exceptionDetails.exception || {}).description);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const rawSend = (method, params = {}) => new Promise((res, rej) => {
    const my = ++id;
    pending.set(my, m => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const send = (method, params = {}, ms = 20000) => Promise.race([
    rawSend(method, params),
    new Promise((_, rej) => setTimeout(() => rej(new Error(method + ' timeout')), ms)),
  ]);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // 清 Service Worker，避免截图拿到旧缓存
  try {
    await send('Page.navigate', { url: 'http://127.0.0.1:8766/?theme=dark&nosw=1&t=0#today' });
    await sleep(2500);
    await send('Runtime.evaluate', { expression: "(async()=>{ if(navigator.serviceWorker){const rs=await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r=>r.unregister()));} if(window.caches){const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k)));} return true;})()", awaitPromise: true });
  } catch (e) {}
  const outDir = path.resolve(__dirname, '../../report/design');
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of scenes) {
    await send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: s.w < 600 });
    await send('Network.clearBrowserCache');
    await send('Page.navigate', { url: s.url });
    await sleep(s.wait || 3500);
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      for (let i = 0; i < 24; i++) {
        try {
          const r = await send('Runtime.evaluate', { expression: "!!document.querySelector('.page-title') && (document.getElementById('app')||{}).innerHTML.length > 200", returnByValue: true }, 8000);
          if (r.result && r.result.value) { ok = true; break; }
        } catch (e) {}
        await sleep(500);
      }
      if (!ok) {
        // 偶发连接重置：整页重载再等一次
        console.log('  retry load', s.name);
        try { await send('Page.reload', { ignoreCache: true }); } catch (e) {}
        await sleep(2500);
      }
    }
    if (s.act) {
      try { await send('Runtime.evaluate', { expression: s.act }); } catch (e) { console.log('act failed', s.name, e.message); }
      await sleep(s.after || 5000);
    }
    await sleep(1400);

    const full = s.w >= 600 && !s.viewport;
    const mh = await send('Runtime.evaluate', { expression: 'Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)', returnByValue: true });
    const contentH = (mh.result && mh.result.value) || s.h;
    const height = full ? Math.min(7000, Math.max(s.h, contentH)) : s.h;
    if (full) {
      await send('Emulation.setDeviceMetricsOverride', { width: s.w, height, deviceScaleFactor: 1, mobile: false });
      await sleep(700);
      await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
      await sleep(500);
    }
    // 等两帧确保重绘完成，再截图；空白帧自动重试
    try {
      await send('Runtime.evaluate', { expression: 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))', awaitPromise: true }, 6000);
    } catch (e) {}
    await sleep(300);
    let shot = null;
    for (let i = 0; i < 5; i++) {
      try { shot = await send('Page.captureScreenshot', { format: 'png' }, 15000); } catch (e) { shot = null; }
      if (shot?.data && shot.data.length >= 20000) break;
      await sleep(900);
      try { await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' }, 5000); } catch (e) {}
    }
    if (!shot?.data) { console.log('  capture failed', s.name); continue; }
    const file = path.join(outDir, s.name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(s.name, `${s.w}x${height}`, file);
  }
  console.log('errors:', events.length ? events.slice(0, 10) : 'none');
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
