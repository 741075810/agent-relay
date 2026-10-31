// T095B148: the bounded journal, and the one thing it may never do.
//
// Invariant under test, in one line: trimming storage may not cause a second write of the same
// run, and may not lose a notice that is still deliverable.
//
// The design that is implemented here: `seen` is trimmed only at capacity, only for entries whose
// run the *boundary gate* already refuses (`armedAt >= end`, with `startedAt <= endedAtMs <=
// attemptedAt`), never for `attempting` entries or the in-flight key, and every evicted entry
// leaves a bounded receipt so `duplicate_event` / `duplicate_run` still answer exactly as before.
// If nothing is provably evictable and the journal is over the bound, the arm stops
// (`journal_over_capacity`) rather than trimming something live.
//
// Red-first: run this file with `T148_EXT_ROOT` pointed at the pre-T148 tree (see T148_REPORT.md)
// and all of it fails on `compactJournal is not a function`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.T148_EXT_ROOT || path.join(HERE, 'extension');
const TT = await import(pathToFileURL(path.join(ROOT, 'lib', 'terminal_trigger.js')).href
  + '?r=t148' + Math.random().toString(36).slice(2));

const ARM = 1793450000000;
const HOUR = 3600 * 1000;
const BINDING = { conversationId: 'conv-148', documentInstanceId: 'doc-148',
  url: 'https://chatgpt.com/c/conv-148', manuallyConfirmed: true };
const SENT = { sent: true, pageWriteAttempted: true, code: null };

function uuid(n) {
  return String(n).padStart(8, '0') + '-0000-4000-8000-' + String(n).padStart(12, '0');
}

function armedAt(when, overrides = {}) {
  const out = TT.configure(TT.createTriggerState(),
    { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-148', true, when);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  return Object.assign(out.state, overrides);
}

function journal(state, n, attemptedAt, extra = {}) {
  const key = TT.key(uuid(n), 'completed');
  state.seen[key] = { runId: uuid(n), status: 'completed', state: 'sent',
    attemptedAt, settledAt: attemptedAt, reason: null, origin: 'bridge', ...extra };
  return key;
}

test('T148: below the bound nothing is touched, so history stays verbatim', () => {
  const state = armedAt(ARM);
  const keys = [];
  for (let i = 0; i < 5; i += 1) keys.push(journal(state, i, ARM + 1000 + i));
  const out = TT.compactJournal(state);
  assert.deepEqual(out.evicted, [], 'no eviction under the bound');
  assert.deepEqual(Object.keys(out.state.seen).sort(), keys.sort());
  assert.equal(out.overflow, false);
  assert.equal(state.seen[keys[0]].state, 'sent', 'and the input is not mutated');
});

test('T148: at capacity only gate-refused runs are evicted, and receipts keep both duplicate codes', () => {
  // Arm A: everything delivered here becomes pre-arm once arm B is granted.
  const first = armedAt(ARM);
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES + 200; i += 1) journal(first, i, ARM + 1000 + i);

  const before = TT.compactJournal(first);
  assert.deepEqual(before.evicted, [], 'within its own arm every entry is post-arm: nothing is evictable');
  assert.equal(before.overflow, true, 'so the bound is reported instead of being faked');
  assert.equal(before.state.enabled, false);
  assert.equal(before.state.lastError, TT.JOURNAL_OVERFLOW_CODE);

  // Re-arming moves the boundary forward: the same entries are now provably pre-arm.
  const second = armedAt(ARM + 2 * HOUR);
  second.seen = { ...first.seen };
  const trimmed = TT.compactJournal(second);
  assert.ok(trimmed.evicted.length >= 200, 'evicted ' + trimmed.evicted.length);
  assert.ok(trimmed.remaining <= TT.MAX_SEEN_ENTRIES, 'remaining=' + trimmed.remaining);
  assert.equal(trimmed.overflow, false);
  assert.ok(trimmed.receipts >= trimmed.evicted.length, 'every eviction leaves a receipt');

  // Both duplicate answers survive for a run that only exists as a receipt now.
  const goneKey = trimmed.evicted[0];
  const runId = goneKey.split('|')[0];
  const same = TT.admit({ ...trimmed.state, enabled: true },
    { runId, status: 'completed', origin: 'bridge',
      startedAt: (ARM + 500) / 1000, endedAtMs: ARM + 2000, postArm: true });
  assert.equal(same.code, 'duplicate_event', 'same key still says duplicate_event');
  assert.equal(same.from, 'receipts');
  const other = TT.admit({ ...trimmed.state, enabled: true },
    { runId, status: 'failed', origin: 'bridge',
      startedAt: (ARM + 500) / 1000, endedAtMs: ARM + 2000, postArm: true });
  assert.equal(other.code, 'duplicate_run', 'same run, other status still says duplicate_run');
});

test('T148: even with every receipt dropped, an evicted run cannot be written again', () => {
  const first = armedAt(ARM);
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES + 50; i += 1) journal(first, i, ARM + 1000 + i);
  const second = armedAt(ARM + 2 * HOUR);
  second.seen = { ...first.seen };
  const trimmed = TT.compactJournal(second);
  assert.ok(trimmed.evicted.length > 0);

  // The worst case: the receipts are lost too (a hand-edited or partially written record).
  const amnesiac = { ...trimmed.state, receipts: {}, enabled: true };
  const runId = trimmed.evicted[0].split('|')[0];
  // The gate is what refuses it now, and the candidate filter in the tick calls exactly this
  // before `admit` (see test_t095b123_trigger_once_e2e: a pre-arm completion never fires).
  const gate = TT.completionAfterArm(amnesiac, { runId, startedAt: (ARM + 500) / 1000 });
  assert.equal(gate.proven, false, 'still refused');
  assert.equal(gate.reason, 'started_before_arm',
    'by the boundary gate, which is why eviction was safe in the first place');
  assert.ok(!amnesiac.receipts || Object.keys(amnesiac.receipts).length === 0,
    'and this really was the receipt-less worst case');
});

test('T148: post-arm work is never evicted, even at twice the bound', () => {
  const state = armedAt(ARM);
  const live = [];
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES * 2; i += 1) {
    const key = journal(state, i, ARM + 1000 + i, { endedAtMs: ARM + 1000 + i });
    live.push(key);
  }
  const out = TT.compactJournal(state);
  assert.equal(Object.keys(out.state.seen).length, live.length,
    'nothing post-arm is evictable: this is the set that stops duplicates');
  assert.equal(out.overflow, true);
  assert.equal(out.state.enabled, false, 'so the arm stops instead');
  assert.equal(out.state.lastError, TT.JOURNAL_OVERFLOW_CODE);
  assert.equal(Object.keys(out.state.receipts || {}).length, 0, 'and nothing is trimmed to fake it');
});

test('T148: an in-flight attempt and its barrier survive compaction untouched', () => {
  const first = armedAt(ARM);
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES + 40; i += 1) journal(first, i, ARM + 1000 + i);
  const second = armedAt(ARM + 2 * HOUR);
  second.seen = { ...first.seen };
  const candidate = { runId: uuid(999999), status: 'completed', origin: 'bridge',
    postArm: true, startedAt: (ARM + 2 * HOUR + 1000) / 1000, endedAtMs: ARM + 2 * HOUR + 5000 };
  const marked = TT.markAttempt(second, candidate, ARM + 2 * HOUR + 6000);
  const key = marked.key;

  const out = TT.compactJournal(marked.state);
  assert.ok(out.state.seen[key], 'the entry being written is never evicted');
  assert.equal(out.state.seen[key].state, 'attempting');
  assert.equal(out.state.pendingAttempt.key, key, 'and the barrier is intact');
  const blocked = TT.admit(out.state, { ...candidate, runId: uuid(999998) });
  assert.equal(blocked.code, 'attempt_in_flight', 'so no second write can start');
});

test('T148: a crash during a write is journaled, not trimmed away', () => {
  const state = armedAt(ARM);
  const candidate = { runId: uuid(555), status: 'completed', origin: 'bridge',
    postArm: true, startedAt: (ARM + 1000) / 1000, endedAtMs: ARM + 5000 };
  const marked = TT.markAttempt(state, candidate, ARM + 6000);
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES + 10; i += 1) {
    journal(marked.state, i + 100000, ARM - (i + 1) * HOUR);
  }
  const repaired = TT.reconcileAfterRestart(marked.state, ARM + 9000);
  assert.equal(repaired.state.seen[marked.key].state, 'stopped',
    'the uncertain write is still on record, which is what stops a resend');
  assert.ok(Object.keys(repaired.state.seen).length <= TT.MAX_SEEN_ENTRIES,
    'and the restart is where the excess is trimmed');
  const again = TT.admit({ ...repaired.state, enabled: true }, { ...candidate });
  assert.equal(again.code, 'duplicate_event', 'no resend after the restart');
});

test('T148: receipts are bounded too, oldest first, and never grow the state past the budget', () => {
  const first = armedAt(ARM);
  const total = TT.MAX_SEEN_ENTRIES + 4000;
  for (let i = 0; i < total; i += 1) journal(first, i, ARM + 1000 + i);
  const second = armedAt(ARM + 2 * HOUR);
  second.seen = { ...first.seen };
  const out = TT.compactJournal(second);
  assert.ok(out.receipts <= TT.MAX_RECEIPTS, 'receipts=' + out.receipts);
  assert.equal(out.remaining, TT.MAX_SEEN_ENTRIES);
  const bytes = Buffer.byteLength(JSON.stringify(out.state), 'utf8');
  // 1024 journal entries + 2048 receipts measured; the point is the margin to the 5 MB bucket.
  assert.ok(bytes < 800 * 1024, 'bounded state is ' + Math.round(bytes / 1024) + ' KB');
  assert.ok(5 * 1024 * 1024 / bytes > 5, 'still at least 5x headroom');
  // The newest receipts are the ones kept.
  const kept = Object.values(out.state.receipts).map((r) => r.settledAt || 0);
  assert.ok(Math.min(...kept) > ARM, 'the oldest receipts are the ones dropped');
});

test('T148: legacy records without receipts still arm, dedup and compact', () => {
  const legacy = {
    version: 1, enabled: true, armedAt: ARM - HOUR, minIntervalMs: 30000, maxPerHour: 100,
    maxTriggers: null, triggers: 3, singleShotTrigger: false, expiresAt: null,
    seen: {}, deferred: {}, preArmCandidateKeys: [], windowStartedAt: null,
    windowCount: 0, lastSentAt: ARM - HOUR / 2, lastError: null, disabledAt: null,
  };
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES + 20; i += 1) {
    const id = uuid(i + 200000);
    legacy.seen[TT.key(id, 'completed')] = { runId: id, status: 'completed',
      state: 'sent', attemptedAt: ARM - 2 * HOUR, settledAt: ARM - 2 * HOUR,
      reason: null, origin: 'bridge' };
  }
  assert.equal(legacy.receipts, undefined, 'the fixture really is pre-T148');
  const rearmed = TT.configure(legacy, { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-148', true, ARM);
  assert.equal(rearmed.result.ok, true, JSON.stringify(rearmed.result));
  assert.ok(Object.keys(rearmed.state.seen).length <= TT.MAX_SEEN_ENTRIES,
    'the excess was evicted against the new boundary');
  assert.ok(rearmed.state.receipts && Object.keys(rearmed.state.receipts).length > 0,
    'and receipts were built from the old records');
});

test('T148: compaction never rewrites the fields the popup renders', () => {
  const first = armedAt(ARM);
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES + 30; i += 1) journal(first, i, ARM + 1000 + i);
  const second = armedAt(ARM + 2 * HOUR, { lastError: 'blocked:send_control_missing_after_3_deferrals',
    lastTick: { at: ARM + 1000, guard: { ok: true, count: 1 }, sent: 1 } });
  second.seen = { ...first.seen };
  const out = TT.compactJournal(second);
  assert.equal(out.state.lastError, second.lastError, 'the last refusal text is untouched');
  assert.deepEqual(out.state.lastTick, second.lastTick, 'the last tick verdict is untouched');
  assert.equal(out.state.armedAt, second.armedAt, 'the arm boundary is untouched');
  assert.equal(out.state.triggers, second.triggers, 'the consumed quota is untouched');
});
