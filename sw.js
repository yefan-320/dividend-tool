/* 红利工具 Service Worker：应用外壳预缓存 + 数据 stale-while-revalidate。
   代码更新时把 VERSION 加一即可让旧缓存失效。 */
const VERSION = 'd3-v9';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './styles/tokens.css', './styles/base.css', './styles/components.css', './styles/pages.css',
  './vendor/echarts.min.js',
  './src/main.js', './src/data.js', './src/net.js', './src/store.js', './src/charts.js',
  './src/pages/today.js', './src/pages/scan.js', './src/pages/stock.js', './src/pages/backtest.js', './src/pages/mine.js', './src/pages/plans.js',
  './src/engine/plan.js', './src/engine/finance.js', './src/engine/portfolio.js', './src/engine/market.js',
  './src/engine/portfolioBacktest.js', './src/engine/stockBacktest.js', './src/engine/backtest.js', './src/engine/verdict.js',
  './src/ui/icons.js', './src/ui/format.js', './src/ui/toast.js', './src/ui/modal.js', './src/ui/buy.js', './src/ui/table.js',
  './assets/icon-192.png', './assets/icon-512.png',
  './data/quotes.json', './data/baseline.json', './data/benchmark.json',
  './data/finance-core.json', './data/dy-pct.json',
  './data/daily/meta.json',
  './data/daily/000333.json', './data/daily/600036.json', './data/daily/600066.json',
  './data/daily/600887.json', './data/daily/600941.json', './data/daily/601318.json', './data/daily/601398.json',
];

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
  })());
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
