// T076: a pre-write refusal must not be mistaken for an uncertain write.
//
// The bug this reproduces: `runTerminalTrigger` writes `seen[key]='attempting'`
// and then calls the send path. When the send path refuses *before touching the
// page* -- the tab lost focus, the composer holds a draft, the probe is stale --
// `settle()` treated that `sent:false` like any other and recorded `stopped` plus
// `enabled=false`. A tab that merely lost focus therefore disabled the trigger for
// good, and the record claimed an attempt that never happened.
//
// The fix has to keep the two apart without weakening anything:
//
//   * provably no page write (a `decide` refusal)  -> defer, re-check later, no
//     quota consumed, trigger stays armed;
//   * a write may have happened (unconfirmed, timeout, restart, missing proof)
//     -> stop and disable, exactly as before, never retried.
//
// Order matters and is asserted: nothing is marked *retryable* unless the absence
// of a write is proven. An unknown or missing proof is treated as a write.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
// T086: the arm boundary is proved from a run's creation time, so a fixture run must
// be created when it is written (i.e. after the arm), exactly like a real completion.
// arm is provably created after it; a fixed timestamp would prove nothing.
// (T086) `Date.now()` is used at the call site below, so a run written after the

const ORIGIN = 'chrome-extension://t076-e2e/';
const CONV = '5b2c3d4e-6f70-4812-9a3b-4c5d6e7f8091';
const BINDING = {
  version: 1, tabId: 21, windowId: 6, url: 'https://chatgpt.com/c/' + CONV,
  conversationId: CONV, documentInstanceId: 'doc-76', manuallyConfirmed: true,
  revision: 8,
};
const RUN = '11111111-2222-4333-8444-555555555555';
const T0 = 1700000000000;

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// A probe that satisfies every target gate, so a test can move one field at a time.
function probe(now, over) {
  return Object.assign({
    observedAt: now - 10, tabId: BINDING.tabId, windowId: BINDING.windowId,
    url: BINDING.url, conversationId: CONV, documentInstanceId: 'doc-76',
    active: true, hasFocus: true, visibilityState: 'visible',
    composerPresent: true, composerEmpty: true,
  }, over || {});
}

// ------------------------------------------------------- the real controller
async function controllerCase(over, writeImpl) {
  const S = await mod('./extension/lib/autosend.js');
  const C = await mod('./extension/lib/autosend_controller.js');
  const armed = S.arm(S.createAutoSendState(), { binding: BINDING },
    'AUTOSEND ' + CONV, true, T0);
  let state = armed.state;
  const writes = [];
  const controller = C.createAutoSendController({
    now: () => T0 + 100,
    load: async () => clone(state),
    save: async (next) => { state = clone(next); },
    readBinding: async () => clone(BINDING),
    probe: async () => probe(T0 + 100, over),
    write: async (candidate) => {
      writes.push(candidate.runId);
      return writeImpl ? writeImpl(candidate) : { status: 'submitted', evidence: {} };
    },
  });
  const result = await controller.sendOnce({ runId: RUN, status: 'completed' , origin: 'bridge'});
  return { S, result, writes, state: () => state };
}

// ------------------------------------------------------------- host, offline
function startHost(stateDir, ledgerRoot) {
  if (!ledgerRoot) {
    throw new Error('startHost requires a temporary ledgerRoot; refusing to let the '
      + 'host read the production AgentState');
  }
  const cwd = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1');
  mkdirSync(stateDir, { recursive: true });
  const manifestPath = join(stateDir, 'host_manifest.e2e.json');
  writeFileSync(manifestPath, JSON.stringify({
    name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN],
  }, null, 2), 'utf8');
  // T067: this suite exercises channel A (Bridge-dispatched, auto-notified),
  // so it declares every run in its ledger as bridge-dispatched. The dedicated
  // T067 suite covers channel B and the unprovable case with an explicit list.
  const originFixturePath = join(stateDir, 'bridge-origin.fixture.json');
  writeFileSync(originFixturePath, JSON.stringify({ version: 1, bridge: '*' }),
    'utf8');
  // T067R: this suite is about channel A. The host also reads DSH's own session
  // logs to discover channel B, so point that at an empty directory -- otherwise
  // the operator's live sessions would leak into a hermetic fixture.
  const nativeRoot = join(stateDir, 'native-sessions');
  mkdirSync(nativeRoot, { recursive: true });
  const child = spawn(process.env.PYTHON || 'python',
    ['-B', 'host.py', ORIGIN, '--state-dir', stateDir,
      '--ledger-root', ledgerRoot, '--manifest', manifestPath,
      '--bridge-db-fixture', originFixturePath,
      '--native-root', nativeRoot],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  const listeners = [];
  const disc = new Set();
  let dead = false;
  child.stderr.on('data', () => {});
  child.on('exit', () => {
    dead = true;
    for (const fn of disc) { try { fn(); } catch (_err) { /* caller's */ } }
    disc.clear();
  });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) return;
      const body = buffer.slice(4, 4 + len).toString('utf8');
      buffer = buffer.slice(4 + len);
      try { const doc = JSON.parse(body); for (const fn of listeners) fn(doc); }
      catch (_err) { /* partial frame */ }
    }
  });
  const frame = (doc) => {
    const body = Buffer.from(JSON.stringify(doc), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
  };
  return {
    port() {
      let onDisc = null;
      const fire = () => { if (onDisc) { try { onDisc(); } catch (_err) { /* test */ } } };
      if (dead) setTimeout(fire, 0);
      return {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        onDisconnect: { addListener(fn) { onDisc = fn; disc.add(fire); } },
        postMessage(doc) {
          if (dead) { setTimeout(fire, 0); return; }
          try { child.stdin.write(frame(doc)); } catch (_err) { setTimeout(fire, 0); }
        },
      };
    },
    stop() { try { child.kill(); } catch (_err) { /* gone */ } },
  };
}

// T086: reuse the exact creation time the host will report, so a locally re-injected
// candidate is still provably post-arm.
function startedAtOf(ledgerRoot, runId) {
  const path = join(ledgerRoot, 'a'.repeat(64), 'endpoint.json.runs.json');
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  const row = rows.find((item) => item.requestID === runId);
  return row ? Math.floor(row.createdAt / 1000) : undefined;
}

function writeRuns(ledgerRoot, list) {
  const dir = join(ledgerRoot, 'a'.repeat(64));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'endpoint.json.runs.json'), JSON.stringify(
    list.map((run, index) => ({ requestID: run.id, status: run.status,
      createdAt: Date.now() + 2000 + index * 1000 })), null, 2), 'utf8');
}

const event = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; } });
function createChrome(hostRef) {
  const stores = { local: new Map(), session: new Map() };
  const alarms = new Map();
  const messageListeners = [];
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      if (defaults && typeof defaults === 'object') {
        for (const [k, v] of Object.entries(defaults)) {
          out[k] = map.has(k) ? clone(map.get(k)) : v;
        }
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) map.set(k, clone(v));
    },
    async remove(key) { map.delete(key); },
  });
  const api = {
    runtime: {
      id: 'test-extension', getURL: (p) => 'chrome-extension://test-extension/' + p,
      connectNative: () => hostRef.current.port(),
      onMessage: { addListener(fn) { messageListeners.push(fn); },
        removeListener() {}, hasListener() { return false; } },
      onInstalled: event(), onStartup: event(), lastError: undefined,
    },
    storage: { local: area(stores.local), session: area(stores.session) },
    alarms: {
      async get(name) { return alarms.has(name) ? clone(alarms.get(name)) : undefined; },
      async create(name, info) { alarms.set(name, clone(info)); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: event(),
    },
    // Deliberately minimal: no `tabs.update`, no `windows.update`. A suite that
    // needed them would mean the fix had started activating tabs.
    tabs: {
      async get() { return undefined; },
      async query() { return []; },
      async sendMessage() { throw new Error('no tab in this suite'); },
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      onAttached: event(), onDetached: event(), onReplaced: event(),
    },
    windows: { onFocusChanged: event() },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    permissions: { async contains() { return false; } },
  };
  return {
    api, stores, alarms,
    read: (key) => clone(stores.local.get(key)),
    write: (key, value) => stores.local.set(key, clone(value)),
    async dispatch(msg) {
      const listener = messageListeners[0];
      if (!listener) throw new Error('background registered no onMessage listener');
      let out = null;
      let ret;
      try {
        ret = listener(clone(msg),
          { id: 'test-extension',
            url: 'chrome-extension://test-extension/popup.html' },
          (r) => { out = r; });
      } catch (err) { throw err; }
      if (ret !== true) return out;
      const started = Date.now();
      while (out === null && Date.now() - started < 8000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return out;
    },
  };
}

async function open() {
  const dir = mkdtempSync(join(tmpdir(), 't076-'));
  const ledgerRoot = join(dir, 'agents');
  writeRuns(ledgerRoot, []);
  const h = startHost(join(dir, 'host'), ledgerRoot);
  const hostRef = { current: h };
  const chromeMock = createChrome(hostRef);
  globalThis.chrome = chromeMock.api;
  chromeMock.stores.session.set('t053TargetBindingState', {
    version: 1, revision: BINDING.revision, binding: BINDING, candidates: [],
    candidateScannedAt: null,
  });
  const bg = await mod('./extension/background.js?t076=' + Date.now()
    + Math.random().toString(16).slice(2));
  const sent = [];
  const env = {
    dir, ledgerRoot, chromeMock, bg, sent,
    dispatch: (msg) => chromeMock.dispatch(msg),
    arm: () => chromeMock.dispatch({ type: 't059-trigger-arm',
      confirmation: 'AUTOTRIGGER ' + CONV, userGesture: true }),
    tick: (options) => bg.runTerminalTrigger(Object.assign({ limit: 3 }, options)),
    trigger: () => chromeMock.read('terminalTrigger') || null,
    candidates: () => chromeMock.read('terminalCandidates') || [],
    cleanup() {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    },
  };
  return env;
}

async function main() {
  const S = await mod('./extension/lib/autosend.js');
  const T = await mod('./extension/lib/terminal_trigger.js');

  // ------------------------ 1. a focus refusal never reaches the page
  console.log('== T076: a pre-write refusal proves no page write happened ==');
  {
    const focused = await controllerCase({});
    check(focused.result.sent === true, 'a focused page still sends');
    check(focused.result.pageWriteAttempted === true,
      'and reports that a page write was attempted');

    const blurred = await controllerCase({ hasFocus: false });
    check(blurred.result.sent === false, 'a blurred page does not send');
    check(blurred.result.code === 'target_not_visible_and_focused',
      'and names the focus gate (' + blurred.result.code + ')');
    check(blurred.writes.length === 0, 'the writer was never called');
    // This is the field the whole fix rests on. Without it the caller cannot tell
    // "refused before typing" from "typed, outcome unknown".
    check(blurred.result.pageWriteAttempted === false,
      'and it says no page write was attempted (' +
      blurred.result.pageWriteAttempted + ')');
    check(blurred.state().journal[RUN + '|completed'] === undefined,
      'nothing was journalled as an attempt either');

    for (const [field, value, code] of [
      ['visibilityState', 'hidden', 'target_not_visible_and_focused'],
      ['active', false, 'target_not_visible_and_focused'],
      ['composerEmpty', false, 'session_occupied'],
      ['composerPresent', false, 'composer_unavailable'],
    ]) {
      const blocked = await controllerCase({ [field]: value });
      check(blocked.result.code === code
        && blocked.result.pageWriteAttempted === false
        && blocked.writes.length === 0,
        field + '=' + String(value) + ' is a pre-write refusal (' +
        blocked.result.code + ')');
    }

    const stale = await controllerCase({ observedAt: T0 + 100 - 60000 });
    check(stale.result.code === 'probe_stale'
      && stale.result.pageWriteAttempted === false && stale.writes.length === 0,
      'a stale probe is a pre-write refusal too');

    // The opposite direction: an attempted write must keep claiming one.
    const unconfirmed = await controllerCase({}, async () => ({
      status: 'unconfirmed', reason: 'delivery_not_confirmed', evidence: {} }));
    check(unconfirmed.writes.length === 1, 'the writer ran once');
    check(unconfirmed.result.sent === false
      && unconfirmed.result.pageWriteAttempted === true,
      'an unconfirmed outcome still claims a page write (' +
      unconfirmed.result.pageWriteAttempted + ')');
  }

  // ------------- 2. the trigger must defer, not disable, on a pre-write refusal
  //
  // This is the reported bug, reproduced at the level where it happens: the tick
  // marks `attempting` and then settles. A focus refusal used to become
  // `stopped` + `enabled=false`, which is what the operator saw in the popup.
  console.log('== T076: a focus refusal defers instead of disabling ==');
  {
    const env = await open();
    try {
      const armed = await env.arm();
      check(armed && armed.result && armed.result.ok === true, 'the trigger arms');
      await env.tick({ limit: 1, sendOnce: async () => ({ sent: true,
        pageWriteAttempted: true, status: 'submitted', evidence: {} }) });

      writeRuns(env.ledgerRoot, [{ id: RUN, status: 'completed' }]);
      const blurred = await env.tick({ limit: 2, sendOnce: async () => ({
        sent: false, pageWriteAttempted: false,
        code: 'target_not_visible_and_focused' }) });

      check(blurred.state.enabled === true,
        'the trigger stays armed (' + blurred.state.lastError + ')');
      check(!String(blurred.state.lastError || '').startsWith('stopped:'),
        'and nothing was recorded as a stop (' + blurred.state.lastError + ')');
      check(blurred.state.seen[RUN + '|completed'] === undefined,
        'the run is not marked as attempted');
      check(blurred.state.windowCount === 0,
        'and no hourly quota was consumed (' + blurred.state.windowCount + ')');
      const deferred = blurred.state.deferred && blurred.state.deferred[RUN + '|completed'];
      check(deferred && deferred.reason === 'target_not_visible_and_focused',
        'the deferral is recorded with its reason (' + JSON.stringify(deferred) + ')');
      check(Number.isFinite(deferred && deferred.retryAt),
        'and with a scheduled re-check (' + (deferred && deferred.retryAt) + ')');
      check(blurred.results.some((r) => String(r.code).startsWith('deferred:')),
        'the tick reports it as deferred (' +
        JSON.stringify(blurred.results.map((r) => r.code)) + ')');
      check(env.candidates().some((item) => item.runId === RUN),
        'the candidate is kept for the re-check, not drained');

      // Backoff: an immediate re-tick must not hammer the page probe, and must not
      // be counted as a fresh attempt either.
      const again = await env.tick({ limit: 2, sendOnce: async () => ({
        sent: false, pageWriteAttempted: false,
        code: 'target_not_visible_and_focused' }) });
      check(again.results.some((r) => r.code === 'deferred_backoff'),
        'a re-tick before the re-check time is a backoff, not a new attempt (' +
        JSON.stringify(again.results.map((r) => r.code)) + ')');
      check(again.state.enabled === true, 'and still does not disable');
    } finally { env.cleanup(); }
  }

  // ------------------------ 3. focus returns: exactly one send, then a real record
  console.log('== T076: after focus returns, one send, and the quota moves once ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: async () => ({ sent: true,
        pageWriteAttempted: true, status: 'submitted', evidence: {} }) });
      writeRuns(env.ledgerRoot, [{ id: RUN, status: 'completed' }]);
      await env.tick({ limit: 2, sendOnce: async () => ({ sent: false,
        pageWriteAttempted: false, code: 'target_not_visible_and_focused' }) });
      const retryAt = env.trigger().deferred[RUN + '|completed'].retryAt;

      const sentIds = [];
      const restored = await env.tick({ limit: 2, now: () => retryAt + 1,
        sendOnce: async (candidate) => {
          sentIds.push(candidate.runId);
          return { sent: true, pageWriteAttempted: true, status: 'submitted',
            evidence: { receipt: 'stub' } };
        } });
      check(sentIds.length === 1 && sentIds[0] === RUN,
        'the deferred run is sent once the gate passes (' + JSON.stringify(sentIds) + ')');
      check(restored.state.seen[RUN + '|completed'].state === 'sent',
        'and the journal finally records it as sent');
      check(restored.state.windowCount === 1,
        'consuming exactly one unit of quota (' + restored.state.windowCount + ')');
      check(!restored.state.deferred[RUN + '|completed'],
        'and the deferral is cleared');
      check(restored.state.enabled === true, 'the trigger stays armed');

      const twice = await env.tick({ limit: 2, now: () => retryAt + 2,
        sendOnce: async (candidate) => { sentIds.push(candidate.runId);
          return { sent: true, pageWriteAttempted: true, status: 'submitted' }; } });
      check(sentIds.length === 1,
        'a second tick never sends it again (' + sentIds.length + ')');
      check(!env.candidates().some((item) => item.runId === RUN),
        'the delivered candidate is drained from the queue');

      // A failed ACK would make the host offer it again. The journal, not the
      // queue, is what must stop the second write.
      env.chromeMock.write('terminalCandidates',
        env.candidates().concat([{ runId: RUN, status: 'completed', origin: 'bridge',
          startedAt: startedAtOf(env.ledgerRoot, RUN) }]));
      const reoffered = await env.tick({ limit: 2, now: () => retryAt + 3,
        sendOnce: async (candidate) => { sentIds.push(candidate.runId);
          return { sent: true, pageWriteAttempted: true, status: 'submitted' }; } });
      check(sentIds.length === 1,
        'a re-offered completion is not written twice (' + sentIds.length + ')');
      check(reoffered.results.some((r) => r.code === 'duplicate_event'
        || r.code === 'duplicate_run'),
        'the duplicate is refused by name (' +
        JSON.stringify(reoffered.results.map((r) => r.code)) + ')');
    } finally { env.cleanup(); }
  }

  // ------------------- 4. a write that may have happened is still fail-closed
  //
  // The whole fix depends on not weakening this half. Each case below either
  // claimed a page write, or refused to say whether one happened.
  console.log('== T076: anything that might have written still stops for good ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: async () => ({ sent: true,
        pageWriteAttempted: true, status: 'submitted' }) });
      const outcomes = [
        ['unconfirmed receipt', { sent: false, pageWriteAttempted: true,
          code: 'unconfirmed', reason: 'delivery_not_confirmed' }],
        ['missing proof flag', { sent: false, code: 'target_not_visible_and_focused' }],
        ['unknown refusal code', { sent: false, pageWriteAttempted: false,
          code: 'something_new' }],
        ['thrown writer', null],
      ];
      let i = 0;
      for (const [label, outcome] of outcomes) {
        i += 1;
        const runId = '2222222' + i + '-3333-4444-8555-66666666666' + i;
        // T091: the re-arm comes first. A run that is already terminal when the
        // trigger is armed is history by definition, so writing it first would
        // test the wrong thing -- and did, once the snapshot became the boundary.
        if (i > 1) await env.arm();          // a human re-arms each time
        writeRuns(env.ledgerRoot, [{ id: runId, status: 'completed' }]);
        const tick = await env.tick({ limit: 1, sendOnce: async (candidate) => {
          if (outcome === null) throw new Error('adapter exploded');
          return outcome;
        } });
        check(tick.state.enabled === false,
          label + ' disables the trigger (' + tick.state.lastError + ')');
        check(String(tick.state.lastError || '').startsWith('stopped:')
          || String(tick.state.lastError || '').startsWith('send_threw'),
          label + ' is recorded as a stop, not a deferral (' + tick.state.lastError + ')');
        check(!tick.state.deferred || !tick.state.deferred[runId + '|completed'],
          label + ' leaves no deferral behind');
      }
    } finally { env.cleanup(); }
  }

  // ---------------------------------- 5. an already-reported run is never replayed
  //
  // The live state that motivated this task: T075 ended as
  // `stopped:target_not_visible_and_focused`. That record must keep blocking.
  console.log('== T076: the stopped T075-style record is never replayed ==');
  {
    const OLD = 'abcdef01-2345-4678-89ab-cdef01234567';
    let state = T.configure(T.createTriggerState(), { binding: BINDING },
      T.CONFIRM_PREFIX + CONV, true, T0).state;
    const marked = T.markAttempt(state, { runId: OLD, status: 'completed' , origin: 'bridge'}, T0 + 1);
    const stopped = T.settle(marked.state, marked.key,
      { sent: false, code: 'target_not_visible_and_focused' }, T0 + 2);
    check(stopped.state.enabled === false, 'the historic record stopped the trigger');
    // An operator re-arming must not resurrect it, whatever the reason was.
    const rearmed = T.configure(stopped.state, { binding: BINDING },
      T.CONFIRM_PREFIX + CONV, true, T0 + 3).state;
    const admitted = T.admit(rearmed, { runId: OLD, status: 'completed' , origin: 'bridge'}, T0 + 4);
    check(admitted.admit === false, 're-arming does not admit the old run');
    check(admitted.code === 'duplicate_event' && admitted.previous === 'stopped',
      'it stays a duplicate, with its history (' + admitted.code +
      '/' + admitted.previous + ')');
    const settleAgain = T.settle(rearmed, marked.key, { sent: true }, T0 + 5);
    check(settleAgain.state.enabled === true && settleAgain.state.windowCount === 0,
      'and settling it again is impossible, so it cannot consume quota');
  }

  // --------------------------------------- 6. a long blur: bounded, no busy loop
  console.log('== T076: a long blur backs off instead of spinning ==');
  {
    let state = T.configure(T.createTriggerState(), { binding: BINDING },
      T.CONFIRM_PREFIX + CONV, true, T0).state;
    const cand = { runId: RUN, status: 'completed' , origin: 'bridge'};
    const waits = [];
    const attempts = [];
    const refusals = [];
    // Ticks arrive every 30 seconds, exactly like the alarm. Only an `admit` that
    // says yes may probe the page, so a long blur must *not* mean a probe per tick.
    let now = T0;
    for (let i = 0; i < 60; i += 1) {
      now += 30000;
      const admitted = T.admit(state, cand, now);
      if (!admitted.admit) {
        refusals.push(admitted.code);
        continue;
      }
      attempts.push(i);
      const marked = T.markAttempt(state, cand, now);
      state = T.settle(marked.state, marked.key, { sent: false,
        pageWriteAttempted: false, code: 'target_not_visible_and_focused' }, now).state;
      const d = state.deferred[RUN + '|completed'];
      waits.push(d.retryAt - now);
    }
    check(attempts.length >= 2, 'the gate really is re-checked over time (' +
      attempts.length + ' probes in 60 ticks)');
    // 60 ticks is half an hour of alarms. With a five-minute cap the gate can be
    // probed at most ~10 times in that window; the point is that it is a small
    // fraction of the ticks, never one probe per tick.
    check(attempts.length * 5 <= 60, 'but not on every tick (' + attempts.length +
      ' probes in 60 ticks)');    check(waits.every((w) => w >= T.DEFER_BASE_MS && w <= T.DEFER_MAX_MS),
      'every wait is inside the bounds (' + JSON.stringify(waits) + ')');
    check(waits[waits.length - 1] === T.DEFER_MAX_MS,
      'and the backoff reaches its cap, not infinity (' + waits[waits.length - 1] + ')');
    check(state.enabled === true && state.windowCount === 0,
      'the trigger is still armed and has consumed nothing');
    check(Object.keys(state.seen).length === 0,
      'and nothing was recorded as an attempt (' + Object.keys(state.seen).length + ')');
    check(refusals.length > 0 && refusals.every((c) => c === 'deferred_backoff'),
      'every skipped tick was a backoff, never a fresh probe (' +
      JSON.stringify([...new Set(refusals)]) + ')');
  }

  // ---------------------- 7. a permanent configuration problem blocks, not defers
  console.log('== T076: configuration refusals block and say so ==');
  {
    let state = T.configure(T.createTriggerState(), { binding: BINDING },
      T.CONFIRM_PREFIX + CONV, true, T0).state;
    const cand = { runId: RUN, status: 'completed' , origin: 'bridge'};
    for (const code of ['authorization_expired', 'binding_invalidated',
      'conversation_changed']) {
      const marked = T.markAttempt(state, cand, T0 + 1);
      const done = T.settle(marked.state, marked.key,
        { sent: false, pageWriteAttempted: false, code }, T0 + 2);
      check(done.result.status !== 'deferred',
        code + ' is not a deferral (' + done.result.status + ')');
      check(done.result.code === 'blocked', code + ' is a block (' +
        done.result.code + ')');
      check(done.state.enabled === false,
        'and disables, because waiting cannot fix it (' + done.state.lastError + ')');
      check(done.state.seen[RUN + '|completed'].state === 'blocked',
        'the run is terminally blocked, so it can never be offered again');
      check(!done.state.deferred || !done.state.deferred[RUN + '|completed'],
        'and no deferral was recorded');
      state = done.state;
    }
  }

  // -------------------------------- 8. a restart keeps the deferral, not a resend
  console.log('== T076: a restart during a deferral neither resends nor forgets ==');
  {
    let state = T.configure(T.createTriggerState(), { binding: BINDING },
      T.CONFIRM_PREFIX + CONV, true, T0).state;
    const marked = T.markAttempt(state, { runId: RUN, status: 'completed' , origin: 'bridge'}, T0 + 1);
    state = T.settle(marked.state, marked.key,
      { sent: false, pageWriteAttempted: false,
        code: 'target_not_visible_and_focused' }, T0 + 2).state;
    const retryAt = state.deferred[RUN + '|completed'].retryAt;
    const after = T.reconcileAfterRestart(state, T0 + 3).state;
    check(after.enabled === true, 'a deferral is not an attempt, so nothing is stopped');
    check(after.deferred[RUN + '|completed'].retryAt === retryAt,
      'the re-check time survives the restart');
    check(Object.keys(after.seen).length === 0, 'and no attempt record appeared');
    check(T.admit(after, { runId: RUN, status: 'completed' , origin: 'bridge'}, T0 + 4).code
      === 'deferred_backoff', 'the backoff still applies after the restart');
    check(T.admit(after, { runId: RUN, status: 'completed' , origin: 'bridge'}, retryAt).admit === true,
      'and it is admitted once the time comes');

    // The other half: a real attempt found dangling stays a stop.
    const real = T.markAttempt(state, { runId: RUN, status: 'completed' , origin: 'bridge'}, T0 + 9);
    const dangling = T.reconcileAfterRestart(real.state, T0 + 10);
    check(dangling.state.seen[RUN + '|completed'].state === 'stopped'
      && dangling.state.enabled === false,
      'a dangling real attempt is still stopped on restart');
  }

  // -------------------------------------- 9. the deferral never touches a window
  console.log('== T076: nothing here can activate or switch a tab ==');
  {
    const source = await (await import('node:fs/promises'))
      .readFile(new URL('./extension/lib/terminal_trigger.js', ROOT), 'utf8');
    const controller = await (await import('node:fs/promises'))
      .readFile(new URL('./extension/lib/autosend_controller.js', ROOT), 'utf8');
    // Comments mention `chrome.*` while explaining the dependency-injection rule,
    // so strip them: only executable references would matter.
    const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const both = strip(source) + strip(controller);
    for (const forbidden of ['tabs.update', 'windows.update', 'tabs.highlight',
      'windows.create', 'tabs.move']) {
      check(!both.includes(forbidden), 'no ' + forbidden + ' in the deferred path');
    }
    check(!/chrome\s*\./m.test(both),
      'and neither module names a chrome API at all');
  }

  // ------------------- 10. the deferral is visible wherever the operator looks
  console.log('== T076: the deferral is reported, not hidden ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: async () => ({ sent: true,
        pageWriteAttempted: true, status: 'submitted' }) });
      writeRuns(env.ledgerRoot, [{ id: RUN, status: 'completed' }]);
      await env.tick({ limit: 2, sendOnce: async () => ({ sent: false,
        pageWriteAttempted: false, code: 'target_not_visible_and_focused' }) });

      const ready = await env.dispatch({ type: 't069-canary-readiness' });
      check(ready && ready.ok === true && ready.result, 'the readiness diagnostic answers');
      const item = (ready.result.items || []).find((i) => i.id === 'no_pending_deferral');
      check(item && item.state === 'unknown',
        'a waiting deferral is unknown, not ok and not bad (' +
        (item && item.state) + ')');
      check(item && item.code === 'deferred_waiting',
        'with its own code (' + (item && item.code) + ')');
      check(item && /target_not_visible_and_focused/.test(item.detail || ''),
        'and the reason in the detail (' + (item && item.detail) + ')');
      check((ready.result.unknownBy || []).includes('deferred_waiting'),
        'listed under unknownBy, not blockedBy (' +
        JSON.stringify(ready.result.unknownBy) + ')');
      check(ready.result.ok === false,
        'so the checklist does not claim it is ready to send right now');

      const evidence = await env.dispatch({ type: 't074-chain-evidence' });
      const stage = (evidence.result.stages || [])
        .find((s) => s.id === 'send_attempted');
      check(stage && stage.state === 'absent'
        && stage.code === 'deferred_target_not_visible_and_focused',
        'the staged report calls the attempt absent, with the reason (' +
        (stage && stage.code) + ')');
      check(stage && Number.isFinite(stage.retryAt),
        'and shows when the re-check is due (' + (stage && stage.retryAt) + ')');
      check(evidence.result.deliveryProven === false,
        'nothing claims delivery while it is only waiting');
    } finally { env.cleanup(); }
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});


