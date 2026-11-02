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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

function emptyState() {
  return { version: 1, seq: 0, tasks: [], events: [], eventIds: [], keys: [], lease: null };
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
  if (state.eventIds.includes(eventId)) return { ok: true, duplicate: true, event: null, seq: state.seq };
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
  state.eventIds.push(eventId);
  if (state.events.length > MAX_EVENTS_RETAINED) {
    const drop = state.events.length - MAX_EVENTS_RETAINED;
    state.events = state.events.slice(drop);
  }
  return { ok: true, duplicate: false, event: stored, seq: state.seq };
}

function leaseView(lease, now) {
  if (!lease) return null;
  return { sessionId: lease.sessionId, acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt, expired: lease.expiresAt <= now };
}

export function createRelay(config) {
  const dir = resolve(config.stateDir);
  mkdirSync(dir, { recursive: true });
  const lock = acquireLock(dir);
  const loaded = lock.ok ? loadState(dir) : { state: null, problem: 'lock_denied', path: join(dir, STATE_FILE) };
  const state = loaded.state;
  const waiters = new Set();
  const now = () => Date.now();

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
      const ttlMs = Number.isFinite(body.ttlMs) ? Math.min(Math.max(body.ttlMs, 1000), 600000) : 60000;
      if (!sessionId) return { status: 400, body: { error: 'sessionId_required' } };
      const current = state.lease;
      if (current && current.sessionId !== sessionId && current.expiresAt > now()) {
        return { status: 409, body: { error: 'lease_held', holder: current.sessionId,
          expiresAt: current.expiresAt } };
      }
      state.lease = { sessionId, acquiredAt: now(), expiresAt: now() + ttlMs };
      persist();
      return { status: 200, body: { lease: leaseView(state.lease, now()) } };
    },

    'POST /lease/release': (body) => {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      if (!state.lease || state.lease.sessionId !== sessionId) {
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
    if (!state) return send(503, { error: 'state_' + loaded.problem, path: loaded.path,
      note: 'the file was left untouched' });

    if (req.method === 'GET' && url.pathname === '/events') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);
      const events = state.events.filter((event) => event.seq > since).slice(0, limit);
      return send(200, { events, more: events.length === limit, seq: state.seq, simulated: true, ...DSH_UNAVAILABLE });
    }
    if (req.method === 'GET' && url.pathname === '/events/wait') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
      const timeoutMs = Math.min(Math.max(Number(url.searchParams.get('timeoutMs') || 1000), 0), 10000);
      const waited = await waitForEvents(since, timeoutMs, limit);
      return send(200, { events: waited.events, more: waited.more, seq: state.seq, simulated: true,
        ...DSH_UNAVAILABLE });
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

  return {
    server, dir, lock, state: () => state,
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
  process.stdout.write(JSON.stringify({ ready: true, port, base: 'http://127.0.0.1:' + port }) + '\n');
  const stop = () => relay.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) main();
