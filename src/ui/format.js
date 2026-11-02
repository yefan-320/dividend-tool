/* 数字与文本格式化：单一实现，页面不再各写一套 */
export const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 数字归零：-0.04 这类四舍五入后会印成「-0.0」「-0%」，看着像负数其实没有 */
function unneg(v, d) {
  const n = Number(v);
  if (!isFinite(n)) return n;
  const eps = 0.5 * Math.pow(10, -d);
  return Math.abs(n) < eps ? 0 : n;
}

export function num(v, d = 1, fallback = '—') {
  if (v == null || !isFinite(v)) return fallback;
  return unneg(v, d).toFixed(d);
}

export function sign(v, d = 1, fallback = '—') {
  if (v == null || !isFinite(v)) return fallback;
  const n = unneg(v, d);
  return (n > 0 ? '+' : '') + n.toFixed(d);
}

export function pct(v, d = 1) {
  if (v == null || !isFinite(v)) return '—';
  return unneg(v, d).toFixed(d) + '%';
}

export function pctSign(v, d = 1) {
  if (v == null || !isFinite(v)) return '—';
  const n = unneg(v, d);
  return (n > 0 ? '+' : '') + n.toFixed(d) + '%';
}

export function money(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(a >= 1e6 ? 1 : 2) + '万';
  return Math.round(v).toLocaleString('zh-CN');
}

export function wan(v, d = 1) {
  if (v == null || !isFinite(v)) return '—';
  return (v / 1e4).toFixed(d);
}

/** 金额拆成「数值 + 单位」：≥1 万亿用万亿、≥1 亿用亿，否则万（避免 1e12 元显示 9 位长串） */
export function moneyParts(v) {
  if (v == null || !isFinite(v)) return { v: '—', u: '' };
  const a = Math.abs(v);
  if (a >= 1e12) return { v: (v / 1e12).toFixed(2), u: '万亿' };
  if (a >= 1e8) return { v: (v / 1e8).toFixed(2), u: '亿' };
  return { v: (v / 1e4).toFixed(1), u: '万' };
}

/** 金额简写（含单位），适合文案/表格；需要分开字号时用 moneyParts */
export function bigMoney(v) {
  const p = moneyParts(v);
  return p.u ? p.v + ' ' + p.u : p.v;
}

export function price(v) {
  if (v == null || !isFinite(v)) return '—';
  return v >= 100 ? v.toFixed(1) : v.toFixed(2);
}

export const upDown = v => (v == null || !isFinite(v)) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';

export function levelPill(level, text) {
  const map = { buy: 'buy', hold: 'hold', wait: 'wait', avoid: 'avoid', missing: 'na', na: 'na' };
  return `<span class="pill ${map[level] || 'neutral'}">${esc(text)}</span>`;
}

export function dot(color = 'ok') {
  return `<span class="dot ${color === 'ok' ? '' : color}"></span>`;
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/** 支付率 = 分红 ÷ EPS。EPS 接近 0 会炸成几千 %（康美药业实测 3429%），那是分母坏了，
 *  不是高分红：一律显示「异常」，排序也丢到最后。 */
export const PAYOUT_CAP = 500;

export function payoutText(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v > PAYOUT_CAP) return '异常';
  return num(v, 0) + '%';
}

export function shortDate(d) {
  if (!d) return '—';
  return String(d).replace(/-/g, '.').slice(0, 10);
}
