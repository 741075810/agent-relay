// T233: the popup half of the diagnostic export. One button, one click, nothing else.
//
// What this deliberately does not do: run at load, run on a timer, send the document anywhere, or read the page. The
// export exists only as long as the operator's own clipboard or the text box below it.
(function () {
  'use strict';

  var STORAGE_KEYS = {
    lastDeliveryDiagnostic: null,
    deliveryDiagnosticHistory: [],
  };

  function el(id) { return document.getElementById(id); }

  function show(text) {
    var box = el('diagExportText');
    if (box) {
      box.value = text;
      box.hidden = false;
      try { box.select(); } catch (_err) { /* selection is a convenience, not a guarantee */ }
    }
  }

  async function exportOnce() {
    var result = el('diagExportResult');
    var button = el('diagExport');
    if (button) button.disabled = true;
    try {
      var stored = await chrome.storage.local.get(STORAGE_KEYS);
      if (typeof window.buildDiagnosticExport !== 'function') {
        if (result) result.textContent = '导出模块未加载（lib/diagnostic_export.js）';
        return;
      }
      var built = window.buildDiagnosticExport(
        stored.lastDeliveryDiagnostic, stored.deliveryDiagnosticHistory, { now: Date.now() });
      var counts = built.document.counts;
      var summary = '已生成 ' + counts.records + ' 条（丢弃 ' + counts.dropped + ' 条，' +
        built.bytes + ' 字节）：submitted ' + counts.submitted + ' / unconfirmed ' +
        counts.unconfirmed + ' / refused ' + counts.refused + ' / unknown ' + counts.unknown +
        '。页面是否被人看到：unknown（本导出不证明这一点）。';
      var copied = false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(built.text);
          copied = true;
        }
      } catch (_err) { copied = false; }
      show(built.text);
      if (result) {
        result.textContent = summary + (copied ? ' 已复制到剪贴板。' :
          ' 无法写剪贴板，请从下面文本框复制。');
      }
    } catch (err) {
      if (result) result.textContent = '导出失败：' + (err && err.message ? err.message : String(err));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function wire() {
    var button = el('diagExport');
    if (button && !button.dataset.wired) {
      button.dataset.wired = '1';
      button.addEventListener('click', exportOnce);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
})();
