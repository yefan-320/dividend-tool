/**
 * 单只股票的决策（第一版：硬约束 + 股息率）。
 *
 * 设计原则：
 *  - 财报缺失 → 直接「数据不足」，不给买卖
 *  - 分红不可持续（支付率过高 / 经营现金流覆盖不足）→ 回避，再高的股息率也不买
 *  - 股息率不够 → 观察
 *  - 只有「财务健康 + 股息率达标」才给「可买」
 *
 * 这是最小可用规则；P2 会加上估值分位、历史信号与置信度。
 */

/** 五个等级的显示名。三个页面以前各自抄了一份，改一处必漏两处——现在只有这一份。 */
export const LEVEL = { buy: '可买', wait: '观察', avoid: '回避', missing: '数据不足', hold: '持有' };

export function latestFin(f10, code) {
  const fin = f10?.[code];
  if (!fin) return null;
  const ys = Object.keys(fin.years || {}).filter((y) => fin.years[y]?.reportDate).sort();
  if (!ys.length) return null;
  const y = ys[ys.length - 1];
  return { year: y, ...fin.years[y] };
}

export function latestDps(div) {
  if (!div) return null;
  const years = div.years || {};
  const ys = Object.keys(years).map(Number).filter((y) => years[y] > 0).sort((a, b) => a - b);
  if (!ys.length) return null;
  const y = ys[ys.length - 1];
  return { year: y, dps: years[y] };
}

/** 连续分红年数（从最近分红年往前） */
export function consecutiveYears(div) {
  const years = div?.years || {};
  let last = null;
  for (const y of Object.keys(years).map(Number).sort((a, b) => b - a)) {
    if (years[y] > 0) { last = y; break; }
  }
  if (!last) return 0;
  let n = 0;
  for (let y = last; y >= last - 40; y--) {
    if (years[y] > 0) n++;
    else break;
  }
  return n;
}

/**
 * @param {string} code
 * @param {object} ctx {quotes, dividends, f10}
 */
export function evaluate(code, ctx) {
  const q = ctx.quotes?.[code] || null;
  const div = ctx.dividends?.[code] || null;
  const finRaw = ctx.finance?.[code];
  const fin = finRaw
    ? { eps: finRaw[0], roe: finRaw[1], nm: finRaw[2], liab: finRaw[3], ocfps: finRaw[4], np: finRaw[5] }
    : latestFin(ctx.f10, code);
  const dpsInfo = latestDps(div);
  const price = q?.p ?? null;
  const dy = dpsInfo && price ? (dpsInfo.dps / price) * 100 : null;
  const consecutive = consecutiveYears(div);

  const reasons = [];
  const metrics = {
    price,
    dy,
    consecutive,
    dps: dpsInfo?.dps ?? null,
    dpsYear: dpsInfo?.year ?? null,
    payout: null,
    ocfCover: null,
    roe: null,
    hasFin: !!fin,
    eps: fin?.eps ?? null,
    nm: fin?.nm ?? null,
    liab: fin?.liab ?? null,
    ocfps: fin?.ocfps ?? null,
    finYear: fin?.year ?? ctx.finYear ?? null,
  };

  if (fin) {
    if (Number.isFinite(fin.eps) && fin.eps > 0 && dpsInfo) metrics.payout = (dpsInfo.dps / fin.eps) * 100;
    if (Number.isFinite(fin.eps) && fin.eps > 0 && Number.isFinite(fin.ocfps)) metrics.ocfCover = fin.ocfps / fin.eps;
    if (Number.isFinite(fin.roe)) metrics.roe = fin.roe;
    if (Number.isFinite(fin.nm)) metrics.nm = fin.nm;
    if (Number.isFinite(fin.liab)) metrics.liab = fin.liab;
  }

  // 1. 数据不足：没财报
  if (!fin) {
    if (dy != null && dy > 15) {
      reasons.push(`股息率 ${dy.toFixed(1)}% 明显异常（多为股价大跌或一次性分红），且缺财报无法核实`);
    } else {
      reasons.push('缺完整财报，无法判断分红是否可持续');
    }
    return { code, name: q?.n || code, level: 'missing', reasons, metrics };
  }

  // 2. 股息率异常：>15% 一律先核实，不买
  if (dy != null && dy > 15) {
    reasons.push(`股息率 ${dy.toFixed(1)}% 异常高，多为股价大跌或一次性分红，先核实再说`);
    return { code, name: q?.n || code, level: 'avoid', reasons, metrics };
  }

  // 3. 亏损：分红没有利润支撑
  if (fin.eps != null && fin.eps <= 0) {
    reasons.push('最近年度亏损，分红没有利润支撑');
    return { code, name: q?.n || code, level: 'avoid', reasons, metrics };
  }

  // 4. 分红可持续性硬约束
  // 80% 而不是 85%：研究里「派息率 10%–80%」是模型的实际门槛，
  // 83% 那种已经是在硬撑分红了，不该给「可买」。
  if (metrics.payout != null && metrics.payout >= 80) {
    reasons.push(`支付率 ${metrics.payout.toFixed(0)}%，把利润几乎分光，不可持续`);
    return { code, name: q?.n || code, level: 'avoid', reasons, metrics };
  }
  if (metrics.ocfCover == null) {
    reasons.push('缺每股经营现金流，无法判断分红是不是挣来的');
    return { code, name: q?.n || code, level: 'missing', reasons, metrics };
  }
  if (metrics.ocfCover < 0.7) {
    reasons.push(`经营现金流 / 净利 ${metrics.ocfCover.toFixed(2)}，分红不是靠经营挣来的`);
    return { code, name: q?.n || code, level: 'avoid', reasons, metrics };
  }
  if (metrics.payout != null && metrics.payout < 20) {
    reasons.push(`支付率只有 ${metrics.payout.toFixed(0)}%，股息率高是股价跌出来的，不是分红给出来的`);
    return { code, name: q?.n || code, level: 'avoid', reasons, metrics };
  }

  // 5. 股息率太高：8% 以上不是机会，是市场在定价「这次分红撑不住」。
  //    研究（tools/research/README.md 发现二）里 8–9% 这一档几何年化只有 7.0%，
  //    而 5–6.5% 那一档是 16.9%——同一套筛选规则，光改股息率区间就差一倍多。
  if (dy != null && dy > 8) {
    reasons.push(`股息率 ${dy.toFixed(1)}%，已经进了「太高」那一段：8%–9% 这一档的长期年化只有 7.0%，5%–6.5% 那一档是 16.9%。市场肯给这么高的股息率，往往是在说这次分红撑不住，先当观察，别急着加仓`);
    return { code, name: q?.n || code, level: 'wait', reasons, metrics };
  }

  // 6. 股息率门槛
  if (dy != null && dy >= 5 && consecutive >= 5) {
    reasons.push(`股息率 ${dy.toFixed(1)}%、连续分红 ${consecutive} 年、支付率 ${metrics.payout == null ? '—' : metrics.payout.toFixed(0) + '%'}、现金流覆盖 ${metrics.ocfCover == null ? '—' : metrics.ocfCover.toFixed(2)}`);
    return { code, name: q?.n || code, level: 'buy', reasons, metrics };
  }

  if (dy != null && dy >= 4) {
    reasons.push(`股息率 ${dy.toFixed(1)}%，接近 5% 门槛；财务健康，等价格再低一点`);
    return { code, name: q?.n || code, level: 'wait', reasons, metrics };
  }

  reasons.push(`股息率 ${dy == null ? '—' : dy.toFixed(1)}%，低于 4%，没有吸引力`);
  return { code, name: q?.n || code, level: 'wait', reasons, metrics };
}
