/**
 * 搜索索引：把 5552 只股票的「代码 | 名称 | 行业」压成一行一只的纯文本。
 *
 * 为什么单独一个文件：pool.json 带市值，369KB / gzip 104KB；
 * 搜索只需要名字，压成 txt 后 gzip ≈ 60KB。个股页、回测页打字时才拉这一份，
 * 不必为了搜一只股票去下整包股票池。
 *
 * 产出：data/name-idx.txt
 *   600519|贵州茅台|白酒Ⅱ
 *   000858|五 粮 液|白酒Ⅱ
 *
 * 用法：node tools/build-name-index.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'data', 'pool.json');
const OUT = path.join(ROOT, 'data', 'name-idx.txt');

const pool = JSON.parse(fs.readFileSync(SRC, 'utf8'));

/**
 * 市值分档（0 最大 · 7 最小）。搜索同分时按这一档排序：
 * 打「格力」要的是格力电器（2310 亿），不是格力博（100 亿）；
 * 打「平安」要的是中国平安，不是平安银行。光按代码排做不出这个效果。
 */
function capRank(cap) {
  const c = Number(cap) || 0;
  if (c >= 5e11) return 0;
  if (c >= 1e11) return 1;
  if (c >= 5e10) return 2;
  if (c >= 2e10) return 3;
  if (c >= 1e10) return 4;
  if (c >= 5e9) return 5;
  if (c >= 2e9) return 6;
  return 7;
}

const lines = [];
for (const [code, v] of Object.entries(pool)) {
  if (!/^\d{6}$/.test(code)) continue;
  const name = String(v?.n || '').replace(/\|/g, ' ').trim();
  if (!name) continue;
  const ind = String(v?.ind || '').replace(/\|/g, ' ').trim();
  lines.push(`${code}|${name}|${ind}|${capRank(v?.cap)}`);
}
lines.sort();

const txt = lines.join('\n');
fs.writeFileSync(OUT, txt, 'utf8');

const rawKB = (Buffer.byteLength(txt) / 1024).toFixed(0);
const gzKB = (zlib.gzipSync(Buffer.from(txt), { level: 9 }).length / 1024).toFixed(1);
console.log(`✓ ${OUT}`);
console.log(`  ${lines.length} 只 · 原文 ${rawKB}KB · gzip ${gzKB}KB`);
