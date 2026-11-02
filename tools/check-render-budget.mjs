#!/usr/bin/env node
/**
 * 渲染耗时门禁：CPU 4x 降速下直接调用各页面 render()，检查冷/热渲染是否超预算（CI 里跑，防性能回退）。
 *
 * 预算按「本地实测 × 3 倍左右」给 CI 机器留余量（CI runner 比 Mac 慢）：
 *   冷渲染（首次，含数据/缓存构建）：today 300ms、scan 1500ms、stock 1200ms、backtest 3000ms、mine 400ms
 *   热渲染（后续重复渲染）：today 150ms、scan 250ms、stock 300ms、backtest 600ms、mine 250ms
 *
 * 前置：8766 静态服务 + Chrome 9222（可用 D3_SITE / D3_CDP_PORT 覆盖）。
 * 用法：node tools/check-render-budget.mjs [--throttle=4]
 */
import { cdpConnect, sleep } from './lib/cdp.mjs';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes('=')).map((a) => a.split('=')));
const THROTTLE = Number(args.throttle) || 4;
const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';

const BUDGET = {
  cold: { today: 300, scan: 1500, stock: 1200, backtest: 3000, mine: 400 },
  warm: { today: 150, scan: 250, stock: 300, backtest: 600, mine: 250 },
};

const { send, evalJs, close } = await cdpConnect();
await send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

const BASE = SITE + (SITE.includes('?') ? '&' : '?') + 'nosw=1&theme=dark';
await send('Page.navigate', { url: BASE + '&t=' + Date.now() + '#today' });
for (let i = 0; i < 600; i++) {
  const ok = await evalJs("!!document.querySelector('.page-title') && document.getElementById('app').innerHTML.length > 500");
  if (ok) break;
  await sleep(50);
}

const raw = JSON.parse(await evalJs(`(async () => {
  const mods = {
    today: ['./src/pages/today.js', 'renderToday'],
    scan: ['./src/pages/scan.js', 'renderScanPage'],
    stock: ['./src/pages/stock.js', 'renderStock'],
    backtest: ['./src/pages/backtest.js', 'renderBacktest'],
    mine: ['./src/pages/mine.js', 'renderMine'],
  };
  const out = {};
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
})()`));
await send('Emulation.setCPUThrottlingRate', { rate: 1 });

const failures = [];
console.log(`渲染耗时（CPU ${THROTTLE}x；冷=首次，热=2/3 次平均）`);
for (const [name, times] of Object.entries(raw)) {
  if (!Array.isArray(times) || times.some((t) => t < 0)) {
    failures.push(`${name} 渲染失败`);
    console.log(name.padEnd(10), 'ERR');
    continue;
  }
  const cold = times[0];
  const warm = Math.round((times[1] + times[2]) / 2);
  const coldOver = cold > BUDGET.cold[name];
  const warmOver = warm > BUDGET.warm[name];
  console.log(
    name.padEnd(10),
    `冷 ${String(cold).padStart(5)}ms / ${BUDGET.cold[name]}ms${coldOver ? ' ✗' : ' ✓'}`,
    `  热 ${String(warm).padStart(4)}ms / ${BUDGET.warm[name]}ms${warmOver ? ' ✗' : ' ✓'}`,
  );
  if (coldOver) failures.push(`${name} 冷渲染 ${cold}ms > ${BUDGET.cold[name]}ms`);
  if (warmOver) failures.push(`${name} 热渲染 ${warm}ms > ${BUDGET.warm[name]}ms`);
}
close();
if (failures.length) {
  console.log('\n✗ 渲染预算超标：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\n✓ 渲染耗时全部在预算内。');
