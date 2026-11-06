// T095B151: durable bookkeeping for *independent backend continuation*.
//
// Scope, stated before the code: this module decides only "may this completed task be handed to the
// fixed DSH session once, and what happens if that hand-off is interrupted". It never touches a tab,
// a window, a document or a page: an independent backend continuation is exactly the case where no
// page is involved, and putting page state in this record would make the two impossible to tell
// apart later.
//
// The invariants, and how each one is enforced:
//
//   at most one accepted handoff per completion (known nonacceptance retries are bounded)
//     the key is `runId|status|epoch`; `admit` refuses an existing key (`duplicate_event`), and
//     `lease` is a write-ahead record: the attempt is persisted *before* the hand-off, so a second
//     lease while one is live is refused (`lease_held`).
//
//   a crash is never a retry
//     `recover` turns a lease past its deadline into `escalated` / `unknown_outcome`. Retrying there
//     would be guessing whether the hand-off happened; the honest answer is "a human decides".
//
//   no authorisation, no dispatch
//     `admit` requires a current grant bound to the same session and the same arm epoch, with
//     `armedAt` before now and `expiresAt` after it. Anything else is `not_authorised` and leaves
//     no record at all -- a refused event must not consume a queue slot.
//
//   an outage delays, it does not lose
//     with `bridgeUp: false` the event is refused with `bridge_unavailable` and nothing is stored;
//     when the Bridge is back the same completion is admitted normally.
//
//   failure retries a bounded number of times, then escalates
//     `complete(..., {outcome: 'failed', attempt})` means verified nonacceptance and schedules
//     `nextRetryAt` with exponential backoff; after
//     `MAX_ATTEMPTS` the job becomes `escalated` and stays on record with its last error.
//
// Persistence is the caller-owned snapshot/restore JSON boundary. This module writes no disk;
// callers must preserve the latest bytes atomically before any real handoff, with one state owner.

export const MAX_ATTEMPTS = 3;
export const BASE_BACKOFF_MS = 30 * 1000;
export const MAX_BACKOFF_MS = 15 * 60 * 1000;
export const TERMINAL_STATUSES = ['completed', 'failed', 'stopped', 'cancelled'];
export const AUTH_MODES = ['standing', 'once'];

export function key(event) {
  return String(event.runId) + '|' + String(event.status) + '|' + String(event.epoch);
}

export function createStore(seed = {}) {
  return { version: 1, jobs: {}, epoch: seed.epoch || null };
}

export function snapshot(store) {
  return JSON.stringify(store);
}

export function restore(json) {
  const raw = json && typeof json === 'object' ? json : {};
  const jobs = {};
  for (const [k, job] of Object.entries(raw.jobs || {})) {
    if (job && typeof job === 'object' && typeof job.runId === 'string') jobs[k] = { ...job };
  }
  return { version: 1, jobs, epoch: typeof raw.epoch === 'string' ? raw.epoch : null };
}

function clone(store) {
  const jobs = {};
  for (const [k, job] of Object.entries(store.jobs)) jobs[k] = { ...job, history: [...job.history] };
  return { version: 1, jobs, epoch: store.epoch };
}

function authorisationUsable(grant, event, now) {
  if (!grant || typeof grant !== 'object') return false;
  if (!AUTH_MODES.includes(grant.mode)) return false;
  if (typeof grant.epoch !== 'string' || grant.epoch !== event.epoch) return false;
  if (typeof grant.sessionId !== 'string' || grant.sessionId !== event.sessionId) return false;
  if (!Number.isFinite(grant.armedAt) || grant.armedAt >= now) return false;
  if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) return false;
  return true;
}

export function admit(store, event) {
  const s = clone(store);
  const now = event && Number.isFinite(event.now) ? event.now : Date.now();
  if (!event || !TERMINAL_STATUSES.includes(event.status)) {
    return { store: s, code: 'status_not_terminal' };
  }
  if (event.bridgeUp !== true) {
    // The completion cannot be trusted while the source that reported it is unreachable.
    return { store: s, code: 'bridge_unavailable' };
  }
  if (!authorisationUsable(event.authorisation, event, now)) {
    return { store: s, code: 'not_authorised' };
  }
  const k = key(event);
  if (s.jobs[k]) return { store: s, code: 'duplicate_event' };
  s.jobs[k] = {
    key: k,
    runId: event.runId,
    status: event.status,
    epoch: event.epoch,
    sessionId: event.sessionId,
    requestedAt: now,
    state: 'queued',
    attempts: 0,
    leaseUntil: null,
    nextRetryAt: null,
    lastError: null,
    history: [{ at: now, what: 'admitted' }],
  };
  return { store: s, code: null, key: k };
}

function unresolved(job, at) {
  job.state = 'escalated';
  job.lastError = 'unknown_outcome';
  job.leaseUntil = null;
  job.nextRetryAt = null;
  job.history.push({ at, what: 'escalated', code: 'unknown_outcome' });
}

export function lease(store, jobKey, now, ttlMs = 60 * 1000) {
  const s = clone(store);
  const job = s.jobs[jobKey];
  if (!job) return { store: s, code: 'unknown_job' };
  if (job.state === 'acked') return { store: s, code: 'already_acked' };
  if (job.state === 'escalated' || job.state === 'abandoned') {
    return { store: s, code: 'not_dispatchable', state: job.state };
  }
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now + ttlMs)) {
    return { store: s, code: 'invalid_lease' };
  }
  if (job.state === 'leased') {
    if (Number.isFinite(job.leaseUntil) && now < job.leaseUntil) return { store: s, code: 'lease_held' };
    unresolved(job, now);
    return { store: s, code: 'unknown_outcome' };
  }
  if (!['queued', 'failed'].includes(job.state) || !Number.isSafeInteger(job.attempts)
    || job.attempts < 0 || job.attempts >= MAX_ATTEMPTS) return { store: s, code: 'not_dispatchable' };
  if (job.state === 'failed' || job.attempts > 0) {
    if (!Number.isFinite(job.nextRetryAt)) return { store: s, code: 'retry_time_unverified' };
    if (now < job.nextRetryAt) return { store: s, code: 'retry_not_due', nextRetryAt: job.nextRetryAt };
  }
  job.state = 'leased';
  job.attempts += 1;
  job.leaseUntil = now + ttlMs;
  job.nextRetryAt = null;
  job.history.push({ at: now, what: 'leased', attempt: job.attempts });
  return { store: s, code: null, key: jobKey, attempt: job.attempts };
}

export function complete(store, jobKey, outcome) {
  const s = clone(store);
  const job = s.jobs[jobKey];
  const at = outcome?.at;
  if (!job) return { store: s, code: 'unknown_job' };
  if (job.state === 'acked') return { store: s, code: 'already_acked' };
  if (['escalated', 'abandoned'].includes(job.state)) return { store: s, code: 'not_dispatchable' };
  if (job.state !== 'leased') return { store: s, code: 'not_leased' };
  if (!Number.isSafeInteger(outcome?.attempt) || outcome.attempt < 1) return { store: s, code: 'attempt_unverified' };
  if (outcome.attempt !== job.attempts) return { store: s, code: 'attempt_mismatch' };
  if (!Number.isFinite(at)) return { store: s, code: 'outcome_time_unverified' };
  if (!['acked', 'failed'].includes(outcome.outcome)) {
    unresolved(job, at);
    return { store: s, code: 'unknown_outcome' };
  }
  if (outcome.outcome === 'acked') {
    job.state = 'acked';
    job.leaseUntil = null;
    job.lastError = null;
    job.history.push({ at, what: 'acked' });
    return { store: s, code: null };
  }
  job.leaseUntil = null;
  job.lastError = (outcome && outcome.code) || 'failed';
  job.history.push({ at, what: 'failed', code: job.lastError });
  if (job.attempts >= MAX_ATTEMPTS) {
    job.state = 'escalated';
    job.nextRetryAt = null;
    return { store: s, code: 'escalated' };
  }
  job.state = 'failed';
  const backoff = Math.min(MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * (2 ** Math.max(0, job.attempts - 1)));
  job.nextRetryAt = at + backoff;
  return { store: s, code: 'retry_scheduled' };
}

export function recover(store, now) {
  const s = clone(store);
  const escalated = [];
  for (const [k, job] of Object.entries(s.jobs)) {
    if (job.state === 'leased' && Number.isFinite(job.leaseUntil) && job.leaseUntil <= now) {
      // A hand-off whose outcome nobody recorded. Retrying would guess; escalate instead.
      unresolved(job, now);
      escalated.push(k);
      continue;
    }
    if (job.state === 'failed' && Number.isFinite(job.nextRetryAt) && job.nextRetryAt <= now) {
      job.state = 'queued';
      job.history.push({ at: now, what: 'requeued' });
    }
  }
  return { store: s, escalated };
}

/**
 * Which jobs may be handed off right now. `context` is accepted for symmetry with callers that know
 * about the page state -- and deliberately not read: an independent continuation must not become
 * conditional on a tab, and a test asserts that flipping `pageState` changes nothing.
 */
export function dispatchable(store, now, context = {}) {
  void context;
  const out = [];
  for (const [k, job] of Object.entries(store.jobs)) {
    if (job.state === 'queued') out.push(k);
    else if (job.state === 'failed' && Number.isFinite(job.nextRetryAt) && job.nextRetryAt <= now) {
      out.push(k);
    }
  }
  return out.sort();
}

export function summary(store) {
  const counts = { queued: 0, leased: 0, acked: 0, failed: 0, escalated: 0, abandoned: 0 };
  let dispatched = 0;
  for (const job of Object.values(store.jobs)) {
    counts[job.state] = (counts[job.state] || 0) + 1;
    dispatched += job.attempts;
  }
  return { total: Object.keys(store.jobs).length, dispatched, ...counts };
}
