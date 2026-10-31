// T095B149: the bound must never be paid for with a second write.
//
// What b8103e7 got wrong, in the exact words of the code it shipped: `compactJournal` evicted a
// journal entry when `armedAt >= endedAtMs`, on the argument that `completionAfterArm` refuses such
// a run "for this arm and every later one". That argument only holds if the gate is the thing that
// refuses. It is not. In `background.js` the epoch branch is:
//
//     if (stateEpoch !== null) {
//       if (hostEpoch === null) return 'arm_snapshot_missing';
//       if (hostEpoch !== stateEpoch) return 'arm_epoch_mismatch';
//       if (item.postArm === true) return null;          // accepted, no time check
//       if (item.postArm === false) return 'in_arm_snapshot';
//       const proof = terminalTrigger.completionAfterArm(state, item);
//       return proof.proven ? null : proof.reason;
//     }
//
// `postArm` arrives on the queue entry (the host's verdict, recorded once at intake and never
// rewritten), and nothing binds it to the epoch it was computed under. So a re-offered run can be
// admitted purely on that flag, whatever its `startedAt`; the *only* thing that then refuses it is
// the journal. Evicting the journal entry therefore removes the last guard, and once the bounded
// receipts had rotated that entry out too, the same run would be written a second time.
//
// This file proves both halves: the hazard (a run with `postArm === true` and no journal entry is
// admitted) and the fix (the journal can no longer lose that entry -- at capacity the arm stops).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.T149_EXT_ROOT || path.join(HERE, 'extension');
const TT = await import(pathToFileURL(path.join(ROOT, 'lib', 'terminal_trigger.js')).href
  + '?r=t149' + Math.random().toString(36).slice(2));
const BG_SRC = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

const ARM = 1793450000000;
const HOUR = 3600 * 1000;
const BINDING = { conversationId: 'conv-149', documentInstanceId: 'doc-149',
  url: 'https://chatgpt.com/c/conv-149', manuallyConfirmed: true };

function uuid(n) {
  return String(n).padStart(8, '0') + '-0000-4000-8000-' + String(n).padStart(12, '0');
}

function armed(when = ARM) {
  const out = TT.configure(TT.createTriggerState(),
    { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-149', true, when);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  return out.state;
}

// A run that started before the arm and finished after it: `postArm === true`, `startedAt <
// armedAt`. This is the shape the host offers for a long task, and the shape the operator asked
// about in T149.
const LONG_RUN = { runId: uuid(4242), status: 'completed', origin: 'bridge',
  startedAt: (ARM - 40 * 60 * 1000) / 1000, endedAtMs: ARM + 60 * 1000,
  postArm: true, armEpoch: 'epoch-A' };

test('T149: the epoch branch accepts postArm=true without any time check (static evidence)', () => {
  const epochBranch = BG_SRC.slice(BG_SRC.indexOf('const stateEpoch = typeof state.armEpoch'));
  assert.ok(epochBranch.length > 0, 'the epoch branch exists');
  const postArmAccept = epochBranch.indexOf('if (item.postArm === true) return null;');
  const timeGate = epochBranch.indexOf('terminalTrigger.completionAfterArm(state, item)');
  assert.ok(postArmAccept > 0, 'a postArm=true candidate is accepted outright');
  assert.ok(timeGate > postArmAccept,
    'and that acceptance happens *before* any completionAfterArm call -- there is no time check');
});

test('T149: with the journal entry gone, a postArm=true re-offer is admitted (the hazard)', () => {
  const state = armed();
  const marked = TT.markAttempt(state, LONG_RUN, ARM + 70 * 1000);
  const settled = TT.settle(marked.state, marked.key,
    { sent: true, pageWriteAttempted: true, code: null }, ARM + 80 * 1000);
  assert.equal(settled.state.seen[marked.key].state, 'sent', 'the run was delivered once');

  // Exactly the state b8103e7 could reach: delivered, then trimmed away by the bound.
  const evicted = { ...settled.state, seen: {}, receipts: {}, enabled: true };
  const verdict = TT.admit(evicted, LONG_RUN, ARM + 200000);
  assert.equal(verdict.admit, true,
    'the journal is the last guard: without it the same run is admitted again');
  assert.equal(verdict.code, null);
});

test('T149: the journal cannot lose that entry any more, at one bound or three', () => {
  // Arm A delivers a long run: it started 40 minutes before the arm and finished a minute after,
  // so the host's verdict was `postArm: true` and the entry carries that verdict for ever.
  const first = armed();
  assert.equal(first.armEpoch === undefined, true, 'no epoch on this arm: the time gate applies');
  const marked = TT.markAttempt(first, LONG_RUN, ARM + 70 * 1000);
  const settled = TT.settle(marked.state, marked.key,
    { sent: true, pageWriteAttempted: true, code: null }, ARM + 80 * 1000);
  assert.equal(settled.state.seen[marked.key].state, 'sent');
  const key = marked.key;

  // Arm B is granted three hours later, i.e. *after* that run ended -- which is exactly the
  // condition b8103e7 used to evict it. Then the journal crosses the bound.
  const second = TT.configure(settled.state,
    { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-149', true, ARM + 3 * HOUR);
  assert.equal(second.result.ok, true, JSON.stringify(second.result));
  const state = second.state;
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES * 3; i += 1) {
    const id = uuid(i + 100000);
    state.seen[TT.key(id, 'completed')] = { runId: id, status: 'completed',
      state: 'sent', attemptedAt: ARM - (i + 1) * 60 * 1000, settledAt: ARM - (i + 1) * 60 * 1000,
      reason: null, origin: 'bridge', endedAtMs: ARM - (i + 1) * 60 * 1000 };
  }
  const bounded = TT.compactJournal(state);
  assert.ok(bounded.state.seen[key],
    'the delivered long run is still on record: b8103e7 evicted exactly this entry');
  assert.deepEqual(bounded.evicted, [], 'nothing is evicted');
  assert.equal(bounded.overflow, true, 'the bound is reported instead');
  assert.equal(bounded.state.enabled, false);
  assert.equal(bounded.state.lastError, TT.JOURNAL_OVERFLOW_CODE);
  assert.equal(Object.keys(bounded.state.seen).length, TT.MAX_SEEN_ENTRIES * 3 + 1,
    'the journal is kept whole, so the duplicate refusal is still available');

  // And the re-offer is refused by memory, not by the host's flag.
  const refused = TT.admit({ ...bounded.state, enabled: true }, LONG_RUN, ARM + 4 * HOUR);
  assert.equal(refused.code, 'duplicate_event');
});

test('T149: over capacity stops the arm instead of trimming it, and re-arming says so', () => {
  const state = armed();
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES + 5; i += 1) {
    const id = uuid(i + 200000);
    state.seen[TT.key(id, 'completed')] = { runId: id, status: 'completed', state: 'sent',
      attemptedAt: ARM + 1000 + i, settledAt: ARM + 1000 + i, reason: null, origin: 'bridge' };
  }
  const bounded = TT.compactJournal(state);
  assert.equal(bounded.remaining, TT.MAX_SEEN_ENTRIES + 5, 'no trim, even at the bound');
  const stopped = TT.admit(bounded.state, { ...LONG_RUN, runId: uuid(777001) });
  assert.equal(stopped.code, 'trigger_disabled', 'the arm is off, so nothing can be written');

  const rearm = TT.configure(bounded.state,
    { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-149', true, ARM + 2 * HOUR);
  assert.equal(rearm.result.ok, false);
  assert.equal(rearm.result.code, TT.JOURNAL_OVERFLOW_CODE);
  assert.equal(rearm.result.remaining, TT.MAX_SEEN_ENTRIES + 5, 'and it does not trim as a side effect');
  assert.equal(Object.keys(rearm.state.seen).length, TT.MAX_SEEN_ENTRIES + 5,
    'the operator sees the real number, not a tidied one');
});

test('T149: nothing in the module can manufacture that evicted state any more', () => {
  const state = armed();
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES * 2; i += 1) {
    const id = uuid(i + 300000);
    state.seen[TT.key(id, 'completed')] = { runId: id, status: 'completed', state: 'sent',
      attemptedAt: ARM - (i + 1) * HOUR, settledAt: ARM - (i + 1) * HOUR,
      reason: null, origin: 'bridge', endedAtMs: ARM - (i + 1) * HOUR };
  }
  // Every one of those runs ended before this arm, i.e. exactly the set b8103e7 evicted.
  const rearmed = TT.configure(state,
    { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-149', true, ARM + 3 * HOUR);
  assert.equal(rearmed.result.ok, false, 'arming is refused rather than tidying the journal');
  assert.equal(rearmed.result.code, TT.JOURNAL_OVERFLOW_CODE);
  const kept = Object.keys(rearmed.state.seen).length;
  assert.equal(kept, TT.MAX_SEEN_ENTRIES * 2, 'every pre-arm entry is still there');
  assert.equal(rearmed.state.receipts, undefined, 'and there is no receipts path that could hide one');
});

test('T149: a crash mid-write survives the bound untouched (regression)', () => {
  const state = armed();
  const candidate = { runId: uuid(888001), status: 'completed', origin: 'bridge',
    startedAt: (ARM + 1000) / 1000, endedAtMs: ARM + 5000, postArm: true };
  const marked = TT.markAttempt(state, candidate, ARM + 6000);
  for (let i = 0; i < TT.MAX_SEEN_ENTRIES + 20; i += 1) {
    const id = uuid(i + 400000);
    marked.state.seen[TT.key(id, 'completed')] = { runId: id, status: 'completed', state: 'sent',
      attemptedAt: ARM - (i + 1) * HOUR, settledAt: ARM - (i + 1) * HOUR,
      reason: null, origin: 'bridge', endedAtMs: ARM - (i + 1) * HOUR };
  }
  const repaired = TT.reconcileAfterRestart(marked.state, ARM + 9000);
  assert.equal(repaired.state.seen[marked.key].state, 'stopped', 'the uncertain write is on record');
  const again = TT.admit({ ...repaired.state, enabled: true }, candidate);
  assert.equal(again.code, 'duplicate_event', 'so it is not written again');
});

test('T149: the bound is a refusal, so the storage cost of dedup is stated in weeks not hours', () => {
  // The number the operator has to decide about: 1024 entries is the ceiling this module will
  // dedup from, i.e. about 10 hours at the shipped `maxPerHour` of 100. Above that the arm stops
  // and stays stopped until someone looks -- which is the honest answer to "bounded storage,
  // unbounded history".
  const perEntry = 95;
  const ceilingBytes = TT.MAX_SEEN_ENTRIES * perEntry;
  const hours = TT.MAX_SEEN_ENTRIES / 100;
  assert.ok(hours < 24, 'the ceiling is ' + hours.toFixed(1) + ' hours of solid notices');
  assert.ok(ceilingBytes < 5 * 1024 * 1024 / 10, 'and ' + Math.round(ceilingBytes / 1024)
    + ' KB of the 5 MB bucket: the bound is about correctness, not about disk');
});
