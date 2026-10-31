#!/usr/bin/env node
/**
 * 页面加载性能：冷缓存 / 热缓存各跑一遍，输出每页加载耗时、资源数、传输体积。
 * 运行前启动 8766 与 Chrome 9222。node tools/perf.mjs
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:8766/?theme=dark';
let bust = 0;

const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const page = list.find((t) => t.type === 'page');
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
const evalJs = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: false });

async function measure(hash, { cold = false } = {}) {
  if (cold) {
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await send('Network.clearBrowserCache');
  }
  const t0 = Date.now();
  await send('Page.navigate', { url: `${BASE}&t=${++bust}${hash}` });
  let ready = -1;
  for (let i = 0; i < 600; i++) {
    const ok = await evalJs("!!document.querySelector('.page-title') && (document.getElementById('app')||{}).innerHTML.length > 500");
    if (ok) { ready = Date.now() - t0; break; }
    await sleep(25);
  }
  await sleep(300);
  const info = JSON.parse(await evalJs(`(()=>{
    const res = performance.getEntriesByType('resource');
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const paint = performance.getEntriesByType('paint') || [];
    const marks = Object.fromEntries(performance.getEntriesByType('mark').map(m=>[m.name, Math.round(m.startTime)]));
    const size = (filter) => res.filter(filter).reduce((s,r)=>s+(r.decodedBodySize||0),0);
    return JSON.stringify({
      load: Math.round(nav.loadEventEnd || 0),
      resources: res.length,
      totalKB: Math.round(size(()=>true)/1024),
      dataKB: Math.round(size(r=>r.name.includes('/data/'))/1024),
      jsKB: Math.round(size(r=>r.name.includes('/src/')||r.name.includes('echarts'))/1024),
      coreMs: marks['d3-core-done'] ?? null,
      dataMs: (marks['d3-core-end'] && marks['d3-core-start']) ? marks['d3-core-end'] - marks['d3-core-start'] : null,
      renderMs: marks['d3-first-render'] ?? null,
      dom: document.querySelectorAll('*').length,
      fcp: Math.round((paint.find(p=>p.name==='first-contentful-paint')||{}).startTime || 0),
    });
  })()`));
  return { ready, ...info };
}

const pages = [
  ['今天', '#today'],
  ['选股', '#scan'],
  ['个股', '#stock?code=600036'],
  ['回测', '#backtest'],
  ['我的', '#mine'],
];

const out = [];
console.log('页面      冷加载(ms)  热加载(ms)  首屏渲染(ms)  核心数据(ms)  数据加载(ms)  数据(KB)  JS(KB)  DOM节点  FCP(ms)');
for (const [name, hash] of pages) {
  const cold = await measure(hash, { cold: true });
  await sleep(1200);
  const warm = await measure(hash, { cold: false });
  out.push({ name, hash, cold, warm });
  console.log(
    name.padEnd(8),
    String(cold.ready).padStart(9), String(warm.ready).padStart(9),
    String(warm.renderMs ?? '-').padStart(10), String(warm.coreMs ?? '-').padStart(8),
    String(warm.dataMs ?? '-').padStart(8), (warm.dataKB).toString().padStart(9),
    (warm.jsKB).toString().padStart(7), String(warm.dom).padStart(8), String(warm.fcp).padStart(7),
  );
}
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../report/design/perf.json');
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('\n→ report/design/perf.json');
ws.close();
