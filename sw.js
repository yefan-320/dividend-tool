/* 红利工具 Service Worker：应用外壳预缓存 + 数据 stale-while-revalidate。
   代码更新时把 VERSION 加一（v1.0.0 → v1.0.1）即可让旧缓存失效。

   图表库（echarts 原始 1MB / gzip 约 326KB）不放进安装预缓存：
   首屏和离线外壳都不需要它，放进 SHELL 会让「装好、离线可用」多等约 40% 的下载。
   改由页面空闲时发 warm-charts 消息补缓存（见 WARM / warmAll），
   没补上也不影响在线画图——外壳的 fetch 处理器会把首次取到的文件顺手缓存。 */
const VERSION = 'hongli-v1.0.0';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './styles/tokens.css', './styles/base.css', './styles/components.css', './styles/pages.css',
  './src/main.js', './src/data.js', './src/net.js', './src/store.js', './src/charts.js',
  './src/pages/today.js', './src/pages/scan.js', './src/pages/stock.js', './src/pages/backtest.js', './src/pages/mine.js', './src/pages/plans.js',
  './src/engine/plan.js', './src/engine/finance.js', './src/engine/portfolio.js', './src/engine/market.js',
  './src/engine/portfolioBacktest.js', './src/engine/stockBacktest.js', './src/engine/backtest.js', './src/engine/verdict.js',
  './src/ui/icons.js', './src/ui/format.js', './src/ui/toast.js', './src/ui/modal.js', './src/ui/buy.js', './src/ui/table.js',
  './assets/icon-192.png', './assets/icon-512.png',
  './data/quotes.json', './data/baseline.json', './data/benchmark.json',
  './data/finance-core.json', './data/dy-pct.json',
  './data/daily/meta.json',
];

/* 暖缓存：不阻塞安装/激活；页面空闲（或首次用到图表页）时再补 */
const WARM = ['./vendor/echarts.min.js'];

async function warmAll(list) {
  const cache = await caches.open(VERSION);
  await Promise.allSettled(list.map(async (u) => {
    const abs = new URL(u, self.registration.scope).href;
    if (await cache.match(abs)) return;
    try { await cache.add(new Request(abs, { cache: 'reload' })); } catch (e) { /* 断网/中断：下次再补 */ }
  }));
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
    // 尽力而为：不放进 waitUntil，避免把「激活完成」拖到 326KB 之后；
    // 常规路径是页面空闲时发 warm-charts 消息（那时 SW 一定已激活）。
    warmAll(WARM).catch(() => {});
  })());
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'warm-charts') e.waitUntil(warmAll(WARM));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 联网接口不拦，交给 net.js / IndexedDB

  // 数据：先给缓存，同时后台更新（离线可用、在线最终一致）
  if (url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    })());
    return;
  }

  // 外壳：缓存优先，后台更新
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    // ignoreSearch：?theme=light 之类入口参数不影响拿到缓存的外壳（否则离线启动白屏）
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) return hit;
    // 导航请求兜底到 index.html（SPA 只有这一个 HTML 入口）
    if (req.mode === 'navigate') {
      const shell = await cache.match(new URL('./index.html', self.registration.scope).href, { ignoreSearch: true });
      if (shell) return shell;
    }
    return (await net) || new Response('offline', { status: 503 });
  })());
});
