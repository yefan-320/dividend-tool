/**
 * 窄屏表格布局工具：把宽数据表在手机上自动变成「一行一张卡片」。
 *
 * 做法：渲染后扫描 `table.table`，把 thead 的列名写到每个 td 的 data-label，
 * CSS 在 ≤640px 时按卡片展示（隐藏 thead、td 变 flex 行、::before 显示列名）。
 * 已有手机专用卡片实现的表格可加 class="no-stack" 跳过；转置表（首列表头是「指标」）跳过。
 * 仍横向滚动的宽表：仅当真的溢出时才加「左右滑动」提示。
 */
export function applyTableLayout(root = document) {
  const tables = root.querySelectorAll('table.table');
  for (const table of tables) {
    if (table.classList.contains('no-stack') || table.classList.contains('stack-on-mobile')) continue;
    const ths = [...table.querySelectorAll('thead tr:last-child th')];
    if (ths.length < 4) continue; // 2–3 列的窄表手机上放得下，不折腾
    const firstLabel = (ths[0]?.textContent || '').trim();
    if (firstLabel === '指标') continue; // 转置的对比表：按横向滑动处理
    let hasColspanEmpty = false;
    for (const tr of table.querySelectorAll('tbody tr')) {
      if (tr.querySelector('td[colspan]')) { hasColspanEmpty = true; break; }
    }
    if (hasColspanEmpty && table.querySelectorAll('tbody tr').length === 1) continue; // 只有空态一行
    const labels = ths.map((th) => (th.textContent || '').trim());
    table.classList.add('stack-on-mobile');
    for (const tr of table.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => {
        if (td.tagName !== 'TD') return;
        if (!td.dataset.label && labels[i]) td.dataset.label = labels[i];
      });
    }
  }
  syncScrollHints(root);
}

/** 只在表格真的超出容器时才加滑动提示（避免 346px 屏上出现「左右滑动」但其实不用滑） */
function syncScrollHints(root) {
  for (const wrap of root.querySelectorAll('.table-wrap')) {
    if (wrap.classList.contains('plan-exec-wrap')) continue; // 该表有手机专用卡片替代
    const table = wrap.querySelector('table.table');
    if (!table || wrap.querySelector('table.stack-on-mobile')) {
      wrap.classList.remove('scroll-hint');
      continue;
    }
    const overflow = wrap.scrollWidth > wrap.clientWidth + 1;
    wrap.classList.toggle('scroll-hint', overflow);
  }
}

/** 窗口尺寸变化后重新判断哪些宽表需要滑动提示 */
export function refreshTableHints() {
  syncScrollHints(document);
}
