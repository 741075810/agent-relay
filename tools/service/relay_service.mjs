#!/usr/bin/env node
// T197: the AgentRelay service -- a real local process, separate from the MCP server, that owns task state, ordered
// terminal events and a single-session control lease.
//
// Boundaries, deliberately narrow:
//   * binds 127.0.0.1 only, and only the port it was told (0 picks one and reports it);
//   * default off -- it does nothing unless started;
//   * it does not submit to DSH. There is no verified external control API, so a "run" here is a local record marked
//     `simulated: true`, and every response says `dsh: "unavailable"`. It never touches the Bridge, the extension, the
//     host, the page or the production queue.

import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { acquireLock, releaseLock } from './lock.mjs';

export const SERVICE_VERSION = '0.1.0';
export const DSH_UNAVAILABLE = Object.freeze({
  simulated: true,
  dsh: 'unavailable',
  reason: 'external_dsh_control_api_unverified',
  note: 'no DSH task was started; records here are local and simulated',
});
const STATE_FILE = 'relay.json';
const MAX_EVENTS_RETAINED = 5000;
// T200: dedupe must survive trimming the event bodies. The ledger stores id -> seq for far more events than the log
// keeps, so a retry of an already-applied event is still refused after its body is gone. The cap is the guarantee
// horizon and is published on /health, so nobody has to guess where it ends.
const MAX_SEEN_RETAINED = 20000;
// The ledger is finite, so beyond its horizon "this id is new" stops being provable. That case is refused unless the
// caller states `expectNew: true`; internal ids (deterministic per task and attempt) always may pass.

// T199: the legal moves of a task. Anything not listed is refused, so "already finished" and "wrong order" are
// different answers rather than one silent no-op.
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'interrupted']);
const TRANSITIONS = Object.freeze({
  queued: ['running', 'completed', 'failed', 'cancelled', 'interrupted'],
  running: ['completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: ['queued'],
});

function emptyState() {
  return { version: 4, seq: 0, tasks: [], events: [], seen: [], keys: [], lease: null, runs: [] };
}

// T202: a run is what the Native Host reported, not what this service believes. Only these two states exist, and the
// host source must be named, so a record can be traced back to the artifact it came from.
const HOST_RUN_STATES = Object.freeze(['pending', 'acked', 'baseline']);
const HOST_SOURCES = Object.freeze(['native_host.terminal-source', 'native_host.terminal-origin', 'native_host.terminal-arm']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;
// T203: a terminal candidate must name a status the host can actually resolve, and the account it came from.
// Exactly the set the host can announce: `resolve_status` maps a ledger `interrupted` to `failed`, so
// `interrupted` is never a status this service may receive -- accepting it would invent an announcement.
const TERMINAL_RUN_STATES = Object.freeze(['completed', 'failed', 'cancelled']);
const TERMINAL_STATUS_SOURCES = Object.freeze(['bridge.run_facts.status', 'bridge_ledger.status']);

// T269: `hostAck` is the host's own bookkeeping (`acked` / `pending` / `unseen`), and the sidecar re-posts every
// terminal candidate on every round. Freezing the label at first ingest made it wrong for every run acknowledged
// afterwards -- the live store still said `unseen` for a run the host had listed in `ackedIds`. The label therefore
// moves forward only: a later round may raise it, never lower it, and a value outside the contract is not an upgrade.
const HOST_ACK_RANK = Object.freeze({ unseen: 0, pending: 1, acked: 2 });

function hostAckMerge(current, incoming) {
  const now = HOST_ACK_RANK[current];
  const next = HOST_ACK_RANK[incoming];
  if (next === undefined) return typeof current === 'string' && current ? current : 'unseen';
  if (now === undefined) return incoming;
  return next > now ? incoming : current;
}

function loadState(dir) {
  const path = join(dir, STATE_FILE);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.events)) {
      return { state: null, problem: 'state_shape', path };
    }
    const state = { ...emptyState(), ...parsed };
    if (!Array.isArray(state.seen) || (state.seen.length === 0 && state.events.length > 0)) {
      // Migrate a version-2 store: the retained events are the ids we can still vouch for.
      const fromEvents = state.events.map((event) => ({ id: event.eventId, seq: event.seq,
        taskId: event.taskId || null, type: event.type || null }));
      state.seen = Array.isArray(state.seen) && state.seen.length ? state.seen : fromEvents;
    }
    return { state, problem: null, path };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: emptyState(), problem: null, path };
    return { state: null, problem: 'state_unreadable', path };
  }
}

function saveState(dir, state) {
  const path = join(dir, STATE_FILE);
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/** Append one event. A repeated eventId is a no-op that reports `duplicate`, so a restarted client cannot double-post. */
export function appendEvent(state, event, options = {}) {
  const eventId = typeof event.eventId === 'string' ? event.eventId.trim() : '';
  if (!eventId) return { ok: false, code: 'event_id_required' };
  const taskId = typeof event.taskId === 'string' ? event.taskId : null;
  const type = typeof event.type === 'string' ? event.type : 'task_event';
  const seen = Array.isArray(state.seen) ? state.seen : [];
  const known = seen.find((item) => item && item.id === eventId);

  if (known) {
    // T201: an id is bound to the task and the kind of event it was first used for. Reusing it for anything else is a
    // conflict, not a retry -- otherwise one event could "confirm" a transition on an unrelated task.
    if ((known.taskId || null) !== taskId || (known.type || null) !== type) {
      return { ok: false, code: 'event_id_conflict',
        detail: { knownTaskId: known.taskId || null, knownType: known.type || null,
          taskId, type, seq: known.seq } };
    }
    return { ok: true, duplicate: true, event: null, seq: known.seq, appliedSeq: known.seq };
  }

  // T201: past the ledger horizon, a brand new id cannot be distinguished from an evicted one. Say so and refuse,
  // rather than silently processing an event that may already have been applied.
  const evicted = Number.isFinite(state.seenEvicted) ? state.seenEvicted : 0;
  if (evicted > 0 && options.allowBeyondWindow !== true && event.expectNew !== true) {
    return { ok: false, code: 'dedupe_unverifiable',
      detail: { evicted, window: seen.length ? { fromSeq: seen[0].seq, toSeq: seen[seen.length - 1].seq } : null } };
  }

  state.seq += 1;
  const stored = { seq: state.seq, eventId, type, taskId, at: Date.now(), simulated: true };
  state.events.push(stored);
  seen.push({ id: eventId, seq: stored.seq, taskId, type });
  if (seen.length > (options.cap || MAX_SEEN_RETAINED)) {
    const drop = seen.length - (options.cap || MAX_SEEN_RETAINED);
    seen.splice(0, drop);
    state.seenEvicted = evicted + drop;
  }
  state.seen = seen;
  if (state.events.length > MAX_EVENTS_RETAINED) {
    state.events = state.events.slice(state.events.length - MAX_EVENTS_RETAINED);
  }
  return { ok: true, duplicate: false, event: stored, seq: state.seq };
}

function leaseView(lease, now) {
  if (!lease) return null;
  return { leaseId: lease.leaseId || null, sessionId: lease.sessionId, controllerId: lease.controllerId || null,
    acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt, expired: lease.expiresAt <= now };
}

/** Explicit evidence that a requested `since` predates what is still stored. */
function gapFor(state, since) {
  const firstSeq = state.events.length ? state.events[0].seq : state.seq + 1;
  if (since >= firstSeq - 1) return null;
  return { fromSeq: since + 1, toSeq: firstSeq - 1, dropped: firstSeq - 1 - since };
}

export function createRelay(config) {
  const dir = resolve(config.stateDir);
  mkdirSync(dir, { recursive: true });
  const lock = acquireLock(dir);
  // T198: an unforgeable bearer token, created once per state dir and shared with the MCP client through a file the
  // operator passes explicitly. The value never reaches stdout, stderr, an error body or a log line.
  const tokenPath = join(dir, 'service.token');
  let token = typeof config.token === 'string' && config.token ? config.token : null;
  if (!token && existsSync(tokenPath)) token = readFileSync(tokenPath, 'utf8').trim() || null;
  if (!token) {
    token = randomBytes(24).toString('hex');
    writeFileSync(tokenPath, token + '\n', 'utf8');
    try { chmodSync(tokenPath, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  }
  const loaded = lock.ok ? loadState(dir) : { state: null, problem: 'lock_denied', path: join(dir, STATE_FILE) };
  const state = loaded.state;
  const seenCap = Number.isFinite(config.seenCap) && config.seenCap > 0 ? config.seenCap : MAX_SEEN_RETAINED;
  // `state0`/`seen0` are the same objects the routes mutate; named apart so the host route reads clearly.
  const state0 = state;
  const seen0 = state && Array.isArray(state.seen) ? state.seen : [];
  const waiters = new Set();
  const now = () => Date.now();
  // T199: recovery. A `running` task whose controlling lease is gone cannot be running -- the process that owned it
  // died. Record that as an event instead of leaving it looking alive for ever.
  if (state) {
    const leaseAlive = state.lease && state.lease.expiresAt > now();
    let recovered = 0;
    for (const task of state.tasks) {
      if (task.status !== 'running') continue;
      if (leaseAlive) continue;
      // T201: an interrupted task may be requeued and interrupted again; each recovery needs its own identity, or the
      // second one would be swallowed as a duplicate of the first and the task would look alive for ever.
      const attempt = (Number.isFinite(task.recoveries) ? task.recoveries : 0) + 1;
      const applied = appendEvent(state,
        { eventId: 'recovered:' + task.taskId + ':' + attempt, type: 'task_interrupted', taskId: task.taskId },
        { cap: seenCap, allowBeyondWindow: true });
      if (applied.ok && !applied.duplicate) task.recoveries = attempt;
      if (!applied.ok) continue;
      task.status = 'interrupted';
      task.updatedAt = now();
      recovered += 1;
    }
    if (recovered) saveState(dir, state);
    void recovered;
  }

  function persist() {
    if (state) saveState(dir, state);
  }

  function notify() {
    for (const waiter of [...waiters]) waiter();
  }

  function waitForEvents(since, timeoutMs, limit) {
    const slice = () => state.events.filter((event) => event.seq > since).slice(0, limit);
    const ready = slice();
    if (ready.length >= limit) return Promise.resolve({ events: ready, more: true });
    if (ready.length) return Promise.resolve({ events: ready, more: false });
    return new Promise((resolvePromise) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolvePromise({ events: slice(), more: false });
      };
      const timer = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  const routes = {
    'GET /health': () => ({ status: 200, body: {
      ok: Boolean(state), version: SERVICE_VERSION, simulated: true, ...DSH_UNAVAILABLE,
      tasks: state ? state.tasks.length : null, events: state ? state.events.length : null,
      seq: state ? state.seq : null, lease: state ? leaseView(state.lease, now()) : null,
      dedupeWindow: state && state.seen && state.seen.length
        ? { fromSeq: state.seen[0].seq, toSeq: state.seen[state.seen.length - 1].seq, ids: state.seen.length,
          evicted: state.seenEvicted || 0 }
        : { fromSeq: null, toSeq: null, ids: 0, evicted: state.seenEvicted || 0 },
    } }),

    'GET /tasks': () => ({ status: 200, body: { tasks: state ? state.tasks : [], ...DSH_UNAVAILABLE } }),

    'POST /tasks': (body) => {
      const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
      const key = typeof body.clientKey === 'string' ? body.clientKey.trim() : '';
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
      if (!goal || !key) return { status: 400, body: { error: 'goal_and_clientKey_required' } };
      const seen = state.keys.find((item) => item.key === key);
      if (seen) {
        const task = state.tasks.find((item) => item.taskId === seen.taskId) || null;
        return { status: 200, body: { task, duplicate: true, ...DSH_UNAVAILABLE } };
      }
      const task = { taskId: 'task-' + (state.seq + 1) + '-' + now().toString(36), goal, clientKey: key,
        sessionId, status: 'queued', simulated: true, createdAt: now() };
      state.tasks.push(task);
      state.keys.push({ key, taskId: task.taskId });
      appendEvent(state, { eventId: 'queued:' + task.taskId, type: 'task_queued', taskId: task.taskId },
        { cap: seenCap, allowBeyondWindow: true });
      persist();
      notify();
      return { status: 201, body: { task, duplicate: false, ...DSH_UNAVAILABLE } };
    },

    // T199: a task has a lifecycle, and only some moves are legal. Anything else is refused with its own code, so a
    // caller can tell "wrong order" from "already there" from "no such task".
    'POST /tasks/transition': (body) => {
      const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
      const to = typeof body.status === 'string' ? body.status.trim() : '';
      if (!taskId || !to) return { status: 400, body: { error: 'taskId_and_status_required' } };
      const task = state.tasks.find((item) => item.taskId === taskId);
      if (!task) return { status: 404, body: { error: 'no_such_task', taskId } };
      const eventIdRequested = typeof body.eventId === 'string' && body.eventId.trim()
        ? body.eventId.trim() : '';
      const known = (state.seen || []).find((item) => item && item.id === eventIdRequested);
      if (known && ((known.taskId || null) !== taskId || (known.type || null) !== 'task_' + to)) {
        // T201: the id belongs to another task or another kind of move. That is not this request's retry.
        return { status: 409, body: { error: 'event_id_conflict',
          detail: { knownTaskId: known.taskId || null, knownType: known.type || null, taskId, type: 'task_' + to,
            seq: known.seq } } };
      }
      if (known && task.status === to) {
        // The same request arriving twice answers the same way; it is not a second move.
        return { status: 200, body: { task, duplicate: true, alreadyAt: to, seq: known.seq,
          ...DSH_UNAVAILABLE } };
      }
      if (task.status === to) {
        return { status: 200, body: { task, duplicate: true, alreadyAt: to, seq: state.seq,
          ...DSH_UNAVAILABLE } };
      }
      const allowed = TRANSITIONS[task.status] || [];
      if (!allowed.includes(to)) {
        return { status: 409, body: { error: 'illegal_transition', from: task.status, to,
          allowed } };
      }
      const eventId = eventIdRequested || 'status:' + taskId + ':' + to + ':' + state.seq;
      const appended = appendEvent(state, { eventId, type: 'task_' + to, taskId },
        { cap: seenCap, allowBeyondWindow: true });
      if (!appended.ok) return { status: 400, body: { error: appended.code } };
      if (appended.duplicate) {
        return { status: 200, body: { task, duplicate: true, seq: appended.seq, ...DSH_UNAVAILABLE } };
      }
      task.status = to;
      task.updatedAt = now();
      persist();
      notify();
      return { status: 200, body: { task, duplicate: false, seq: appended.seq, ...DSH_UNAVAILABLE } };
    },

    // T202: the only write path for real host traffic. Every item must name a run id, a state the host itself uses,
    // and the artifact it came from; anything else is refused with the item index so a client can fix it.
    'POST /host/candidates': (body) => {
      const items = Array.isArray(body.candidates) ? body.candidates : null;
      if (!items) return { status: 400, body: { error: 'candidates_required' } };
      const accepted = [];
      const rejected = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index] || {};
        const runId = typeof item.runId === 'string' ? item.runId.trim() : '';
        const state = typeof item.state === 'string' ? item.state.trim() : '';
        const hostSource = typeof item.hostSource === 'string' ? item.hostSource.trim() : '';
        if (!RUN_ID.test(runId)) { rejected.push({ index, error: 'run_id_invalid', runId }); continue; }
        if (!HOST_RUN_STATES.includes(state)) { rejected.push({ index, error: 'state_unknown', state }); continue; }
        if (!HOST_SOURCES.includes(hostSource)) {
          rejected.push({ index, error: 'host_source_unknown', hostSource }); continue;
        }
        const existing = state0.runs.find((run) => run.runId === runId);
        if (existing) {
          if (existing.state !== state) {
            existing.state = state;
            existing.updatedAt = now();
            accepted.push({ runId, state, duplicate: true, updated: true, seq: existing.seq });
            persist();
          } else {
            accepted.push({ runId, state, duplicate: true, updated: false, seq: existing.seq });
          }
          continue;
        }
        state0.seq += 1;
        const record = { seq: state0.seq, runId, state, hostSource, ingestedAt: now(),
          origin: 'native_host', simulated: false };
        state0.runs.push(record);
        seen0.push({ id: 'host:' + runId + ':' + state, seq: record.seq, taskId: runId,
          type: 'host_candidate' });
        accepted.push({ runId, state, duplicate: false, seq: record.seq });
      }
      if (accepted.some((item) => !item.duplicate)) persist();
      return { status: 200, body: { accepted, rejected, seq: state0.seq,
        note: 'host-observed only: a host ack is not page delivery and not proof of a DSH run' } };
    },

    // T203: real terminal candidates from the host's own `terminal-mirror` sample. A record without a terminal status
    // and a named source is refused, because "the host offered it" and "the task finished successfully" are two
    // different facts and collapsing them is how a wrong notice gets sent.
    'POST /host/terminal-candidates': (body) => {
      const items = Array.isArray(body.candidates) ? body.candidates : null;
      if (!items) return { status: 400, body: { error: 'candidates_required' } };
      const accepted = [];
      const rejected = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index] || {};
        const runId = typeof item.runId === 'string' ? item.runId.trim() : '';
        const terminalStatus = typeof item.terminalStatus === 'string' ? item.terminalStatus.trim() : '';
        const statusSource = typeof item.statusSource === 'string' ? item.statusSource.trim() : '';
        const hostSource = typeof item.hostSource === 'string' ? item.hostSource.trim() : '';
        if (!RUN_ID.test(runId)) { rejected.push({ index, error: 'run_id_invalid', runId }); continue; }
        if (!TERMINAL_RUN_STATES.includes(terminalStatus)) {
          rejected.push({ index, error: 'terminal_status_missing', terminalStatus }); continue;
        }
        if (!TERMINAL_STATUS_SOURCES.includes(statusSource)) {
          rejected.push({ index, error: 'status_source_missing', statusSource }); continue;
        }
        if (hostSource !== 'native_host.terminal-mirror') {
          rejected.push({ index, error: 'host_source_unknown', hostSource }); continue;
        }
        const existing = state0.runs.find((run) => run.runId === runId);
        if (existing) {
          const incomingInstant = Number.isFinite(item.completedAt) ? item.completedAt : null;
          const incomingSource = typeof item.completedAtSource === 'string' ? item.completedAtSource : 'unknown';
          // T269: the ACK label describes the host's queue state *now*, and the sidecar reports it every round.
          const incomingAck = typeof item.hostAck === 'string' ? item.hostAck : 'unseen';
          const mergedAck = hostAckMerge(existing.hostAck || 'unseen', incomingAck);
          const ackMoved = mergedAck !== (existing.hostAck || 'unseen');
          if (existing.terminalStatus !== terminalStatus) {
            // The status moved, so the instant must move with it: an instant that belonged to the previous status is
            // no longer evidence for this one. `null` means the new report had none, and unknown stays unknown.
            existing.terminalStatus = terminalStatus;
            existing.statusSource = statusSource;
            existing.completedAt = incomingInstant;
            existing.completedAtSource = incomingInstant === null ? 'unknown' : incomingSource;
            existing.hostAck = mergedAck;
            existing.updatedAt = now();
            accepted.push({ runId, terminalStatus, duplicate: true, updated: true, seq: existing.seq });
          } else {
            // Same status: the earliest credible instant wins. A re-post must never be able to push an old run's
            // completion time later and so make it look newer than an arm.
            let refreshed = false;
            if (incomingInstant !== null) {
              if (!Number.isFinite(existing.completedAt) || incomingInstant < existing.completedAt) {
                existing.completedAt = incomingInstant;
                existing.completedAtSource = incomingSource;
                refreshed = true;
              }
            }
            if (ackMoved) {
              existing.hostAck = mergedAck;
              refreshed = true;
            }
            accepted.push({ runId, terminalStatus, duplicate: true, updated: false, refreshed, seq: existing.seq });
          }
          persist();
          continue;
        }
        state0.seq += 1;
        state0.runs.push({ seq: state0.seq, runId, terminalStatus, statusSource, hostSource,
          hostAck: typeof item.hostAck === 'string' ? item.hostAck : 'unseen',
          origin: typeof item.origin === 'string' ? item.origin : 'unknown',
          startedAt: Number.isFinite(item.startedAt) ? item.startedAt : null,
          // T210: completion time, when the reporting host has it. Never derived from `startedAt`.
          completedAt: Number.isFinite(item.completedAt) ? item.completedAt : null,
          // T211: where that instant came from (`bridge.task_events.task.completed`, ...) or `unknown`.
          completedAtSource: typeof item.completedAtSource === 'string' ? item.completedAtSource : 'unknown',
          reportedBy: 'native_host', origin_kind: 'terminal_candidate',
          pageDelivery: 'unknown', simulated: false, ingestedAt: now() });
        accepted.push({ runId, terminalStatus, duplicate: false, seq: state0.seq });
      }
      if (accepted.some((entry) => !entry.duplicate)) persist();
      return { status: 200, body: { accepted, rejected, seq: state0.seq,
        pageDelivery: 'unknown',
        note: 'host terminal candidates only: an ack is not a delivered page, and this service ran nothing' } };
    },

    // T204: the same records, rendered in the shape the extension's auto-trigger already consumes. This is a
    // *rendering*, not a second sender: the fields are the ones `terminal-list` offers (`runId`/`status`/`startedAt`/
    // `origin`), `requiresAck` is false because nothing here may consume the host's pending list, and `deliverable` is
    // false because this service cannot write to a page. Whether anything is sent is decided by the extension's own
    // arm/grant/`admit` path over there, which this process does not touch.
    'GET /extension/terminal-candidates': () => {
      const candidates = (state0.runs || [])
        .filter((run) => typeof run.terminalStatus === 'string')
        .map((run) => ({
          runId: run.runId,
          status: run.terminalStatus,
          startedAt: Number.isFinite(run.startedAt) ? run.startedAt : null,
          completedAt: Number.isFinite(run.completedAt) ? run.completedAt : null,
          completedAtSource: run.completedAtSource || 'unknown',
          origin: run.origin || 'unknown',
          postArm: null,
          source: run.hostSource,
          statusSource: run.statusSource,
          hostAck: run.hostAck || 'unseen',
          pageDelivery: 'unknown',
        }));
      return { status: 200, body: {
        ok: true,
        source: 'agentrelay.mirror',
        readOnly: true,
        deliverable: false,
        requiresAck: false,
        confirmed: false,
        baselineEstablished: candidates.length > 0,
        pageDelivery: 'unknown',
        note: 'mirror of the Native Host terminal candidates: nothing here was written to a page, and a host ack '
          + 'is not delivery',
        candidates,
      } };
    },

    'GET /runs': () => ({ status: 200, body: { runs: state0.runs, note: 'reported by the Native Host; ' +
      'this service did not observe the page and did not run anything' } }),

    'POST /events': (body) => {
      const result = appendEvent(state, { ...body, expectNew: body.expectNew === true }, { cap: seenCap });
      if (!result.ok) {
        const status = result.code === 'event_id_conflict' || result.code === 'dedupe_unverifiable' ? 409 : 400;
        return { status, body: { error: result.code, detail: result.detail || null } };
      }
      persist();
      notify();
      return { status: result.duplicate ? 200 : 201,
        body: { seq: result.seq, duplicate: result.duplicate, event: result.event, ...DSH_UNAVAILABLE } };
    },

    'POST /lease': (body) => {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const controllerId = typeof body.controllerId === 'string' ? body.controllerId.trim() : '';
      const ttlMs = Number.isFinite(body.ttlMs) ? Math.min(Math.max(body.ttlMs, 1000), 600000) : 60000;
      if (!sessionId) return { status: 400, body: { error: 'sessionId_required' } };
      // T198: a session id is a name two controllers can both type. The lease is held by a controller, identified
      // separately, and handed back as a handle that renewal and release must present.
      if (!controllerId) return { status: 400, body: { error: 'controllerId_required' } };
      const current = state.lease;
      if (current && current.expiresAt > now()) {
        const sameController = current.controllerId === controllerId
          && current.sessionId === sessionId
          && (!body.leaseId || body.leaseId === current.leaseId);
        if (!sameController) {
          return { status: 409, body: { error: 'lease_held', holder: current.controllerId,
            sessionId: current.sessionId, expiresAt: current.expiresAt } };
        }
        state.lease = { ...current, expiresAt: now() + ttlMs };
        persist();
        return { status: 200, body: { lease: leaseView(state.lease, now()), renewed: true } };
      }
      state.lease = { leaseId: 'lease-' + randomBytes(8).toString('hex'), sessionId, controllerId,
        acquiredAt: now(), expiresAt: now() + ttlMs };
      persist();
      return { status: 200, body: { lease: leaseView(state.lease, now()), renewed: false } };
    },

    'POST /lease/release': (body) => {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const controllerId = typeof body.controllerId === 'string' ? body.controllerId.trim() : '';
      const current = state.lease;
      if (!current || current.sessionId !== sessionId || current.controllerId !== controllerId
          || (body.leaseId && body.leaseId !== current.leaseId)) {
        return { status: 409, body: { error: 'not_lease_holder' } };
      }
      state.lease = null;
      persist();
      return { status: 200, body: { released: true } };
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!authorised(req)) {
      // No body detail and no hint about the token: an unknown caller learns only that it is unknown.
      return send(401, { error: 'unauthorized' });
    }
    if (!state) return send(503, { error: 'state_' + loaded.problem, path: loaded.path,
      note: 'the file was left untouched' });

    if (req.method === 'GET' && url.pathname === '/events') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);
      const events = state.events.filter((event) => event.seq > since).slice(0, limit);
      return send(200, { events, more: events.length === limit, seq: state.seq, gap: gapFor(state, since),
        simulated: true, ...DSH_UNAVAILABLE });
    }
    if (req.method === 'GET' && url.pathname === '/events/wait') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
      const timeoutMs = Math.min(Math.max(Number(url.searchParams.get('timeoutMs') || 1000), 0), 10000);
      const waited = await waitForEvents(since, timeoutMs, limit);
      return send(200, { events: waited.events, more: waited.more, seq: state.seq, gap: gapFor(state, since),
        simulated: true, ...DSH_UNAVAILABLE });
    }
    if (req.method === 'GET' && url.pathname === '/tasks/get') {
      const taskId = url.searchParams.get('taskId') || '';
      const task = state.tasks.find((item) => item.taskId === taskId) || null;
      return send(task ? 200 : 404, { found: Boolean(task), task, ...DSH_UNAVAILABLE });
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: 'body_not_json' });
      }
    }
    const handler = routes[req.method + ' ' + url.pathname];
    if (!handler) return send(404, { error: 'no_route', path: url.pathname });
    const result = handler(body || {});
    return send(result.status, result.body);
  });

  const authorised = (req) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return false;
    return header.slice(7) === token;
  };

  return {
    server, dir, lock, tokenPath, state: () => state,
    async listen(port) {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', resolveListen);
      });
      return server.address().port;
    },
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
      releaseLock(lock);
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const stateDir = value('--state-dir');
  if (!stateDir) {
    process.stderr.write('usage: relay_service.mjs --state-dir <dir> [--port 0]\n');
    process.exitCode = 2;
    return;
  }
  const seenCapAt = argv.indexOf('--seen-cap');
  const relay = createRelay({ stateDir,
    seenCap: seenCapAt >= 0 ? Number(argv[seenCapAt + 1]) : undefined });
  if (!relay.lock.ok) {
    process.stderr.write('refusing to start: ' + relay.lock.code + '\n');
    process.exitCode = 3;
    return;
  }
  if (!relay.state()) {
    process.stderr.write('refusing to start: state_' + 'unreadable_or_locked\n');
    process.exitCode = 4;
    return;
  }
  const port = await relay.listen(Number(value('--port') || 0));
  // The token file path only: the secret itself is never written to a stream.
  process.stdout.write(JSON.stringify({ ready: true, port, base: 'http://127.0.0.1:' + port,
    tokenFile: relay.tokenPath }) + '\n');
  const stop = () => relay.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) main();
