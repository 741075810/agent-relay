// DSH Direct: the Host adapter contract, the rc.2 adapter, and the offline fake.
//
// T271 shipped an adapter that invented `listSessions` / `prompt({sessionId, text, requestId})` / `getEvents`.
// `session_api.mjs` records what `@deepseek-ai/dsh-api-session-controller@0.2.0-rc.2` actually declares
// (`list` / `prompt` / `page`), and this file is the only place that touches those methods.
//
// The honesty boundary is unchanged and now sharper:
//
//   * `createSessionControllerAdapter()` probes the object it is handed. The probe requires exactly the rc.2 methods
//     `list`, `prompt`, `page`; a Host that offers the old guesses instead is refused with `host_capability_missing`
//     and the missing/required/available lists, so a version mismatch reads as a version mismatch;
//   * `createFakeHost()` is rc.2-shaped, including the one behaviour that matters for lost responses: a repeated
//     `requestId` is acknowledged **without** admitting a second message. It labels itself `offline_fake` all the way
//     into the MCP result.

import { CODES, DirectError, fail } from './protocol.mjs';
import {
  REMOTE_METHODS, buildPageRequest, buildPromptRequest, extractAssistantText, findAdmission, mapRemoteError,
  normalizeList, normalizePage, readPromptValue,
} from './session_api.mjs';

export { REMOTE_METHODS as REQUIRED_SESSION_CONTROLLER };

export function describeCapabilities(candidate) {
  const available = [];
  const missing = [];
  for (const name of REMOTE_METHODS) {
    const value = candidate ? candidate[name] : undefined;
    (typeof value === 'function' ? available : missing).push(name);
  }
  return { available, missing, required: REMOTE_METHODS.slice(),
    // Named so a receipt can show *why* a probe failed on an older build: T271's guessed names are not present.
    legacyGuessPresent: ['listSessions', 'getEvents'].filter((name) => typeof (candidate ? candidate[name] : undefined)
      === 'function') };
}

/**
 * Adapt `ctx.sessionController`. The returned object is the neutral shape the bridge publishes over loopback:
 *
 *   listSessions()                                     -> rows (from list() -> { items } | array)
 *   prompt({ sessionId, text, requestId, clientTimeZone? }) -> { accepted, turnId | null, reason | null }
 *   getEvents({ sessionId, throughSeq=-1, maxMessages })    -> newest page mapped to assistant text + admission
 *   findAdmission({ sessionId, requestId })                -> { found, seq, eventType }
 *
 * Errors the Host raises deliberately are mapped by `mapRemoteError`; everything else propagates as a transport loss,
 * which the MCP server treats as "unknown, reconcile with the same requestId".
 */
export function createSessionControllerAdapter(candidate, { kind = 'cordis_session_controller' } = {}) {
  const caps = describeCapabilities(candidate);
  if (caps.missing.length) {
    throw new DirectError(CODES.host_capability_missing,
      'the Host does not offer the session-controller methods 0.2.0-rc.2 declares',
      { kind, missing: caps.missing, required: caps.required, available: caps.available,
        legacyGuessPresent: caps.legacyGuessPresent });
  }

  /**
   * rc.2's host-side `prompt(request, signal)` and `page(request, signal)` call `signal.throwIfAborted()` **without**
   * optional chaining (`lib/index.js:3096` and `:1419`), so an omitted signal is not a no-op: it is
   * `Cannot read properties of undefined (reading 'throwIfAborted')`, thrown after the request was already sent. A real
   * AbortSignal is therefore mandatory, and a timeout is the only cancellation this side can originate.
   */
  const CALL_SIGNAL_TIMEOUT_MS = 120000;
  function callSignal() {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(CALL_SIGNAL_TIMEOUT_MS);
    }
    return new AbortController().signal;
  }

  async function call(method, ...args) {
    try {
      return await candidate[method](...args);
    } catch (err) {
      throw mapRemoteError(err);
    }
  }

  return {
    kind,
    protocol: 'dsh-api-session-controller@0.2.0-rc.2',
    capabilities: () => describeCapabilities(candidate),
    async listSessions() {
      // `list(_request, signal)` reaches `signal?.throwIfAborted()`, which tolerates an absent signal, so the request
      // object is the only argument this one needs.
      const value = await call('list', {});
      const { rows, shape } = normalizeList(value);
      // `shape` travels with the data: rc.2's type says { items }, the service class returned an array.
      return rows.map((row) => ({ ...row, listShape: shape }));
    },
    async prompt({ sessionId, text, requestId, clientTimeZone }) {
      const request = buildPromptRequest({ requestId, sessionId, text, clientTimeZone });
      const value = await call('prompt', request, callSignal());
      return { ...readPromptValue(value), requestId };
    },
    async getEvents({ sessionId, throughSeq = -1, maxMessages }) {
      const value = await call('page', buildPageRequest({ sessionId, throughSeq, maxMessages }), callSignal());
      const { records, hasMore } = normalizePage(value);
      return {
        events: records.map((record) => {
          const event = record && record.event ? record.event : null;
          return { seq: Number.isFinite(event && event.seq) ? event.seq : null,
            kind: event && typeof event.type === 'string' ? event.type : 'unknown',
            data: event ? event.data : null };
        }),
        records,
        hasMore,
        assistantText: extractAssistantText(records),
      };
    },
    /** Proof that one requestId reached the durable log, used by reconciliation. */
    async findAdmission({ sessionId, requestId, maxMessages = 120 }) {
      const value = await call('page', buildPageRequest({ sessionId, throughSeq: -1, maxMessages }), callSignal());
      const { records } = normalizePage(value);
      return findAdmission(records, requestId);
    },
  };
}

/**
 * An offline Host for tests, shaped like rc.2. Deterministic, in-process, and labelled at every layer it can be.
 *
 * `admissions` counts accepted prompts; a repeated `requestId` is acknowledged without incrementing it, which is the
 * one property the whole reconcile story rests on. `loseNextResponse` makes the next prompt be admitted and *then*
 * fail on the way back -- the exact failure that used to be mislabelled as "never sent".
 */
export function createFakeHost({ sessions = [], pagesPerTurn = 2, failPrompt = false } = {}) {
  const known = new Map();
  for (const session of sessions) {
    known.set(session.sessionId, {
      sessionId: session.sessionId,
      cwd: session.cwd === undefined ? null : session.cwd,
      updatedAt: session.updatedAt === undefined ? 1794000000000 : session.updatedAt,
      running: false,
      blank: session.blank === true,
      agentAvailable: true,
      parentSessionId: null,
      origin: null,
      title: session.title === undefined ? null : session.title,
    });
  }
  const turns = new Map();      // sessionId -> { requestId, text, reads, admissions }
  const admitted = [];          // every accepted requestId, in order
  let state = { loseNextResponse: false, refuseAs: null, listShape: 'items', hideAdmission: false };

  const rows = () => Array.from(known.values()).map((session) => ({
    sessionId: session.sessionId, cwd: session.cwd, updatedAt: session.updatedAt, running: session.running,
    blank: session.blank, agentAvailable: session.agentAvailable, parentSessionId: null, origin: null,
  }));

  return {
    kind: 'offline_fake',
    protocol: 'dsh-api-session-controller@0.2.0-rc.2',
    capabilities: () => ({ available: REMOTE_METHODS.slice(), missing: [], required: REMOTE_METHODS.slice(),
      legacyGuessPresent: [] }),
    // Test controls, not part of the adapter contract.
    control: {
      loseNextResponse(value = true) { state.loseNextResponse = value; },
      refuseAs(code) { state.refuseAs = code; },
      listShape(shape) { state.listShape = shape === 'array' ? 'array' : 'items'; },
      hideAdmission(value = true) { state.hideAdmission = value; },
      admissions() { return admitted.slice(); },
      titles() { return new Map(Array.from(known.values()).map((s) => [s.sessionId, s.title])); },
    },
    async list() {
      const items = rows();
      return state.listShape === 'array' ? items : { items };
    },
    async prompt(request, signal) {
      // rc.2 calls this unconditionally (`lib/index.js:3096`); a fake that tolerates a missing signal let a real
      // `Cannot read properties of undefined (reading 'throwIfAborted')` reach the operator instead of this suite.
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      signal.throwIfAborted();
      if (state.refuseAs) {
        const code = state.refuseAs;
        state.refuseAs = null;
        const error = new Error('fake host refused with ' + code);
        error.code = code;
        throw error;
      }
      if (!request || typeof request.requestId !== 'string' || !request.requestId.length) {
        const error = new Error('requestId is required');
        error.code = 'gateway/bad-request';
        throw error;
      }
      const text = Array.isArray(request.content)
        ? request.content.filter((part) => part && part.type === 'text').map((part) => part.text).join('')
        : '';
      if (!text.trim().length) {
        const error = new Error('prompt content must include non-whitespace text');
        error.code = 'gateway/bad-request';
        throw error;
      }
      const session = known.get(request.sessionId);
      if (!session) {
        const error = new Error('session "' + request.sessionId + '" not found');
        error.code = 'session/not-found';
        throw error;
      }
      if (failPrompt) return { accepted: false, reason: 'prompt_refused_by_fake' };
      // Idempotent admission: the same requestId is acknowledged, never inserted twice (rc.2 lib/index.js:855).
      if (admitted.includes(request.requestId)) {
        const turn = turns.get(request.sessionId);
        if (state.loseNextResponse) {
          state.loseNextResponse = false;
          const error = new Error('stream carrier closed after admission');
          error.code = 'gateway/uplink-overflow';
          throw error;
        }
        return { accepted: true };
      }
      admitted.push(request.requestId);
      turns.set(request.sessionId, { requestId: request.requestId, text, reads: 0 });
      session.updatedAt = Date.now();
      session.running = true;
      if (state.loseNextResponse) {
        state.loseNextResponse = false;
        // Admitted, then the answer is lost. This is the failure a naive client calls "failed".
        const error = new Error('connection reset after the Host accepted the prompt');
        error.code = 'gateway/internal';
        throw error;
      }
      return { accepted: true };
    },
    async page(request, signal) {
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      signal.throwIfAborted();
      const sessionId = request && request.address && request.address.sessionId;
      if (!known.has(sessionId)) {
        const error = new Error('session "' + String(sessionId) + '" not found');
        error.code = 'session/not-found';
        throw error;
      }
      const turn = turns.get(sessionId);
      const records = [];
      if (turn) {
        turn.reads += 1;
        records.push({ type: 'event', event: { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 0 } } });
        // `hideAdmission` models a durable log that does not (yet, or any more) carry the submission's rpcId -- the
        // one case where reconcile genuinely needs the original text. The adapter scans records, so the evidence has
        // to be absent from the records, not just from the fake's own convenience method.
        if (!state.hideAdmission) {
          records.push({ type: 'event', event: { type: 'user/message', seq: 2, time: Date.now(),
            data: { message: { content: [{ type: 'text', text: turn.text }], source: { kind: 'user',
              rpcId: turn.requestId } } } } });
        }
        if (turn.reads >= pagesPerTurn) {
          records.push({ type: 'event', event: { type: 'assistant/message', seq: 3, time: Date.now(),
            data: { turn: 0, step: 1, message: { content: [
              { type: 'text', text: 'offline fake answer for ' + turn.text.slice(0, 40) }] } } } });
          known.get(sessionId).running = false;
        }
      }
      return { records, hasMore: false };
    },
    findAdmission: async ({ sessionId, requestId }) => {
      if (state.hideAdmission) return { found: false, seq: null, eventType: null };
      const turn = turns.get(sessionId);
      return turn && turn.requestId === requestId
        ? { found: true, seq: 2, eventType: 'user/message' }
        : { found: false, seq: null, eventType: null };
    },
  };
}
