// T193/T194: one read-only block that keeps six different facts apart.
//
// T194 fixed three real wiring bugs in the first version: `binding` was read from `local` although the binding
// lives in `session` (mirrored to `local`), `trigger.mode` does not exist -- the record carries
// `enabled` / `singleShotTrigger` / `maxTriggers` / `triggers` / `expiresAt` / `lastError` -- and the ACK line was
// hard-coded to unknown even though `terminalChainStatus.lastPoll.acked` is a real reading.
//
// Two rules that survive the rewrite:
//   * an ACK is "this poll's candidates the host confirmed", never "everything stored, and delivered";
//   * nothing here observes page display, so `delivery` is `unknown` on every path.
//
// An absent input renders `unknown`; it never defaults to a comfortable value.
(function expose() {
  'use strict';

  const UNKNOWN = 'unknown';

  function num(value) {
    return Number.isFinite(value) ? value : null;
  }

  /** Host-side acknowledgement: only what the last poll actually confirmed, with its time. */
  function ackLine(lastPoll) {
    const acked = num(lastPoll && lastPoll.acked);
    if (acked === null) return 'host ack: ' + UNKNOWN + ' (no chain-status reading)';
    const at = num(lastPoll.at);
    return 'host ack: last poll confirmed ' + acked + ' candidate(s)'
      + (at === null ? '' : ' at ' + new Date(at).toISOString())
      + ' -- storage confirmation for that poll, not page delivery';
  }

  /** Mode is derived from the fields the record really has; `mode` is not one of them. */
  function triggerLine(trigger) {
    if (!trigger || typeof trigger !== 'object') return 'trigger: ' + UNKNOWN;
    const oneShot = trigger.singleShotTrigger === true;
    const mode = oneShot ? 'single_shot' : 'standing';
    const enabled = trigger.enabled === true;
    const bits = [mode, enabled ? 'enabled' : (trigger.enabled === false ? 'disabled' : UNKNOWN)];
    const max = num(trigger.maxTriggers);
    const used = num(trigger.triggers);
    if (oneShot && max !== null && used !== null) {
      const remaining = Math.max(0, max - used);
      bits.push('remaining=' + remaining);
      if (remaining === 0) bits.push('spent');
    } else if (used !== null) {
      bits.push('triggers=' + used);
    }
    if (trigger.expiresAt !== null && trigger.expiresAt !== undefined) {
      bits.push(num(trigger.expiresAt) === null ? 'expiry ' + UNKNOWN
        : (trigger.expiresAt > Date.now() ? 'unexpired' : 'EXPIRED'));
    }
    if (trigger.lastError) bits.push('lastError=' + String(trigger.lastError).slice(0, 60));
    return 'trigger: ' + bits.join(' ');
  }

  function autosendLine(state) {
    if (!state || typeof state !== 'object') return 'autosend: ' + UNKNOWN;
    const sent = num(state.sentCount);
    const max = num(state.maxSends);
    const bits = [state.enabled === true ? 'enabled'
      : (state.enabled === false ? 'disabled' : UNKNOWN)];
    if (sent !== null && max !== null) bits.push(sent + '/' + max + ' used');
    else bits.push('quota ' + UNKNOWN);
    if (state.singleShot === true) bits.push('single-shot');
    if (num(state.expiresAt) !== null) {
      bits.push(state.expiresAt > Date.now() ? 'unexpired' : 'EXPIRED');
    }
    return 'autosend: ' + bits.join(' ');
  }

  /**
   * `bound` and `validated` are different facts. A mirror that survived a reload proves a binding was saved;
   * only a live probe proves it is still the page's. Say which one this is.
   */
  function bindingLine(binding) {
    if (!binding || typeof binding !== 'object') return 'binding: ' + UNKNOWN;
    if (binding.bound !== true) {
      return 'binding: no saved binding'
        + (binding.invalidatedReason ? ' (invalidated: ' + String(binding.invalidatedReason).slice(0, 60) + ')' : '');
    }
    const where = binding.source === 'session' ? 'session' : (binding.source === 'local' ? 'saved mirror' : UNKNOWN);
    const health = binding.validated === true ? 'current'
      : (binding.validated === false ? 'stale' : 'health ' + UNKNOWN);
    return 'binding: bound_saved (' + where + '), ' + health;
  }

  /** The last *recorded* adapter result. It is not attributed to the current run unless a run id links it. */
  function adapterLine(diag) {
    if (!diag || diag.present !== true) return 'page adapter: ' + UNKNOWN + ' (nothing recorded)';
    const f = (diag.stored && diag.stored.fields) || {};
    const bits = [f.status || UNKNOWN];
    if (f.reason) bits.push(f.reason);
    if (f.clickPerformed !== undefined) bits.push('click=' + f.clickPerformed);
    if (f.visibilityState) bits.push('vis=' + f.visibilityState);
    const runId = (diag.stored && diag.stored.runId) || null;
    return 'last recorded page adapter result: ' + bits.join(' ')
      + (runId ? ' (run ' + runId + ')' : ' (no run id -- ' + UNKNOWN + ' for the current run)');
  }

  function deliveryLine() {
    return 'delivery: ' + UNKNOWN + ' (a host ack is not page display; submitted is not consumption)';
  }

  function noticeRuntimeLines(input) {
    const src = input || {};
    return [
      ackLine(src.lastPoll),
      triggerLine(src.trigger),
      autosendLine(src.autosend),
      bindingLine(src.binding),
      adapterLine(src.diagnostic),
      deliveryLine(),
    ];
  }

  window.noticeRuntimeLines = noticeRuntimeLines;
}());
