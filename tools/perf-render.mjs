#!/usr/bin/env node
/**
 * 页面渲染耗时：直接调用各页面模块的 render()（不含网络），CPU 4x 降速模拟中端手机。
 * 用于比较优化前后（股息索引 / 页面缓存 / 数据层改动）的渲染开销。
 *
 * 前置：启动 8766 静态服务与 Chrome 9222（见 README）。
 * 用法：node tools/perf-render.mjs [--throttle=4]
 */
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes('=')).map((a) => a.split('=')));
const THROTTLE = Number(args.throttle) || 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
await send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

const BASE = 'http://127.0.0.1:8766/?theme=dark&nosw=1';
await send('Page.navigate', { url: BASE + '#today' });
for (let i = 0; i < 400; i++) {
  const ok = await evalJs("!!document.querySelector('.page-title') && document.getElementById('app').innerHTML.length > 500");
  if (ok) break;
  await sleep(50);
}

const script = `(async () => {
  const out = {};
  const mods = {
    today: ['./src/pages/today.js', 'renderToday'],
    scan: ['./src/pages/scan.js', 'renderScanPage'],
    stock: ['./src/pages/stock.js', 'renderStock'],
    backtest: ['./src/pages/backtest.js', 'renderBacktest'],
    mine: ['./src/pages/mine.js', 'renderMine'],
  };
  for (const [name, [path, fnName]] of Object.entries(mods)) {
    const m = await import(path);
    const fn = m[fnName];
    if (!fn) { out[name] = null; continue; }
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try { await fn(); } catch (e) { times.push(-1); break; }
      times.push(Math.round(performance.now() - t0));
    }
    out[name] = times;
  }
  return JSON.stringify(out);
})()`;
const raw = JSON.parse(await evalJs(script));
console.log(`render() 耗时（CPU ${THROTTLE}x，3 次，ms）`);
for (const [name, times] of Object.entries(raw)) {
  console.log(name.padEnd(10), Array.isArray(times) ? times.map((t) => String(t).padStart(4)).join(' ') : 'ERR');
}
await send('Emulation.setCPUThrottlingRate', { rate: 1 });

const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../report/design/perf-render.json');
fs.writeFileSync(OUT, JSON.stringify({ throttle: THROTTLE, render: raw }, null, 2));
console.log(`\n→ report/design/perf-render.json`);
ws.close();
