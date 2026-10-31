// T095B123 end-to-end: the popup message, the real background handler, the real trigger loop.
//
// The unit suite proves the module's rules. This one proves the *product* wiring, which is
// exactly what was missing: `terminal_trigger.configureOnce` and `disarmAfterSendOnce` existed
// as functions without a caller, so the shipped UI could not reach them at all.
//
// What is real here: `extension/background.js` itself, loaded as a module with a chrome mock
// installed as a global, its own `chrome.runtime.onMessage` listener, its own
// `runTerminalTrigger`, and the popup's own message objects.
//
// What is faked, and why: the native host (one canned `terminal-arm-snapshot` reply, because
// this suite must not read a machine's real arm snapshot), the page writer (the documented
// `sendOnce` test seam, because no page exists), and the clock. Nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'extension');
const CONV = 'conv-t123-e2e-0001';
const DOC = 'doc-t123-e2e-0001';
const URL_OK = 'https://chatgpt.com/c/' + CONV;
// The message guard in background.js insists on a real popup sender: our own extension id and
// the popup.html URL, and no tab. The id is a single repeated letter so it is self-evidently
// synthetic -- docs/PUBLISHING.md explains why that matters.
const EXT_ID = 'p'.repeat(32);
const POPUP_URL = 'chrome-extension://' + EXT_ID + '/popup.html';

function makeChrome() {
  const store = { local: {}, session: {} };
  const alarms = new Map();
  const listeners = [];
  const clears = [];
  const creates = [];

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
      async create(name, info) { creates.push([name, info]); alarms.set(name, info); },
      async clear(name) { clears.push(name); const had = alarms.has(name);
        alarms.delete(name); return had; },
      async get(name) { return alarms.get(name) || null; },
      onAlarm: inert,
    },
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      onInstalled: inert,
      onStartup: inert,
      lastError: null,
      id: EXT_ID,
      getURL: (rel) => 'chrome-extension://' + EXT_ID + '/' + rel,
      // The one native call the arm path makes. A canned reply keeps this hermetic.
      connectNative() {
        const handlers = [];
        const port = {
          postMessage(msg) {
            // Every op is answered: the arm needs a snapshot, and the trigger's own
            // `terminal-list` refresh needs a report. The report says "the source was read
            // and offered nothing", which keeps the candidates this test seeds by hand --
            // the alternative, a timeout, would exercise a different code path.
            // The `terminal-list` report echoes the arm epoch, which is what the boundary
            // gate compares: two sides disagreeing about the round proves nothing, so the
            // mock echoes what the arm stored rather than inventing one.
            const armed = store.local.terminalTrigger || {};
            const result = msg.op === 'terminal-arm-snapshot'
              ? { ok: true, epoch: msg.args.epoch, count: 0,
                takenAt: Math.floor(Date.now() / 1000) }
              : { ok: true, candidates: [], acked: [], armEpoch: armed.armEpoch || null };
            setTimeout(() => handlers.forEach((fn) =>
              fn({ v: 1, id: msg.id, ok: true, result })), 0);
          },
          onMessage: { addListener(fn) { handlers.push(fn); } },
          onDisconnect: { addListener() {} },
          disconnect() {},
        };
        return port;
      },
    },
    tabs: {
      async get(id) { return { id, windowId: 2, url: URL_OK, active: true }; },
      async query() { return []; },
      sendMessage: async () => ({ ok: false, reason: 'no_content_script_in_e2e' }),
      onActivated: inert,
      onUpdated: inert,
      onRemoved: inert,
      onReplaced: inert,
      onDetached: inert,
      onAttached: inert,
    },
    windows: { onFocusChanged: inert },
    scripting: { async executeScript() { return []; } },
    notifications: { async create() {} },
  };
  return { chrome, store, alarms, listeners, clears, creates };
}

async function boot(world) {
  globalThis.chrome = world.chrome;
  const url = pathToFileURL(path.join(ROOT, 'background.js')).href
    + '?r=t123e2e' + Math.random().toString(36).slice(2);
  return import(url);
}

function seedBinding(world) {
  world.store.session.t053TargetBindingState = {
    version: 1, revision: 1, candidates: [], candidateScannedAt: null,
    binding: { tabId: 7, windowId: 2, revision: 1, url: URL_OK,
      conversationId: CONV, documentInstanceId: DOC,
      manuallyConfirmed: true, accountFingerprint: 'a'.repeat(64),
      accountVerified: true, boundAt: 1 },
  };
}

function ask(world, message) {
  return new Promise((resolve) => {
    let settled = false;
    const send = (response) => { if (!settled) { settled = true; resolve(response); } };
    for (const fn of world.listeners) {
      try { fn(message, { id: EXT_ID, url: POPUP_URL, tab: undefined }, send); } catch (err) { send({ ok: false,
        error: String(err && err.message ? err.message : err) }); }
    }
    setTimeout(() => send({ ok: false, error: 'no_response' }), 2000);
  });
}

function candidate(runId, startedSec, status = 'completed', postArm = true) {
  // `postArm` is what the host asserts about a candidate it saw finish after the arm round
  // started; the boundary gate reads it as one of its two proofs. A historical completion must
  // say `false`, because that is what the host would say about it.
  return { runId, status, origin: 'bridge', startedAt: startedSec,
    endedAtMs: startedSec * 1000 + 4000, postArm };
}

test('T123 e2e: two restricted arms, one candidate, exactly one write, then stopped', async () => {
  const world = makeChrome();
  seedBinding(world);
  const bg = await boot(world);
  assert.ok(world.listeners.length > 0, 'the background must register a message listener');

  // 1. the send grant, exactly as the popup's button sends it
  const sendArm = await ask(world, { type: 't058-arm-once',
    confirmation: 'AUTOSEND-ONCE ' + CONV, userGesture: true });
  assert.equal(sendArm.result.ok, true, JSON.stringify(sendArm));

  // 2. the trigger grant, exactly as the second button sends it
  const trigArm = await ask(world, { type: 't059-trigger-arm-once',
    confirmation: 'AUTOTRIGGER-ONCE ' + CONV, userGesture: true });
  assert.equal(trigArm.result.ok, true, JSON.stringify(trigArm));
  assert.equal(trigArm.result.maxTriggers, 1, 'the handler must produce a capped trigger');
  const stored = world.store.local.terminalTrigger;
  assert.equal(stored.maxTriggers, 1);
  assert.equal(stored.singleShotTrigger, true);
  assert.ok(stored.expiresAt > Date.now(), 'the window must be in the future');

  // 3. a message cannot smuggle a wider cap past the handler
  const smuggled = await ask(world, { type: 't059-trigger-arm-once',
    confirmation: 'AUTOTRIGGER-ONCE ' + CONV, userGesture: true, maxTriggers: 50 });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.error, 'unexpected_fields');

  // 4. the trigger runs; the writer is the documented test seam
  const writes = [];
  const armedAt = stored.armedAt;
  const fresh = candidate('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', armedAt / 1000 + 1);
  world.store.local.terminalCandidates = [fresh];
  const run1 = await bg.runTerminalTrigger({
    now: () => armedAt + 5000,
    sendOnce: async (cand) => { writes.push(cand.runId);
      return { sent: true, pageWriteAttempted: true, code: null, state: {} }; },
  });
  assert.equal(writes.length, 1, 'exactly one write: ' + JSON.stringify(run1.results));
  assert.equal(world.store.local.terminalTrigger.enabled, false,
    'the restricted trigger must stop after the first send');
  assert.equal(world.store.local.terminalTrigger.lastError, 'single_shot_trigger_spent');
  assert.ok(world.clears.includes('dsh-terminal-trigger'),
    'the alarm must be cleared with it');

  // 5. a second completion produces no second message
  const second = candidate('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', armedAt / 1000 + 2);
  world.store.local.terminalCandidates = [second];
  await bg.runTerminalTrigger({
    now: () => armedAt + 6000,
    sendOnce: async (cand) => { writes.push(cand.runId);
      return { sent: true, pageWriteAttempted: true, code: null, state: {} }; },
  });
  assert.equal(writes.length, 1, 'no second notification, ever');
});

test('T123 e2e: two competing candidates spend nothing', async () => {
  const world = makeChrome();
  seedBinding(world);
  const bg = await boot(world);
  await ask(world, { type: 't058-arm-once', confirmation: 'AUTOSEND-ONCE ' + CONV,
    userGesture: true });
  const armed = await ask(world, { type: 't059-trigger-arm-once',
    confirmation: 'AUTOTRIGGER-ONCE ' + CONV, userGesture: true });
  assert.equal(armed.result.ok, true, JSON.stringify(armed));

  const armedAt = world.store.local.terminalTrigger.armedAt;
  world.store.local.terminalCandidates = [
    candidate('cccccccc-3333-4333-8333-cccccccccccc', armedAt / 1000 + 1),
    candidate('dddddddd-4444-4444-8444-dddddddddddd', armedAt / 1000 + 2),
  ];
  const firstId = world.store.local.terminalCandidates[0].runId;
  const writes = [];
  const run = await bg.runTerminalTrigger({
    now: () => armedAt + 5000,
    sendOnce: async (cand) => { writes.push(cand.runId);
      return { sent: true, pageWriteAttempted: true, code: null, state: {} }; },
  });
  // T142: two queued completions used to veto the whole batch, which on a live install meant
  // forty-three of them and zero sends. Exactly one is released now -- the earliest one -- and
  // the rest stay queued for a later arm.
  assert.deepEqual(writes, [firstId], 'exactly one candidate is released');
  assert.ok(run.results.some((row) => row.code === 'single_shot_queued'),
    JSON.stringify(run.results.map((row) => row.code)));
  assert.equal(world.store.local.terminalTrigger.enabled, false,
    'the shot was spent by the send, so nothing further can fire');
});

test('T123 e2e: a completion from before the arm cannot be the one trigger', async () => {
  const world = makeChrome();
  seedBinding(world);
  const bg = await boot(world);
  await ask(world, { type: 't058-arm-once', confirmation: 'AUTOSEND-ONCE ' + CONV,
    userGesture: true });
  const armed = await ask(world, { type: 't059-trigger-arm-once',
    confirmation: 'AUTOTRIGGER-ONCE ' + CONV, userGesture: true });
  assert.equal(armed.result.ok, true, JSON.stringify(armed));

  const armedAt = world.store.local.terminalTrigger.armedAt;
  // T121's shape: a task that finished well before this arm existed.
  world.store.local.terminalCandidates = [
    candidate('71d4a000-0515-47a1-b686-587ba39fbdeb', armedAt / 1000 - 3600, 'completed', false),
  ];
  const writes = [];
  await bg.runTerminalTrigger({
    now: () => armedAt + 5000,
    sendOnce: async (cand) => { writes.push(cand.runId);
      return { sent: true, pageWriteAttempted: true, code: null, state: {} }; },
  });
  assert.equal(writes.length, 0, 'a historical completion is never re-sent');
});

test('T123 e2e: an expired restricted trigger stops instead of waiting', async () => {
  const world = makeChrome();
  seedBinding(world);
  const bg = await boot(world);
  await ask(world, { type: 't058-arm-once', confirmation: 'AUTOSEND-ONCE ' + CONV,
    userGesture: true });
  const armed = await ask(world, { type: 't059-trigger-arm-once',
    confirmation: 'AUTOTRIGGER-ONCE ' + CONV, userGesture: true });
  assert.equal(armed.result.ok, true, JSON.stringify(armed));

  const state = world.store.local.terminalTrigger;
  world.store.local.terminalCandidates = [
    candidate('eeeeeeee-5555-4555-8555-eeeeeeeeeeee', state.armedAt / 1000 + 1),
  ];
  const writes = [];
  const run = await bg.runTerminalTrigger({
    now: () => state.expiresAt + 1,
    sendOnce: async (cand) => { writes.push(cand.runId);
      return { sent: true, pageWriteAttempted: true, code: null, state: {} }; },
  });
  assert.equal(writes.length, 0);
  // T137 moved this decision earlier: `reconcileAfterRestart()` now retires an expired
  // restricted arm before any candidate is looked at, so the tick returns `trigger_disabled`
  // with an empty `results` list instead of walking the queue and refusing one entry at a time.
  // That is the stronger outcome -- a dead arm does not inspect candidates at all -- and both
  // paths must keep the three guarantees below.
  assert.ok(run.results.length === 0
    || run.results.some((row) => row.code === 'trigger_expired'),
  JSON.stringify(run.results));
  assert.equal(run.fetched.code, 'trigger_disabled',
    'an expired arm must not even ask the host for candidates: ' + JSON.stringify(run.fetched));
  assert.equal(world.store.local.terminalTrigger.enabled, false,
    'expiry must disable, not leave it dormant for a later candidate');
  assert.equal(world.store.local.terminalTrigger.lastError, 'single_shot_trigger_expired');
  assert.ok(world.clears.includes('dsh-terminal-trigger'));
});
