// A restricted trigger must die with its window, even across a restart.
//
// `configureOnce()` gives the T059 arm a 15-minute window, and `admit()` refuses with
// `trigger_expired` once that window is gone. Both are covered by test_t095b123_trigger_once.mjs.
// What neither covers is the *restart path*: the arm lives in `chrome.storage.local`, so it
// outlives the worker, and `reconcileAfterRestart()` rewrites only journal entries stuck in
// `attempting`. An expired restricted arm therefore comes back `enabled: true` after a restart:
// the popup reports a live arm that cannot ever fire, and `syncTerminalAlarm()` keeps the hourly
// alarm scheduled because it only clears an alarm for `enabled !== true`.
//
// The sibling module already does the right thing -- `autosend.reconcileAfterRestart()` expires
// its grant with `authorization_expired` -- which is what makes the asymmetry a defect rather
// than a design choice. These tests fail against the code as it stood, and they fail closed
// either way: nothing here can send.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as trigger from './extension/lib/terminal_trigger.js';
import * as autosend from './extension/lib/autosend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, 'extension');
const CONV = 'conv-restart-0001';
const BINDING = {
  tabId: 4242, windowId: 5,
  url: 'https://chatgpt.com/c/' + CONV,
  conversationId: CONV,
  documentInstanceId: 'doc-restart-0001',
  revision: 7,
  manuallyConfirmed: true,
};

const ARMED_AT = 1_000_000;
const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function restrictedArm(now = ARMED_AT) {
  const done = trigger.configureOnce(trigger.createTriggerState(),
    { binding: BINDING }, trigger.ONCE_CONFIRM_PREFIX + CONV, true, now);
  assert.equal(done.result.ok, true, JSON.stringify(done.result));
  return done.state;
}

test('restart: a restricted arm whose window has passed comes back disabled', () => {
  const armed = restrictedArm();
  const expiredAt = armed.expiresAt + 60_000;
  const after = trigger.reconcileAfterRestart(armed, expiredAt);
  assert.equal(after.changed, true, 'the repair must be reported so the background persists it');
  assert.equal(after.state.enabled, false, 'an expired restricted arm must not come back armed');
  assert.equal(after.state.lastError, 'single_shot_trigger_expired');
  assert.equal(after.state.singleShotTrigger, true, 'the record still names what it was');
  assert.equal(after.state.expiresAt, armed.expiresAt, 'the window is history, not a new one');
});

test('restart: a restricted arm still inside its window is untouched', () => {
  const armed = restrictedArm();
  const inside = armed.expiresAt - 60_000;
  const after = trigger.reconcileAfterRestart(armed, inside);
  assert.equal(after.changed, false, 'nothing to repair inside the window');
  assert.equal(after.state.enabled, true);
  assert.equal(after.state.expiresAt, armed.expiresAt);
  assert.equal(after.state.lastError, null);
  // and it must still admit a candidate that finished after the arm
  const admitted = trigger.admit(after.state,
    { runId: RUN, status: 'completed', origin: trigger.ORIGIN_BRIDGE,
      startedAt: ARMED_AT / 1000 + 1, endedAtMs: ARMED_AT + 30_000, postArm: true }, inside);
  assert.equal(admitted.admit, true, JSON.stringify(admitted));
});

test('restart: a standing arm is never expired by the restart path', () => {
  const standing = trigger.configure(trigger.createTriggerState(),
    { binding: BINDING }, trigger.CONFIRM_PREFIX + CONV, true, ARMED_AT).state;
  assert.equal(standing.singleShotTrigger, false);
  const far = ARMED_AT + 30 * 24 * 60 * 60 * 1000;
  const after = trigger.reconcileAfterRestart(standing, far);
  assert.equal(after.state.enabled, true,
    'a standing arm has no window; a month later it is still what the operator armed');
  assert.equal(after.state.lastError, null);
  assert.equal(after.changed, false);
});

test('restart: the journal repair still happens when the arm has also expired', () => {
  const armed = restrictedArm();
  const marked = trigger.markAttempt(armed,
    { runId: RUN, status: 'completed', origin: trigger.ORIGIN_BRIDGE,
      startedAt: ARMED_AT / 1000 + 1, endedAtMs: ARMED_AT + 30_000, postArm: true },
    ARMED_AT + 35_000);
  assert.equal(marked.state.seen[marked.key].state, 'attempting');
  const after = trigger.reconcileAfterRestart(marked.state, armed.expiresAt + 1);
  assert.equal(after.state.seen[marked.key].state, 'stopped', 'a stuck attempt is still stopped');
  assert.match(String(after.state.seen[marked.key].reason), /worker_restarted_during_attempt/);
  assert.equal(after.state.enabled, false);
  // The journal entry must survive: deleting it would let the same run be offered again.
  const offeredAgain = trigger.admit(after.state,
    { runId: RUN, status: 'completed', origin: trigger.ORIGIN_BRIDGE,
      startedAt: ARMED_AT / 1000 + 1, endedAtMs: ARMED_AT + 30_000, postArm: true },
    armed.expiresAt + 2);
  assert.equal(offeredAgain.admit, false, 'a stopped attempt is never re-offered');
  assert.equal(offeredAgain.code, 'trigger_disabled');
});

test('restart: the send grant and the trigger agree about expiry', () => {
  // The property being pinned is symmetry: the same restart, the same wall clock, the same
  // answer from both stores. A grant that expires while an arm does not is how the UI ends up
  // describing two different truths.
  const grant = autosend.arm(autosend.createAutoSendState(),
    { binding: BINDING, singleShot: true },
    autosend.SINGLE_SHOT_CONFIRM_PREFIX + CONV, true, ARMED_AT);
  assert.equal(grant.result.ok, true, JSON.stringify(grant.result));
  const armedGrant = grant.state;
  const grantAfter = autosend.reconcileAfterRestart(armedGrant, armedGrant.expiresAt + 1);
  assert.equal(grantAfter.state.enabled, false);
  assert.equal(grantAfter.state.lastError, 'authorization_expired');
  const armAfter = trigger.reconcileAfterRestart(restrictedArm(), armedGrant.expiresAt + 1);
  assert.equal(armAfter.state.enabled, false,
    'the trigger must reach the same verdict as the grant at the same instant');
});

// ---------------------------------------------------------------- the runtime, not the module
// A module that returns `{changed:true}` is worth nothing if nothing persists it or the alarm
// keeps waking. This half drives the real background.js against a chrome mock.

function makeChrome() {
  const store = { local: {}, session: {} };
  const alarms = new Map();
  const listeners = [];
  const clears = [];
  const inert = { addListener() {}, removeListener() {}, hasListener() { return false; } };
  const EXT_ID = 'p'.repeat(32);
  const POPUP_URL = 'chrome-extension://' + EXT_ID + '/popup.html';
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
      onInstalled: inert, onStartup: inert, lastError: null,
      id: EXT_ID,
      getURL: (rel) => 'chrome-extension://' + EXT_ID + '/' + rel,
      connectNative() {
        const handlers = [];
        return {
          postMessage(msg) {
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
      },
    },
    tabs: {
      async get(id) { return { id, windowId: 2, url: BINDING.url, active: true }; },
      async query() { return []; },
      async sendMessage() { return { ok: false, reason: 'no_content_script_in_test' }; },
      onActivated: inert, onUpdated: inert, onRemoved: inert,
      onReplaced: inert, onDetached: inert, onAttached: inert,
    },
    windows: { onFocusChanged: inert },
    scripting: { async executeScript() { return []; } },
    notifications: { async create() {} },
  };
  return { chrome, store, alarms, listeners, clears, EXT_ID, POPUP_URL };
}

async function boot(world) {
  globalThis.chrome = world.chrome;
  return import(pathToFileURL(path.join(EXT, 'background.js')).href
    + '?r=restart' + Math.random().toString(36).slice(2));
}

test('runtime: a tick after the window persists the disable and clears the alarm', async () => {
  const world = makeChrome();
  const bg = await boot(world);
  // A restricted arm armed in the past, its window long gone, and an alarm Chrome still holds.
  const armed = restrictedArm(ARMED_AT);
  world.store.local.terminalTrigger = armed;
  await world.chrome.alarms.create('dsh-terminal-trigger', { periodInMinutes: 1 });
  const after = await bg.runTerminalTrigger({
    now: () => armed.expiresAt + 60_000,
    sendOnce: async () => { throw new Error('nothing may be sent by an expired arm'); },
  });
  assert.equal(after.state.enabled, false, JSON.stringify(after.state));
  assert.equal(after.state.lastError, 'single_shot_trigger_expired');
  assert.equal(world.store.local.terminalTrigger.enabled, false,
    'the disable must be persisted, not just returned');
  assert.ok(world.clears.includes('dsh-terminal-trigger'),
    'the dead arm must not keep an hourly wake-up: ' + JSON.stringify(world.clears));
});

test('runtime: a popup state read also repairs an expired restricted arm', async () => {
  const world = makeChrome();
  const bg = await boot(world);
  const armed = restrictedArm(ARMED_AT);
  world.store.local.terminalTrigger = armed;
  const reply = await new Promise((resolve) => {
    let done = false;
    const send = (r) => { if (!done) { done = true; resolve(r); } };
    for (const fn of world.listeners) {
      fn({ type: 't059-trigger-state' },
        { id: world.EXT_ID, url: world.POPUP_URL }, send);
    }
    setTimeout(() => send({ ok: false, error: 'no_response' }), 2000);
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  // The read must not lie about the window either, whatever the storage says.
  assert.equal(reply.result.enabled, false,
    'an expired restricted arm must not be reported as armed');
});

test('source: both reconcile sites clear the alarm when the repair disables the arm', () => {
  const js = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  const sites = js.split('reconcileAfterRestart(').slice(1);
  assert.ok(sites.length >= 2, 'expected the startup and tick reconcile sites');
  for (const site of sites) {
    const window = site.slice(0, 900);
    assert.match(window, /syncTerminalAlarm\(\)/,
      'a reconcile that can disable the arm must clear its alarm in the same step');
  }
});
