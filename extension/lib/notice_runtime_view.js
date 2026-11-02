// T193: one read-only block that keeps six different facts apart, because collapsing them is what made the last
// four rounds of missing notices so hard to read.
//
//   hostAcKnown      the host stored the candidate (an ACK says *this*, and nothing else)
//   trigger          is the terminal trigger armed, and is it one-shot or standing
//   autosend         is the send permit live, how many sends are left, has it expired
//   binding          is the target conversation bound and still the one the page shows
//   adapter          what the page adapter actually returned for the last run
//   delivery         page display / ChatGPT consumption -- nothing here observes it
//
// No field is invented: an absent input renders `unknown`, never `ok`.
(function expose() {
  'use strict';

  const UNKNOWN = 'unknown';

  function oneOf(value, allowed) {
    return allowed.includes(value) ? value : null;
  }

  function hostAckLine(readiness) {
    const acked = readiness && readiness.ackedIds;
    if (!Number.isFinite(acked)) return 'host ack: ' + UNKNOWN + ' (no host readback)';
    return 'host ack: ' + acked + ' ids stored by the host (this is persistence, not page delivery)';
  }

  function triggerLine(trigger) {
    if (!trigger || typeof trigger !== 'object') return 'trigger: ' + UNKNOWN;
    const mode = oneOf(trigger.mode, ['standing', 'single_shot', 'off']);
    const enabled = trigger.enabled === true;
    const bits = [mode || UNKNOWN, enabled ? 'enabled' : (trigger.enabled === false ? 'disabled' : UNKNOWN)];
    if (trigger.lastError) bits.push('lastError=' + String(trigger.lastError).slice(0, 60));
    if (mode === 'single_shot' && trigger.spentAt) bits.push('spent');
    return 'trigger: ' + bits.join(' ');
  }

  function autosendLine(state) {
    if (!state || typeof state !== 'object') return 'autosend: ' + UNKNOWN;
    const sent = Number.isFinite(state.sentCount) ? state.sentCount : null;
    const max = Number.isFinite(state.maxSends) ? state.maxSends : null;
    const bits = [state.enabled === true ? 'enabled'
      : (state.enabled === false ? 'disabled' : UNKNOWN)];
    if (sent !== null && max !== null) bits.push(sent + '/' + max + ' used');
    else bits.push('quota ' + UNKNOWN);
    if (state.singleShot === true) bits.push('single-shot');
    if (Number.isFinite(state.expiresAt)) {
      bits.push(state.expiresAt > Date.now() ? 'unexpired' : 'EXPIRED');
    }
    return 'autosend: ' + bits.join(' ');
  }

  function bindingLine(binding) {
    if (!binding || typeof binding !== 'object') return 'binding: ' + UNKNOWN;
    const conv = typeof binding.conversationId === 'string' && binding.conversationId;
    const fresh = binding.stale === true ? 'STALE'
      : (binding.stale === false ? 'current' : UNKNOWN);
    return 'binding: ' + (conv ? 'conversation bound' : 'no conversation') + ', ' + fresh;
  }

  function adapterLine(diag) {
    if (!diag || diag.present !== true) return 'page adapter: ' + UNKNOWN + ' (no record)';
    const f = (diag.stored && diag.stored.fields) || {};
    const bits = [f.status || UNKNOWN];
    if (f.reason) bits.push(f.reason);
    if (f.clickPerformed !== undefined) bits.push('click=' + f.clickPerformed);
    if (f.visibilityState) bits.push('vis=' + f.visibilityState);
    return 'page adapter: ' + bits.join(' ');
  }

  function deliveryLine(diag) {
    // Nothing on this side observes page display or ChatGPT consumption, so the honest answer is a fixed line,
    // not a guess derived from an ack.
    if (diag && diag.present === true && diag.stored && diag.stored.delivered === true) {
      return 'delivery: claimed delivered by the record (unverified here)';
    }
    return 'delivery: ' + UNKNOWN + ' (a host ack is not page display; submitted is not consumption)';
  }

  function noticeRuntimeLines(input) {
    const src = input || {};
    return [
      hostAckLine(src.readiness),
      triggerLine(src.trigger),
      autosendLine(src.autosend),
      bindingLine(src.binding),
      adapterLine(src.diagnostic),
      deliveryLine(src.diagnostic),
    ];
  }

  window.noticeRuntimeLines = noticeRuntimeLines;
}());
