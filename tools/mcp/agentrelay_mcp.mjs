#!/usr/bin/env node
// T195: a prototype MCP server for AgentRelay -- stdio JSON-RPC, no network, no DSH, no Bridge.
//
// This is the first piece of the eventual replacement for the Bridge, and it is deliberately the smallest piece
// that can be tested end to end: initialize, tool discovery, and a read-only status query over a local task store
// that survives a process restart. It does not talk to DSH, does not send notices, and cannot affect the running
// Bridge. Everything it knows lives in `--state-dir`.
//
// Framing: newline-delimited JSON, per MCP's stdio transport. Each request is answered on stdout; diagnostics go
// to stderr so a client never has to parse around them.

import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'agentrelay-mcp';
export const SERVER_VERSION = '0.1.0';
const STATE_FILE = 'tasks.json';

function emptyState() {
  return { version: 1, tasks: [], requests: {}, seq: 0 };
}

/** Read the store, or an empty one. A malformed file is reported, never silently replaced. */
function readState(dir) {
  const path = join(dir, STATE_FILE);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tasks)) return { state: emptyState(), problem: 'state_shape' };
    return { state: parsed, problem: null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: emptyState(), problem: null };
    return { state: emptyState(), problem: 'state_unreadable' };
  }
}

/** Write atomically: a crash mid-write must not leave a half document behind. */
function writeState(dir, state) {
  const path = join(dir, STATE_FILE);
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export let UUID_SEQ = 0;
function nextId() {
  UUID_SEQ += 1;
  return `task-${process.pid}-${Date.now().toString(36)}-${UUID_SEQ}`;
}

/**
 * The tools. `agentrelay_status` is read-only; `agentrelay_submit` records a task locally and is idempotent on its
 * `idempotencyKey`; `agentrelay_task_get` reads one task back. None of them touch anything outside the state dir.
 */
export const TOOLS = Object.freeze([
  {
    name: 'agentrelay_status',
    description: 'Read-only summary of the local task store. Does not contact DSH, the Bridge or any page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agentrelay_submit',
    description: 'Record a task locally. Repeating the same idempotencyKey returns the same task id.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'what the task should achieve' },
        idempotencyKey: { type: 'string', description: 'stable key; repeating it never creates a second task' },
        providerSessionId: { type: 'string' },
      },
      required: ['goal', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'agentrelay_task_get',
    description: 'Read one task by id. Returns found:false rather than inventing one.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
]);

const MAX_TASKS_RETAINED = 200;

function callTool(state, name, args) {
  if (name === 'agentrelay_status') {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const task of state.tasks) {
      if (Object.prototype.hasOwnProperty.call(counts, task.status)) counts[task.status] += 1;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ tasks: state.tasks.length, counts,
        lastTaskId: state.tasks.length ? state.tasks[state.tasks.length - 1].taskId : null,
        note: 'local store only; nothing here proves a DSH run or a delivered notice' }, null, 2) }],
      isError: false,
    };
  }

  if (name === 'agentrelay_submit') {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    const key = typeof args.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
    if (!goal || !key) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'goal and idempotencyKey are required' }) }],
        isError: true };
    }
    const existing = state.requests[key];
    if (existing) {
      const task = state.tasks.find((item) => item.taskId === existing);
      return { content: [{ type: 'text', text: JSON.stringify({ taskId: existing, duplicate: true,
        status: task ? task.status : null }) }], isError: false };
    }
    const task = {
      taskId: nextId(),
      goal,
      idempotencyKey: key,
      providerSessionId: typeof args.providerSessionId === 'string' ? args.providerSessionId : null,
      status: 'queued',
      createdAt: Date.now(),
    };
    state.seq += 1;
    state.tasks.push(task);
    state.requests[key] = task.taskId;
    if (state.tasks.length > MAX_TASKS_RETAINED) state.tasks = state.tasks.slice(-MAX_TASKS_RETAINED);
    return { content: [{ type: 'text', text: JSON.stringify({ taskId: task.taskId, duplicate: false,
      status: task.status }) }], isError: false };
  }

  if (name === 'agentrelay_task_get') {
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    const task = state.tasks.find((item) => item.taskId === taskId) || null;
    return { content: [{ type: 'text', text: JSON.stringify({ found: Boolean(task), task }) }],
      isError: false };
  }

  return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool:' + name }) }], isError: true };
}

export function createServer(stateDir) {
  const dir = resolve(stateDir);
  mkdirSync(dir, { recursive: true });
  let { state } = readState(dir);
  // Responses already produced for a request id, so a replayed id is answered identically instead of re-run.
  const answered = new Map();

  function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message && message.id !== undefined ? message.id : null,
        error: { code: -32600, message: 'invalid request' } };
    }
    const { id, method, params } = message;
    if (id !== undefined && answered.has(id)) return answered.get(id);

    let response;
    if (method === 'initialize') {
      response = { jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'Local AgentRelay state only. The Bridge still carries the live loop.',
        } };
    } else if (method === 'notifications/initialized') {
      return null; // a notification: no response
    } else if (method === 'tools/list') {
      response = { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    } else if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.args) || {};
      const result = callTool(state, name, args);
      if (name === 'agentrelay_submit' && result.isError === false) writeState(dir, state);
      response = { jsonrpc: '2.0', id, result };
    } else {
      response = { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } };
    }
    if (id !== undefined) answered.set(id, response);
    return response;
  }

  return { handle, dir, state: () => state };
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
  const server = createServer(stateDir);
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (err) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const response = server.handle(message);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  });
  process.stderr.write(`agentrelay-mcp ready (state ${server.dir})\n`);
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) main();
