/**
 * 组合收益计算（纯函数）。
 *
 * 支持多笔不同时间买入、部分卖出（FIFO），计算：
 *  - 每笔买入的持有收益、分红、年化、XIRR
 *  - 组合整体 XIRR、加权收益率、时间轴
 *
 * 分红规则（估算）：A 股上一年度分红多在次年 5-7 月实施。
 * 这里约定「Y 年度分红在 Y+1-06-30 实施」：买入日在实施日之前才计入。
 */
import { xirr } from './finance.js';

const DAY = 86400000;
const parseDate = (s) => Date.parse(s + (s.length === 10 ? 'T00:00:00' : ''));

/** 年度分红实施日（近似） */
export function dividendPayDate(year) {
  return `${year + 1}-06-30`;
}

/** 某笔买入在持有期内可获得的年度分红 [{year, payDate, dps, cash}] */
export function dividendsForLot(lot, divs, today) {
  const years = divs?.[lot.code]?.years || {};
  const out = [];
  const buyT = parseDate(lot.date);
  const todayT = parseDate(today);
  for (const [yStr, dps] of Object.entries(years)) {
    const y = Number(yStr);
    if (!(dps > 0)) continue;
    const payDate = dividendPayDate(y);
    const payT = parseDate(payDate);
    if (buyT < payT && payT <= todayT) {
      out.push({ year: y, payDate, dps, cash: dps * lot.shares });
    }
  }
  out.sort((a, b) => a.payDate.localeCompare(b.payDate));
  return out;
}

/**
 * FIFO 处理交易，返回当前持仓 lot 和已实现收益。
 * @param {Array} txs [{id,date,code,side:'buy'|'sell',shares,price,fee?}]
 */
export function buildLots(txs) {
  // 无日期 / 非法日期的交易直接丢弃（旧备份、脏 localStorage 可能写坏；parseDate 会抛错）
  const sorted = (Array.isArray(txs) ? txs : [])
    .filter((tx) => tx && typeof tx.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tx.date) && Number.isFinite(parseDate(tx.date)))
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  const queues = new Map(); // code -> [{date, shares, price, fee}]
  const realized = [];
  for (const tx of sorted) {
    const code = tx.code;
    const shares = Number(tx.shares) || 0;
    const price = Number(tx.price) || 0;
    const fee = Number(tx.fee) || 0;
    if (!code || shares <= 0 || price <= 0) continue;
    if (!queues.has(code)) queues.set(code, []);
    const q = queues.get(code);
    if (tx.side === 'sell') {
      let left = shares;
      let cost = 0;
      while (left > 0 && q.length) {
        const lot = q[0];
        const take = Math.min(left, lot.shares);
        const unitCost = lot.price + (lot.fee || 0) / lot.shares;
        cost += take * unitCost;
        lot.shares -= take;
        left -= take;
        if (lot.shares <= 1e-9) q.shift();
      }
      const proceeds = shares * price - fee;
      realized.push({ date: tx.date, code, shares, price, cost, proceeds, pnl: proceeds - cost });
    } else {
      q.push({ id: tx.id, date: tx.date, code, shares, price, fee, name: tx.name });
    }
  }

  const lots = [];
  for (const [code, q] of queues) {
    for (const lot of q) {
      if (lot.shares > 1e-9) {
        const cost = lot.shares * lot.price + (lot.fee || 0);
        lots.push({ ...lot, cost });
      }
    }
  }
  lots.sort((a, b) => a.date.localeCompare(b.date));
  return { lots, realized, queues };
}

/**
 * 单笔持仓统计。
 * @param {object} lot {code,date,shares,price,fee,cost}
 * @param {object} quotes {code:{p,n}}
 * @param {object} divs {code:{years}}
 * @param {string} today 'YYYY-MM-DD'
 */
export function lotStats(lot, quotes, divs, today) {
  const q = quotes[lot.code] || {};
  const name = q.n || lot.name || lot.code;
  const nowPrice = Number(q.p) || null;
  const cost = lot.cost ?? lot.shares * lot.price;
  const dividends = dividendsForLot(lot, divs, today);
  const divCash = dividends.reduce((s, d) => s + d.cash, 0);
  const marketValue = nowPrice ? nowPrice * lot.shares : null;
  const pnl = marketValue != null ? marketValue + divCash - cost : null;
  const ret = pnl != null && cost > 0 ? pnl / cost : null;
  // 未来日期的买入（脏数据）年化无意义：持有天数按 1 天展示，但年化返回 null，避免 1e28 级数字
  const heldDays = Math.round((parseDate(today) - parseDate(lot.date)) / DAY);
  const days = Math.max(1, heldDays);
  const annualized = ret != null && heldDays > 0 ? Math.pow(1 + ret, 365.25 / days) - 1 : null;

  const flows = [{ date: lot.date, amount: -cost }];
  for (const d of dividends) flows.push({ date: d.payDate, amount: d.cash });
  if (marketValue != null) flows.push({ date: today, amount: marketValue });
  const irr = pnl != null ? xirr(flows) : null;

  return {
    ...lot,
    name,
    nowPrice,
    cost,
    dividends,
    divCash,
    marketValue,
    pnl,
    ret,
    days,
    annualized,
    xirr: irr,
  };
}

/**
 * 组合整体统计。
 */
export function portfolioStats(txs, quotes, divs, today) {
  const { lots, realized } = buildLots(txs);
  const stats = lots.map((lot) => lotStats(lot, quotes, divs, today));

  const totalCost = stats.reduce((s, x) => s + x.cost, 0);
  const totalValue = stats.reduce((s, x) => s + (x.marketValue || 0), 0);
  const totalDiv = stats.reduce((s, x) => s + x.divCash, 0);
  const totalPnl = stats.reduce((s, x) => s + (x.pnl || 0), 0);
  const realizedPnl = realized.reduce((s, x) => s + x.pnl, 0);
  const totalRet = totalCost > 0 ? (totalPnl + realizedPnl) / totalCost : null;

  // 组合 XIRR：买入负、卖出正、分红正、期末市值正
  const flows = [];
  for (const tx of txs) {
    const amt = Number(tx.shares) * Number(tx.price);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    flows.push({ date: tx.date, amount: tx.side === 'sell' ? amt : -amt });
    if (Number(tx.fee) > 0) flows.push({ date: tx.date, amount: tx.side === 'sell' ? -tx.fee : -tx.fee });
  }
  for (const s of stats) for (const d of s.dividends) flows.push({ date: d.payDate, amount: d.cash });
  if (totalValue > 0) flows.push({ date: today, amount: totalValue });
  const irr = xirr(flows);

  const weightedDays = totalCost > 0 ? stats.reduce((s, x) => s + x.days * x.cost, 0) / totalCost : 0;

  // 按买入年份分组的收益贡献
  const byYear = {};
  for (const s of stats) {
    const y = s.date.slice(0, 4);
    if (!byYear[y]) byYear[y] = { year: y, cost: 0, value: 0, pnl: 0, count: 0 };
    byYear[y].cost += s.cost;
    byYear[y].value += s.marketValue || 0;
    byYear[y].pnl += s.pnl || 0;
    byYear[y].count++;
  }

  return {
    lots: stats,
    realized,
    totalCost,
    totalValue,
    totalDiv,
    totalPnl,
    realizedPnl,
    totalRet,
    xirr: irr,
    weightedDays,
    byYear: Object.values(byYear).sort((a, b) => a.year.localeCompare(b.year)),
  };
}
