// DSH Direct: the MCP server (stdio, JSON-RPC 2.0).
//
// Transports: newline-delimited JSON on stdin/stdout, which is what an MCP client launches. No port is opened, no
// session is created, and the only outbound call is HTTP to the loopback Host bridge with a bearer token.
//
// The server refuses to start unless it was given a config that names: the bridge URL (loopback only), the token
// file, the bound project/session allowlist, and a state dir. An unbound call is refused with `not_bound`, not
// quietly widened -- this is the "only the bound project/session" rule, and it is enforced here, at the entry point,
// as well as in the store.

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { CODES, DirectError, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, TOOLS, fail, toolByName,
  validateListSessions, validateSubmitTask, validateTaskId } from './protocol.mjs';
import { HostClient } from './host_client.mjs';
import { TaskStore } from './store.mjs';
import { precheckWorktree } from './worktree.mjs';

const MAX_POLLS = 3;

export function loadConfig(configPath) {
  // Required by every code path below: no config, no server. The file is the operator's, not the repository's.
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const config = {
    hostUrl: raw.hostUrl,
    tokenFile: raw.tokenFile,
    stateDir: raw.stateDir,
    worktreeRoot: raw.worktreeRoot || null,
    allowDirtyWorktree: raw.allowDirtyWorktree === true,
    boundProjectIds: Array.isArray(raw.boundProjectIds) ? raw.boundProjectIds.slice() : [],
    boundSessionIds: Array.isArray(raw.boundSessionIds) ? raw.boundSessionIds.slice() : [],
    maxPolls: Number.isFinite(raw.maxPolls) ? raw.maxPolls : MAX_POLLS,
  };
  if (typeof config.hostUrl !== 'string' || !/^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(config.hostUrl)) {
    fail(CODES.invalid_arguments, 'config.hostUrl must be a loopback http URL', { hostUrl: config.hostUrl });
  }
  for (const key of ['tokenFile', 'stateDir']) {
    if (typeof config[key] !== 'string' || !config[key]) {
      fail(CODES.invalid_arguments, 'config.' + key + ' is required', { field: key });
    }
  }
  if (!config.boundSessionIds.length && !config.boundProjectIds.length) {
    fail(CODES.not_bound, 'config binds no session and no project; refusing to run unbound');
  }
  return config;
}

/** Bound, existing, and matching the project the caller named. */
export function assertBound(config, session) {
  if (!config.boundSessionIds.includes(session.sessionId)) {
    fail(CODES.not_bound, 'this session is not in the binding', { sessionId: session.sessionId });
  }
  if (session.projectId && config.boundProjectIds.length
      && !config.boundProjectIds.includes(session.projectId)) {
    fail(CODES.not_bound, 'this session belongs to a project outside the binding', {
      sessionId: session.sessionId, projectId: session.projectId });
  }
}

export class DirectServer {
  constructor(config, { client, store, worktree = precheckWorktree } = {}) {
    this.config = config;
    this.client = client || new HostClient({ baseUrl: config.hostUrl, tokenFile: config.tokenFile });
    this.store = store || new TaskStore(config.stateDir);
    this.worktree = worktree;
  }

  async listSessions(args) {
    const input = validateListSessions(args);
    const listed = await this.client.listSessions();
    const allowed = listed.filter((session) => this.config.boundSessionIds.includes(session.sessionId));
    const filtered = input.projectId ? allowed.filter((session) => session.projectId === input.projectId) : allowed;
    return { ok: true, host: this.client.kind, bound: this.config.boundSessionIds.length,
      sessions: filtered, counts: { listed: listed.length, bound: allowed.length, returned: filtered.length } };
  }

  async submitTask(args) {
    const input = validateSubmitTask(args);
    // Fail closed on the worktree *before* any Host call: never write over work in progress, and say why.
    let worktree = null;
    if (this.config.worktreeRoot) {
      worktree = await this.worktree(this.config.worktreeRoot);
      if (!worktree.clean && !this.config.allowDirtyWorktree) {
        fail(CODES.worktree_dirty, 'the target worktree has uncommitted changes; refusing to submit', {
          root: this.config.worktreeRoot, head: worktree.head, entries: worktree.entries });
      }
    }
    const sessions = await this.client.listSessions();
    const session = sessions.find((item) => item.sessionId === input.sessionId) || null;
    if (!session) {
      fail(CODES.session_not_found, 'no such session on the Host; this server never creates one', {
        sessionId: input.sessionId });
    }
    assertBound(this.config, session);
    if (input.projectId && session.projectId && input.projectId !== session.projectId) {
      fail(CODES.project_mismatch, 'the session belongs to a different project', {
        sessionId: input.sessionId, expected: session.projectId, got: input.projectId });
    }
    const accepted = this.store.accept({ ...input, projectId: session.projectId });
    if (accepted.duplicate) {
      return { ok: true, host: this.client.kind, duplicate: true, worktree, task: this.#view(accepted.task) };
    }
    const task = accepted.task;
    this.store.stage(task.taskId, 'host_prompt_sent', { sessionId: input.sessionId });
    let receipt = null;
    try {
      receipt = await this.client.prompt({ sessionId: input.sessionId, text: input.prompt,
        requestId: input.requestId });
    } catch (err) {
      // A prompt that never reached the Host must not leave the task active: the ledger would then refuse every
      // later submit to this session with `session_busy`, which is a stuck state, not a safety property.
      const code = err instanceof DirectError ? err.code : CODES.internal;
      this.store.transition(task.taskId, 'failed', { error: { code,
        message: String(err && err.message), phase: 'host_prompt' } });
      throw err;
    }
    if (receipt.accepted !== true) {
      this.store.transition(task.taskId, 'failed', { error: { code: 'host_refused',
        message: 'the Host refused the turn', reason: receipt.reason } });
      return { ok: false, host: this.client.kind, worktree, task: this.#view(this.store.find(task.taskId)) };
    }
    this.store.transition(task.taskId, 'running', { turnId: receipt.turnId });
    const settled = await this.#collect(task.taskId, receipt.turnId);
    return { ok: true, host: this.client.kind, duplicate: false, worktree, task: this.#view(settled) };
  }

  /** Poll the Host a bounded number of times per call: no timers, no long-running process, no unbounded wait. */
  async #collect(taskId, turnId) {
    const task = this.store.find(taskId);
    let cursor = null;
    for (let poll = 1; poll <= this.config.maxPolls; poll += 1) {
      const page = await this.client.getEvents({ sessionId: task.sessionId, turnId, cursor });
      cursor = page.cursor;
      const text = page.events.filter((event) => event.kind === 'assistant.message' && event.text)
        .map((event) => event.text).join('\n');
      this.store.stage(taskId, 'host_events', { poll, events: page.events.length, done: page.done });
      if (page.done) {
        return this.store.transition(taskId, 'succeeded', {
          result: { text: text || null, events: page.events, cursor, polls: poll },
        });
      }
      if (text) {
        this.store.stage(taskId, 'assistant_text_seen', { chars: text.length });
      }
    }
    this.store.stage(taskId, 'poll_budget_spent', { polls: this.config.maxPolls });
    return this.store.find(taskId);
  }

  getTask(args) {
    const taskId = validateTaskId(args);
    const task = this.store.find(taskId);
    if (!task) fail(CODES.task_not_found, 'no such task', { taskId });
    return { ok: true, task: this.#view(task) };
  }

  getResult(args) {
    const taskId = validateTaskId(args);
    return { ok: true, task: this.#view(this.store.finished(taskId)) };
  }

  #view(task) {
    return {
      taskId: task.taskId,
      requestId: task.requestId,
      sessionId: task.sessionId,
      projectId: task.projectId,
      state: task.state,
      unknownReason: task.unknownReason === undefined ? null : task.unknownReason,
      turnId: task.turnId,
      promptChars: task.promptChars,
      promptSha256: task.promptSha256,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      stages: task.stages,
      result: task.result,
      error: task.error,
      host: this.client.kind,
    };
  }
}

async function dispatch(server, name, args) {
  const tool = toolByName(name);
  if (!tool) fail(CODES.unknown_tool, 'no such tool', { tool: name });
  switch (name) {
    case 'list_sessions': return server.listSessions(args);
    case 'submit_task': return server.submitTask(args);
    case 'get_task': return server.getTask(args);
    case 'get_result': return server.getResult(args);
    default: return fail(CODES.unknown_tool, 'no such tool', { tool: name });
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

export function serve(server) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request = null;
    try {
      request = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const id = request.id === undefined ? null : request.id;
    handle(server, request).then((result) => {
      if (id === null && request.method && request.method.startsWith('notifications/')) return;
      send({ jsonrpc: '2.0', id, result });
    }).catch((err) => {
      const error = err instanceof DirectError
        ? { code: -32000, message: err.code + ': ' + err.message, data: err.toJSON() }
        : { code: -32603, message: 'internal error', data: { message: String(err && err.message) } };
      send({ jsonrpc: '2.0', id, error });
    });
  });
}

export async function handle(server, request) {
  const method = request && request.method;
  const params = (request && request.params) || {};
  if (method === 'initialize') {
    return { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } } };
  }
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments === undefined ? {} : params.arguments;
    try {
      const structured = await dispatch(server, name, args);
      return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured,
        isError: structured.ok === false };
    } catch (err) {
      if (err instanceof DirectError) {
        const payload = err.toJSON();
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload,
          isError: true };
      }
      throw err;
    }
  }
  if (method === 'ping') return {};
  throw new DirectError(CODES.unknown_tool, 'unsupported method', { method });
}

export async function main(argv = process.argv.slice(2)) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  const configPath = value('--config');
  if (!configPath) {
    process.stderr.write('usage: mcp_server.mjs --config <dsh-direct.config.json>\n');
    process.exitCode = 2;
    return;
  }
  let config = null;
  try {
    config = loadConfig(path.resolve(configPath));
  } catch (err) {
    process.stderr.write('dsh-direct: ' + (err instanceof DirectError ? err.code : 'config_error') + '\n');
    process.exitCode = 2;
    return;
  }
  mkdirSync(config.stateDir, { recursive: true });
  serve(new DirectServer(config));
}

// Entry detection by exact path, the same rule the service modules in this repository use: importing this file (a
// test, a tool) must not start a server on stdin.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main();
}
