// DSH Direct: the MCP server (stdio, JSON-RPC 2.0).
//
// Transport: newline-delimited JSON on stdin/stdout, which is what an MCP client launches. No port is opened, no
// session is created, and the only outbound call is HTTP to the loopback Host bridge with a bearer token.
//
// The decision this file exists for is what to do when a prompt gets no answer. T271 marked that `failed` and released
// the session, which is wrong: the Host may already hold the prompt. The rule now is:
//
//   * an explicit Host refusal (`host_refused`, `session_busy`, `session_writer_held`, `session_not_found`,
//     `invalid_arguments`) is an outcome -> `failed`, lock released;
//   * anything else (`host_unreachable`, `host_error`, `cancelled`, `internal`) means the answer never arrived ->
//     `unsettled`, the session lock is **kept**, `get_result` refuses with `task_unsettled`, and `reconcile_task`
//     re-submits the *same* requestId, which `@deepseek-ai/dsh-api-session-controller@0.2.0-rc.2` acknowledges
//     without inserting a second message (`lib/index.js:855`).

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  CODES, DirectError, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, TOOLS, fail, loadHttpConfig, toolByName,
  validateListSessions, validateSubmitTask, validateTaskId,
} from './protocol.mjs';
import { HostClient } from './host_client.mjs';
import { TaskStore, promptSha } from './store.mjs';
import { precheckWorktree } from './worktree.mjs';

/** Codes that mean "the Host answered, and the answer was no". Everything else is an unanswered call. */
const REFUSAL_CODES = new Set([CODES.host_refused, CODES.session_busy, CODES.session_writer_held,
  CODES.session_not_found, CODES.invalid_arguments, CODES.unauthenticated, CODES.not_bound,
  CODES.project_mismatch, CODES.host_capability_missing, CODES.host_identity_mismatch, CODES.bind_failed]);
const DEFAULT_MAX_POLLS = 3;

/**
 * The keys `loadConfig` understands. Exported so the preflight can prove that `config.example.json` and the install
 * document only mention fields this server actually reads -- a doc that teaches a field nobody implements is the same
 * class of defect as a frozen port nobody can reach.
 */
export const CONFIG_FIELDS = Object.freeze(['hostUrl', 'endpointFile', 'tokenFile', 'stateDir', 'worktreeRoot',
  'allowDirtyWorktree', 'expectKind', 'expectProtocol', 'boundProjectIds', 'boundSessionIds', 'boundCwds',
  'maxPolls', 'http']);

export function loadConfig(configPath) {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const config = {
    hostUrl: raw.hostUrl,
    endpointFile: raw.endpointFile,
    tokenFile: raw.tokenFile,
    stateDir: raw.stateDir,
    worktreeRoot: raw.worktreeRoot || null,
    allowDirtyWorktree: raw.allowDirtyWorktree === true,
    expectKind: typeof raw.expectKind === 'string' ? raw.expectKind : null,
    expectProtocol: typeof raw.expectProtocol === 'string' ? raw.expectProtocol : null,
    boundProjectIds: Array.isArray(raw.boundProjectIds) ? raw.boundProjectIds.slice() : [],
    boundSessionIds: Array.isArray(raw.boundSessionIds) ? raw.boundSessionIds.slice() : [],
    boundCwds: Array.isArray(raw.boundCwds) ? raw.boundCwds.slice() : [],
    maxPolls: Number.isFinite(raw.maxPolls) ? raw.maxPolls : DEFAULT_MAX_POLLS,
    // Off unless `http.enabled` is the boolean true. The stdio transport stays the default; the HTTP one is an opt-in
    // and refuses anything but a loopback host, so an existing deployment cannot become network-reachable by editing
    // one field by accident.
    http: loadHttpConfig(raw.http),
  };
  // Exactly one locator. A plugin that binds `port: 0` cannot be addressed by a frozen URL, so `endpointFile` is the
  // supported shape there; a pinned port uses `hostUrl`. Both at once means the caller cannot say which wins.
  const wantsUrl = typeof config.hostUrl === 'string' && config.hostUrl !== '';
  const wantsFile = typeof config.endpointFile === 'string' && config.endpointFile !== '';
  if (wantsUrl && wantsFile) {
    fail(CODES.invalid_arguments, 'config.hostUrl and config.endpointFile are mutually exclusive',
      { hostUrl: config.hostUrl, endpointFile: config.endpointFile });
  }
  if (!wantsUrl && !wantsFile) {
    fail(CODES.invalid_arguments, 'config.hostUrl or config.endpointFile is required', {});
  }
  if (wantsUrl && !/^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(config.hostUrl)) {
    fail(CODES.invalid_arguments, 'config.hostUrl must be a loopback http URL', { hostUrl: config.hostUrl });
  }
  if (config.endpointFile !== undefined && config.endpointFile !== null && !wantsFile) {
    fail(CODES.invalid_arguments, 'config.endpointFile must be a non-empty path', { endpointFile: config.endpointFile });
  }
  for (const key of ['tokenFile', 'stateDir']) {
    if (typeof config[key] !== 'string' || !config[key]) {
      fail(CODES.invalid_arguments, 'config.' + key + ' is required', { field: key });
    }
  }
  if (!config.boundSessionIds.length && !config.boundProjectIds.length && !config.boundCwds.length) {
    fail(CODES.not_bound, 'config binds no session, project or cwd; refusing to run unbound');
  }
  return config;
}

/** Bound, existing, and matching the project/cwd the caller named. rc.2 rows carry `cwd`, not a project id. */
export function assertBound(config, session) {
  const byId = config.boundSessionIds.includes(session.sessionId);
  const byCwd = typeof session.cwd === 'string' && config.boundCwds.includes(session.cwd);
  if (!byId && !byCwd) {
    fail(CODES.not_bound, 'this session is not in the binding', { sessionId: session.sessionId,
      cwd: session.cwd === undefined ? null : session.cwd });
  }
}

/** Absence of busy evidence is not idle evidence. Never inject into an already-running or unavailable Agent. */
export function assertSessionIdle(session) {
  if (session.running !== false || session.agentAvailable !== true) {
    fail(CODES.session_busy, 'the Host has not confirmed an idle, available session; no prompt sent', {
      sessionId: session.sessionId, running: session.running ?? null,
      agentAvailable: session.agentAvailable ?? null, reason: 'host_idle_not_confirmed' });
  }
}

export class DirectServer {
  constructor(config, { client, store, worktree = precheckWorktree } = {}) {
    this.config = config;
    this.client = client || new HostClient({ baseUrl: config.hostUrl || null,
      endpointFile: config.endpointFile || null, tokenFile: config.tokenFile,
      expectKind: config.expectKind, expectProtocol: config.expectProtocol });
    this.store = store || new TaskStore(config.stateDir);
    this.worktree = worktree;
  }

  async listSessions(args) {
    const input = validateListSessions(args);
    const listed = await this.client.listSessions();
    const allowed = listed.filter((session) => {
      const bound = this.config.boundSessionIds.includes(session.sessionId);
      const cwdBound = typeof session.cwd === 'string' && this.config.boundCwds.includes(session.cwd);
      return bound || cwdBound;
    });
    const filtered = input.projectId ? allowed.filter((session) => session.cwd === input.projectId) : allowed;
    return { ok: true, host: this.client.kind, protocol: this.client.protocol, bound: this.config.boundSessionIds.length,
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
    if (input.projectId && session.cwd && input.projectId !== session.cwd) {
      fail(CODES.project_mismatch, 'the session belongs to a different cwd', {
        sessionId: input.sessionId, expected: session.cwd, got: input.projectId });
    }
    // Duplicate keys and local locks are checked by the ledger without sending a second prompt. A genuinely new
    // request additionally needs positive Host-side idle evidence; a busy/unknown session is not a queue target here.
    if (!this.store.byRequestId(input.requestId) && !this.store.activeFor(input.sessionId)) {
      assertSessionIdle(session);
    }
    const accepted = this.store.accept({ ...input, projectId: session.cwd });
    if (accepted.duplicate) {
      return { ok: true, host: this.client.kind, duplicate: true, worktree, task: this.#view(accepted.task) };
    }
    return this.#admit(accepted.task, input, worktree);
  }

  /**
   * Re-submit an unsettled task. Order of preference:
   *   1. if the durable log already holds this requestId, the earlier attempt was admitted -> no second call;
   *   2. otherwise re-submit the *same* requestId with the same text (the caller supplies it; this server keeps only
   *      the digest, and the digest must match), which rc.2 acknowledges without inserting a second message.
   */
  async reconcileTask(args) {
    const taskId = validateTaskId(args);
    const task = this.store.find(taskId);
    if (!task) fail(CODES.task_not_found, 'no such task', { taskId });
    if (task.state !== 'unsettled') {
      fail(CODES.not_reconcilable, 'only an unsettled task can be reconciled', { taskId, state: task.state });
    }
    let admission = null;
    try {
      admission = await this.client.findAdmission({ sessionId: task.sessionId, requestId: task.requestId });
    } catch (err) {
      this.store.stage(taskId, 'reconcile_evidence_unavailable', { code: err instanceof DirectError ? err.code : null });
    }
    if (admission && admission.found) {
      this.store.stage(taskId, 'admission_found_in_log', { seq: admission.seq, eventType: admission.eventType });
      this.store.transition(taskId, 'running', { turnId: null, requiresReconcile: false });
      return { ok: true, host: this.client.kind, reconciledBy: 'durable_log',
        task: this.#view(await this.#collect(taskId)) };
    }
    const prompt = args === undefined || args === null ? undefined : args.prompt;
    if (typeof prompt !== 'string' || !prompt.length) {
      fail(CODES.not_reconcilable,
        'reconcile needs the original `prompt` text: this server keeps only its digest, never the text', {
          taskId, promptSha256: task.promptSha256, reason: 'reconcile_needs_prompt' });
    }
    const digest = promptSha(prompt);
    if (digest !== task.promptSha256) {
      fail(CODES.invalid_arguments, 'the supplied prompt does not match the digest recorded for this task', {
        taskId, expected: task.promptSha256, got: digest });
    }
    const listed = await this.client.listSessions();
    const session = listed.find((item) => item.sessionId === task.sessionId);
    if (!session) fail(CODES.session_not_found, 'the bound session is absent; no reconcile prompt sent');
    assertBound(this.config, session);
    assertSessionIdle(session);
    if (this.config.worktreeRoot) {
      const check = await this.worktree(this.config.worktreeRoot);
      if (!check.clean && !this.config.allowDirtyWorktree) {
        fail(CODES.worktree_dirty, 'the worktree is dirty; no reconcile prompt sent', check);
      }
    }
    this.store.stage(taskId, 'reconcile_reprompt', { requestId: task.requestId });
    const settled = await this.#admit(task, { prompt }, null, { reconciling: true });
    return { ...settled, reconciledBy: 'idempotent_reprompt' };
  }

  /** Send (or re-send) one prompt for an existing task, then collect what the Host has. */
  async #admit(task, input, worktree, { reconciling = false } = {}) {
    if (typeof input.prompt !== 'string' || !input.prompt.length) {
      fail(CODES.not_reconcilable,
        'reconcile needs the original prompt text: this server keeps only its digest, never the text', {
          taskId: task.taskId, promptSha256: task.promptSha256 });
    }
    this.store.stage(task.taskId, reconciling ? 'host_reprompt_sent' : 'host_prompt_sent',
      { sessionId: task.sessionId, requestId: task.requestId });
    let receipt = null;
    try {
      receipt = await this.client.prompt({ sessionId: task.sessionId, text: input.prompt,
        requestId: task.requestId });
    } catch (err) {
      const code = err instanceof DirectError ? err.code : CODES.internal;
      if (REFUSAL_CODES.has(code)) {
        // The Host said no. That is an outcome, and the session is free again.
        this.store.transition(task.taskId, 'failed', { error: { code, message: String(err && err.message),
          phase: 'host_prompt' } });
        throw err;
      }
      // No answer: the prompt may already be in the Host. Keep the lock and require a reconcile.
      this.store.transition(task.taskId, 'unsettled', { error: { code, message: String(err && err.message),
        phase: 'host_prompt' }, requiresReconcile: true });
      return { ok: false, host: this.client.kind, code: CODES.task_unsettled, requiresReconcile: true,
        message: 'the prompt call got no answer; the Host may hold it, so the session stays locked until reconcile',
        worktree, task: this.#view(this.store.find(task.taskId)) };
    }
    if (receipt.accepted !== true) {
      this.store.transition(task.taskId, 'failed', { error: { code: CODES.host_refused,
        message: 'the Host did not accept the prompt', reason: receipt.reason || null } });
      return { ok: false, host: this.client.kind, worktree, task: this.#view(this.store.find(task.taskId)) };
    }
    this.store.transition(task.taskId, 'running', { turnId: receipt.turnId || null, requiresReconcile: false });
    const settled = await this.#collect(task.taskId);
    return { ok: true, host: this.client.kind, duplicate: false, worktree, task: this.#view(settled) };
  }

  /** Poll the Host a bounded number of times per call: no timers, no long-running process, no unbounded wait. */
  async #collect(taskId) {
    const task = this.store.find(taskId);
    let cursor = null;
    for (let poll = 1; poll <= this.config.maxPolls; poll += 1) {
      const page = await this.client.getEvents({ sessionId: task.sessionId, requestId: task.requestId });
      cursor = page.cursor;
      const text = page.assistantText || null;
      this.store.stage(taskId, 'host_events', { poll, events: page.events.length, done: page.done,
        admission: page.admission ? page.admission.found : null });
      // The bridge must join this exact requestId to an admitted user event and a completed same-turn terminal.
      // An old assistant message, an intermediate tool step, or an unrelated turn is never a successful result.
      if (page.admission?.found === true && page.terminal && page.terminal.kind !== 'completed') {
        return this.store.transition(taskId, 'failed', { turnId: page.turnId ?? task.turnId,
          error: { code: CODES.host_refused, phase: 'host_turn', reason: page.terminal.kind },
          result: { text, cursor, admission: page.admission, terminal: page.terminal } });
      }
      if (page.done && page.admission?.found === true && page.terminal?.kind === 'completed'
          && typeof page.turnId === 'string') {
        return this.store.transition(taskId, 'succeeded', {
          turnId: page.turnId ?? task.turnId,
          result: { text, events: page.events.map((event) => ({ seq: event.seq, kind: event.kind })), cursor, polls: poll,
            admission: page.admission },
        });
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

  async getResult(args) {
    const taskId = validateTaskId(args);
    const task = this.store.find(taskId);
    if (!task) fail(CODES.task_not_found, 'no such task', { taskId });
    // A normal model answer outlives the three immediate polls in submit_task. Subsequent reads must refresh
    // history rather than consulting a permanently running ledger. This path never calls prompt/reconcile.
    if (task.state === 'running') await this.#collect(taskId);
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
      requiresReconcile: task.requiresReconcile === true,
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
    case 'reconcile_task': return server.reconcileTask(args);
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
    // A JSON-RPC notification (no `id`) must never be answered -- including when handling it fails. Answering
    // `notifications/initialized` with an error was what a real stdio probe saw, because only the success path skipped
    // the reply: the rejection fell through to the catch below and emitted an error object with id null.
    const isNotification = request.id === undefined;
    handle(server, request).then((result) => {
      if (isNotification) return;
      send({ jsonrpc: '2.0', id, result });
    }).catch((err) => {
      if (isNotification) return;
      const error = err instanceof DirectError
        ? { code: -32000, message: err.code + ': ' + err.message, data: err.toJSON() }
        : { code: -32603, message: 'internal error', data: { message: String(err && err.message) } };
      send({ jsonrpc: '2.0', id, error });
    });
  });
}

/**
 * The one dispatcher. Both transports call this: stdio passes nothing, Streamable HTTP passes the revision it negotiated
 * during `initialize`, so a client that asked for 2024-11-05 is answered 2024-11-05 and one that asked for 2025-11-25
 * is answered that. Everything else is identical between the two transports, which is the point.
 */
export async function handle(server, request, context = {}) {
  const method = request && request.method;
  const params = (request && request.params) || {};
  if (method === 'initialize') {
    return { protocolVersion: context.protocolVersion || PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
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
    process.stderr.write('usage: mcp_server.mjs --config <dsh-direct.config.json> [--httponly]'
      + '\n  stdio is the default; config.http.enabled=true starts the Streamable HTTP transport instead\n');
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
  const server = new DirectServer(config);
  if (!config.http) {
    serve(server);
    return;
  }
  // Loaded here rather than imported at the top: the transport imports `handle` from this module, and a static import
  // in both directions would make the module graph cyclic for no reason.
  const { startHttpTransport } = await import('./http_transport.mjs');
  let started = null;
  try {
    started = await startHttpTransport({ direct: server, http: config.http });
  } catch (err) {
    process.stderr.write('dsh-direct: ' + (err instanceof DirectError ? err.code + ': ' + err.message
      : 'http_start_failed: ' + String(err && err.message)) + '\n');
    process.exitCode = 1;
    return;
  }
  process.stderr.write('dsh-direct: MCP Streamable HTTP on ' + started.base + ' (loopback only, '
    + config.http.allowedOrigins.length + ' allowed origin(s), ' + config.boundSessionIds.length + ' bound session(s))\n');
  const shutdown = async () => {
    await started.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
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
