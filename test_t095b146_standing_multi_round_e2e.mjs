// T095B146: standing (long-lived) authorisation, two rounds and beyond.
//
// The restricted ONCE path is covered by test_t095b142. This suite covers the grant the
// operator actually wants for a multi-round loop: `AUTOSEND <conv>` + `AUTOTRIGGER <conv>`,
// no cap, no window. What the product must guarantee, round after round:
//
//   * every bound-session completion produces exactly one notice, and never two;
//   * a third round is not disabled by anything the first two rounds left behind;
//   * with no grant armed, nothing is sent at all;
//   * a page refusal that proved a pre-write stop (focus lost, frozen document, a human's
//     draft in the composer) fails closed *without losing the notice*: the run stays
//     deliverable, the retry is rate-limited, and the eventual send happens once;
//   * a different binding, an expired grant, a duplicate terminal status and an uncertain
//     write are each refused, and none of them sends twice.
//
// What is real: `extension/background.js` (its own message listener, its own
// `runTerminalTrigger`, its own storage writes), `terminal_trigger.js`, `autosend.js`
// (`classifyRefusal`), and the popup's own message objects. What is faked: Chrome, the
// native host (a stub that serves a queue and honours ACKs), the page writer (the
// documented `sendOnce` seam), and the clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'extension');
const CONV = 'conv-t146-standing-0001';
const OTHER = 'conv-t146-standing-0002';
const DOC = 'doc-t146-standing-0001';
const URL_OK = 'https://chatgpt.com/c/' + CONV;
const EXT_ID = 'p'.repeat(32);
const POPUP_URL = 'chrome-extension://' + EXT_ID + '/popup.html';
const MIN_INTERVAL = 30 * 1000;

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
  return { chrome, store, alarms, listeners, clears, creates };
}

// The host stub. It keeps a queue, answers the four terminal ops, and ACKs durably, so a
// second tick sees exactly what a real host would have left. Nothing here decides anything:
// what to offer, what was acknowledged, and what the arm boundary was are all recorded.
function makeHost() {
  const host = {
    offered: [], forced: [], acked: [], armEpoch: null, snapshotIds: [],
    ops: [], ackCalls: [],
    push(...items) { host.offered.push(...items); return host; },
    // `force` re-offers a run the host already acknowledged. A real host does that when an
    // ACK reply was lost, and it is the only way to prove the trigger's own dedup.
    force(item) { host.forced.push(item); return host; },
    connect() {
      const handlers = [];
      const reply = (msg, result) => setTimeout(
        () => handlers.forEach((fn) => fn({ v: 1, id: msg.id, ok: true, result })), 0);
      const port = {
        postMessage(msg) {
          host.ops.push(msg.op);
          const args = msg.args || {};
          if (msg.op === 'terminal-arm-snapshot') {
            // The comment in the previous suite is the point: the *host* owns the snapshot.
            // It answers with the set of runs it had already seen finish, and the extension
            // uses that set as the arm boundary.
            host.armEpoch = args.epoch;
            host.snapshotIds = host.offered.map((c) => c.runId);
            return reply(msg, { ok: true, epoch: args.epoch, ids: host.snapshotIds,
              count: host.snapshotIds.length, takenAt: Math.floor(Date.now() / 1000) });
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
            host.ackCalls.push(ids.slice());
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
    + '?r=t146e2e' + bootSeq + Math.random().toString(36).slice(2);
  return import(url);
}

function seedBinding(world, conversationId = CONV, documentId = DOC) {
  world.store.session.t053TargetBindingState = {
    version: 1, revision: 1, candidates: [], candidateScannedAt: null,
    binding: { tabId: 7, windowId: 2, revision: 1,
      url: 'https://chatgpt.com/c/' + conversationId,
      conversationId, documentInstanceId: documentId,
      manuallyConfirmed: true, accountFingerprint: 'a'.repeat(64),
      accountVerified: true, boundAt: 1 },
  };
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

function world0() {
  const world = makeChrome();
  world.host = makeHost();
  seedBinding(world);
  return world;
}

function candidate(runId, startedSec, extra = {}) {
  return { runId, status: 'completed', origin: 'bridge', startedAt: startedSec,
    endedAtMs: startedSec * 1000 + 4000, postArm: true, ...extra };
}

async function armStanding(world, bg) {
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
    const step = script.shift();
    assert.ok(step, 'unexpected extra write attempt for ' + cand.runId);
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
const uncertain = (code) => ({ sent: false, pageWriteAttempted: true, code, state: {} });

// The journal is keyed `runId|status` (`terminal_trigger.key`), so a lookup by run id has to
// go through that. Doing it explicitly keeps the tests honest about the shape on disk.
function keyFor(world, runId, bag = 'seen') {
  const state = world.store.local.terminalTrigger || {};
  const keys = Object.keys(state[bag] || {});
  return keys.find((k) => k.indexOf(String(runId) + '|') === 0) || null;
}

function seenOf(world, runId) {
  const k = keyFor(world, runId, 'seen');
  return k ? world.store.local.terminalTrigger.seen[k] : undefined;
}

function deferredOf(world, runId) {
  const k = keyFor(world, runId, 'deferred');
  return k ? world.store.local.terminalTrigger.deferred[k] : undefined;
}

function runIds(world) {
  const seen = world.store.local.terminalTrigger;
  return Object.keys((seen && seen.seen) || {});
}

test('T146 e2e: two sequential rounds send exactly one notice each, and round three still fires', async () => {
  const world = world0();
  const bg = await boot(world);
  const state = await armStanding(world, bg);

  // The standing grant is the *uncapped* one: no shot counter, no window.
  assert.notEqual(state.singleShotTrigger, true, 'standing arm must not be flagged single-shot');
  assert.ok(state.maxTriggers === null || state.maxTriggers === undefined,
    'standing arm has no cap: ' + state.maxTriggers);
  assert.equal(state.enabled, true);

  const base = state.armedAt + 1000;
  const a = candidate('a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1', base / 1000 + 1);
  const b = candidate('b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2', base / 1000 + 100);
  const c = candidate('c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3', base / 1000 + 200);
  const w = writer([SENT, SENT, SENT]);

  world.host.push(a);
  const r1 = await bg.runTerminalTrigger({ now: () => base, sendOnce: w });
  assert.deepEqual(w.calls, [a.runId], 'round 1: ' + JSON.stringify(r1.results));
  assert.deepEqual(world.host.acked, [a.runId], 'round 1 must be acknowledged exactly once');

  world.host.push(b);
  const r2 = await bg.runTerminalTrigger({ now: () => base + MIN_INTERVAL + 1000, sendOnce: w });
  assert.deepEqual(w.calls, [a.runId, b.runId], 'round 2: ' + JSON.stringify(r2.results));
  assert.deepEqual(world.host.acked, [a.runId, b.runId]);

  world.host.push(c);
  const r3 = await bg.runTerminalTrigger({ now: () => base + 2 * (MIN_INTERVAL + 1000), sendOnce: w });
  assert.deepEqual(w.calls, [a.runId, b.runId, c.runId], 'round 3: ' + JSON.stringify(r3.results));

  const after = world.store.local.terminalTrigger;
  assert.equal(after.enabled, true, 'a standing arm stays armed across rounds');
  assert.equal(after.triggers, 3, 'the standing arm counts sends without capping them');
  assert.ok(!world.clears.includes('dsh-terminal-trigger'),
    'the alarm must not be cleared while a standing arm is alive');
  const codes = [...r1.results, ...r2.results, ...r3.results].map((row) => row.code).filter(Boolean);
  for (const bad of ['single_shot_queued', 'single_shot_multiple_candidates',
    'trigger_disabled', 'trigger_limit_reached', 'single_shot_trigger_spent']) {
    assert.ok(!codes.includes(bad), bad + ' must not appear: ' + JSON.stringify(codes));
  }
  // Observability: every tick records the guard verdict the popup renders, and the last one
  // (round three) must say "one candidate, released, one send" rather than a veto.
  const lastTick = world.store.local.terminalTrigger.lastTick;
  assert.equal(lastTick.guard.ok, true, 'guard verdict: ' + JSON.stringify(lastTick));
  assert.equal(lastTick.sent, 1);
  assert.equal(lastTick.guard.count, 1);
  for (const run of [r1, r2, r3]) {
    assert.ok(run.results.filter((row) => row.sent === true).length === 1,
      'each tick sends exactly one: ' + JSON.stringify(run.results.map((r) => r.code)));
  }
});

test('T146 e2e: with no grant armed, a finished task produces zero sends', async () => {
  const world = world0();
  const bg = await boot(world);
  const w = writer([]);
  world.host.push(candidate('d4d4d4d4-4444-4444-8444-d4d4d4d4d4d4', 1793427001));

  const none = await bg.runTerminalTrigger({ now: () => 1793427010000, sendOnce: w });
  assert.equal(w.calls.length, 0, 'nothing may be sent without a trigger grant');
  assert.equal(none.fetched.code, 'trigger_disabled', JSON.stringify(none.fetched));

  // A trigger grant alone is not enough either: the send grant is the other half.
  const trig = await ask(world, { type: 't059-trigger-arm', confirmation: 'AUTOTRIGGER ' + CONV,
    userGesture: true, minIntervalMs: MIN_INTERVAL, maxPerHour: 100 });
  assert.equal(trig.result.ok, true, JSON.stringify(trig));
  const armedAt = world.store.local.terminalTrigger.armedAt;
  world.store.local.terminalCandidates = [candidate('e5e5e5e5-5555-4555-8555-e5e5e5e5e5e5',
    armedAt / 1000 + 1)];
  // The writer refuses exactly as the real gate does when no grant is stored.
  const denied = writer([refused('autosend_disabled')]);
  await bg.runTerminalTrigger({ now: () => armedAt + 5000, sendOnce: denied });
  assert.equal(denied.calls.length, 1, 'the writer is consulted');
  assert.equal(runIds(world).length, 1);
  assert.equal(world.store.local.terminalTrigger.lastError, 'blocked:autosend_disabled',
    'an unarmed send grant is a pre-write block, not a send');
  assert.equal(world.store.local.terminalTrigger.enabled, false,
    'a block stops the arm rather than looping on it');
});

test('T146 e2e: a lost focus defers without losing the notice, and the retry sends once', async () => {
  const world = world0();
  const bg = await boot(world);
  const state = await armStanding(world, bg);
  const base = state.armedAt + 1000;
  const run = candidate('f6f6f6f6-6666-4666-8666-f6f6f6f6f6f6', base / 1000 + 1);
  world.host.push(run);
  const w = writer([refused('target_not_visible_and_focused'), SENT]);

  const first = await bg.runTerminalTrigger({ now: () => base, sendOnce: w });
  assert.deepEqual(w.sends, [], 'a focus refusal happens before the composer is touched');
  // ACK is a *persistence* acknowledgement, not a delivery one: the candidate is stored
  // locally and therefore acknowledged, and the deferral then retries from that store.
  assert.ok(world.host.acked.includes(run.runId), 'a persisted candidate is acknowledged');
  let after = world.store.local.terminalTrigger;
  assert.equal(after.enabled, true, 'the arm survives a deferral');
  const deferral = deferredOf(world, run.runId);
  assert.ok(deferral, 'the deferral is recorded with a retry time: ' + JSON.stringify(first.results));
  assert.equal(deferral.reason, 'target_not_visible_and_focused');
  assert.equal(deferral.attempts, 1);
  assert.equal(runIds(world).length, 0, 'a deferred run is never journaled as delivered');

  // Before the retry time the candidate is refused by backoff, not attempted again.
  const early = await bg.runTerminalTrigger({
    now: () => deferral.retryAt - 1, sendOnce: w });
  assert.deepEqual(w.sends, [], 'the retry must respect the backoff: ' + JSON.stringify(early.results));

  // Focus returns: the same run is delivered exactly once.
  const later = await bg.runTerminalTrigger({
    now: () => deferral.retryAt + 1, sendOnce: w });
  assert.deepEqual(w.sends, [run.runId], 'the deferred run is still deliverable');
  assert.deepEqual(world.host.acked, [run.runId]);
  after = world.store.local.terminalTrigger;
  assert.equal(seenOf(world, run.runId).state, 'sent');
  assert.equal(after.triggers, 1);

  // And a fourth tick does not send it again.
  world.host.force({ ...run });
  const again = await bg.runTerminalTrigger({
    now: () => deferral.retryAt + 120000, sendOnce: w });
  assert.deepEqual(w.sends, [run.runId], 'no duplicate write: ' + JSON.stringify(again.results));
});

test('T146 e2e: a human draft in the composer (and a frozen document) never burns the notice', async () => {
  const world = world0();
  const bg = await boot(world);
  const state = await armStanding(world, bg);
  const base = state.armedAt + 1000;
  const run = candidate('a7a7a7a7-7777-4777-8777-a7a7a7a7a7a7', base / 1000 + 1);
  world.host.push(run);
  const w = writer([refused('composer_not_empty'), refused('composer_not_empty'), SENT]);

  await bg.runTerminalTrigger({ now: () => base, sendOnce: w });
  let after = world.store.local.terminalTrigger;
  assert.deepEqual(w.sends, [], 'a draft in the composer is a pre-write refusal');
  assert.equal(after.enabled, true);

  let deferral = deferredOf(world, run.runId);
  await bg.runTerminalTrigger({ now: () => deferral.retryAt + 1, sendOnce: w });
  after = world.store.local.terminalTrigger;
  assert.deepEqual(w.sends, [], 'still refused while the draft is there');
  assert.equal(after.enabled, true, 'two drafts are not a broken page');
  deferral = deferredOf(world, run.runId);
  assert.equal(deferral.attempts, 2);

  await bg.runTerminalTrigger({ now: () => deferral.retryAt + 1, sendOnce: w });
  assert.deepEqual(w.sends, [run.runId], 'the box empties and the notice goes out once');
  assert.equal(seenOf(world, run.runId).state, 'sent');
});

test('T146 e2e: a frozen document keeps waiting instead of burning the notice', async () => {
  const world = world0();
  const bg = await boot(world);
  const state = await armStanding(world, bg);
  let now = state.armedAt + 1000;
  const run = candidate('b8b8b8b8-8888-4888-8888-b8b8b8b8b8b8', now / 1000 + 1);
  world.host.push(run);
  const w = writer([
    refused('target_background_unobservable'), refused('target_background_unobservable'),
    refused('target_background_unobservable'), refused('target_background_unobservable'), SENT,
  ]);

  // Four ticks with the tab frozen/discarded. Before T146 the fourth one escalated to a
  // block: the arm was disabled and the run journaled as delivered, so the notice was gone.
  for (let round = 0; round < 4; round += 1) {
    await bg.runTerminalTrigger({ now: () => now, sendOnce: w });
    const after = world.store.local.terminalTrigger;
    assert.equal(after.enabled, true, 'round ' + round + ' must not stop the arm');
    assert.equal(seenOf(world, run.runId), undefined,
      'round ' + round + ' must not journal the run as delivered');
    const deferral = deferredOf(world, run.runId);
    assert.ok(deferral, 'round ' + round + ' must stay deferred: '
      + JSON.stringify(after.lastError || null));
    assert.equal(deferral.attempts, round + 1);
    now = deferral.retryAt + 1;
  }
  assert.deepEqual(w.sends, [], 'nothing was written while the document was frozen');

  // The tab is back: the same run goes out, exactly once, and is then closed.
  const back = await bg.runTerminalTrigger({ now: () => now, sendOnce: w });
  assert.deepEqual(w.sends, [run.runId], 'the notice survives the freeze: '
    + JSON.stringify(back.results));
  assert.deepEqual(world.host.acked, [run.runId]);
  const done = world.store.local.terminalTrigger;
  assert.equal(done.enabled, true, 'a recovered page does not disable the arm');
  assert.equal(seenOf(world, run.runId).state, 'sent');
  assert.equal(deferredOf(world, run.runId), undefined);

  // A later tick cannot send it twice.
  world.host.force({ ...run });
  await bg.runTerminalTrigger({ now: () => now + 120000, sendOnce: w });
  assert.deepEqual(w.sends, [run.runId], 'no duplicate after recovery');
});

test('T146 e2e: a page with no send control still escalates to a stop (the arm must not loop)', async () => {
  const world = world0();
  const bg = await boot(world);
  const state = await armStanding(world, bg);
  let now = state.armedAt + 1000;
  const run = candidate('c1c1c1c1-1111-4111-8111-c1c1c1c1c1c1', now / 1000 + 1);
  world.host.push(run);
  const w = writer([
    refused('send_control_missing'), refused('send_control_missing'),
    refused('send_control_missing'), refused('send_control_missing'),
  ]);
  for (let round = 0; round < 4; round += 1) {
    await bg.runTerminalTrigger({ now: () => now, sendOnce: w });
    const deferral = deferredOf(world, run.runId);
    if (deferral) now = deferral.retryAt + 1;
  }
  const stopped = world.store.local.terminalTrigger;
  assert.deepEqual(w.sends, [], 'never written');
  assert.equal(stopped.enabled, false, 'a page without a send control stops the arm');
  assert.match(stopped.lastError, /^blocked:send_control_missing_after_3_deferrals/,
    'and names the cause: ' + stopped.lastError);
  assert.equal(seenOf(world, run.runId).state, 'blocked',
    'the run is closed out, so a later arm cannot send an unverifiable page');
});

test('T146 e2e: a different binding, an expired grant, a duplicate status and an uncertain write are refused', async () => {
  // (a) the binding moved to another conversation between the arm and the write
  {
    const world = world0();
    const bg = await boot(world);
    const state = await armStanding(world, bg);
    const run = candidate('c9c9c9c9-9999-4999-8999-c9c9c9c9c9c9', state.armedAt / 1000 + 1);
    world.host.push(run);
    const w = writer([refused('binding_changed')]);
    await bg.runTerminalTrigger({ now: () => state.armedAt + 5000, sendOnce: w });
    assert.equal(w.calls.length, 1, 'the writer is what refuses, not the trigger');
    assert.deepEqual(w.sends, [], 'and nothing was written');
    assert.equal(world.store.local.terminalTrigger.enabled, false, 'a changed binding stops the arm');
    assert.equal(world.store.local.terminalTrigger.lastError, 'blocked:binding_changed');
  }
  // (b) the grant expired
  {
    const world = world0();
    const bg = await boot(world);
    const state = await armStanding(world, bg);
    const run = candidate('d0d0d0d0-0000-4000-8000-d0d0d0d0d0d0', state.armedAt / 1000 + 1);
    world.host.push(run);
    const w = writer([refused('authorization_expired')]);
    await bg.runTerminalTrigger({ now: () => state.armedAt + 5000, sendOnce: w });
    assert.deepEqual(w.sends, [], 'an expired grant never reaches the page');
    assert.equal(world.store.local.terminalTrigger.lastError, 'blocked:authorization_expired');
  }
  // (c) an uncertain write stops the arm and is never retried
  {
    const world = world0();
    const bg = await boot(world);
    const state = await armStanding(world, bg);
    const run = candidate('e1e1e1e1-1111-4111-8111-e1e1e1e1e1e1', state.armedAt / 1000 + 1);
    world.host.push(run);
    const w = writer([uncertain('no_confirmed_page_write')]);
    await bg.runTerminalTrigger({ now: () => state.armedAt + 5000, sendOnce: w });
    assert.deepEqual(w.calls, [run.runId], 'exactly one attempt');
    const after = world.store.local.terminalTrigger;
    assert.equal(after.enabled, false, 'an unprovable write stops the arm');
    const entry = seenOf(world, run.runId);
    assert.equal(entry.state, 'stopped',
      'the run is journaled so a later arm cannot send it twice');
    assert.equal(entry.reason, 'no_confirmed_page_write');
    // a second arm does not resend it
    const rearmed = await armStanding(world, bg);
    const again = await bg.runTerminalTrigger({ now: () => rearmed.armedAt + 5000, sendOnce: w });
    assert.deepEqual(w.calls, [run.runId], 'no retry after an uncertain write: '
      + JSON.stringify(again.results));
  }
  // (d) the same run offered twice as a terminal status
  {
    const world = world0();
    const bg = await boot(world);
    const state = await armStanding(world, bg);
    const run = candidate('f2f2f2f2-2222-4222-8222-f2f2f2f2f2f2', state.armedAt / 1000 + 1);
    world.host.push(run);
    const w = writer([SENT]);
    await bg.runTerminalTrigger({ now: () => state.armedAt + 5000, sendOnce: w });
    world.host.force({ ...run });
    const dup = await bg.runTerminalTrigger({
      now: () => state.armedAt + 40000, sendOnce: w });
    assert.deepEqual(w.calls, [run.runId], 'one run, one notice: ' + JSON.stringify(dup.results));
    assert.ok(dup.results.some((row) => row.code === 'duplicate_event'
      || row.code === 'duplicate_run'), JSON.stringify(dup.results.map((r) => r.code)));
  }
});

test('T146 e2e: a backlog of pre-arm completions neither fires nor blocks later rounds', async () => {
  const world = world0();
  // 40 historical completions, already terminal when the arm is taken.
  const backlog = [];
  for (let i = 0; i < 40; i += 1) {
    const id = '0'.repeat(8) + '-0000-4000-8000-' + String(i).padStart(12, '0');
    backlog.push(candidate(id, 1793400000 + i, { postArm: false }));
  }
  world.host.push(...backlog);
  const bg = await boot(world);
  const state = await armStanding(world, bg);
  assert.equal(world.host.snapshotIds.length, 40, 'the arm snapshot must hold the backlog');

  const base = state.armedAt + 1000;
  const fresh = [candidate('a3a3a3a3-3333-4333-8333-a3a3a3a3a3a3', base / 1000 + 1),
    candidate('b4b4b4b4-4444-4444-8444-b4b4b4b4b4b4', base / 1000 + 100),
    candidate('c5c5c5c5-5555-4555-8555-c5c5c5c5c5c5', base / 1000 + 200)];
  world.host.push(...fresh);
  const w = writer([SENT, SENT, SENT]);
  let now = base;
  for (const run of fresh) {
    await bg.runTerminalTrigger({ now: () => now, sendOnce: w });
    now += MIN_INTERVAL + 1000;
  }
  assert.deepEqual(w.sends, fresh.map((run) => run.runId),
    'three rounds, three notices, backlog untouched');
  const after = world.store.local.terminalTrigger;
  assert.equal(after.enabled, true, 'a backlog never disables the arm');
  assert.equal(after.triggers, 3);
  // 43 persisted, 3 delivered: the snapshot's 40 are acknowledged as *stored*, never sent.
  assert.equal(world.host.acked.length, 43);
  assert.deepEqual(w.sends.length, 3);
});
