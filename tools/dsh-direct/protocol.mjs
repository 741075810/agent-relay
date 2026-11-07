// DSH Direct: shared protocol, error taxonomy and argument validation.
//
// This module is deliberately boring and dependency-free: it is the single place that decides what a caller may
// say and what an error is called. Every refusal has a `code` -- "could not reach the Host" and "the Host has no
// such session" are different facts here, the same way they are in the relay code.

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'dsh-direct';
export const SERVER_VERSION = '0.1.0';

// The MCP revisions this server can speak, newest first. `initialize` echoes the client's version when it is one of
// these and offers `LATEST_PROTOCOL_VERSION` otherwise, which is what the specification asks a server to do when it does
// not support the requested revision.
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
/** stdio existed in every revision, so this transport may speak all of them. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
/**
 * Streamable HTTP was introduced in the 2025-03-26 revision. Offering `2024-11-05` here would be a claim that cannot
 * be true: that revision has no such transport, so a client asking for it could not have meant this endpoint. The stdio
 * set keeps 2024-11-05; this one starts at 2025-03-26.
 */
export const SUPPORTED_HTTP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);

/** Every refusal this module can produce. Stable strings: the tests and the operator both match on them. */
export const CODES = Object.freeze({
  // request shape
  invalid_arguments: 'invalid_arguments',
  unknown_tool: 'unknown_tool',
  // identity / authorisation
  unauthenticated: 'unauthenticated',
  not_bound: 'not_bound',
  session_not_found: 'session_not_found',
  project_mismatch: 'project_mismatch',
  // transport (Streamable HTTP). None of these ever reached the Host, so none of them may touch a session lock.
  method_not_allowed: 'method_not_allowed',
  origin_rejected: 'origin_rejected',
  body_too_large: 'body_too_large',
  unsupported_accept: 'unsupported_accept',
  unsupported_content_type: 'unsupported_content_type',
  too_many_requests: 'too_many_requests',
  unsupported_protocol_version: 'unsupported_protocol_version',
  session_required: 'session_required',
  request_timeout: 'request_timeout',
  http_disabled: 'http_disabled',
  // the port answered, but it is not the bridge we expect there (stale endpoint file, or another local program);
  // nothing was sent, so this is a refusal and never a reason to keep the session locked
  host_identity_mismatch: 'host_identity_mismatch',
  // the plugin could not bind its loopback port at all (EADDRINUSE); also nothing sent
  bind_failed: 'bind_failed',
  // lifecycle
  request_conflict: 'request_conflict',
  session_busy: 'session_busy',
  session_writer_held: 'session_writer_held',
  task_not_found: 'task_not_found',
  task_not_finished: 'task_not_finished',
  task_unsettled: 'task_unsettled',
  not_reconcilable: 'not_reconcilable',
  // environment
  host_unreachable: 'host_unreachable',
  host_capability_missing: 'host_capability_missing',
  host_refused: 'host_refused',
  host_error: 'host_error',
  cancelled: 'cancelled',
  worktree_dirty: 'worktree_dirty',
  state_unreadable: 'state_unreadable',
  internal: 'internal',
});

// `unsettled` is the state a submission enters when the answer never arrived but the Host may already have the
// prompt. It keeps the session lock and refuses `get_result` until `reconcile_task` re-submits the same requestId.
export const TASK_STATES = Object.freeze(['accepted', 'running', 'succeeded', 'failed', 'unsettled', 'unknown']);
export const ACTIVE_STATES = Object.freeze(['accepted', 'running', 'unsettled']);

/** The token file must hold at least this many characters. Length only; the value is never logged or returned. */
export const MIN_TOKEN_CHARS = 32;

export const HTTP_PATH_DEFAULT = '/mcp';
export const MAX_BODY_DEFAULT = 1048576;
export const REQUEST_TIMEOUT_DEFAULT = 120000;
export const MAX_SESSIONS_DEFAULT = 16;

/** The keys `config.http` may contain. Exported so the preflight and the docs check use the list the server enforces. */
export const HTTP_CONFIG_FIELDS = Object.freeze(['enabled', 'host', 'port', 'path', 'authTokenFile', 'allowedOrigins',
  'maxBodyBytes', 'requestTimeoutMs', 'maxSessions', 'maxConcurrentRequests']);
export const MAX_CONCURRENT_DEFAULT = 8;

/**
 * Validate the optional `http` block. Returns `null` when the transport is off, which is the default: this is a
 * deliberate opt-in, not something a profile can enable by accident or by writing `"true"` in a string.
 */
export function loadHttpConfig(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(CODES.invalid_arguments, 'config.http must be an object');
  const unknown = Object.keys(raw).filter((key) => !key.startsWith('$') && !HTTP_CONFIG_FIELDS.includes(key));
  if (unknown.length) {
    fail(CODES.invalid_arguments, 'config.http has fields this server does not read: ' + unknown.join(', '),
      { fields: unknown });
  }
  if (raw.enabled === false || raw.enabled === undefined) return null;
  if (raw.enabled !== true) {
    fail(CODES.invalid_arguments, 'config.http.enabled must be the boolean true to enable the HTTP transport',
      { enabled: raw.enabled });
  }
  const host = raw.host === undefined ? '127.0.0.1' : raw.host;
  if (host !== '127.0.0.1') {
    fail(CODES.invalid_arguments, 'config.http.host must be 127.0.0.1; this transport refuses to listen anywhere else',
      { host });
  }
  const port = raw.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail(CODES.invalid_arguments, 'config.http.port must be an integer in 1024..65535', { port });
  }
  const urlPath = raw.path === undefined ? HTTP_PATH_DEFAULT : raw.path;
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/') || urlPath.includes('..') || urlPath.length > 128) {
    fail(CODES.invalid_arguments, 'config.http.path must start with "/" and contain no ".."', { path: urlPath });
  }
  if (typeof raw.authTokenFile !== 'string' || !raw.authTokenFile) {
    fail(CODES.invalid_arguments, 'config.http.authTokenFile is required: an unauthenticated loopback listener is still '
      + 'reachable from a browser', { field: 'authTokenFile' });
  }
  const allowedOrigins = raw.allowedOrigins === undefined ? [] : raw.allowedOrigins;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((value) => typeof value !== 'string' || !value)) {
    fail(CODES.invalid_arguments, 'config.http.allowedOrigins must be an array of origin strings', { allowedOrigins });
  }
  const maxBodyBytes = raw.maxBodyBytes === undefined ? MAX_BODY_DEFAULT : raw.maxBodyBytes;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 8388608) {
    fail(CODES.invalid_arguments, 'config.http.maxBodyBytes must be an integer in 1024..8388608', { maxBodyBytes });
  }
  const requestTimeoutMs = raw.requestTimeoutMs === undefined ? REQUEST_TIMEOUT_DEFAULT : raw.requestTimeoutMs;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 50 || requestTimeoutMs > 600000) {
    fail(CODES.invalid_arguments, 'config.http.requestTimeoutMs must be an integer in 50..600000',
      { requestTimeoutMs });
  }
  const maxSessions = raw.maxSessions === undefined ? MAX_SESSIONS_DEFAULT : raw.maxSessions;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 256) {
    fail(CODES.invalid_arguments, 'config.http.maxSessions must be an integer in 1..256', { maxSessions });
  }
  const maxConcurrentRequests = raw.maxConcurrentRequests === undefined ? MAX_CONCURRENT_DEFAULT
    : raw.maxConcurrentRequests;
  if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || maxConcurrentRequests > 64) {
    fail(CODES.invalid_arguments, 'config.http.maxConcurrentRequests must be an integer in 1..64',
      { maxConcurrentRequests });
  }
  return { enabled: true, host, port, path: urlPath, authTokenFile: raw.authTokenFile,
    allowedOrigins: allowedOrigins.slice(), maxBodyBytes, requestTimeoutMs, maxSessions, maxConcurrentRequests };
}

export class DirectError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DirectError';
    this.code = code;
    this.details = details === undefined ? null : details;
  }
  toJSON() {
    return { ok: false, code: this.code, message: this.message, details: this.details };
  }
}

export function fail(code, message, details) {
  throw new DirectError(code, message, details);
}

const SESSION_ID = /^(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
// 0.2.0-rc.2 rows carry `cwd` (a workspace path), not a project id; both spellings are accepted for the filter.
const PROJECT_OR_CWD = /^[^\u0000-\u001f]{1,512}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;
const TASK_ID = /^dshd-[0-9a-f]{16}$/;

export const isSessionId = (value) => typeof value === 'string' && SESSION_ID.test(value);
export const isProjectId = (value) => typeof value === 'string' && PROJECT_OR_CWD.test(value);
export const isRequestId = (value) => typeof value === 'string' && REQUEST_ID.test(value);
export const isTaskId = (value) => typeof value === 'string' && TASK_ID.test(value);

export const MAX_PROMPT_CHARS = 32000;

function requireString(args, key, pattern, code = CODES.invalid_arguments) {
  const value = args[key];
  if (typeof value !== 'string' || !value.length) {
    fail(code, '`' + key + '` must be a non-empty string', { field: key });
  }
  if (pattern && !pattern.test(value)) {
    fail(code, '`' + key + '` is not in the accepted shape', { field: key, value: String(value).slice(0, 80) });
  }
  return value;
}

/** `list_sessions` takes only an optional project filter. */
export function validateListSessions(args) {
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== 'object' || Array.isArray(input)) fail(CODES.invalid_arguments, 'arguments must be an object');
  const out = {};
  if (input.projectId !== undefined && input.projectId !== null) {
    out.projectId = requireString(input, 'projectId', PROJECT_OR_CWD);
  }
  return out;
}

/** `submit_task` never creates a session: the id must be an existing, bound one. */
export function validateSubmitTask(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    fail(CODES.invalid_arguments, 'arguments must be an object');
  }
  const requestId = requireString(args, 'requestId', REQUEST_ID);
  const sessionId = requireString(args, 'sessionId', SESSION_ID);
  const prompt = args.prompt;
  if (typeof prompt !== 'string' || !prompt.trim().length) {
    fail(CODES.invalid_arguments, '`prompt` must be a non-empty string', { field: 'prompt' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    fail(CODES.invalid_arguments, '`prompt` is longer than the accepted maximum', { field: 'prompt',
      maxChars: MAX_PROMPT_CHARS, chars: prompt.length });
  }
  const out = { requestId, sessionId, prompt };
  if (args.projectId !== undefined && args.projectId !== null) out.projectId = requireString(args, 'projectId', PROJECT_OR_CWD);
  if (args.cwd !== undefined && args.cwd !== null) out.projectId = requireString(args, 'cwd', PROJECT_OR_CWD);
  if (args.createSession !== undefined) {
    // Named explicitly so the refusal is legible instead of "unknown argument".
    fail(CODES.not_bound, 'this server never creates a session; omit `createSession`', { field: 'createSession' });
  }
  return out;
}

export function validateTaskId(args, key = 'taskId') {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    fail(CODES.invalid_arguments, 'arguments must be an object');
  }
  return requireString(args, key, TASK_ID);
}

/** The tool surface, as MCP expects it. Kept next to the validators so they cannot drift apart. */
export const TOOLS = Object.freeze([
  {
    name: 'list_sessions',
    description: 'List the DSH sessions this server is bound to. Read-only; never creates a session.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Optional cwd/workspace filter (0.2.0-rc.2 rows carry cwd).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'submit_task',
    description: 'Submit one prompt into an EXISTING bound DSH session. No session is ever created. '
      + 'Requires confirmed Host idle/availability; idempotent on `requestId`; one active task per session.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Caller-chosen idempotency key (8-80 chars).' },
        sessionId: { type: 'string', description: 'An existing session id (session-<uuid>).' },
        prompt: { type: 'string', description: 'The text to deliver as one turn.' },
        projectId: { type: 'string', description: 'Optional; must equal the session\'s own cwd. `cwd` is accepted as an alias.' },
      },
      required: ['requestId', 'sessionId', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    description: 'Read one task: state plus the stages recorded so far. No side effects.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_result',
    description: 'Refresh bounded Host history for a running task, without sending another prompt, then read its result. '
      + 'Returns task_not_finished while still active, or task_unsettled when admission must be reconciled first.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'reconcile_task',
    description: 'Re-submit an unsettled task with its original requestId. The Host acknowledges a repeated '
      + 'requestId without inserting a second message, so this cannot duplicate a prompt; it settles whether the '
      + 'earlier attempt was admitted. Pass `prompt` when the Host has no admission evidence yet: this server keeps '
      + 'only the digest, and the text must hash to it.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        prompt: { type: 'string', description: 'The original prompt text; must match the recorded digest.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
]);

export function toolByName(name) {
  return TOOLS.find((tool) => tool.name === name) || null;
}
