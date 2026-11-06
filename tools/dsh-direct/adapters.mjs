// DSH Direct: the Host adapter contract, and the adapter that would run inside a Cordis Desktop plugin.
//
// The boundary this file paints is the whole honesty argument of the module:
//
//   * the MCP server never talks to Electron, to Chrome, or to a private WebSocket token. It talks HTTP to a Host
//     bridge on loopback, with a bearer token, and that is the only thing it trusts;
//   * the Host bridge is fed by an adapter. `createSessionControllerAdapter()` adapts the object a Cordis plugin
//     receives as `ctx.sessionController` -- and it *probes* that object instead of assuming its shape. When the
//     methods are absent it refuses with `host_capability_missing` and names them, because "the Host cannot do this"
//     and "this experiment failed" must not collapse into one message;
//   * `createFakeHost()` implements the same contract for tests. It is labelled `offline_fake` all the way through to
//     the MCP result, so no receipt produced by it can be mistaken for a real Desktop dispatch.
//
// What is verified today: the contract, the probe, the bridge, the MCP surface, the ledger. What is NOT verified:
// that the installed Desktop build actually exposes `ctx.sessionController` with `listSessions`/`prompt`/`getEvents`.
// A string count over `resources/app/lib/main.js` and `preload-app.cjs` of `@deepseek-ai/dsh-desktop@0.2.0-rc.2`
// finds no `sessionController` at all, so the probe is the honest end of this road until a plugin is installed and
// run inside the app.

import { CODES, DirectError, fail } from './protocol.mjs';

/** The three methods the adapter needs. Named here so a refusal can enumerate them. */
export const REQUIRED_SESSION_CONTROLLER = Object.freeze(['listSessions', 'prompt', 'getEvents']);

/** Which methods an arbitrary object actually has. Used by the probe's refusal details and by `/health`. */
export function describeCapabilities(candidate) {
  const available = [];
  const missing = [];
  for (const name of REQUIRED_SESSION_CONTROLLER) {
    const value = candidate ? candidate[name] : undefined;
    (typeof value === 'function' ? available : missing).push(name);
  }
  return { available, missing, required: REQUIRED_SESSION_CONTROLLER.slice() };
}

function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object') fail(CODES.internal, 'the Host returned a session that is not an object');
  const sessionId = raw.sessionId;
  if (typeof sessionId !== 'string' || !sessionId.startsWith('session-')) {
    fail(CODES.internal, 'the Host returned a session without a usable sessionId', { got: typeof sessionId });
  }
  return {
    sessionId,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : null,
    status: typeof raw.status === 'string' ? raw.status : 'unknown',
    lastActivityAt: Number.isFinite(raw.lastActivityAt) ? raw.lastActivityAt : null,
  };
}

/**
 * Adapt a `ctx.sessionController`-shaped object. Nothing is cached beyond the probe: a Host that withdraws a method
 * after activation must fail the next call, not keep answering from a stale belief that it can.
 */
export function createSessionControllerAdapter(candidate, { kind = 'cordis_session_controller' } = {}) {
  const caps = describeCapabilities(candidate);
  if (caps.missing.length) {
    throw new DirectError(CODES.host_capability_missing,
      'the Host does not offer the session-controller methods this adapter requires',
      { kind, missing: caps.missing, required: caps.required, available: caps.available });
  }
  return {
    kind,
    capabilities: () => describeCapabilities(candidate),
    async listSessions() {
      const listed = await candidate.listSessions();
      if (!Array.isArray(listed)) {
        fail(CODES.internal, 'sessionController.listSessions() did not return an array');
      }
      return listed.map(normalizeSession);
    },
    async prompt({ sessionId, text, requestId }) {
      const answer = await candidate.prompt({ sessionId, text, requestId });
      if (!answer || typeof answer !== 'object') {
        fail(CODES.internal, 'sessionController.prompt() returned no receipt');
      }
      if (answer.accepted !== true && answer.accepted !== false) {
        fail(CODES.internal, 'sessionController.prompt() did not say whether the turn was accepted');
      }
      return { accepted: answer.accepted === true, turnId: typeof answer.turnId === 'string' ? answer.turnId : null,
        reason: typeof answer.reason === 'string' ? answer.reason : null };
    },
    async getEvents({ sessionId, turnId, cursor }) {
      const answer = await candidate.getEvents({ sessionId, turnId, cursor });
      if (!answer || typeof answer !== 'object' || !Array.isArray(answer.events)) {
        fail(CODES.internal, 'sessionController.getEvents() did not return an event list');
      }
      return {
        events: answer.events.map((event) => ({
          seq: Number.isFinite(event && event.seq) ? event.seq : null,
          kind: typeof (event && event.kind) === 'string' ? event.kind : 'unknown',
          text: typeof (event && event.text) === 'string' ? event.text : null,
        })),
        cursor: Number.isFinite(answer.cursor) ? answer.cursor : null,
        done: answer.done === true,
      };
    },
  };
}

/**
 * An offline Host for tests. Deterministic, in-process, and labelled at every layer it can be labelled at: the
 * bridge reports `kind: offline_fake`, `/health` repeats it, and the MCP result carries it back to the caller.
 *
 * It is *not* a stand-in for a real dispatch. It exists so the MCP surface, the ledger, the auth and the occupancy
 * rules can be exercised for real (real processes, real HTTP, real stdio) without pretending a Desktop prompt ran.
 */
export function createFakeHost({ sessions = [], turnsPerTask = 2, failPrompt = false } = {}) {
  const known = new Map();
  for (const session of sessions) known.set(session.sessionId, { ...normalizeSession(session) });
  const turns = new Map();
  let seq = 0;
  return {
    kind: 'offline_fake',
    capabilities: () => ({ available: REQUIRED_SESSION_CONTROLLER.slice(), missing: [],
      required: REQUIRED_SESSION_CONTROLLER.slice() }),
    async listSessions() {
      return Array.from(known.values()).map((session) => ({ ...session }));
    },
    async prompt({ sessionId, text, requestId }) {
      const session = known.get(sessionId);
      if (!session) return { accepted: false, turnId: null, reason: 'session_not_found' };
      if (failPrompt) return { accepted: false, turnId: null, reason: 'prompt_refused_by_fake' };
      seq += 1;
      const turnId = 'turn-' + String(seq).padStart(4, '0');
      turns.set(turnId, { sessionId, text, requestId, reads: 0, turnsPerTask });
      session.lastActivityAt = Date.now();
      return { accepted: true, turnId };
    },
    async getEvents({ sessionId, turnId }) {
      const turn = turns.get(turnId);
      if (!turn || turn.sessionId !== sessionId) {
        return { events: [], cursor: null, done: true };
      }
      turn.reads += 1;
      const events = [{ seq: turn.reads, kind: 'turn.accepted', text: null }];
      if (turn.reads >= turn.turnsPerTask) {
        events.push({ seq: turn.reads + 1, kind: 'assistant.message',
          text: 'offline fake answer for ' + turn.text.slice(0, 40) });
        return { events, cursor: turn.reads + 1, done: true };
      }
      return { events, cursor: turn.reads, done: false };
    },
  };
}
