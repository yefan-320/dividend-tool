#!/usr/bin/env node
/**
 * 离线可用性检查（真机）：页面 + Service Worker 两个 target 同时断网，验证核心页面能打开。
 *
 * 覆盖：
 *  1. 在线预热（注册 SW、打开一次今天/选股/个股）；
 *  2. 页面 target 与 SW target 同时 offline；
 *  3. #today / #scan 仍能渲染（本地快照 + SW 缓存）；#stock 离线能打开且先前看过的日 K 有图；
 *  4. 无「页面加载失败」错误横幅；
 *  5. 恢复在线后页面正常。
 *
 * 前置：8766 静态服务 + Chrome 9222（D3_SITE / DSH_CDP_PORT / D3_CDP_PORT 可覆盖）。
 * 用法：node tools/check-offline.mjs   （失败 exit 1）
 */
import { cdpConnect, sleep } from './lib/cdp.mjs';

const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const { send, evalJs, close } = await cdpConnect();

const failures = [];
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ' ' + detail : ''));
};
const state = async () => JSON.parse(await evalJs(`JSON.stringify({
  title: document.querySelector('.page-title')?.textContent || '',
  appLen: (document.getElementById('app') || {}).innerHTML.length || 0,
  banner: [...document.querySelectorAll('.banner.warn')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()).join(' | '),
  canvas: document.querySelectorAll('canvas').length,
  rows: document.querySelectorAll('.scan-table tbody tr').length,
  counts: ((document.body.innerText || '').match(/可买 \\d+/) || [''])[0],
})`));

let swSession = null;
try {
  /* ---------- 1) 在线预热：SW 安装 + 打开核心页 + 个股（让它按需缓存日 K） ---------- */
  await send('Page.navigate', { url: SITE });
  await sleep(2500);
  let ready = false;
  for (let i = 0; i < 3 && !ready; i++) {
    ready = await evalJs(`(async () => {
      try {
        await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000))]);
        return !!navigator.serviceWorker.controller;
      } catch (e) { return false; }
    })()`);
    if (!ready) { await send('Page.navigate', { url: SITE }); await sleep(2500); }
  }
  check('在线预热：SW 已注册并控制页面', ready);
  const warm = [['today', '#today', 5000], ['scan', '#scan', 7000], ['stock', '#stock?code=600036', 6000]];
  for (const [name, hash, wait] of warm) {
    await send('Page.navigate', { url: SITE + '?theme=dark&t=' + Date.now() + hash });
    await sleep(wait);
    const st = await state();
    check(`在线预热：${name} 渲染`, st.title !== '' && st.appLen > 500, st.title);
  }

  // 图表库不在安装预缓存里（少下 326KB），靠页面空闲时发 warm-charts 消息补缓存；
  // 离线画图前确认它真的进了缓存 —— 这同时验证「暖缓存」机制本身
  const echartsCached = await evalJs(`(async () => {
    for (let i = 0; i < 60; i++) {
      try { const hit = await caches.match('./vendor/echarts.min.js'); if (hit) return true; } catch (e) {}
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })()`);
  check('在线预热：图表库进 SW 暖缓存（安装期不预缓存，空闲补）', echartsCached);

  /* ---------- 2) 页面 + SW 双断网 ---------- */
  const targets = await send('Target.getTargets');
  const swTarget = (targets.targetInfos || []).find((t) => t.type === 'service_worker');
  if (swTarget) {
    const att = await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    swSession = att.sessionId;
    await send('Network.enable', {}, swSession);
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, swSession);
  } else {
    console.log('⚠ 未找到 SW target，仅页面离线（结论会偏乐观）');
  }
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });

  /* ---------- 3) 离线打开核心页 ---------- */
  const offlineScenes = [
    ['today', '#today', 5000, (st) => st.title === '今天' && !!st.counts && st.appLen > 500],
    ['scan', '#scan', 7000, (st) => st.title === '选股' && st.rows > 0],
    ['stock', '#stock?code=600036', 7000, (st) => st.title === '招商银行' && st.canvas >= 1],
  ];
  for (const [name, hash, wait, verify] of offlineScenes) {
    await send('Page.navigate', { url: SITE + '?theme=dark&t=' + Date.now() + hash });
    await sleep(wait);
    const st = await state();
    const noError = !st.banner.includes('页面加载失败');
    check(`离线 ${name} 可打开且无错误横幅`, noError && verify(st), JSON.stringify({ title: st.title, canvas: st.canvas, rows: st.rows, banner: st.banner.slice(0, 60) }));
  }

  /* ---------- 4) 恢复在线 ---------- */
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  if (swSession) await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, swSession).catch(() => {});
  await send('Page.navigate', { url: SITE + '?theme=dark&t=' + Date.now() + '#today' });
  await sleep(5000);
  const st = await state();
  check('恢复在线后今天页正常', st.title === '今天' && st.appLen > 500, st.title);
} finally {
  try {
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    if (swSession) await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, swSession).catch(() => {});
  } catch (e) { /* ignore */ }
  close();
}

if (failures.length) {
  console.log('\n✗ 离线可用性检查失败：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\n✓ 离线可用性检查通过（页面 + SW 双断网，核心页可打开）。');
