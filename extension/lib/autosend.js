// T058: one-time authorization for repeat notifications, default off.
//
// The old policy asked for a typed `SEND <runId>` before every single message.
// That is incompatible with "set it up once and stop confirming each task", so
// this module adds a *separate* standing authorization rather than loosening
// the old one:
//
//   * it is off until someone arms it with a real user gesture and the exact
//     phrase `AUTOSEND <conversationId>`;
//   * it expires (default 8h) and is capped (default 20 notices). Both bounds
//     are checked before every send, not once at arm time;
//   * it is tied to one binding revision and one document instance, so
//     re-binding, navigating or reloading the tab invalidates it;
//   * every attempt is journalled *before* the write. An attempt found in
//     `attempting` after a restart becomes `ambiguous` and is never retried;
//   * any doubt disarms it. `ambiguous` is a stop state, not a retry state.
//
// Nothing here reads the received-notification store. Those records are stored
// with `deliverable:false` and `queue_delivery` refuses anything else; using
// them as send candidates would be exactly the silent upgrade this design
// forbids. A candidate is supplied explicitly, by whoever is allowed to decide
// that a notice should be sent.
export const CONFIRM_PREFIX = 'AUTOSEND ';
// T048: a second, separate phrase for the mode that writes into a tab nobody is
// looking at. Two phrases, not one flag, because the two grants mean different
// things: the first says "type in the conversation I am watching", the second says
// "type in the conversation while I am somewhere else". A single phrase plus a
// checkbox would let a habitual `AUTOSEND <id>` silently become the wider one.
export const BACKGROUND_CONFIRM_PREFIX = 'AUTOSEND-BACKGROUND ';
export const DELIVERY_MODES = Object.freeze(['foreground', 'background']);
export const DEFAULT_DELIVERY_MODE = 'foreground';
// One manual authorization is meant to cover a working week, not an afternoon:
// 7 days and up to 1000 notices. Both are *defaults for the next explicit arm* --
// they never touch a grant that is already stored, so an existing authorization
// cannot widen itself just because these numbers changed.
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_SENDS = 1000;
// Hard bounds for an explicit request. Without them a caller could arm an
// effectively permanent, effectively unlimited permission in one click, and every
// later "is this authorized?" check would answer yes.
export const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SENDS_CEILING = 1000;
export const PROBE_MAX_AGE_MS = 5000;

export function createAutoSendState() {
  return {
    version: 1,
    enabled: false,
    // T048: absent/unknown means foreground. Every grant written before this field
    // existed keeps exactly the semantics it was given, which is why a stored
    // record needs no migration and cannot be widened by a reload.
    deliveryMode: DEFAULT_DELIVERY_MODE,
    armedAt: null,
    expiresAt: null,
    maxSends: 0,
    sentCount: 0,
    bindingRevision: null,
    conversationId: null,
    documentInstanceId: null,
    lastError: null,
    journal: {},
  };
}

export function journalKey(runId, status) {
  return String(runId) + '|' + String(status);
}

// Every code `decide()` can return is, by construction, a refusal *before* the
// page is touched: `decide` runs above `recordAttempt`/`write`, so nothing has
// been typed and nothing has been clicked. Callers still need to tell two very
// different situations apart:
//
//   * the target is merely unavailable right now (blurred tab, a draft in the
//     composer, a probe too old to trust). Nothing was written, and the same
//     notice may be offered again later after a fresh check. Recording that as an
//     uncertain write disabled the whole trigger for a tab that lost focus;
//   * the configuration itself rules the send out (no binding, expired grant,
//     changed conversation). Also nothing was written, but waiting will not help.
//
// Anything not listed here is treated as "a write may have happened" -- the safe
// direction. `PRE_WRITE_*` are only meaningful together with the writer's own
// `pageWriteAttempted: false`, which is the actual proof.
export const PRE_WRITE_DEFERRED = Object.freeze([
  'probe_unavailable', 'probe_stale',
  'target_not_visible_and_focused',
  // T048: in background mode the tab is *expected* to be inactive, so the two
  // situations that used to share one code are now separate. This one means the
  // bound tab cannot be observed at all right now -- discarded, frozen, or a
  // document the browser is not running. It is pre-write (nothing was typed), so
  // it defers; it is also escalating, because a tab that keeps saying this is not
  // coming back on its own.
  'target_background_unobservable',
  'session_occupied', 'session_occupied_by_dialog',
  // T051: a dialog is open over the composer, refused by the page-side writer
  // itself. It has to live here rather than only in `decide` because the probe
  // never reports `modalOpen`: the `session_occupied_by_dialog` rule above has no
  // data source in the served build, so this code is the real protection.
  //
  // Deferred, never escalated: a dialog is a transient state of the operator's own
  // page, so waiting is the correct answer, and the candidate must survive it.
  'modal_open',
  'composer_unavailable',
  // T056: a human's draft in the composer. The page-side writer refuses before it
  // types anything (`composerTouched:false`, the draft is byte-identical), so this
  // is the same class as `composer_unavailable`: nothing happened, and waiting is
  // the right answer. It is *not* caught one layer up by `session_occupied`, even
  // though `decide` has that rule, because the served read-only probe never reports
  // `composerEmpty` -- so without this entry the refusal reached `settle` as an
  // unknown code, became `ambiguous`, and disarmed the whole trigger over a draft
  // the operator was writing.
  //
  // Not escalating, on purpose: like `modal_open`, a draft is a transient state of
  // the operator's own page. Escalating would turn "I was typing" into a permanent
  // block; the candidate must survive and send once the box is empty.
  'composer_not_empty',
  // T079: the page has no send control we can identify, or not exactly one. Both
  // are proved to happen before the composer is touched, so neither is a write.
  // "Missing" can be a re-render, so it waits; "ambiguous" cannot be resolved by
  // waiting and is handled as a block instead.
  'send_control_missing',
  // T081: the tab lost focus between the background probe and the type step. Still
  // before the composer is touched, so still a pure refusal. Foreground only: a
  // background delivery never had focus to lose.
  'target_focus_lost',
  // T052: a write arrived with no document identity to check, which only a caller
  // older than the gate can do. Refused rather than trusted, and nothing was
  // written -- but deferred, because the tab picks up a current content script the
  // next time it loads. A caller that keeps omitting it reaches
  // MAX_DEFERRAL_ATTEMPTS and is blocked there instead of retrying for ever.
  'document_identity_unavailable',
]);

export const PRE_WRITE_BLOCKED = Object.freeze([
  'autosend_disabled', 'authorization_expired', 'authorization_exhausted',
  'target_not_bound', 'target_not_manually_bound',
  'binding_invalidated', 'binding_changed', 'conversation_changed',
  'wrong_tab', 'redirect_or_url_mismatch', 'conversation_identity_mismatch',
  'document_instance_changed',
  // T079: two candidate send controls, or the notice is aimed at a route the page
  // has already left. Neither is fixed by waiting; a human must look.
  'send_control_ambiguous', 'conversation_route_changed',
]);

// Codes whose deferral is expected to resolve on its own given time. A deferral
// that keeps repeating means the page is not what we think it is, so the trigger
// escalates it to a block instead of waiting for ever.
export const ESCALATING_DEFERRALS = Object.freeze([
  'send_control_missing',
  'target_background_unobservable',
]);
export const MAX_DEFERRAL_ATTEMPTS = 3;

/** `deferred` | `blocked` | `ambiguous`. Unknown codes are always `ambiguous`. */
export function classifyRefusal(code) {
  if (PRE_WRITE_DEFERRED.includes(code)) return 'deferred';
  if (PRE_WRITE_BLOCKED.includes(code)) return 'blocked';
  return 'ambiguous';
}


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function arm(state, input, confirmation, userGesture, now = Date.now()) {
  const binding = input && input.binding;
  if (!binding) return { state, result: { ok: false, code: 'target_not_bound' } };
  if (binding.manuallyConfirmed !== true) {
    return { state, result: { ok: false, code: 'target_not_manually_bound' } };
  }
  if (binding.invalidatedReason) {
    return { state, result: { ok: false, code: 'binding_invalidated' } };
  }
  if (typeof binding.conversationId !== 'string' || !binding.conversationId) {
    return { state, result: { ok: false, code: 'conversation_id_invalid' } };
  }
  if (userGesture !== true) {
    return { state, result: { ok: false, code: 'arm_user_gesture_required' } };
  }
  // Which mode is being asked for. An unrecognised value is refused rather than
  // defaulted: silently treating `backgroudn` as foreground would arm something
  // the operator did not ask for and then refuse every notice with a reason that
  // looks like a page fault.
  const wanted = input && input.deliveryMode === undefined
    ? DEFAULT_DELIVERY_MODE : input.deliveryMode;
  if (!DELIVERY_MODES.includes(wanted)) {
    return { state, result: { ok: false, code: 'arm_delivery_mode_unknown' } };
  }
  const prefix = wanted === 'background' ? BACKGROUND_CONFIRM_PREFIX : CONFIRM_PREFIX;
  if (confirmation !== prefix + binding.conversationId) {
    return { state, result: { ok: false, code: wanted === 'background'
      ? 'arm_background_confirmation_mismatch' : 'arm_confirmation_mismatch' } };
  }
  // Explicit requests are honoured but clamped to the hard bounds, so the stated
  // limit is always the effective limit. A default is never clamped: it already
  // sits inside them.
  const ttl = Number.isSafeInteger(input.ttlMs) && input.ttlMs > 0
    ? Math.min(input.ttlMs, MAX_TTL_MS) : DEFAULT_TTL_MS;
  const maxSends = Number.isSafeInteger(input.maxSends) && input.maxSends > 0
    ? Math.min(input.maxSends, MAX_SENDS_CEILING) : DEFAULT_MAX_SENDS;
  const next = clone(state || createAutoSendState());
  next.enabled = true;
  next.deliveryMode = wanted;
  next.armedAt = now;
  next.expiresAt = now + ttl;
  next.maxSends = maxSends;
  next.sentCount = 0;
  next.bindingRevision = binding.revision;
  next.conversationId = binding.conversationId;
  next.documentInstanceId = binding.documentInstanceId || null;
  next.lastError = null;
  return { state: next, result: { ok: true, enabled: true, deliveryMode: wanted,
    expiresAt: next.expiresAt, maxSends } };
}

export function disarm(state, reason, now = Date.now()) {
  const next = clone(state || createAutoSendState());
  next.enabled = false;
  next.lastError = reason || null;
  next.disarmedAt = now;
  for (const item of Object.values(next.journal)) {
    if (item.state === 'attempting') {
      item.state = 'ambiguous';
      item.reason = reason || 'disarmed_during_attempt';
      item.settledAt = now;
    }
  }
  return { state: next, result: { ok: true, enabled: false } };
}

// A restart cannot know whether the click landed. Treat it as unconfirmed.
export function reconcileAfterRestart(state, now = Date.now()) {
  const next = clone(state || createAutoSendState());
  let changed = false;
  for (const item of Object.values(next.journal)) {
    if (item.state === 'attempting') {
      item.state = 'ambiguous';
      item.reason = 'worker_restarted_during_attempt; do not retry blindly';
      item.settledAt = now;
      changed = true;
    }
  }
  if (next.enabled && Number.isFinite(next.expiresAt) && now >= next.expiresAt) {
    next.enabled = false;
    next.lastError = 'authorization_expired';
    changed = true;
  }
  return { state: next, changed };
}

/**
 * May this exact notice be sent right now?
 *
 * Every check returns a named reason. `send: true` never means "probably fine";
 * it means the target, the authorization and the journal all agreed.
 */
export function decide(state, input, now = Date.now()) {
  const s = state || createAutoSendState();
  const binding = input && input.binding;
  const probe = input && input.probe;

  if (s.enabled !== true) return { send: false, code: 'autosend_disabled' };
  if (!Number.isFinite(s.expiresAt) || now >= s.expiresAt) {
    return { send: false, code: 'authorization_expired' };
  }
  if (s.sentCount >= s.maxSends) {
    return { send: false, code: 'authorization_exhausted' };
  }
  if (!binding) return { send: false, code: 'target_not_bound' };
  if (binding.manuallyConfirmed !== true) {
    return { send: false, code: 'target_not_manually_bound' };
  }
  if (binding.invalidatedReason) {
    return { send: false, code: 'binding_invalidated' };
  }
  if (binding.revision !== s.bindingRevision) {
    return { send: false, code: 'binding_changed' };
  }
  if (binding.conversationId !== s.conversationId) {
    return { send: false, code: 'conversation_changed' };
  }

  if (!probe) return { send: false, code: 'probe_unavailable' };
  if (!Number.isSafeInteger(probe.observedAt) || now - probe.observedAt < 0 ||
      now - probe.observedAt > PROBE_MAX_AGE_MS) {
    return { send: false, code: 'probe_stale' };
  }
  if (probe.tabId !== binding.tabId || probe.windowId !== binding.windowId) {
    return { send: false, code: 'wrong_tab' };
  }
  if (probe.url !== binding.url) return { send: false, code: 'redirect_or_url_mismatch' };
  if (probe.conversationId !== binding.conversationId) {
    return { send: false, code: 'conversation_identity_mismatch' };
  }
  const expectedDoc = s.documentInstanceId || binding.documentInstanceId;
  if (!probe.documentInstanceId || probe.documentInstanceId !== expectedDoc) {
    return { send: false, code: 'document_instance_changed' };
  }
  // T048: foreground and background differ in exactly one place -- whether the tab
  // has to be the one the operator is looking at. Every identity check above this
  // line, and every occupancy check below it, is shared, because "is this the
  // conversation we bound, with an empty composer" is the same question either way.
  //
  // The mode comes from the *grant*, not from the caller: a caller cannot ask for
  // background delivery on the strength of a foreground grant.
  const mode = s.deliveryMode === 'background' ? 'background' : 'foreground';
  if (mode === 'foreground') {
    if (probe.active !== true || probe.hasFocus !== true ||
        probe.visibilityState !== 'visible') {
      return { send: false, code: 'target_not_visible_and_focused' };
    }
  } else {
    // A document the browser is not running cannot be typed into, however willing
    // we are to do it quietly. `hidden` is fine here -- that is the whole point of
    // the mode -- but a dropped, frozen or prerendering document is not.
    if (probe.discarded === true || probe.frozen === true ||
        !['visible', 'hidden'].includes(probe.visibilityState)) {
      return { send: false, code: 'target_background_unobservable',
        detail: probe.discarded === true ? 'discarded'
          : probe.frozen === true ? 'frozen'
            : 'visibility_' + String(probe.visibilityState) };
    }
  }
  if (probe.composerPresent !== true) {
    return { send: false, code: 'composer_unavailable' };
  }
  // Occupied means someone is in the middle of something: a draft is in the
  // box, or the page is showing a dialog. The rule from here is stop, never
  // "make it available" -- this module has no way to switch tabs or activate a
  // window, and that is deliberate. A send that needed a tab switch would be a
  // send into a conversation nobody is looking at.
  if (probe.composerEmpty === false) {
    return { send: false, code: 'session_occupied' };
  }
  if (probe.modalOpen === true) {
    return { send: false, code: 'session_occupied_by_dialog' };
  }

  const key = journalKey(input.runId, input.status);
  const prior = s.journal[key];
  if (prior) {
    if (prior.state === 'sent') return { send: false, code: 'duplicate_event' };
    if (prior.state === 'attempting') return { send: false, code: 'attempt_in_progress' };
    return { send: false, code: 'previous_attempt_ambiguous' };
  }
  // Last gate before a page write: one notice per *task*, not per task-status
  // pair. A status change must not produce a second message in the same
  // conversation.
  for (const item of Object.values(s.journal)) {
    if (item && item.runId === String(input.runId)) {
      return { send: false, code: 'duplicate_run' };
    }
  }
  return { send: true, code: null, key, deliveryMode: mode };
}

// Write-ahead: this must be persisted before the page is touched.
export function recordAttempt(state, input, now = Date.now()) {
  const next = clone(state || createAutoSendState());
  const key = journalKey(input.runId, input.status);
  next.journal[key] = {
    runId: String(input.runId),
    status: String(input.status),
    state: 'attempting',
    attemptedAt: now,
    settledAt: null,
    reason: null,
    // Named so no reader can mistake a stored notice for proof of origin.
    provenance: 'unverified_candidate',
  };
  return { state: next, key };
}

export function settle(state, key, outcome, now = Date.now()) {
  const next = clone(state || createAutoSendState());
  const item = next.journal[key];
  if (!item || item.state !== 'attempting') {
    return { state, result: { ok: false, code: 'event_not_attempting' } };
  }
  if (outcome && outcome.status === 'submitted') {
    item.state = 'sent';
    item.settledAt = now;
    item.reason = null;
    next.sentCount += 1;
    return { state: next, result: { ok: true, status: 'sent' } };
  }
  item.state = 'ambiguous';
  item.settledAt = now;
  item.reason = (outcome && (outcome.reason || outcome.status)) ||
    'send_outcome_unconfirmed';
  next.enabled = false;
  next.lastError = 'ambiguous_stop:' + item.reason;
  return { state: next, result: { ok: false, code: 'ambiguous',
    reason: item.reason } };
}
