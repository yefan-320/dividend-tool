/**
 * 共用 CDP 客户端：tools/ 下的 check-*.mjs / smoke-all.mjs 都通过它连 Chrome 调试口。
 *
 * 为什么单独一个文件：每个脚本过去各自抄一份 connect / send / evalJs / pending 样板
 * （20–40 行），改一次超时或错误信息要改十遍。
 *
 * 前置：Chrome 用 --remote-debugging-port=9222 启动（端口可用 DSH_CDP_PORT / D3_CDP_PORT 覆盖）。
 * 注意：这些脚本共用同一个页面 target，**绝不能并发跑**。
 */

/** 默认调试端口：DSH_CDP_PORT > D3_CDP_PORT > 9222 */
export const CDP_PORT = process.env.DSH_CDP_PORT || process.env.D3_CDP_PORT || '9222';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 连上 Chrome 的页面 target，返回带常用动作的连接对象。
 *
 * @param {object}   [options]
 * @param {string}   [options.port]          调试端口，默认 CDP_PORT
 * @param {number}   [options.timeout]       单条 CDP 命令的超时（毫秒）
 * @param {Function} [options.onEvent]       CDP 事件回调 (msg) => void，例：收 console.error
 * @param {boolean}  [options.enable]        连上后自动 Page/Runtime/Network.enable 并关缓存
 * @param {boolean}  [options.cacheDisabled]
 */
export async function cdpConnect(options = {}) {
  const {
    port = CDP_PORT,
    timeout = 120000,
    onEvent = null,
    enable = true,
    cacheDisabled = true,
  } = options;

  let list;
  try {
    list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  } catch (e) {
    throw new Error(`连不上 Chrome 调试口 127.0.0.1:${port}（${e.message}）——Chrome 需带 --remote-debugging-port=${port} 启动`);
  }
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error(`找不到 Chrome 页面 target（端口 ${port}）——请确认 Chrome 已启动且开着一个页面`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Set();   // once(method) 的等待者

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej, timer, method } = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(timer);
      m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (!m.method) return;
    if (onEvent) onEvent(m);
    for (const fn of listeners) fn(m);
  });

  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`连接 Chrome 调试口超时（${port}）`)), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); rej(new Error(`连接 Chrome 调试口失败（${port}）：${e?.message || e?.type || 'WebSocket error'}`)); }, { once: true });
  });

  /** 发一条 CDP 命令；sessionId 用于 SW 这类子 target。 */
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      rej(new Error(`${method} 超时（${timeout}ms）`));
    }, timeout);
    pending.set(mid, { res, rej, timer, method });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  /** 页面里跑一段表达式，取返回值（awaitPromise：表达式可以是 async IIFE）。 */
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };

  /** 等一个 CDP 事件（如 Page.loadEventFired），resolve 出原始消息。 */
  const once = (method) => new Promise((res) => {
    const fn = (m) => { if (m.method === method) { listeners.delete(fn); res(m); } };
    listeners.add(fn);
  });

  /** 轮询表达式直到真值；超时抛错（文案带 label）。 */
  const waitFor = async (expr, label, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await evalJs(expr).catch(() => null);
      if (v) return v;
      await sleep(120);
    }
    throw new Error('等待超时：' + (label || expr));
  };

  /** 整页导航（只改 hash 是同文档导航，不会重载模块——需要重载时自己加时间戳参数）。 */
  const navigate = (url) => send('Page.navigate', { url });

  /** 移动端/尺寸仿真：viewport + 可选触摸 + 可选 UA。 */
  const setViewport = async ({ width, height, dpr = 1, mobile = false, screenSize = false, touch = false, ua, platform } = {}) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: dpr, mobile,
      ...(screenSize ? { screenWidth: width, screenHeight: height } : {}),
    });
    if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    if (ua) await send('Emulation.setUserAgentOverride', { userAgent: ua, ...(platform ? { platform } : {}) });
  };

  /** 撤掉 setViewport 的三项仿真。 */
  const clearViewport = async () => {
    await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    await send('Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
  };

  /* ---------- localStorage ---------- */

  const readLS = (key) => evalJs(`localStorage.getItem(${JSON.stringify(key)})`);
  const setLS = (key, value) => evalJs(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);

  /** 按前缀备份整个 localStorage 分区（默认 d3:*），返回 { key: value }。 */
  const readLSAll = async (prefix = 'd3:') => JSON.parse(await evalJs(
    `JSON.stringify(Object.fromEntries(Object.keys(localStorage)
      .filter((k) => k.startsWith(${JSON.stringify(prefix)}))
      .map((k) => [k, localStorage.getItem(k)])))`,
  ));

  /** 还原 readLSAll 的快照：删掉前缀下多出来的键，再写回快照。 */
  const restoreLS = (snapshot, prefix = 'd3:') => evalJs(`(() => {
    const keep = ${JSON.stringify(snapshot || {})};
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(${JSON.stringify(prefix)}) && !(k in keep)) localStorage.removeItem(k);
    }
    for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v);
    return 1;
  })()`);

  /** 清站点存储（SW / IndexedDB 行情缓存等）；失败不致命。 */
  const clearStorage = (origin, storageTypes = 'indexeddb,service_workers,cache_storage,local_storage') =>
    send('Storage.clearDataForOrigin', { origin, storageTypes }).catch(() => {});

  const close = () => { try { ws.close(); } catch (e) { /* ignore */ } };

  const conn = {
    ws, port,
    send, evalJs, once, waitFor, navigate,
    setViewport, clearViewport,
    readLS, setLS, readLSAll, restoreLS, clearStorage,
    close,
  };

  if (enable) {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    if (cacheDisabled) await send('Network.setCacheDisabled', { cacheDisabled: true });
  }

  return conn;
}
