// T167: normalise "did DSH stop?" into one event with one id, and keep it until it is delivered.
//
// Measured facts behind this file (host side, this repository, no runtime access):
//   * `terminal_source.py` and `native_turns.py` mention `idle` zero times -- neither scanner can produce
//     an event for "the agent stopped and nobody was told";
//   * both build candidates from ledger/`run` records, so a turn that ends without a task record
//     (DSH stopping itself, an unexpected stop, a cancelled turn) has no event at all;
//   * therefore "DSH finished, no notification" has its first break before the page: at event creation.
//
// This module is the offline half of the fix: a terminal-state normaliser with a stable identity, plus a
// delivery ledger whose states separate "we tried" from "we know it arrived". Nothing here sends, clicks,
// writes to a page, or talks to Bridge. Everything is data in, data out.

import { buildDiagnosticRecord, renderDiagnosticText } from './diagnostic_record.js';

/** States that really mean the turn is over. */
export const TERMINAL_KINDS = Object.freeze([
  'completed', 'failed', 'cancelled', 'unexpected_stop', 'idle_with_unfinished_work',
]);

/** States that look like stopping but are not: someone is expected to act. */
export const NOT_TERMINAL_KINDS = Object.freeze([
  'running', 'idle_clean', 'awaiting_user_input', 'permission_wait',
]);

/** An idle only counts as terminal once it has held for this long with work still unfinished. */
export const IDLE_STABLE_MS = 60000;

export const DELIVERY_STATES = Object.freeze([
  'queued', 'attempted', 'written_not_clicked', 'clicked_unknown', 'submitted', 'acked',
]);

const REASONS = {
  kind_unknown: 'the kind was not recognised, so nothing can be decided about it',
  not_terminal_kind: 'the kind is not a terminal state',
  awaiting_user_input: 'waiting for the operator is not a completed task',
  permission_wait: 'waiting for a permission decision is not a completed task',
  idle_clean: 'an idle with nothing unfinished is a pause, not an ending',
  idle_unstable: 'the idle has not held long enough to be an ending',
  session_missing: 'no session id: the notice could not name what finished',
  task_missing: 'no task id: a notice about an unnamed task is not reviewable',
  ended_at_unknown: 'no terminal timestamp, so no ordering against consent is possible',
  idle_without_unfinished_work: 'idle_with_unfinished_work needs at least one unfinished item',
};

function refuse(code, extra) {
  return Object.assign({ ok: false, code, why: REASONS[code] || null, terminal: false }, extra || {});
}

/**
 * Stable identity for one ending: the same fact observed twice must collapse to one notice.
 * Deliberately built from identifiers only -- no timestamps, no text -- so a re-read of the same
 * session log cannot mint a second id.
 */
export function terminalEventId({ source, sessionId, taskId, turn, kind }) {
  return [source, sessionId, taskId, turn === undefined || turn === null ? '-' : turn, kind].join(':');
}

/**
 * @param {object} input
 * @param {string} input.source        'bridge' | 'native' | 'host'
 * @param {string} input.sessionId
 * @param {string} input.taskId
 * @param {number|string} [input.turn]
 * @param {string} input.kind          one of TERMINAL_KINDS / NOT_TERMINAL_KINDS
 * @param {number|null} input.endedAtMs  terminal timestamp in ms; null means unknown, never guessed
 * @param {number} [input.idleForMs]   how long the idle has held
 * @param {number} [input.unfinished]  count of unfinished items at the idle
 * @param {number} [input.observedAt]
 */
export function normalizeTerminalEvent(input = {}) {
  const kind = input.kind;
  if (!TERMINAL_KINDS.includes(kind) && !NOT_TERMINAL_KINDS.includes(kind)) {
    return refuse('kind_unknown', { kind: kind === undefined ? null : String(kind) });
  }
  if (NOT_TERMINAL_KINDS.includes(kind)) {
    // Each non-terminal kind gets its own code: "the operator has to type something" and "nothing is
    // running" lead to opposite actions, and collapsing them is how a notice gets sent for a paused task.
    const code = kind === 'awaiting_user_input' ? 'awaiting_user_input'
      : kind === 'permission_wait' ? 'permission_wait'
        : kind === 'idle_clean' ? 'idle_clean' : 'not_terminal_kind';
    return refuse(code, { kind });
  }
  if (kind === 'idle_with_unfinished_work') {
    const unfinished = Number.isSafeInteger(input.unfinished) ? input.unfinished : 0;
    if (unfinished <= 0) return refuse('idle_without_unfinished_work', { kind });
    const idleForMs = Number.isFinite(input.idleForMs) ? input.idleForMs : 0;
    if (idleForMs < IDLE_STABLE_MS) {
      return refuse('idle_unstable', { kind, idleForMs, requiredMs: IDLE_STABLE_MS });
    }
  }
  if (typeof input.sessionId !== 'string' || input.sessionId === '') return refuse('session_missing', { kind });
  if (typeof input.taskId !== 'string' || input.taskId === '') return refuse('task_missing', { kind });
  const endedAtMs = Number.isSafeInteger(input.endedAtMs) && input.endedAtMs > 0
    ? input.endedAtMs : null;
  if (endedAtMs === null) return refuse('ended_at_unknown', { kind });

  return {
    ok: true, code: null, terminal: true, kind,
    id: terminalEventId(input),
    source: input.source || 'unknown', sessionId: input.sessionId, taskId: input.taskId,
    turn: input.turn === undefined ? null : input.turn,
    endedAtMs, observedAt: Number.isSafeInteger(input.observedAt) ? input.observedAt : null,
  };
}

// ------------------------------------------------------------------ delivery ledger

export function createDeliveryLedger() {
  return { version: 1, entries: [] };
}

function find(ledger, id) {
  return (ledger && Array.isArray(ledger.entries)) ? ledger.entries.find((e) => e.id === id) : undefined;
}

/**
 * Add an event once. A duplicate is not an error: it is the normal result of reading the same ending
 * twice, and it must not produce a second notice.
 */
export function enqueue(ledger, event, now = 0) {
  if (!ledger || !Array.isArray(ledger.entries)) return { added: false, code: 'ledger_missing' };
  if (!event || event.ok !== true || !event.id) return { added: false, code: 'event_not_terminal' };
  const existing = find(ledger, event.id);
  if (existing) return { added: false, code: 'duplicate', state: existing.state, id: event.id };
  ledger.entries.push({
    id: event.id, kind: event.kind, source: event.source, sessionId: event.sessionId,
    taskId: event.taskId, turn: event.turn, endedAtMs: event.endedAtMs,
    state: 'queued', attempts: 0, queuedAt: now, updatedAt: now,
    lastReason: null, receiptVerified: false, ackedAt: null,
  });
  return { added: true, code: null, id: event.id, state: 'queued' };
}

const ALLOWED = {
  queued: ['attempted'],
  attempted: ['submitted', 'written_not_clicked', 'clicked_unknown', 'queued'],
  written_not_clicked: [],          // the draft is intact; retrying is what must not happen
  clicked_unknown: [],              // a second click could duplicate: never
  submitted: ['acked', 'clicked_unknown'],
  acked: [],
};

/**
 * Move one entry. `delivered` is never a state you can set: it is `acked`, and `acked` requires the
 * adapter's verified receipt. `submitted` means the page accepted it, which is not the same claim.
 */
export function transition(ledger, id, nextState, detail = {}) {
  const entry = find(ledger, id);
  if (!entry) return { ok: false, code: 'entry_missing', id };
  if (!DELIVERY_STATES.includes(nextState)) return { ok: false, code: 'state_unknown', id };
  if (!(ALLOWED[entry.state] || []).includes(nextState)) {
    return { ok: false, code: 'transition_refused', id, from: entry.state, to: nextState,
      why: entry.state === 'written_not_clicked' || entry.state === 'clicked_unknown'
        ? 'this state must not be retried: a second write or click could duplicate the notice'
        : 'not an allowed transition' };
  }
  if (nextState === 'acked' && detail.receiptVerified !== true) {
    return { ok: false, code: 'receipt_not_verified', id,
      why: 'acked is the only delivered state, and it requires a verified receipt' };
  }
  if (nextState === 'attempted') entry.attempts += 1;
  entry.state = nextState;
  if (detail.reason !== undefined) entry.lastReason = detail.reason;
  if (nextState === 'submitted') entry.receiptVerified = detail.receiptVerified === true;
  if (nextState === 'acked') { entry.ackedAt = Number.isSafeInteger(detail.now) ? detail.now : null;
    entry.receiptVerified = true; }
  if (Number.isSafeInteger(detail.now)) entry.updatedAt = detail.now;
  return { ok: true, code: null, id, state: entry.state };
}

export function pending(ledger) {
  return (ledger && Array.isArray(ledger.entries) ? ledger.entries : [])
    .filter((e) => e.state !== 'acked');
}

export function delivered(ledger) {
  return (ledger && Array.isArray(ledger.entries) ? ledger.entries : [])
    .filter((e) => e.state === 'acked' && e.receiptVerified === true);
}

/** Bounded backoff for the states that may be retried; the non-retryable ones get null. */
export function nextAttemptDelayMs(entry) {
  if (!entry) return null;
  if (entry.state === 'queued') return 0;
  if (entry.state !== 'attempted') return null;
  return Math.min(30000 * Math.max(1, entry.attempts), 15 * 60 * 1000);
}

/** T166 reuse: the same record shape, built from a ledger entry instead of a live result. */
export function entryDiagnostic(entry, observation) {
  const result = entry ? { status: entry.state === 'acked' ? 'submitted' : 'unconfirmed',
    reason: entry.lastReason, clickPerformed: entry.state === 'clicked_unknown'
      || entry.state === 'submitted' || entry.state === 'acked',
    evidence: { observedAt: entry.updatedAt, deliveryMode: entry.deliveryMode } } : null;
  return buildDiagnosticRecord({ result, observation });
}

export { renderDiagnosticText };
