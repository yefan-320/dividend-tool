#!/usr/bin/env node
/**
 * PWA 可安装性检查（真机 CDP）：
 *  1. 打开站点 → Service Worker 注册成功且页面被控制；
 *  2. Chrome 的 Page.getInstallabilityErrors 为空；
 *  3. manifest 解析无错误，name/short_name/start_url/icons 齐全，icons 实际可访问（200）。
 *
 * 前置：8766 静态服务 + Chrome 9222（可用 D3_SITE / D3_CDP_PORT 覆盖）。
 * 用法：node tools/check-pwa.mjs   （失败 exit 1）
 */
const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const PORT = process.env.D3_CDP_PORT || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('找不到 Chrome 页面 target，请确认 Chrome 已启动'); process.exit(1); }
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
await send('Network.setCacheDisabled', { cacheDisabled: true });

const failures = [];
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ' ' + detail : ''));
};

// 1) SW 注册/控制（首次访问会安装；安装可能需要拉 48 个预缓存文件，最多等 30s）
await send('Page.navigate', { url: SITE });
await sleep(2500);
let sw = { active: false, controlled: false };
for (let attempt = 0; attempt < 3; attempt++) {
  sw = JSON.parse(await evalJs(`(async () => {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('SW ready 超时')), 30000)),
      ]);
      return JSON.stringify({ active: !!reg.active, controlled: !!navigator.serviceWorker.controller });
    } catch (e) {
      // ready 超时：显式注册一次再等
      try {
        await navigator.serviceWorker.register('./sw.js');
        const reg = await navigator.serviceWorker.ready;
        return JSON.stringify({ active: !!reg.active, controlled: !!navigator.serviceWorker.controller });
      } catch (e2) { return JSON.stringify({ error: e2.message }); }
    }
  })()`));
  if (sw.active && sw.controlled) break;
  // 首次页面可能还没被 claim：刷新一次让它被控制
  await send('Page.navigate', { url: SITE });
  await sleep(2500);
  sw = JSON.parse(await evalJs(`(async () => {
    let active = false;
    try { const reg = await navigator.serviceWorker.getRegistration(); active = !!reg?.active; } catch (e) { /* ignore */ }
    return JSON.stringify({ active, controlled: !!navigator.serviceWorker.controller });
  })()`));
  if (sw.active && sw.controlled) break;
}
check('Service Worker 注册并控制页面', sw.active && sw.controlled, JSON.stringify(sw));

// 2) Chrome 可安装性错误
try {
  const r = await send('Page.getInstallabilityErrors');
  const errs = (r.installabilityErrors || []).map((e) => e.errorId || e.errorType || JSON.stringify(e));
  check('Chrome installability 无错误', errs.length === 0, errs.join(', '));
} catch (e) {
  check('Chrome installability 检查', false, e.message);
}

// 3) manifest 字段与图标
try {
  const mf = await send('Page.getAppManifest');
  const raw = mf.data || '';
  const j = JSON.parse(raw);
  const mErr = (mf.errors || []).map((e) => e.message || e.critical || JSON.stringify(e));
  check('manifest 解析无错误', mErr.length === 0, JSON.stringify(mErr));
  check('manifest 有 name/short_name', !!(j.name && j.short_name), `${j.name} / ${j.short_name}`);
  check('manifest 有 start_url/display', !!(j.start_url && j.display), `${j.start_url} / ${j.display}`);
  const icons = j.icons || [];
  const sizes = icons.map((i) => i.sizes);
  check('manifest 图标含 192/512', sizes.includes('192x192') && sizes.includes('512x512'), sizes.join(' '));
  const iconOk = await evalJs(`(async () => {
    const res = await Promise.all(${JSON.stringify(icons.map((i) => i.src))}.map((src) => fetch(new URL(src, location.href)).then((r) => r.status).catch(() => 0)));
    return JSON.stringify(res);
  })()`);
  const codes = JSON.parse(iconOk);
  check('图标文件可访问', codes.every((c) => c === 200), codes.join(','));
} catch (e) {
  check('manifest 检查', false, e.message);
}

ws.close();
if (failures.length) {
  console.log('\n✗ PWA 检查失败：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\n✓ PWA 可安装性检查通过。');
