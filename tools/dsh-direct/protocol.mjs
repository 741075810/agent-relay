// DSH Direct: shared protocol, error taxonomy and argument validation.
//
// This module is deliberately boring and dependency-free: it is the single place that decides what a caller may
// say and what an error is called. Every refusal has a `code` -- "could not reach the Host" and "the Host has no
// such session" are different facts here, the same way they are in the relay code.

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_NAME = 'dsh-direct';
export const SERVER_VERSION = '0.1.0';

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
  // lifecycle
  request_conflict: 'request_conflict',
  session_busy: 'session_busy',
  task_not_found: 'task_not_found',
  task_not_finished: 'task_not_finished',
  // environment
  host_unreachable: 'host_unreachable',
  host_capability_missing: 'host_capability_missing',
  worktree_dirty: 'worktree_dirty',
  state_unreadable: 'state_unreadable',
  internal: 'internal',
});

export const TASK_STATES = Object.freeze(['accepted', 'running', 'succeeded', 'failed', 'unknown']);
export const ACTIVE_STATES = Object.freeze(['accepted', 'running']);

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
const PROJECT_ID = /^(prj-[0-9a-z][0-9a-z-]{2,62})$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;
const TASK_ID = /^dshd-[0-9a-f]{16}$/;

export const isSessionId = (value) => typeof value === 'string' && SESSION_ID.test(value);
export const isProjectId = (value) => typeof value === 'string' && PROJECT_ID.test(value);
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
    out.projectId = requireString(input, 'projectId', PROJECT_ID);
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
  if (args.projectId !== undefined && args.projectId !== null) out.projectId = requireString(args, 'projectId', PROJECT_ID);
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
      properties: { projectId: { type: 'string', description: 'Optional project filter (prj-...).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'submit_task',
    description: 'Submit one prompt into an EXISTING bound DSH session. No session is ever created. '
      + 'Idempotent on `requestId`; one active task per session.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Caller-chosen idempotency key (8-80 chars).' },
        sessionId: { type: 'string', description: 'An existing session id (session-<uuid>).' },
        prompt: { type: 'string', description: 'The text to deliver as one turn.' },
        projectId: { type: 'string', description: 'Optional; must match the session\'s own project.' },
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
    description: 'Read the result of a finished task. Refuses with task_not_finished while it is still active.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
]);

export function toolByName(name) {
  return TOOLS.find((tool) => tool.name === name) || null;
}
