#!/usr/bin/env node
/**
 * 静态一致性检查：不启动浏览器，检查「文件引用」有没有断。
 *
 * 检查项：
 *  1. index.html 里本地 CSS / JS / manifest / icon 引用都存在；
 *  2. sw.js 的 SHELL 预缓存列表里每个文件都存在（改名/删文件后最容易漏）；
 *  3. src/**、tools/**、test/** 里的相对 import/export from 都能解析到真实文件；
 *  4. manifest.webmanifest 的 icons / start_url 文件存在；
 *  5. data.js 里 getJson('xxx.json') 引用的数据文件存在；
 *  6. 页面模块导出的 render / bind 函数与 main.js 的 PAGES 配置匹配（少了会在运行时白屏）。
 *
 * 用法：node tools/check-static.mjs   （有问题 exit 1；全部通过 exit 0）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const issues = [];
const ok = [];
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => {
  try { return fs.statSync(path.join(ROOT, p)).isFile(); } catch (e) { return false; }
};
const clean = (u) => u.split('?')[0].split('#')[0];

/* 1. index.html 本地资源 */
const html = read('index.html');
for (const m of html.matchAll(/(?:href|src)="(?!https?:|data:|#)([^"]+)"/g)) {
  const p = clean(m[1]);
  if (!exists(p)) issues.push(`index.html 引用不存在：${p}`);
}
ok.push('index.html 本地引用');

/* 2. sw.js SHELL 预缓存列表 */
const sw = read('sw.js');
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
const shellPaths = new Set();
if (!shellBlock) issues.push('sw.js 里找不到 SHELL 数组');
else {
  const entries = [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // './' 与 './index.html' 等价于根目录
  for (const raw of entries) {
    const p = raw === './' ? 'index.html' : clean(raw.replace(/^\.\//, ''));
    shellPaths.add(p.split(path.sep).join('/'));
    if (!exists(p)) issues.push(`sw.js SHELL 预缓存的文件不存在：${raw}`);
  }
  ok.push(`sw.js SHELL（${entries.length} 个文件）`);
}

/* 3. import / export from 解析 */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(name)) out.push(full);
  }
  return out;
}
const jsFiles = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tools')), ...walk(path.join(ROOT, 'test'))];
let importCount = 0;
for (const file of jsFiles) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\bfrom\s*)?['"](\.[^'"]+)['"]/g)) {
    const spec = m[1];
    const target = path.resolve(path.dirname(file), spec);
    const candidates = [target, target + '.js', target + '.mjs', path.join(target, 'index.js')];
    importCount++;
    if (!candidates.some((p) => fs.existsSync(p) && fs.statSync(p).isFile())) {
      issues.push(`${path.relative(ROOT, file)} 引用了不存在的模块：${spec}`);
    }
  }
}
ok.push(`模块 import（${jsFiles.length} 个文件 / ${importCount} 条相对引用）`);

/* 3b. SHELL 反向覆盖：src 下每个模块都必须进安装预缓存
   —— 只做正向（列了就必须存在）挡不住「新增模块忘了登记」。
      回测页拆成三块的当天就漏了 core.js / view.js：新装用户断网首访时
      模块图求值拿到 503，main.js 的静态 import 链整体失败，整站白屏，
      连 main.js 自己的错误横幅都渲染不出来。
   确实该懒加载的模块，在 LAZY_MODULES 里登记并写清原因。 */
const LAZY_MODULES = new Set([
  // 暂无：图表库在 vendor/ 走 WARM 后台补，不属于 src
]);
const srcRel = walk(path.join(ROOT, 'src')).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
const notPrecached = srcRel.filter((rel) => !shellPaths.has(rel) && !LAZY_MODULES.has(rel));
for (const rel of notPrecached) {
  issues.push(`src 模块没进 sw.js 的 SHELL 预缓存：${rel}（离线首访会 503 → 白屏；确属懒加载就登记到 LAZY_MODULES）`);
}
ok.push(`SHELL 覆盖 src 模块（${srcRel.length - notPrecached.length}/${srcRel.length}）`);

/* 4. manifest */
const manifest = JSON.parse(read('manifest.webmanifest'));
if (!manifest.icons?.length) issues.push('manifest 里没有 icons');
for (const icon of manifest.icons || []) {
  const p = clean(icon.src.replace(/^\.\//, ''));
  if (!exists(p)) issues.push(`manifest 图标不存在：${icon.src}`);
}
const start = clean((manifest.start_url || '').replace(/^\.\//, ''));
if (start && !exists(start)) issues.push(`manifest.start_url 指向不存在的文件：${manifest.start_url}`);
ok.push('manifest 图标 / start_url');

/* 5. data.js 里 getJson 引用的数据文件 */
const dataJs = read('src/data.js');
for (const m of dataJs.matchAll(/getJson\(\s*[`'"]((?:daily\/)?[^`'"$]+\.json)[`'"]/g)) {
  const p = 'data/' + m[1];
  if (!exists(p)) issues.push(`data.js 引用的数据文件不存在：${p}`);
}
ok.push('data.js 数据文件引用');

/* 6. 页面导出 render/bind 与 main.js PAGES 对应

   页面拆成多文件后，入口改用 `export { x } from './子模块.js'` 再导出。
   这里必须**顺着 from 打开目标模块确认它真的导出了 x**——只看名字有没有出现在
   花括号里是不够的：改名后忘了同步，`export { 旧名 } from './core.js'` 照样通过，
   运行时抛 "does not provide an export named"，整页白屏。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const resolveSpec = (fromFile, spec) => {
  const target = path.resolve(path.dirname(fromFile), spec);
  const candidates = [target, target + '.js', target + '.mjs', path.join(target, 'index.js')];
  return candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
};
const exportCache = new Map();
/** 一个模块对外提供哪些导出名（本地声明 + 逐层展开的再导出） */
function exportedNames(file, seen = new Set()) {
  if (exportCache.has(file)) return exportCache.get(file);
  if (seen.has(file)) return new Set(); // 环：不再展开，交给其它检查项兜
  seen.add(file);
  const out = new Set();
  let code = '';
  try { code = stripComments(fs.readFileSync(file, 'utf8')); } catch (e) { return out; }
  // 本地导出声明
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  // export { a, b as c }  /  export { a } from './x.js'
  for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g)) {
    const specs = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const parts = s.split(/\s+as\s+/);
        return { local: parts[0].trim(), as: parts[parts.length - 1].trim() };
      });
    if (!m[2]) {
      // 无 from：本地绑定再导出（本项目目前没有；不做作用域分析，乐观接受）
      for (const { as } of specs) out.add(as);
      continue;
    }
    const target = resolveSpec(file, m[2]);
    if (!target) continue; // 路径断了由第 3 项报
    const sub = exportedNames(target, seen);
    for (const { local, as } of specs) if (sub.has(local)) out.add(as);
  }
  exportCache.set(file, out);
  return out;
}
const mainJs = read('src/main.js');
const pageDefs = [...mainJs.matchAll(/import \{ ([^}]+) \} from '\.\/pages\/([a-z]+)\.js'/g)];
const pageImports = new Map();
for (const [, names, mod] of pageDefs) pageImports.set(mod, names.split(',').map((s) => s.trim()));
for (const [mod, names] of pageImports) {
  const provided = exportedNames(path.join(ROOT, 'src/pages', `${mod}.js`));
  for (const nm of names) {
    if (!provided.has(nm)) issues.push(`main.js 从 pages/${mod}.js 导入了 ${nm}，但该文件（含再导出）没提供`);
  }
}
ok.push(`页面模块导出（${pageImports.size} 个页面）`);

/* 输出 */
for (const line of ok) console.log('✓ ' + line);
if (issues.length) {
  console.log(`\n✗ 发现 ${issues.length} 个问题：`);
  for (const line of issues) console.log('  - ' + line);
  process.exit(1);
}
console.log('\n静态检查全部通过。');
