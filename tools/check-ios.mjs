#!/usr/bin/env node
/**
 * iOS / 移动端适配检查（静态断言 + 真机 CDP 移动仿真）。
 *
 * 为什么单独一个工具：桌面 Chrome 冒烟测不出 iOS 的这几类问题——
 *  1. 输入框字号 <16px：iOS Safari 聚焦时会整页放大（跳到输入框、页面错位）；
 *  2. 100vh：iOS 地址栏收起/展开时高度跳变（改用 dvh）；
 *  3. 安全区：PWA（black-translucent）内容顶进状态栏、横屏刘海切正文、tabbar 被 Home 条压住；
 *  4. 点按：双击缩放 / 300ms 延迟（touch-action: manipulation）、点按灰块（tap-highlight）；
 *  5. 橡皮筋回弹闪白（overscroll-behavior）。
 *
 * 检查内容：
 *  A. 静态：index.html / tokens.css / base.css / components.css 里关键规则都在；
 *  B. 仿真：iPhone 14（390×844）、iPhone SE（320×568）、横屏（844×390）
 *     × 5 个页面：无横向溢出、tabbar 在视口内、正文避开 tabbar、
 *     输入框 16px、点按高亮透明、overscroll 关闭、侧栏隐藏；
 *  C. 深浅色切换时 theme-color（iOS 状态栏/地址栏颜色）跟着变；
 *  D. 全程无 console.error / 未捕获异常。
 *
 * 前置：8766 静态服务 + Chrome 9222（D3_SITE / D3_CDP_PORT 可覆盖）。
 * 用法：node tools/check-ios.mjs   （失败 exit 1）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = process.env.D3_SITE || 'http://127.0.0.1:8766/';
const PORT = process.env.D3_CDP_PORT || '9222';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const failures = [];
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures.push(name + (detail ? ' ' + detail : ''));
};

/* ---------------- A. 静态断言 ---------------- */
const html = read('index.html');
const tokens = read('styles/tokens.css');
const base = read('styles/base.css');
const comp = read('styles/components.css');

check('viewport 带 viewport-fit=cover（刘海安全区生效）', /viewport-fit=cover/.test(html));
check('声明 apple-mobile-web-app-capable + 状态栏', /apple-mobile-web-app-capable/.test(html) && /apple-mobile-web-app-status-bar-style/.test(html));
check('有 apple-touch-icon（iOS 主屏图标）', /rel="apple-touch-icon"/.test(html) && fs.existsSync(path.join(ROOT, 'assets/icon-180.png')));
check('禁用 iOS 文字自动放大（text-size-adjust）', /-webkit-text-size-adjust:\s*100%/.test(tokens) && /text-size-adjust:\s*100%/.test(tokens));
check('点按灰块透明（-webkit-tap-highlight-color）', /-webkit-tap-highlight-color:\s*transparent/.test(tokens));
check('禁用橡皮筋/下拉刷新（overscroll-behavior-y）', /overscroll-behavior-y:\s*none/.test(tokens));
check('视口高度用 dvh 兜底（body/shell/sidebar）', (tokens.match(/100dvh/g) || []).length >= 1 && (base.match(/100dvh/g) || []).length >= 2);
check('顶部/左右/底部安全区都用到 env(safe-area-inset-*)',
  /env\(safe-area-inset-top\)/.test(base) && /env\(safe-area-inset-left\)/.test(base) && /env\(safe-area-inset-right\)/.test(base) && /env\(safe-area-inset-bottom\)/.test(base));
check('输入框移动端 16px（iOS 聚焦不放大）', /input\.input[^{]*\{[^}]*font-size:\s*16px/.test(read('styles/pages.css')) && /\.stock-search input[^{]*\{[^}]*font-size:\s*16px/.test(read('styles/pages.css')));
check('可点元素 touch-action: manipulation（去双击缩放）', /touch-action:\s*manipulation/.test(base));
check('弹层高度用 dvh + 内部滚动不传染（overscroll-behavior）', /max-height:\s*86dvh/.test(comp) && /overscroll-behavior:\s*contain/.test(comp));
check('移动端 toast 提到 tabbar 之上（含安全区）', /#toast\s*\{\s*bottom:\s*calc\(84px \+ env\(safe-area-inset-bottom\)\)/.test(comp));

/* ---------------- CDP ---------------- */
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('找不到 Chrome 页面 target，请确认 Chrome 已启动'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
let errors = [];
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
async function waitFor(expr, label, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await evalJs(expr).catch(() => null);
    if (v) return v;
    await sleep(120);
  }
  throw new Error('等待超时：' + (label || expr));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const BASE = SITE + (SITE.includes('?') ? '&' : '?') + 'offline=1&nosw=1&theme=dark';
let navSeq = 0;

async function emulation(width, height, dpr) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: true, screenWidth: width, screenHeight: height });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', { userAgent: UA_IPHONE, platform: 'iPhone' });
}
async function goto(hash) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await send('Page.navigate', { url: BASE + '&r=' + (++navSeq) + hash });
    await sleep(300);
    try {
      await waitFor(`document.readyState === 'complete' && (document.getElementById('app')?.children.length || 0) > 0`, '页面就绪 ' + hash, 8000);
      await waitFor(`!!document.querySelector('.page-title')`, '页面标题 ' + hash, 8000);
      return;
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
}

const pageMetrics = async () => JSON.parse(await evalJs(`(() => {
  const cx = getComputedStyle(document.body).overscrollBehaviorY;
  const main = document.querySelector('.main');
  const tabbar = document.querySelector('.tabbar');
  const tb = tabbar ? tabbar.getBoundingClientRect() : null;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const wide = [...document.querySelectorAll('.main *')]
    .filter((el) => visible(el) && el.getBoundingClientRect().right > innerWidth + 1)
    .slice(0, 4)
    .map((el) => (el.className || el.tagName) + '@' + Math.round(el.getBoundingClientRect().right));
  const inputs = [...document.querySelectorAll('input.input, .stock-search input')]
    .filter(visible)
    .map((el) => ({ id: el.id || el.className, size: parseFloat(getComputedStyle(el).fontSize) }));
  const charts = [...document.querySelectorAll('.chart canvas')]
    .filter(visible)
    .map((el) => ({ w: Math.round(el.getBoundingClientRect().width), cw: Math.round(el.closest('.chart').getBoundingClientRect().width) }));
  return JSON.stringify({
    title: document.querySelector('.page-title')?.textContent || '',
    docScrollW: document.documentElement.scrollWidth,
    innerW: innerWidth,
    innerH: innerHeight,
    wide,
    overscroll: cx,
    mainPadTop: main ? parseFloat(getComputedStyle(main).paddingTop) : null,
    mainPadBottom: main ? parseFloat(getComputedStyle(main).paddingBottom) : null,
    tabbar: tb ? { display: getComputedStyle(tabbar).display, top: Math.round(tb.top), height: Math.round(tb.height), bottom: Math.round(tb.bottom) } : null,
    tabLinkH: (() => { const a = document.querySelector('.tabbar a'); return a ? Math.round(a.getBoundingClientRect().height) : null; })(),
    tapHighlight: getComputedStyle(document.querySelector('.btn') || document.body).getPropertyValue('-webkit-tap-highlight-color'),
    inputs,
    charts,
    sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
    textLen: (document.getElementById('app') || {}).textContent?.length || 0,
    themeColor: document.querySelector('meta[name="theme-color"]')?.content || '',
    theme: document.documentElement.dataset.theme || '',
  });
})()`));

const PAGES = [
  ['#today', '今天'],
  ['#scan', '选股'],
  ['#stock?code=600036', '个股'],
  ['#backtest', '回测'],
  ['#mine', '我的组合'],
];
const DEVICES = [
  ['iPhone 14（390×844）', 390, 844, 3],
  ['iPhone SE（320×568）', 320, 568, 2],
  ['横屏（844×390）', 844, 390, 3],
];

for (const [devName, w, h, dpr] of DEVICES) {
  await emulation(w, h, dpr);
  for (const [hash, title] of PAGES) {
    await goto(hash);
    await sleep(300);
    const m = await pageMetrics();
    const tag = `[${devName}] ${title}`;
    check(`${tag} 渲染正常`, norm(m.title) === title && m.textLen > 80, `title=${norm(m.title)} textLen=${m.textLen}`);
    check(`${tag} 无横向溢出`, m.docScrollW <= m.innerW + 1, `scrollWidth=${m.docScrollW} innerWidth=${m.innerW} ${m.wide.length ? '越界元素：' + m.wide.join(', ') : ''}`);
    const tb = m.tabbar || {};
    check(`${tag} tabbar 固定在视口内、高度≥62`, tb.display === 'flex' && tb.bottom <= m.innerH + 1 && tb.height >= 62, JSON.stringify({ ...tb, innerH: m.innerH }));
    check(`${tag} 正文避开 tabbar（main 底部留白≥84）`, m.mainPadBottom >= 84, `paddingBottom=${m.mainPadBottom}`);
    check(`${tag} 顶部安全区留白≥22`, m.mainPadTop >= 22, `paddingTop=${m.mainPadTop}`);
    const badInputs = m.inputs.filter((x) => x.size < 16);
    check(`${tag} 输入框字号≥16px（iOS 不放大）`, badInputs.length === 0, badInputs.map((x) => `${x.id}:${x.size}px`).join(', '));
    check(`${tag} 点按高亮透明`, /rgba\(0, 0, 0, 0\)|transparent/.test(m.tapHighlight), m.tapHighlight);
    check(`${tag} overscroll 已关闭（不回弹闪白）`, m.overscroll === 'none', m.overscroll);
    check(`${tag} 侧栏隐藏、tab 点击区≥40`, m.sidebar === 'none' && m.tabLinkH >= 40, `sidebar=${m.sidebar} tabLink=${m.tabLinkH}`);
    const badCharts = m.charts.filter((c) => c.w > c.cw + 2);
    check(`${tag} 图表不超出容器`, badCharts.length === 0, badCharts.map((c) => `canvas ${c.w}px > 容器 ${c.cw}px`).join(', '));
  }
}

/* ---------- C. 深/浅色切换：theme-color 跟着变（iOS 状态栏/地址栏） ---------- */
await emulation(390, 844, 3);
await goto('#today');
await sleep(300);
const beforeTheme = await evalJs(`JSON.stringify({ theme: document.documentElement.dataset.theme, color: document.querySelector('meta[name="theme-color"]')?.content })`);
const before = JSON.parse(beforeTheme);
const clickTheme = async (times) => {
  for (let i = 0; i < times; i++) {
    await evalJs(`document.getElementById('themeBtn').click()`);
    await sleep(350);
  }
};
await clickTheme(1);
const afterDark = JSON.parse(await evalJs(`JSON.stringify({ theme: document.documentElement.dataset.theme, color: document.querySelector('meta[name="theme-color"]')?.content })`));
check('点主题钮切换深浅色', afterDark.theme !== before.theme, `${before.theme} → ${afterDark.theme}`);
check('theme-color 跟着主题变（iOS 状态栏颜色）', afterDark.color !== before.color, `${before.color} → ${afterDark.color}`);
await clickTheme(1);
const afterLight = JSON.parse(await evalJs(`JSON.stringify({ theme: document.documentElement.dataset.theme, color: document.querySelector('meta[name="theme-color"]')?.content })`));
check('切回原主题后 theme-color 复原', afterLight.theme === before.theme && afterLight.color === before.color, `${afterLight.theme} ${afterLight.color}`);

check('全程无 console.error / 未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));

await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
await send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
await send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});

ws.close();
console.log('');
if (failures.length) {
  console.log(`✗ iOS / 移动端适配检查失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('✓ iOS / 移动端适配检查全部通过');
process.exit(0);
