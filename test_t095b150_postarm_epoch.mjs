// T095B150: the host's `postArm` verdict is a proof about *one* snapshot, so it needs the epoch it
// was made under.
//
// The defect: `entry.postArm` is recorded once at intake and the gate used to accept
// `postArm === true` with no epoch check at all. A long task that finished after arm A's snapshot
// therefore carried a `true` that would authorise it under arm B, arm C and every later arm --
// including arms granted after the run had ended, i.e. arms that provably did not authorise it.
// Combined with the journal (which T149 proved can forget a run), that is a second write.
//
// What must survive the fix, unchanged:
//   * the legitimate long task: offered while the arm that will send it is the *current* one,
//     finished after that arm's snapshot -> still sent, exactly once;
//   * the short task: `startedAt >= armedAt`, no `postArm` field at all -> still sent;
//   * re-offers after an ACK -> still never a second write;
//   * ONCE (single-shot) behaviour is untouched -- covered by `test_t095b142_trigger_once_e2e.mjs`
//     in the same run, and by the disarm assertion at the end of the standing case here.
//
// What must be refused, and is: a verdict stamped with another epoch, and a verdict with no stamp
// at all (records written before this field existed). Both fall back to `completionAfterArm`, whose
// rule is the repository's standing invariant: `startedAt >= armedAt` or nothing.
//
// Real here: `extension/background.js`, `terminal_trigger.js`, `autosend.js`, the popup's own
// message objects. Faked: Chrome, the native host (a stub with a queue, ACKs and an arm-snapshot
// `ids` cap so truncation can be reproduced), the page writer, and the clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.T150_EXT_ROOT || path.join(HERE, 'extension');
const CONV = 'conv-t150-epoch-0001';
const DOC = 'doc-t150-epoch-0001';
const URL_OK = 'https://chatgpt.com/c/' + CONV;
const EXT_ID = 'p'.repeat(32);
const POPUP_URL = 'chrome-extension://' + EXT_ID + '/popup.html';
const MIN_INTERVAL = 30 * 1000;

function makeChrome() {
  const store = { local: {}, session: {} };
  const alarms = new Map();
  const listeners = [];
  const clears = [];
  const area = (bag) => ({
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) {
        out[k] = Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : v;
      }
      return out;
    },
    async set(patch) { Object.assign(bag, patch); },
    async remove(key) { delete bag[key]; },
  });
  const inert = { addListener() {}, removeListener() {}, hasListener() { return false; } };
  const chrome = {
    storage: { local: area(store.local), session: area(store.session) },
    alarms: {
      async create(name, info) { alarms.set(name, info); },
      async clear(name) { clears.push(name); const had = alarms.has(name);
        alarms.delete(name); return had; },
      async get(name) { return alarms.get(name) || null; },
      onAlarm: inert,
    },
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      onInstalled: inert, onStartup: inert, lastError: null, id: EXT_ID,
      getURL: (rel) => 'chrome-extension://' + EXT_ID + '/' + rel,
      connectNative() { return null; },
    },
    tabs: {
      async get(id) { return { id, windowId: 2, url: URL_OK, active: true }; },
      async query() { return []; },
      sendMessage: async () => ({ ok: false, reason: 'no_content_script_in_e2e' }),
      onActivated: inert, onUpdated: inert, onRemoved: inert, onReplaced: inert,
      onDetached: inert, onAttached: inert,
    },
    windows: { onFocusChanged: inert },
    scripting: { async executeScript() { return []; } },
    notifications: { async create() {} },
  };
  return { chrome, store, alarms, listeners, clears };
}

// Host stub. `snapshotCap` reproduces a truncated `terminal-arm-snapshot`: the host answers with at
// most that many ids, so a run that really did exist before the arm can be missing from the
// snapshot -- which is exactly the case where the host says `postArm: true` about a run it already
// knew about, and the reason the epoch stamp has to be checked rather than trusted.
function makeHost() {
  const host = {
    offered: [], forced: [], acked: [], armEpoch: null, snapshotIds: [],
    snapshotCap: 0, snapshots: [],
    push(...items) { host.offered.push(...items); return host; },
    force(item) { host.forced.push(item); return host; },
    connect() {
      const handlers = [];
      const reply = (msg, result) => setTimeout(
        () => handlers.forEach((fn) => fn({ v: 1, id: msg.id, ok: true, result })), 0);
      const port = {
        postMessage(msg) {
          const args = msg.args || {};
          if (msg.op === 'terminal-arm-snapshot') {
            host.armEpoch = args.epoch;
            const all = host.offered.map((c) => c.runId);
            host.snapshotIds = all.slice(0, Math.max(0, host.snapshotCap));
            host.snapshots.push({ epoch: args.epoch, ids: host.snapshotIds.slice(),
              truncated: host.snapshotIds.length < all.length });
            return reply(msg, { ok: true, epoch: args.epoch, ids: host.snapshotIds,
              count: host.snapshotIds.length, takenAt: Math.floor(Date.now() / 1000),
              truncated: host.snapshotIds.length < all.length });
          }
          if (msg.op === 'terminal-list') {
            const fresh = host.offered.filter((c) => !host.acked.includes(c.runId))
              .concat(host.forced);
            return reply(msg, { ok: true, candidates: fresh, acked: host.acked.slice(),
              armEpoch: host.armEpoch });
          }
          if (msg.op === 'terminal-ack') {
            const ids = Array.isArray(args.acked) ? args.acked
              : (Array.isArray(args.ids) ? args.ids : []);
            for (const id of ids) if (!host.acked.includes(id)) host.acked.push(id);
            return reply(msg, { ok: true, acked: host.acked.slice() });
          }
          if (msg.op === 'terminal-running') return reply(msg, { ok: true, running: [] });
          return reply(msg, { ok: true, events: [], cursor: '0' });
        },
        onMessage: { addListener(fn) { handlers.push(fn); } },
        onDisconnect: { addListener() {} },
        disconnect() {},
      };
      return port;
    },
  };
  return host;
}

let bootSeq = 0;
async function boot(world) {
  world.chrome.runtime.connectNative = () => world.host.connect();
  globalThis.chrome = world.chrome;
  bootSeq += 1;
  const url = pathToFileURL(path.join(ROOT, 'background.js')).href
    + '?r=t150e2e' + bootSeq + Math.random().toString(36).slice(2);
  return import(url);
}

function world0() {
  const world = makeChrome();
  world.host = makeHost();
  world.store.session.t053TargetBindingState = {
    version: 1, revision: 1, candidates: [], candidateScannedAt: null,
    binding: { tabId: 7, windowId: 2, revision: 1, url: URL_OK, conversationId: CONV,
      documentInstanceId: DOC, manuallyConfirmed: true, accountFingerprint: 'a'.repeat(64),
      accountVerified: true, boundAt: 1 },
  };
  return world;
}

function ask(world, message) {
  return new Promise((resolve) => {
    let settled = false;
    const send = (response) => { if (!settled) { settled = true; resolve(response); } };
    for (const fn of world.listeners) {
      try { fn(message, { id: EXT_ID, url: POPUP_URL, tab: undefined }, send); }
      catch (err) { send({ ok: false, error: String(err && err.message ? err.message : err) }); }
    }
    setTimeout(() => send({ ok: false, error: 'no_response' }), 2000);
  });
}

async function arm(world) {
  const sent = await ask(world, { type: 't058-arm', confirmation: 'AUTOSEND ' + CONV,
    userGesture: true, deliveryMode: 'foreground', ttlMs: 86400000, maxSends: 100 });
  assert.equal(sent.result && sent.result.ok, true, 'send grant: ' + JSON.stringify(sent));
  const armed = await ask(world, { type: 't059-trigger-arm',
    confirmation: 'AUTOTRIGGER ' + CONV, userGesture: true,
    minIntervalMs: MIN_INTERVAL, maxPerHour: 100 });
  assert.equal(armed.result && armed.result.ok, true, 'trigger grant: ' + JSON.stringify(armed));
  return world.store.local.terminalTrigger;
}

function writer(script) {
  const calls = [];
  const sends = [];
  const fn = async (cand) => {
    calls.push(cand.runId);
    const step = script.length > 1 ? script.shift() : script[0];
    const outcome = typeof step === 'function' ? step(cand) : step;
    if (outcome && outcome.sent === true) sends.push(cand.runId);
    return outcome;
  };
  fn.calls = calls;
  fn.sends = sends;
  return fn;
}

const SENT = { sent: true, pageWriteAttempted: true, code: null, state: {} };
const refused = (code) => ({ sent: false, pageWriteAttempted: false, code, state: {} });
const LONG_ID = 'e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5';
const SHORT_ID = 'f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6';

// A run that started before the arm and finished after it: the legitimate long task the host
// reports as `postArm: true`.
function longRun(armedAtMs, extra = {}) {
  return { runId: LONG_ID, status: 'completed', origin: 'bridge',
    startedAt: (armedAtMs - 40 * 60 * 1000) / 1000, endedAtMs: armedAtMs + 60 * 1000,
    postArm: true, ...extra };
}

test('T150 e2e: a verdict from the previous epoch cannot authorise a run under the new one', async () => {
  const world = world0();
  const bg = await boot(world);
  // Arm A: its snapshot is empty (nothing was terminal yet), so the long run that follows is
  // legitimately `postArm: true` for A.
  world.host.snapshotCap = 0;
  const armA = await arm(world);
  const epochA = armA.armEpoch;
  assert.ok(typeof epochA === 'string' && epochA.length > 0, 'the arm carries a host epoch');

  const run = longRun(armA.armedAt);
  world.host.push(run);
  const base = armA.armedAt + 2 * 1000;
  // The first tick cannot write (page not visible), so the entry stays stored with A's stamp.
  const w1 = writer([refused('target_not_visible_and_focused')]);
  await bg.runTerminalTrigger({ now: () => base, sendOnce: w1 });
  assert.deepEqual(w1.calls, [LONG_ID], 'the run was considered once');
  assert.equal(w1.sends.length, 0, 'and nothing was written');

  const stored = world.store.local.terminalCandidates || [];
  const entry = stored.find((row) => row.runId === LONG_ID);
  assert.ok(entry, 'the entry is kept for a retry');
  assert.equal(entry.postArm, true, 'with the host verdict on it');
  assert.equal(entry.postArmEpoch, epochA, 'stamped with the epoch it was computed under');

  // Arm B: a new epoch. Its snapshot is truncated the way a capped host snapshot can be, so the
  // already-known run is missing from `ids` and the host still calls it `postArm: true`.
  world.host.snapshotCap = 0;
  const armB = await arm(world);
  assert.notEqual(armB.armEpoch, epochA, 're-arming is a new epoch');

  const w2 = writer([SENT]);
  const tick = await bg.runTerminalTrigger({ now: () => armB.armedAt + 2 * MIN_INTERVAL,
    sendOnce: w2 });
  assert.deepEqual(w2.calls, [], 'a stale verdict must not authorise a write: '
    + JSON.stringify(tick.results));
  assert.equal(w2.sends.length, 0);
  const codes = tick.results.map((row) => row.code);
  // `pre_arm_candidate` is the queue-mirror boundary; `started_before_arm` is the time gate. Both
  // mean "this run predates the arm", and either is a correct refusal -- what must not appear is a
  // send.
  assert.ok(codes.some((code) => code === 'pre_arm_candidate' || code === 'started_before_arm'
    || code === 'queued_before_arm' || code === 'in_arm_snapshot'),
    'and it is refused for a boundary reason, not by luck: ' + JSON.stringify(codes));
  const lastTick = world.store.local.terminalTrigger.lastTick;
  assert.equal(world.store.local.terminalTrigger.seen
    ? Object.keys(world.store.local.terminalTrigger.seen).length : 0, 0,
  'nothing was journaled as sent: ' + JSON.stringify(lastTick && lastTick.guard));
});

test('T150 e2e: the current epoch still accepts a task that started before the arm', async () => {
  const world = world0();
  const bg = await boot(world);
  world.host.snapshotCap = 0;
  const armed = await arm(world);
  const run = longRun(armed.armedAt);
  world.host.push(run);
  const w = writer([SENT]);
  const tick = await bg.runTerminalTrigger({ now: () => armed.armedAt + 3 * 1000, sendOnce: w });
  assert.deepEqual(w.sendOnce === undefined ? w.calls : w.calls, [LONG_ID],
    'the legitimate long task is sent: ' + JSON.stringify(tick.results));
  assert.deepEqual(w.sends, [LONG_ID]);
  assert.deepEqual(world.host.acked, [LONG_ID], 'and acknowledged exactly once');
  const state = world.store.local.terminalTrigger;
  assert.equal(state.triggers, 1);
  assert.notEqual(state.singleShotTrigger, true, 'a standing arm is not a single shot');
});

test('T150 e2e: the sound short path is untouched (startedAt >= armedAt, no postArm field)', async () => {
  const world = world0();
  const bg = await boot(world);
  world.host.snapshotCap = 10;
  const armed = await arm(world);
  const run = { runId: SHORT_ID, status: 'completed', origin: 'bridge',
    startedAt: (armed.armedAt + 1000) / 1000, endedAtMs: armed.armedAt + 5000 };
  world.host.push(run);
  const w = writer([SENT]);
  await bg.runTerminalTrigger({ now: () => armed.armedAt + 6000, sendOnce: w });
  assert.deepEqual(w.sends, [SHORT_ID], 'the strict creation-time proof still sends');
});

test('T150 e2e: an entry written before the stamp existed falls back to the strict gate', async () => {
  const world = world0();
  const bg = await boot(world);
  world.host.snapshotCap = 0;
  const armed = await arm(world);
  // A record from an older release: `postArm` present, no epoch, sitting in the queue mirror.
  world.store.local.terminalCandidates = [{
    runId: LONG_ID, status: 'completed', origin: 'bridge',
    startedAt: (armed.armedAt - 40 * 60 * 1000) / 1000, endedAtMs: armed.armedAt + 60 * 1000,
    postArm: true, arrivedAt: armed.armedAt - 1000,
  }];
  const w = writer([SENT]);
  const tick = await bg.runTerminalTrigger({ now: () => armed.armedAt + 7000, sendOnce: w });
  assert.deepEqual(w.sends, [], 'an unbound verdict is not an authorisation: '
    + JSON.stringify(tick.results));
  const codes = tick.results.map((row) => row.code);
  assert.ok(codes.includes('pre_arm_candidate') || codes.includes('started_before_arm')
    || codes.includes('queued_before_arm'),
    'refused by a boundary gate: ' + JSON.stringify(codes));
});

test('T150 e2e: a re-offer after the ACK is still never a second write', async () => {
  const world = world0();
  const bg = await boot(world);
  world.host.snapshotCap = 0;
  const armed = await arm(world);
  const run = longRun(armed.armedAt);
  world.host.push(run);
  const w = writer([SENT]);
  await bg.runTerminalTrigger({ now: () => armed.armedAt + 3000, sendOnce: w });
  assert.deepEqual(w.sends, [LONG_ID], 'first delivery');

  world.host.force(run);
  const again = await bg.runTerminalTrigger({ now: () => armed.armedAt + 3 * MIN_INTERVAL,
    sendOnce: w });
  assert.deepEqual(w.sends, [LONG_ID], 'and no second one: ' + JSON.stringify(again.results));
  const codes = again.results.map((row) => row.code).filter(Boolean);
  assert.ok(codes.includes('duplicate_event') || codes.includes('duplicate_run'),
    'the journal refuses it: ' + JSON.stringify(codes));
});

test('T150 unit: the epoch binding, stated as a table', async () => {
  const TT = await import(pathToFileURL(path.join(ROOT, 'lib', 'terminal_trigger.js')).href
    + '?r=t150u' + Math.random().toString(36).slice(2));
  const state = { armEpoch: 'epoch-B' };
  assert.equal(TT.postArmUsable(state, { postArm: true, postArmEpoch: 'epoch-B' }), true,
    'same epoch: usable');
  assert.equal(TT.postArmUsable(state, { postArm: true, postArmEpoch: 'epoch-A' }), false,
    'older epoch: not usable');
  assert.equal(TT.postArmUsable(state, { postArm: true }), false,
    'no stamp (record from an older release): not usable');
  assert.equal(TT.postArmUsable(state, { postArm: true, postArmEpoch: null }), false,
    'null stamp: not usable');
  assert.equal(TT.postArmUsable(state, { postArm: false, postArmEpoch: 'epoch-B' }), false,
    'a `false` verdict is never usable as an authorisation');
  assert.equal(TT.postArmUsable({ armEpoch: null }, { postArm: true, postArmEpoch: 'epoch-B' }),
    false, 'no current epoch: nothing is usable');
  assert.equal(TT.postArmUsable({}, { postArm: true, postArmEpoch: 'epoch-B' }), false,
    'an arm that predates epochs: nothing is usable');
  assert.equal(TT.postArmUsable(state, null), false, 'no entry: nothing is usable');
});
