// T044 prototype: popup. Every action below is read-only or simulated; there is
// no button that sends anything into a conversation, and none is planned until
// the read-only half is verified on a real browser by the operator.

// popup.html loads this file as a classic script (no `type="module"`), so it cannot import.
// T095B110 needs one decision shared with the tests -- how to word a refusal that may have
// landed anyway -- so lib/queue_error_view.js is loaded first as a plain script and exposes
// `describeQueueError` on the global. T063 pins the classic script; keep it that way.
//
// T095B112: the stamp is not duplicated here any more. lib/build_stamp.js is loaded before this
// file and owns the only literal, derived from a digest of the extension tree. A second copy in
// this file is how it went stale for forty changes without anyone noticing.
const BUILD_STAMP = globalThis.BUILD_STAMP || 'stamp-missing';

const els = {
  host: document.getElementById('host'),
  caps: document.getElementById('caps'),
  queue: document.getElementById('queue'),
  lastPoll: document.getElementById('lastPoll'),
  lastError: document.getElementById('lastError'),
  received: document.getElementById('received'),
  tabs: document.getElementById('tabs'),
  bindingState: document.getElementById('bindingState'),
  bindingCandidates: document.getElementById('bindingCandidates'),
  bindingHealthResult: document.getElementById('bindingHealthResult'),
  buildStamp: document.getElementById('t053BuildStamp'),
  bindingConfirmation: document.getElementById('bindingConfirmation'),
  bindingConfirmationPhrase: document.getElementById('bindingConfirmationPhrase'),
  bindingConfirmationInput: document.getElementById('bindingConfirmationInput'),
  dryRunRunId: document.getElementById('dryRunRunId'),
  dryRunResult: document.getElementById('dryRunResult'),
  dryRunHistoryInfo: document.getElementById('dryRunHistoryInfo'),
};

let pendingBindingAction = null;

function setText(el, text, cls) {
  el.textContent = text;
  el.className = cls || '';
}

function ask(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(reply || { ok: false, error: 'no reply' });
    });
  });
}

async function refresh() {
  const stored = await chrome.storage.local.get({
    cursor: 0, received: [], lastPollAt: null, lastError: null,
  });

  els.received.innerHTML = '';
  if (!stored.received.length) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = '尚无';
    els.received.appendChild(li);
  } else {
    for (const event of stored.received.slice(-8).reverse()) {
      const li = document.createElement('li');
      li.textContent = '[' + event.status + '] ' + event.message;
      li.title = 'eventId: ' + event.eventId + '\nrunId: ' + event.runId +
                 '\nreceivedAt: ' + event.receivedAt;
      els.received.appendChild(li);
    }
  }

  setText(els.lastPoll, stored.lastPollAt || '—');
  // T095B110: an error is not always "nothing happened". A committed-but-unsynced write is on
  // disk, and painting it red with no further word invites a resend of a notice the queue
  // already holds. The wording decision lives in lib/queue_error_view.js so it can be tested.
  const errorView = describeQueueError(stored);
  setText(els.lastError, errorView.text, errorView.tone);
}

document.getElementById('hello').addEventListener('click', async () => {
  const reply = await ask({ type: 'hello' });
  if (reply.ok) {
    const caps = reply.result.capabilities || {};
    setText(els.host, reply.result.host + ' ' + reply.result.hostVersion, 'ok');
    setText(els.caps, Object.keys(caps)
      .map((k) => k + '=' + caps[k]).join(' '), '');
  } else {
    setText(els.host, reply.error, 'bad');
    setText(els.caps, '—', '');
  }
});

document.getElementById('status').addEventListener('click', async () => {
  const reply = await ask({ type: 'status' });
  if (reply.ok) {
    setText(els.queue, '待取 ' + reply.result.queued + ' / 已确认 ' +
            reply.result.acked, 'ok');
  } else {
    setText(els.queue, reply.error, 'bad');
  }
});

document.getElementById('poll').addEventListener('click', async () => {
  const reply = await ask({ type: 'poll' });
  if (reply.ok) {
    setText(els.lastPoll, new Date().toLocaleTimeString() +
            '（新增 ' + reply.added + '）', 'ok');
    setText(els.lastError, '—', 'ok');
  } else {
    setText(els.lastError, reply.error, 'bad');
  }
  await refresh();
});

document.getElementById('simulate').addEventListener('click', async () => {
  const reply = await ask({ type: 'simulate', count: 1 });
  if (reply.ok) {
    setText(els.lastError, '已注入 ' + reply.result.added + ' 条模拟事件，' +
            '点“立即轮询”取回', 'ok');
  } else {
    setText(els.lastError, reply.error, 'bad');
  }
});

document.getElementById('scan').addEventListener('click', async () => {
  const reply = await ask({ type: 'tabs' });
  if (!reply.ok) {
    els.tabs.textContent = reply.error;
    return;
  }
  if (!reply.result.length) {
    els.tabs.textContent = '当前窗口没有 ChatGPT 标签页';
    return;
  }
  els.tabs.textContent = reply.result.map((tab) =>
    '#' + tab.id + (tab.active ? ' [当前]' : ' [背景]') +
    ' [' + tab.state.status + ']' + '\n' + (tab.url || 'URL 不可用') +
    (tab.state.conversationId ? '\nconversation: ' + tab.state.conversationId : '')
  ).join('\n\n');
});

const bindingMessageTypes = new Set([
  't053-binding-state', 't053-binding-scan', 't053-binding-confirm',
  't053-binding-health', 't053-binding-clear',
  // T095B76: re-inject the read-only observer into one named tab.
  't053-binding-reconnect',
]);

function bindingAsk(message) {
  if (!message || !bindingMessageTypes.has(message.type)) {
    return Promise.resolve({ ok: false, error: 'invalid_binding_request' });
  }
  return ask(message);
}

function formatBinding(binding) {
  if (!binding) return '未绑定';
  return [
    binding.invalidatedReason ? '绑定已失效: ' + binding.invalidatedReason : '已人工绑定',
    'tabId=' + binding.tabId + ' | windowId=' + binding.windowId,
    'URL: ' + binding.url,
    'conversation: ' + binding.conversationId,
    '账号身份: 未验证 | sendEligible=false',
    'boundAt: ' + new Date(binding.boundAt).toISOString(),
  ].join('\n');
}

async function refreshBindingState() {
  const reply = await bindingAsk({ type: 't053-binding-state' });
  if (!reply.ok || !reply.result.ok) {
    els.bindingState.textContent = '绑定状态不可读: ' +
      (reply.error || reply.result.status || 'unknown');
    return null;
  }
  els.bindingState.textContent = formatBinding(reply.result.binding);
  return reply.result;
}

// Says *why* each ChatGPT tab was dropped. Without this the popup could only
// report "no candidates", which cannot distinguish a stale probe from a missing
// composer from a stale extension build. Only tab identity and probe verdicts
// are shown -- never page text.
function describeRejection(item, now) {
  const age = Number.isSafeInteger(item.observedAt)
    ? ' (' + Math.max(0, Math.round((now - item.observedAt) / 1000)) + 's 前观测)'
    : '';
  return [
    'tabId=' + item.tabId + ' windowId=' + item.windowId +
      ' → ' + (item.reason || 'unknown'),
    '  probe.status=' + item.status +
      ' frozen=' + (item.frozen === null ? 'absent' : String(item.frozen)) +
      ' frozenStateKnown=' + String(item.frozenStateKnown) +
      ' source=' + item.frozenStateSource,
    '  visible=' + item.visibilityState + ' hasFocus=' + String(item.hasFocus) +
      ' active=' + String(item.active) + ' discarded=' + String(item.discarded),
    '  composer=' + String(item.composerPresent) +
      ' pageLoaded=' + String(item.pageLoaded) +
      ' documentInstance=' + (item.hasDocumentInstance ? 'yes' : 'no'),
    '  observedAt=' + (item.observedAt === null ? 'unknown' : item.observedAt) + age,
  ].join('\n');
}

function renderScanDiagnostics(container, reply, now) {
  const rejected = Array.isArray(reply.rejected) ? reply.rejected : [];
  const tabs = Array.isArray(reply.tabs) ? reply.tabs : [];
  const block = document.createElement('pre');
  if (!rejected.length && !tabs.length) {
    block.textContent = '本次扫描没有返回任何 ChatGPT 标签。' +
      '若你确定该会话开着，说明扩展的 tabs 查询没有看到它：' +
      '请确认被扫描的窗口里确实有 chatgpt.com/c/<会话ID> 页面。';
  } else if (!rejected.length) {
    block.textContent = '扫描返回 ' + tabs.length + ' 个标签，但没有记录到拒绝理由。';
  } else {
    block.textContent = '本次扫描的每个 ChatGPT 标签：\n\n' +
      rejected.map((item) => describeRejection(item, now)).join('\n\n');
  }
  container.appendChild(block);
  // T095B76: the one rejection an operator can fix from here. A reload in
  // chrome://extensions orphans the content script in an already-open page, and the
  // tab then reports `content_unavailable` -- which is not a target the binding may
  // accept, so without this the tab is unbindable until the page is refreshed. The
  // button is per tab, names the tab it will touch, and does nothing else.
  const orphaned = rejected.filter((item) => item && item.status === 'content_unavailable' &&
    Number.isSafeInteger(item.tabId));
  if (!orphaned.length) return;
  const hint = document.createElement('p');
  hint.className = 'mod-note';
  hint.textContent = '以下标签的内容脚本在扩展重载后已断开。重连只把只读探针放回去，' +
    '不改绑定、不发通知；重连成功后重新扫描即可绑定，不需要刷新页面。';
  container.appendChild(hint);
  for (const item of orphaned) {
    const row = document.createElement('div');
    const label = document.createElement('pre');
    label.textContent = 'tabId=' + item.tabId + '\n' + (item.url || 'URL 不可用');
    const button = document.createElement('button');
    button.textContent = '重连此标签页的内容脚本';
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '正在重连…';
      const reply = await bindingAsk({ type: 't053-binding-reconnect',
        tabId: item.tabId });
      const attempt = reply && reply.ok ? reply.result : null;
      if (!attempt || attempt.ok !== true) {
        button.disabled = false;
        button.textContent = '重连失败，重试';
        const why = document.createElement('pre');
        why.textContent = '重连未成功: ' +
          ((attempt && attempt.code) || (reply && reply.error) || 'unknown') +
          (attempt && attempt.error ? '\n' + attempt.error : '');
        row.appendChild(why);
        return;
      }
      button.textContent = '已重连，重新扫描…';
      // Re-scan so the newly readable tab appears as a confirmable candidate. The
      // binding still needs the typed phrase; this only re-measures.
      document.getElementById('bindingScan').click();
    });
    row.append(label, button);
    container.appendChild(row);
  }
}

function showCandidateButtons(candidates, currentBinding, diagnostics) {
  els.bindingCandidates.replaceChildren();
  if (!candidates.length) {
    els.bindingCandidates.textContent =
      '没有可绑定候选。下面列出本次扫描每个标签被筛掉的具体理由。';
    if (diagnostics) {
      renderScanDiagnostics(els.bindingCandidates, diagnostics, Date.now());
    }
    return;
  }
  for (const candidate of candidates) {
    const row = document.createElement('div');
    const description = document.createElement('pre');
    description.textContent = 'tabId=' + candidate.tabId + ' | windowId=' +
      candidate.windowId + ' | ' + candidate.visibilityState + '\n' +
      candidate.url + '\nconversation: ' + candidate.conversationId +
      '\n页面实例标记: ' + candidate.documentInstanceId;
    const button = document.createElement('button');
    button.textContent = currentBinding ? '人工确认替换此目标' : '人工绑定此目标';
    button.addEventListener('click', () => {
      const selected = 'tab=' + candidate.tabId + ' window=' + candidate.windowId +
        ' url=' + candidate.url + ' conversation=' + candidate.conversationId;
      const phrase = currentBinding
        ? 'REPLACE tab=' + currentBinding.tabId + ' window=' + currentBinding.windowId +
          ' url=' + currentBinding.url + ' conversation=' + currentBinding.conversationId +
          ' WITH ' + selected
        : 'BIND ' + selected;
      pendingBindingAction = { token: candidate.token, phrase };
      els.bindingConfirmationPhrase.textContent = phrase;
      els.bindingConfirmationInput.value = '';
      els.bindingConfirmation.hidden = false;
      els.bindingConfirmationInput.focus();
    });
    row.append(description, button);
    els.bindingCandidates.appendChild(row);
  }
  // Orphaned tabs get their reconnect control even when some other tab is bindable,
  // otherwise a second ChatGPT tab that lost its script would be invisible here for
  // exactly as long as it was inconvenient.
  const orphans = (diagnostics && Array.isArray(diagnostics.rejected)
    ? diagnostics.rejected : []).filter((item) => item &&
    item.status === 'content_unavailable');
  if (orphans.length) {
    renderScanDiagnostics(els.bindingCandidates, diagnostics, Date.now());
  }
}

document.getElementById('bindingScan').addEventListener('click', async () => {
  els.bindingCandidates.textContent = '正在对所有窗口的现有 ChatGPT 标签做只读 fresh probe…';
  const reply = await bindingAsk({ type: 't053-binding-scan' });
  if (!reply.ok) {
    els.bindingCandidates.textContent = '扫描失败: ' + reply.error;
    return;
  }
  const current = await refreshBindingState();
  showCandidateButtons(reply.result.candidates || [], current && current.binding,
    reply.result);
  els.bindingHealthResult.textContent = reply.result.error
    ? '候选扫描不可用: ' + reply.result.error
    : '扫描完成；只有明确成功、生命周期状态可知的快照可选。';
});

document.getElementById('bindingConfirm').addEventListener('click', async () => {
  if (!pendingBindingAction) return;
  const action = pendingBindingAction;
  const confirmation = els.bindingConfirmationInput.value;
  pendingBindingAction = null;
  els.bindingConfirmation.hidden = true;
  const reply = await bindingAsk({
    type: 't053-binding-confirm',
    token: action.token,
    confirmation,
  });
  els.bindingHealthResult.textContent = reply.ok && reply.result.ok
    ? JSON.stringify(reply.result, null, 2)
    : '绑定失败: ' + (reply.error || (reply.result && reply.result.status) || 'unknown');
  await refreshBindingState();
  if (reply.ok && reply.result.ok) els.bindingCandidates.replaceChildren();
});

document.getElementById('bindingCancel').addEventListener('click', () => {
  pendingBindingAction = null;
  els.bindingConfirmation.hidden = true;
  els.bindingConfirmationInput.value = '';
});

document.getElementById('bindingHealth').addEventListener('click', async () => {
  els.bindingHealthResult.textContent = '正在只检查已绑定的原始 tabId/windowId…';
  const reply = await bindingAsk({ type: 't053-binding-health' });
  if (!reply.ok) {
    els.bindingHealthResult.textContent = '健康检查失败: ' + reply.error;
    return;
  }
  const health = reply.result;
  els.bindingHealthResult.textContent = JSON.stringify({
    status: health.status,
    reason: health.reason || null,
    observedAt: health.observedAt || null,
    active: health.active,
    visibilityState: health.visibilityState,
    hasFocus: health.hasFocus,
    discarded: health.discarded,
    frozen: health.frozen,
    frozenStateKnown: health.frozenStateKnown,
    accountIdentity: health.accountIdentity,
    sendEligible: health.sendEligible,
  }, null, 2);
  await refreshBindingState();
});

document.getElementById('bindingClear').addEventListener('click', async () => {
  const state = await refreshBindingState();
  if (!state || !state.binding) return;
  const confirmation = 'UNBIND tab=' + state.binding.tabId + ' window=' +
    state.binding.windowId + ' url=' + state.binding.url +
    ' conversation=' + state.binding.conversationId;
  const approved = window.confirm('仅解除本地绑定，不影响 ChatGPT 页面。确认解除？\n' +
    'tabId=' + state.binding.tabId + ' | windowId=' + state.binding.windowId +
    '\n' + state.binding.url + '\n' + state.binding.conversationId);
  if (!approved) return;
  const reply = await bindingAsk({
    type: 't053-binding-clear',
    confirmation,
  });
  els.bindingHealthResult.textContent = reply.ok && reply.result.ok
    ? '绑定已解除。'
    : '解除绑定失败: ' + (reply.error || (reply.result && reply.result.status) || 'unknown');
  await refreshBindingState();
  if (reply.ok && reply.result.ok) els.bindingCandidates.replaceChildren();
});

document.getElementById('readonlyProbe').addEventListener('click', async () => {
  els.tabs.textContent = '只读预检中；不激活标签页，不读取消息正文…';
  const reply = await ask({ type: 'readonly-dry-run' });
  if (!reply.ok) {
    els.tabs.textContent = '预检失败: ' + reply.error;
    return;
  }
  const result = reply.result;
  if (result.error) {
    els.tabs.textContent = '预检拒绝: ' + result.error +
      (Number.isSafeInteger(result.tabCount) ? ' (' + result.tabCount + ' tabs)' : '');
    return;
  }
  const lines = [
    '手动只读快照 @ ' + new Date(result.generatedAt).toISOString(),
    '账号身份: unavailable | 发送资格: false | 发送回执: unsupported',
  ];
  if (!result.tabs.length) lines.push('当前窗口没有 ChatGPT 标签页');
  for (const tab of result.tabs) {
    const state = tab.status;
    lines.push('');
    lines.push('#' + tab.tabId + (tab.active ? ' [当前]' : ' [背景]') +
      ' [' + state + ']');
    if (tab.url) lines.push('URL: ' + tab.url);
    if (tab.conversationId) lines.push('conversation: ' + tab.conversationId);
    if (tab.observedAt) {
      lines.push('observed: ' + new Date(tab.observedAt).toISOString() +
        ' | visibility=' + tab.visibilityState + ' | focus=' + tab.hasFocus +
        ' | composer=' + tab.composerPresent + ' | loaded=' + tab.pageLoaded +
        ' | frozen=' + (tab.frozenStateKnown ? 'false' : 'unknown'));
    }
    if (tab.reason) lines.push('reason: ' + tab.reason);
    if (tab.beforeUrl) lines.push('before URL: ' + tab.beforeUrl);
    if (tab.afterUrl) lines.push('after URL: ' + tab.afterUrl);
  }
  els.tabs.textContent = lines.join('\n');
});

// -- T054 bound-target dry-run (read-only; never sends or writes a page) ----
const dryRunMessageTypes = new Set(['t054-state', 't054-dry-run']);

function dryRunAsk(message) {
  if (!message || !dryRunMessageTypes.has(message.type)) {
    return Promise.resolve({ ok: false, error: 'invalid_dry_run_request' });
  }
  return ask(message);
}

function newSimulatedRunId() {
  return crypto.randomUUID();
}

function formatDryRun(result) {
  if (!result || result.ok !== true) {
    return '判定不可用: ' + ((result && (result.status || result.error)) ||
      'unknown');
  }
  const lines = [
    result.reviewAllowed
      ? '判定: 允许人工审阅（不是发送资格）'
      : '判定: 已阻止',
    'sendEligible=' + result.sendEligible +
      ' | pageWriteEligible=' + result.pageWriteEligible +
      ' | wouldSend=' + result.wouldSend +
      ' | receipt=' + result.deliveryReceipt,
    'bindingStatus=' + result.bindingStatus,
    'accountIdentity=' + result.accountIdentity,
  ];
  if (result.target) {
    lines.push('target: tab=' + result.target.tabId +
      ' window=' + result.target.windowId + ' revision=' + result.target.revision);
    lines.push('URL: ' + result.target.url);
    lines.push('conversation: ' + result.target.conversationId);
  } else {
    lines.push('target: 无绑定');
  }
  if (result.proposal) {
    lines.push('模拟提案: ' + result.proposal.text);
    lines.push('runId=' + result.proposal.runId +
      ' | status=' + result.proposal.status +
      ' | proposalId=' + (result.proposal.proposalId || '—'));
  }
  if (result.reasons && result.reasons.length) {
    lines.push('阻止原因: ' + result.reasons.join(', '));
  }
  if (result.issues && result.issues.length) {
    lines.push('明细:');
    for (const item of result.issues) {
      lines.push('  - ' + item.code + ' :: ' + item.detail);
    }
  }
  if (result.evaluatedAt) {
    lines.push('evaluatedAt: ' + new Date(result.evaluatedAt).toISOString());
  }
  return lines.join('\n');
}

async function refreshDryRunState() {
  const reply = await dryRunAsk({ type: 't054-state' });
  if (!reply.ok || !reply.result.ok) {
    els.dryRunHistoryInfo.textContent = 'dry-run 历史不可读: ' +
      (reply.error || (reply.result && reply.result.status) || 'unknown');
    return null;
  }
  els.dryRunHistoryInfo.textContent = '已记录的模拟提案: ' +
    reply.result.history.length + ' 条（session 作用域，重启浏览器后清空）';
  return reply.result;
}

document.getElementById('dryRunGenerate').addEventListener('click', () => {
  els.dryRunRunId.value = newSimulatedRunId();
});

document.getElementById('dryRunEvaluate').addEventListener('click', async () => {
  // A blank field would only ever produce run_id_invalid. Fill a local
  // simulated UUID first so the manual step is meaningful, and keep it visible
  // for the operator to re-use or replace.
  if (!els.dryRunRunId.value.trim()) {
    els.dryRunRunId.value = newSimulatedRunId();
  }
  els.dryRunResult.textContent = '只读检查绑定与页面状态中；不发送、不写页面…';
  const reply = await dryRunAsk({
    type: 't054-dry-run',
    runId: els.dryRunRunId.value.trim(),
    status: document.getElementById('dryRunStatus').value,
  });
  if (!reply.ok) {
    els.dryRunResult.textContent = 'dry-run 调用失败: ' + reply.error;
    return;
  }
  els.dryRunResult.textContent = formatDryRun(reply.result);
  await refreshDryRunState();
});

// T055 has no startup request: listing and evaluation both require a click.
const reviewList = document.getElementById('receivedReviewList');
const reviewChoice = document.getElementById('receivedReviewChoice');
const reviewEvaluate = document.getElementById('receivedReviewEvaluate');
const reviewMetadata = document.getElementById('receivedReviewMetadata');
const reviewResult = document.getElementById('receivedReviewResult');
let receivedReviewItems = new Map();
reviewList.addEventListener('click', async () => {
  reviewList.disabled = true;
  reviewChoice.disabled = true;
  reviewEvaluate.disabled = true;
  receivedReviewItems.clear();
  reviewChoice.replaceChildren(new Option('请人工选择一条记录', ''));
  reviewMetadata.textContent = '读取本地展示记录中…';
  reviewResult.textContent = '旧选择与结果已清除；未探测页面。';
  try {
    const reply = await ask({ type: 't055-list' });
    const result = reply && reply.result;
    if (!reply?.ok || !result?.ok || !Array.isArray(result.items)) {
      reviewMetadata.textContent = '清单不可用: ' + (result?.reasons?.join(', ') || reply?.error || 'unknown');
      return;
    }
    for (const item of result.items) {
      receivedReviewItems.set(item.token, item);
      reviewChoice.add(new Option('[' + item.status + '] ' + item.runId + ' | unverified', item.token));
    }
    reviewChoice.disabled = false;
    reviewMetadata.textContent = result.items.length
      ? '请手动选择；选择有效期 60 秒，切换标签/窗口后需重新读取。'
      : '本地没有已接收记录；不会自动轮询 Host。';
  } finally { reviewList.disabled = false; }
});
reviewChoice.addEventListener('change', () => {
  const item = receivedReviewItems.get(reviewChoice.value);
  reviewEvaluate.disabled = !item;
  reviewResult.textContent = '未评估当前选择。';
  reviewMetadata.textContent = item ? [
    '来源: extension_local_received | provenance=unverified',
    '类型: 已接收展示记录（真实性未知；不是 T054 本地模拟输入）',
    'eventId=' + item.eventId, 'runId=' + item.runId, 'status=' + item.status,
    'createdAt（源创建/启动时间；非结束）=' + item.createdAt,
    'receivedAt（本地接收时间）=' + item.receivedAt,
    '预先阻止原因: ' + item.reasons.join(', '),
  ].join('\n') : '尚未选择。';
});
reviewEvaluate.addEventListener('click', async () => {
  const token = reviewChoice.value;
  if (!receivedReviewItems.has(token)) return;
  reviewEvaluate.disabled = true;
  reviewList.disabled = true;
  reviewChoice.disabled = true;
  receivedReviewItems.delete(token);
  reviewResult.textContent = '只读复核中；不改变绑定或模拟历史…';
  try {
    const reply = await ask({ type: 't055-review', token });
    const r = reply?.result;
    if (!reply?.ok || !r) {
      reviewResult.textContent = '调用失败: ' + (reply?.error || 'no_reply');
      return;
    }
    reviewResult.textContent = [
      '可信真实提案: 已阻止 | provenance=' + r.provenance,
      'sendEligible=' + r.sendEligible + ' | wouldSend=' + r.wouldSend +
        ' | pageWriteEligible=' + r.pageWriteEligible,
      'accountIdentity=' + r.accountIdentity + ' | receipt=' + r.deliveryReceipt,
      '目标一致性=' + (r.targetConsistent ?? '未检查') + ' | bindingStatus=' + (r.bindingStatus || '不可用'),
      'target=' + JSON.stringify(r.target || null),
      '重复事件=' + (r.duplicate ?? '未检查') + ' | 去重=' + (r.deduplication || '未检查'),
      'historyRecorded=' + r.historyRecorded,
      '阻止原因: ' + (r.reasons || []).join(', '),
      'observedAt=' + (r.observedAt || '无') + ' | evaluatedAt=' + (r.evaluatedAt || '无'),
      '本次选择令牌已消费；再次检查请重新读取并人工选择。',
    ].join('\n');
  } finally {
    reviewList.disabled = false;
    // Keep the consumed selection disabled until the operator reloads the list.
  }
});

// -- T058/T059: one-time authorization ---------------------------------------
//
// Two independent switches, both default off, both armed by typing a phrase that
// is derived from the *current* binding rather than remembered. The phrase is
// shown, never pre-filled: copying it is the gesture that proves a human read
// which conversation this is about.
const asEls = {
  state: document.getElementById('notifyAuthState'),
  phrase: document.getElementById('notifyAuthPhrase'),
  input: document.getElementById('notifyAuthConfirmation'),
  mode: document.getElementById('notifyAuthMode'),
  refresh: document.getElementById('notifyAuthRefresh'),
  arm: document.getElementById('notifyAuthArm'),
  disarm: document.getElementById('notifyAuthDisarm'),
  // T122: the restricted ("one message, 15 minutes") controls. Separate elements, separate
  // phrase, separate message -- the standing grant is neither reused nor narrowed.
  onceState: document.getElementById('notifyAuthOnceState'),
  oncePhrase: document.getElementById('notifyAuthOncePhrase'),
  onceInput: document.getElementById('notifyAuthOnceConfirmation'),
  onceArm: document.getElementById('notifyAuthOnceArm'),
  onceResult: document.getElementById('notifyAuthOnceResult'),
  result: document.getElementById('notifyAuthResult'),
  triggerState: document.getElementById('terminalTriggerState'),
  triggerPhrase: document.getElementById('terminalTriggerPhrase'),
  // T123: the restricted trigger's own controls. Separate elements on purpose: the standing
  // arm must stay reachable, and neither may be mistaken for the other.
  triggerOncePhrase: document.getElementById('terminalTriggerOncePhrase'),
  triggerOnceInput: document.getElementById('terminalTriggerOnceConfirmation'),
  triggerOnceArm: document.getElementById('terminalTriggerOnceArm'),
  triggerOnceResult: document.getElementById('terminalTriggerOnceResult'),
  triggerInput: document.getElementById('terminalTriggerConfirmation'),
  triggerArm: document.getElementById('terminalTriggerArm'),
  triggerDisarm: document.getElementById('terminalTriggerDisarm'),
  triggerResult: document.getElementById('terminalTriggerResult'),
  // T067: the per-task opt-in surface for runs started inside DSH Desktop.
  directState: document.getElementById('directOptInState'),
  directChoice: document.getElementById('directOptInChoice'),
  directRefresh: document.getElementById('directOptInRefresh'),
  directArm: document.getElementById('directOptInArm'),
  directResult: document.getElementById('directOptInResult'),
  // T068: decisions taken while the task is still running.
  runningState: document.getElementById('runningState'),
  runningChoice: document.getElementById('runningChoice'),
  runningRefresh: document.getElementById('runningRefresh'),
  runningArm: document.getElementById('runningArm'),
  runningRevoke: document.getElementById('runningRevoke'),
  runningResult: document.getElementById('runningResult'),
};

function formatAutoSend(state, candidates, defaults) {
  if (!state) return '尚未授权';
  const journal = Object.values(state.journal || {});
  const sent = journal.filter((item) => item.state === 'sent').length;
  const ambiguous = journal.filter((item) => item.state === 'ambiguous').length;
  const remaining = state.enabled && typeof state.maxSends === 'number'
    ? Math.max(0, state.maxSends - (state.sentCount || 0)) : 0;
  const mode = state.deliveryMode === 'background' ? 'background' : 'foreground';
  const lines = [
    '授权：' + (state.enabled ? '已启用' : '未启用'),
    // T048: the mode is stated before the counters, because it decides what the
    // counters mean. A grant that only works while you watch is a different
    // permission from one that works while you are elsewhere.
    '投递模式：' + (mode === 'background'
      ? '后台（标签不在前台也投递，绝不切换窗口）'
      : '前台（仅当该标签可见且有焦点）'),
    '已发送：' + state.sentCount + ' / ' + state.maxSends +
      (state.enabled ? '（剩余 ' + remaining + ' 条）' : ''),
    '到期：' + (state.expiresAt ? new Date(state.expiresAt).toLocaleString() : '—'),
    '绑定版本：' + (state.bindingRevision === null ? '—' : state.bindingRevision),
    '日志：已发送 ' + sent + ' 条，结果不确定 ' + ambiguous + ' 条',
    '最后错误：' + (state.lastError || '无'),
  ];
  if (typeof candidates === 'number') lines.push('待处理候选：' + candidates);
  // What the numbers above are, versus what a *new* manual arm would grant. The
  // gap is the point: changing the default never widens a live grant.
  if (defaults && defaults.maxSends) {
    lines.push('本次授权上限：' + state.maxSends + ' 条 / 到期 ' +
      (state.expiresAt ? new Date(state.expiresAt).toLocaleString() : '—'));
    lines.push('下次人工授权默认：最多 ' + defaults.maxSends + ' 条，有效期 ' +
      defaults.ttlDays + ' 天（上限 ' + defaults.maxSendsCeiling + ' 条 / ' +
      Math.round(defaults.maxTtlMs / 86400000) + ' 天）');
    if (defaults.backgroundConfirmationPrefix) {
      lines.push('前台短语：' + defaults.confirmationPrefix + '<会话 ID>');
      lines.push('后台短语：' + defaults.backgroundConfirmationPrefix + '<会话 ID>'
        + '（两句不通用，前台授权不会自动变成后台）');
    }
  }
  return lines.join('\n');
}

// How many notices the 30s pacing alone allows inside one hour. The fixed window
// and this bound are independent, so the reachable maximum is the smaller of the
// two: the window permits 2x across a boundary, but pacing is what actually holds
// throughput down. Quoting only 2x in the popup would overstate the real cap.
function pacingCap(state) {
  const interval = Number.isFinite(state.minIntervalMs) && state.minIntervalMs > 0
    ? state.minIntervalMs : 30000;
  return Math.floor(3600000 / interval) + 1;
}

function formatTrigger(state, preArm, extras) {
  if (!state) return '尚未启用';
  const seen = Object.values(state.seen || {});
  const lines = [
    '终态触发：' + (state.enabled ? '已启用' : '未启用'),
    '最小间隔：' + Math.round(state.minIntervalMs / 1000) + ' 秒',
    '每小时上限：' + state.maxPerHour + ' 条（独立限流）',
    '本窗口已发：' + state.windowCount + ' / ' + state.maxPerHour,
    '已处理任务：' + seen.length + ' 条',
    '最后错误：' + (state.lastError || '无'),
  ];
  // Say what the counter really is. It is a fixed 60-minute block anchored at the
  // last reset, not a rolling rate: right after a rollover the previous block's
  // 100 and the new block's 100 can both land inside one clock hour, so a burst of
  // up to 2x is possible across the boundary. The popup says this out loud --
  // calling it "100 per rolling hour" would be a false guarantee.
  const windowMs = extras && extras.defaults && extras.defaults.windowMs;
  if (state.enabled && typeof windowMs === 'number' && windowMs > 0) {
    const anchor = Number.isFinite(state.windowStartedAt) ? state.windowStartedAt : null;
    const resetAt = anchor === null ? null : anchor + windowMs;
    lines.push('计数窗口：固定 ' + Math.round(windowMs / 60000) + ' 分钟（非滑动）' +
      (resetAt === null ? '' : '，' + new Date(resetAt).toLocaleTimeString() + ' 重置'));
    lines.push('注意：固定窗口不是滚动限流。跨窗口边界时窗口会再放行一批，'
      + '理论上限 2×' + state.maxPerHour + ' 条；但 ' +
      Math.round(state.minIntervalMs / 1000) + ' 秒最小间隔使任一 60 分钟内的'
      + '实际上限约为 ' + pacingCap(state) + ' 条');
  }
  // T095B75: the scheduled period is an *observation*, not a restatement of the
  // configured interval. When the alarm table is empty but the trigger is enabled --
  // which is what a reload used to leave behind -- saying "每 0.5 分钟检查一次" was a
  // false statement about a timer that did not exist. Name the two states apart.
  const alarm = extras && extras.alarm;
  const alarmError = extras && extras.alarmError;
  const alarmExpected = extras && extras.alarmExpected;
  if (state.enabled && typeof alarm === 'number') {
    lines.push('调度周期：每 ' + alarm + ' 分钟检查一次' +
      '（Chrome 只保证不早于该周期，实际可能延后）');
  } else if (state.enabled && alarmError) {
    lines.push('定时器状态：无法读取（' + alarmError + '）'
      + '——不能据此判断是否会检查');
  } else if (state.enabled) {
    lines.push('定时器状态：未调度（已授权，但 Chrome 里没有这个定时器）'
      + (typeof alarmExpected === 'number'
        ? '；理论周期每 ' + alarmExpected + ' 分钟' : '')
      + '——重启浏览器或重新授权后恢复');
  }
  // T076: a pre-write refusal (blurred tab, a draft in the composer) is a wait,
  // not a failure. Saying so keeps it distinct from the "last error" line, which
  // stays reserved for stops that need a human.
  const pending = Object.values(state.deferred || {});
  if (pending.length > 0) {
    const soonest = pending.sort((a, b) => (a.retryAt || 0) - (b.retryAt || 0))[0];
    lines.push('等待重检：' + pending.length + ' 条（上次原因：'
      + (soonest.reason || 'unknown')
      // T048: the code alone does not tell you what to do. `target_background_unobservable`
      // with `discarded` means Chrome recycled the tab; with `frozen` it means the tab is
      // suspended. Same code, different fix -- so the cause is printed when one was recorded.
      + (soonest.detail ? ' / ' + soonest.detail : '')
      + '，下次 '
      + (Number.isFinite(soonest.retryAt)
        ? new Date(soonest.retryAt).toLocaleTimeString() : 'unknown') + '）');
    lines.push('说明：写前被拒绝未触碰页面，不消耗额度、不会停用；'
      + '满足全部发送门禁后只会尝试一次。');
  }
  // T078: say what a schema repair did, and never let a quarantine look healthy.
  // `schemaFilled` is history (a field had to be added); `schemaSuspect` is a live
  // refusal, because a field we cannot trust might be hiding a sent run.
  const suspectFields = Array.isArray(state.schemaSuspect) ? state.schemaSuspect : [];
  const filledFields = Array.isArray(state.schemaFilled) ? state.schemaFilled : [];
  if (suspectFields.length > 0) {
    lines.push('状态字段异常：' + suspectFields.join(', ')
      + '（该记录已停发，需人工重新启用；历史记录不会被重发）');
  } else if (filledFields.length > 0) {
    lines.push('兼容补全：' + filledFields.join(', ') + '（仅补字段，历史记录未改动）');
  }
  const defaults = extras && extras.defaults;
  if (defaults && defaults.maxPerHour) {
    lines.push('下次启用默认：间隔 ' + Math.round(defaults.minIntervalMs / 1000) +
      ' 秒 / 每小时 ' + defaults.maxPerHour + ' 条（可设范围 ' +
      Math.round(defaults.minIntervalFloorMs / 1000) + '–' +
      Math.round(defaults.maxIntervalCeilingMs / 60000) + ' 分钟内，上限 ' +
      defaults.maxPerHourCeiling + ' 条/小时）');
  }
  if (typeof preArm === 'number' && preArm > 0) {
    lines.push('启用前遗留候选：' + preArm + ' 条（已保留，不会自动发送）');
  }
    // T142: an arm that consumed nothing and sent nothing used to look exactly like a broken
  // one. Say what the last tick decided, how much of the one-shot budget is left, and whether
  // a write is in flight. Read-only: this renders state, it never changes it.
  if (state.singleShotTrigger === true) {
    const max = Number.isSafeInteger(state.maxTriggers) ? state.maxTriggers : null;
    const used = Number.isSafeInteger(state.triggers) ? state.triggers : 0;
    lines.push('单次额度：' + (max === null ? '—'
      : '剩余 ' + Math.max(0, max - used) + ' / ' + max));
  }
  if (state.pendingAttempt) {
    lines.push('写入进行中：' + (state.pendingAttempt.runId || '—'));
  }
  if (state.lastTick && state.lastTick.guard) {
    const verdict = state.lastTick.guard;
    const when = state.lastTick.at ? new Date(state.lastTick.at).toLocaleString() : '—';
    const what = verdict.ok === false
      ? '否决 ' + (verdict.code || '—') + ' ×' + verdict.count + '（一个都不会发）'
      : '候选 ' + verdict.count + '，放行 ' + (verdict.chosen ? 1 : 0)
        + (verdict.count > 1 && verdict.chosen ? '（其余 ' + (verdict.count - 1) + ' 排队）' : '');
    lines.push('上次 tick：' + when + '；' + what + '；已发 ' + (state.lastTick.sent || 0));
  }
return lines.join('\n');
}

// T067: what the popup shows about the A/B split, and the one action it offers.
//
// The list is the *whole* point of channel B being default-off: a task started in
// DSH Desktop is stored and shown, and it goes nowhere until a person clicks one
// specific row. So the panel has to be honest about three different populations --
// waiting for a click, already armed (with the window it has left), and not
// eligible at all -- instead of collapsing them into "pending".
function directLabel(item) {
  const when = Number.isFinite(item.startedAt)
    ? new Date(item.startedAt * 1000).toLocaleString()
    : '时间未知';
  const origin = item.origin === 'direct' ? '直发'
    : (item.origin === 'unknown' ? '来源未知' : String(item.origin || '未记录'));
  // T067R: a直发 candidate's id is derived from its turn, so the id is meaningless
  // to a person. Show the turn instead -- that is what the operator recognises from
  // the DSH window, and it is the only way to know which task the click covers.
  if (Number.isInteger(item.nativeTurn)) {
    const session = typeof item.nativeSession === 'string'
      ? item.nativeSession.replace(/^session-/, '').slice(0, 8) : '?';
    return '会话 ' + session + ' · 第 ' + item.nativeTurn + ' 轮 · '
      + item.status + ' · ' + origin + ' · ' + when;
  }
  return (item.runId || '').slice(0, 8) + ' · ' + item.status + ' · '
    + origin + ' · ' + when;
}

function renderDirectOptIn(reply) {
  if (!reply || !reply.ok || !reply.result) {
    setText(asEls.directState, '读取失败：' + ((reply && reply.error) || '未知'),
      'bad');
    asEls.directChoice.disabled = true;
    asEls.directArm.disabled = true;
    return;
  }
  const r = reply.result;
  const counts = r.counts || {};
  const minutes = Math.round((r.ttlMs || 0) / 60000);
  const source = r.originSource === 'bridge-sqlite' ? '实时（bridge 派发绑定）'
    : (r.originSource === 'bridge-cache'
      ? '缓存（' + (r.originStale ? '已过期' : '可用') + '）'
      : '不可用 → 全部按直发处理');
  const lines = [
    '来源判定：' + source,
    '经 Bridge（默认通知）：' + (counts.bridge || 0) + ' 条',
    '待选择（默认不通知）：' + (counts.waiting || 0) + ' 条',
    '已选择待发送：' + (counts.armed || 0) + ' 条（' + minutes + ' 分钟内有效）',
  ];
  if (counts.expired) lines.push('选择已过期，需重新点：' + counts.expired + ' 条');
  if (counts.missingOrigin) {
    lines.push('未记录来源（旧候选，需人工选择）：' + counts.missingOrigin + ' 条');
  }
  if (!counts.waiting) {
    lines.push('', '当前没有需要你选择的直发任务。');
  }
  setText(asEls.directState, lines.join('\n'),
    counts.waiting ? 'ok' : 'ok');

  const waiting = (r.direct || []).filter((item) => item.armedAt === null)
    .concat((r.direct || []).filter((item) => item.armedExpired === true));
  const previous = asEls.directChoice.value;
  asEls.directChoice.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = waiting.length
    ? '请选择一条直发任务（共 ' + waiting.length + ' 条）'
    : '没有可选的直发任务';
  asEls.directChoice.appendChild(placeholder);
  for (const item of waiting) {
    const option = document.createElement('option');
    option.value = item.runId + '|' + item.status;
    option.textContent = directLabel(item)
      + (item.armedExpired ? '（选择已过期）' : '');
    asEls.directChoice.appendChild(option);
  }
  if (previous && waiting.some((item) => item.runId + '|' + item.status === previous)) {
    asEls.directChoice.value = previous;
  }
  asEls.directChoice.disabled = waiting.length === 0;
  asEls.directArm.disabled = true;      // requires an explicit selection
}

async function refreshDirectOptIn() {
  renderDirectOptIn(await ask({ type: 't067-direct-state' }));
}

asEls.directRefresh.addEventListener('click', async () => {
  await refreshDirectOptIn();
  setText(asEls.directResult, '已刷新直发任务列表', 'ok');
});

asEls.directChoice.addEventListener('change', () => {
  asEls.directArm.disabled = !asEls.directChoice.value;
});

asEls.directArm.addEventListener('click', async () => {
  const chosen = asEls.directChoice.value || '';
  const cut = chosen.lastIndexOf('|');
  if (cut <= 0) {
    setText(asEls.directResult, '请先在上面的下拉框里选中一条。', 'bad');
    return;
  }
  const runId = chosen.slice(0, cut);
  const status = chosen.slice(cut + 1);
  asEls.directArm.disabled = true;
  try {
    const reply = await ask({
      type: 't067-direct-optin', runId, status, userGesture: true,
    });
    const result = reply.ok ? reply.result : { ok: false, code: reply.error };
    setText(asEls.directResult, result.ok
      ? '已选择通知 ' + runId.slice(0, 8) + '（' + status + '）。'
        + '不会立刻发送：下一轮检查时才会尝试，间隔/上限/页面检查/授权照旧生效。'
      : '未选择：' + result.code, result.ok ? 'ok' : 'bad');
  } finally {
    await refreshDirectOptIn();
  }
});

// ---------------------------------------------------------------- T068 running panel
//
// The T067 panel above can only list tasks that have already ended, because that is
// all the host's candidate list contains. For a task that runs for an hour that is
// useless: the operator wants to decide in the first minute. This panel lists what
// DSH itself reports as still running, and lets the decision be taken there.

function runningLabel(item) {
  const session = typeof item.sessionId === 'string'
    ? item.sessionId.replace(/^session-/, '').slice(0, 8) : '?';
  const parts = ['会话 ' + session + ' · 第 ' + item.turn + ' 轮'];
  // Prefer the proven start; fall back to when the log first showed this turn, and
  // say which one it is. A task whose `turn/start` scrolled out of the read window
  // has no provable start, and pretending otherwise is the guess this design refuses.
  if (Number.isFinite(item.startedAt)) {
    parts.push('开始 ' + new Date(item.startedAt * 1000).toLocaleTimeString());
  } else if (Number.isFinite(item.observedSince)) {
    parts.push('至少自 ' + new Date(item.observedSince * 1000).toLocaleTimeString()
      + ' 起在跑');
  }
  if (Number.isFinite(item.lastActivityAt)) {
    parts.push('最近活动 ' + new Date(item.lastActivityAt * 1000).toLocaleTimeString());
  }
  parts.push(item.optedIn ? '已选择通知' : '未选择');
  return parts.join(' · ');
}

function renderRunning(reply) {
  if (!reply || !reply.ok || !reply.result) {
    setText(asEls.runningState, '读取失败：' + ((reply && reply.error) || '未知'),
      'bad');
    asEls.runningChoice.disabled = true;
    asEls.runningArm.disabled = true;
    asEls.runningRevoke.disabled = true;
    return;
  }
  const r = reply.result;
  if (r.ok !== true) {
    // "could not be read" and "nothing is running" are different facts. Saying
    // "nothing running" here would tell the operator their task had vanished when in
    // fact nothing was looked at.
    const why = r.code === 'ledger_unavailable'
      ? 'Bridge 台账不可读，无法排除经 Bridge 派发的任务 → 不列出任何任务'
      : 'DSH 会话日志不可读（' + (r.code || '未知') + '）';
    setText(asEls.runningState, why + (r.error ? '\n' + r.error : ''), 'bad');
    asEls.runningChoice.disabled = true;
    asEls.runningArm.disabled = true;
    asEls.runningRevoke.disabled = true;
    return;
  }
  const counts = r.counts || {};
  const lines = [
    '正在运行（非 Bridge）：' + (counts.running || 0) + ' 条',
    '其中已选择通知：' + (counts.optedIn || 0) + ' 条',
    '经 Bridge 派发、正在运行（自动通知，不在此列）：'
      + (r.bridgeRunning === null ? '未知' : r.bridgeRunning) + ' 条',
    'DSH 日志：' + (r.nativeOk ? '可读' : '不可读')
      + ' · Bridge 台账：' + (r.ledgerOk ? '可读' : '不可读'),
  ];
  if (r.stale) {
    lines.push('日志里停在中途、已超时的记录：' + r.stale + ' 条（已忽略）');
  }
  if (r.triggerEnabled !== true) {
    lines.push('', '注意：终态触发当前未启用。选择会记下来，但不会发送。');
  }
  if (!counts.running) {
    lines.push('', '当前没有正在运行的直发任务。');
  }
  setText(asEls.runningState, lines.join('\n'), 'ok');

  const rows = Array.isArray(r.rows) ? r.rows : [];
  const previous = asEls.runningChoice.value;
  asEls.runningChoice.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = rows.length
    ? '请选择一条正在运行的任务（共 ' + rows.length + ' 条）'
    : '没有正在运行的直发任务';
  asEls.runningChoice.appendChild(placeholder);
  for (const item of rows) {
    const option = document.createElement('option');
    option.value = item.sessionId + '|' + item.turn;
    option.textContent = runningLabel(item);
    asEls.runningChoice.appendChild(option);
  }
  if (previous && rows.some((item) => item.sessionId + '|' + item.turn === previous)) {
    asEls.runningChoice.value = previous;
  }
  asEls.runningChoice.disabled = rows.length === 0;
  // Both buttons stay disabled until a row is picked: the selection *is* the target,
  // and a default target is how the wrong task gets notified.
  asEls.runningArm.disabled = true;
  asEls.runningRevoke.disabled = true;
}

function selectedRunning() {
  const chosen = asEls.runningChoice.value || '';
  const cut = chosen.lastIndexOf('|');
  if (cut <= 0) return null;
  const turn = Number.parseInt(chosen.slice(cut + 1), 10);
  if (!Number.isInteger(turn) || turn < 0) return null;
  return { sessionId: chosen.slice(0, cut), turn };
}

async function refreshRunning() {
  renderRunning(await ask({ type: 't068-running-state' }));
}

asEls.runningRefresh.addEventListener('click', async () => {
  await refreshRunning();
  setText(asEls.runningResult, '已刷新正在运行的任务', 'ok');
});

asEls.runningChoice.addEventListener('change', () => {
  const picked = Boolean(asEls.runningChoice.value);
  asEls.runningArm.disabled = !picked;
  asEls.runningRevoke.disabled = !picked;
});

asEls.runningArm.addEventListener('click', async () => {
  const target = selectedRunning();
  if (!target) {
    setText(asEls.runningResult, '请先在上面的下拉框里选中一条。', 'bad');
    return;
  }
  asEls.runningArm.disabled = true;
  try {
    const reply = await ask({
      type: 't068-running-optin', sessionId: target.sessionId,
      turn: target.turn, userGesture: true,
    });
    const result = reply.ok ? reply.result : { ok: false, code: reply.error };
    if (result.ok) {
      setText(asEls.runningResult,
        '已记下：会话 ' + target.sessionId.replace(/^session-/, '').slice(0, 8)
        + ' 第 ' + target.turn + ' 轮，结束时通知。'
        + (result.triggerEnabled === false
          ? '\n注意：终态触发未启用，现在不会发送。' : '')
        + '\n不会立刻发送：任务真正结束后，间隔/上限/页面检查/授权照旧全部生效。',
        'ok');
    } else {
      setText(asEls.runningResult, '未记下：' + result.code, 'bad');
    }
  } finally {
    await refreshRunning();
  }
});

asEls.runningRevoke.addEventListener('click', async () => {
  const target = selectedRunning();
  if (!target) {
    setText(asEls.runningResult, '请先在上面的下拉框里选中一条。', 'bad');
    return;
  }
  asEls.runningRevoke.disabled = true;
  try {
    const reply = await ask({
      type: 't068-running-optout', sessionId: target.sessionId,
      turn: target.turn, userGesture: true,
    });
    const result = reply.ok ? reply.result : { ok: false, code: reply.error };
    setText(asEls.runningResult, result.ok
      ? '已撤销：第 ' + target.turn + ' 轮不会再通知。'
      : '未撤销：' + result.code, result.ok ? 'ok' : 'bad');
  } finally {
    await refreshRunning();
  }
});

async function refreshAutoSend() {  const stateReply = await ask({ type: 't058-state' });
  const bindingReply = await bindingAsk({ type: 't053-binding-state' });
  const triggerReply = await ask({ type: 't059-trigger-state' });
  const directReply = await ask({ type: 't067-direct-state' });

  const binding = bindingReply.ok && bindingReply.result && bindingReply.result.binding
    ? bindingReply.result.binding : null;
  const conversationId = binding ? binding.conversationId : null;

  setText(asEls.state, stateReply.ok ? formatAutoSend(stateReply.result,
    undefined, stateReply.defaults)
    : '读取失败：' + (stateReply.error || '未知'), stateReply.ok ? 'ok' : 'bad');
  setText(asEls.triggerState,
    triggerReply.ok ? formatTrigger(triggerReply.result, triggerReply.preArm,
      { alarm: triggerReply.alarm, alarmError: triggerReply.alarmError,
        alarmExpected: triggerReply.alarmExpected,
        defaults: triggerReply.defaults })
      : '读取失败：' + (triggerReply.error || '未知'),
    triggerReply.ok ? 'ok' : 'bad');
  renderDirectOptIn(directReply);
  // T122: what the restricted grant currently is, in one line. A standing grant leaves this
  // saying "none", because the two are different permissions and must not look alike.
  const autoState = stateReply.ok ? stateReply.result : null;
  if (autoState && autoState.singleShot === true) {
    setText(asEls.onceState, '一次性授权：最多 ' + autoState.maxSends + ' 条，已发 ' +
      autoState.sentCount + '，' + (autoState.expiresAt
        ? new Date(autoState.expiresAt).toLocaleString() + ' 到期' : '无到期时间') +
      (autoState.enabled === true ? '' : '（已停用：' + (autoState.lastError || '—') + '）'),
    autoState.enabled === true ? 'ok' : 'warn');
  } else {
    setText(asEls.onceState, '当前没有一次性授权（长期授权不影响这一组，反之亦然）。');
  }

  if (!conversationId) {
    setText(asEls.phrase, '尚未绑定会话，请先在上一节完成绑定。', 'bad');
    setText(asEls.triggerPhrase, '尚未绑定会话，请先在上一节完成绑定。', 'bad');
    asEls.arm.disabled = true;
    asEls.onceArm.disabled = true;
    setText(asEls.oncePhrase, '尚未绑定会话，请先在上一节完成绑定。', 'bad');
    asEls.triggerArm.disabled = true;
    asEls.triggerOnceArm.disabled = true;
    setText(asEls.triggerOncePhrase, '尚未绑定会话，请先在上一节完成绑定。', 'bad');
    asEls.disarm.disabled = true;
    asEls.triggerDisarm.disabled = true;
    return;
  }
  // T048: both phrases are shown, labelled. The mode selector decides which one the
  // worker will accept, so the popup cannot accidentally suggest that one phrase
  // covers both permissions.
  setText(asEls.phrase, '前台照抄：AUTOSEND ' + conversationId
    + '\n后台照抄：AUTOSEND-BACKGROUND ' + conversationId
    + '\n（两句不通用；选哪种模式就抄哪一句）');
  setText(asEls.triggerPhrase, '请照抄：AUTOTRIGGER ' + conversationId);
  // T123: the restricted phrase. Same rule as T122's: shown, never pre-filled.
  const triggerOnce = (typeof window !== 'undefined' && window.onceTriggerPhrase)
    ? window.onceTriggerPhrase(conversationId)
    : 'AUTOTRIGGER-ONCE ' + conversationId;
  setText(asEls.triggerOncePhrase, '仅一次照抄：' + triggerOnce
    + '\n（只放行 1 条 · 15 分钟内有效 · 只认这条 arm 之后结束的任务；发出即停用）');
  // T122: the restricted phrase, shown next to the standing one and typed into its own
  // box. Copying it is the gesture; nothing here pre-fills either field. The prefix comes
  // from lib/single_shot_view.js, which a test pins against the worker's own constant.
  const oncePhrase = (typeof window !== 'undefined' && window.singleShotPhrase)
    ? window.singleShotPhrase(conversationId)
    : 'AUTOSEND-ONCE ' + conversationId;
  setText(asEls.oncePhrase, '仅一次照抄：' + oncePhrase
    + '\n（最多 1 条 · 15 分钟内有效 · 只对当前绑定会话；发出一条或结果不确定就自行停用）');
  asEls.arm.disabled = false;
  asEls.onceArm.disabled = false;
  asEls.triggerArm.disabled = false;
  asEls.triggerOnceArm.disabled = false;
  asEls.disarm.disabled = false;
  asEls.triggerDisarm.disabled = false;
}

asEls.refresh.addEventListener('click', async () => {
  await refreshAutoSend();
  setText(asEls.result, '已刷新状态', 'ok');
});

asEls.arm.addEventListener('click', async () => {
  asEls.arm.disabled = true;
  try {
    // T048: the mode is chosen before the phrase is typed, and it changes which
    // phrase is accepted. Sending both to the worker lets `arm` reject a mismatch
    // instead of the popup deciding on its own which grant was meant.
    const deliveryMode = asEls.mode && asEls.mode.value === 'background'
      ? 'background' : 'foreground';
    const reply = await ask({
      type: 't058-arm',
      confirmation: asEls.input.value,
      deliveryMode,
      userGesture: true,
    });
    const result = reply.ok ? reply.result : { ok: false, code: reply.error };
    setText(asEls.result, result.ok
      ? '已授权（' + (result.deliveryMode === 'background' ? '后台' : '前台') +
        '），到期 ' + new Date(result.expiresAt).toLocaleString() +
        '，最多 ' + result.maxSends + ' 条。'
      : '未授权：' + result.code, result.ok ? 'ok' : 'bad');
    asEls.input.value = '';
  } finally {
    await refreshAutoSend();
  }
});

asEls.disarm.addEventListener('click', async () => {
  const reply = await ask({ type: 't058-disarm' });
  setText(asEls.result, reply.ok ? '已停用自动发送。' : '停用失败：' + reply.error,
    reply.ok ? 'ok' : 'bad');
  await refreshAutoSend();
});

// T122: arm exactly one message, for fifteen minutes, on this binding only. The typed phrase
// is the gesture; the bounds are applied by the worker, so a modified popup cannot ask for
// more than one.
asEls.onceArm.addEventListener('click', async () => {
  asEls.onceArm.disabled = true;
  try {
    const reply = await ask({
      type: 't058-arm-once',
      confirmation: asEls.onceInput.value,
      userGesture: true,
    });
    const result = reply.ok ? reply.result : { ok: false, code: reply.error };
    setText(asEls.onceResult, result.ok
      ? '已授权下一条：最多 ' + result.maxSends + ' 条，' +
        new Date(result.expiresAt).toLocaleString() + ' 到期；发出一条或结果不确定即自动停用。'
      : '未授权：' + result.code, result.ok ? 'ok' : 'bad');
    asEls.onceInput.value = '';
  } finally {
    await refreshAutoSend();
  }
});

asEls.triggerArm.addEventListener('click', async () => {
  asEls.triggerArm.disabled = true;
  try {
    const reply = await ask({
      type: 't059-trigger-arm',
      confirmation: asEls.triggerInput.value,
      userGesture: true,
    });
    const result = reply.ok ? reply.result : { ok: false, code: reply.error };
    setText(asEls.triggerResult, result.ok
      ? '终态触发已启用：最小间隔 ' + Math.round(result.minIntervalMs / 1000) +
        ' 秒，每小时最多 ' + result.maxPerHour + ' 条。'
      : '未启用：' + result.code, result.ok ? 'ok' : 'bad');
    asEls.triggerInput.value = '';
  } finally {
    await refreshAutoSend();
  }
});

asEls.triggerDisarm.addEventListener('click', async () => {
  const reply = await ask({ type: 't059-trigger-disable' });
  setText(asEls.triggerResult,
    reply.ok ? '终态触发已停用。' : '停用失败：' + reply.error,
    reply.ok ? 'ok' : 'bad');
  await refreshAutoSend();
});

// T123: arm the trigger for exactly one terminal message. No limits travel with the message --
// the cap and the window are the worker's decision, so a modified popup cannot widen them.
asEls.triggerOnceArm.addEventListener('click', async () => {
  asEls.triggerOnceArm.disabled = true;
  try {
    const reply = await ask({
      type: 't059-trigger-arm-once',
      confirmation: asEls.triggerOnceInput.value,
      userGesture: true,
    });
    const result = reply.ok ? reply.result : { ok: false, code: reply.error };
    setText(asEls.triggerOnceResult, result.ok
      ? '已启用一次性终态触发：只放行 1 条，' +
        new Date(result.expiresAt).toLocaleString() + ' 到期；发出第一条后自动停用。'
      : '未启用：' + result.code, result.ok ? 'ok' : 'bad');
    asEls.triggerOnceInput.value = '';
  } finally {
    await refreshAutoSend();
  }
});

// T065: chain self-check rendering.
//
// The four layers are printed separately and never collapsed into one word,
// because "the host answered" and "a message was delivered" are different facts
// and conflating them is exactly the failure this panel exists to prevent.
const chainEls = {
  run: document.getElementById('chainSelfCheck'),
  verdict: document.getElementById('chainVerdict'),
  detail: document.getElementById('chainDetail'),
};

const CHAIN_LABELS = [
  ['hostOnline', 'Native Host 应答'],
  ['sourceReady', '终态源可读'],
  ['baseline', '终态基线'],
  ['binding', 'T053 绑定健康'],
  ['authorized', 'T058 发送授权'],
  ['trigger', 'T059 触发开关'],
  ['delivered', '实际页面写入'],
];

function chainMark(entry) {
  if (!entry || entry.known !== true) return 'unknown';
  return entry.value === true ? 'ok' : 'blocked';
}

function chainMarkText(entry) {
  const mark = chainMark(entry);
  if (mark === 'unknown') {
    return 'unknown' + (entry && entry.reason ? '（' + entry.reason + '）' : '');
  }
  return mark === 'ok' ? 'ok' : 'blocked' +
    (entry.code || entry.reason ? '（' + (entry.code || entry.reason) + '）' : '');
}

function renderChainVerdict(report) {
  if (!report || report.ok !== true) {
    chainEls.verdict.textContent = '自检失败：' + ((report && report.error) || 'unknown');
    chainEls.verdict.className = 'bad';
    return;
  }
  const lines = [];
  // Headline: the first blocked layer, or "no confirmed write yet". It never
  // says "已完成" for anything short of a confirmed page write.
  lines.push('结论：' + (report.headline || report.stage));
  lines.push('');
  for (const [key, label] of CHAIN_LABELS) {
    lines.push('  ' + label + ': ' + chainMarkText(report.layers[key]));
  }
  lines.push('');
  lines.push('读取时间: ' + (report.atIso || report.at));
  lines.push('这条自检不发送任何内容；sendEligible=' + String(report.sendEligible) +
    '，accountIdentity=' + report.accountIdentity);
  chainEls.verdict.textContent = lines.join('\n');
  chainEls.verdict.className = report.stage === 'ready' ? 'ok' : '';
}

function renderChainDetail(report) {
  if (!report || report.ok !== true) {
    chainEls.detail.textContent = '—';
    return;
  }
  const d = report.detail || {};
  const out = [];
  const host = d.host || {};
  out.push('Host: ' + (host.host && host.host.host
    ? host.host.host + ' v' + host.host.hostVersion +
      ' / protocol ' + host.host.protocolVersion
    : 'unknown') +
    ' | 可产候选=' + String(host.canProduceCandidates) +
    (host.sourceCode ? ' | 源代码=' + host.sourceCode : ''));

  const c = d.candidates || {};
  out.push('候选: 已存 ' + String(c.storedCandidates) + ' 条' +
    (c.candidateRunIds && c.candidateRunIds.length
      ? '（' + c.candidateRunIds.join(', ') + '）' : ''));
  if (typeof c.heldBackCandidates === 'number' && c.heldBackCandidates > 0) {
    out.push('其中 ' + String(c.heldBackCandidates)
      + ' 条为启用 T059 之前就存在的历史候选：不会自动发送，仅供人工审核。');
  }
  const lp = c.lastPoll;
  out.push('最近轮询/ACK: ' + (!lp || lp.known === false
    ? 'unknown（' + ((lp && lp.reason) || '无记录') + '）'
    : 'at=' + (lp.atIso || lp.at) + ' ok=' + String(lp.ok) +
      ' added=' + String(lp.added) + ' acked=' + String(lp.acked) +
      (lp.code ? ' code=' + lp.code : '')));

  const b = d.binding || {};
  out.push('绑定: ' + chainMarkText(b) +
    (b.status ? ' status=' + b.status : '') +
    (b.reason ? ' reason=' + b.reason : '') +
    (b.tabId !== null && b.tabId !== undefined ? ' tab=' + b.tabId : ''));

  const a = d.authorization || {};
  if (a && a.known === true) {
    out.push('授权: ' + (a.value === true ? '有效' : '无效') +
      ' 剩余 ' + String(a.remainingMinutes) + ' 分钟 / ' +
      String(a.remainingSends) + ' 条' +
      '（已用 ' + String(a.sentCount) + '/' + String(a.maxSends) + '）' +
      (a.expired ? ' [已过期]' : '') + (a.exhausted ? ' [已用完]' : '') +
      (a.lastError ? ' lastError=' + JSON.stringify(a.lastError) : ''));
  } else {
    out.push('授权: unknown（' + ((a && a.reason) || '不可读') + '）');
  }

  const t = d.trigger || {};
  out.push('触发: ' + chainMarkText(t) +
    (t.known === true
      ? ' 间隔 ' + String(t.minIntervalMs) + 'ms / 上限 ' +
        String(t.maxPerHour) + ' 次每小时；journal=' + JSON.stringify(t.journal)
      : ''));

  const del = d.delivery || {};
  // T059: the count comes from the delivery layer, the only record of confirmed page
  // writes. The old expression read the authorization detail's confirmedSends field,
  // which `authorizationLayer` never produces (it carries `sentCount`), so this line
  // printed "确认 0 次" no matter how many notices really landed.
  out.push('写入: 确认 ' + String(del.confirmedSends === null ||
    del.confirmedSends === undefined ? '—' : del.confirmedSends) + ' 次' +
    (del.confirmedSends === null && del.confirmedSendsCode
      ? '（' + del.confirmedSendsCode + '）' : '') +
    ' | ambiguous=' + String(del.ambiguousAttempts) +
    ' dangling=' + String(del.danglingAttempts) +
    (del.needsHumanReview ? ' ← 需要人工确认页面实际状态' : ''));

  chainEls.detail.textContent = out.join('\n');
  chainEls.detail.className = del.needsHumanReview ? 'bad' : '';
}

if (chainEls.run) {
  chainEls.run.addEventListener('click', async () => {
    chainEls.verdict.textContent = '正在只读自检…（不轮询、不 ACK、不发送）';
    chainEls.verdict.className = '';
    chainEls.detail.textContent = '—';
    const reply = await ask({ type: 't065-chain-selfcheck' });
    if (!reply.ok) {
      chainEls.verdict.textContent = '自检不可用：' + reply.error;
      chainEls.verdict.className = 'bad';
      return;
    }
    renderChainVerdict(reply.result);
    renderChainDetail(reply.result);
    // Added to the same panel: one extra line, no new button, no new interaction.
    try {
      const ready = await ask({ type: 't069-canary-readiness' });
      if (ready && ready.ok && ready.result) {
        const blocked = ready.result.blockedBy || [];
        const unsure = ready.result.unknownBy || [];
        // `unknown` gets its own marker and its own line: it is neither a pass nor
        // a proven blocker, and rendering it as either one would be a lie.
        const mark = (item) => (item.state === 'ok' ? '  ok  '
          : item.state === 'unknown' ? '  ??  ' : '  --  ');
        chainEls.detail.textContent += '\n\n首条真实发送就绪：'
          + (ready.result.ok
            ? '具备尝试条件（真实写入仍未确认）'
            : '仍被阻塞 → ' + (blocked.length ? blocked.join(', ') : '无'
              + (unsure.length ? '' : '（无阻塞项）'))
              + (unsure.length ? '；未确认 → ' + unsure.join(', ') : ''))
          + '\n' + (ready.result.items || [])
            .map((item) => mark(item) + item.id
              + (item.detail ? '：' + item.detail : ''))
            .join('\n');
      }
    } catch (_err) { /* the self-check above already reported its own result */ }
    // T074: where the most recent completion actually got to, stage by stage. Each
    // line is a different record; the note says which one is page proof.
    try {
      const evidence = await ask({ type: 't074-chain-evidence' });
      if (evidence && evidence.ok && evidence.result) {
        const mark = { observed: '  ok  ', absent: '  --  ', unknown: '  ??  ' };
        chainEls.detail.textContent += '\n\n本次链路证据（'
          + (evidence.result.runId || '尚无 run') + '）：'
          + evidence.result.headline
          + '\n' + (evidence.result.stages || [])
            .map((item) => (mark[item.state] || '  ??  ') + item.id
              + (item.code ? '（' + item.code + '）' : ''))
            .join('\n')
          + '\n注：ACK 不是送达；只有"适配器已提交"才是页面写入；'
          + '"独立证实后续派发"本扩展看不到。';
      }
    } catch (_err) { /* the evidence line is optional */ }
  });
}

function showBuildStamp() {
  if (!els.buildStamp) return;
  // Printed so a stale or differently-sourced copy is visible at a glance
  // instead of being argued about: compare this string with
  // extension/lib/build_stamp.js.
  els.buildStamp.textContent = '代码版本: ' + BUILD_STAMP +
    ' | extensionId=' + (chrome.runtime && chrome.runtime.id
      ? chrome.runtime.id : 'unknown');
}

showBuildStamp();
refresh();
refreshBindingState();
refreshDryRunState();
refreshAutoSend();
// T068: populated on open, because the whole point is that the operator decides while
// the task is running -- making them find and click a refresh button first is how a
// running task goes un-notified. Read-only on the host side: no poll, no ACK, no write.
refreshRunning();
