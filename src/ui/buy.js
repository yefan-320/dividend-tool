/* 买入弹层：个股页 / 选股页 / 我的页共用，写入本地组合 */
import { db, quote, nameOf } from '../data.js';
import { addTx } from '../store.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { esc } from './format.js';

/**
 * @param {string} code
 * @param {{onDone?:Function}} [opts]
 */
export function openBuyModal(code, opts = {}) {
  const q = quote(code);
  const name = nameOf(code);
  const price = q?.p ?? 0;
  const today = db.generated || new Date().toISOString().slice(0, 10);
  openModal({
    title: `买入 ${name}`,
    body: `<div class="modal-form">
      <label class="modal-field"><span>日期</span><input class="input" id="buyDate" type="date" value="${esc(today)}" max="${esc(today)}"></label>
      <label class="modal-field"><span>股数（建议 100 的整数倍）</span><input class="input" id="buyShares" type="number" step="100" min="1" value="1000"></label>
      <label class="modal-field"><span>成本价</span><input class="input" id="buyPrice" type="number" step="0.01" min="0.01" value="${price || ''}"></label>
      <div class="modal-hint">当前价 ${price ? price.toFixed(2) : '—'} · 代码 ${esc(code)} · 只存本地，不上传</div>
    </div>`,
    actions: [
      { label: '取消', kind: 'ghost' },
      {
        label: '计入组合', kind: 'primary', onClick: () => {
          const date = document.getElementById('buyDate')?.value;
          const shares = Number(document.getElementById('buyShares')?.value);
          const px = Number(document.getElementById('buyPrice')?.value);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { toast('请选择买入日期'); return false; }
          if (!(shares > 0) || !(px > 0)) { toast('股数和成本价要大于 0'); return false; }
          addTx({ date, code, side: 'buy', shares, price: px, fee: 5 });
          toast(`已计入组合：${name} ${shares} 股`);
          setTimeout(() => { (opts.onDone || window.__rerender)?.(); }, 60);
        },
      },
    ],
  });
}
