/* 数字与文本格式化：单一实现，页面不再各写一套 */
export const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function num(v, d = 1, fallback = '—') {
  if (v == null || !isFinite(v)) return fallback;
  return Number(v).toFixed(d);
}

export function sign(v, d = 1, fallback = '—') {
  const s = num(v, d, fallback);
  if (s === fallback) return s;
  return (v > 0 ? '+' : '') + s;
}

export function pct(v, d = 1) {
  if (v == null || !isFinite(v)) return '—';
  return v.toFixed(d) + '%';
}

export function pctSign(v, d = 1) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
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

export function shortDate(d) {
  if (!d) return '—';
  return String(d).replace(/-/g, '.').slice(0, 10);
}
