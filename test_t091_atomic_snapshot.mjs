// T091: the arming boundary, taken from the host instead of guessed from a clock.
//
// T086 drew the boundary with `startedAt >= armedAt`. That is a real proof, but a
// one-sided one: a task created before the operator armed and finished after it was
// indistinguishable from the backlog, so it was refused. This suite proves the
// replacement end to end: the host records *which runs are terminal at the instant
// the trigger is armed*, and a run absent from that set was therefore still running
// then -- so it finished afterwards, whatever its creation time says.
//
// The whole chain is real: the shipped `background.js` worker, the real Python host
// over its real length-prefixed wire, and a synthetic ledger in a temp directory.
// No production ledger, no browser, no page.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync,
  existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);

const ORIGIN = 'chrome-extension://t091-e2e/';
const CONV = '2b7c9e10-3d4f-4a5b-9c8d-7e6f5a4b3c2d';
const BINDING = {
  version: 1, revision: 6, manuallyConfirmed: true, tabId: 31, windowId: 4,
  conversationId: CONV, url: 'https://chatgpt.com/c/' + CONV,
  documentInstanceId: 'doc-91', boundAt: 0,
};
// 2026-09-20-ish. Nothing in this suite depends on the wall clock except the
// fixture timestamps, which are deliberately far in the past.
const T0 = 1789000000000;
const HOUR = 3600000;
// Already terminal when the trigger is armed: history, must never be sent.
const OLD_DONE = '5a5a5a5a-1111-4111-8111-5a5a5a5a5a5a';
// Created two hours before the arm, still running at the arm, finished after it.
// This is the long task T086 had to refuse and T091 must deliver.
const LONG_RUN = '6b6b6b6b-2222-4222-8222-6b6b6b6b6b6b';
// Created after the arm: the ordinary case.
const NEW_RUN = '7c7c7c7c-3333-4333-8333-7c7c7c7c7c7c';
const BASE_RUN = '8d8d8d8d-4444-4444-8444-8d8d8d8d8d8d';

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ the host
function writeLedger(ledgerRoot, runs) {
  const dir = join(ledgerRoot, 'c'.repeat(64));
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
      connectNative: () => {
        if (hostRef.broken) throw new Error('native host is not installed');
        return hostRef.current.port();
      },
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

// ------------------------------------------------------------------ harness
async function open(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 't091-'));
  const ledgerRoot = join(dir, 'agents');
  writeLedger(ledgerRoot, options.ledger || []);
  const hostRef = { current: null, broken: options.brokenHost === true };
  const chromeMock = createChrome(hostRef);
  globalThis.chrome = chromeMock.api;
  chromeMock.stores.session.set('t053TargetBindingState', {
    version: 1, revision: BINDING.revision, binding: BINDING, candidates: [],
    candidateScannedAt: null,
  });
  const h = options.brokenHost === true ? { stop() {} }
    : startHost(join(dir, 'host'), ledgerRoot);
  hostRef.current = h;
  if (options.seed) chromeMock.stores.local.set('terminalTrigger', clone(options.seed));
  const bg = await mod('./extension/background.js?t091=' + Date.now()
    + Math.random().toString(16).slice(2));
  const stateDir = join(dir, 'host');
  return {
    dir, ledgerRoot, chromeMock, bg, host: h, stateDir,
    armFile: join(stateDir, 'terminal-arm.json'),
    read: (key) => (chromeMock.stores.local.has(key)
      ? clone(chromeMock.stores.local.get(key)) : undefined),
    write: (key, value) => chromeMock.stores.local.set(key, clone(value)),
    rewrite: (runs) => writeLedger(ledgerRoot, runs),
    dispatch: (msg) => wireDispatch(chromeMock)(msg),
    arm: () => wireDispatch(chromeMock)({
      type: 't059-trigger-arm', minIntervalMs: 30000, maxPerHour: 100,
      confirmation: 'AUTOTRIGGER ' + CONV, userGesture: true,
    }),
    tick: (sendOnce, now) => bg.runTerminalTrigger({
      limit: 4, now: now || (() => T0), sendOnce,
    }),
    close() {
      try { h.stop(); } catch (_err) { /* gone */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch (_err) { /* gone */ }
    },
  };
}

// The host's own snapshot document, read back for assertions. The epoch and the id
// set only -- no message body, no project path.
function armDoc(env) {
  if (!existsSync(env.armFile)) return null;
  return JSON.parse(readFileSync(env.armFile, 'utf8'));
}

function collector() {
  const sent = [];
  return {
    sent,
    writer: async (candidate) => {
      sent.push(candidate.runId);
      return { sent: true, code: null, status: 'submitted' };
    },
  };
}

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

async function main() {
  // ------------------- 1. the boundary is taken from the host, before enabling
  console.log('== T091: arming records a host-side snapshot, not a local guess ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      const baseline = await env.bg.refreshTerminalCandidates();
      check(baseline.ok === true, 'the sampler baseline is established');

      // One task finished long before anyone armed; another is still running.
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: OLD_DONE, status: 'completed', createdAt: T0 - 6 * HOUR },
      ]);
      const armed = await env.arm();
      check(armed && armed.ok === true && armed.result.ok === true,
        'the trigger arms (' + JSON.stringify(armed && armed.result) + ')');

      const state = env.read('terminalTrigger');
      check(typeof state.armEpoch === 'string' && state.armEpoch.length >= 8,
        'the arm round is named (' + state.armEpoch + ')');
      check(Number.isSafeInteger(state.armSnapshotAt),
        'and the snapshot instant is recorded (' + state.armSnapshotAt + ')');
      const doc = armDoc(env);
      check(doc !== null, 'the host wrote its own snapshot document');
      check(doc && doc.epoch === state.armEpoch,
        'the two sides agree on the arm round');
      check(doc && doc.truncated === false, 'and the snapshot is complete');
      check(doc && doc.ids.includes(OLD_DONE),
        'the already-finished run is in it (' + (doc && doc.ids.length) + ' ids)');
      check(doc && !doc.ids.includes(LONG_RUN),
        'and the task that is still running is not');
      check(state.enabled === true, 'the trigger really is enabled');
    } finally { env.close(); }
  }

  // ------------------- 2. the long task T086 could not deliver
  console.log('== T091: a task created before the arm but finished after it ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      await env.bg.refreshTerminalCandidates();
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: OLD_DONE, status: 'completed', createdAt: T0 - 6 * HOUR },
      ]);
      await env.arm();
      // It finishes now, two hours after it was created and after the arm.
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: OLD_DONE, status: 'completed', createdAt: T0 - 6 * HOUR },
        { id: LONG_RUN, status: 'completed', createdAt: T0 - 2 * HOUR },
      ]);
      const c = collector();
      const tick = await env.tick(c.writer);
      // T086 refused this as `started_before_arm`: provably created before the
      // arm, therefore not provably new, therefore dropped. Case 6 below runs the
      // same ledger on the old rule and shows exactly that, so this is a change in
      // capability, not in wording.
      check(c.sent.length === 1 && c.sent[0] === LONG_RUN,
        'the long task is delivered (' + JSON.stringify(c.sent) + ')');
      check(!c.sent.includes(OLD_DONE),
        'while the run that was already finished at arm time is not');
      const codes = (tick.results || []).map((r) => r.code + '/' + (r.reason || ''));
      check(codes.includes('pre_arm_candidate/in_arm_snapshot'),
        'and it is refused by name (' + codes.join(',') + ')');
      const state = env.read('terminalTrigger');
      check(state.windowCount === 1, 'exactly one slot of quota was used (' +
        state.windowCount + ')');
    } finally { env.close(); }
  }

  // ------------------- 3. the window between snapshot and enable
  console.log('== T091: a completion in the snapshot/enable window is new work ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      await env.bg.refreshTerminalCandidates();
      const armed = await env.arm();
      check(armed.result.ok === true, 'the arm completed');
      const takenAt = env.read('terminalTrigger').armSnapshotAt;
      check(Number.isSafeInteger(takenAt), 'the snapshot instant is on record');
      // Finished 1s before the snapshot instant, i.e. inside the window between
      // the host answering and the extension persisting `enabled`. It is absent
      // from the snapshot, so it is provably post-snapshot and must be delivered.
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: NEW_RUN, status: 'completed', createdAt: (takenAt - 1) * 1000 },
      ]);
      const c = collector();
      await env.tick(c.writer);
      check(c.sent.length === 1 && c.sent[0] === NEW_RUN,
        'a run that finished in that window is delivered (' +
        JSON.stringify(c.sent) + ')');
    } finally { env.close(); }
  }

  // ------------------- 4. nothing is enabled on a snapshot that cannot be taken
  console.log('== T091: no provable snapshot means no arm ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      await env.bg.refreshTerminalCandidates();
      // 5001 terminal runs: one past the id bound. A bounded snapshot would drop
      // its oldest ids, and every dropped id would look new -- the exact failure
      // this mechanism exists to prevent. Refusing the arm is the only safe answer.
      const many = [];
      for (let i = 0; i < 5001; i += 1) {
        many.push({ id: '9e9e9e9e-' + String(i).padStart(4, '0') + '-4aaa-8aaa-'
          + String(i).padStart(12, '0'), status: 'completed',
          createdAt: T0 - 48 * HOUR + i * 1000 });
      }
      env.rewrite(many);
      const armed = await env.arm();
      check(armed && armed.result && armed.result.ok === false,
        'the arm is refused (' + JSON.stringify(armed && armed.result) + ')');
      check(String(armed && armed.result && armed.result.code)
        .includes('snapshot_truncated'),
        'with a truncation code (' + (armed && armed.result && armed.result.code) + ')');
      const state = env.read('terminalTrigger');
      check(!state || state.enabled !== true,
        'and the trigger is not enabled (' + (state && state.enabled) + ')');
      check(armDoc(env) === null, 'and no partial snapshot was written');
      const c = collector();
      const tick = await env.tick(c.writer);
      check(c.sent.length === 0,
        'so a tick after the failed arm writes nothing (' + c.sent.length + ')');
      check(tick.fetched && tick.fetched.code === 'trigger_disabled',
        'because the trigger was never enabled (' +
        (tick.fetched && tick.fetched.code) + ')');
    } finally { env.close(); }
  }
  {
    const env = await open({ ledger: [], brokenHost: true });
    try {
      const armed = await env.arm();
      check(armed && armed.result && armed.result.ok === false,
        'an unreachable host refuses the arm (' +
        JSON.stringify(armed && armed.result) + ')');
      check(env.read('terminalTrigger') === undefined,
        'and no trigger state is written at all');
    } finally { env.close(); }
  }

  // ------------------- 5. a host that lost its snapshot makes nothing provable
  console.log('== T091: lost or mismatched epoch refuses, and does not swallow ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      await env.bg.refreshTerminalCandidates();
      await env.arm();
      // The host's own state directory is lost (a restart with a fresh state dir,
      // a wiped disk, a different agent state). Its snapshot is gone; the trigger
      // still holds an epoch, so nothing can be proven.
      rmSync(env.armFile, { force: true });
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: NEW_RUN, status: 'completed', createdAt: T0 - 1000 },
      ]);
      const c = collector();
      const tick = await env.tick(c.writer);
      check(c.sent.length === 0,
        'nothing is sent when the host has no snapshot (' + c.sent.length + ')');
      const codes = (tick.results || []).map((r) => r.code + '/' + (r.reason || ''));
      check(codes.includes('boundary_unproven/arm_snapshot_missing'),
        'the refusal is named as a missing snapshot (' + codes.join(',') + ')');
      const state = env.read('terminalTrigger');
      check(state.enabled === true,
        'the trigger stays armed so a re-arm can fix it (' + state.enabled + ')');
      check(!Array.isArray(state.preArmCandidateKeys)
        || !state.preArmCandidateKeys.includes(NEW_RUN + '|completed'),
        'and the candidate is NOT locked in as history (' +
        JSON.stringify(state.preArmCandidateKeys || []) + ')');

      // A re-arm takes a fresh snapshot, so a run that finished while nothing was
      // provable is now *terminal at the new arm instant* -- legitimately history.
      // What matters is that this verdict comes from a human re-arm, and that the
      // unproven candidate was never silently rewritten as history beforehand.
      const rearmed = await env.arm();
      check(rearmed.result.ok === true, 'a re-arm succeeds (' +
        JSON.stringify(rearmed && rearmed.result) + ')');
      const c2 = collector();
      const tick2 = await env.tick(c2.writer);
      check(c2.sent.length === 0,
        'the run that finished while unproven is history at the new arm (' +
        JSON.stringify(c2.sent) + ')');
      const codes2 = (tick2.results || []).map((r) => r.code + '/' + (r.reason || ''));
      // `queued_before_arm` (the extension still held it in its candidate queue at
      // arm time) or `in_arm_snapshot` (the host saw it terminal) -- both are a
      // verdict from this re-arm. What must not appear is a stale fold left over
      // from the broken round, which is what the previous check rules out.
      check(codes2.some((x) => x.endsWith('/in_arm_snapshot')
        || x.endsWith('/queued_before_arm')),
        'and it is refused by the new round, not by a stale fold (' +
        codes2.join(',') + ')');

      // Work that finishes after the new arm still goes through, so nothing was
      // disabled along the way.
      const later = 'cdcdcdcd-6666-4666-8666-cdcdcdcdcdcd';
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: NEW_RUN, status: 'completed', createdAt: T0 - 1000 },
        { id: later, status: 'completed', createdAt: T0 - 500 },
      ]);
      const c3 = collector();
      await env.tick(c3.writer);
      check(c3.sent.includes(later),
        'and work finishing after the new arm is delivered (' +
        JSON.stringify(c3.sent) + ')');
    } finally { env.close(); }
  }
  {
    // An epoch that exists on both sides but does not agree: the extension was
    // re-armed against a host that still holds an older round. Nothing about
    // either snapshot applies, so nothing is proven.
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      await env.bg.refreshTerminalCandidates();
      await env.arm();
      const state = env.read('terminalTrigger');
      env.write('terminalTrigger', Object.assign({}, state,
        { armEpoch: 'someone-elses-arm-round' }));
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: NEW_RUN, status: 'completed', createdAt: T0 - 1000 },
      ]);
      const c = collector();
      const tick = await env.tick(c.writer);
      check(c.sent.length === 0, 'a mismatched epoch sends nothing');
      const codes = (tick.results || []).map((r) => r.code + '/' + (r.reason || ''));
      check(codes.includes('boundary_unproven/arm_epoch_mismatch'),
        'and says the rounds disagree (' + codes.join(',') + ')');
    } finally { env.close(); }
  }

  // ------------------- 6. the old rule, on the same ledger, still refuses
  console.log('== T091: the T086 rule really did refuse that task ==');
  {
    // Same ledger as case 2, but on a trigger record with no epoch -- exactly the
    // record the previous release left behind. It must keep working (it never
    // sends history) and it must still refuse the long task, which is the whole
    // reason this release exists.
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      await env.bg.refreshTerminalCandidates();
      env.write('terminalTrigger', {
        version: 1, enabled: true, armedAt: Date.now(),
        minIntervalMs: 30000, maxPerHour: 100,
        lastSentAt: null, windowStartedAt: Date.now(), windowCount: 0,
        lastError: null, disabledAt: null, seen: {}, deferred: {},
        preArmCandidateKeys: [],
      });
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: OLD_DONE, status: 'completed', createdAt: T0 - 6 * HOUR },
        { id: LONG_RUN, status: 'completed', createdAt: T0 - 2 * HOUR },
      ]);
      const c = collector();
      const tick = await env.tick(c.writer, () => Date.now());
      check(c.sent.length === 0,
        'the legacy rule refuses it (' + JSON.stringify(c.sent) + ')');
      const codes = (tick.results || []).map((r) => r.code + '/' + (r.reason || ''));
      check(codes.includes('pre_arm_candidate/started_before_arm'),
        'naming the creation-time proof as the reason (' + codes.join(',') + ')');

      // And a task created after the legacy arm still goes through, so the old
      // record is not simply dead.
      const fresh = 'abababab-5555-4555-8555-abababababab';
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: OLD_DONE, status: 'completed', createdAt: T0 - 6 * HOUR },
        { id: LONG_RUN, status: 'completed', createdAt: T0 - 2 * HOUR },
        { id: fresh, status: 'completed', createdAt: Date.now() + 2000 },
      ]);
      const c2 = collector();
      await env.tick(c2.writer, () => Date.now());
      check(c2.sent.includes(fresh),
        'while a post-arm task is still delivered (' + JSON.stringify(c2.sent) + ')');
    } finally { env.close(); }
  }

  // ------------------- 7. the arm touches nothing the send journal owns
  console.log('== T091: journal, quota and ambiguity records survive the arm ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      await env.bg.refreshTerminalCandidates();
      // A trigger that has already been used: two sends this window, one permanent
      // record, one deferral, and two ambiguous outcome records awaiting a human.
      const seenKey = 'eeeeeeee-7777-4777-8777-eeeeeeeeeeee|completed';
      const before = {
        version: 1, enabled: false, armedAt: T0 - HOUR,
        minIntervalMs: 30000, maxPerHour: 100,
        lastSentAt: T0 - 60000, windowStartedAt: T0 - 600000, windowCount: 2,
        lastError: 'stopped:delivery_not_confirmed', disabledAt: T0 - 30000,
        seen: { [seenKey]: { at: T0 - 60000, code: null } },
        deferred: { 'ffffffff-8888-4888-8888-ffffffffffff|completed':
          { attempts: 1, retryAt: T0 + 30000 } },
        ambiguous: [
          { runId: 'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa', at: T0 - 120000 },
          { runId: 'bbbbbbbb-9999-4999-8999-bbbbbbbbbbbb', at: T0 - 180000 },
        ],
      };
      env.write('terminalTrigger', Object.assign({}, before, { enabled: false }));
      const armed = await env.arm();
      check(armed.result.ok === true, 'the arm succeeds over a used journal');
      const after = env.read('terminalTrigger');
      check(Object.keys(after.seen).includes(seenKey),
        'the permanent sent record is intact (' +
        Object.keys(after.seen).length + ' keys)');
      // T059 already decided that a *manual* arm opens a fresh hourly window, and
      // that decision is unchanged here: the anti-replay guards are `seen` and
      // `lastSentAt`, and both survive. Changing the window semantics is not part
      // of this task, and silently doing it would be the kind of half-change this
      // release exists to avoid.
      check(after.windowCount === 0,
        'the hourly window is rebuilt by the arm, as T059 decided (' +
        after.windowCount + ')');
      check(after.lastSentAt === T0 - 60000,
        'but the last-send instant is preserved, so the interval floor still applies');
      check(Array.isArray(after.ambiguous) && after.ambiguous.length === 2,
        'both ambiguous records are still there (' +
        (after.ambiguous || []).length + ')');
      check(after.deferred && Object.keys(after.deferred).length === 1,
        'the pending deferral survives (' +
        Object.keys(after.deferred || {}).length + ')');
      check(typeof after.armEpoch === 'string' && after.armEpoch.length > 0,
        'and the new round is the only thing added');
      // The journal's own record still vetoes a re-send even though this is a new
      // arm round: enabling again is not permission to replay.
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: seenKey.split('|')[0], status: 'completed', createdAt: T0 - 1000 },
      ]);
      const c = collector();
      await env.tick(c.writer);
      check(!c.sent.includes(seenKey.split('|')[0]),
        'and the already-sent run is not replayed (' + JSON.stringify(c.sent) + ')');
    } finally { env.close(); }
  }

  // ------------------- 8. an ack that failed does not become a second send
  console.log('== T091: a lost ack re-offers the run but never re-sends it ==');
  {
    const env = await open({ ledger: [] });
    try {
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      await env.bg.refreshTerminalCandidates();
      await env.arm();
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: NEW_RUN, status: 'completed', createdAt: T0 - 1000 },
      ]);
      const first = collector();
      await env.tick(first.writer);
      check(first.sent.length === 1, 'the first pass sent it once');
      // The queue hands the same run back -- what a duplicate offer, a retried ack
      // or a stale in-memory entry all look like from here. The permanent journal
      // record, not the arm round, is what must refuse it.
      env.write('terminalCandidates', [{ runId: NEW_RUN, status: 'completed', origin: 'bridge',
        startedAt: Math.floor((T0 - 1000) / 1000), postArm: true }]);
      const second = collector();
      const tick = await env.tick(second.writer);
      check(second.sent.length === 0,
        'a duplicate offer sends nothing (' + JSON.stringify(second.sent) + ')');
      const codes = (tick.results || []).map((r) => r.code + '/' + (r.reason || ''));
      check(codes.length > 0 && !codes.some((x) => x.startsWith('deferred')),
        'and it is refused outright, not deferred (' + codes.join(',') + ')');
      check((env.read('terminalTrigger').windowCount || 0) === 1,
        'no second slot of quota moved (' +
        env.read('terminalTrigger').windowCount + ')');
      // Re-arming does not unlock it either: the journal, not the arm, decides.
      await env.arm();
      env.write('terminalCandidates', [{ runId: NEW_RUN, status: 'completed', origin: 'bridge',
        startedAt: Math.floor((T0 - 1000) / 1000), postArm: true }]);
      const third = collector();
      await env.tick(third.writer);
      check(third.sent.length === 0,
        'and a fresh arm round does not replay it (' +
        JSON.stringify(third.sent) + ')');
    } finally { env.close(); }
  }

  // ------------------- 9. an unreadable ledger refuses the arm
  console.log('== T091: an unreadable ledger refuses, it does not arm blind ==');
  {
    const env = await open({ ledger: [] });
    try {
      const dir = join(env.ledgerRoot, 'c'.repeat(64));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'endpoint.json.runs.json'),
        JSON.stringify([{ status: 'completed' }]), 'utf8');
      const armed = await env.arm();
      check(armed && armed.result && armed.result.ok === false,
        'the arm is refused (' + JSON.stringify(armed && armed.result) + ')');
      check(String(armed && armed.result && armed.result.code)
        .includes('source_unavailable'),
        'naming the source (' + (armed && armed.result && armed.result.code) + ')');
      check(env.read('terminalTrigger') === undefined,
        'and nothing is enabled');
    } finally { env.close(); }
  }

  // ------------------- 10. a fresh install: arm before any sample exists
  console.log('== T091: the first sample of a fresh install does not swallow work ==');
  {
    const env = await open({ ledger: [] });
    try {
      // Nothing has ever been sampled, so the host has no baseline either. The
      // operator arms, and only then does a run finish. Without the snapshot the
      // first sample would record every terminal run as history and that
      // completion would be lost for good.
      env.rewrite([{ id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR }]);
      const armed = await env.arm();
      check(armed.result.ok === true, 'the trigger arms with no baseline yet');
      env.rewrite([
        { id: BASE_RUN, status: 'completed', createdAt: T0 - 24 * HOUR },
        { id: NEW_RUN, status: 'completed', createdAt: T0 - 500 },
      ]);
      const c = collector();
      await env.tick(c.writer);
      check(c.sent.length === 1 && c.sent[0] === NEW_RUN,
        'the first sample delivers what finished after the arm (' +
        JSON.stringify(c.sent) + ')');
      check(!c.sent.includes(BASE_RUN),
        'and not the run that was already there');
      const baseline = env.read('terminalSourceBaseline');
      check(baseline && baseline.established === true,
        'the baseline is recorded as established');
      const sample = await env.bg.refreshTerminalCandidates();
      check(sample.ok === true && sample.armEpoch === env.read('terminalTrigger').armEpoch,
        'and every later sample carries the same arm round (' + sample.armEpoch + ')');
      check(sample.armCount === 1,
        'with the snapshot size the host recorded (' + sample.armCount + ')');
    } finally { env.close(); }
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

