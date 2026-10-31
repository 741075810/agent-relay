// T095B153: what a *real* continuation transport must prove before it is allowed anywhere near this
// code, and a read-only adapter that is honest about what it can do.
//
// The finding this file encodes, established read-only from the installed packages:
//
//   * DSH's Bridge surface is `@codex-bridge/dsh-desktop-connector` v1.0.0, protocol
//     `codex-bridge-dsh/1`. `transport.mjs` builds it with `net.createServer`, and its dispatch table
//     is `pairing/state|request|revoke`, `project/sync`, `run/start|observe|steer|cancel`,
//     `session/list|open|read|rename|event`. Every one of those is the Bridge asking DSH. `index.mjs`
//     adds `/api/codex-bridge-desktop` forwarding a Bridge `client-request` into `clientRpc` -- the
//     same direction again.
//   * `mcp__Codex_Bridge__list_tasks|get_task|submit_task` are tools of the ChatGPT client. Their
//     existence there is not a capability of the DSH host process, which registers no such client.
//
// So: no outbound, documented, supported channel exists from here today. Rather than fake one, the
// contract below makes that state explicit and machine-checkable. An adapter declares its direction
// and its documentation; anything inbound-only, undocumented, or missing a read-only page is
// refused. The read-only adapter requires an injected client, so an environment without one reports
// `unavailable` instead of inventing traffic.

export const DIRECTIONS = ['outbound', 'inbound'];

export const READ_ONLY_OPS = ['listTasks', 'getTask'];

export const ALLOWED_TOOLS = ['list_tasks', 'get_task'];

function problem(code, reason) {
  return { code, reason: reason || code, ok: false };
}

/** Validate a capability declaration. `null` code means the declaration is acceptable. */
export function validateCapability(declaration) {
  if (!declaration || typeof declaration !== 'object') {
    return problem('declaration_missing', 'no capability was declared');
  }
  const { api, version, direction, docsRef, ops } = declaration;
  if (typeof api !== 'string' || api.length === 0) return problem('declaration_missing', 'api');
  if (typeof version !== 'string' || version.length === 0) {
    return problem('declaration_missing', 'version');
  }
  if (typeof docsRef !== 'string' || docsRef.length === 0) {
    return problem('docs_ref_missing',
      'a transport without a documented interface cannot be verified, so it is not usable');
  }
  if (!DIRECTIONS.includes(direction)) return problem('declaration_missing', 'direction');
  if (direction === 'inbound') {
    return problem('direction_not_outbound',
      'this interface is inbound: it receives Bridge requests, so it cannot list or submit tasks '
      + 'from this process');
  }
  if (!ops || typeof ops !== 'object') return problem('op_unsupported', 'ops');
  for (const op of READ_ONLY_OPS) {
    if (ops[op] !== true) {
      return problem('op_unsupported', 'missing read-only operation: ' + op);
    }
  }
  return { code: null, ok: true, reason: null };
}

/**
 * What this process can actually do right now. `state: 'unavailable'` is the honest answer in an
 * environment with no outbound Bridge channel, and it is the answer this repository ships.
 */
export async function probeEnvironment(evidence = {}) {
  return {
    state: 'unavailable',
    code: 'no_supported_outbound_channel',
    evidence: {
      connectorDirection: 'inbound',
      connectorProtocol: 'codex-bridge-dsh/1',
      connectorMethods: ['pairing/state', 'pairing/request', 'pairing/revoke', 'project/sync',
        'run/start', 'run/observe', 'run/steer', 'run/cancel',
        'session/list', 'session/open', 'session/read', 'session/rename', 'session/event'],
      mcpClientInHost: false,
      needed: 'a documented outbound channel (or an injected, authorised MCP client) before any '
        + 'adapter can be used',
      ...evidence,
    },
  };
}

/**
 * Probe an injected client. Nothing here creates a client, opens a socket, or reads a config: with
 * no client the transport is unavailable, and submission is refused whether or not a grant exists.
 */
export async function probe({ capability, client, grant } = {}) {
  const verdict = validateCapability(capability);
  if (verdict.code !== null) return { state: 'unavailable', code: verdict.code,
    reason: verdict.reason, canSubmit: false };
  if (!client || typeof client.callTool !== 'function') {
    return { state: 'unavailable', code: 'client_absent', canSubmit: false,
      reason: 'no client was injected; this process has no Bridge MCP client of its own',
      canRead: false };
  }
  const canSubmit = submitAllowed(capability, grant);
  return { state: 'read_only', code: canSubmit.code, canSubmit: canSubmit.ok, canRead: true,
    reason: canSubmit.reason, grant: grant ? grant.kind : null };
}

function submitAllowed(capability, grant) {
  if (!grant || grant.kind !== 'continuation') {
    return { ok: false, code: 'submit_not_authorised',
      reason: 'a continuation grant is required; page-notice grants do not authorise execution' };
  }
  if (capability.ops.submitTask !== true) {
    return { ok: false, code: 'op_unsupported', reason: 'the declaration does not offer submission' };
  }
  // Even fully authorised, this repository has no supported submit implementation to call. Saying so
  // is the point: the alternative is a fake that would look like progress.
  return { ok: false, code: 'submit_not_implemented',
    reason: 'no documented submission path exists for the DSH host process' };
}

function redactTask(task) {
  if (!task || typeof task !== 'object') return null;
  const out = { id: String(task.id), status: String(task.status ?? 'unknown') };
  if (typeof task.title === 'string') out.title = task.title;
  out.promptRedacted = typeof task.prompt === 'string' || typeof task.body === 'string';
  out.at = Number.isFinite(task.at) ? task.at : null;
  return out;
}

function normalizeList(reply) {
  if (!reply || typeof reply !== 'object') throw new Error('invalid_upstream_shape: not an object');
  const raw = Array.isArray(reply.tasks) ? reply.tasks
    : (Array.isArray(reply.items) ? reply.items : null);
  if (raw === null) throw new Error('invalid_upstream_shape: no task array');
  const tasks = raw.map(redactTask).filter((task) => task && task.id);
  const cursor = reply.next_cursor ?? reply.nextCursor ?? null;
  return { tasks, nextCursor: typeof cursor === 'string' && cursor.length > 0 ? cursor : null };
}

/**
 * Read-only adapter over an injected client. It can list and fetch; it cannot submit, cancel or run
 * anything, and it refuses tool names outside `ALLOWED_TOOLS` before any call is made.
 */
export function createReadOnlyAdapter({ capability, client } = {}) {
  const verdict = validateCapability(capability);
  if (verdict.code !== null) {
    const err = new Error(verdict.code + ': ' + verdict.reason);
    err.code = verdict.code;
    throw err;
  }
  if (!client || typeof client.callTool !== 'function') {
    const err = new Error('client_absent: no client injected');
    err.code = 'client_absent';
    throw err;
  }

  const adapter = {
    capability: { api: capability.api, version: capability.version, docsRef: capability.docsRef },
    async listTasks({ cursor = null, limit = 50 } = {}) {
      const reply = await client.callTool('list_tasks', { cursor, limit });
      return normalizeList(reply);
    },
    async getTask(id) {
      if (typeof id !== 'string' || id.length === 0) throw new Error('invalid_task_id');
      const reply = await client.callTool('get_task', { id });
      if (!reply || typeof reply !== 'object') {
        throw new Error('invalid_upstream_shape: task is not an object');
      }
      const task = redactTask(reply);
      if (!task || !task.id) throw new Error('invalid_upstream_shape: task has no id');
      return task;
    },
    async callRaw(tool, args = {}) {
      if (!ALLOWED_TOOLS.includes(tool)) return 'tool_not_allowed';
      const reply = await client.callTool(tool, args);
      return reply;
    },
    async submitTask() {
      const err = new Error('submit_not_implemented: no supported submission path for this process');
      err.code = 'submit_not_implemented';
      throw err;
    },
  };
  return adapter;
}
