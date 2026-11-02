#!/usr/bin/env node
/**
 * 本地与 CI 共用的静态服务器：模拟 GitHub Pages 的压缩行为。
 *
 * 为什么不用 `python3 -m http.server`：它不压缩。生产站（GitHub Pages）对
 * js/css/json 走 gzip/brotli，首屏差出几百 KB。CI 拿不压缩的服务器去量
 * 「个股页冷渲染 1200ms 预算」，量出来 2363ms——测的不是产品，是测试环境。
 *
 * 约定（和线上对齐的三件事）：
 *  - 文本类响应 gzip（客户端声明 accept-encoding: gzip 时）
 *  - cache-control: no-store —— 检查要看到当前代码，不能被浏览器缓存骗
 *  - 单进程并发处理，不做连接复用限制
 *
 * 用法：node tools/serve-static.mjs [根目录=仓库根] [端口=8766]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const PORT = Number(process.argv[3] || process.env.D3_PORT || 8766);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE = /\.(js|mjs|css|json|txt|html|webmanifest|svg)$/;

http
  .createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad url');
      return;
    }
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, p);
    // 目录穿越防护：解析后必须仍在根目录下
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const buf = fs.readFileSync(file);
    const useGzip = COMPRESSIBLE.test(ext) && /gzip/i.test(String(req.headers['accept-encoding'] || ''));
    const body = useGzip ? zlib.gzipSync(buf, { level: 9 }) : buf;
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'content-length': body.length,
    };
    if (useGzip) headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(body);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
