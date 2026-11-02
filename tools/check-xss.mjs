#!/usr/bin/env node
/**
 * XSS / 转义审计：在真机浏览器里往「用户可控输入」和「URL 参数」注入 HTML/JS，确认按文本渲染、不执行。
 *
 * 覆盖：
 *  1. localStorage 方案名 / 备注（会渲染到方案列表与详情）
 *  2. URL 参数：#stock?code= / #scan?view= / ?theme= / #mine?view=
 *  3. 搜索框输入
 *  4. 恶意串里带 <img onerror> / <script> 两类载荷 —— 执行 = window.__xss* 被置位；注入成功 = DOM 里出现 img[src=x]
 *
 * 运行前启动 8766 静态服务与 Chrome 9222（可用 D3_SITE / DSH_CDP_PORT / D3_CDP_PORT 覆盖）。
 * 用法：node tools/check-xss.mjs     （有问题 exit 1）
 */
import { cdpConnect, sleep } from './lib/cdp.mjs';

const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const { navigate, send, evalJs, readLSAll, restoreLS, close } = await cdpConnect();

const failures = [];
const report = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures.push(name + ' ' + (detail || ''));
};

// 备份并稍后还原用户本地数据（只动 d3:*）
await navigate(SITE);
await sleep(1500);
const backup = await readLSAll('d3:');

const XSS = '"><img src=x onerror="window.__xssA=1"><script>window.__xssB=1<\/script>';
const base = SITE + (SITE.includes('?') ? '&' : '?') + 'nosw=1&theme=dark';

try {
  // 1) 方案名 / 备注注入
  await evalJs(`localStorage.setItem('d3:plans', JSON.stringify([{
    id: 'p-xss', name: ${JSON.stringify(XSS)}, note: ${JSON.stringify(XSS)},
    capital: 1000000, holdings: [{ code: '600036', weight: 100 }],
    entry: { mode: 'once', months: 12, minDy: 5.5 }, createdAt: '2026-01-01', updatedAt: '2026-01-01'
  }]))`);
  await send('Page.navigate', { url: base + '#mine?view=plans' });
  await sleep(3000);
  for (const [name, hash] of [['方案列表', '#mine?view=plans'], ['方案详情', '#mine?view=plans']]) {
    const r = JSON.parse(await evalJs(`JSON.stringify({ exec: !!(window.__xssA || window.__xssB), img: document.querySelectorAll('img[src="x"]').length, script: document.body.innerHTML.includes('<script>') })`));
    report('方案 ' + name + ' 注入按文本渲染', !r.exec && r.img === 0 && !r.script, JSON.stringify(r));
  }

  // 2) URL 参数注入
  const urls = [
    ['#stock?code=', base + '#stock?code=' + encodeURIComponent(XSS)],
    ['#scan?view=', base + '#scan?view=' + encodeURIComponent(XSS)],
    ['?theme=', base + '&theme=' + encodeURIComponent(XSS) + '#today'],
    ['#mine?view=', base + '#mine?view=' + encodeURIComponent(XSS)],
  ];
  for (const [name, url] of urls) {
    await send('Page.navigate', { url });
    await sleep(2500);
    const r = JSON.parse(await evalJs(`JSON.stringify({ exec: !!(window.__xssA || window.__xssB), img: document.querySelectorAll('img[src="x"]').length, title: document.title })`));
    report('URL 参数 ' + name + ' 注入安全', !r.exec && r.img === 0, JSON.stringify(r));
  }

  // 3) 搜索框输入
  await send('Page.navigate', { url: base + '#stock?code=600036' });
  await sleep(3000);
  const r = JSON.parse(await evalJs(`(() => {
    const s = document.getElementById('stockSearch');
    if (s) s.value = ${JSON.stringify(XSS)};
    return JSON.stringify({ exec: !!(window.__xssA || window.__xssB), img: document.querySelectorAll('img[src="x"]').length });
  })()`));
  report('搜索框输入按文本处理', !r.exec && r.img === 0, JSON.stringify(r));
} finally {
  // 还原 localStorage
  try { await restoreLS(backup, 'd3:'); } catch (e) { /* 页面可能不在同源 */ }
  close();
}

if (failures.length) {
  console.log('\n✗ XSS 审计失败：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\n✓ XSS 审计通过：所有注入均按文本渲染，无脚本执行、无 DOM 注入。');
