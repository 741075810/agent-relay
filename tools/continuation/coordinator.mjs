// T095B152/T262: offline, default-disabled, at most one accepted handoff per completion.
//
// What it does, in one paragraph: it reads completed tasks from the durable mirror
// (`eventsource.mjs`), claims one at a time against a *continuation* grant, picks the next
// pre-approved task whose scope that grant covers, hands it to the fixed DSH session through a
// transport adapter, and records the outcome. Every step is persisted, so a restart resumes instead
// of repeating, and a hand-off whose reply never arrived becomes `unknown_outcome` instead of a
// second attempt.
//
// What it refuses, by design:
//   * running at all until `enable()` is given a grant whose `kind` is `'continuation'`. The page
//     notice grants (T058/T059) authorise writing a message into a conversation; they say nothing
//     about running work in a session, and passing one is `wrong_authorisation_kind`;
//   * claiming work when the event window came back truncated (`event_gap`) -- the mirror cannot
//     prove coverage there, and skipping is how work disappears;
//   * any task outside `grant.scopes` (`no_approved_task`), and any grant past `expiresAt`
//     (`grant_expired`, which also disables the coordinator);
//   * dispatching while the transport is down (`bridge_unavailable`) -- nothing is claimed, so the
//     event is still there when it returns.
//
// The session is fixed: it comes from the grant, is checked against the configured one, and is
// copied into every request. There is no code path here that creates a session.
//
// Limits are enforced twice, because they mean different things: `config.maxTasksPerRun` is this
// process's own stop condition, `grant.maxTasks` is what the operator authorised. Reaching either
// disables the coordinator (`disabled`) rather than silently continuing.

import { createHash } from 'node:crypto';
import {
  MAX_ATTEMPTS,
  admit,
  complete,
  createStore,
  dispatchable,
  lease,
  recover as recoverStore,
  restore as restoreStore,
  snapshot,
  summary,
} from './continuation_state.mjs';
import { appendEvent, ingestList, createMirror } from './eventsource.mjs';

export const DEFAULT_CONFIG = {
  enabled: false,
  leaseMs: 60 * 1000,
  maxTasksPerRun: 8,
  requireSession: true,
};

function defaultAuthorisation(grant, event) {
  // The state machine knows one shape of authorisation; the continuation grant has to be translated
  // rather than passed through, so a notice grant cannot be smuggled in by shape coincidence.
  return {
    mode: 'standing',
    epoch: grant.epoch,
    armedAt: grant.armedAt,
    expiresAt: grant.expiresAt,
    sessionId: grant.sessionId,
  };
}

function grantProblem(grant, sessionId, now) {
  if (!grant || typeof grant !== 'object') return 'not_authorised';
  if (grant.kind !== 'continuation') return 'wrong_authorisation_kind';
  if (typeof grant.sessionId !== 'string' || !grant.sessionId) return 'not_authorised';
  if (sessionId && grant.sessionId !== sessionId) return 'session_mismatch';
  if (!Array.isArray(grant.scopes) || grant.scopes.length === 0) return 'not_authorised';
  if (!Number.isSafeInteger(grant.maxTasks) || grant.maxTasks <= 0) return 'not_authorised';
  if (!Number.isFinite(grant.armedAt) || grant.armedAt >= now) return 'not_authorised';
  if (!Number.isFinite(grant.expiresAt)) return 'not_authorised';
  if (grant.expiresAt <= now) return 'grant_expired';
  return null;
}

export function createCoordinator(deps = {}) {
  const config = { ...DEFAULT_CONFIG, ...(deps.config || {}) };
  const sessionId = deps.sessionId || null;
  const bridge = deps.bridge;
  const tasks = Array.isArray(deps.tasks) ? deps.tasks : [];
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const co = {
    config,
    sessionId,
    bridge,
    tasks,
    state: {
      version: 1,
      enabled: config.enabled === true,
      stopped: false,
      stopReason: null,
      grant: null,
      store: createStore(),
      mirror: createMirror(deps.mirror || {}),
      used: [],
      tasksDone: 0,
      admitted: [],
      gap: null,
      lastCode: null,
    },
  };

  function statusOf() {
    const summaryOut = summary(co.state.store);
    const retries = Object.values(co.state.store.jobs)
      .map((job) => job.nextRetryAt).filter((value) => Number.isFinite(value));
    return {
      enabled: co.state.enabled,
      stopped: co.state.stopped,
      sessionId: co.sessionId,
      tasksDone: co.state.tasksDone,
      dispatched: summaryOut.dispatched,
      escalated: summaryOut.escalated,
      queued: summaryOut.queued,
      nextRetryAt: retries.length > 0 ? Math.min(...retries) : null,
      gap: co.state.gap,
      grant: co.state.grant ? { kind: co.state.grant.kind, epoch: co.state.grant.epoch,
        expiresAt: co.state.grant.expiresAt, scopes: [...co.state.grant.scopes],
        maxTasks: co.state.grant.maxTasks } : null,
      jobs: co.state.store.jobs,
      mirrorSize: co.state.mirror.events.length,
      lastCode: co.state.lastCode,
    };
  }

  // The latest serialized bytes, not an actual disk transaction. The caller owns atomic storage
  // before any real handoff. This offline owner snapshots the lease/intent before invoking its seam.
  function serialise() {
    return JSON.stringify({
      version: 1,
      sessionId: co.sessionId,
      config: co.config,
      state: co.state,
      store: JSON.parse(snapshot(co.state.store)),
      mirror: co.state.mirror,
    });
  }

  function persist() {
    co.state.persistedAt = now();
    co.persisted = serialise();
    return co.persisted;
  }

  co.status = statusOf;
  co.persist = persist;
  co.checkpoint = () => co.persisted || persist();

  co.enable = async function enable(grant) {
    const problem = grantProblem(grant, co.sessionId, now());
    if (problem === 'grant_expired') {
      co.state.grant = grant;
      co.state.enabled = false;
      co.state.lastCode = 'grant_expired';
      return 'grant_expired';
    }
    if (problem) return problem;
    co.state.grant = grant;
    co.state.enabled = true;
    co.state.stopped = false;
    co.state.stopReason = null;
    co.state.lastCode = null;
    persist();
    return null;
  };

  co.disable = function disable(reason = 'operator') {
    co.state.enabled = false;
    co.state.lastCode = reason;
    persist();
    return reason;
  };

  co.stop = function stopContinuation(reason = 'operator') {
    co.state.stopped = true;
    co.state.enabled = false;
    co.state.stopReason = reason;
    co.state.lastCode = 'stopped';
    persist();
    return reason;
  };

  co.poll = function poll(reply, at = now()) {
    const out = ingestList(co.state.mirror, reply, { epoch: reply && reply.armEpoch,
      sessionId: co.sessionId, at });
    co.state.mirror = out.mirror;
    if (out.gap) {
      co.state.gap = { at, truncated: out.truncated, count: out.count, seen: out.seen };
    } else if (co.state.gap) {
      // A whole window proves the source is readable again. Work resumes; nothing is dispatched to
      // "catch up", because the mirror already holds every event that was ever visible.
      co.state.gap = null;
    }
    persist();
    return { added: out.added, gap: out.gap };
  };

  function admitPending() {
    const grant = co.state.grant;
    for (const event of co.state.mirror.events) {
      const out = admit(co.state.store, {
        runId: event.runId, status: event.status, epoch: event.epoch,
        sessionId: grant ? grant.sessionId : co.sessionId,
        authorisation: grant ? defaultAuthorisation(grant, event) : null,
        now: now(), bridgeUp: true,
      });
      co.state.store = out.store;
      if (out.code === null) co.state.admitted.push(out.key);
    }
  }

  const taskText = (value, bytes) => typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= bytes && !value.includes('\0');
  const taskDigest = task => createHash('sha256').update(JSON.stringify([task.id, task.scope, task.title])).digest('hex');
  function resolveTask(job) {
    const grant = co.state.grant;
    if (job.sessionId !== grant.sessionId || job.epoch !== grant.epoch) return { code: 'task_binding_changed' };
    const reserved = job.attempts > 0 || job.taskId !== undefined || job.taskDigest !== undefined;
    if (reserved && (!taskText(job.taskId, 512) || typeof job.taskDigest !== 'string'
      || !/^[0-9a-f]{64}$/.test(job.taskDigest))) return { code: 'reservation_unverified' };
    const task = reserved ? co.tasks.find(item => item?.id === job.taskId)
      : co.tasks.find(item => item && !co.state.used.includes(item.id) && grant.scopes.includes(item.scope));
    if (!task) return { code: reserved ? 'reserved_task_unavailable' : 'no_approved_task' };
    if (![taskText(task.id, 512), taskText(task.scope, 512), taskText(task.title, 32768)].every(Boolean)) return { code: 'task_invalid' };
    if (co.tasks.filter(item => item?.id === task.id).length !== 1) return { code: 'task_identity_ambiguous' };
    if (!grant.scopes.includes(task.scope) || co.state.used.includes(task.id)) return { code: 'task_binding_changed' };
    const digest = taskDigest(task);
    if (reserved && digest !== job.taskDigest) return { code: 'task_intent_changed' };
    return { code: null, task: { id: task.id, title: task.title }, digest };
  }

  co.step = async function step(at = now()) {
    const state = co.state;
    if (state.stopped) return { code: 'stopped', reason: state.stopReason };
    if (!state.enabled) return { code: 'disabled' };
    if (state.gap) return { code: 'event_gap', gap: state.gap };
    if (!Number.isFinite(at)) return { code: 'clock_unverified' };
    const problem = grantProblem(state.grant, co.sessionId, at);
    if (problem) {
      state.enabled = false;
      state.lastCode = problem;
      return { code: problem };
    }
    if (co.bridge && co.bridge.down === true) {
      return { code: 'bridge_unavailable' };
    }

    admitPending();
    const entries = Object.entries(state.store.jobs);
    const halted = entries.find(([, job]) => job.state === 'escalated');
    if (halted) return { code: halted[1].lastError === 'unknown_outcome' ? 'unknown_outcome' : 'escalated', key: halted[0] };
    const held = entries.find(([, job]) => job.state === 'leased');
    if (held) return { code: 'in_flight', key: held[0] };
    const retry = entries.find(([, job]) => job.state === 'failed' || (job.state === 'queued' && job.attempts > 0));
    if (retry && !Number.isFinite(retry[1].nextRetryAt)) return { code: 'retry_time_unverified', key: retry[0] };
    if (retry && retry[1].nextRetryAt > at) {
      return { code: 'retry_wait', key: retry[0], nextRetryAt: retry[1].nextRetryAt };
    }
    const ready = dispatchable(state.store, at);
    if (ready.length === 0) return { code: 'no_events' };
    const key = retry ? retry[0] : ready[0];
    const chosen = resolveTask(state.store.jobs[key]);
    if (chosen.code) return { code: chosen.code, key };
    const leased = lease(state.store, key, at, co.config.leaseMs);
    state.store = leased.store;
    if (leased.code !== null) { persist(); return { code: leased.code }; }
    const job = state.store.jobs[key];
    job.taskId = chosen.task.id; job.taskDigest = chosen.digest;
    const request = Object.freeze({ sessionId: job.sessionId, taskId: job.taskId,
      title: chosen.task.title, key, epoch: job.epoch, attempt: leased.attempt });

    // Single owner: lease + intent snapshot precedes await. Actual disk durability is caller-owned.
    persist();
    let reply;
    try {
      reply = await co.bridge.request(request);
    } catch {
      state.lastCode = 'in_flight';
      persist();
      return { code: 'in_flight', key, error: 'transport_error' };
    }
    // Only an explicit known-nonacceptance callback may retry. RPC/quota/task failure is not that fact.
    const outcome = reply && !Array.isArray(reply) && typeof reply === 'object' ? reply.outcome : null;
    if (!['ack', 'failed'].includes(outcome)) {
      state.lastCode = 'in_flight';
      persist();
      return { code: 'in_flight', key };
    }
    const recordedAt = now();
    const completionAt = Number.isFinite(recordedAt) ? Math.max(at, recordedAt) : NaN;
    if (outcome === 'ack') {
      const acknowledged = complete(state.store, key, { outcome: 'acked', attempt: request.attempt, at: completionAt });
      state.store = acknowledged.store;
      if (acknowledged.code !== null) {
        state.lastCode = acknowledged.code; persist(); return { code: acknowledged.code, key };
      }
      state.used.push(request.taskId);
      state.tasksDone += 1;
      state.lastCode = null;
      let stoppedBy = null;
      if (state.tasksDone >= co.config.maxTasksPerRun) stoppedBy = 'max_tasks_reached';
      else if (state.tasksDone >= state.grant.maxTasks) stoppedBy = 'grant_max_tasks';
      if (stoppedBy) {
        state.enabled = false;
        state.lastCode = stoppedBy;
      }
      persist();
      return { code: null, dispatch: { key, taskId: request.taskId, sessionId: request.sessionId },
        stoppedBy };
    }

    const failed = complete(state.store, key, { outcome: 'failed', attempt: request.attempt,
      code: reply.code || 'dispatch_failed', at: completionAt });
    state.store = failed.store;
    state.lastCode = failed.code;
    persist();
    return { code: failed.code, key, taskId: request.taskId };
  };

  co.recover = async function recoverAt(at = now()) {
    const out = recoverStore(co.state.store, at);
    co.state.store = out.store;
    if (out.escalated.length > 0) co.state.lastCode = 'escalated';
    persist();
    return { escalated: out.escalated, at };
  };

  if (deps.mirror) co.state.mirror = createMirror(deps.mirror);
  persist();
  return co;
}

export function restore(json, deps = {}) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  const co = createCoordinator({
    ...deps,
    config: (raw && raw.config) || deps.config,
    sessionId: (raw && raw.sessionId) || deps.sessionId,
    now: deps.now,
    mirror: (raw && raw.mirror) || {},
  });
  co.state = {
    ...co.state,
    ...(raw.state || {}),
    store: restoreStore(raw.store || {}),
    mirror: createMirror(raw.mirror || raw.state && raw.state.mirror || {}),
  };
  co.state.enabled = raw.state && raw.state.enabled === true;
  co.persist(); // checkpoint must reflect restored state even without poll/step/enable.
  return co;
}

export { MAX_ATTEMPTS };
