// T095B147: audit of `terminalTrigger.seen` -- how big it gets, and what a bounded journal
// is allowed to delete.
//
// The risk T146 raised: `seen` is the dedup journal. Entries are only removed for a *deferral*
// (a proven pre-write refusal), so every delivered / blocked / stopped run stays for ever, and
// `chrome.storage.local` is one 5 MB bucket shared with the whole extension. A standing arm at
// the shipped ceiling (maxPerHour 100) adds up to 2400 entries a day.
//
// This suite is deliberately an *audit*, not a fix: the first attempt at bounding the journal
// (drop entries whose run ended before the arm) turned out to break two documented guarantees --
// `test_t078_legacy_state` and `test_t076_focus_defer` both require that re-arming preserves the
// history of every earlier run, and that an old run stays a `duplicate_event` rather than
// becoming a `started_before_arm` refusal. Losing that is a diagnostics regression even though
// it cannot cause a second send, so the change was reverted and this suite pins the numbers and
// the proof obligations instead. See T147_REPORT.md for the design and its blocker.
//
// What is asserted here is therefore the contract any future compaction must satisfy, not a
// compactor that does not exist yet.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TT = await import(pathToFileURL(path.join(HERE, 'extension', 'lib', 'terminal_trigger.js')).href
  + '?r=t147audit' + Math.random().toString(36).slice(2));

const ARM = 1793450000000;
const HOUR = 3600 * 1000;
const STORAGE_BUCKET = 5 * 1024 * 1024;
const BINDING = { conversationId: 'conv-147-audit', documentInstanceId: 'doc-147-audit',
  url: 'https://chatgpt.com/c/conv-147-audit', manuallyConfirmed: true };

function uuid(n) {
  return String(n).padStart(8, '0') + '-0000-4000-8000-' + String(n).padStart(12, '0');
}

function armed(overrides = {}) {
  const out = TT.configure(TT.createTriggerState(),
    { binding: BINDING, minIntervalMs: 30000, maxPerHour: 100 },
    'AUTOTRIGGER conv-147-audit', true, ARM);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  return Object.assign(out.state, overrides);
}

function delivered(state, n, attemptedAt) {
  const key = TT.key(uuid(n), 'completed');
  state.seen[key] = { runId: uuid(n), status: 'completed', state: 'sent',
    attemptedAt, settledAt: attemptedAt, reason: null, origin: 'bridge' };
  return key;
}

test('T147 audit: the journal has no bound today, and the 5 MB horizon is days not years', () => {
  const state = armed();
  for (let i = 0; i < 1200; i += 1) delivered(state, i, ARM + 60 * 1000 + i);
  assert.equal(Object.keys(state.seen).length, 1200,
    'nothing evicts a delivered entry: the journal grows without limit');

  const bytes = Buffer.byteLength(JSON.stringify(state.seen), 'utf8');
  const perEntry = bytes / 1200;
  const perDay = 100 * 24;                       // maxPerHour ceiling of the shipped standing arm
  const bytesPerDay = perEntry * perDay;
  const horizonDays = STORAGE_BUCKET / bytesPerDay;
  // These are the numbers a compaction design has to beat. If a future change makes the entry
  // bigger, or eviction impossible, this test says so instead of the operator discovering it as
  // "the popup says the arm is armed and nothing is ever sent".
  assert.ok(perEntry > 40 && perEntry < 400, 'one entry is ' + perEntry.toFixed(1) + ' bytes');
  assert.ok(horizonDays < 60, 'a 5 MB bucket lasts ' + horizonDays.toFixed(1)
    + ' days at 2400 notices/day (' + Math.round(bytesPerDay / 1024) + ' KB/day)');
  assert.ok(horizonDays > 1, 'sanity: it is not instant either (' + horizonDays.toFixed(2) + ' days)');
});

test('T147 audit: the three refusals any compaction must keep working', () => {
  const state = armed();
  const endedAtMs = ARM + 30 * 1000;
  delivered(state, 7, endedAtMs);

  const same = TT.admit(state, { runId: uuid(7), status: 'completed', origin: 'bridge',
    startedAt: (endedAtMs - 4000) / 1000, endedAtMs, postArm: true });
  assert.equal(same.code, 'duplicate_event', 'the same completion is a duplicate');

  const other = TT.admit(state, { runId: uuid(7), status: 'failed', origin: 'bridge',
    startedAt: (endedAtMs - 4000) / 1000, endedAtMs, postArm: true });
  assert.equal(other.code, 'duplicate_run', 'the same task with another status is a duplicate');

  // And the boundary gate, which is what a *later* arm relies on instead of the journal.
  const gate = TT.completionAfterArm(state, { runId: uuid(7), startedAt: (endedAtMs - 4000) / 1000 });
  assert.equal(gate.proven, true, 'this run really did start after the arm');
  const laterArm = { ...state, armedAt: endedAtMs + 60 * 1000 };
  const gateLater = TT.completionAfterArm(laterArm, { runId: uuid(7),
    startedAt: (endedAtMs - 4000) / 1000 });
  assert.equal(gateLater.proven, false);
  assert.equal(gateLater.reason, 'started_before_arm',
    'a re-armed trigger refuses it by time, not by memory -- this is what makes eviction possible');
});

test('T147 audit: the safe eviction rule, measured against the gate itself', () => {
  const state = armed();
  const postArm = [];
  const preArm = [];
  for (let i = 0; i < 400; i += 1) {
    const attemptedAt = i % 2 === 0 ? ARM - (i + 1) * HOUR : ARM + (i + 1) * HOUR;
    (attemptedAt <= ARM ? preArm : postArm).push({ i, attemptedAt, key: delivered(state, i, attemptedAt) });
  }
  assert.equal(preArm.length, 200);
  assert.equal(postArm.length, 200);
  assert.equal(Object.keys(state.seen).length, 400);

  // The proposed rule: an entry may go only when `attemptedAt <= armedAt`, because an attempt
  // happens after the run reached a terminal status, so `startedAt <= endedAtMs <= attemptedAt`
  // and the gate then answers `started_before_arm` for this arm and every later one.
  for (const item of preArm) {
    const gate = TT.completionAfterArm(state, { runId: uuid(item.i), startedAt: (item.attemptedAt - 1000) / 1000 });
    assert.equal(gate.reason, 'started_before_arm', 'pre-arm entry ' + item.i + ' is gate-refused');
  }
  // Entries at or after the arm are the ones the journal must keep: the host re-offers them
  // after a lost ACK and the gate *would* admit them.
  for (const item of postArm) {
    const gate = TT.completionAfterArm(state, { runId: uuid(item.i), startedAt: (item.attemptedAt - 1000) / 1000 });
    assert.equal(gate.proven, true, 'post-arm entry ' + item.i + ' is gate-admissible, so it stays');
  }
});

test('T147 audit: an in-flight attempt is never evictable, and the barrier proves it', () => {
  const state = armed();
  const key = TT.key(uuid(11), 'completed');
  const candidate = { runId: uuid(11), status: 'completed', origin: 'bridge', postArm: true,
    startedAt: (ARM + 1000) / 1000, endedAtMs: ARM + 5000 };
  const marked = TT.markAttempt(state, candidate, ARM + 6000);
  assert.equal(marked.state.seen[key].state, 'attempting');
  assert.equal(marked.state.pendingAttempt.key, key);

  const whileInFlight = TT.admit(marked.state, { ...candidate, runId: uuid(12),
    startedAt: (ARM + 2000) / 1000 });
  assert.equal(whileInFlight.code, 'attempt_in_flight',
    'a second write is impossible while the barrier is up');

  // A restart retires it as `stopped` (a write may have happened), so the entry must exist for
  // that verdict to be recorded at all: eviction must skip `attempting` entries.
  const repaired = TT.reconcileAfterRestart(marked.state, ARM + 9000);
  assert.equal(repaired.state.seen[key].state, 'stopped', 'the crash is journaled, not dropped');
  assert.equal(repaired.state.pendingAttempt === undefined || repaired.state.pendingAttempt === null,
    true, 'and the barrier is cleared');
});

test('T147 audit: the stored state keeps its documented shape (a compactor must not add unversioned fields)', () => {
  const state = armed();
  const expected = ['version', 'enabled', 'armedAt', 'minIntervalMs', 'maxPerHour',
    'maxTriggers', 'triggers', 'singleShotTrigger', 'expiresAt', 'seen', 'deferred',
    'pendingAttempt', 'lastSentAt', 'windowStartedAt', 'windowCount', 'lastError',
    'disabledAt', 'lastTick'];
  const keys = Object.keys(TT.createTriggerState());
  for (const field of expected) {
    assert.ok(keys.includes(field), 'the schema keeps ' + field + ': ' + keys.join(','));
  }
  assert.equal(state.version, TT.createTriggerState().version,
    'a journal change must not bump the schema version silently');
});
