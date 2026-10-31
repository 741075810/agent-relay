// T095B149: rewrite of the T148 capacity suite.
//
// The file is kept because the T148 commit (`b8103e7`) shipped "evict entries whose run ended
// before the arm, leave a bounded receipt", and that contract was wrong: `background.js` accepts a
// candidate carrying `postArm === true` with no time check, so an evicted entry was the difference
// between one notice and two (see `test_t095b149_postarm_resend.mjs` for the proof). The contract
// asserted here is the corrected one -- the bound is a *refusal*, never a trim -- so this suite now
// pins behaviour the module must keep rather than behaviour it once had.
//
// Red-first note: everything below fails on `b8103e7`, because that build returned a trimmed
// journal instead of a stopped arm.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.T148_EXT_ROOT || path.join(HERE, 'extension');
const TT = await import(pathToFileURL(path.join(ROOT, 'lib', 'terminal_trigger.js')).href
  + '?r=t148b' + Math.random().toString(36).slice(2));

const ARM = 1793450000000;
const BINDING = { conversationId: 'conv-148', documentInstanceId: 'doc-148',
  url: 'https://chatgpt.com/c/conv-148', manuallyConfirmed: true };

function uuid(n) {
  return String(n).padStart(8, '0') + '-0000-4000-8000-' + String(n).padStart(12, '0');
}

function armed(overrides = {}) {
  const out = TT.configure(TT.createTriggerState(),
    { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-148', true, ARM);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  return Object.assign(out.state, overrides);
}

function fill(state, count, attemptedAt) {
  for (let i = 0; i < count; i += 1) {
    const id = uuid(i + 500000);
    state.seen[TT.key(id, 'completed')] = { runId: id, status: 'completed', state: 'sent',
      attemptedAt, settledAt: attemptedAt, reason: null, origin: 'bridge', endedAtMs: attemptedAt };
  }
  return state;
}

test('T148/T149: below the bound nothing happens at all', () => {
  const state = armed();
  fill(state, 5, ARM + 1000);
  const out = TT.compactJournal(state);
  assert.deepEqual(out.evicted, []);
  assert.equal(out.remaining, 5);
  assert.equal(out.overflow, false);
  assert.equal(out.state.enabled, true, 'a normal journal keeps the arm working');
});

test('T148/T149: at the bound the journal is kept and the arm stops', () => {
  const state = armed();
  fill(state, TT.MAX_SEEN_ENTRIES + 12, ARM + 1000);
  const out = TT.compactJournal(state);
  assert.equal(out.remaining, TT.MAX_SEEN_ENTRIES + 12, 'kept in full');
  assert.deepEqual(out.evicted, []);
  assert.equal(out.overflow, true);
  assert.equal(out.state.enabled, false);
  assert.equal(out.state.lastError, TT.JOURNAL_OVERFLOW_CODE);
  const verdict = TT.admit(out.state,
    { runId: uuid(900001), status: 'completed', origin: 'bridge',
      startedAt: (ARM + 5000) / 1000, endedAtMs: ARM + 9000, postArm: true });
  assert.equal(verdict.code, 'trigger_disabled', 'and it stops before any candidate is judged');
});

test('T148/T149: the fields the popup renders survive a compaction unchanged', () => {
  const state = armed({ lastError: 'blocked:send_control_missing_after_3_deferrals',
    lastTick: { at: ARM + 1000, guard: { ok: true, count: 1 }, sent: 1 } });
  fill(state, TT.MAX_SEEN_ENTRIES + 3, ARM + 2000);
  const out = TT.compactJournal(state);
  // The popup must be told why the arm stopped, so the capacity code deliberately replaces the
  // previous refusal text -- that is the one field compaction is allowed to rewrite, and only to a
  // louder message.
  assert.equal(out.state.lastError, TT.JOURNAL_OVERFLOW_CODE);
  assert.deepEqual(out.state.lastTick, state.lastTick);
  assert.equal(out.state.armedAt, state.armedAt);
  assert.equal(out.state.triggers, state.triggers);
});

test('T148/T149: a legacy record without any T148/T149 fields is still armed and judged', () => {
  const legacy = {
    version: 1, enabled: true, armedAt: ARM - 1000, minIntervalMs: 30000, maxPerHour: 100,
    maxTriggers: null, triggers: 0, singleShotTrigger: false, expiresAt: null,
    seen: {}, deferred: {}, preArmCandidateKeys: [], windowStartedAt: null,
    windowCount: 0, lastSentAt: null, lastError: null, disabledAt: null,
  };
  fill(legacy, 3, ARM - 500);
  const out = TT.configure(legacy, { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-148', true, ARM + 1000);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  assert.equal(Object.keys(out.state.seen).length, 3, 'the three historical entries are intact');
  assert.equal(out.state.receipts, undefined, 'and no receipts machinery was invented for them');
});
