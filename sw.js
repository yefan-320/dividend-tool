/* 红利工具 Service Worker：应用外壳预缓存 + 数据 stale-while-revalidate。

   ⚠ 两级缓存，别再合并回一个：
     · SHELL_CACHE —— 代码壳（html/js/css/图标）。改代码升这个号。
     · DATA_CACHE  —— 数据（data/**、vendor/**）。只有数据格式变了才升。
   以前一个 VERSION 管所有：改一行代码就把用户机器上几 MB 数据全清了，
   下次打开又得重下财报/日 K/月线（实测重下要 80 秒）。分开之后改代码不再动数据。

   图表库（echarts 原始 1MB / gzip 约 326KB）不放进安装预缓存：
   首屏和离线外壳都不需要它，放进 SHELL 会让「装好、离线可用」多等约 40% 的下载。
   改由页面空闲时发 warm-charts 消息补缓存（见 WARM / warmAll），
   没补上也不影响在线画图——外壳的 fetch 处理器会把首次取到的文件顺手缓存。 */
const SHELL_CACHE = 'hongli-shell-v1.9.2';
const DATA_CACHE = 'hongli-data-v3';
/** 数据和代码分开放；数据量大又天天变，不该被代码改版连坐 */
const cacheNameFor = (u) => (/\/data\//.test(u) || /\/vendor\//.test(u) ? DATA_CACHE : SHELL_CACHE);
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './styles/tokens.css', './styles/base.css', './styles/components.css', './styles/pages.css',
  './src/main.js', './src/data.js', './src/net.js', './src/store.js', './src/charts.js',
  './src/pages/today.js', './src/pages/scan.js', './src/pages/stock.js', './src/pages/backtest.js', './src/pages/mine.js', './src/pages/plans.js',
  './src/engine/plan.js', './src/engine/finance.js', './src/engine/portfolio.js', './src/engine/market.js',
  './src/engine/portfolioBacktest.js', './src/engine/stockBacktest.js', './src/engine/backtest.js', './src/engine/verdict.js',
  './src/ui/icons.js', './src/ui/format.js', './src/ui/toast.js', './src/ui/modal.js', './src/ui/buy.js', './src/ui/table.js',
  './src/ui/stockSearch.js',
  './assets/icon-192.png', './assets/icon-512.png',
  './data/quotes.json', './data/baseline.json', './data/benchmark.json',
  './data/finance-core.json', './data/dy-pct.json',
  './data/daily/meta.json',
  // 本地已有的几只日 K（默认持仓/示例）：离线时个股页也能画图，其余股票在线按需拉
  './data/daily/000333.json', './data/daily/600036.json', './data/daily/600066.json',
  './data/daily/600887.json', './data/daily/600941.json', './data/daily/601318.json',
  './data/daily/601398.json',
];

/* 暖缓存：不阻塞安装/激活；页面空闲（或首次用到图表页）时再补 */
const WARM = ['./vendor/echarts.min.js', './data/name-idx.txt'];   // 搜索索引 58KB：不占安装预算，空闲时补

async function warmAll(list) {
  const cache = await caches.open(DATA_CACHE);
  await Promise.allSettled(list.map(async (u) => {
    const abs = new URL(u, self.registration.scope).href;
    if (await cache.match(abs)) return;
    try { await cache.add(new Request(abs, { cache: 'reload' })); } catch (e) { /* 断网/中断：下次再补 */ }
  }));
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // 按目标分组写进各自的 cache，不要一股脑塞进一个
    await Promise.allSettled(SHELL.map(async (u) => {
      const cache = await caches.open(cacheNameFor(u));
      await cache.add(new Request(u, { cache: 'reload' }));
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // 只清掉不是当前这两级的旧 cache（含旧版单层 hongli-v1.0.x）
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)));
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
      const cache = await caches.open(cacheNameFor(url.pathname));
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      if (hit) return hit;
      const res = await net;
      if (res) return res;
      // ⚠ 不要用 `{}` 冒充成功。以前这里返回 503 + 空 JSON 体，
      // 上层 loadMonthly 拿到 `{}` 就当成功，把空数据永久记进 db.monthly，
      // 于是组合对比里的「红利策略」静默变成空组合（99.9 万 / -0.0%）。
      // 直接报错，让上层 catch 得到、页面才知道该提示什么。
      return Response.error();
    })());
    return;
  }

  // 外壳：缓存优先，后台更新
  e.respondWith((async () => {
    const cache = await caches.open(cacheNameFor(url.pathname));
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
