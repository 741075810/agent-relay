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
  return { version: 2, seq: 0, tasks: [], events: [], keys: [], lease: null };
}

function loadState(dir) {
  const path = join(dir, STATE_FILE);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.events)) {
      return { state: null, problem: 'state_shape', path };
    }
    return { state: { ...emptyState(), ...parsed }, problem: null, path };
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
export function appendEvent(state, event) {
  const eventId = typeof event.eventId === 'string' ? event.eventId.trim() : '';
  if (!eventId) return { ok: false, code: 'event_id_required' };
  // T199: dedupe against the events we still hold. The old `eventIds` array grew for ever while the event log was
  // trimmed, so memory kept every id ever seen even though the bodies were gone -- and the two could disagree.
  if (state.events.some((item) => item.eventId === eventId)) {
    return { ok: true, duplicate: true, event: null, seq: state.seq };
  }
  state.seq += 1;
  const stored = {
    seq: state.seq,
    eventId,
    type: typeof event.type === 'string' ? event.type : 'task_event',
    taskId: typeof event.taskId === 'string' ? event.taskId : null,
    at: Date.now(),
    simulated: true,
  };
  state.events.push(stored);
  if (state.events.length > MAX_EVENTS_RETAINED) {
    const drop = state.events.length - MAX_EVENTS_RETAINED;
    state.events = state.events.slice(drop);
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
      task.status = 'interrupted';
      task.updatedAt = now();
      appendEvent(state, { eventId: 'recovered:' + task.taskId, type: 'task_interrupted', taskId: task.taskId });
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
      appendEvent(state, { eventId: 'queued:' + task.taskId, type: 'task_queued', taskId: task.taskId });
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
      const allowed = TRANSITIONS[task.status] || [];
      if (!allowed.includes(to)) {
        return { status: 409, body: { error: 'illegal_transition', from: task.status, to,
          allowed } };
      }
      const eventId = typeof body.eventId === 'string' && body.eventId.trim()
        ? body.eventId.trim() : 'status:' + taskId + ':' + to + ':' + state.seq;
      const appended = appendEvent(state, { eventId, type: 'task_' + to, taskId });
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

    'POST /events': (body) => {
      const result = appendEvent(state, body);
      if (!result.ok) return { status: 400, body: { error: result.code } };
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
  const relay = createRelay({ stateDir });
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
