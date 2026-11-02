#!/usr/bin/env node
// T195/T196: a prototype MCP server for AgentRelay -- stdio JSON-RPC, local state, no DSH, no Bridge.
//
// T196 fixed five interoperability and durability defects found in review:
//   1. tool arguments arrive in `params.arguments` (the MCP field), not `params.args`;
//   2. a corrupt store is **fail-closed**: the server refuses to write rather than overwrite what it cannot read;
//   3. the per-request-id response cache is gone -- a JSON-RPC id is a correlation id, not a business key, and
//      reusing it for a different call must reach the tool; deduplication is only the persisted `idempotencyKey`;
//   4. idempotency keys are held in a `Map`, so inherited property names (`__proto__`, `constructor`) are ordinary
//      data, and a key reused with a different goal/session is a conflict rather than a silent alias;
//   5. retention never forgets unfinished work: only terminal tasks are pruned; at capacity with nothing prunable
//      the store refuses with `store_full` instead of silently dropping a queued task.
//
// What this server is not: it does not execute anything. `agentrelay_submit` records a queued task locally and the
// response says so. The Bridge still carries the live loop.

import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { acquireLock, releaseLock } from '../service/lock.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'agentrelay-mcp';
export const SERVER_VERSION = '0.3.0';
const STATE_FILE = 'tasks.json';
const LOCK_FILE = 'writer.lock';
const MAX_TASKS_RETAINED = 200;
const TERMINAL = Object.freeze(['completed', 'failed', 'cancelled']);

function emptyState() {
  return { version: 2, tasks: [], requests: [], seq: 0 };
}

/** `requests` is a list of {key, taskId, goal, providerSessionId} so no key can collide with Object.prototype. */
function normaliseState(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) return null;
  const requests = Array.isArray(parsed.requests) ? parsed.requests.filter((item) => item
    && typeof item.key === 'string' && typeof item.taskId === 'string') : [];
  return { version: 2, tasks: parsed.tasks, requests, seq: Number.isFinite(parsed.seq) ? parsed.seq : 0 };
}

/** Read the store. A problem is reported and never turned into an empty store that a later write would replace. */
export function readState(dir) {
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return { state: emptyState(), problem: null, path };
  try {
    const state = normaliseState(JSON.parse(readFileSync(path, 'utf8')));
    if (!state) return { state: null, problem: 'state_shape', path };
    return { state, problem: null, path };
  } catch (err) {
    return { state: null, problem: 'state_unreadable', path };
  }
}

function writeState(dir, state) {
  const path = join(dir, STATE_FILE);
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export let ID_SEQ = 0;
function nextId() {
  ID_SEQ += 1;
  return `task-${process.pid}-${Date.now().toString(36)}-${ID_SEQ}`;
}

export const TOOLS = Object.freeze([
  {
    name: 'agentrelay_status',
    description: 'Read-only summary of the local store. Does not contact DSH, the Bridge or any page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agentrelay_submit',
    description: 'Record a task as queued in the local store only. Nothing is executed and no DSH run is started.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        idempotencyKey: { type: 'string' },
        providerSessionId: { type: 'string' },
      },
      required: ['goal', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentrelay_task_get',
    description: 'Read one task by id. Returns found:false rather than inventing one.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } },
      required: ['taskId'], additionalProperties: false },
  },
  {
    name: 'relay_status',
    description: 'Health and counters from the running local AgentRelay service. Read-only, simulated.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'relay_task_get',
    description: 'Read one task from the running local service. Returns found:false rather than inventing one.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } },
      required: ['taskId'], additionalProperties: false },
  },
  {
    name: 'relay_events',
    description: 'Incremental read of the service event log after a sequence number.',
    inputSchema: { type: 'object', properties: {
      since: { type: 'number' }, timeoutMs: { type: 'number' }, limit: { type: 'number' } },
      additionalProperties: false },
  },
]);

const LOCAL_ONLY = Object.freeze({
  durable: true,
  localOnly: true,
  executes: false,
  note: 'recorded in this server\'s local store only; no DSH run was started and no notice was sent',
});

function text(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(code, detail) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: code, detail: detail || null }) }],
    isError: true };
}

/** Retention may only remove work that is already finished; anything else must survive. */
function prune(state) {
  if (state.tasks.length <= MAX_TASKS_RETAINED) return true;
  const keep = [];
  let excess = state.tasks.length - MAX_TASKS_RETAINED;
  for (const task of state.tasks) {
    if (excess > 0 && TERMINAL.includes(task.status)) { excess -= 1; continue; }
    keep.push(task);
  }
  if (excess > 0) return false; // nothing finished to drop: refuse rather than forget a queued task
  state.tasks = keep;
  return true;
}

const RELAY_TOOLS = ['relay_status', 'relay_task_get', 'relay_events'];

/** Call the local service. Any failure is said out loud -- the tool never falls back to the local store. */
async function callRelay(serviceUrl, name, args) {
  if (!serviceUrl) return fail('service_unavailable', { reason: 'start the service and pass --service-url' });
  const base = serviceUrl.replace(/\/+$/, '');
  const target = name === 'relay_status' ? base + '/health'
    : name === 'relay_task_get' ? base + '/tasks/get?taskId=' + encodeURIComponent(String(args.taskId || ''))
      : base + '/events' + (Number.isFinite(args.timeoutMs)
        ? '/wait?timeoutMs=' + args.timeoutMs + '&since=' : '?since=') + Number(args.since || 0)
        + (Number.isFinite(args.limit) ? '&limit=' + args.limit : '');
  try {
    const response = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify({ status: response.status, ...payload,
      simulated: true, dsh: 'unavailable' }, null, 2) }], isError: response.status >= 400 };
  } catch (err) {
    return fail('service_unreachable', { url: target, detail: String(err && err.message ? err.message : err) });
  }
}

function callTool(dir, state, name, args) {
  if (name === 'agentrelay_status') {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of state.tasks) {
      if (Object.prototype.hasOwnProperty.call(counts, task.status)) counts[task.status] += 1;
    }
    return text({ tasks: state.tasks.length, counts, keys: state.requests.length,
      lastTaskId: state.tasks.length ? state.tasks[state.tasks.length - 1].taskId : null, ...LOCAL_ONLY });
  }

  if (name === 'agentrelay_task_get') {
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    const task = state.tasks.find((item) => item.taskId === taskId) || null;
    return text({ found: Boolean(task), task, ...LOCAL_ONLY });
  }

  if (name === 'agentrelay_submit') {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    const key = typeof args.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
    if (!goal || !key) return fail('goal_and_idempotencyKey_required');
    if (key.length > 200) return fail('idempotencyKey_too_long');
    const providerSessionId = typeof args.providerSessionId === 'string' ? args.providerSessionId : null;

    const seen = state.requests.find((item) => item.key === key);
    if (seen) {
      const sameIntent = seen.goal === goal && (seen.providerSessionId || null) === providerSessionId;
      const task = state.tasks.find((item) => item.taskId === seen.taskId) || null;
      if (!sameIntent) return fail('idempotency_conflict',
        { existingTaskId: seen.taskId, reason: 'the same key was used for a different goal or session' });
      if (!task) return fail('task_pruned_for_key', { taskId: seen.taskId });
      return text({ taskId: task.taskId, duplicate: true, status: task.status, ...LOCAL_ONLY });
    }

    const task = { taskId: nextId(), goal, idempotencyKey: key, providerSessionId,
      status: 'queued', createdAt: Date.now() };
    state.seq += 1;
    state.tasks.push(task);
    state.requests.push({ key, taskId: task.taskId, goal, providerSessionId });
    if (!prune(state)) {
      // Undo the insert: refusing is correct, half-applying is not.
      state.tasks.pop();
      state.requests.pop();
      return fail('store_full', { retained: state.tasks.length,
        reason: 'no finished task may be dropped; finish or clear tasks before submitting more' });
    }
    writeState(dir, state);
    return text({ taskId: task.taskId, duplicate: false, status: task.status, ...LOCAL_ONLY });
  }

  return fail('unknown_tool', { name });
}

export function createServer(stateDir, options = {}) {
  const serviceUrl = options.serviceUrl || process.env.AGENTRELAY_SERVICE_URL || '';
  const dir = resolve(stateDir);
  mkdirSync(dir, { recursive: true });
  const lock = options.lock === false ? { ok: true, code: null, token: null, path: null } : acquireLock(dir);
  const read = readState(dir);
  return {
    dir,
    lock,
    problem: read.problem,
    state: () => read.state,
    handle(message) {
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0'
          || typeof message.method !== 'string') {
        return { jsonrpc: '2.0', id: message && message.id !== undefined ? message.id : null,
          error: { code: -32600, message: 'invalid request' } };
      }
      const { id, method, params } = message;
      if (!lock.ok) {
        return { jsonrpc: '2.0', id: id === undefined ? null : id,
          error: { code: -32000, message: 'state dir is held by another writer (pid '
            + (lock.owner && lock.owner.pid ? lock.owner.pid : '?') + ')' } };
      }
      if (method === 'notifications/initialized') return null;
      if (method === 'initialize') {
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'agentrelay_submit queues a task in this server\'s local store; the relay_* tools read the '
            + 'separate local service. Nothing here starts a DSH run: no verified external DSH control API exists, so '
            + 'the relay service records are marked simulated. The Bridge still carries the live loop.',
        } };
      }
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      if (method !== 'tools/call') {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
      }

      const name = params && params.name;
      // MCP passes tool arguments in `arguments`. `args` is not the field, and accepting it silently is how a
      // prototype ends up passing its own tests and failing every real client.
      const args = (params && params.arguments) || {};
      if (typeof args !== 'object' || Array.isArray(args)) {
        return { jsonrpc: '2.0', id, result: fail('arguments_must_be_object') };
      }
      if (params && params.args !== undefined) {
        return { jsonrpc: '2.0', id, result: fail('unknown_parameter_args',
          { hint: 'MCP sends tool arguments in `arguments`, not `args`' }) };
      }
      if (read.problem) {
        // Fail closed: the store cannot be read, so it must not be replaced by a fresh one.
        return { jsonrpc: '2.0', id, result: fail('state_' + read.problem,
          { path: read.path, note: 'the file was left untouched; repair or remove it deliberately' }) };
      }
      if (RELAY_TOOLS.includes(name)) {
        return Promise.resolve(callRelay(serviceUrl, name, args))
          .then((result) => ({ jsonrpc: '2.0', id, result }));
      }
      return { jsonrpc: '2.0', id, result: callTool(dir, read.state, name, args) };
    },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--state-dir');
  const stateDir = at >= 0 ? argv[at + 1] : process.env.AGENTRELAY_MCP_STATE;
  if (!stateDir) {
    process.stderr.write('usage: agentrelay_mcp.mjs --state-dir <dir>\n');
    process.exitCode = 2;
    return;
  }
  const serviceAt = argv.indexOf('--service-url');
  const serviceUrl = (serviceAt >= 0 ? argv[serviceAt + 1] : undefined)
    || process.env.AGENTRELAY_SERVICE_URL || '';
  const server = createServer(stateDir, { serviceUrl });
  if (!server.lock.ok) {
    process.stderr.write(`refusing to start: ${server.lock.code}\n`);
    process.exitCode = 3;
    return;
  }
  process.on('exit', () => { releaseLock(server.lock); });
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    const raw = line.trim();
    if (!raw) return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    Promise.resolve(server.handle(message)).then((response) => {
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }).catch((err) => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message && message.id,
        error: { code: -32603, message: 'internal error: ' + String(err && err.message) } }) + '\n');
    });
  });
  reader.on('close', () => {
    releaseLock(server.lock);
    process.exit(0);
  });
  process.stderr.write(`agentrelay-mcp ${SERVER_VERSION} ready (state ${server.dir})\n`);
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
