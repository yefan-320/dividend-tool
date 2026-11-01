#!/usr/bin/env node
/**
 * 首屏性能预算门禁：不启动浏览器，检查「首屏要下载的东西」有没有偷偷变大。
 *
 * 检查项：
 *  1. 首屏核心数据（quotes + baseline + finance-core + benchmark）gzip 体积 ≤ 420KB；
 *  2. 外壳 JS/CSS（src/**、styles/**、index.html、manifest）gzip 体积 ≤ 145KB；
 *  3. 首屏总量（核心数据 + 外壳 + 图标）gzip ≤ 560KB；
 *  4. ECharts 必须是按需加载：index.html 里不许有同步 <script src="...echarts...">；
 *  5. 懒加载大文件（monthly / finance-history / finance-extra / echarts）不许进 SW 预缓存；
 *  6. 关键首屏文件必须进 SW 预缓存（离线可用）。
 *
 * 数值是当前实测 + 约 10% 余量；超了说明有人往首屏加了东西，先优化再提交。
 * 用法：node tools/check-budget.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const readText = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const gzipSize = (p) => zlib.gzipSync(fs.readFileSync(path.join(ROOT, p)), { level: 9 }).length;

const BUDGET = {
  coreDataKB: 420,
  shellKB: 145,
  firstLoadKB: 560,
  precacheKB: 620, // SW 安装时后台预缓存总量：ECharts 移出后应约 540KB（以前含图表库是 865KB）
};

/* 1. 首屏核心数据 */
const CORE_DATA = ['data/quotes.json', 'data/baseline.json', 'data/finance-core.json', 'data/benchmark.json'];
const coreItems = CORE_DATA.map((f) => ({ f, kb: gzipSize(f) / 1024 }));
const coreKB = coreItems.reduce((s, x) => s + x.kb, 0);

/* 2. 外壳 JS/CSS（与 sw.js SHELL 同源的那批文件） */
const shellItems = [];
function walk(rel) {
  for (const name of fs.readdirSync(path.join(ROOT, rel))) {
    const p = path.posix.join(rel, name);
    const st = fs.statSync(path.join(ROOT, p));
    if (st.isDirectory()) walk(p);
    else if (/\.(js|css|html|webmanifest)$/.test(name) && !p.includes('vendor/')) shellItems.push(p);
  }
}
walk('src');
walk('styles');
shellItems.push('index.html', 'manifest.webmanifest');
const shellKB = shellItems.reduce((s, f) => s + gzipSize(f) / 1024, 0);

/* 3. 首屏总量（核心数据 + 外壳 + 192 图标） */
const icons = ['assets/icon-192.png'].filter((f) => fs.existsSync(path.join(ROOT, f)));
const iconKB = icons.reduce((s, f) => s + gzipSize(f) / 1024, 0);
const firstLoadKB = coreKB + shellKB + iconKB;

/* 4. ECharts 必须按需加载 */
const html = readText('index.html');
const syncEcharts = /<script[^>]+src="[^"]*echarts/i.test(html);
const chartsJs = readText('src/charts.js');
const lazyEcharts = chartsJs.includes('ensureEcharts') && chartsJs.includes("vendor/echarts.min.js");

/* 5. 懒加载大文件不许进 SW 预缓存；6. 关键首屏文件必须在 */
const sw = readText('sw.js');
const shellBlock = (sw.match(/const SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
const shellList = [...shellBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
// monthly / finance-history / finance-extra 体积大且只在不常用页按需用，不进预缓存；
// echarts 1MB 也不进安装预缓存，改由 WARM 暖缓存（否则「装好即离线可用」要多等约 40%）
const mustNotPrecache = ['data/monthly.json', 'data/finance-history.json', 'data/finance-extra.json', 'vendor/echarts.min.js'];
const mustPrecache = ['data/quotes.json', 'data/baseline.json', 'data/finance-core.json', 'data/benchmark.json', './src/main.js'];
// 暖缓存：SW 里声明 + 页面空闲时发消息补下载
const warmBlock = (sw.match(/const WARM = \[([\s\S]*?)\];/) || [])[1] || '';
const warmList = [...warmBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const mainJs = readText('src/main.js');
const postsWarm = /postMessage\(\{\s*type:\s*'warm-charts'/.test(mainJs);

const problems = [];
const fmt = (n) => n.toFixed(1) + 'KB';

console.log('首屏性能预算');
for (const x of coreItems) console.log('  ' + x.f.padEnd(30) + fmt(x.kb));
console.log('  核心数据合计'.padEnd(32) + fmt(coreKB) + ' / ' + BUDGET.coreDataKB + 'KB');
console.log('  外壳 JS/CSS（' + shellItems.length + ' 个文件）'.padEnd(26) + fmt(shellKB) + ' / ' + BUDGET.shellKB + 'KB');
console.log('  首屏合计（含图标）'.padEnd(30) + fmt(firstLoadKB) + ' / ' + BUDGET.firstLoadKB + 'KB');
console.log('  懒加载：echarts ' + fmt(gzipSize('vendor/echarts.min.js') / 1024) +
  ' · monthly ' + fmt(gzipSize('data/monthly.json') / 1024) +
  ' · 财报整包（仅对比模式全市场选股用）' );

if (coreKB > BUDGET.coreDataKB) problems.push(`首屏核心数据 ${fmt(coreKB)} 超预算 ${BUDGET.coreDataKB}KB`);
if (shellKB > BUDGET.shellKB) problems.push(`外壳 JS/CSS ${fmt(shellKB)} 超预算 ${BUDGET.shellKB}KB`);
if (firstLoadKB > BUDGET.firstLoadKB) problems.push(`首屏总量 ${fmt(firstLoadKB)} 超预算 ${BUDGET.firstLoadKB}KB`);
if (syncEcharts) problems.push('index.html 里仍有同步 ECharts <script>，必须是按需加载');
if (!lazyEcharts) problems.push('src/charts.js 找不到 ensureEcharts 懒加载实现');
if (!warmList.some((u) => u.replace(/^\.\//, '') === 'vendor/echarts.min.js')) problems.push('sw.js 的 WARM 里应包含 vendor/echarts.min.js（离线画图暖缓存）');
if (!postsWarm) problems.push('src/main.js 没有在空闲时发 { type: \'warm-charts\' } 让 SW 补缓存');
for (const f of mustNotPrecache) {
  const base = f.replace(/^\.\//, '');
  const hit = shellList.some((u) => u.replace(/^\.\//, '') === base || u.includes(base));
  if (hit) problems.push(`${f} 是懒加载大文件，不应进 SW 预缓存`);
}
for (const f of mustPrecache) {
  const base = f.replace(/^\.\//, '');
  const hit = shellList.some((u) => u.replace(/^\.\//, '') === base);
  if (!hit) problems.push(`${f} 应在 SW 预缓存里（离线可用）`);
}

/* SW 安装时后台预缓存总量（不阻塞首屏，但影响首次访问流量） */
let precacheKB = 0;
for (const u of shellList) {
  const rel = u === './' ? 'index.html' : u.replace(/^\.\//, '');
  if (fs.existsSync(path.join(ROOT, rel))) precacheKB += gzipSize(rel) / 1024;
}
console.log('  SW 后台预缓存合计（' + shellList.length + ' 项）'.padEnd(28) + fmt(precacheKB) + ' / ' + BUDGET.precacheKB + 'KB');
console.log('  暖缓存（空闲补下）'.padEnd(30) + warmList.join(', '));
if (precacheKB > BUDGET.precacheKB) problems.push(`SW 预缓存 ${fmt(precacheKB)} 超预算 ${BUDGET.precacheKB}KB`);

if (problems.length) {
  console.log('\n✗ 预算/结构检查失败：');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\n✓ 性能预算与懒加载结构全部通过。');
