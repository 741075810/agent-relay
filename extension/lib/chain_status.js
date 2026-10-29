// T065: read-only summary of the automatic-notification chain.
//
// One place that answers "how far along is this actually?", and nothing else.
// It reads state and reports; it never arms, sends, polls, acknowledges, clears,
// activates or navigates. Every field is either an observed fact or explicitly
// `unknown` -- the whole point is that "the host answered" must never be
// mistaken for "a message reached ChatGPT".
//
// The four layers are deliberately separate booleans, not a single percentage:
//   1. hostOnline        the native host answered a read-only request
//   2. sourceReady       the terminal source has a baseline (so "new" means new)
//   3. authorized        an auto-send authorization is currently valid
//   4. delivered         a page write was actually confirmed
// Only layer 4 is "done", and only a real receipt may set it.

export const LAYERS = ['hostOnline', 'sourceReady', 'authorized', 'delivered'];

function unknown(reason) {
  return { known: false, reason };
}

function known(value, extra) {
  return Object.assign({ known: true, value }, extra || {});
}

function iso(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch (_err) {
    return null;
  }
}

/**
 * Layer 1: did the host answer?
 * `hello` is read-only and cheap; `terminal-list` is what proves the terminal
 * source exists, so both are reported separately.
 */
export function hostLayer(hello, terminalList) {
  // Every early return has to carry all three keys. Returning a partial object
  // here made `summariseChain` throw on the one path that matters most -- a host
  // that never answered -- so the self-check crashed instead of reporting
  // "unknown".
  if (!hello || typeof hello !== 'object') {
    return {
      hostOnline: unknown('no_host_reply'),
      sourceReady: unknown('host_did_not_answer'),
      baseline: unknown('host_did_not_answer'),
    };
  }
  if (hello.ok === false) {
    return {
      hostOnline: known(false, { code: hello.code || 'host_error' }),
      sourceReady: unknown('host_did_not_answer'),
      baseline: unknown('host_did_not_answer'),
    };
  }
  const caps = hello.capabilities && typeof hello.capabilities === 'object'
    ? Object.keys(hello.capabilities).sort() : [];

  // `hello.capabilities` carries deliver/detect/simulate only -- the terminal
  // ops are not advertised there. So "can this host feed the chain?" is inferred
  // from what `terminal-list` actually answered, not from the capability map.
  // (Reading it off the map marked every real host as unsupported.)
  let terminalSupported = unknown('terminal_list_not_asked');
  let sourceReady = unknown('terminal_list_not_asked');
  let baseline = unknown('terminal_list_not_asked');
  if (terminalList && typeof terminalList === 'object') {
    if (terminalList.ok === false) {
      const code = terminalList.code || 'source_unavailable';
      if (code === 'unknown_op') {
        // The host is old or not the one this extension expects.
        terminalSupported = known(false, { code });
        sourceReady = known(false, { code });
        baseline = known(false, { code });
      } else if (code === 'baseline_not_established') {
        // Not a host answer at all: the self-check declined to ask, because its
        // first `terminal-list` would create the baseline and swallow every
        // pending completion. So "is the source readable" was never tested --
        // that is unknown, not blocked. Only the baseline is genuinely absent.
        terminalSupported = unknown('not_asked_before_baseline');
        sourceReady = unknown('not_asked_before_baseline');
        baseline = known(false, { code });
      } else {
        terminalSupported = known(true, { code });
        // The host answered, but the ledger behind it could not be read. That is
        // "source not ready", never "host offline".
        sourceReady = known(false, { code });
        baseline = known(false, { code });
      }
    } else {
      terminalSupported = known(true, {});
      const established = terminalList.baselineEstablished === true;
      // Same wording as the baseline layer: during a healthy self-check this call
      // is *not* the one that created the baseline, so the raw field would read
      // `false` and invite exactly the misreading this turn was about.
      sourceReady = known(true, { establishedNow: established });
      // `baselineEstablished` answers "did *this* call create the baseline", not
      // "does a baseline exist". A later sample reports false because the
      // baseline was already there, which is the healthy steady state -- reading
      // the flag straight into the value told the operator "baseline missing" on
      // every check after the first one. The value is "a baseline exists"; the
      // flag survives as `establishedNow`.
      baseline = known(true, {
        establishedNow: established,
        existingTerminalRuns: Number.isSafeInteger(terminalList.existingTerminalRuns)
          ? terminalList.existingTerminalRuns : null,
        droppedFromBaseline: Number.isSafeInteger(terminalList.droppedFromBaseline)
          ? terminalList.droppedFromBaseline : null,
      });
    }
  }

  return {
    hostOnline: known(true, {
      host: typeof hello.host === 'string' ? hello.host : null,
      hostVersion: typeof hello.hostVersion === 'string' ? hello.hostVersion : null,
      protocolVersion: hello.protocolVersion,
      capabilities: caps,
      terminalSupported,
      // true/false/'unknown' -- never a guess presented as a fact.
      canProduceCandidates: terminalSupported.known
        ? terminalSupported.value : 'unknown',
    }),
    sourceReady,
    baseline,
  };
}

/** Layer 2: what the last candidate poll saw, from stored state only. */
export function candidateLayer(stored) {
  const candidates = Array.isArray(stored && stored.candidates)
    ? stored.candidates : [];
  const lastPoll = stored && stored.lastPoll && typeof stored.lastPoll === 'object'
    ? stored.lastPoll : null;
  // Candidates that were already queued when the trigger was armed. They are held
  // for manual review rather than sent, so the count belongs in the diagnostics:
  // otherwise "1 stored candidate" looks like a stuck delivery instead of history.
  const preArm = Array.isArray(stored && stored.preArmCandidateKeys)
    ? new Set(stored.preArmCandidateKeys) : null;
  const heldBack = preArm
    ? candidates.filter((item) => item && preArm.has(
      String(item.runId) + '|' + String(item.status))).length
    : 0;
  return {
    storedCandidates: candidates.length,
    heldBackCandidates: preArm ? heldBack : null,
    candidateRunIds: candidates
      .map((item) => (item && typeof item.runId === 'string' ? item.runId : null))
      .filter(Boolean).slice(0, 10),
    lastPoll: lastPoll
      ? {
        at: Number.isFinite(lastPoll.at) ? lastPoll.at : null,
        atIso: iso(lastPoll.at),
        added: Number.isSafeInteger(lastPoll.added) ? lastPoll.added : null,
        acked: Number.isSafeInteger(lastPoll.acked) ? lastPoll.acked : null,
        ok: lastPoll.ok === true,
        code: typeof lastPoll.code === 'string' ? lastPoll.code : null,
      }
      : unknown('no_terminal_poll_recorded'),
  };
}

/** Layer 3: the standing authorization, including what is left of it. */
export function authorizationLayer(state, now = Date.now()) {
  if (!state || typeof state !== 'object') {
    return { authorized: unknown('authorization_state_unreadable') };
  }
  const expiresAt = Number.isFinite(state.expiresAt) ? state.expiresAt : null;
  const remainingMs = expiresAt === null ? null : Math.max(0, expiresAt - now);
  const maxSends = Number.isSafeInteger(state.maxSends) ? state.maxSends : null;
  const sentCount = Number.isSafeInteger(state.sentCount) ? state.sentCount : null;
  const remainingSends = maxSends === null || sentCount === null
    ? null : Math.max(0, maxSends - sentCount);
  const expired = expiresAt !== null && now >= expiresAt;
  const exhausted = remainingSends !== null && remainingSends === 0;
  // `enabled` alone is not "authorized": an expired or used-up grant is not one.
  const active = state.enabled === true && !expired && !exhausted;

  return {
    authorized: known(active, {
      enabled: state.enabled === true,
      expired,
      exhausted,
      expiresAt,
      expiresAtIso: iso(expiresAt),
      remainingMs,
      remainingMinutes: remainingMs === null ? null
        : Math.round(remainingMs / 60000),
      maxSends,
      sentCount,
      remainingSends,
      conversationId: typeof state.conversationId === 'string'
        ? state.conversationId : null,
      lastError: state.lastError || null,
    }),
  };
}

/** The trigger switch, kept apart from the send authorization on purpose. */
export function triggerLayer(state, now = Date.now()) {
  if (!state || typeof state !== 'object') {
    return { trigger: unknown('trigger_state_unreadable') };
  }
  const lastSentAt = Number.isFinite(state.lastSentAt) ? state.lastSentAt : null;
  const journal = state.seen && typeof state.seen === 'object'
    ? Object.values(state.seen) : [];
  const counts = { sent: 0, attempting: 0, stopped: 0, ambiguous: 0, blocked: 0 };
  for (const item of journal) {
    const s = item && item.state;
    if (s && Object.prototype.hasOwnProperty.call(counts, s)) counts[s] += 1;
  }
  // T076: deferrals are visible but are *not* attempts. They are listed apart from
  // the journal counts so "3 sent, 1 waiting for a re-check" cannot be read as
  // "4 attempts".
  //
  // T059: this `for` loop used to appear a second time, after the deferral
  // computation, with a body identical to the one above. Every state was therefore
  // counted twice: one really-sent run printed `journal={"sent":2,...}`, and a
  // single stopped run printed `stopped:2`. The panel is the only place an operator
  // can count attempts, so it was reporting twice the truth. Kept as one loop.
  const deferred = state.deferred && typeof state.deferred === 'object'
    ? Object.values(state.deferred) : [];
  return {
    trigger: known(state.enabled === true, {
      enabled: state.enabled === true,
      armedAt: Number.isFinite(state.armedAt) ? state.armedAt : null,
      minIntervalMs: Number.isSafeInteger(state.minIntervalMs)
        ? state.minIntervalMs : null,
      maxPerHour: Number.isSafeInteger(state.maxPerHour) ? state.maxPerHour : null,
      lastSentAt,
      lastSentAtIso: iso(lastSentAt),
      windowCount: Number.isSafeInteger(state.windowCount) ? state.windowCount : null,
      journal: counts,
      deferred: deferred.length,
      deferredReason: deferred.length && typeof deferred[0].reason === 'string'
        ? deferred[0].reason : null,
      lastError: state.lastError || null,
      // T078: what a schema repair had to fill in, and what it could not trust.
      schemaFilled: Array.isArray(state.schemaFilled)
        ? state.schemaFilled.filter((f) => typeof f === 'string') : [],
      schemaSuspect: Array.isArray(state.schemaSuspect)
        ? state.schemaSuspect.filter((f) => typeof f === 'string') : [],
    }),
  };
}

/** Layer 4: only a confirmed page write may ever claim delivery. */
export function deliveryLayer(state) {
  if (!state || typeof state !== 'object') {
    return { delivered: unknown('authorization_state_unreadable') };
  }
  const journal = state.journal && typeof state.journal === 'object'
    ? Object.values(state.journal) : [];
  const sent = journal.filter((item) => item && item.state === 'sent');
  const ambiguous = journal.filter((item) => item && item.state === 'ambiguous');
  const attempting = journal.filter((item) => item && item.state === 'attempting');
  const lastSent = sent.length
    ? sent.reduce((a, b) => (a.settledAt || 0) >= (b.settledAt || 0) ? a : b)
    : null;
  return {
    // Deliberately not `known(true)` when there is nothing: "no confirmed send
    // yet" is a fact about the record, and it must not read as success.
    delivered: sent.length > 0
      ? known(true, {
        confirmedSends: sent.length,
        lastSentAt: Number.isFinite(lastSent.lastSentAt) ? lastSent.lastSentAt : null,
        lastSentAtIso: iso(lastSent.lastSentAt),
        lastRunId: typeof lastSent.runId === 'string' ? lastSent.runId : null,
      })
      : known(false, { confirmedSends: 0, code: 'no_confirmed_page_write' }),
    ambiguousAttempts: ambiguous.length,
    danglingAttempts: attempting.length,
    // Anything non-zero here means the page state is genuinely unknown, which is
    // exactly the case where the chain must stop rather than retry.
    needsHumanReview: ambiguous.length > 0 || attempting.length > 0,
  };
}

/** Binding health, passed through but flattened so the popup can render it. */
export function bindingLayer(health) {
  if (!health || typeof health !== 'object') {
    return { binding: unknown('binding_health_not_asked') };
  }
  const ok = health.ok === true;
  const b = health.binding && typeof health.binding === 'object'
    ? health.binding : null;
  return {
    binding: known(ok, {
      status: typeof health.status === 'string' ? health.status : null,
      reason: typeof health.reason === 'string' ? health.reason : null,
      tabId: b && Number.isSafeInteger(b.tabId) ? b.tabId : null,
      conversationId: b && typeof b.conversationId === 'string'
        ? b.conversationId : null,
      visibilityState: typeof health.visibilityState === 'string'
        ? health.visibilityState : null,
      hasFocus: health.hasFocus === true,
      frozen: typeof health.frozen === 'boolean' ? health.frozen : null,
      frozenStateKnown: health.frozenStateKnown === true,
      // A healthy binding is still not a send: this stays false always.
      sendEligible: false,
      accountIdentity: health.accountIdentity || 'unverified',
    }),
  };
}

/**
 * Assemble the report. Takes an already-collected `facts` bundle so this stays a
 * pure function and the caller owns every side effect (there are none).
 */
export function summariseChain(facts, now = Date.now()) {
  const f = facts || {};
  const host = hostLayer(f.hello, f.terminalList);
  const candidates = candidateLayer(f.candidates);
  const authorization = authorizationLayer(f.autoSendState, now);
  const trigger = triggerLayer(f.triggerState, now);
  const delivery = deliveryLayer(f.autoSendState);
  const binding = bindingLayer(f.bindingHealth);

  // The headline is the weakest link, never the strongest: a green host must not
  // colour the whole line green.
  const steps = {
    hostOnline: host.hostOnline,
    sourceReady: host.sourceReady,
    baseline: host.baseline,
    binding: binding.binding,
    authorized: authorization.authorized,
    trigger: trigger.trigger,
    delivered: delivery.delivered,
  };
  const stageOf = (entry) => {
    if (!entry || entry.known !== true) return 'unknown';
    return entry.value === true ? 'ok' : 'blocked';
  };
  const order = ['hostOnline', 'sourceReady', 'baseline', 'binding',
    'authorized', 'trigger', 'delivered'];
  const firstBlocked = order.find((name) => stageOf(steps[name]) === 'blocked');
  const anyUnknown = order.some((name) => stageOf(steps[name]) === 'unknown');

  return {
    ok: true,
    at: now,
    atIso: iso(now),
    // Nothing here is a message; it is a reading of local state.
    deliveredMessage: false,
    sendEligible: false,
    accountIdentity: 'unverified',
    stage: firstBlocked || (anyUnknown ? 'unknown' : 'ready'),
    stages: Object.fromEntries(order.map((name) => [name, stageOf(steps[name])])),
    layers: {
      hostOnline: host.hostOnline,
      sourceReady: host.sourceReady,
      baseline: host.baseline,
      binding: binding.binding,
      authorized: authorization.authorized,
      trigger: trigger.trigger,
      delivered: delivery.delivered,
    },
    detail: {
      host: {
        host: host.hostOnline.value === true
          ? { host: host.hostOnline.host, hostVersion: host.hostOnline.hostVersion,
            protocolVersion: host.hostOnline.protocolVersion,
            capabilities: host.hostOnline.capabilities } : null,
        canProduceCandidates: host.hostOnline.canProduceCandidates,
        sourceCode: host.sourceReady.code || null,
      },
      candidates: candidates,
      authorization: authorization.authorized,
      trigger: trigger.trigger,
      delivery: {
        ambiguousAttempts: delivery.ambiguousAttempts,
        danglingAttempts: delivery.danglingAttempts,
        needsHumanReview: delivery.needsHumanReview,
        // T059: the popup's `写入: 确认 N 次` line read
        // `detail.authorization.confirmedSends`, a field that does not exist on
        // `authorizationLayer().authorized` (it carries `sentCount`). The expression
        // therefore evaluated to 0 for ever -- five confirmed page writes still
        // printed "确认 0 次". The number exists, on the delivery layer, so pass the
        // real one through instead of letting the panel guess. `0` is a fact here
        // (nothing confirmed yet), which is exactly why `delivered` marks it with
        // `value: false` and the code below.
        confirmedSends: Number.isSafeInteger(delivery.delivered
          && delivery.delivered.confirmedSends)
          ? delivery.delivered.confirmedSends : null,
        confirmedSendsCode: (delivery.delivered && delivery.delivered.value !== true
          ? (delivery.delivered.code || 'no_confirmed_page_write') : null),
      },
      binding: binding.binding,
    },
  };
}

/** One-line human summary. Kept next to the logic so the two cannot drift. */
export function describeStage(report) {
  if (!report || report.ok !== true) return '自检失败';
  switch (report.stage) {
    case 'hostOnline': return 'Native Host 未应答';
    case 'sourceReady': return 'Host 在线但终态源不可读';
    case 'baseline': return '终态源尚未建立基线（等一次正常轮询建立）';
    case 'binding': return '绑定目标不健康或不完整';
    case 'authorized': return '未授权自动发送（或授权已过期/用完）';
    case 'trigger': return '自动发送已授权，但终态触发未启用';
    case 'delivered': return '链路已就绪，但尚无确认过的页面写入';
    case 'ready': return '链路就绪且已有确认写入';
    case 'unknown': return '部分状态未知，见下方明细';
    default: return '未知状态';
  }
}
