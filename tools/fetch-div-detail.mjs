/**
 * 分红明细：把「每年一个合计」换成「每一笔的除权除息日 + 每股派息」。
 *
 * 为什么要换：一年可能分两次（中期 + 年度），合计算不出哪天除权。
 * 而分红复投必须落在**除权除息日当天收盘**——那天股价已经除息，按不复权收盘价买才对。
 *
 * 数据源：东方财富 RPT_SHAREBONUS_DET
 *   EX_DIVIDEND_DATE   除权除息日
 *   PRETAX_BONUS_RMB   每 10 股派息（税前），÷10 = 每股
 *
 * 产出：data/div/<code>.json
 *   { "ev": [["2025-07-11", 2.0], ["2026-01-16", 1.013]], "years": { ... } }
 *   ev 是新的，按日期升序；years 保留给旧逻辑兜底。
 *
 * 用法：node tools/fetch-div-detail.mjs [--limit 20] [--codes 600036,000651]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'div');
const POOL = path.join(ROOT, 'data', 'pool.json');

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : 0;
const codesArg = args.indexOf('--codes');
const ONLY = codesArg >= 0 ? String(args[codesArg + 1]).split(',').map((s) => s.trim()).filter(Boolean) : null;

const API = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function batchUrl(codes) {
  const list = codes.map((c) => `"${c}"`).join(',');
  const p = new URLSearchParams({
    reportName: 'RPT_SHAREBONUS_DET',
    columns: 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB',
    filter: `(SECURITY_CODE in (${list}))`,
    pageSize: '2000',
    sortColumns: 'EX_DIVIDEND_DATE',
    sortTypes: '1',
  });
  return `${API}?${p}`;
}

/** 一批股票的所有分红明细 → Map<code, [[date, dps], ...]> */
async function fetchBatch(codes) {
  const { execFileSync } = await import('node:child_process');
  let all = [];
  for (let page = 1; page <= 6; page++) {
    const u = `${batchUrl(codes)}&pageNumber=${page}`;
    const out = execFileSync('curl', ['-s', '--max-time', '30', u], { encoding: 'utf8', maxBuffer: 32 << 20 });
    const j = JSON.parse(out);
    const rows = j?.result?.data || [];
    all = all.concat(rows);
    if (!rows.length || !j.result?.pages || page >= j.result.pages) break;
  }
  const map = new Map();
  for (const r of all) {
    const code = String(r.SECURITY_CODE || '');
    const d = String(r.EX_DIVIDEND_DATE || '').slice(0, 10);
    const per10 = Number(r.PRETAX_BONUS_RMB);
    if (!/^\d{6}$/.test(code)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;      // 预案未实施：没有除权日
    if (!Number.isFinite(per10) || per10 <= 0) continue; // 只送股/转增，不派现
    if (!map.has(code)) map.set(code, []);
    map.get(code).push([d, Math.round((per10 / 10) * 10000) / 10000]);
  }
  for (const arr of map.values()) arr.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return map;
}

function yearsFrom(ev) {
  const y = {};
  for (const [d, v] of ev) {
    // 分红记在「所属年度」：除权日在 1–6 月的算上一年度（年报分红），7–12 月算本年度
    const yy = Number(d.slice(0, 4));
    const key = Number(d.slice(5, 7)) <= 6 ? yy - 1 : yy;
    y[key] = Math.round(((y[key] || 0) + v) * 10000) / 10000;
  }
  return y;
}

async function main() {
  const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
  let codes = ONLY || Object.keys(pool).filter((c) => /^\d{6}$/.test(c));
  if (LIMIT) codes = codes.slice(0, LIMIT);
  console.log(`拉 ${codes.length} 只的分红明细…`);

  let done = 0;
  let hit = 0;
  let totalBytes = 0;
  const fails = [];

  const BATCH = 50;
  const batches = [];
  for (let i = 0; i < codes.length; i += BATCH) batches.push(codes.slice(i, i + BATCH));

  const CONC = 6;
  let bi = 0;
  async function worker() {
    while (bi < batches.length) {
      const batch = batches[bi++];
      let map = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          map = await fetchBatch(batch);
          break;
        } catch (e) {
          if (attempt === 2) fails.push(...batch);
          await sleep(600 + attempt * 1200);
        }
      }
      if (map) {
        for (const [code, ev] of map) {
          if (!ev.length) continue;
          hit++;
          let years = {};
          try {
            const old = JSON.parse(fs.readFileSync(path.join(OUT, code + '.json'), 'utf8'));
            if (old && old.years) years = old.years;
          } catch (e) { /* 没有旧文件 */ }
          // years 保留旧口径（组合回测的股息率靠它），只在缺失时用明细派生的补上
          const out = { years: Object.keys(years).length ? years : yearsFrom(ev), ev };
          const json = JSON.stringify(out);
          fs.writeFileSync(path.join(OUT, code + '.json'), json);
          totalBytes += json.length;
        }
      }
      done += batch.length;
      if (done % 500 < BATCH) process.stdout.write(`  ${done}/${codes.length} · 有分红 ${hit} · 失败 ${fails.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  console.log(`\n✓ 完成 ${done} 只，有分红记录 ${hit} 只，失败 ${fails.length} 只`);
  console.log(`  平均 ${(totalBytes / Math.max(1, hit)).toFixed(0)}B/只`);
  if (fails.length) fs.writeFileSync('/tmp/div-fail.txt', fails.join('\n'));
  if (fails.length) console.log(`  失败清单：/tmp/div-fail.txt`);
}

main().catch((e) => { console.error(e); process.exit(1); });
