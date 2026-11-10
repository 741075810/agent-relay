// DSH Direct: the task ledger.
//
// One JSON document in the caller's state dir, written atomically. Three properties matter and are tested:
//
//   1. `requestId` idempotency -- the same key with the same payload returns the same task, and the same key with a
//      different payload is refused rather than silently retargeted;
//   2. one active task per session -- a second submit while one is running is refused, because two prompts into one
//      conversation interleave and neither result can be attributed;
//   3. a restart never invents an outcome -- a task that was `running` when the process died comes back as
//      `unknown`, not `succeeded`.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { acquireWriter } from './writer_lock.mjs';

import { ACTIVE_STATES, CODES, DirectError, TASK_STATES, fail } from './protocol.mjs';

const STATE_VERSION = 1;
const STATE_FILE = 'tasks.json';

export function newTaskId() {
  return 'dshd-' + randomBytes(8).toString('hex');
}

export function promptSha(prompt) {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

// A restart is not a terminal observation. Keep this predicate shared by collection,
// result eligibility and locking so a recovery path never silently releases a session.
export function isRecoverableUnknown(task) {
  return task?.state === 'unknown' && task.unknownReason === 'process_restart';
}

function holdsSession(task) {
  return ACTIVE_STATES.includes(task.state) || isRecoverableUnknown(task);
}

export class TaskStore {
  #writer = new AsyncLocalStorage();
  #snapshot;

  /** Hold ownership across asynchronous Host admission/collection; never queue or steal. */
  async withWriter(work) {
    if (this.#writer.getStore()) fail('direct_writer_reentrant', 'nested Direct writer operation');
    const lease = acquireWriter(this.stateDir);
    try {
      return await this.#writer.run(lease, async () => {
        this.#assertSnapshot(lease); // stale long-lived instances fail, rather than clobber a newer ledger
        return await work();
      });
    } finally { lease.release(); }
  }

  assertWriterHeld() {
    const lease = this.#writer.getStore();
    if (!lease) fail('direct_writer_required', 'Host admission requires the active Direct writer');
    this.#assertSnapshot(lease);
  }

  #diskBytes() {
    try { return readFileSync(this.path); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  #assertSnapshot(lease) {
    lease.assertHeld();
    const current = this.#diskBytes();
    if (!(current === null && this.#snapshot === null) && !(current && this.#snapshot && current.equals(this.#snapshot))) {
      lease.preserve();
      fail('direct_writer_stale', 'ledger changed outside this snapshot; reservation preserved');
    }
  }

  #mutate(work) {
    const inherited = this.#writer.getStore(), lease = inherited || acquireWriter(this.stateDir);
    const before = structuredClone(this.doc);
    try { this.#assertSnapshot(lease); return work(lease); }
    catch (e) { this.doc = before; throw e; }
    finally { if (!inherited) lease.release(); }
  }

  constructor(stateDir, now = () => Date.now()) {
    this.stateDir = stateDir;
    this.path = path.join(stateDir, STATE_FILE);
    this.now = now;
    this.doc = this.#load();
  }

  #load() {
    let raw = null;
    try {
      const bytes = readFileSync(this.path);
      this.#snapshot = bytes;
      raw = bytes.toString('utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') { this.#snapshot = null; return { version: STATE_VERSION, tasks: [], requestIds: {} }; }
      fail(CODES.state_unreadable, 'the task ledger exists but cannot be read', { path: this.path, reason: String(err && err.code) });
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(CODES.state_unreadable, 'the task ledger is not valid JSON', { path: this.path });
    }
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.tasks)
        || typeof parsed.requestIds !== 'object' || parsed.requestIds === null) {
      fail(CODES.state_unreadable, 'the task ledger is not a version ' + STATE_VERSION + ' ledger', { path: this.path });
    }
    // A run that was in flight when the previous process died has no outcome this process may claim. An `unsettled`
    // task is different: it already means "the Host may hold the prompt", so it keeps its state *and* its lock, and
    // the operator reconciles it with the same requestId.
    let recovered = 0;
    for (const task of parsed.tasks) {
      if (task.state === 'unsettled') {
        task.stages = (task.stages || []).concat([{ at: this.now(), stage: 'unsettled_across_restart',
          detail: 'still requiring reconcile with the same requestId' }]);
        recovered += 1;
        continue;
      }
      if (ACTIVE_STATES.includes(task.state)) {
        task.state = 'unknown';
        task.unknownReason = 'process_restart';
        task.updatedAt = this.now();
        task.stages = (task.stages || []).concat([{ at: this.now(), stage: 'recovered_as_unknown',
          detail: 'the ledger was reloaded after a restart' }]);
        recovered += 1;
      }
    }
    this.recovered = recovered;
    return parsed;
  }

  #save(lease) {
    const tmp = this.path + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
    const bytes = Buffer.from(JSON.stringify(this.doc, null, 2) + '\n', 'utf8');
    try {
      this.#assertSnapshot(lease);
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      this.#assertSnapshot(lease);
      renameSync(tmp, this.path);
      this.#snapshot = bytes;
    } catch (e) {
      lease.preserve(); // leave temp/lock evidence; no automatic rollback over newer/uncertain disk state
      throw e;
    }
  }

  get tasks() {
    return this.doc.tasks;
  }

  find(taskId) {
    return this.doc.tasks.find((task) => task.taskId === taskId) || null;
  }

  byRequestId(requestId) {
    const taskId = this.doc.requestIds[requestId];
    return taskId ? this.find(taskId) : null;
  }

  activeFor(sessionId) {
    return this.doc.tasks.find((task) => task.sessionId === sessionId && holdsSession(task)) || null;
  }

  /**
   * Record a new task, or return the existing one for a repeated `requestId`.
   * `requestId` reuse with a different (sessionId, prompt) is a refusal: it is a different intent wearing the same
   * key, and answering with the old task would lose it.
   */
  accept(input) { return this.#mutate(lease => this.#accept(input, lease)); }

  #accept({ requestId, sessionId, projectId, prompt }, lease) {
    const sha = promptSha(prompt);
    const known = this.byRequestId(requestId);
    if (known) {
      if (known.sessionId === sessionId && known.promptSha256 === sha) {
        return { task: known, duplicate: true };
      }
      fail(CODES.request_conflict, 'this `requestId` was already used for a different task', {
        requestId, existingTaskId: known.taskId });
    }
    const busy = this.activeFor(sessionId);
    if (busy) {
      fail(CODES.session_busy, 'this session already has an active task', {
        sessionId, activeTaskId: busy.taskId, activeState: busy.state });
    }
    const at = this.now();
    const task = {
      taskId: newTaskId(),
      requestId,
      sessionId,
      projectId: projectId || null,
      promptSha256: sha,
      promptChars: prompt.length,
      state: 'accepted',
      stages: [{ at, stage: 'accepted', detail: 'validated against the binding and the Host session list' }],
      createdAt: at,
      updatedAt: at,
      turnId: null,
      result: null,
      error: null,
    };
    this.doc.tasks.push(task);
    this.doc.requestIds[requestId] = task.taskId;
    this.#save(lease);
    return { task, duplicate: false };
  }

  stage(taskId, stage, detail) { return this.#mutate(lease => this.#stage(taskId, stage, detail, lease)); }

  #stage(taskId, stage, detail, lease) {
    const task = this.find(taskId);
    if (!task) fail(CODES.task_not_found, 'no such task', { taskId });
    const at = this.now();
    task.stages.push({ at, stage, detail: detail === undefined ? null : detail });
    task.updatedAt = at;
    this.#save(lease);
    return task;
  }

  transition(taskId, state, patch = {}) { return this.#mutate(lease => this.#transition(taskId, state, patch, lease)); }

  #transition(taskId, state, patch, lease) {
    if (!TASK_STATES.includes(state)) fail(CODES.internal, 'unknown task state', { state });
    const task = this.find(taskId);
    if (!task) fail(CODES.task_not_found, 'no such task', { taskId });
    task.state = state;
    Object.assign(task, patch);
    task.updatedAt = this.now();
    task.stages.push({ at: task.updatedAt, stage: 'state_' + state, detail: null });
    this.#save(lease);
    return task;
  }

  /** For `get_result`: a finished task is returned, anything else is refused with the reason it is not finished. */
  finished(taskId) {
    const task = this.find(taskId);
    if (!task) fail(CODES.task_not_found, 'no such task', { taskId });
    if (task.state === 'unsettled') {
      fail(CODES.task_unsettled, 'the submission never got an answer; reconcile it with its requestId first', {
        taskId, requestId: task.requestId, stages: task.stages.length });
    }
    if (holdsSession(task)) {
      fail(CODES.task_not_finished, 'the task has not finished', { taskId, state: task.state,
        stages: task.stages.length });
    }
    return task;
  }
}

export function isDirectError(err) {
  return err instanceof DirectError;
}
