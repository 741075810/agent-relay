// DSH Direct: the exact wire shapes of `@deepseek-ai/dsh-api-session-controller` **0.2.0-rc.2**.
//
// T271 guessed this API (`listSessions` / `prompt({sessionId,text,requestId})` / `getEvents`). That guess was wrong
// for the version installed on this machine, and this file replaces it with what the shipped bytes actually say.
// Every fact below is quoted from the installed package, not from `master`:
//
//   list(request: SessionListRequest, signal): Promise<SessionListValue>
//       summary in  ...\dsh-api-session-controller\lib\typert.host.js  (catalog entry "session/list")
//       SessionListValue = { items: readonly SessionSummary[] }        (dsh-tool-cordis api-catalog.js)
//       SessionSummary   = { agentAvailable, sessionId, updatedAt, running, blank,
//                            parentSessionId?, origin?, cwd?, projections? }
//   prompt(request: SessionPromptRequest, signal): Promise<SessionPromptValue>
//       SessionPromptRequest = { requestId, sessionId, mode: 'queue' | 'steer',
//                                content: readonly PromptContentPart[], clientTimeZone? }
//       SessionPromptValue   = { accepted: true }
//   page(request: SessionPageRequest, signal): Promise<SessionPage>
//       SessionPageRequest = { address, throughSeq, beforeSeq?, maxMessages?, turnWindow? }
//       SessionPage        = { records: readonly SessionHistoryRecord[], hasMore: boolean }
//       throughSeq === -1 means the EMPTY prefix (paginate ends at throughSeq + 1).
//   projections({ sessionId }, signal) -> { asOfSeq, values } | null supplies the cold-safe current cursor.
//   follow / control are *streams*; follow may activate a cold Agent, so history reads use projections + page.
//
// Two facts from `lib/index.js` decide the whole submission story, so they are encoded here:
//
//   line 851: prompt rejects content with no non-blank text and no attachment;
//   line 855: `if (hasPromptRequest(agent, request.requestId)) return { accepted: true }`
//             -- re-submitting the same requestId is *acknowledged without re-inserting*.
//
// That second fact is why a lost response is recoverable: the safe move is to retry the same requestId, never to
// invent a second one. `session_api` therefore treats `requestId` as the single identity of one admission attempt.

import { CODES, DirectError, fail } from './protocol.mjs';

/** The Remote methods this module needs. `page` replaced T271's invented `getEvents`. */
export const REMOTE_METHODS = Object.freeze(['list', 'prompt', 'page', 'projections']);

/** `session/*` and `gateway/*` codes reach us as `err.code` from RemoteError. Map the ones we act on. */
export function mapRemoteError(err) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  const message = err && typeof err.message === 'string' ? err.message : String(err && err.message);
  switch (code) {
    case 'session/not-found':
      return new DirectError(CODES.session_not_found, message, { remoteCode: code });
    case 'session/writer-held':
      return new DirectError(CODES.session_writer_held, message, { remoteCode: code });
    case 'session/agent-busy':
      return new DirectError(CODES.session_busy, message, { remoteCode: code });
    case 'session/model-unavailable':
    case 'session/provider-models-unavailable':
      return new DirectError(CODES.host_refused, message, { remoteCode: code });
    case 'session/attachment-invalid':
    case 'session/invalid-time-zone':
    case 'gateway/bad-request':
      return new DirectError(CODES.invalid_arguments, message, { remoteCode: code });
    case 'gateway/cancelled':
      return new DirectError(CODES.cancelled, message, { remoteCode: code });
    default:
      return new DirectError(CODES.host_error, message, { remoteCode: code });
  }
}

export function isTransportLoss(err) {
  // A rejected promise we cannot attribute to a Host refusal is treated as "the answer never arrived": the call may
  // or may not have been admitted. `mapRemoteError` covers what the Host says on purpose; everything else (socket
  // closed, gateway uplink lost, stream carrier gone, timeout) is a loss.
  if (err instanceof DirectError) return err.code === CODES.cancelled || err.code === CODES.host_error
    || err.code === CODES.host_unreachable;
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (code.startsWith('session/') || code.startsWith('gateway/bad-request')) return false;
  return true;
}

function requireRow(raw) {
  if (!raw || typeof raw !== 'object') fail(CODES.internal, 'a Session row is not an object');
  if (typeof raw.sessionId !== 'string' || !raw.sessionId.length) {
    fail(CODES.internal, 'a Session row has no sessionId');
  }
  return {
    sessionId: raw.sessionId,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
    running: typeof raw.running === 'boolean' ? raw.running : null,
    blank: raw.blank === true,
    agentAvailable: raw.agentAvailable === true,
    parentSessionId: typeof raw.parentSessionId === 'string' ? raw.parentSessionId : null,
    origin: typeof raw.origin === 'string' ? raw.origin : null,
  };
}

/**
 * `list` is typed `{ items }` in the published type, while the service class returned a bare array in the bytes we
 * read (`lib/index.js`, `async list(signal) { ... return items; }`). Both are accepted, and which one was seen is
 * reported back so a receipt can say what the Host actually did instead of what we expected.
 */
export function normalizeList(value) {
  if (Array.isArray(value)) return { rows: value.map(requireRow), shape: 'array' };
  if (value && typeof value === 'object' && Array.isArray(value.items)) {
    return { rows: value.items.map(requireRow), shape: 'items' };
  }
  fail(CODES.internal, 'sessionController.list() returned neither { items } nor an array', {
    got: value === null ? 'null' : typeof value });
}

/** One prompt request, exactly as rc.2 declares it. `mode: 'queue'` matches `agent.followup` in the Host. */
export function buildPromptRequest({ requestId, sessionId, text, clientTimeZone }) {
  if (typeof text !== 'string' || !text.trim().length) {
    fail(CODES.invalid_arguments, 'a prompt needs non-blank text');
  }
  const request = {
    requestId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  };
  if (typeof clientTimeZone === 'string' && clientTimeZone.length) request.clientTimeZone = clientTimeZone;
  return request;
}

/** `{ accepted: true }` is the only success shape; anything else is not an acceptance. */
export function readPromptValue(value) {
  if (value && value.accepted === true) return { accepted: true };
  return { accepted: false, reason: 'host_did_not_accept' };
}

/** An exact inclusive history cut; -1 is empty, never a request for the newest page. */
export function buildPageRequest({ sessionId, throughSeq, beforeSeq, maxMessages = 60 }) {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < -1 || Object.is(throughSeq, -0)) {
    fail(CODES.invalid_arguments, 'page needs an explicit throughSeq cursor greater than or equal to -1');
  }
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
    fail(CODES.invalid_arguments, 'maxMessages must be a positive safe integer');
  }
  const request = { address: { kind: 'session', sessionId }, throughSeq, maxMessages };
  if (beforeSeq !== undefined) {
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || Object.is(beforeSeq, -0)) {
      fail(CODES.invalid_arguments, 'beforeSeq must be a non-negative safe integer');
    }
    request.beforeSeq = beforeSeq;
  }
  return request;
}

export function normalizePage(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.records)) {
    fail(CODES.internal, 'sessionController.page() returned no records array');
  }
  return { records: value.records, hasMore: value.hasMore === true };
}

/** rc.2 appends the UserMessage itself as event.data, not event.data.message. */
function isAdmission(event, requestId) {
  return typeof requestId === 'string' && requestId.length > 0 && event?.type === 'user/message'
    && event.data?.source?.kind === 'user' && event.data.source.rpcId === requestId;
}

export function findAdmission(records, requestId) {
  const event = Array.isArray(records) ? records.find((record) => isAdmission(record?.event, requestId))?.event : null;
  return event ? { found: true, seq: event.seq, eventType: event.type }
    : { found: false, seq: null, eventType: null };
}

/** Only literal text blocks, never reasoning text or a tool argument named `text`. */
function messageText(message) {
  const text = (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n').trim();
  return text || null;
}

/** Correlate one request to its enclosing turn and the matching durable turn/end. */
export function correlateResult(records, requestId) {
  const events = Array.isArray(records) ? records.map((record) => record?.event).filter(Boolean) : [];
  const admission = findAdmission(records, requestId);
  const result = { admission, turnId: null, terminal: null, done: false, assistantText: null };
  const at = events.findIndex((event) => isAdmission(event, requestId));
  if (at < 0) return result;
  let start = at - 1;
  while (start >= 0 && events[start].type !== 'turn/start' && events[start].type !== 'turn/end') start -= 1;
  const turn = events[start]?.type === 'turn/start' ? events[start].data?.turn : undefined;
  if (!Number.isSafeInteger(turn) || turn < 0) return result;
  result.turnId = String(turn);
  let lastAssistant = null;
  for (let i = at + 1; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === 'turn/start') break;
    if (event.type === 'assistant/message' && event.data?.turn === turn) lastAssistant = event.data;
    if (event.type !== 'turn/end') continue;
    if (event.data?.turn !== turn || typeof event.data.reason?.kind !== 'string') break;
    result.terminal = { kind: event.data.reason.kind, seq: event.seq };
    // A tool step can have text too; only the final non-tool, uninterrupted assistant message is an answer.
    const content = lastAssistant?.message?.content;
    if (result.terminal.kind === 'completed' && lastAssistant?.interrupted !== true
        && Array.isArray(content) && !content.some((part) => part?.type === 'tool-call')) {
      result.assistantText = messageText(lastAssistant.message);
      result.done = result.assistantText !== null;
    }
    break;
  }
  return result;
}

/** Result extraction always requires a request id and a matching completed turn. */
export function extractAssistantText(records, requestId) {
  return correlateResult(records, requestId).assistantText;
}

/** True when a page contains any event newer than `afterSeq`. */
export function newestSeq(records) {
  let max = -1;
  if (!Array.isArray(records)) return max;
  for (const record of records) {
    const seq = record && record.event && record.event.seq;
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}
