// T059: the terminal trigger -- a separate, default-off switch that decides
// which terminal events may even be offered to the send path.
//
// Why it is separate from `autosend`: `autosend` answers "may I write to this
// page right now". This answers "should this completion be sent at all". Folding
// them together would mean the rate limit and the dedup lived in the same object
// as the target checks, and a bug in one would quietly disable the other.
//
// Why it is separate from the received store: `queue_delivery.js` refuses any
// event whose `deliverable !== false`, so those records are, by construction,
// not sendable. This module is fed from its own candidate list
// (`storage.local.terminalCandidates`), which is empty until something that is
// allowed to decide fills it. The read-only notification path is untouched.
//
// Bounds are clamped, not trusted: a caller cannot enlarge the rate limit or
// shorten the dedup window by passing bigger numbers.
import { classifyRefusal, ESCALATING_DEFERRALS, MAX_DEFERRAL_ATTEMPTS }
  from './autosend.js';

export const CONFIRM_PREFIX = 'AUTOTRIGGER ';
// T123: the restricted trigger. T122 gave the *send* a one-shot form but left the trigger that
// offers candidates on the standing path, so a spent single shot was followed by an hourly
// trigger that kept proposing new tasks. This is the missing half: its own phrase, a hard cap
// of one, and a window, so "one test message" is one candidate as well as one write.
export const ONCE_CONFIRM_PREFIX = 'AUTOTRIGGER-ONCE ';
export const ONCE_TTL_MS = 15 * 60 * 1000;
export const MIN_INTERVAL_FLOOR_MS = 30 * 1000;
// 30 seconds is the requested floor *and* the default: with a 100/hour ceiling the
// interval alone could never reach 100, so the two are deliberately independent --
// the interval paces bursts, the hourly count caps the total.
export const DEFAULT_MIN_INTERVAL_MS = 30 * 1000;
// An hour is a fixed 3600000 ms window, so 100 an hour can never be exceeded even
// if the alarm fires more often than expected.
export const MAX_PER_HOUR_CEILING = 100;
export const DEFAULT_MAX_PER_HOUR = 100;
// Bounds an explicit request, not the default. A ten-hour "minimum interval" would
// look armed and never fire, which is worse than refusing the number.
export const MAX_INTERVAL_CEILING_MS = 60 * 60 * 1000;
export const WINDOW_MS = 60 * 60 * 1000;
export const ALLOWED_STATUS = ['completed', 'failed', 'cancelled'];

// T067: the two channels, and the consent each one needs.
//
//   bridge  the run was dispatched by the Bridge (ChatGPT asked for it), so the
//           terminal notice is the expected reply. Notified by default.
//   direct  the run was started by a person in DSH Desktop's own window. Nothing
//           asked for a report, so the default is *off* and the operator opts in
//           per task.
//   unknown cannot be proven either way (the Bridge database was unreadable and
//           no cache covered the run). Treated exactly like `direct`: manual.
//           Guessing `bridge` here is the only way an unattended write could
//           happen without anyone asking for it.
export const ORIGIN_BRIDGE = 'bridge';
export const ORIGIN_DIRECT = 'direct';
export const ORIGIN_UNKNOWN = 'unknown';
export const ORIGINS = [ORIGIN_BRIDGE, ORIGIN_DIRECT, ORIGIN_UNKNOWN];
// How long a per-task opt-in stays valid. Long enough to survive a deferred
// re-check loop (the backoff caps at five minutes), short enough that a click
// made an hour ago cannot deliver a task that is only now retired.
export const DIRECT_OPTIN_TTL_MS = 30 * 60 * 1000;

// T068: opting in to a task that is still running.
//
// The T067 flow arms a candidate that is already in the list, which only exists once
// the task has *ended*. For a task that runs for hours that is the wrong moment: the
// operator knows at minute two that they want the notice, and is asleep at hour three
// when the decision would have been available. Worse, reusing `DIRECT_OPTIN_TTL_MS`
// for it would expire the click before the task finished -- a long task would lose
// its choice silently, which is precisely the defect this constant set exists to fix.
//
// So a running opt-in is keyed on what the task *is* -- (sessionId, turn), the same
// pair the host joins on -- rather than on a candidate that does not exist yet, and it
// has no short TTL. Three bounds replace the TTL:
//
//   * it only ever authorises the one turn it names;
//   * it must have been recorded strictly before that turn's own `endedAt`, so a
//     click can never turn into a retroactive notice for work that already finished;
//   * it is deleted on age (`OPTIN_MAX_AGE_MS`) and the store is capped, so an
//     abandoned opt-in cannot accumulate forever.
export const OPTIN_VERSION = 1;
// A week is far longer than any task this machine runs, and it is the only thing
// stopping a store left behind by a deleted session from living forever.
export const OPTIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Bounded store. 100 concurrent named tasks is already generous; the cap is what
// keeps a long-lived profile from growing an unbounded permission list.
export const MAX_OPTINS = 100;
// An opt-in for a future timestamp would be an unbounded grant, so it is treated as
// corrupt rather than clamped: clamping would silently honour half of a bad record.
export const OPTIN_FUTURE_SLACK_MS = 5 * 60 * 1000;

// T076: how long a pre-write refusal waits before the gate is checked again. The
// first retry is one pacing interval away, then it doubles, capped at five
// minutes. This is a bounded backoff, not a poll loop: the alarm keeps ticking at
// its own period and `admit` refuses until `retryAt`, so nothing busy-waits and no
// page probe is made in the meantime.
export const DEFER_BASE_MS = MIN_INTERVAL_FLOOR_MS;
export const DEFER_MAX_MS = 5 * 60 * 1000;
// A deferral map that could grow without bound is a slow leak in a long-lived
// worker. Only the most recently deferred entries are worth remembering.
export const MAX_DEFERRED = 50;

export function createTriggerState() {
  return {
    version: 1,
    enabled: false,
    armedAt: null,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    maxPerHour: DEFAULT_MAX_PER_HOUR,
    // T122: a per-arm cap, null on the standing path. The hourly limit bounds the *rate*;
    // this bounds the *total*, which is what a one-shot test needs. Absent means unlimited
    // by this field, i.e. every existing arm keeps exactly the behaviour it had.
    maxTriggers: null,
    triggers: 0,
    // T123: absent/false on every stored record written before this field existed, which is
    // exactly right -- those arms are the standing ones.
    singleShotTrigger: false,
    expiresAt: null,
    lastSentAt: null,
    windowStartedAt: null,
    windowCount: 0,
    lastError: null,
    disabledAt: null,
    seen: {},
    // Pre-write refusals that are waiting for a re-check. Kept apart from `seen`
    // on purpose: `seen` is "this run has been offered to the page", and putting a
    // deferral there would both poison the dedup and lose the retry.
    deferred: {},
    // T142: the write that is in flight right now -- `{key, runId, status, at}` or null.
    // It is the concurrency barrier: while one is on record no other candidate may be
    // admitted, and a restart that finds one treats the write as possibly-landed.
    pendingAttempt: null,
    // T142: what the last tick decided, so the popup can say "43 candidates, one
    // released" instead of showing an arm that looks silently broken.
    lastTick: null,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// T078: one place that knows the schema.
//
// The T074 record on disk has no `deferred` field; T076's `settle()` read it
// directly, so upgrading the extension with a trigger already armed threw
// `Cannot read properties of undefined (reading '<uuid>|completed')` on every tick
// and the alarm wrapper disarmed the trigger. Filling the field at *every* entry
// point is the fix; guessing inside one branch is not.
//
// Two rules decide what a repair may do:
//
//   * history is never rewritten. `seen`, `preArmCandidateKeys`, `windowCount`,
//     `lastSentAt` and the grant are carried through exactly as found, because
//     losing them is what would let an already-sent run be sent again;
//   * a field we cannot trust disables sending instead of resetting to a
//     permissive default. `suspect` names those fields and `admit()` refuses while
//     it is non-empty; only an explicit re-arm (which resets the window by design)
//     clears it.
//
// Safe to call on anything, any number of times: a second pass changes nothing and
// reports `filled: []`.
export function normalizeTriggerState(state, now = Date.now()) {
  const filled = [];
  const suspect = [];
  const isPlain = (v) => v !== null && typeof v === 'object'
    && !Array.isArray(v);
  let next;
  if (isPlain(state)) {
    next = clone(state);
  } else {
    // Not even an object: there is no history to preserve, and a fresh state is
    // off by default.
    next = createTriggerState();
    filled.push('state');
    suspect.push('state');
  }

  if (!Number.isSafeInteger(next.version)) {
    next.version = 1;
    filled.push('version');
  }
  if (typeof next.enabled !== 'boolean') {
    // `'true'`, `1`, `{}` -- none of them are "on", and none may be read as on.
    next.enabled = false;
    filled.push('enabled');
    suspect.push('enabled');
  }
  if (!isPlain(next.seen)) {
    if (next.seen === undefined) {
      next.seen = {};
      filled.push('seen');
    } else {
      // A `seen` we cannot read might be hiding a sent run. Resetting it to `{}`
      // would be a licence to resend, so the state is quarantined instead.
      next.seen = {};
      filled.push('seen');
      suspect.push('seen');
    }
  }
  if (!isPlain(next.deferred)) {
    // Losing a deferral only means an earlier re-check, and dedup plus every send
    // gate still apply, so this one is repairable without quarantine.
    next.deferred = {};
    filled.push('deferred');
  }

  const interval = next.minIntervalMs;
  if (!Number.isSafeInteger(interval)) {
    next.minIntervalMs = DEFAULT_MIN_INTERVAL_MS;
    filled.push('minIntervalMs');
    if (interval !== undefined) suspect.push('minIntervalMs');
  } else {
    const bounded = Math.min(MAX_INTERVAL_CEILING_MS,
      Math.max(MIN_INTERVAL_FLOOR_MS, interval));
    if (bounded !== interval) {
      next.minIntervalMs = bounded;
      filled.push('minIntervalMs');
    }
  }
  const perHour = next.maxPerHour;
  if (!Number.isSafeInteger(perHour)) {
    next.maxPerHour = DEFAULT_MAX_PER_HOUR;
    filled.push('maxPerHour');
    if (perHour !== undefined) suspect.push('maxPerHour');
  } else {
    // Only ever tightened: a stored 20 stays 20.
    const bounded = Math.min(MAX_PER_HOUR_CEILING, Math.max(1, perHour));
    if (bounded !== perHour) {
      next.maxPerHour = bounded;
      filled.push('maxPerHour');
    }
  }

  for (const field of ['armedAt', 'lastSentAt', 'windowStartedAt', 'disabledAt']) {
    const value = next[field];
    if (value === undefined) {
      // Absent is not corrupt: it is what an older record legitimately looks like.
      next[field] = null;
      filled.push(field);
    } else if (value !== null && !Number.isFinite(value)) {
      next[field] = null;
      filled.push(field);
      // Pacing and the window anchor are safety-relevant: an unreadable anchor
      // could look like "never sent", which would skip the interval check.
      if (field === 'lastSentAt' || field === 'windowStartedAt') {
        suspect.push(field);
      }
    }
  }

  const count = next.windowCount;
  if (!Number.isSafeInteger(count) || count < 0) {
    // Fail closed: an unreadable count is treated as "this window is used up",
    // which is wrong in the safe direction and clears on re-arm or rollover.
    next.windowCount = Number.isSafeInteger(next.maxPerHour) ? next.maxPerHour : 0;
    filled.push('windowCount');
    // A *missing* count is not corruption -- it means no window has started, and
    // zero is the honest reading. Only a present-but-unreadable one is suspect.
    if (count !== undefined) suspect.push('windowCount');
  }

  if ('preArmCandidateKeys' in next) {
    const keys = next.preArmCandidateKeys;
    const valid = Array.isArray(keys) && keys.every((k) => typeof k === 'string');
    if (!valid) {
      // Without the snapshot, `runTerminalTrigger` cannot tell backlog from new
      // work. Drop the field (so it re-snapshots) but do not send on that basis.
      delete next.preArmCandidateKeys;
      filled.push('preArmCandidateKeys');
      suspect.push('preArmCandidateKeys');
    }
  }

  // An existing quarantine is inherited, never recomputed from the repaired
  // fields: after `seen` was reset to `{}` there is nothing left to notice, and
  // forgetting it would silently turn "unreadable history" into "nothing sent".
  const inherited = Array.isArray(next.schemaSuspect)
    ? next.schemaSuspect.filter((f) => typeof f === 'string') : [];
  const uniq = [...new Set([...inherited, ...suspect])];
  if (uniq.length > 0) {
    next.schemaSuspect = uniq;
  } else {
    delete next.schemaSuspect;
  }
  if (filled.length > 0) {
    next.schemaFilled = [...new Set(filled)];
    next.normalizedAt = now;
  }
  return { state: next, filled: [...new Set(filled)], suspect: uniq };
}

/** The normalized state, for callers that do not care what was repaired. */
function normalized(state) {
  return normalizeTriggerState(state).state;
}


export function key(runId, status) {
  return String(runId) + '|' + String(status);
}

/**
 * T086: can this completion be *proved* to have happened after the operator armed
 * the trigger?
 *
 * The old boundary was `preArmCandidateKeys` -- a snapshot of the *local* queue at
 * arm time. That is a fact about the extension's cache, not about the task: a run
 * that finished before arming but had not been pulled from the host yet was absent
 * from the snapshot, so the next tick saw it as fresh work and wrote a notice for
 * it. Reloading the extension and re-arming made exactly that happen.
 *
 * What the wire contract does give us is `startedAt`: the run's creation time in
 * whole seconds (the host floors `createdAt`, it does not round). A run always
 * completes at or after it was created, so
 *
 *     startedAt * 1000 >= armedAt   =>   completedAt >= armedAt
 *
 * which is a proof, not an estimate. The converse is *not* a proof: a run created
 * before the arm may have finished either side of it, and the contract carries no
 * completion timestamp to tell those apart. Such a run is refused and named, never
 * guessed at.
 *
 * Returns `{proven: true, reason: null}` or `{proven: false, reason}`.
 * The reasons are stable strings: `arm_boundary_missing`, `candidate_time_missing`,
 * `started_before_arm`.
 */
export function completionAfterArm(state, candidate) {
  const armedAt = state ? state.armedAt : null;
  if (!Number.isFinite(armedAt) || armedAt <= 0) {
    // No boundary on record. Sending on that basis would be the old behaviour back
    // again, so this is fatal for the candidate rather than "assume fresh".
    return { proven: false, reason: 'arm_boundary_missing' };
  }
  const startedAt = candidate ? candidate.startedAt : null;
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    // Older local entries stored only `{runId, status}`. Without a creation time
    // there is nothing to compare, and "no evidence" must not become "yes".
    return { proven: false, reason: 'candidate_time_missing' };
  }
  // Floor before scaling: the host truncates downwards, and flooring an already
  // truncated value can only move the estimate earlier, i.e. stricter.
  if (Math.floor(startedAt) * 1000 >= armedAt) {
    return { proven: true, reason: null };
  }
  return { proven: false, reason: 'started_before_arm' };
}

export function configure(state, input, confirmation, userGesture, now = Date.now()) {
  const binding = input && input.binding;
  if (!binding || binding.manuallyConfirmed !== true) {
    return { state, result: { ok: false, code: 'target_not_manually_bound' } };
  }
  if (userGesture !== true) {
    return { state, result: { ok: false, code: 'trigger_user_gesture_required' } };
  }
  // T123: the phrase decides which grant is being asked for. `restricted` is set by
  // `configureOnce` below, never by a message: a caller that says AUTOTRIGGER-ONCE and then
  // tries to pass its own cap gets the once bounds regardless.
  const restricted = input && input.restricted === true;
  const prefix = restricted ? ONCE_CONFIRM_PREFIX : CONFIRM_PREFIX;
  if (confirmation !== prefix + binding.conversationId) {
    return { state, result: { ok: false, code: 'trigger_confirmation_mismatch' } };
  }
  const next = normalized(state);
  const wanted = Number.isSafeInteger(input.minIntervalMs)
    ? input.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
  const perHour = Number.isSafeInteger(input.maxPerHour)
    ? input.maxPerHour : DEFAULT_MAX_PER_HOUR;
  next.enabled = true;
  next.armedAt = now;
  next.minIntervalMs = Math.min(MAX_INTERVAL_CEILING_MS,
    Math.max(MIN_INTERVAL_FLOOR_MS, wanted));
  next.maxPerHour = Math.min(MAX_PER_HOUR_CEILING, Math.max(1, perHour));
  // T122: null (the default) means no per-arm cap. A positive integer caps the total, and
  // the counter restarts because a fresh arm is a fresh grant.
  //
  // T123: a restricted arm is one, always.
  next.maxTriggers = restricted ? 1
    : (Number.isSafeInteger(input.maxTriggers) && input.maxTriggers > 0
      ? Math.min(input.maxTriggers, MAX_PER_HOUR_CEILING) : null);
  next.singleShotTrigger = restricted;
  next.expiresAt = restricted ? now + ONCE_TTL_MS : null;
  next.triggers = 0;
  next.lastError = null;
  next.windowStartedAt = now;
  next.windowCount = 0;
  // `lastSentAt` is deliberately *not* cleared: it paces the next send, and a
  // re-arm should not buy an immediate one.
  // A re-arm rebuilds exactly the fields named here, so a quarantine on them is
  // genuinely gone. A quarantine on `seen` or `preArmCandidateKeys` is not: those
  // were reset, not repaired, and clearing it would turn "unreadable history" into
  // "nothing was ever sent". Keep it, and keep refusing.
  if (Array.isArray(next.schemaSuspect)) {
    const rebuilt = new Set(['state', 'enabled', 'minIntervalMs', 'maxPerHour',
      'windowStartedAt', 'windowCount', 'lastSentAt', 'armedAt', 'disabledAt']);
    const left = next.schemaSuspect.filter((field) => !rebuilt.has(field));
    if (left.length > 0) next.schemaSuspect = left;
    else delete next.schemaSuspect;
  }
  return { state: next, result: {
    ok: true, enabled: true,
    minIntervalMs: next.minIntervalMs, maxPerHour: next.maxPerHour,
    maxTriggers: next.maxTriggers, triggers: next.triggers,
    singleShotTrigger: next.singleShotTrigger, expiresAt: next.expiresAt,
    schemaSuspect: Array.isArray(next.schemaSuspect) ? next.schemaSuspect.slice()
      : [],
  } };
}

/**
 * T123: arm the trigger for exactly one terminal message.
 *
 * Restated so it cannot be skimmed past: `maxTriggers` is set here and not read from `input`,
 * because the value that matters must not be the one a caller can supply. Everything else --
 * phrase check, gesture check, binding check, the arm boundary the whole design rests on --
 * is the same code the standing arm runs.
 */
export function configureOnce(state, input, confirmation, userGesture, now = Date.now()) {
  return configure(state, Object.assign({}, input, { restricted: true }),
    confirmation, userGesture, now);
}

/**
 * T123: after a send, a restricted trigger is spent -- and "we are not sure whether it landed"
 * counts as spent, for the same reason it does for the send grant: a second notice about an
 * uncertain one is worse than none. A pre-write deferral is different: nothing was written, so
 * the single trigger must survive it.
 */
export function disarmAfterSendOnce(state, outcome, now = Date.now()) {
  if (!state || state.singleShotTrigger !== true) return { state, disarmed: false };
  if (!outcome || (outcome.sent !== true && outcome.pageWriteAttempted !== true)) {
    return { state, disarmed: false };
  }
  const done = disable(state, 'single_shot_trigger_spent', now);
  return { state: done.state, disarmed: true };
}

export function disable(state, reason, now = Date.now()) {
  const next = normalized(state);
  next.enabled = false;
  next.disabledAt = now;
  next.lastError = reason || null;
  return { state: next, result: { ok: true, enabled: false } };
}

/** The pending deferral for one candidate, or null. */
export function deferralOf(state, candidate) {
  const map = state && state.deferred;
  if (!map || typeof map !== 'object' || !candidate) return null;
  return map[key(candidate.runId, candidate.status)] || null;
}

/** Push a deferral's re-check time back, bounded by `DEFER_MAX_MS`. */
export function nextRetryAt(attempts, now) {
  const n = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 0;
  // Guard the exponent: 2**n overflows to Infinity long before n is large, and an
  // infinite retryAt would defer the candidate for ever.
  const factor = Math.pow(2, Math.min(n, 8));
  const wait = Math.min(DEFER_MAX_MS, DEFER_BASE_MS * factor);
  return now + wait;
}

/**
 * Should this completion be offered to the send path?
 *
 * Refusals are cheap and named. `admit: true` means "no reason to hold it",
 * not "it will be sent" -- the target checks still run afterwards.
 */
export function admit(state, candidate, now = Date.now()) {
  const s = normalized(state);
  if (s.enabled !== true) return { admit: false, code: 'trigger_disabled' };
  // T142: an attempt already on record means a write may be in flight, or was
  // interrupted. Admitting a second candidate here is how one arm writes twice, so this
  // refuses everything until `settle()` or a restart reconcile clears the barrier.
  if (s.pendingAttempt && typeof s.pendingAttempt === 'object') {
    return { admit: false, code: 'attempt_in_flight',
      pending: s.pendingAttempt.key || null,
      since: Number.isFinite(s.pendingAttempt.at) ? s.pendingAttempt.at : null };
  }
  // T123: a restricted trigger has a window. Past it the arm is dead, and dead means refused,
  // not "renewed because a candidate happened to arrive".
  if (s.singleShotTrigger === true && Number.isFinite(s.expiresAt) && now >= s.expiresAt) {
    return { admit: false, code: 'trigger_expired', expiresAt: s.expiresAt };
  }
  // T122: the per-arm cap, checked before anything about the candidate so a spent one-shot
  // cannot be revived by a candidate that would otherwise be admissible.
  if (Number.isSafeInteger(s.maxTriggers) && s.maxTriggers > 0 &&
      Number.isFinite(s.triggers) && s.triggers >= s.maxTriggers) {
    return { admit: false, code: 'trigger_limit_reached',
      triggers: s.triggers, maxTriggers: s.maxTriggers };
  }
  // A field we could not trust means we cannot prove dedup, pacing or the window.
  // Refusing to send is recoverable; a duplicate write is not. Only an explicit
  // re-arm clears this, and that is a human decision.
  if (Array.isArray(s.schemaSuspect) && s.schemaSuspect.length > 0) {
    return { admit: false, code: 'state_schema_suspect',
      fields: s.schemaSuspect.slice() };
  }
  if (!candidate || typeof candidate !== 'object') {
    return { admit: false, code: 'candidate_invalid' };
  }
  const runId = candidate.runId;
  const status = candidate.status;
  if (typeof runId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    return { admit: false, code: 'run_id_invalid' };
  }
  if (!ALLOWED_STATUS.includes(status)) {
    return { admit: false, code: 'status_not_terminal' };
  }
  const seen = s.seen[key(runId, status)];
  if (seen) {
    return { admit: false, code: 'duplicate_event',
      previous: seen.state, key: key(runId, status) };
  }
  // Same task, different status. The journal key is `runId|status` so that a
  // retry of the *same* completion is distinguishable from a new one, but that
  // alone would let one task write twice to the page if the ledger ever showed
  // it as completed and then as failed. The notice is a wake-up call about a
  // task, not a status feed: one write per task, full stop.
  for (const item of Object.values(s.seen)) {
    if (item && item.runId === runId) {
      return { admit: false, code: 'duplicate_run',
        previous: item.state, status: item.status };
    }
  }
  // T067: the channel gate. Placed after the identity checks (a duplicate or a
  // bad run id is a fact about the candidate, whatever channel it came from) and
  // before pacing, so a candidate the operator never opted in to cannot consume a
  // pacing slot or a quota unit.
  //
  // This is one gate for both channels on purpose. Two gates -- one per channel --
  // is how the same run gets written twice when the two disagree; here there is
  // one `seen` journal and one answer, so a run can only ever be admitted once.
  const origin = ORIGINS.includes(candidate.origin)
    ? candidate.origin : ORIGIN_UNKNOWN;
  if (origin !== ORIGIN_BRIDGE) {
    // Two ways to hold the operator's consent, and they are not interchangeable:
    //
    //   runningArmedAt  recorded *before* the task ended, keyed on (session, turn).
    //                   No short TTL: the whole reason it exists is that the task may
    //                   run for hours after the click. Its bounds are the opt-in's own
    //                   age cap and the "before the end" rule, both enforced where the
    //                   entry is read (`optInUsable`), which is also where the
    //                   annotated value came from.
    //   directArmedAt   a click on a candidate that had already ended (T067). This one
    //                   keeps its 30-minute TTL, because a list entry is a snapshot of
    //                   what finished recently and an hour-old click on it really has
    //                   gone stale.
    const runningArmedAt = candidate.runningArmedAt;
    const directArmedAt = candidate.directArmedAt;
    const hasRunning = Number.isFinite(runningArmedAt) && runningArmedAt > 0;
    const hasDirect = Number.isFinite(directArmedAt) && directArmedAt > 0;
    if (!hasRunning && !hasDirect) {
      // T069: an opt-in that exists but could not be proved (its run's terminal
      // instant is unknown, or the click came after the end) is a different fact from
      // "nobody ever asked". Reporting both as `direct_not_opted_in` sends the
      // operator looking for a click they already made, so the real reason travels
      // with the candidate and is returned here instead.
      const refused = candidate.optInRefusal;
      if (typeof refused === 'string' && refused) {
        return { admit: false, code: refused, origin };
      }
      return { admit: false,
        code: origin === ORIGIN_DIRECT ? 'direct_not_opted_in' : 'origin_unproven',
        origin };
    }
    if (!hasRunning && now - directArmedAt > DIRECT_OPTIN_TTL_MS) {
      return { admit: false, code: 'direct_optin_expired', origin,
        armedAt: directArmedAt };
    }
  }
  // A deferred candidate is waiting for its re-check. Answering `admit: false`
  // here is what makes the backoff real: the alarm may tick every 30 seconds, but
  // the page probe is not repeated until this moment has passed.
  const waiting = deferralOf(s, candidate);  if (waiting && Number.isFinite(waiting.retryAt) && now < waiting.retryAt) {
    return { admit: false, code: 'deferred_backoff',
      reason: waiting.reason || null, retryAt: waiting.retryAt,
      waitMs: waiting.retryAt - now };
  }
  if (Number.isFinite(s.lastSentAt) && now - s.lastSentAt < s.minIntervalMs) {
    return { admit: false, code: 'rate_limited',
      waitMs: s.minIntervalMs - (now - s.lastSentAt) };
  }
  const windowStart = Number.isFinite(s.windowStartedAt) ? s.windowStartedAt : now;
  const inWindow = now - windowStart < WINDOW_MS;
  const count = inWindow ? s.windowCount : 0;
  if (count >= s.maxPerHour) {
    return { admit: false, code: 'rate_window_exceeded', maxPerHour: s.maxPerHour };
  }
  return { admit: true, code: null, key: key(runId, status) };
}

// Write-ahead. Must be persisted before the page is touched, exactly like the
// autosend journal: a restart cannot tell "never started" from "half done".
export function markAttempt(state, candidate, now = Date.now()) {
  const next = normalized(state);
  const k = key(candidate.runId, candidate.status);
  next.seen[k] = {
    runId: String(candidate.runId),
    status: String(candidate.status),
    state: 'attempting',
    attemptedAt: now,
    settledAt: null,
    reason: null,
    // T067: which channel authorised this attempt. Recorded so the journal can
    // answer "was this sent because ChatGPT asked, or because a person clicked"
    // long after the candidate itself has been consumed.
    origin: ORIGINS.includes(candidate.origin) ? candidate.origin : ORIGIN_UNKNOWN,
    // T068: which of the two consents authorised it. The T067 record could only say
    // "a person clicked"; now a notice can be traced to either a click on a finished
    // task or a decision made while it was still running, and the two are different
    // facts about the operator's intent.
    consent: Number.isFinite(candidate.runningArmedAt) && candidate.runningArmedAt > 0
      ? 'running_opt_in'
      : (Number.isFinite(candidate.directArmedAt) ? 'candidate_opt_in' : 'none'),
    provenance: 'unverified_candidate',
  };
  // T142: the attempt is a *write barrier*, not a spend. It must be persisted before the
  // page is touched -- a restart cannot tell "never started" from "half done" -- but the
  // quota belongs to the outcome: a refusal that provably never reached the page (the tab
  // lost focus, a draft was in the composer) must not cost a one-shot its only chance.
  // T122 spent it here, and a live install lost its one shot to a single focus blip.
  next.pendingAttempt = { key: k, runId: String(candidate.runId),
    status: String(candidate.status), at: now };
  return { state: next, key: k };
}

// T142: the quota is spent by an outcome that reached (or may have reached) the page.
function spendShot(state) {
  state.triggers = (Number.isSafeInteger(state.triggers) ? state.triggers : 0) + 1;
}

// The barrier is only cleared by the settle/reconcile of the very attempt that set it.
function clearPendingAttempt(state, k) {
  if (!state.pendingAttempt) return;
  if (k && state.pendingAttempt.key !== k) return;
  delete state.pendingAttempt;
}

/**
 * T142: what a one-shot has left, in the shape the popup renders.
 *
 * `remaining` is null for a standing arm: it has no total to run out of, and showing a
 * number there would invent a limit the operator never granted.
 */
export function singleShotRemaining(state) {
  const s = normalized(state);
  const capped = Number.isSafeInteger(s.maxTriggers) && s.maxTriggers > 0;
  const triggers = Number.isSafeInteger(s.triggers) ? s.triggers : 0;
  return {
    capped,
    enabled: s.enabled === true,
    triggers,
    maxTriggers: capped ? s.maxTriggers : null,
    remaining: capped ? Math.max(0, s.maxTriggers - triggers) : null,
    pendingAttempt: s.pendingAttempt || null,
  };
}

/**
 * T142: which single completion a restricted arm releases.
 *
 * T122 refused the whole set as soon as two candidates were eligible. On a live install
 * with a backlog that is not a safety property but a deadlock: 43 completions queued, 0
 * writes, and every 30s tick answering `single_shot_multiple_candidates` until the window
 * expired. What the arm actually promises is "the next terminal message", and the next one
 * is well defined: the earliest completion that started after the arm was taken.
 *
 * The choice is therefore a rule, not a guess:
 *
 *   * eligibility is unchanged -- terminal status, not in the journal, and a proven
 *     post-arm start (`completionAfterArm`), so pre-arm and historical entries can never
 *     be selected;
 *   * ordering uses `endedAtMs` when the host proved it, else the (already proven) start
 *     instant. It never uses the wall clock, a file mtime, or a reading order;
 *   * a candidate waiting out its deferral backoff is skipped, so one unreachable page
 *     state cannot pin the arm to the same entry forever;
 *   * two candidates whose ordering key is equal are refused, not tie-broken: an arm that
 *     cannot say which task it is about must not pick one.
 *
 * Returns `{ok, count, runIds, chosen, waiting}`. `chosen` is null for a standing arm (the
 * caller keeps its old behaviour) and for "nothing sendable right now".
 */
export function guardSingleCandidate(state, candidates, now = Date.now()) {
  const s = normalized(state);
  const capped = Number.isSafeInteger(s.maxTriggers) && s.maxTriggers > 0;
  const list = Array.isArray(candidates) ? candidates : [];
  const eligible = [];
  for (const candidate of list) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (!ALLOWED_STATUS.includes(candidate.status)) continue;
    if (s.seen[key(candidate.runId, candidate.status)]) continue;
    if (!completionAfterArm(s, candidate).proven) continue;
    const order = Number.isFinite(candidate.endedAtMs) ? candidate.endedAtMs
      : Math.floor(candidate.startedAt) * 1000;
    const waiting = deferralOf(s, candidate);
    const inBackoff = Boolean(waiting) && Number.isFinite(waiting.retryAt)
      && now < waiting.retryAt;
    eligible.push({ runId: String(candidate.runId),
      order: Number.isFinite(order) ? order : null, inBackoff });
  }
  const runIds = eligible.map((entry) => entry.runId);
  if (!capped) return { ok: true, count: eligible.length, runIds, chosen: null };
  const sendable = eligible.filter((entry) => entry.inBackoff !== true
    && entry.order !== null);
  const waiting = eligible.filter((entry) => entry.inBackoff === true).length;
  if (sendable.length === 0) {
    return { ok: true, count: eligible.length, runIds, chosen: null, waiting };
  }
  const earliest = Math.min(...sendable.map((entry) => entry.order));
  const winners = sendable.filter((entry) => entry.order === earliest);
  if (winners.length > 1) {
    return { ok: false, code: 'single_shot_multiple_candidates',
      count: eligible.length, runIds: winners.map((entry) => entry.runId) };
  }
  return { ok: true, count: eligible.length, runIds, chosen: winners[0].runId };
}

/**
 * T067: record an operator's per-task opt-in for a *direct* run.
 *
 * Pure: takes the candidate list, returns the new list. The flag lives on the
 * candidate entry rather than in a parallel store, so "may this be sent" and
 * "which run is this" cannot drift apart, an evicted candidate takes its opt-in
 * with it, and the channel gate in `admit` reads one object instead of two.
 *
 * A bridge candidate is refused rather than silently armed: arming it would mean
 * the click did nothing, and the operator would believe they had changed
 * something. A run that is already in the journal is refused too -- it was
 * settled, and arming it would only make the popup show a dead entry.
 */
export function armDirect(candidates, runId, status, state = null,
  now = Date.now()) {
  const list = Array.isArray(candidates) ? candidates : [];
  const k = key(runId, status);
  const index = list.findIndex((item) => item && key(item.runId, item.status) === k);
  if (index < 0) return { ok: false, code: 'candidate_not_found', list };
  const target = list[index];
  if (target.origin === ORIGIN_BRIDGE) {
    return { ok: false, code: 'bridge_runs_need_no_opt_in', list };
  }
  // An entry stored before T067 has no `origin`. It is not a bridge run we can
  // prove, so it is treated as `unknown`: a human may arm it by hand, and nothing
  // sends it on its own.
  const origin = target.origin === ORIGIN_DIRECT ? ORIGIN_DIRECT : ORIGIN_UNKNOWN;
  const seen = state && state.seen && typeof state.seen === 'object'
    ? state.seen : {};
  if (seen[k]) return { ok: false, code: 'already_settled', list };
  const next = list.slice();
  next[index] = Object.assign({}, target, { directArmedAt: now });
  return { ok: true, code: null, list: next, armedAt: now, origin,
    runId: target.runId, status: target.status };
}

// ---------------------------------------------------------------- T068 running opt-ins
//
// A durable answer to "did the operator ask for a notice about this task, before it
// finished". It lives outside the candidate list on purpose: a running task has no
// candidate yet (there is nothing terminal to hand out), and a task that runs for
// hours must not depend on a list entry that a capacity bound could evict.

export function optInKey(sessionId, turn) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (!Number.isInteger(turn) || turn < 0) return null;
  return sessionId + '|' + turn;
}

export function createOptInState() {
  return { version: OPTIN_VERSION, entries: {} };
}

/**
 * Repair whatever was on disk into a state this release can read.
 *
 * Conservative in the same direction as `normalizeTriggerState`: an entry that cannot
 * be parsed is dropped (it cannot authorise anything without a session and a turn), a
 * timestamp in the future is dropped rather than clamped, and the store is trimmed to
 * `MAX_OPTINS` oldest-last. Dropping is reported, never silent -- an opt-in that
 * disappears without a word is exactly the failure the operator would blame on the
 * product.
 */
export function normalizeOptIns(doc, now = Date.now()) {
  const dropped = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || doc.version !== OPTIN_VERSION || !doc.entries
      || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) {
    if (doc !== null && doc !== undefined) dropped.push('store_unreadable');
    return { state: createOptInState(), dropped };
  }
  const entries = {};
  for (const [key, raw] of Object.entries(doc.entries)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      dropped.push(key + ':not_an_object');
      continue;
    }
    const k = optInKey(raw.sessionId, raw.turn);
    if (k === null || k !== key) {
      dropped.push(key + ':identity_mismatch');
      continue;
    }
    if (!Number.isFinite(raw.armedAt) || raw.armedAt <= 0) {
      dropped.push(key + ':no_armed_at');
      continue;
    }
    if (raw.armedAt > now + OPTIN_FUTURE_SLACK_MS) {
      dropped.push(key + ':armed_in_the_future');
      continue;
    }
    entries[key] = {
      sessionId: raw.sessionId,
      turn: raw.turn,
      armedAt: raw.armedAt,
      consumedAt: Number.isFinite(raw.consumedAt) ? raw.consumedAt : null,
      settledAs: typeof raw.settledAs === 'string' ? raw.settledAs : null,
      source: raw.source === 'popup' ? 'popup' : 'unknown',
    };
  }
  const state = { version: OPTIN_VERSION, entries };
  const pruned = pruneOptIns(state, now);
  return { state: pruned.state, dropped: dropped.concat(pruned.dropped) };
}

/**
 * Drop entries that can no longer authorise anything.
 *
 * Two rules, and neither looks at whether the task is still running: an old opt-in is
 * old whether or not DSH still remembers the turn, and the whole point of this store
 * is that a task running for hours keeps its choice. Age and count only.
 */
export function pruneOptIns(state, now = Date.now()) {
  const next = state && state.entries ? state : createOptInState();
  const dropped = [];
  const keep = [];
  for (const [key, entry] of Object.entries(next.entries || {})) {
    if (!entry || !Number.isFinite(entry.armedAt)) {
      dropped.push(key + ':unreadable');
      continue;
    }
    if (now - entry.armedAt > OPTIN_MAX_AGE_MS) {
      dropped.push(key + ':expired');
      continue;
    }
    keep.push([key, entry]);
  }
  // Settled entries are the least valuable: they already did their job and are kept
  // only so the popup can say "this one was sent". They sort to the END, so
  // `slice(0, MAX_OPTINS)` sacrifices them before anything still waiting to fire.
  // The comparator is `aSettled - bSettled` for exactly that reason -- the reverse
  // keeps the spent ones and evicts live consents, which is a silent lost notice.
  keep.sort((a, b) => {
    const aSettled = a[1].consumedAt ? 1 : 0;
    const bSettled = b[1].consumedAt ? 1 : 0;
    if (aSettled !== bSettled) return aSettled - bSettled;
    return b[1].armedAt - a[1].armedAt;
  });
  const trimmed = keep.slice(0, MAX_OPTINS);
  for (const [key] of keep.slice(MAX_OPTINS)) dropped.push(key + ':over_capacity');
  const entries = {};
  for (const [key, entry] of trimmed) entries[key] = entry;
  return { state: { version: OPTIN_VERSION, entries }, dropped };
}

/**
 * The operator's decision, before the task ends.
 *
 * Refuses rather than overwrites: a second click on a task already opted in would
 * either move the `armedAt` forward (narrowing the window in which the notice could
 * still be justified) or silently do nothing while the popup said it worked.
 */
export function armRunning(state, sessionId, turn, now = Date.now()) {
  const current = state && state.entries ? state : createOptInState();
  const key = optInKey(sessionId, turn);
  if (key === null) return { ok: false, code: 'target_invalid', state: current };
  const existing = current.entries[key];
  if (existing && !existing.consumedAt) {
    return { ok: false, code: 'already_opted_in', state: current,
      entry: existing };
  }
  if (existing && existing.consumedAt) {
    return { ok: false, code: 'already_settled', state: current, entry: existing };
  }
  const entry = { sessionId, turn, armedAt: now, consumedAt: null,
    settledAs: null, source: 'popup' };
  const grown = { version: OPTIN_VERSION,
    entries: Object.assign({}, current.entries, { [key]: entry }) };
  const pruned = pruneOptIns(grown, now);
  return { ok: true, code: null, state: pruned.state, entry,
    dropped: pruned.dropped };
}

/** Taking the decision back. Symmetric with `armRunning`, and just as explicit. */
export function revokeRunning(state, sessionId, turn) {
  const current = state && state.entries ? state : createOptInState();
  const key = optInKey(sessionId, turn);
  if (key === null) return { ok: false, code: 'target_invalid', state: current };
  const existing = current.entries[key];
  if (!existing) return { ok: false, code: 'not_opted_in', state: current };
  if (existing.consumedAt) {
    // The notice already happened. Removing the record would erase the only local
    // trace of why, so the refusal is the honest answer.
    return { ok: false, code: 'already_settled', state: current, entry: existing };
  }
  const entries = Object.assign({}, current.entries);
  delete entries[key];
  return { ok: true, code: null,
    state: { version: OPTIN_VERSION, entries }, entry: existing };
}

export function optInFor(state, candidate) {
  if (!state || !state.entries || !candidate) return null;
  const key = optInKey(candidate.nativeSession, candidate.nativeTurn);
  if (key === null) return null;
  return state.entries[key] || null;
}

/**
 * Can this opt-in authorise this candidate -- now?
 *
 * The one rule that makes the whole feature safe: the opt-in must have been recorded
 * strictly before the turn's own terminal instant. That is what separates "I asked to
 * be told when this finished" from "tell me about something that already finished".
 *
 * T069: the comparison is done in *milliseconds*, against `endedAtMs`, and it is
 * strict. Three things follow, and each one was a defect before:
 *
 *   * `endedAt` (seconds, floored) is no longer consulted. The T068 rule compared
 *     against `(endedAt + 1) * 1000` -- the end of the truncated second -- so a task
 *     that finished at 12:00:00.100 and a click made at 12:00:00.900 looked like the
 *     click came first. It did not. A retroactive opt-in was accepted for up to
 *     999 ms after the task was already over.
 *   * `armedAt >= endedAtMs` is refused, so the same millisecond is refused too. There
 *     is no ordering to prove at the same instant, and "probably before" is how the
 *     old rule went wrong.
 *   * an absent `endedAtMs` is refused (`terminal_time_unknown`). A candidate stored
 *     by an older release carries only the floored field, and re-deriving milliseconds
 *     from it is exactly the guess that produced the bug.
 */
export function optInUsable(entry, candidate, now = Date.now()) {
  if (!entry) return { ok: false, code: 'no_opt_in' };
  if (entry.consumedAt) return { ok: false, code: 'already_settled' };
  if (!Number.isFinite(entry.armedAt) || entry.armedAt <= 0) {
    return { ok: false, code: 'opt_in_unreadable' };
  }
  if (entry.armedAt > now + OPTIN_FUTURE_SLACK_MS) {
    return { ok: false, code: 'opt_in_from_the_future' };
  }
  if (now - entry.armedAt > OPTIN_MAX_AGE_MS) {
    return { ok: false, code: 'opt_in_expired' };
  }
  const endedAtMs = candidate && Number.isSafeInteger(candidate.endedAtMs)
    && candidate.endedAtMs > 0 ? candidate.endedAtMs : null;
  if (endedAtMs === null) {
    // Nothing proves the opt-in came first. "Probably before" is how the T068 rule
    // sent a notice for a task the operator had already watched finish.
    return { ok: false, code: 'terminal_time_unknown' };
  }
  if (entry.armedAt >= endedAtMs) {
    return { ok: false, code: 'opt_in_after_terminal',
      armedAt: entry.armedAt, endedAtMs };
  }
  return { ok: true, code: null, armedAt: entry.armedAt, endedAtMs };
}

/**
 * Mark the opt-in as spent, so it cannot authorise anything ever again.
 *
 * Called only when the trigger journal recorded a *conclusive* outcome for that run
 * (`sent`, or `stopped`). A rate-limit refusal is not conclusive: the task still owes
 * a notice, and consuming the opt-in there would turn "wait your turn" into "never".
 */
export function settleOptIn(state, candidate, journalState, now = Date.now()) {
  const current = state && state.entries ? state : createOptInState();
  const key = optInKey(candidate && candidate.nativeSession,
    candidate && candidate.nativeTurn);
  if (key === null) return { state: current, changed: false };
  const entry = current.entries[key];
  if (!entry || entry.consumedAt) return { state: current, changed: false };
  if (!['sent', 'stopped'].includes(journalState)) {
    return { state: current, changed: false };
  }
  const entries = Object.assign({}, current.entries, {
    [key]: Object.assign({}, entry, { consumedAt: now, settledAs: journalState }),
  });
  return { state: { version: OPTIN_VERSION, entries }, changed: true, key };
}

export function settle(state, k, outcome, now = Date.now()) {  const next = normalized(state);
  const item = next.seen[k];
  if (!item || item.state !== 'attempting') {
    return { state, result: { ok: false, code: 'trigger_not_attempting' } };
  }
  // T142: settling a key other than the in-flight one would clear the barrier while the
  // real attempt is still running. Refuse; reconcile handles a genuine leftover.
  if (next.pendingAttempt && next.pendingAttempt.key !== k) {
    return { state, result: { ok: false, code: 'trigger_attempt_mismatch',
      pending: next.pendingAttempt.key, settled: k } };
  }
  if (outcome && outcome.sent === true) {
    item.state = 'sent';
    item.settledAt = now;
    item.reason = null;
    next.lastSentAt = now;
    delete next.deferred[k];
    const windowStart = Number.isFinite(next.windowStartedAt) ? next.windowStartedAt : now;
    if (now - windowStart >= WINDOW_MS) {
      next.windowStartedAt = now;
      next.windowCount = 1;
    } else {
      next.windowCount += 1;
    }
    // T142: this is where a shot is actually spent -- a write that reached the page.
    spendShot(next);
    clearPendingAttempt(next, k);
    return { state: next, result: { ok: true, status: 'sent' } };
  }

  // T076: only the writer can prove the page was never touched. When it says so
  // *and* the refusal is a recognised pre-write code, this was not an attempt at
  // all -- the tab lost focus, a draft was in the composer, the probe was stale.
  // Recording that as a stop disabled the trigger for good, which is the bug this
  // branch exists to remove.
  //
  // The proof test is deliberately strict: `pageWriteAttempted === false` exactly,
  // plus a code in the allowlist. A missing flag, an unknown code, or anything the
  // writer did not classify all fall through to the stop path below, because in
  // those cases a write cannot be ruled out.
  if (outcome && outcome.pageWriteAttempted === false
      && typeof outcome.code === 'string') {
    const kind = classifyRefusal(outcome.code);
    if (kind === 'deferred') {
      const previous = next.deferred[k];
      const attempts = (previous && Number.isSafeInteger(previous.attempts)
        ? previous.attempts : 0) + 1;
      // T079: a deferral that keeps repeating is not a transient page state, it is
      // a page we do not recognise. Escalate to a block so the operator sees a
      // stop instead of a silent "waiting" that never ends.
      if (ESCALATING_DEFERRALS.includes(outcome.code)
          && attempts > MAX_DEFERRAL_ATTEMPTS) {
        delete next.seen[k];
        item.state = 'blocked';
        item.settledAt = now;
        item.reason = outcome.code;
        next.seen[k] = item;
        delete next.deferred[k];
        next.enabled = false;
        next.lastError = 'blocked:' + outcome.code + '_after_'
          + MAX_DEFERRAL_ATTEMPTS + '_deferrals';
        return { state: next, result: { ok: false, code: 'blocked',
          reason: outcome.code, attempts } };
      }
      // `seen` must not keep the entry: `admit` treats any `seen` hit as a
      // duplicate, and this run has not been delivered yet.
      delete next.seen[k];
      next.deferred[k] = {
        runId: item.runId, status: item.status, reason: outcome.code,
        // T048: the cause behind the code, when the writer knew one. A deferral
        // nobody can explain is a deferral nobody can fix, so "the tab was
        // discarded" is recorded rather than shown as a bare status.
        detail: (outcome && (outcome.detail || outcome.cause)) || null,
        attempts, retryAt: nextRetryAt(attempts, now), lastRefusedAt: now,
      };
      const keys = Object.keys(next.deferred);
      if (keys.length > MAX_DEFERRED) {
        keys.sort((a, b) => (next.deferred[a].lastRefusedAt || 0)
          - (next.deferred[b].lastRefusedAt || 0));
        for (const stale of keys.slice(0, keys.length - MAX_DEFERRED)) {
          delete next.deferred[stale];
        }
      }
      // T142: the line below was true about everything except the quota, which
      // `markAttempt` had already spent. Clearing the barrier here is what makes "no
      // quota consumed" a fact instead of an intention.
      clearPendingAttempt(next, k);
      // No quota consumed, no `lastSentAt` touched, `enabled` untouched.
      return { state: next, result: { ok: true, status: 'deferred',
        reason: outcome.code, detail: next.deferred[k].detail,
        retryAt: next.deferred[k].retryAt, attempts } };
    }
    if (kind === 'blocked') {
      // Nothing was written, but waiting will not fix this: a human has to. The
      // entry stays terminal so this run can never be offered again.
      item.state = 'blocked';
      item.settledAt = now;
      item.reason = outcome.code;
      // A finished run must not keep a "waiting for a re-check" row. `seen[k]` is
      // now terminal, so no re-check can ever happen; leaving the deferral behind
      // would show the operator a queue entry that is dead, and would hold a slot
      // in the bounded `deferred` map that a genuinely waiting run needs.
      delete next.deferred[k];
      spendShot(next);
      clearPendingAttempt(next, k);
      next.enabled = false;
      next.lastError = 'blocked:' + outcome.code;
      return { state: next, result: { ok: false, code: 'blocked',
        reason: outcome.code } };
    }
  }

  // T142: an outcome that is not a proven pre-write refusal may have written. Spend the
  // shot before disabling, so the popup cannot show "1 remaining" on a dead arm.
  spendShot(next);
  clearPendingAttempt(next, k);
  item.state = 'stopped';
  item.settledAt = now;
  item.reason = (outcome && (outcome.reason || outcome.code)) || 'send_not_confirmed';
  // Same reason as the `blocked` branch: this run is finished, so the deferral row
  // it may have carried from an earlier refusal is now a claim about a re-check
  // that cannot happen. Only the sent path used to clear it, which is how a live
  // install ended up showing four "waiting" rows for runs that had already stopped.
  delete next.deferred[k];
  // Any doubt stops the whole trigger. A later notice must be re-armed by hand.
  next.enabled = false;
  next.lastError = 'stopped:' + item.reason;
  return { state: next, result: { ok: false, code: 'stopped',
    reason: item.reason } };
}

// A restart cannot know whether the offer reached the page.
export function reconcileAfterRestart(state, now = Date.now()) {
  const next = normalized(state);
  let changed = false;
  for (const [key, item] of Object.entries(next.seen)) {
    if (item.state === 'attempting') {
      item.state = 'stopped';
      item.reason = 'worker_restarted_during_attempt; do not retry blindly';
      item.settledAt = now;
      // Same leak as `settle()`: this run is finished now, so a deferral left over
      // from an earlier refusal is a claim about a re-check that will never come.
      delete next.deferred[key];
      // T142: the write may have landed, so the shot goes with it -- the same verdict
      // `settle()` reaches for an uncertain outcome, and the reason T122 counted it at
      // `markAttempt` in the first place. Now it is counted here, where it belongs.
      spendShot(next);
      clearPendingAttempt(next, key);
      changed = true;
    }
  }
  if (next.pendingAttempt && typeof next.pendingAttempt === 'object') {
    delete next.pendingAttempt;
    changed = true;
  }
  if (changed && next.enabled) {
    next.enabled = false;
    next.lastError = 'stopped:worker_restarted_during_attempt';
  }
  // T137: a restricted arm has a window, and this is the one path where it can outlive it.
  // `admit()` refuses an expired arm, but nothing calls `admit()` while the store sits untouched,
  // so the record came back `enabled: true`: the popup described a live arm that could never
  // fire, and `syncTerminalAlarm()` kept the hourly alarm scheduled because it only clears an
  // alarm for `enabled !== true`. The grant store already expires itself here
  // (`authorization_expired`); the two must reach the same verdict at the same instant, or the UI
  // ends up describing two different truths.
  //
  // Deliberate: when the journal repair above already disabled the arm, it keeps its reason. An
  // attempt that may have written is the sharper fact, and one field cannot say both.
  if (next.enabled === true && next.singleShotTrigger === true
      && Number.isFinite(next.expiresAt) && now >= next.expiresAt) {
    next.enabled = false;
    next.lastError = 'single_shot_trigger_expired';
    next.disabledAt = now;
    changed = true;
  }
  return { state: next, changed };
}
