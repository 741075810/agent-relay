// T074: staged evidence for "did this completion actually get through?".
//
// The chain has six links, and each one is proven by a *different* record. The
// whole reason this module exists is that those records are not interchangeable:
//
//   1. terminal_observed      a real sample of the host's terminal source saw it
//   2. candidate_created      it was queued locally (`terminalCandidates`)
//   3. host_acknowledged      the host was told we consumed it -- this is a
//                             bookkeeping receipt, NOT a delivery
//   4. send_attempted         a write-ahead journal entry exists for it
//   5. adapter_submitted      the page receipt said `submitted`, which requires
//                             exactly one exact-template message and an empty
//                             composer -- this is the only page-level proof
//   6. downstream_confirmed   an independent observation that ChatGPT then acted
//                             (produced the next round). Nothing in this
//                             extension can see that, so it stays `unknown`
//                             unless the caller hands over such an observation.
//
// A stage that was not observed is `unknown`, never `true`. `acknowledgement-
// IsNotDelivery` is a constant so a reader cannot miss the distinction.
//
// Pure: it takes a `facts` bundle and returns a report. The caller owns storage
// and the host; this module performs no I/O of any kind.

export const STAGES = [
  'terminal_observed',
  'candidate_created',
  'host_acknowledged',
  'send_attempted',
  'adapter_submitted',
  'downstream_confirmed',
];

export const STAGE_TITLES = {
  terminal_observed: '终态观测',
  candidate_created: '候选生成',
  host_acknowledged: 'Host 确认（ACK，仅账面）',
  send_attempted: '发送尝试（预写日志）',
  adapter_submitted: '适配器已提交（页面回执）',
  downstream_confirmed: '独立证实 ChatGPT 后续派发',
};

export const OBSERVED = 'observed';
export const ABSENT = 'absent';
export const UNKNOWN = 'unknown';

function iso(ms) {
  if (!Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch (_err) { return null; }
}

function entry(id, state, code, detail, extra) {
  return Object.assign({ id, state, code: code || null, detail: detail || null },
    extra || {});
}

function key(runId, status) {
  return String(runId) + '|' + String(status);
}

// The trigger and autosend journals share a key format, so one lookup finds both.
function lookup(journal, runId) {
  const found = [];
  if (journal && typeof journal === 'object') {
    for (const [k, item] of Object.entries(journal)) {
      if (!item || typeof item !== 'object') continue;
      if (item.runId === runId || String(k).startsWith(runId + '|')) {
        found.push(Object.assign({ key: k }, item));
      }
    }
  }
  return found;
}

function latest(entries) {
  let best = null;
  for (const item of entries) {
    const at = Number.isFinite(item.settledAt) ? item.settledAt
      : (Number.isFinite(item.attemptedAt) ? item.attemptedAt : 0);
    if (!best || at >= best.at) best = { at, item };
  }
  return best;
}

/**
 * Choose the run to describe when the caller did not name one: the most recently
 * touched journal entry, else the head of the queue. Returns `null` when there is
 * nothing to describe, and every stage then reports `unknown` rather than a pass.
 */
export function pickRunId(facts) {
  const f = facts || {};
  const candidates = Array.isArray(f.candidates) ? f.candidates : [];
  const fromTrigger = [];
  const seen = f.triggerState && f.triggerState.seen;
  if (seen && typeof seen === 'object') {
    for (const item of Object.values(seen)) {
      if (item && typeof item.runId === 'string') fromTrigger.push(item);
    }
  }
  const best = latest(fromTrigger);
  if (best) return best.item.runId;
  const fromSend = [];
  const journal = f.autoSendState && f.autoSendState.journal;
  if (journal && typeof journal === 'object') {
    for (const item of Object.values(journal)) {
      if (item && typeof item.runId === 'string') fromSend.push(item);
    }
  }
  const bestSend = latest(fromSend);
  if (bestSend) return bestSend.item.runId;
  const head = candidates.find((item) => item && typeof item.runId === 'string');
  return head ? head.runId : null;
}

/**
 * Build the staged report.
 *
 * `facts`: `{ runId?, terminalChainStatus?, terminalSourceBaseline?, candidates?,
 *             triggerState?, autoSendState?, downstream? }`
 * `options.now` keeps the report reproducible in tests.
 */
export function describeChainEvidence(facts, options = {}) {
  const f = facts || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const runId = typeof f.runId === 'string' && f.runId ? f.runId : pickRunId(f);
  const candidates = Array.isArray(f.candidates) ? f.candidates : [];
  const queued = runId === null ? null
    : candidates.find((item) => item && item.runId === runId) || null;
  const triggerHits = runId === null ? [] : lookup(f.triggerState
    && f.triggerState.seen, runId);
  const sendHits = runId === null ? [] : lookup(f.autoSendState
    && f.autoSendState.journal, runId);
  const triggerBest = latest(triggerHits);
  const sendBest = latest(sendHits);
  const lastPoll = f.terminalChainStatus && typeof f.terminalChainStatus === 'object'
    ? f.terminalChainStatus : null;
  const baseline = f.terminalSourceBaseline
    && typeof f.terminalSourceBaseline === 'object' ? f.terminalSourceBaseline : null;
  const stages = [];

  // 1. terminal observation ------------------------------------------------
  const sampleOk = Boolean(lastPoll && lastPoll.ok === true);
  if (!sampleOk) {
    stages.push(entry('terminal_observed', UNKNOWN,
      lastPoll ? (lastPoll.code || 'last_poll_failed') : 'no_poll_record',
      lastPoll ? '最近一次采样未成功（' + (lastPoll.code || 'unknown') + '）'
        : '没有任何一次真实采样记录'));
  } else if (runId === null) {
    stages.push(entry('terminal_observed', UNKNOWN, 'no_run_selected',
      '还不存在任何候选或尝试记录，无法归属到某个 run'));
  } else if (queued || triggerHits.length || sendHits.length) {
    stages.push(entry('terminal_observed', OBSERVED, null,
      '采样于 ' + (iso(lastPoll.at) || 'unknown') + '，本次采样 added='
      + String(lastPoll.added), { at: Number.isFinite(lastPoll.at)
        ? lastPoll.at : null }));
  } else {
    stages.push(entry('terminal_observed', ABSENT, 'not_in_sample',
      '最近一次采样成功但未包含该 run（采样 ' + (iso(lastPoll.at) || 'unknown') + '）'));
  }

  // 2. candidate ------------------------------------------------------------
  if (runId === null) {
    stages.push(entry('candidate_created', UNKNOWN, 'no_run_selected', null));
  } else if (queued) {
    stages.push(entry('candidate_created', OBSERVED, null,
      '在本地候选队列中（status=' + String(queued.status) + '）'));
  } else if (triggerHits.length || sendHits.length) {
    stages.push(entry('candidate_created', OBSERVED, 'already_drained',
      '曾经入队，已从队列移除（日志仍有记录）'));
  } else if (!sampleOk) {
    stages.push(entry('candidate_created', UNKNOWN, 'no_poll_record', null));
  } else {
    stages.push(entry('candidate_created', ABSENT, 'not_queued',
      '从未进入本地候选队列'));
  }

  // 3. host ACK -------------------------------------------------------------
  //
  // Deliberately never `observed` per run: the ACK is written as a count
  // (`terminalChainStatus.acked`), so it cannot be attributed to one run. It is
  // also not evidence of a page write, which is the whole point of this stage
  // being separate.
  if (!lastPoll || !Number.isSafeInteger(lastPoll.acked)) {
    stages.push(entry('host_acknowledged', UNKNOWN, 'ack_not_recorded',
      '没有可用的 ACK 计数'));
  } else {
    stages.push(entry('host_acknowledged', UNKNOWN, 'ack_not_recorded_per_run',
      '最近一次轮询 acked=' + lastPoll.acked + '（链路级计数，无法归属到单个 run）；'
      + 'ACK 只表示宿主已交付该事件，不代表页面写入'));
  }

  // 4. attempt --------------------------------------------------------------
  //
  // A deferral is explicitly *not* an attempt: `deferred` is written only when the
  // writer proved the page was never touched. It is reported as absent, with the
  // reason and the next re-check, so "waiting for focus" never looks like
  // "tried and we do not know".
  const deferrals = f.triggerState && f.triggerState.deferred
    && typeof f.triggerState.deferred === 'object'
    ? f.triggerState.deferred : {};
  const deferral = runId === null ? null
    : deferrals[key(runId, queued ? queued.status : 'completed')]
      || Object.values(deferrals).find((item) => item && item.runId === runId)
      || null;
  const attempted = triggerBest || sendBest;
  if (attempted) {
    const state = attempted.item.state;
    const at = Number.isFinite(attempted.item.attemptedAt)
      ? attempted.item.attemptedAt : null;
    stages.push(entry('send_attempted', OBSERVED, 'journal_' + String(state),
      '预写日志状态=' + String(state), { at }));
  } else if (deferral) {
    stages.push(entry('send_attempted', ABSENT, 'deferred_' + String(deferral.reason),
      '写前被拒（' + String(deferral.reason) + '），页面未触碰；第 '
      + String(deferral.attempts) + ' 次延后，计划重检于 '
      + (iso(deferral.retryAt) || 'unknown'), {
        at: Number.isFinite(deferral.lastRefusedAt) ? deferral.lastRefusedAt : null,
        retryAt: Number.isFinite(deferral.retryAt) ? deferral.retryAt : null,
      }));
  } else if (queued) {
    stages.push(entry('send_attempted', ABSENT, 'not_attempted_yet',
      '仍在队列中，尚未发起写入'));
  } else {
    stages.push(entry('send_attempted', UNKNOWN, 'no_attempt_record',
      '没有任何尝试记录'));
  }

  // 5. adapter receipt ------------------------------------------------------
  const sentEntry = sendHits.find((item) => item.state === 'sent') || null;
  const ambiguous = sendHits.find((item) => item.state === 'ambiguous') || null;
  const inFlight = sendHits.find((item) => item.state === 'attempting') || null;
  const triggerStopped = triggerHits.find((item) => item.state === 'stopped') || null;
  if (sentEntry) {
    stages.push(entry('adapter_submitted', OBSERVED, null,
      '适配器回执 submitted（恰一条同模板消息且 composer 已清空）于 '
      + (iso(sentEntry.settledAt) || 'unknown'), {
        at: Number.isFinite(sentEntry.settledAt) ? sentEntry.settledAt : null,
        evidence: sentEntry.evidence || null,
      }));
  } else if (ambiguous) {
    stages.push(entry('adapter_submitted', ABSENT, 'outcome_ambiguous',
      '结果不确定（' + String(ambiguous.reason || 'unconfirmed') + '），按规则已停用；'
      + '不能算送达'));
  } else if (inFlight) {
    stages.push(entry('adapter_submitted', ABSENT, 'attempt_unresolved',
      '尝试尚未结算（重启后会被判定为不确定）'));
  } else if (triggerStopped) {
    stages.push(entry('adapter_submitted', ABSENT, 'send_stopped',
      '尝试被停止（' + String(triggerStopped.reason || 'send_not_confirmed') + '）'));
  } else if (triggerBest && triggerBest.item.state === 'sent' && !sentEntry) {
    // The trigger only records `sent` when the send path returned sent:true, which
    // the send path only does on an adapter `submitted`. A missing autosend entry
    // is therefore a contradiction, not a pass.
    stages.push(entry('adapter_submitted', UNKNOWN, 'journal_mismatch',
      '终态触发记为 sent，但自动发送日志缺少对应记录：证据不一致'));
  } else if (queued) {
    stages.push(entry('adapter_submitted', ABSENT, 'not_attempted_yet',
      '尚未发起写入，因此没有页面回执'));
  } else {
    stages.push(entry('adapter_submitted', UNKNOWN, 'no_write_attempted',
      '没有页面写入的证据'));
  }

  // 6. downstream ----------------------------------------------------------
  const down = f.downstream && typeof f.downstream === 'object'
    ? f.downstream : null;
  const independent = down && down.source === 'independent_observation'
    && typeof down.taskId === 'string' && down.taskId
    && (!runId || down.taskId !== runId);
  if (independent) {
    stages.push(entry('downstream_confirmed', OBSERVED, null,
      '独立观测到后续派发 taskId=' + down.taskId, {
        at: Number.isFinite(down.observedAt) ? down.observedAt : null }));
  } else {
    stages.push(entry('downstream_confirmed', UNKNOWN,
      'requires_independent_observation',
      '本扩展看不到 ChatGPT 是否据此派发了下一轮；DSH 任务 completed 与 ACK '
      + '都不能证明这一点'));
  }

  const byId = Object.fromEntries(stages.map((item) => [item.id, item]));
  const unverified = stages.filter((item) => item.state !== OBSERVED)
    .map((item) => item.id);
  return {
    at: now,
    atIso: iso(now),
    runId,
    stages,
    byId,
    // Page-level proof: exactly one template message appeared and the composer
    // emptied. Strong, but it is still *our* observation of *our* tab.
    deliveryProven: byId.adapter_submitted.state === OBSERVED,
    // A closed loop needs a link this extension cannot see by itself.
    loopClosed: byId.downstream_confirmed.state === OBSERVED,
    acknowledgementIsNotDelivery: true,
    unverified,
    stopReason: (f.triggerState && f.triggerState.lastError)
      || (f.autoSendState && f.autoSendState.lastError) || null,
    note: 'ACK 只表示宿主已交付事件；只有适配器 submitted 才算页面写入；'
      + '只有独立观测才能证明 ChatGPT 真的派发了下一轮。',
  };
}

/** One-line summary for the popup, kept beside the logic so they cannot drift. */
export function describeEvidenceLine(report) {
  if (!report || !Array.isArray(report.stages)) return '证据不可用';
  if (report.loopClosed) return '已独立证实后续派发';
  if (report.deliveryProven) return '页面写入已确认；后续派发未证实';
  const first = report.stages.find((item) => item.state !== OBSERVED);
  if (!first) return '证据不完整';
  const mark = first.state === ABSENT ? '未发生' : '未知';
  return STAGE_TITLES[first.id] + '：' + mark + '（' + (first.code || '-') + '）';
}
