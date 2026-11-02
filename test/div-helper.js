/**
 * 测试夹具专用：把「年度合计 years」摊成「真实除权日 ev」。
 *
 * 引擎的口径只有一条：分红必须带除权除息日（ev），没有就一律不计。
 * 所以夹具不能只写 years——那只能喂给股息率/选股判断，喂不进回测。
 *
 * 约定：第 Y 年度的分红，落在 Y+1 年 6-30 除息（比实际 4 月末晚两个月，不影响验证）。
 */
export function withEv(dividends, monthDay = '06-30') {
  const out = {};
  for (const [code, d] of Object.entries(dividends || {})) {
    const ev = Object.entries(d?.years || {})
      .map(([y, v]) => [`${Number(y) + 1}-${monthDay}`, v])
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    out[code] = { ...d, ev };
  }
  return out;
}
