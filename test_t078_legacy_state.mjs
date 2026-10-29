// T078: the T074-era trigger record has no `deferred` field, and T076's settle()
// reads it unguarded.
//
// The live failure, verbatim:
//   lastError = alarm_tick_failed:Cannot read properties of undefined
//               (reading '<uuid>|completed')
//
// Two unguarded reads produce exactly that message:
//   settle() line "const previous = next.deferred[k]"        (deferred branch)
//   settle() line "delete next.deferred[k]"                  (success branch)
// because `clone()` of a stored state without `deferred` yields `undefined`, and
// any property access on it throws with the requested key in the message.
//
// The damage is not just a disabled trigger: `markAttempt()` was already persisted
// before the throw, so the run stays `attempting` and the next tick's
// `reconcileAfterRestart()` turns it into `stopped`. The send is therefore lost --
// which is the correct, fail-closed outcome -- but the trigger dies with an
// unreadable reason, and the operator cannot tell "no write happened" from
// "we do not know".
//
// So: reproduce first, on the old shape, without touching the code.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
// T086: the arm boundary is proved from a run's creation time, so a fixture run must
// be created when it is written (i.e. after the arm), exactly like a real completion.
// arm is provably created after it; a fixed timestamp would prove nothing.
// (T086) `Date.now()` is used at the call site below, so a run written after the

const ORIGIN = 'chrome-extension://t078-e2e/';
const CONV = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const BINDING = {
  version: 1, tabId: 31, windowId: 7, url: 'https://chatgpt.com/c/' + CONV,
  conversationId: CONV, documentInstanceId: 'doc-78', manuallyConfirmed: true,
  revision: 9,
};
// Shapes as they were actually persisted, one per release that wrote them.
const T077_RUN = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';   // stuck attempting
const SENT_RUN = '8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
const STOPPED_RUN = '9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f';
const NEW_RUN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const T0 = 1760000000000;

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// A state written by T074. `deferred` does not exist in this release, and neither
// does anything else T076 added. Every field here is one the old code really wrote.
function t074State(over) {
  return Object.assign({
    version: 1,
    enabled: true,
    armedAt: T0,
    minIntervalMs: 30000,
    maxPerHour: 100,
    lastSentAt: T0 + 60000,
    windowStartedAt: T0 + 60000,
    windowCount: 1,
    lastError: null,
    seen: {
      [SENT_RUN + '|completed']: {
        runId: SENT_RUN, status: 'completed', origin: 'bridge', state: 'sent',
        attemptedAt: T0 + 59000, settledAt: T0 + 60000, reason: null,
        provenance: 'unverified_candidate',
      },
      [STOPPED_RUN + '|completed']: {
        runId: STOPPED_RUN, status: 'completed', origin: 'bridge', state: 'stopped',
        attemptedAt: T0 + 100, settledAt: T0 + 200,
        reason: 'send_not_confirmed', provenance: 'unverified_candidate',
      },
      [T077_RUN + '|completed']: {
        runId: T077_RUN, status: 'completed', origin: 'bridge', state: 'attempting',
        attemptedAt: T0 + 70000, settledAt: null, reason: null,
        provenance: 'unverified_candidate',
      },
    },
    preArmCandidateKeys: [SENT_RUN + '|completed'],
  }, over || {});
}

// ------------------------------------------------------ the real controller
async function controllerCase(over, writeImpl) {
  const S = await mod('./extension/lib/autosend.js');
  const C = await mod('./extension/lib/autosend_controller.js');
  const armed = S.arm(S.createAutoSendState(), { binding: BINDING },
    'AUTOSEND ' + CONV, true, T0);
  let state = armed.state;
  const controller = C.createAutoSendController({
    now: () => T0 + 100,
    load: async () => clone(state),
    save: async (next) => { state = clone(next); },
    readBinding: async () => clone(BINDING),
    probe: async () => ({
      observedAt: T0 + 90, tabId: BINDING.tabId, windowId: BINDING.windowId,
      url: BINDING.url, conversationId: CONV, documentInstanceId: 'doc-78',
      active: false, hasFocus: false, visibilityState: 'visible',
      composerPresent: true, composerEmpty: true,
    }),
    write: async () => (writeImpl ? writeImpl() : { status: 'submitted' }),
  });
  return controller.sendOnce({ runId: NEW_RUN, status: 'completed' , origin: 'bridge'});
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
    api, stores,
    read: (key) => clone(stores.local.get(key)),
    write: (key, value) => stores.local.set(key, clone(value)),
    async dispatch(msg) {
      const listener = messageListeners[0];
      if (!listener) throw new Error('background registered no onMessage listener');
      let out = null;
      const ret = listener(clone(msg),
        { id: 'test-extension',
          url: 'chrome-extension://test-extension/popup.html' },
        (r) => { out = r; });
      if (ret !== true) return out;
      const started = Date.now();
      while (out === null && Date.now() - started < 8000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return out;
    },
  };
}

async function open(seed) {
  const dir = mkdtempSync(join(tmpdir(), 't078-'));
  const ledgerRoot = join(dir, 'agents');
  writeRuns(ledgerRoot, []);
  const h = startHost(join(dir, 'host'), ledgerRoot);
  const chromeMock = createChrome({ current: h });
  globalThis.chrome = chromeMock.api;
  chromeMock.stores.session.set('t053TargetBindingState', {
    version: 1, revision: BINDING.revision, binding: BINDING, candidates: [],
    candidateScannedAt: null,
  });
  if (seed) chromeMock.stores.local.set('terminalTrigger', clone(seed));
  const bg = await mod('./extension/background.js?t078=' + Date.now()
    + Math.random().toString(16).slice(2));
  return {
    dir, ledgerRoot, chromeMock, bg,
    dispatch: (msg) => chromeMock.dispatch(msg),
    tick: (options) => bg.runTerminalTrigger(Object.assign({ limit: 3 }, options)),
    alarm: () => bg.runTerminalOnAlarm(),
    trigger: () => chromeMock.read('terminalTrigger') || null,
    cleanup() {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    },
  };
}

async function main() {
  const T = await mod('./extension/lib/terminal_trigger.js');

  // --------------- 1. the crash itself, on the exact shape the field has today
  console.log('== T078: a T074-shaped record crashes settle() ==');
  {
    const k = NEW_RUN + '|completed';
    check(t074State().deferred === undefined,
      'the T074 record has no `deferred` field at all');

    const marked = T.markAttempt(t074State(), { runId: NEW_RUN, status: 'completed' , origin: 'bridge'},
      T0 + 1000);
    let deferredError = null;
    let deferredResult = null;
    try {
      deferredResult = T.settle(marked.state, marked.key, {
        sent: false, pageWriteAttempted: false,
        code: 'target_not_visible_and_focused' }, T0 + 1100);
    } catch (err) { deferredError = err; }
    check(deferredError === null,
      'settling a pre-write refusal does not throw (' +
      (deferredError && deferredError.message) + ')');
    check(!deferredError || !String(deferredError.message).includes(k),
      'and certainly not with the journal key in the message');

    let sentError = null;
    try {
      T.settle(marked.state, marked.key, { sent: true }, T0 + 1100);
    } catch (err) { sentError = err; }
    check(sentError === null,
      'settling a success does not throw (' +
      (sentError && sentError.message) + ')');

    let stopError = null;
    try {
      T.settle(marked.state, marked.key, { sent: false,
        pageWriteAttempted: true, code: 'unconfirmed' }, T0 + 1100);
    } catch (err) { stopError = err; }
    check(stopError === null, 'settling an uncertain outcome does not throw (' +
      (stopError && stopError.message) + ')');

    // The same three reads a legacy record would hit on other paths.
    let restartError = null;
    try { T.reconcileAfterRestart(t074State(), T0 + 1200); }
    catch (err) { restartError = err; }
    check(restartError === null, 'reconcileAfterRestart survives the old shape (' +
      (restartError && restartError.message) + ')');

    let admitError = null;
    try { T.admit(t074State(), { runId: NEW_RUN, status: 'completed' , origin: 'bridge'}, T0 + 1300); }
    catch (err) { admitError = err; }
    check(admitError === null, 'admit survives the old shape (' +
      (admitError && admitError.message) + ')');

    let disableError = null;
    try { T.disable(t074State(), 'manual', T0 + 1400); }
    catch (err) { disableError = err; }
    check(disableError === null, 'disable survives the old shape (' +
      (disableError && disableError.message) + ')');

    check(typeof T.normalizeTriggerState === 'function',
      'there is one place that knows the schema, not six');
  }

  // ---------- 2. the whole tick, exactly as the alarm runs it in the field
  console.log('== T078: the field tick dies and leaves the run attempting ==');
  {
    const env = await open(t074State());
    try {
      const r = await env.alarm();
      const after = env.trigger();
      check(after.lastError === null || !String(after.lastError)
        .startsWith('alarm_tick_failed:'),
        'the tick no longer dies on the alarm wrapper (' + after.lastError + ')');
      // T077 must stay fail-closed whatever happens: its persisted state says
      // `attempting`, so the only legal outcomes are "stopped" or "still attempting".
      const t077 = after.seen[T077_RUN + '|completed'];
      check(t077.state === 'stopped' || t077.state === 'attempting',
        'the T077 run is never turned into a retryable deferral (' + t077.state + ')');
      check(!String(after.lastError || '').startsWith('alarm_tick_failed:'),
        'and the failure reason is readable, not a TypeError (' +
        after.lastError + ')');
      check(r && r.skipped !== 'error', 'the wrapper reports a real result, not error (' +
        JSON.stringify(r && r.skipped) + ')');
      check(Array.isArray(r.results) && r.results.length === 0,
        'and the run left `attempting` by the crash never reached the writer (' +
        JSON.stringify(r && r.results) + ')');
      check(!after.deferred || !after.deferred[T077_RUN + '|completed'],
        'T077 has no deferral entry');
    } finally { env.cleanup(); }
  }

  // ------------------- 3. legacy record, then a focus refusal, then a re-check
  console.log('== T078: a legacy record defers, then sends exactly once ==');
  {
    const reconciled = t074State();
    reconciled.seen[T077_RUN + '|completed'].state = 'stopped';
    reconciled.seen[T077_RUN + '|completed'].settledAt = T0 + 80000;
    reconciled.seen[T077_RUN + '|completed'].reason =
      'worker_restarted_during_attempt';
    reconciled.lastError = 'stopped:worker_restarted_during_attempt';
    reconciled.enabled = false;
    const env = await open(reconciled);
    try {
      const armed = await env.chromeMock.dispatch({ type: 't059-trigger-arm',
        confirmation: 'AUTOTRIGGER ' + CONV, userGesture: true });
      check(armed && armed.result && armed.result.ok === true,
        'the operator can re-arm a record written by T074');
      const armState = env.trigger();
      check(armState.deferred !== undefined && armState.deferred !== null,
        'after arming the record carries the current schema');
      check(armState.seen[SENT_RUN + '|completed'].state === 'sent'
        && armState.seen[STOPPED_RUN + '|completed'].state === 'stopped'
        && armState.seen[T077_RUN + '|completed'].state === 'stopped',
        'and every historical entry survived the upgrade verbatim');
      check(Array.isArray(armState.preArmCandidateKeys)
        && armState.preArmCandidateKeys.length === 0,
        'arming re-snapshots the queue, as it always has (' +
        JSON.stringify(armState.preArmCandidateKeys) + ')');

      // Let the source take its baseline first, exactly like a real deployment
      // where the trigger is armed before the next task finishes.
      await env.tick({ limit: 1, sendOnce: async () => ({ sent: true,
        pageWriteAttempted: true, status: 'submitted' }) });
      writeRuns(env.ledgerRoot, [{ id: NEW_RUN, status: 'completed' }]);
      const refused = await env.tick({ limit: 2, sendOnce: async () => ({
        sent: false, pageWriteAttempted: false,
        code: 'target_not_visible_and_focused' }) });
      const s1 = env.trigger();
      check(refused.fetched && refused.fetched.ok === true,
        'the source was readable (' + JSON.stringify(refused.fetched) + ')');
      check(refused.results.some((x) => x.code
        === 'deferred:target_not_visible_and_focused'),
        'the refusal is deferred, not stopped (' +
        JSON.stringify(refused.results.map((x) => x.code)) + ')');
      check(s1.enabled === true, 'the trigger stays armed (' + s1.lastError + ')');
      check(s1.windowCount === 0, 'no quota was consumed (' + s1.windowCount + ')');
      check(s1.deferred[NEW_RUN + '|completed'].reason
        === 'target_not_visible_and_focused', 'the deferral names its reason');
      check(s1.seen[NEW_RUN + '|completed'] === undefined,
        'and the run is not marked as a page attempt');

      const retryAt = s1.deferred[NEW_RUN + '|completed'].retryAt;
      const sentIds = [];
      const restored = await env.tick({ limit: 2, now: () => retryAt + 1,
        sendOnce: async (c) => { sentIds.push(c.runId);
          return { sent: true, pageWriteAttempted: true, status: 'submitted' }; } });
      check(sentIds.length === 1 && sentIds[0] === NEW_RUN,
        'exactly one send after the re-check (' + JSON.stringify(sentIds) + ')');
      check(restored.state.windowCount === 1, 'quota moved once (' +
        restored.state.windowCount + ')');
      check(restored.state.seen[NEW_RUN + '|completed'].state === 'sent',
        'the journal records it as sent');
      check(!restored.state.deferred[NEW_RUN + '|completed'],
        'and the deferral is cleared');

      // Re-offering the same completion (an ACK retry) must not write again.
      env.chromeMock.write('terminalCandidates',
        (env.chromeMock.read('terminalCandidates') || [])
          .concat([{ runId: NEW_RUN, status: 'completed' , origin: 'bridge'}]));
      const again = await env.tick({ limit: 2, now: () => retryAt + 2,
        sendOnce: async (c) => { sentIds.push(c.runId);
          return { sent: true, pageWriteAttempted: true, status: 'submitted' }; } });
      check(sentIds.length === 1, 'a re-offered completion is not written twice (' +
        sentIds.length + ')');

      // And T077 is still refused by name after all of that.
      const old = env.chromeMock.read('terminalCandidates');
      env.chromeMock.write('terminalCandidates', old.concat([
        { runId: T077_RUN, status: 'completed' , origin: 'bridge'}]));
      const revived = await env.tick({ limit: 2, now: () => retryAt + 3,
        sendOnce: async (c) => { sentIds.push(c.runId);
          return { sent: true, pageWriteAttempted: true, status: 'submitted' }; } });
      check(sentIds.length === 1, 'the T077 run is never replayed (' + sentIds.length + ')');
      check(revived.results.some((x) => x.code === 'duplicate_event'
        || x.code === 'duplicate_run' || x.code === 'pre_arm_candidate'),
        'it is refused by name (' +
        JSON.stringify(revived.results.map((x) => x.code)) + ')');
    } finally { env.cleanup(); }
  }

  // ------------- 4. the repair fills, and never rewrites, what it finds
  console.log('== T078: normalization fills gaps without touching history ==');
  {
    const before = t074State();
    const once = T.normalizeTriggerState(before, T0 + 2000);
    check(once.filled.includes('deferred'), 'it reports filling `deferred` (' +
      JSON.stringify(once.filled) + ')');
    check(once.suspect.length === 0,
      'a well-formed legacy record is not quarantined (' +
      JSON.stringify(once.suspect) + ')');
    check(JSON.stringify(once.state.seen) === JSON.stringify(before.seen),
      'every journal entry is byte-identical, including `attempting`');
    check(JSON.stringify(once.state.preArmCandidateKeys)
      === JSON.stringify(before.preArmCandidateKeys),
      'the pre-arm snapshot is preserved');
    for (const field of ['windowCount', 'lastSentAt', 'windowStartedAt', 'armedAt',
      'minIntervalMs', 'maxPerHour', 'enabled']) {
      check(once.state[field] === before[field],
        field + ' is untouched (' + once.state[field] + ')');
    }
    check(once.state.schemaSuspect === undefined,
      'and no quarantine field is written on a clean record');
    check(JSON.stringify(once.state.deferred) === '{}',
      'the new map starts empty, so nothing becomes retryable');

    const twice = T.normalizeTriggerState(once.state, T0 + 3000);
    check(twice.filled.length === 0,
      'a second pass has nothing to do (' + JSON.stringify(twice.filled) + ')');
    check(JSON.stringify(twice.state) === JSON.stringify(once.state),
      'and is byte-identical, so the repair is idempotent');
    check(once.state.schemaFilled.includes('deferred'),
      'the repair is recorded for the diagnostics panel');

    // Mutating the result must not reach back into the caller's object.
    once.state.seen[SENT_RUN + '|completed'].state = 'tampered';
    check(before.seen[SENT_RUN + '|completed'].state === 'sent',
      'and it works on a copy, not on the caller\'s state');
  }

  // ------------------------------ 5. malformed input is refused, never widened
  console.log('== T078: malformed fields fail closed ==');
  {
    const cases = [
      ['seen null', { seen: null }, 'seen'],
      ['seen an array', { seen: [] }, 'seen'],
      ['seen a string', { seen: 'x' }, 'seen'],
      ['lastSentAt a string', { lastSentAt: 'soon' }, 'lastSentAt'],
      ['preArmCandidateKeys a string', { preArmCandidateKeys: 'nope' },
        'preArmCandidateKeys'],
      ['windowCount negative', { windowCount: -3 }, 'windowCount'],
    ];
    for (const [label, over, field] of cases) {
      const r = T.normalizeTriggerState(t074State(over), T0 + 4000);
      check(r.suspect.includes(field), label + ' is quarantined (' +
        JSON.stringify(r.suspect) + ')');
      // Well past the stored pacing anchor, so only the quarantine can refuse.
      const admitted = T.admit(r.state, { runId: NEW_RUN, status: 'completed' , origin: 'bridge'},
        T0 + 200000);
      check(admitted.admit === false && admitted.code === 'state_schema_suspect',
        'and it refuses to send (' + admitted.code + ')');
      check(JSON.stringify(admitted.fields || []).includes(field),
        'naming the field (' + JSON.stringify(admitted.fields) + ')');
    }

    const enabledString = T.normalizeTriggerState(t074State({ enabled: 'true' }),
      T0 + 4500);
    check(enabledString.state.enabled === false,
      'the string "true" is not an armed trigger');
    check(enabledString.suspect.includes('enabled'), 'and it is quarantined');

    const huge = T.normalizeTriggerState(t074State({ maxPerHour: 1e9 }), T0 + 4600);
    check(huge.state.maxPerHour === 100, 'an absurd hourly cap is clamped down (' +
      huge.state.maxPerHour + ')');
    const tiny = T.normalizeTriggerState(t074State({ maxPerHour: 0 }), T0 + 4700);
    check(tiny.state.maxPerHour === 1, 'a zero cap becomes 1, not 100 (' +
      tiny.state.maxPerHour + ')');
    const fast = T.normalizeTriggerState(t074State({ minIntervalMs: 1000 }),
      T0 + 4800);
    check(fast.state.minIntervalMs === 30000, 'a 1s interval becomes the 30s floor (' +
      fast.state.minIntervalMs + ')');
    const slow = T.normalizeTriggerState(t074State({ minIntervalMs: 1e12 }),
      T0 + 4900);
    check(slow.state.minIntervalMs === 3600000, 'and a day becomes the ceiling (' +
      slow.state.minIntervalMs + ')');
    const kept = T.normalizeTriggerState(t074State({ maxPerHour: 20 }), T0 + 4950);
    check(kept.state.maxPerHour === 20,
      'a legitimate 20/hour is never widened or narrowed (' + kept.state.maxPerHour + ')');

    const corruptDeferred = T.normalizeTriggerState(
      t074State({ deferred: 'garbage' }), T0 + 5000);
    check(JSON.stringify(corruptDeferred.state.deferred) === '{}',
      'a corrupt deferral map is simply emptied (it cannot cause a write)');
    check(!corruptDeferred.suspect.includes('deferred'),
      'and does not quarantine the trigger');
    check(JSON.stringify(corruptDeferred.state.seen)
      === JSON.stringify(t074State().seen), 'dedup is untouched by that repair');

    for (const junk of [null, undefined, [], 'x', 42]) {
      const r = T.normalizeTriggerState(junk, T0 + 5100);
      check(r.state.enabled === false && JSON.stringify(r.state.seen) === '{}',
        'a non-object state (' + JSON.stringify(junk) + ') becomes a fresh, off state');
      check(T.admit(r.state, { runId: NEW_RUN, status: 'completed' , origin: 'bridge'},
        T0 + 5200).code === 'trigger_disabled',
        'which cannot send');
    }
  }

  // ------------------- 6. the other outcomes still behave on a legacy record
  console.log('== T078: blocked and uncertain outcomes are unchanged ==');
  {
    const cand = { runId: NEW_RUN, status: 'completed' , origin: 'bridge'};
    const blocked = T.settle(
      T.markAttempt(t074State(), cand, T0 + 6000).state,
      NEW_RUN + '|completed',
      { sent: false, pageWriteAttempted: false, code: 'authorization_expired' },
      T0 + 6100);
    check(blocked.result.code === 'blocked', 'an expired grant is a block (' +
      blocked.result.code + ')');
    check(blocked.state.enabled === false,
      'and disarms (' + blocked.state.lastError + ')');
    check(blocked.state.seen[NEW_RUN + '|completed'].state === 'blocked',
      'the run is terminal');

    const uncertain = T.settle(
      T.markAttempt(t074State(), cand, T0 + 6200).state,
      NEW_RUN + '|completed',
      { sent: false, pageWriteAttempted: true, code: 'unconfirmed' }, T0 + 6300);
    check(uncertain.result.code === 'stopped' && uncertain.state.enabled === false,
      'an uncertain write still stops the trigger');
    check(uncertain.state.deferred[NEW_RUN + '|completed'] === undefined,
      'and never becomes a deferral');

    const noFlag = T.settle(
      T.markAttempt(t074State(), cand, T0 + 6400).state,
      NEW_RUN + '|completed',
      { sent: false, code: 'target_not_visible_and_focused' }, T0 + 6500);
    check(noFlag.result.code === 'stopped',
      'a refusal without proof of "no write" is a stop (' + noFlag.result.code + ')');

    const dup = T.admit(t074State(), { runId: SENT_RUN, status: 'completed' , origin: 'bridge'},
      T0 + 6600);
    check(dup.code === 'duplicate_event' && dup.previous === 'sent',
      'an already-sent run is a duplicate (' + dup.code + '/' + dup.previous + ')');
    const dupRun = T.admit(t074State(), { runId: SENT_RUN, status: 'failed' , origin: 'bridge'},
      T0 + 6700);
    check(dupRun.code === 'duplicate_run',
      'a second status for the same task is refused too (' + dupRun.code + ')');
    const stuck = T.admit(t074State(), { runId: T077_RUN, status: 'completed' , origin: 'bridge'},
      T0 + 6800);
    check(stuck.code === 'duplicate_event' && stuck.previous === 'attempting',
      'and an `attempting` run from a crash is never re-offered (' +
      stuck.code + '/' + stuck.previous + ')');
  }

  // ------------------------------ 7. the repair is visible, and claims nothing
  console.log('== T078: the panel shows the repair, not a delivery ==');
  {
    const legacy = t074State();
    legacy.enabled = false;
    legacy.lastError = 'alarm_tick_failed:legacy';
    const env = await open(legacy);
    try {
      const ready = await env.dispatch({ type: 't069-canary-readiness' });
      const item = (ready.result.items || [])
        .find((i) => i.id === 'trigger_schema');
      check(item !== undefined, 'the panel reports a schema item');
      check(item && item.state === 'ok', 'a repairable record reads ok (' +
        (item && item.state) + ')');
      check(item && /deferred/.test(item.detail || ''),
        'and names what had to be filled in (' + (item && item.detail) + ')');

      const suspectState = t074State({ seen: null });
      suspectState.enabled = true;
      env.chromeMock.write('terminalTrigger', suspectState);
      const ready2 = await env.dispatch({ type: 't069-canary-readiness' });
      const item2 = (ready2.result.items || [])
        .find((i) => i.id === 'trigger_schema');
      check(item2 && item2.state === 'bad',
        'a quarantined record reads bad (' + (item2 && item2.state) + ')');
      check((ready2.result.blockedBy || []).includes('trigger_schema_suspect'),
        'and blocks by name (' + JSON.stringify(ready2.result.blockedBy) + ')');
      check(ready2.result.ok === false, 'so the panel does not call it ready');
      check(ready2.result.realWriteConfirmed === false,
        'and nothing claims a real write was confirmed');
    } finally { env.cleanup(); }
  }

  // ------------- 8. a deferral can never be re-settled into a second attempt
  console.log('== T078: the repair cannot manufacture a retry ==');
  {
    const cand = { runId: NEW_RUN, status: 'completed' , origin: 'bridge'};
    const k = NEW_RUN + '|completed';
    const first = T.settle(T.markAttempt(t074State(), cand, T0 + 7000).state, k,
      { sent: false, pageWriteAttempted: false,
        code: 'target_not_visible_and_focused' }, T0 + 7100);
    check(first.result.status === 'deferred', 'the first refusal defers');
    const second = T.settle(first.state, k,
      { sent: true }, T0 + 7200);
    check(second.result.ok === false && second.result.code === 'trigger_not_attempting',
      'settling it again is refused (' + second.result.code + ')');
    check(second.state.windowCount === first.state.windowCount,
      'and cannot consume quota (' + second.state.windowCount + ')');
    check(JSON.stringify(second.state.seen)
      === JSON.stringify(first.state.seen),
      'and cannot create a journal entry out of nothing');

    // The same holds on a legacy record read straight from storage. A run left
    // `attempting` by a crash is *not* re-settleable into a confirmation by this
    // module: the tick reconciles first, which turns it into `stopped`, and only
    // then would `settle` see it -- at which point it refuses.
    const legacy = t074State();
    const reconciledLegacy = T.reconcileAfterRestart(legacy, T0 + 7300).state;
    check(reconciledLegacy.seen[T077_RUN + '|completed'].state === 'stopped',
      'a crash leftovers become stopped, never sent (' +
      reconciledLegacy.seen[T077_RUN + '|completed'].state + ')');
    const afterReconcile = T.settle(reconciledLegacy, T077_RUN + '|completed',
      { sent: true }, T0 + 7350);
    check(afterReconcile.result.ok === false,
      'and a later settle cannot turn it into a delivery (' +
      afterReconcile.result.code + ')');
    check(afterReconcile.state.windowCount === legacy.windowCount,
      'nor consume quota (' + afterReconcile.state.windowCount + ')');

    const restarted = T.reconcileAfterRestart(
      T.markAttempt(t074State(), cand, T0 + 7400).state, T0 + 7500);
    check(restarted.state.seen[k].state === 'stopped'
      && restarted.state.enabled === false,
      'a dangling attempt on a legacy record is still stopped, not deferred');
    check(restarted.state.deferred === undefined
      || restarted.state.deferred[k] === undefined,
      'and no deferral appears for it');

    // The one thing that makes the above airtight: every tick reconciles *before*
    // it can mark or settle anything. Keeping that order is a load-bearing
    // invariant, so assert it on the source rather than in a comment.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('./extension/background.js', ROOT), 'utf8');
    const body = source.slice(source.indexOf('async function runTerminalTrigger'));
    const reconcileAt = body.indexOf('reconcileAfterRestart(');
    const markAt = body.indexOf('markAttempt(');
    const settleAt = body.indexOf('.settle(');
    check(reconcileAt !== -1 && markAt !== -1 && settleAt !== -1,
      'the tick still reconciles, marks and settles');
    check(reconcileAt < markAt && reconcileAt < settleAt,
      'and it reconciles first (' + reconcileAt + ' < ' + markAt + ' / '
      + settleAt + ')');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

