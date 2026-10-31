/* 弹层：确认 / 输入 / 表单。统一 iOS 风格底部弹层（移动端）/ 居中卡片（桌面端）。 */
import { esc } from './format.js';

let backdrop = null;
let modal = null;
let onClose = null;

function ensure() {
  if (backdrop) return;
  backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.onclick = () => closeModal();
  modal = document.createElement('div');
  modal.className = 'modal';
  document.body.appendChild(backdrop);
  document.body.appendChild(modal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop && backdrop.classList.contains('show')) closeModal();
  });
}

export function closeModal() {
  if (!backdrop) return;
  backdrop.classList.remove('show');
  modal.classList.remove('show');
  document.body.classList.remove('modal-open');
  const b = backdrop;
  const m = modal;
  backdrop = null;
  modal = null;
  setTimeout(() => {
    b.remove();
    m.remove();
    if (onClose) { const fn = onClose; onClose = null; fn(); }
  }, 200);
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.body HTML
 * @param {Array<{label:string, kind?:'primary'|'ghost'|'danger', onClick?:Function, close?:boolean}>} o.actions
 * @param {Function} [o.onMount] 返回 false 可阻止关闭
 * @param {string} [o.width]
 */
export function openModal({ title, body, actions = [], onMount, width }) {
  ensure();
  modal.innerHTML = `
    <div class="modal-head">
      <div class="modal-title">${esc(title)}</div>
      <button class="modal-close" aria-label="关闭">×</button>
    </div>
    <div class="modal-body">${body}</div>
    <div class="modal-actions">
      ${actions.map((a, i) => `<button class="btn ${a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger' : 'ghost'}" data-act="${i}">${esc(a.label)}</button>`).join('')}
    </div>`;
  modal.style.maxWidth = width || '';
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = async () => {
      const a = actions[Number(b.dataset.act)];
      if (a.onClick) {
        const keep = await a.onClick();
        if (keep === false) return;
      }
      if (a.close !== false) closeModal();
    };
  });
  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    modal.classList.add('show');
    document.body.classList.add('modal-open');
    const first = modal.querySelector('input, select, textarea');
    if (first) setTimeout(() => first.focus(), 60);
  });
  if (onMount) onMount(modal);
}

/** 确认框 → Promise<boolean> */
export function confirmDialog({ title = '确认', message = '', okLabel = '确定', cancelLabel = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    openModal({
      title,
      body: `<div class="modal-text">${message}</div>`,
      actions: [
        { label: cancelLabel, kind: 'ghost', onClick: () => finish(false) },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => finish(true) },
      ],
      onMount: () => { onClose = () => finish(false); },
    });
  });
}

/** 输入框 → Promise<string|null> */
export function promptDialog({ title = '输入', label = '', value = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    openModal({
      title,
      body: `<label class="modal-field"><span>${esc(label)}</span><input class="input" id="modalInput" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`,
      actions: [
        { label: '取消', kind: 'ghost', onClick: () => finish(null) },
        {
          label: '确定', kind: 'primary', onClick: () => {
            const v = document.getElementById('modalInput')?.value?.trim() || '';
            if (!v) return false;
            finish(v);
          },
        },
      ],
      onMount: (root) => {
        onClose = () => finish(null);
        const input = root.querySelector('#modalInput');
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); root.querySelector('[data-act="1"]').click(); } };
      },
    });
  });
}
