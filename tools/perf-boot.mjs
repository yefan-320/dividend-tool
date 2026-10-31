#!/usr/bin/env node
/**
 * 首屏启动测量：弱网 + 降速 CPU 下，导航到站点后多久出现「骨架/侧栏」、多久出现完整页面。
 * 用于验证「先画骨架、不等核心数据」的优化（main.js boot）。
 *
 * 运行前：启动 8766 静态服务与 Chrome 9222（见 README）。
 *   node tools/perf-boot.mjs            # 本地无节流 + 慢 4G 两组
 *   node tools/perf-boot.mjs --slow     # 只跑慢 4G
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:8766/?theme=dark&nosw=1';

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
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const SLOW = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8, // ≈ 1.6 Mbps
  uploadThroughput: (750 * 1024) / 8,
};

/** 清掉本站 Service Worker + CacheStorage，保证是「首次访问」口径而非 SW 缓存 */
async function clearServiceWorker() {
  try {
    await send('Page.navigate', { url: 'http://127.0.0.1:8766/?nosw=1' });
    await sleep(400);
    await evalJs(`(async () => {
      try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); } catch (e) {}
      try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch (e) {}
      return 1;
    })()`);
  } catch (e) { /* 首次没有 SW，忽略 */ }
}

/** 冷缓存导航一次，轮询三个里程碑 */
async function run({ slow = false } = {}) {
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(250);
  await send('Network.clearBrowserCache');
  await clearServiceWorker();
  if (slow) {
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await send('Network.emulateNetworkConditions', SLOW);
  } else {
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }
  const t0 = Date.now();
  await send('Page.navigate', { url: `${BASE}&t=${Date.now()}` });
  let shellMs = -1;
  let skeletonMs = -1;
  let readyMs = -1;
  for (let i = 0; i < 3000; i++) {
    const st = await evalJs(`(()=>{
      const app = document.getElementById('app') || {};
      return JSON.stringify({
        shell: !!document.querySelector('#sidebar .brand'),
        skeleton: !!document.querySelector('.skeleton-page'),
        ready: !!document.querySelector('.page-title') && (app.innerHTML || '').length > 500,
      });
    })()`);
    const s = JSON.parse(st);
    const dt = Date.now() - t0;
    if (shellMs < 0 && s.shell) shellMs = dt;
    if (skeletonMs < 0 && s.skeleton) skeletonMs = dt;
    if (s.ready) { readyMs = dt; break; }
    await sleep(16);
  }
  await sleep(150);
  const info = JSON.parse(await evalJs(`(()=>{
    const paint = performance.getEntriesByType('paint') || [];
    return JSON.stringify({ fcp: Math.round((paint.find(p=>p.name==='first-contentful-paint')||{}).startTime || 0) });
  })()`));
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  return { shellMs, skeletonMs, readyMs, fcp: info.fcp };
}

const results = [];
const modes = process.argv.includes('--slow') ? [['慢 4G + 4x CPU', true]] : [['本地', false], ['慢 4G + 4x CPU', true]];
for (const [name, slow] of modes) {
  const r = await run({ slow });
  results.push({ name, ...r });
  console.log(
    name.padEnd(14),
    '侧栏 ' + String(r.shellMs).padStart(5) + 'ms',
    '骨架 ' + String(r.skeletonMs).padStart(5) + 'ms',
    '完整首屏 ' + String(r.readyMs).padStart(6) + 'ms',
    'FCP ' + String(r.fcp).padStart(5) + 'ms',
  );
}

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../report/design/perf-boot.json');
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log('\n→ report/design/perf-boot.json');
ws.close();
