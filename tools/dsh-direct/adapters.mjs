// DSH Direct: the Host adapter contract, the rc.2 adapter, and the offline fake.
//
// T271 shipped an adapter that invented `listSessions` / `prompt({sessionId, text, requestId})` / `getEvents`.
// `session_api.mjs` records what `@deepseek-ai/dsh-api-session-controller@0.2.0-rc.2` actually declares
// (`list` / `prompt` / `page`), and this file is the only place that touches those methods.
//
// The honesty boundary is unchanged and now sharper:
//
//   * `createSessionControllerAdapter()` probes the object it is handed. The probe requires exactly the rc.2 methods
//     `list`, `prompt`, `page`, `projections`; missing cursor support also fails with `host_capability_missing`
//     and the missing/required/available lists, so a version mismatch reads as a version mismatch;
//   * `createFakeHost()` is rc.2-shaped, including the one behaviour that matters for lost responses: a repeated
//     `requestId` is acknowledged **without** admitting a second message. It labels itself `offline_fake` all the way
//     into the MCP result.

import { CODES, DirectError, fail } from './protocol.mjs';
import {
  REMOTE_METHODS, buildPageRequest, buildPromptRequest, correlateResult, findAdmission, mapRemoteError,
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
 *   getEvents({ sessionId, requestId, throughSeq?, maxMessages }) -> fixed-cut correlated result + admission
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
   * rc.2 prompt checks signal before admission, and page checks it after observing history. Both require a real
   * AbortSignal. This signal is a read budget, not a guarantee that prompt admission itself times out: the Host only
   * checks the prompt signal before handing off to its command layer.
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

  async function history({ sessionId, requestId, throughSeq, maxMessages = 60 }, admissionOnly = false) {
    const signal = callSignal();
    if (throughSeq === undefined) {
      const snapshot = await call('projections', { sessionId }, signal);
      if (snapshot === null) fail(CODES.session_not_found, 'session projections were not found', { sessionId });
      throughSeq = snapshot?.asOfSeq;
    }
    // Validate even for an empty snapshot: undefined is not an implicit latest cursor.
    buildPageRequest({ sessionId, throughSeq, maxMessages });
    const records = [];
    let beforeSeq;
    let hasMore = false;
    const MAX_HISTORY_PAGES = 32;
    for (let pageNo = 0; pageNo < MAX_HISTORY_PAGES; pageNo += 1) {
      const page = normalizePage(await call('page', buildPageRequest({ sessionId, throughSeq, beforeSeq,
        maxMessages }), signal));
      const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
      const first = page.records[0]?.event?.seq ?? end;
      if (!Number.isSafeInteger(first) || first < 0 || page.records.length !== end - first
          || page.records.some((record, index) => record?.type !== 'event' || record.event?.seq !== first + index)
          || (page.hasMore && (page.records.length === 0 || first === 0))) {
        fail(CODES.host_error, 'session page was not a contiguous prefix of the requested cursor');
      }
      records.unshift(...page.records);
      hasMore = page.hasMore;
      const matched = correlateResult(records, requestId);
      if (!hasMore || (admissionOnly ? matched.admission.found : matched.turnId !== null)) break;
      beforeSeq = first;
    }
    return { records, hasMore, cursor: throughSeq, ...correlateResult(records, requestId) };
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
    async getEvents(request) {
      const page = await history(request);
      return { ...page, events: page.records.map(({ event }) => ({ seq: event.seq, kind: event.type,
        data: event.data })) };
    },
    /** Proof from a fixed cursor, walking backwards when admission is outside the newest page. */
    async findAdmission({ sessionId, requestId, maxMessages = 120 }) {
      return (await history({ sessionId, requestId, maxMessages }, true)).admission;
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
export function createFakeHost({ sessions = [], pagesPerTurn, turnsPerTask = 2, failPrompt = false } = {}) {
  const readsToFinish = pagesPerTurn ?? turnsPerTask;
  const known = new Map(sessions.map((session) => [session.sessionId, {
    sessionId: session.sessionId, cwd: session.cwd ?? null, updatedAt: session.updatedAt ?? 1794000000000,
    running: session.running === true, blank: session.blank === true, agentAvailable: true,
    parentSessionId: null, origin: null, title: session.title ?? null,
  }]));
  const logs = new Map(sessions.map((session) => [session.sessionId, []]));
  const turns = new Map();
  const admitted = [];
  const identities = new Set();
  const state = { loseNextResponse: false, refuseAs: null, listShape: 'items', hideAdmission: false };
  function remote(code, message) { throw Object.assign(new Error(message), { code }); }
  function requireSignal(signal) {
    if (!signal || typeof signal.throwIfAborted !== 'function') throw new TypeError('a real AbortSignal is required');
    signal.throwIfAborted();
  }
  function requireSession(sessionId) {
    if (!known.has(sessionId)) remote('session/not-found', 'session "' + sessionId + '" not found');
    return known.get(sessionId);
  }
  function append(sessionId, type, data) {
    const log = logs.get(sessionId);
    log.push({ type: 'event', event: { type, seq: log.length, time: Date.now(), data } });
  }
  function finish(sessionId) {
    const turn = turns.get(sessionId);
    if (!turn || turn.finished) return;
    append(sessionId, 'assistant/message', { turn: turn.number, step: 1, message: { content: [
      { type: 'text', text: 'offline fake answer for ' + turn.text.slice(0, 40) }] } });
    append(sessionId, 'turn/end', { turn: turn.number, reason: { kind: 'completed' } });
    turn.finished = true;
    known.get(sessionId).running = false;
  }
  function visible(records) {
    return records.map((record) => state.hideAdmission && record.event.type === 'user/message'
      ? { ...record, event: { ...record.event, data: { ...record.event.data, source: { kind: 'user' } } } } : record);
  }
  return {
    kind: 'offline_fake',
    protocol: 'dsh-api-session-controller@0.2.0-rc.2',
    capabilities: () => ({ available: REMOTE_METHODS.slice(), missing: [], required: REMOTE_METHODS.slice(),
      legacyGuessPresent: [] }),
    control: {
      loseNextResponse(value = true) { state.loseNextResponse = value; },
      refuseAs(code) { state.refuseAs = code; },
      listShape(shape) { state.listShape = shape === 'array' ? 'array' : 'items'; },
      hideAdmission(value = true) { state.hideAdmission = value; },
      finish(sessionId) { if (sessionId) finish(sessionId); else for (const id of known.keys()) finish(id); },
      setRunning(sessionId, value) { requireSession(sessionId).running = value === true; },
      admissions() { return admitted.slice(); },
      titles() { return new Map(Array.from(known.values()).map((s) => [s.sessionId, s.title])); },
    },
    async list() {
      const items = Array.from(known.values()).map(({ title, ...row }) => ({ ...row }));
      return state.listShape === 'array' ? items : { items };
    },
    async prompt(request, signal) {
      requireSignal(signal);
      if (state.refuseAs) {
        const code = state.refuseAs;
        state.refuseAs = null;
        remote(code, 'fake host refused with ' + code);
      }
      if (typeof request?.requestId !== 'string' || !request.requestId.length) {
        remote('gateway/bad-request', 'requestId is required');
      }
      const text = Array.isArray(request.content)
        ? request.content.filter((part) => part?.type === 'text').map((part) => part.text).join('') : '';
      if (!text.trim()) remote('gateway/bad-request', 'prompt content must include non-whitespace text');
      const session = requireSession(request.sessionId);
      if (failPrompt) return { accepted: false, reason: 'prompt_refused_by_fake' };
      const key = JSON.stringify([request.sessionId, request.requestId]);
      if (!identities.has(key)) {
        identities.add(key);
        admitted.push(request.requestId);
        const number = (turns.get(request.sessionId)?.number ?? -1) + 1;
        turns.set(request.sessionId, { number, requestId: request.requestId, text, reads: 0, finished: false });
        append(request.sessionId, 'turn/start', { turn: number });
        append(request.sessionId, 'user/message', { content: [{ type: 'text', text }],
          source: { kind: 'user', rpcId: request.requestId } });
        session.updatedAt = Date.now();
        session.running = true;
      }
      if (state.loseNextResponse) {
        state.loseNextResponse = false;
        remote('gateway/internal', 'connection reset after the Host accepted the prompt');
      }
      return { accepted: true };
    },
    async projections({ sessionId }, signal) {
      requireSignal(signal);
      requireSession(sessionId);
      const turn = turns.get(sessionId);
      if (turn && !turn.finished && ++turn.reads >= readsToFinish) finish(sessionId);
      return { asOfSeq: logs.get(sessionId).length - 1, values: {} };
    },
    async page(request, signal) {
      requireSignal(signal);
      const sessionId = request?.address?.sessionId;
      requireSession(sessionId);
      buildPageRequest({ sessionId, throughSeq: request.throughSeq, beforeSeq: request.beforeSeq,
        maxMessages: request.maxMessages });
      const log = logs.get(sessionId);
      if (request.throughSeq >= log.length) remote('gateway/bad-request', 'throughSeq is past cursor');
      const end = Math.min(request.throughSeq + 1, request.beforeSeq ?? request.throughSeq + 1);
      let cut = 0;
      let messages = 0;
      for (let i = end - 1; i >= 0; i -= 1) {
        if (!['user/message', 'assistant/message'].includes(log[i].event.type)) continue;
        if (++messages >= (request.maxMessages ?? 60)) { cut = i; break; }
      }
      return { records: visible(log.slice(cut, end)), hasMore: cut > 0 };
    },
    async findAdmission({ sessionId, requestId }) {
      requireSession(sessionId);
      return findAdmission(visible(logs.get(sessionId)), requestId);
    },
  };
}
