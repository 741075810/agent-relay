// T095B142: a restricted trigger must be able to fire even when other completions
// are sitting in the queue, and a pre-write refusal must not burn the one shot.
//
// T141 proved two defects in the shipped build:
//   1. `guardSingleCandidate` vetoed the *whole* set as soon as two post-arm
//      candidates existed, so a live install with 43 queued completions could never
//      send anything (0 writer calls, `single_shot_multiple_candidates` x43).
//   2. `markAttempt` spent the shot before the page was touched, and `settle`'s
//      deferral branch (focus lost, composer occupied, stale probe) dropped `seen`
//      without giving the shot back -- one focus blip and the arm was dead for the
//      rest of its fifteen minutes ("trigger_limit_reached").
//
// These tests are written against the contract this commit establishes:
//   * exactly one candidate is released per restricted arm, chosen as the earliest
//     completion that started after the arm; a genuine tie is refused, never guessed;
//   * the shot is spent by a write that was sent or may have been sent, not by a
//     refusal that provably never reached the page;
//   * an attempt in flight blocks other candidates instead of being silently
//     outnumbered, and a restart during an attempt still leaves the arm spent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const EXT = new URL('./extension/', import.meta.url);
const trigger = await import(new URL('lib/terminal_trigger.js', EXT).href);

const CONV = 'conv-t142';
const BINDING = { tabId: 4242, windowId: 5, url: 'https://chatgpt.com/c/' + CONV,
  conversationId: CONV, documentInstanceId: 'doc-t142', revision: 7, manuallyConfirmed: true };
const ARMED_AT = 1_793_426_689_000;          // 2026-10-31T06:04:49Z, the live arm moment

function onceArm(now = ARMED_AT) {
  const configured = trigger.configureOnce(trigger.createTriggerState(), { binding: BINDING },
    trigger.ONCE_CONFIRM_PREFIX + CONV, true, now);
  assert.equal(configured.result.ok, true, JSON.stringify(configured.result));
  return configured.state;
}

// `startedAt` is seconds (the host truncates), `endedAtMs` is the ordering key.
function candidate(runId, startedAtSec, endedAtMs, extra = {}) {
  return Object.assign({ runId, status: 'completed', origin: 'bridge',
    startedAt: startedAtSec, endedAtMs, postArm: true }, extra);
}

function postArmCandidate(index, endedAtMs) {
  const tail = String(index).padStart(12, '0');
  return candidate('0000000' + (index % 10) + '-b142-4a42-8a42-' + tail,
    ARMED_AT / 1000 + 1 + index, endedAtMs);
}

const T139_RUN = '8173f25e-72f0-4e1d-beaf-e35db64d6c7f';

test('T142: 43 post-arm candidates release exactly the earliest one', () => {
  const state = onceArm();
  const candidates = [candidate(T139_RUN, ARMED_AT / 1000 + 41, ARMED_AT + 60_000)];
  for (let i = 0; i < 42; i += 1) {
    candidates.push(postArmCandidate(i + 2, ARMED_AT + 120_000 + i * 1000));
  }
  const guard = trigger.guardSingleCandidate(state, candidates, ARMED_AT + 300_000);
  assert.equal(guard.ok, true, JSON.stringify(guard));
  assert.equal(guard.count, 43);
  assert.equal(guard.chosen, T139_RUN, 'the earliest completion after the arm is the next message');
});

test('T142: a genuine tie is refused, not guessed', () => {
  const state = onceArm();
  const a = candidate('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', ARMED_AT / 1000 + 5, ARMED_AT + 70_000);
  const b = candidate('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', ARMED_AT / 1000 + 6, ARMED_AT + 70_000);
  const guard = trigger.guardSingleCandidate(state, [a, b], ARMED_AT + 300_000);
  assert.equal(guard.ok, false);
  assert.equal(guard.code, 'single_shot_multiple_candidates');
  assert.deepEqual(guard.runIds.slice().sort(), [a.runId, b.runId].sort());
});

test('T142: an earlier completion from before the arm can never be chosen', () => {
  const state = onceArm();
  const old = candidate('cccccccc-3333-4333-8333-cccccccccccc', ARMED_AT / 1000 - 600, ARMED_AT - 500_000);
  const freshOne = candidate('dddddddd-4444-4444-8444-dddddddddddd', ARMED_AT / 1000 + 3, ARMED_AT + 90_000);
  const guard = trigger.guardSingleCandidate(state, [old, freshOne], ARMED_AT + 300_000);
  assert.equal(guard.ok, true);
  assert.equal(guard.chosen, freshOne.runId);
  assert.equal(guard.count, 1, 'the pre-arm entry is not eligible at all');
});

test('T142: a candidate in deferral backoff does not block a ready one', () => {
  const state = onceArm();
  const slow = candidate('eeeeeeee-5555-4555-8555-eeeeeeeeeeee', ARMED_AT / 1000 + 2, ARMED_AT + 30_000);
  const ready = candidate('ffffffff-6666-4666-8666-ffffffffffff', ARMED_AT / 1000 + 3, ARMED_AT + 40_000);
  const marked = trigger.markAttempt(state, slow, ARMED_AT + 50_000);
  const deferred = trigger.settle(marked.state, marked.key,
    { sent: false, pageWriteAttempted: false, code: 'target_not_visible_and_focused' },
    ARMED_AT + 50_000).state;
  const guard = trigger.guardSingleCandidate(deferred, [slow, ready], ARMED_AT + 51_000);
  assert.equal(guard.ok, true, JSON.stringify(guard));
  assert.equal(guard.chosen, ready.runId);
});

test('T142: a pre-write deferral keeps the shot', () => {
  const state = onceArm();
  const one = candidate(T139_RUN, ARMED_AT / 1000 + 41, ARMED_AT + 60_000);
  const marked = trigger.markAttempt(state, one, ARMED_AT + 60_100);
  assert.equal(trigger.singleShotRemaining(marked.state).remaining, 1,
    'the attempt marker alone must not spend the shot');
  const settled = trigger.settle(marked.state, marked.key,
    { sent: false, pageWriteAttempted: false, code: 'target_not_visible_and_focused' },
    ARMED_AT + 60_200);
  assert.equal(settled.result.status, 'deferred');
  assert.equal(trigger.singleShotRemaining(settled.state).remaining, 1);
  assert.equal(settled.state.pendingAttempt || null, null, 'the in-flight marker is cleared');
  // And the retry can actually reach the page.
  const retryAt = trigger.nextRetryAt(1, ARMED_AT + 60_200);
  const again = trigger.admit(settled.state, one, retryAt + 1);
  assert.equal(again.admit, true, JSON.stringify(again));
});

test('T142: an attempt in flight blocks the next candidate instead of being outnumbered', () => {
  const state = onceArm();
  const a = candidate('11111111-7777-4777-8777-111111111111', ARMED_AT / 1000 + 5, ARMED_AT + 70_000);
  const b = candidate('22222222-8888-4888-8888-222222222222', ARMED_AT / 1000 + 6, ARMED_AT + 80_000);
  const marked = trigger.markAttempt(state, a, ARMED_AT + 90_000);
  const verdict = trigger.admit(marked.state, b, ARMED_AT + 90_100);
  assert.equal(verdict.admit, false);
  assert.equal(verdict.code, 'attempt_in_flight');
});

test('T142: a send spends the shot, and only then', () => {
  const state = onceArm();
  const one = candidate(T139_RUN, ARMED_AT / 1000 + 41, ARMED_AT + 60_000);
  const other = candidate('33333333-9999-4999-8999-333333333333', ARMED_AT / 1000 + 42, ARMED_AT + 61_000);
  const marked = trigger.markAttempt(state, one, ARMED_AT + 62_000);
  const sent = trigger.settle(marked.state, marked.key,
    { sent: true, pageWriteAttempted: true }, ARMED_AT + 62_500);
  assert.equal(trigger.singleShotRemaining(sent.state).remaining, 0);
  const spent = trigger.admit(sent.state, other, ARMED_AT + 63_000);
  assert.equal(spent.admit, false);
  assert.equal(spent.code, 'trigger_limit_reached');
});

test('T142: an uncertain write spends the shot and stops the arm', () => {
  const state = onceArm();
  const one = candidate(T139_RUN, ARMED_AT / 1000 + 41, ARMED_AT + 60_000);
  const marked = trigger.markAttempt(state, one, ARMED_AT + 62_000);
  const settled = trigger.settle(marked.state, marked.key,
    { sent: false, pageWriteAttempted: true, code: 'page_write_uncertain' }, ARMED_AT + 62_500);
  assert.equal(settled.result.code, 'stopped');
  assert.equal(settled.state.enabled, false);
  assert.equal(trigger.singleShotRemaining(settled.state).remaining, 0);
});

test('T142: a restart during an attempt still leaves the arm spent', () => {
  const state = onceArm();
  const one = candidate(T139_RUN, ARMED_AT / 1000 + 41, ARMED_AT + 60_000);
  const marked = trigger.markAttempt(state, one, ARMED_AT + 62_000);
  const reconciled = trigger.reconcileAfterRestart(marked.state, ARMED_AT + 70_000);
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.state.enabled, false, 'doubt stops the arm');
  assert.equal(trigger.singleShotRemaining(reconciled.state).remaining, 0,
    'a write may have landed, so the shot is gone');
  assert.equal(reconciled.state.pendingAttempt || null, null);
});

test('T142: the same run cannot be written twice under a second status', () => {
  const state = onceArm();
  const one = candidate(T139_RUN, ARMED_AT / 1000 + 41, ARMED_AT + 60_000);
  const marked = trigger.markAttempt(state, one, ARMED_AT + 62_000);
  const sent = trigger.settle(marked.state, marked.key, { sent: true, pageWriteAttempted: true },
    ARMED_AT + 62_500).state;
  const failed = Object.assign({}, one, { status: 'failed' });
  // The cap is checked before the journal, so a spent arm answers `trigger_limit_reached`.
  assert.equal(trigger.admit(sent, failed, ARMED_AT + 63_000).code, 'trigger_limit_reached');
  // Dedup itself is proved on a standing arm, where no cap shadows it.
  const standing = trigger.configure(trigger.createTriggerState(), { binding: BINDING },
    trigger.CONFIRM_PREFIX + CONV, true, ARMED_AT).state;
  const marked2 = trigger.markAttempt(standing, one, ARMED_AT + 62_000);
  const sent2 = trigger.settle(marked2.state, marked2.key,
    { sent: true, pageWriteAttempted: true }, ARMED_AT + 62_500).state;
  assert.equal(trigger.admit(sent2, one, ARMED_AT + 63_000).code, 'duplicate_event');
  assert.equal(trigger.admit(sent2, failed, ARMED_AT + 63_000).code, 'duplicate_run');
});

// --- background-level: the tick must actually reach the writer exactly once -----

function makeChrome(seed) {
  const store = { local: Object.assign({}, seed), session: {} };
  const clears = [];
  const inert = { addListener() {}, removeListener() {}, hasListener() { return false; } };
  const area = (bag) => ({
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) {
        out[k] = Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : v;
      }
      return out;
    },
    async set(patch) { Object.assign(bag, patch); },
    async remove(k) { delete bag[k]; },
  });
  const chrome = {
    storage: { local: area(store.local), session: area(store.session) },
    alarms: { async create() {}, async get() { return null; },
      async clear(name) { clears.push(name); return true; }, onAlarm: inert },
    runtime: {
      onMessage: { addListener() {} }, onInstalled: inert, onStartup: inert,
      lastError: null, id: 'p'.repeat(32),
      getURL: (rel) => 'chrome-extension://' + 'p'.repeat(32) + '/' + rel,
      connectNative() {
        const handlers = [];
        return {
          postMessage(msg) {
            const armed = store.local.terminalTrigger || {};
            const result = msg.op === 'terminal-arm-snapshot'
              ? { ok: true, epoch: msg.args.epoch, count: 0, takenAt: Math.floor(Date.now() / 1000) }
              : { ok: true, candidates: [], acked: [], armEpoch: armed.armEpoch || null };
            setTimeout(() => handlers.forEach((fn) => fn({ v: 1, id: msg.id, ok: true, result })), 0);
          },
          onMessage: { addListener(fn) { handlers.push(fn); } },
          onDisconnect: { addListener() {} },
          disconnect() {},
        };
      },
    },
    tabs: {
      async get(id) { return { id, windowId: 5, url: 'https://chatgpt.com/c/' + CONV, active: true }; },
      async query() { return []; },
      async sendMessage() { return { ok: false, reason: 'no_content_script_in_test' }; },
      onActivated: inert, onUpdated: inert, onRemoved: inert,
      onReplaced: inert, onDetached: inert, onAttached: inert,
    },
    windows: { onFocusChanged: inert },
    scripting: { async executeScript() { return []; } },
    notifications: { async create() {} },
  };
  return { chrome, store, clears };
}

function liveState(candidates) {
  const state = {
    version: 1, enabled: true, armedAt: ARMED_AT, minIntervalMs: 30_000, maxPerHour: 100,
    maxTriggers: 1, triggers: 0, singleShotTrigger: true,
    expiresAt: ARMED_AT + trigger.ONCE_TTL_MS, lastSentAt: null,
    windowStartedAt: ARMED_AT, windowCount: 0, lastError: null, disabledAt: null,
    seen: {}, deferred: {}, preArmCandidateKeys: [], armEpoch: 't142-epoch',
    armSnapshotAt: Math.floor(ARMED_AT / 1000), armSnapshotCount: 40,
  };
  return {
    terminalTrigger: state,
    autosend: {
      version: 1, enabled: true, deliveryMode: 'foreground', minSendIntervalMs: 30_000,
      armedAt: ARMED_AT, expiresAt: ARMED_AT + trigger.ONCE_TTL_MS, maxSends: 1,
      sentCount: 0, singleShot: true, lastError: null, disabledAt: null, journal: {},
      binding: BINDING,
    },
    terminalCandidates: candidates,
    t053TargetBindingState: { version: 1, revision: 1, candidates: [],
      candidateScannedAt: null, binding: BINDING },
  };
}

async function boot(world) {
  globalThis.chrome = world.chrome;
  return import(new URL('background.js', EXT).href + '?r=' + Math.random());
}

test('T142 e2e: 43 queued completions produce one write, not a deadlock', async () => {
  const candidates = [candidate(T139_RUN, ARMED_AT / 1000 + 41, ARMED_AT + 60_000)];
  for (let i = 0; i < 42; i += 1) {
    candidates.push(postArmCandidate(i + 2, ARMED_AT + 120_000 + i * 1000));
  }
  const world = makeChrome(liveState(candidates));
  const bg = await boot(world);
  const writes = [];
  const run = await bg.runTerminalTrigger({
    now: () => ARMED_AT + 300_000,
    sendOnce: async (cand) => { writes.push(cand.runId);
      return { sent: true, pageWriteAttempted: true, code: null, state: {} }; },
  });
  assert.deepEqual(writes, [T139_RUN], 'exactly the earliest completion is released');
  const queued = run.results.filter((row) => row.code === 'single_shot_queued');
  assert.equal(queued.length, 42, JSON.stringify(run.results.map((r) => r.code)));
  const held = world.store.local.terminalCandidates.filter((c) => c.runId !== T139_RUN);
  assert.equal(held.length, 42, 'the rest stay queued for a later arm, not acknowledged as sent');
  assert.equal(world.store.local.terminalTrigger.enabled, false, 'the shot was spent by the send');
  assert.equal(trigger.singleShotRemaining(world.store.local.terminalTrigger).remaining, 0);
  assert.ok(world.clears.includes('dsh-terminal-trigger'), 'the alarm is cleared with the arm');
  assert.equal(world.store.local.terminalTrigger.lastTick.guard.chosen, T139_RUN);
});

test('T142 e2e: losing focus twice does not spend the shot, and a later tick sends', async () => {
  const one = candidate(T139_RUN, ARMED_AT / 1000 + 41, ARMED_AT + 60_000);
  const world = makeChrome(liveState([one]));
  const bg = await boot(world);
  const writes = [];
  const refuse = async (cand) => { writes.push(cand.runId);
    return { sent: false, pageWriteAttempted: false,
      code: 'target_not_visible_and_focused', state: {} }; };
  const first = await bg.runTerminalTrigger({ now: () => ARMED_AT + 61_000, sendOnce: refuse });
  assert.equal(first.results.filter((row) => row.code.startsWith('deferred:')).length, 1,
    JSON.stringify(first.results));
  const afterFirst = world.store.local.terminalTrigger;
  assert.equal(afterFirst.enabled, true, 'a pre-write refusal must not stop the arm');
  assert.equal(trigger.singleShotRemaining(afterFirst).remaining, 1, 'and must not spend the shot');
  assert.equal(afterFirst.pendingAttempt || null, null);

  const retryAt = trigger.nextRetryAt(1, ARMED_AT + 61_000);
  const second = await bg.runTerminalTrigger({
    now: () => retryAt + 1,
    sendOnce: async (cand) => { writes.push(cand.runId);
      return { sent: true, pageWriteAttempted: true, code: null, state: {} }; },
  });
  assert.equal(second.results.filter((row) => row.sent === true).length, 1,
    JSON.stringify(second.results));
  assert.equal(world.store.local.terminalTrigger.enabled, false);
  assert.deepEqual(writes, [T139_RUN, T139_RUN]);
});
