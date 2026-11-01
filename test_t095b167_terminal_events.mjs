// T167: terminal-state normalisation and the delivery ledger, tested from the states that failed live.
//
// The user's report was "DSH finished, no notification". Everything here is about the two halves of that:
// deciding that a turn really ended (not that it paused, not that it is waiting for the operator), and
// keeping that ending on record until something proves it reached ChatGPT.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib');
const TE = await import(pathToFileURL(path.join(LIB, 'terminal_events.js')).href + '?r=t167'
  + Math.random().toString(36).slice(2));

const SESSION = 'session-11111111-2222-4333-8444-555555555555';
const base = (over = {}) => ({ source: 'native', sessionId: SESSION, taskId: 'T167', turn: 7,
  kind: 'completed', endedAtMs: 1793800000000, ...over });

test('T167: a completed turn normalises to one event with one stable id', () => {
  const a = TE.normalizeTerminalEvent(base());
  const b = TE.normalizeTerminalEvent(base({ observedAt: 1793800009999 }));
  assert.equal(a.ok, true);
  assert.equal(a.terminal, true);
  assert.equal(a.id, b.id, 'the same ending read twice must not mint two ids');
  assert.equal(a.id, 'native:' + SESSION + ':T167:7:completed');
});

test('T167: every terminal kind is accepted, including the ones no scanner currently emits', () => {
  for (const kind of TE.TERMINAL_KINDS) {
    const out = TE.normalizeTerminalEvent(base({ kind,
      unfinished: kind === 'idle_with_unfinished_work' ? 2 : undefined,
      idleForMs: kind === 'idle_with_unfinished_work' ? TE.IDLE_STABLE_MS : undefined }));
    assert.equal(out.ok, true, kind + ' must be terminal: ' + JSON.stringify(out));
  }
});

test('T167: waiting for the operator or for permission is not a completed task', () => {
  assert.equal(TE.normalizeTerminalEvent(base({ kind: 'awaiting_user_input' })).code,
    'awaiting_user_input');
  assert.equal(TE.normalizeTerminalEvent(base({ kind: 'permission_wait' })).code, 'permission_wait');
  assert.equal(TE.normalizeTerminalEvent(base({ kind: 'running' })).code, 'not_terminal_kind');
  assert.equal(TE.normalizeTerminalEvent(base({ kind: 'idle_clean' })).code, 'idle_clean');
});

test('T167: a momentary idle is not an ending, and neither is an idle with no unfinished work', () => {
  const short = TE.normalizeTerminalEvent(base({ kind: 'idle_with_unfinished_work',
    unfinished: 3, idleForMs: TE.IDLE_STABLE_MS - 1 }));
  assert.equal(short.ok, false);
  assert.equal(short.code, 'idle_unstable');
  assert.equal(short.requiredMs, TE.IDLE_STABLE_MS);

  const empty = TE.normalizeTerminalEvent(base({ kind: 'idle_with_unfinished_work',
    unfinished: 0, idleForMs: TE.IDLE_STABLE_MS }));
  assert.equal(empty.code, 'idle_without_unfinished_work');

  const stable = TE.normalizeTerminalEvent(base({ kind: 'idle_with_unfinished_work',
    unfinished: 1, idleForMs: TE.IDLE_STABLE_MS }));
  assert.equal(stable.ok, true);
});

test('T167: an unknown terminal time is refused, never reconstructed', () => {
  for (const endedAtMs of [null, undefined, 0, -1, 1.5, '1793800000000']) {
    const out = TE.normalizeTerminalEvent(base({ endedAtMs }));
    assert.equal(out.ok, false, String(endedAtMs));
    assert.equal(out.code, 'ended_at_unknown');
  }
});

test('T167: an unnamed session or task cannot become a notice', () => {
  assert.equal(TE.normalizeTerminalEvent(base({ sessionId: '' })).code, 'session_missing');
  assert.equal(TE.normalizeTerminalEvent(base({ taskId: undefined })).code, 'task_missing');
  assert.equal(TE.normalizeTerminalEvent(base({ kind: 'weird' })).code, 'kind_unknown');
});

test('T167: the same ending enqueues once and reads back as a duplicate', () => {
  const ledger = TE.createDeliveryLedger();
  const event = TE.normalizeTerminalEvent(base());
  assert.equal(TE.enqueue(ledger, event, 100).added, true);
  const again = TE.enqueue(ledger, event, 200);
  assert.equal(again.added, false);
  assert.equal(again.code, 'duplicate');
  assert.equal(ledger.entries.length, 1);
  assert.equal(TE.pending(ledger).length, 1);
});

test('T167: a non-terminal or refused event is not enqueued at all', () => {
  const ledger = TE.createDeliveryLedger();
  assert.equal(TE.enqueue(ledger, { ok: false, code: 'idle_unstable' }).added, false);
  assert.equal(TE.enqueue(ledger, TE.normalizeTerminalEvent(base({ kind: 'permission_wait' }))).added,
    false);
  assert.equal(ledger.entries.length, 0);
});

test('T167: written-but-not-clicked and clicked-unknown are terminal for retries', () => {
  const ledger = TE.createDeliveryLedger();
  const event = TE.normalizeTerminalEvent(base());
  TE.enqueue(ledger, event, 0);
  TE.transition(ledger, event.id, 'attempted', { now: 1 });
  TE.transition(ledger, event.id, 'written_not_clicked', { reason: 'send_button_not_ready', now: 2 });
  const retry = TE.transition(ledger, event.id, 'attempted', { now: 3 });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'transition_refused');
  assert.match(retry.why, /duplicate/);
  assert.equal(TE.pending(ledger).length, 1, 'the event is kept, not dropped');
  assert.equal(TE.nextAttemptDelayMs(ledger.entries[0]), null);

  const second = TE.normalizeTerminalEvent(base({ taskId: 'T167b' }));
  TE.enqueue(ledger, second, 0);
  TE.transition(ledger, second.id, 'attempted', { now: 1 });
  TE.transition(ledger, second.id, 'clicked_unknown', { reason: 'delivery_not_confirmed', now: 2 });
  assert.equal(TE.transition(ledger, second.id, 'attempted', { now: 3 }).code, 'transition_refused');
});

test('T167: only a verified receipt reaches acked, and only acked counts as delivered', () => {
  const ledger = TE.createDeliveryLedger();
  const event = TE.normalizeTerminalEvent(base());
  TE.enqueue(ledger, event, 0);
  TE.transition(ledger, event.id, 'attempted', { now: 1 });
  // The page accepted it; that is not delivery.
  assert.equal(TE.transition(ledger, event.id, 'submitted', { receiptVerified: true, now: 2 }).ok, true);
  assert.equal(TE.delivered(ledger).length, 0, 'submitted is not delivered');
  assert.equal(TE.pending(ledger).length, 1);
  // Claiming the ack without a verified receipt is refused.
  assert.equal(TE.transition(ledger, event.id, 'acked', { now: 3 }).code, 'receipt_not_verified');
  assert.equal(TE.transition(ledger, event.id, 'acked', { receiptVerified: true, now: 4 }).ok, true);
  assert.equal(TE.delivered(ledger).length, 1);
  assert.equal(TE.pending(ledger).length, 0);
});

test('T167: an unconfirmed attempt may go back to queued, with a bounded delay', () => {
  const ledger = TE.createDeliveryLedger();
  const event = TE.normalizeTerminalEvent(base());
  TE.enqueue(ledger, event, 0);
  TE.transition(ledger, event.id, 'attempted', { now: 1 });
  assert.equal(TE.transition(ledger, event.id, 'queued', { reason: 'tab_hidden', now: 2 }).ok, true);
  const entry = ledger.entries[0];
  assert.equal(TE.nextAttemptDelayMs(entry), 0);
  // Once attempted twice, backoff is bounded rather than unbounded doubling.
  entry.attempts = 99;
  entry.state = 'attempted';
  assert.equal(TE.nextAttemptDelayMs(entry), 15 * 60 * 1000);
});

test('T167: a successful send goes attempted -> submitted directly', () => {
  // Pinned because the transition table omitted it once: every real delivery would have been refused
  // while all the failure paths stayed green.
  const ledger = TE.createDeliveryLedger();
  const event = TE.normalizeTerminalEvent(base());
  TE.enqueue(ledger, event, 0);
  TE.transition(ledger, event.id, 'attempted', { now: 1 });
  const out = TE.transition(ledger, event.id, 'submitted', { receiptVerified: true, now: 2 });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.state, 'submitted');
});

test('T167: unknown states and missing entries are refused by name', () => {
  const ledger = TE.createDeliveryLedger();
  assert.equal(TE.transition(ledger, 'nope', 'queued').code, 'entry_missing');
  const event = TE.normalizeTerminalEvent(base());
  TE.enqueue(ledger, event, 0);
  assert.equal(TE.transition(ledger, event.id, 'delivered').code, 'state_unknown');
});

test('T167: the T166 diagnostic record still works, fed from a ledger entry', () => {
  const ledger = TE.createDeliveryLedger();
  const event = TE.normalizeTerminalEvent(base());
  TE.enqueue(ledger, event, 0);
  TE.transition(ledger, event.id, 'attempted', { now: 1 });
  TE.transition(ledger, event.id, 'written_not_clicked', { reason: 'send_button_not_ready', now: 2 });
  const record = TE.entryDiagnostic(ledger.entries[0], { visibilityState: 'hidden', hasFocus: false });
  assert.equal(record.delivered, false);
  assert.equal(record.classification, 'written_not_clicked');
  assert.match(TE.renderDiagnosticText(record), /visibilityState: hidden/);
});
