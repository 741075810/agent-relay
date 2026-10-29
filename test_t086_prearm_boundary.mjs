// T086: the arming boundary must not depend on what the *local* queue happened to
// hold at the moment of arming.
//
// The live sequence that exposed it:
//
//   1. the trigger was armed at some point, and a backlog snapshot
//      (`preArmCandidateKeys`) was taken from the *local* candidate list;
//   2. the extension was reloaded and re-armed while a task had already finished
//      but had not yet been pulled from the host into that local list;
//   3. the first tick after arming called `terminal-list`, which handed the old
//      completion over as a brand-new candidate;
//   4. it was not in the snapshot, so it counted as fresh work and was sent.
//
// Nothing about the local queue can prove when a run finished, so the snapshot
// alone is not a boundary. What *is* provable from the existing contract: a run
// always completes at or after its creation, and the host reports that creation
// time (`startedAt`, whole seconds). So `startedAt * 1000 >= armedAt` proves the
// completion happened after the operator armed the trigger.
//
// This suite drives the real background worker against the real Python host over
// its real wire protocol, with a synthetic ledger -- no production data, no
// browser, no page.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);

const ORIGIN = 'chrome-extension://t086-e2e/';
const CONV = '9f2a1b3c-4d5e-4f60-8a7b-1c2d3e4f5a6b';
const BINDING = {
  version: 1, revision: 4, manuallyConfirmed: true, tabId: 21, windowId: 3,
  conversationId: CONV, url: 'https://chatgpt.com/c/' + CONV,
  documentInstanceId: 'doc-86', boundAt: 0,
};
// 2026-10-08T... in ms; every timestamp below is derived from it so the arithmetic
// in the assertions stays readable.
const T0 = 1790000000000;
const OLD_RUN = '11111111-1111-4111-8111-111111111111';   // finished before arming
const NEW_RUN = '22222222-2222-4222-8222-222222222222';   // started after arming
const TICK = 30000;

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ the host
function writeLedger(ledgerRoot, runs) {
  const dir = join(ledgerRoot, 'b'.repeat(64));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'endpoint.json.runs.json'), JSON.stringify(
    runs.map((run) => ({ requestID: run.id, status: run.status,
      createdAt: run.createdAt })), null, 2), 'utf8');
}

function startHost(stateDir, ledgerRoot) {
  if (!ledgerRoot) {
    throw new Error('startHost requires a temporary ledgerRoot; refusing to read '
      + 'the production AgentState');
  }
  const cwd = fileURLToPath(new URL('.', import.meta.url));
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
    child,
    port() {
      let onDisc = null;
      const fire = () => { if (onDisc) { try { onDisc(); } catch (_err) { /* t */ } } };
      if (dead) setTimeout(fire, 0);
      return {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        onDisconnect: { addListener(fn) { disc.add(fn); onDisc = fn; } },
        postMessage(doc) { child.stdin.write(frame(doc)); },
        disconnect() { disc.delete(onDisc); },
      };
    },
    stop() { try { child.kill(); } catch (_err) { /* already gone */ } },
  };
}

// --------------------------------------------------------------- chrome mock
const event = () => ({ addListener() {}, removeListener() {},
  hasListener() { return false; } });

function createChrome(hostRef) {
  const stores = { local: new Map(), session: new Map() };
  const alarms = new Map();
  const messageListeners = [];
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      for (const [k, v] of Object.entries(defaults || {})) {
        out[k] = map.has(k) ? clone(map.get(k)) : v;
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
      async get() { return undefined; }, async query() { return []; },
      async sendMessage() { throw new Error('no tab in this suite'); },
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      onAttached: event(), onDetached: event(), onReplaced: event(),
    },
    windows: { onFocusChanged: event() },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    permissions: { async contains() { return false; } },
  };
  return { api, stores, messageListeners };
}

// The background's popup-only message boundary needs a real listener dispatch.
function wireDispatch(chromeMock) {
  return async (msg) => {
    const listener = chromeMock.messageListeners[0];
    if (!listener) throw new Error('no onMessage listener registered');
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
  };
}

// ------------------------------------------------------------------ harness
async function open(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 't086-'));
  const ledgerRoot = join(dir, 'agents');
  writeLedger(ledgerRoot, options.ledger || []);
  const hostRef = { current: null };
  const chromeMock = createChrome(hostRef);
  globalThis.chrome = chromeMock.api;
  chromeMock.stores.session.set('t053TargetBindingState', {
    version: 1, revision: BINDING.revision, binding: BINDING, candidates: [],
    candidateScannedAt: null,
  });
  const h = startHost(join(dir, 'host'), ledgerRoot);
  hostRef.current = h;
  const bg = await mod('./extension/background.js?t086=' + Date.now()
    + Math.random().toString(16).slice(2));
  return {
    dir, ledgerRoot, chromeMock, bg, host: h,
    read: (key) => clone(chromeMock.stores.local.get(key)),
    write: (key, value) => chromeMock.stores.local.set(key, clone(value)),
    rewrite: (runs) => writeLedger(ledgerRoot, runs),
    dispatch: (msg) => wireDispatch(chromeMock)(msg),
    close() { try { h.stop(); } catch (_err) { /* gone */ } 
      try { rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* gone */ } },
  };
}

function armedState(over) {
  return Object.assign({
    version: 1, enabled: true,
    // Armed *after* the old task was created, and after it had already finished.
    armedAt: T0 + 600000,
    minIntervalMs: 30000, maxPerHour: 100,
    lastSentAt: null, windowStartedAt: T0 + 600000, windowCount: 0,
    lastError: null, disabledAt: null,
    seen: {}, deferred: {},
    // The snapshot taken at arm time from the LOCAL queue: empty, because the old
    // completion had not been pulled from the host yet. This is the whole bug.
    preArmCandidateKeys: [],
  }, over || {});
}

async function main() {
  const T = await mod('./extension/lib/terminal_trigger.js');

  // ------------------- 1. the reported bug, reproduced end to end
  console.log('== T086: a completion from before the arm is not new work ==');
  {
    const env = await open({ ledger: [] });
    try {
      // Step 1: a run exists and the sampler has already taken its baseline.
      env.rewrite([{ id: '00000000-0000-4000-8000-000000000001',
        status: 'completed', createdAt: T0 - 86400000 }]);
      const baseline = await env.bg.refreshTerminalCandidates();
      check(baseline.ok === true && baseline.added === 0,
        'the first sample only establishes a baseline (' + JSON.stringify(
          { ok: baseline.ok, added: baseline.added }) + ')');

      // Step 2: a task finishes *before* the operator arms, and the host has not
      // handed it out yet -- exactly the "not in the local queue" state.
      env.rewrite([
        { id: '00000000-0000-4000-8000-000000000001', status: 'completed',
          createdAt: T0 - 86400000 },
        { id: OLD_RUN, status: 'completed', createdAt: T0 - 600000 },
      ]);
      env.write('terminalTrigger', armedState());

      const sent = [];
      const tick = await env.bg.runTerminalTrigger({
        limit: 3, now: () => T0 + 660000,
        sendOnce: async (candidate) => {
          sent.push(candidate.runId);
          return { sent: true, code: null, status: 'submitted' };
        },
      });
      // Before the fix this was sent: it was absent from the local snapshot, so it
      // counted as fresh work even though it finished two minutes before arming.
      check(sent.length === 0,
        'nothing was written for a pre-arm completion (' + JSON.stringify(sent) + ')');
      const codes = (tick.results || []).map((r) => r.code);
      check(codes.includes('pre_arm_candidate'),
        'it is reported as pre-arm, not silently dropped (' + codes.join(',') + ')');
      const state = env.read('terminalTrigger');
      check(state.windowCount === 0,
        'no quota was consumed (' + state.windowCount + ')');
      check(state.enabled === true,
        'and the trigger is still armed (' + state.enabled + ')');
      check(!Object.keys(state.seen || {}).includes(OLD_RUN + '|completed'),
        'and it was never journaled as attempted');
    } finally { env.close(); }
  }

  // ------------------- 2. a task that really did start after arming still sends
  console.log('== T086: a task created after the arm is still deliverable ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: '00000000-0000-4000-8000-000000000001',
        status: 'completed', createdAt: T0 - 86400000 }]);
      await env.bg.refreshTerminalCandidates();
      env.rewrite([
        { id: '00000000-0000-4000-8000-000000000001', status: 'completed',
          createdAt: T0 - 86400000 },
        { id: NEW_RUN, status: 'completed', createdAt: T0 + 660000 },
      ]);
      env.write('terminalTrigger', armedState());
      const sent = [];
      const tick = await env.bg.runTerminalTrigger({
        limit: 3, now: () => T0 + 700000,
        sendOnce: async (candidate) => {
          sent.push(candidate.runId);
          return { sent: true, code: null, status: 'submitted' };
        },
      });
      check(sent.length === 1 && sent[0] === NEW_RUN,
        'the post-arm completion is delivered (' + JSON.stringify(sent) + ')');
      const state = env.read('terminalTrigger');
      check(state.windowCount === 1, 'and the window counted it (' +
        state.windowCount + ')');
      check((tick.state || state).enabled === true, 'the trigger stayed armed');
    } finally { env.close(); }
  }

  // ------------------- 3. a candidate with no provenance is not provable
  console.log('== T086: a candidate with no creation time fails closed ==');
  {
    const env = await open({ ledger: [] });
    try {
      // A local entry from an older release: `{runId, status}` only.
      env.write('terminalCandidates', [{ runId: OLD_RUN, status: 'completed' , origin: 'bridge'}]);
      env.write('terminalTrigger', armedState());
      const sent = [];
      const tick = await env.bg.runTerminalTrigger({
        limit: 3, now: () => T0 + 660000,
        sendOnce: async (candidate) => {
          sent.push(candidate.runId);
          return { sent: true, code: null, status: 'submitted' };
        },
      });
      check(sent.length === 0, 'it is not sent (' + JSON.stringify(sent) + ')');
      const codes = (tick.results || []).map((r) => r.code);
      check(codes.includes('pre_arm_candidate'),
        'and it is counted as pre-arm (' + codes.join(',') + ')');
    } finally { env.close(); }
  }

  // ------------------- 4. a trigger record without `armedAt` is not a boundary
  console.log('== T086: a state with no arm timestamp cannot prove anything ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: '00000000-0000-4000-8000-000000000001',
        status: 'completed', createdAt: T0 - 86400000 }]);
      await env.bg.refreshTerminalCandidates();
      env.rewrite([
        { id: '00000000-0000-4000-8000-000000000001', status: 'completed',
          createdAt: T0 - 86400000 },
        { id: NEW_RUN, status: 'completed', createdAt: T0 + 660000 },
      ]);
      // `armedAt` deleted: this is what a record written before this release, or a
      // repaired one, looks like.
      const legacy = armedState();
      delete legacy.armedAt;
      env.write('terminalTrigger', legacy);
      const sent = [];
      await env.bg.runTerminalTrigger({
        limit: 3, now: () => T0 + 700000,
        sendOnce: async (candidate) => {
          sent.push(candidate.runId);
          return { sent: true, code: null, status: 'submitted' };
        },
      });
      check(sent.length === 0,
        'nothing is sent until a boundary exists (' + JSON.stringify(sent) + ')');
      const state = env.read('terminalTrigger');
      check(Number.isFinite(state.armedAt),
        'and a boundary is recorded now (' + state.armedAt + ')');

      // The very next tick, with the same ledger, must still refuse: the task was
      // created before the boundary that was just recorded.
      const second = [];
      await env.bg.runTerminalTrigger({
        limit: 3, now: () => T0 + 760000,
        sendOnce: async (candidate) => {
          second.push(candidate.runId);
          return { sent: true, code: null, status: 'submitted' };
        },
      });
      check(second.length === 0,
        'seeding the boundary does not release the backlog (' +
        JSON.stringify(second) + ')');
    } finally { env.close(); }
  }

  // ------------------- 5. re-arming moves the boundary, and only forward
  console.log('== T086: re-arming rebuilds the boundary ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: '00000000-0000-4000-8000-000000000001',
        status: 'completed', createdAt: T0 - 86400000 }]);
      await env.bg.refreshTerminalCandidates();
      env.rewrite([
        { id: '00000000-0000-4000-8000-000000000001', status: 'completed',
          createdAt: T0 - 86400000 },
        { id: OLD_RUN, status: 'completed', createdAt: T0 - 600000 },
      ]);
      // Arm through the real popup message, i.e. the real `configure()` path.
      const armed = await env.dispatch({
        type: 't059-trigger-arm', minIntervalMs: 30000, maxPerHour: 100,
        confirmation: 'AUTOTRIGGER ' + CONV, userGesture: true,
      });
      check(armed && armed.ok === true && armed.result.ok === true,
        'the trigger armed through the popup message (' +
        JSON.stringify(armed && armed.result) + ')');
      const state = env.read('terminalTrigger');
      check(Number.isFinite(state.armedAt) && state.armedAt > T0,
        'and the boundary is the arm instant (' + state.armedAt + ')');

      const sent = [];
      await env.bg.runTerminalTrigger({
        limit: 3, sendOnce: async (candidate) => {
          sent.push(candidate.runId);
          return { sent: true, code: null, status: 'submitted' };
        },
      });
      check(sent.length === 0,
        'a task created before the arm is still refused (' + JSON.stringify(sent) + ')');
    } finally { env.close(); }
  }

  // ------------------- 6. the boundary is a pure predicate over stored data
  console.log('== T086: the predicate is testable on its own ==');
  {
    const armed = { armedAt: T0 };
    const at = (ms) => ({ runId: OLD_RUN, status: 'completed', origin: 'bridge', startedAt: ms });
    check(T.completionAfterArm(armed, at(T0 / 1000)).proven === true,
      'a run created exactly at the arm moment is provable');
    check(T.completionAfterArm(armed, at(T0 / 1000 + 1)).proven === true,
      'and so is one created a second later');
    const before = T.completionAfterArm(armed, at(T0 / 1000 - 1));
    check(before.proven === false && before.reason === 'started_before_arm',
      'one created a second earlier is not (' + JSON.stringify(before) + ')');
    check(T.completionAfterArm(armed, at(T0 / 1000 - 0.5)).proven === false,
      'and the truncated second at the boundary is refused, not rounded up');
    check(T.completionAfterArm(armed, { runId: OLD_RUN, status: 'completed' , origin: 'bridge'})
      .reason === 'candidate_time_missing', 'a missing time is refused by name');
    check(T.completionAfterArm({ armedAt: null }, at(T0 / 1000)).reason
      === 'arm_boundary_missing', 'a missing boundary is refused by name');
    check(T.completionAfterArm({}, null).proven === false,
      'and nothing at all is not provable either');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});


