import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, num, sign, pct, pctSign, money, wan, moneyParts, bigMoney, price, upDown, levelPill, dot, clamp, shortDate,
} from '../src/ui/format.js';

test('esc：转义 HTML 危险字符，null/undefined 变空串', () => {
  assert.equal(esc('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc('普通文本'), '普通文本');
});

test('num：正常值按固定小数位，非法值回退', () => {
  assert.equal(num(1.2345, 2), '1.23');
  assert.equal(num(0), '0.0');
  assert.equal(num(null), '—');
  assert.equal(num(undefined), '—');
  assert.equal(num(NaN), '—');
  assert.equal(num(Infinity), '—');
  assert.equal(num(-0.05, 2), '-0.05');
  assert.equal(num(1, 0, 'N/A'), '1');
});

test('sign：正数带 +，负数/0 不带，非法值回退', () => {
  assert.equal(sign(3.14), '+3.1');
  assert.equal(sign(-2.5), '-2.5');
  assert.equal(sign(0), '0.0');
  assert.equal(sign(null), '—');
  assert.equal(sign(NaN), '—');
});

test('pct / pctSign：百分比格式与符号', () => {
  assert.equal(pct(12.345, 1), '12.3%');
  assert.equal(pct(0), '0.0%');
  assert.equal(pct(null), '—');
  assert.equal(pctSign(5.5, 2), '+5.50%');
  assert.equal(pctSign(-5.5, 2), '-5.50%');
  assert.equal(pctSign(0, 1), '0.0%');
  assert.equal(pctSign(Infinity), '—');
});

test('money：亿 / 万 / 元三档，非法值回退', () => {
  assert.equal(money(1.5e8), '1.50亿');
  assert.equal(money(-2.34e8), '-2.34亿');
  assert.equal(money(123456), '12.35万'); // 12.3456 万，四舍五入保留 2 位
  assert.equal(money(1234567), '123.5万'); // >=1e6 只保留 1 位
  assert.equal(money(9999), '9,999');
  assert.equal(money(0), '0');
  assert.equal(money(NaN), '—');
});

test('wan / price：万元与价格格式', () => {
  assert.equal(wan(23000), '2.3');
  assert.equal(wan(23000, 2), '2.30');
  assert.equal(wan(null), '—');
  assert.equal(price(9.876), '9.88');
  assert.equal(price(123.45), '123.5'); // >=100 只保留 1 位
  assert.equal(price(null), '—');
});

test('moneyParts / bigMoney：万 / 亿 / 万亿 三档切换（防长数字串）', () => {
  assert.deepEqual(moneyParts(613000), { v: '61.3', u: '万' });
  assert.deepEqual(moneyParts(123456789), { v: '1.23', u: '亿' });
  assert.deepEqual(moneyParts(-5e12), { v: '-5.00', u: '万亿' });
  assert.deepEqual(moneyParts(null), { v: '—', u: '' });
  assert.deepEqual(moneyParts(NaN), { v: '—', u: '' });
  assert.equal(bigMoney(613000), '61.3 万');
  assert.equal(bigMoney(1e12), '1.00 万亿');
  assert.equal(bigMoney(-2.5e8), '-2.50 亿');
  assert.equal(bigMoney(null), '—');
});

test('upDown：涨跌 class，0 与非法值为空串', () => {
  assert.equal(upDown(1), 'up');
  assert.equal(upDown(-1), 'down');
  assert.equal(upDown(0), '');
  assert.equal(upDown(null), '');
  assert.equal(upDown(NaN), '');
});

test('levelPill：等级映射到样式类，文本被转义', () => {
  assert.equal(levelPill('buy', '可买'), '<span class="pill buy">可买</span>');
  assert.equal(levelPill('hold', '持有'), '<span class="pill hold">持有</span>');
  assert.equal(levelPill('wait', '观察'), '<span class="pill wait">观察</span>');
  assert.equal(levelPill('avoid', '回避'), '<span class="pill avoid">回避</span>');
  assert.equal(levelPill('missing', '数据不足'), '<span class="pill na">数据不足</span>');
  assert.equal(levelPill('unknown', 'x'), '<span class="pill neutral">x</span>');
  assert.equal(levelPill('buy', '<script>'), '<span class="pill buy">&lt;script&gt;</span>');
});

test('dot / clamp / shortDate', () => {
  assert.equal(dot(), '<span class="dot "></span>');
  assert.equal(dot('warn'), '<span class="dot warn"></span>');
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-1, 1, 10), 1);
  assert.equal(clamp(99, 1, 10), 10);
  assert.equal(clamp(NaN, 1, 10), NaN); // 与 Math.max/min 一致，不在本函数兜底
  assert.equal(shortDate('2026-10-30'), '2026.10.30');
  assert.equal(shortDate(''), '—');
  assert.equal(shortDate(null), '—');
});
