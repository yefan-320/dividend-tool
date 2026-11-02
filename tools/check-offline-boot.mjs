#!/usr/bin/env node
/**
 * 离线首访检查（真机）：模拟「全新安装 → 在线打开一次 → 断网 → 再打开」。
 *
 * 为什么单独一条：check-offline.mjs 会在线导航三四次，第二次起 SW 已经接管，
 * 页面请求的模块被 fetch 处理器顺手写进缓存 —— 于是它永远测不到「新装首访」。
 * 而 sw.js 的 SHELL 是手工清单：拆文件时忘了登记，只有这条路径会暴露——
 * main.js 静态 import 了整个页面模块图，任何一个模块 503 都会让 boot() 一行不跑，
 * 整站白屏（连 main.js 自己的错误横幅都渲染不出来）。
 *
 * 覆盖：
 *  1. 清空站点数据后，在线打开一次让 SW 装好；
 *  2. 断网（页面 + SW 双 target）；
 *  3. 新文档里逐个取首屏模块，必须全部 200（来自 SW 缓存）；
 *  4. 新文档 body 有内容（boot 至少跑起来了）。
 *
 * ⚠ 会清空本站 localStorage / Cache Storage / SW，建议单独跑，别和其它检查并发。
 * 前置：8766 静态服务 + Chrome 9222（D3_SITE / D3_CDP_PORT 可覆盖）。
 * 用法：node tools/check-offline-boot.mjs   （失败 exit 1）
 */
import { cdpConnect, sleep } from './lib/cdp.mjs';

const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const ORIGIN = new URL(SITE).origin;
const { send, evalJs, close } = await cdpConnect();

const failures = [];
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ' ' + detail : ''));
};

/** 首屏必须能从缓存里取到的模块（含页面拆出来的每一块） */
const MUST_CACHE = [
  './src/main.js',
  './src/pages/backtest.js',
  './src/pages/backtest/core.js',
  './src/pages/backtest/view.js',
  './src/engine/plan.js',
  './src/engine/market.js',
];

let swSession = null;
try {
  /* ---------- 1) 全新安装：清空一切，在线只打开一次 ---------- */
  await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
  await sleep(800);
  await send('Page.navigate', { url: SITE + '?t=' + Date.now() + '#today' });
  await sleep(4500);
  const ready = await evalJs(`(async () => {
    try { const reg = await navigator.serviceWorker.ready; return !!reg.active; } catch (e) { return false; }
  })()`);
  check('SW 安装完成（只在线访问一次，不做第二次导航）', ready);
  if (!ready) throw new Error('SW 没装好，后面无法判断');

  /* ---------- 2) 页面 + SW 双断网 ---------- */
  const targets = await send('Target.getTargets');
  const swTarget = (targets.targetInfos || []).find((t) => t.type === 'service_worker');
  if (swTarget) {
    const att = await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    swSession = att.sessionId;
    await send('Network.enable', {}, swSession);
    await send('Network.emulateNetworkConditions',
      { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, swSession);
  } else {
    console.log('⚠ 未找到 SW target，仅页面离线（结论会偏乐观）');
  }
  await send('Network.emulateNetworkConditions',
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });

  /* ---------- 3) 新文档：断网首访 ---------- */
  // 必须导航出一个新 document —— 同一页面的模块图已求值，动态 import 会命中内存缓存，
  // 测不出「缓存里到底有没有这个文件」。
  await send('Page.navigate', { url: SITE + '?t=' + Date.now() + '#today' });
  await sleep(5000);

  const booted = await evalJs(`JSON.stringify({
    bodyLen: (document.body.innerText || '').length,
    appLen: (document.getElementById('app') || {}).innerHTML.length || 0,
  })`);
  const b = JSON.parse(booted);
  check('断网首访：页面有内容（模块图求值成功）', b.bodyLen > 0 && b.appLen > 0,
    `body=${b.bodyLen} app=${b.appLen}`);

  const fetched = JSON.parse(await evalJs(`(async () => {
    const out = {};
    for (const u of ${JSON.stringify(MUST_CACHE)}) {
      try { const r = await fetch(u); out[u] = r.status; } catch (e) { out[u] = 0; }
    }
    return JSON.stringify(out);
  })()`));
  for (const [url, status] of Object.entries(fetched)) {
    check(`断网首访：${url.replace('./src/', '')} 取自 SW 缓存`, status === 200, 'status=' + status);
  }
} finally {
  try {
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    if (swSession) await send('Network.emulateNetworkConditions',
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, swSession).catch(() => {});
  } catch (e) { /* ignore */ }
  close();
}

if (failures.length) {
  console.log('\n✗ 离线首访检查失败（sw.js 的 SHELL 大概漏了新拆出来的模块）：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\n✓ 离线首访检查通过（全新安装 + 断网首访，首屏模块全部来自缓存）。');
