// T068: the T058/T059 default limits, their hard bounds, and the real alarm period.
//
// What changed and must stay true:
//   T058  one manual arm = 7 days, up to 1000 notices (bounds: 30 days / 1000)
//   T059  30s minimum interval, 100 per hour (bounds: 30s..60min, ceiling 100/hour)
//   alarm periodInMinutes 0.5 for a 30s interval -- Chrome 120+ supports it, and
//         the old `Math.max(1, Math.ceil(ms/60000))` silently ran a 1-minute tick
//
// Unchanged on purpose, and asserted here so a future edit cannot drift:
// hourly limit independent of the send budget, runId dedupe, T067 history
// isolation, first-baseline/ACK semantics, and "an existing grant never widens
// because the defaults moved".
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'chrome-extension://t068-e2e/';
const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
// T086: the arm boundary is proved from a run's creation time, so a fixture run must
// be created when it is written (i.e. after the arm), exactly like a real completion.
// arm is provably created after it; a fixed timestamp would prove nothing.
// (T086) `Date.now()` is used at the call site below, so a run written after the

const CONV = '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071';
const DAY = 86400000;
const OLD_RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// ------------------------------------------------------------- real host driver
function startHost(stateDir, ledgerRoot) {
  if (!ledgerRoot) {
    throw new Error('startHost requires a temporary ledgerRoot; refusing to let '
      + 'the host read the production AgentState');
  }
  const cwd = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1');
  const manifestPath = join(stateDir, 'host_manifest.e2e.json');
  mkdirSync(stateDir, { recursive: true });
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
  const portListeners = [];
  const discListeners = new Set();
  let stderr = '';
  let dead = false;
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  child.on('exit', () => {
    dead = true;
    for (const fn of discListeners) { try { fn(); } catch (_e) { /* caller's */ } }
    discListeners.clear();
  });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.slice(4, 4 + length).toString('utf8');
      buffer = buffer.slice(4 + length);
      let doc;
      try { doc = JSON.parse(body); } catch (_e) { continue; }
      for (const fn of portListeners) fn(doc);
    }
  });
  function frame(doc) {
    const body = Buffer.from(JSON.stringify(doc), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
  }
  return {
    get stderr() { return stderr; },
    port() {
      let listener = null;
      let fired = false;
      const fire = () => {
        if (fired || !listener) return;
        fired = true;
        try { listener(); } catch (_e) { /* the test's callback */ }
      };
      if (dead) setTimeout(fire, 0);
      return {
        onMessage: { addListener(fn) { portListeners.push(fn); } },
        onDisconnect: { addListener(fn) { listener = fn; discListeners.add(fire); } },
        postMessage(doc) {
          if (dead) { setTimeout(fire, 0); return; }
          try { child.stdin.write(frame(doc)); } catch (_e) { setTimeout(fire, 0); }
        },
      };
    },
    stop() { try { child.kill(); } catch (_e) { /* gone */ } },
  };
}

function writeRuns(ledgerRoot, runs) {
  const dir = join(ledgerRoot, 'a'.repeat(64));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'endpoint.json.runs.json'), JSON.stringify(
    runs.map((run, index) => ({ requestID: run.id, status: run.status,
      createdAt: Date.now() + 2000 + index * 1000 })), null, 2), 'utf8');
}

// ---------------------------------------------------------------- mock chrome
function stubEvent() {
  return { addListener() {}, removeListener() {}, hasListener() { return false; } };
}
function stubObject() {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (String(prop).startsWith('on')) return stubEvent();
      return stubObject();
    },
    apply() { return undefined; },
  });
}
function shield(target) {
  return new Proxy(target, {
    get(base, prop) {
      if (prop in base) return base[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (String(prop).startsWith('on')) return stubEvent();
      return stubObject();
    },
  });
}

function createChrome(hostRef) {
  const local = new Map();
  const session = new Map();
  const alarms = new Map();
  const createCalls = [];
  const messageListeners = [];
  function area(store) {
    return {
      async get(defaults) {
        const out = {};
        for (const [k, fb] of Object.entries(defaults || {})) {
          out[k] = store.has(k) ? clone(store.get(k)) : fb;
        }
        return out;
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) store.set(k, clone(v));
      },
      async remove(key) { store.delete(key); },
    };
  }
  const api = shield({
    storage: { local: area(local), session: area(session) },
    runtime: shield({
      id: 'test-extension',
      getURL: (p) => 'chrome-extension://t/' + p,
      connectNative: () => hostRef.current.port(),
      lastError: null,
      onMessage: { addListener(fn) { messageListeners.push(fn); } },
    }),
    tabs: shield({
      async query() { return []; },
      async get() { return null; },
      async sendMessage() { throw new Error('no content script'); },
    }),
    windows: shield({ async get() { return null; } }),
    alarms: shield({
      // Chrome keeps one alarm per name and replaces it on create, so the mock
      // does the same -- a second sync with the same period must not "create" a
      // new alarm, or the timer would reset forever.
      async get(name) {
        const found = alarms.get(name);
        return found ? clone(found) : undefined;
      },
      create(name, info) {
        createCalls.push({ name, info: clone(info) });
        alarms.set(name, { name, periodInMinutes: info.periodInMinutes,
          when: info.when });
      },
      async clear(name) { alarms.delete(name); },
    }),
    action: shield({ async setBadgeText() {} }),
    scripting: shield({ async executeScript() { return []; } }),
  });
  return {
    api, local, session, alarms, createCalls,
    dispatch(msg, sender) {
      return new Promise((resolve) => {
        const fn = messageListeners[messageListeners.length - 1];
        if (!fn) { resolve(undefined); return; }
        const ret = fn(msg, sender || { id: 'test-extension',
          url: 'chrome-extension://t/popup.html' }, resolve);
        if (ret !== true) resolve(undefined);
      });
    },
  };
}

async function main() {
  const autosend = await mod('./extension/lib/autosend.js');
  const trigger = await mod('./extension/lib/terminal_trigger.js');
  const BINDING = {
    tabId: 11, windowId: 4, revision: 3, url: 'https://chatgpt.com/c/' + CONV,
    conversationId: CONV, documentInstanceId: 'instance-abcdefghijkl',
    manuallyConfirmed: true, invalidatedReason: null,
  };
  const PHRASE = 'AUTOSEND ' + CONV;
  const TRIGGER_PHRASE = 'AUTOTRIGGER ' + CONV;

  // ------------------------------------------- 1. T058 defaults and hard bounds
  console.log('== T068: T058 grants 7 days / 1000 by default ==');
  {
    const arm = autosend.arm(autosend.createAutoSendState(), { binding: BINDING },
      PHRASE, true, 1_000_000);
    check(arm.result.ok === true, 'a default arm succeeds');
    check(arm.state.maxSends === 1000,
      'and grants 1000 notices (' + arm.state.maxSends + ')');
    check(arm.state.expiresAt === 1_000_000 + 7 * DAY,
      'with a 7-day lifetime (' +
      ((arm.state.expiresAt - 1_000_000) / DAY) + ' days)');
    check(autosend.DEFAULT_MAX_SENDS === 1000, 'the constant matches');
    check(autosend.DEFAULT_TTL_MS === 7 * DAY, 'including the TTL constant');

    // Bounds. A caller cannot buy itself a permanent, unlimited permission.
    const greedy = autosend.arm(autosend.createAutoSendState(),
      { binding: BINDING, ttlMs: 400 * DAY, maxSends: 1e9 }, PHRASE, true, 0);
    check(greedy.state.maxSends === autosend.MAX_SENDS_CEILING,
      'an oversized count is clamped to the ceiling (' + greedy.state.maxSends + ')');
    check(greedy.state.expiresAt === autosend.MAX_TTL_MS,
      'and an oversized lifetime to the ceiling (' +
      (greedy.state.expiresAt / DAY) + ' days)');

    const tiny = autosend.arm(autosend.createAutoSendState(),
      { binding: BINDING, ttlMs: 0, maxSends: -5 }, PHRASE, true, 0);
    check(tiny.state.maxSends === 1000 && tiny.state.expiresAt === 7 * DAY,
      'nonsense values fall back to the defaults, not to zero');

    const small = autosend.arm(autosend.createAutoSendState(),
      { binding: BINDING, ttlMs: 60000, maxSends: 3 }, PHRASE, true, 0);
    check(small.state.maxSends === 3 && small.state.expiresAt === 60000,
      'a smaller explicit request is honoured exactly');

    // An existing grant must not widen just because the default moved.
    const existing = { version: 1, enabled: true, armedAt: 0, expiresAt: 1_000_000,
      maxSends: 20, sentCount: 4, journal: {}, bindingRevision: 3,
      conversationId: CONV, documentInstanceId: 'instance-abcdefghijkl',
      lastError: null };
    const reconciled = autosend.reconcileAfterRestart(existing, 500_000);
    check(reconciled.state.maxSends === 20,
      'an older 20-notice grant keeps its 20 (no silent widening)');
    check(reconciled.state.expiresAt === 1_000_000,
      'and its original expiry');
  }

  // ---------------------------------- 2. T059 defaults, bounds, hourly ceiling
  console.log('== T068: T059 defaults to 30s / 100 per hour ==');
  {
    const made = trigger.configure(trigger.createTriggerState(),
      { binding: BINDING }, TRIGGER_PHRASE, true, 0);
    check(made.result.ok === true, 'a default configure succeeds');
    check(made.state.minIntervalMs === 30000,
      'and sets a 30s minimum interval (' + made.state.minIntervalMs + ')');
    check(made.state.maxPerHour === 100,
      'and 100 per hour (' + made.state.maxPerHour + ')');
    check(trigger.DEFAULT_MAX_PER_HOUR === 100 && trigger.MAX_PER_HOUR_CEILING === 100,
      'both the default and the ceiling are 100');
    check(trigger.DEFAULT_MIN_INTERVAL_MS === 30000, 'the interval default is 30s');

    const floor = trigger.configure(trigger.createTriggerState(),
      { binding: BINDING, minIntervalMs: 1 }, TRIGGER_PHRASE, true, 0);
    check(floor.state.minIntervalMs === trigger.MIN_INTERVAL_FLOOR_MS,
      'a sub-30s interval is raised to the floor');
    const ceiling = trigger.configure(trigger.createTriggerState(),
      { binding: BINDING, minIntervalMs: 10 * 3600000 },
      TRIGGER_PHRASE, true, 0);
    check(ceiling.state.minIntervalMs === trigger.MAX_INTERVAL_CEILING_MS,
      'and an absurd interval is capped (' + ceiling.state.minIntervalMs + ')');
    const perHour = trigger.configure(trigger.createTriggerState(),
      { binding: BINDING, maxPerHour: 9999 }, TRIGGER_PHRASE, true, 0);
    check(perHour.state.maxPerHour === 100,
      'a greedy hourly count is capped at 100 (' + perHour.state.maxPerHour + ')');

    // 100 in one window, then refused -- and this is independent of the 1000 budget.
    let state = trigger.configure(trigger.createTriggerState(),
      { binding: BINDING }, TRIGGER_PHRASE, true, 0).state;
    let admitted = 0;
    let refusedCode = null;
    // 30.5s spacing keeps all 101 attempts inside the single 60-minute window,
    // so the refusal can only come from the count and not from a rollover.
    let t = 0;
    for (let i = 0; i < 104; i += 1) {
      const runId = 'cccccccc-cccc-4ccc-8ccc-' + String(i).padStart(12, '0');
      // T067: `origin: 'bridge'` because this block measures the hourly ceiling, not
      // the channel gate. A direct run would be refused before it consumed a slot.
      const verdict = trigger.admit(state, { runId, status: 'completed', origin: 'bridge' }, t);
      if (verdict.admit) {
        admitted += 1;
        state = trigger.settle(trigger.markAttempt(state, { runId,
          status: 'completed', origin: 'bridge' }, t).state, verdict.key,
        { sent: true }, t).state;
      } else if (refusedCode === null) {
        refusedCode = verdict.code;
      }
      t += 30500;                 // just past the 30s interval, still in-window
    }
    check(admitted === 100,
      'exactly 100 writes fit in one window despite 104 attempts (' + admitted + ')');
    check(refusedCode === 'rate_window_exceeded',
      'and the 101st is refused by the hourly window (' + refusedCode + ')');

    // The 30s pacing is independent of the hourly count: a burst inside 30s stops
    // on the interval, not on the window, so the two limits cannot mask each other.
    let paced = trigger.configure(trigger.createTriggerState(),
      { binding: BINDING }, TRIGGER_PHRASE, true, 0).state;
    const first = trigger.admit(paced,
      { runId: 'dddddddd-dddd-4ddd-8ddd-000000000001', status: 'completed' , origin: 'bridge'}, 5_000_000);
    paced = trigger.settle(trigger.markAttempt(paced,
      { runId: 'dddddddd-dddd-4ddd-8ddd-000000000001', status: 'completed' , origin: 'bridge'},
      5_000_000).state, first.key, { sent: true }, 5_000_000).state;
    const tooSoon = trigger.admit(paced,
      { runId: 'dddddddd-dddd-4ddd-8ddd-000000000002', status: 'completed' , origin: 'bridge'}, 5_020_000);
    check(tooSoon.admit === false && tooSoon.code === 'rate_limited',
      'a second notice 20s later is paced out, not counted (' + tooSoon.code + ')');
    check(tooSoon.waitMs === 10000, 'and says how long to wait (' + tooSoon.waitMs + 'ms)');
    check(paced.windowCount === 1,
      'without consuming window budget (' + paced.windowCount + ')');

    // runId dedupe is untouched.
    const dedupe = trigger.admit(state,
      { runId: 'cccccccc-cccc-4ccc-8ccc-000000000000', status: 'completed' , origin: 'bridge'},
      2_000_000);
    check(dedupe.admit === false && dedupe.code === 'duplicate_event',
      'the same runId|status stays refused as a duplicate (' + dedupe.code + ')');
    const duplicateRun = trigger.admit(state,
      { runId: 'cccccccc-cccc-4ccc-8ccc-000000000000', status: 'failed' , origin: 'bridge'},
      2_000_000);
    check(duplicateRun.admit === false && duplicateRun.code === 'duplicate_run',
      'and the same run with another status is refused too');

    // An existing 20/hour grant must not widen on its own.
    const old = trigger.configure(trigger.createTriggerState(),
      { binding: BINDING, maxPerHour: 20 }, TRIGGER_PHRASE, true, 0).state;
    check(old.maxPerHour === 20,
      'a re-armed explicit 20 stays 20 until the operator re-arms (' + old.maxPerHour + ')');
    const untouched = Object.assign({}, old, { enabled: false });
    const reconciled = trigger.reconcileAfterRestart(untouched, 1_000_000);
    check(reconciled.state.maxPerHour === 20,
      'and a plain reconcile never raises it to 100 (' + reconciled.state.maxPerHour + ')');
  }

  // ------------------------------------------- 3. authorization status corners
  console.log('== T068: expiry and exhaustion still stop the send ==');
  {
    const probe = { ok: true, tabId: 11, windowId: 4, url: BINDING.url,
      conversationId: CONV, documentInstanceId: 'instance-abcdefghijkl',
      composerPresent: true, composerEmpty: true, hasFocus: true, active: true,
      visibilityState: 'visible', discarded: false, frozen: false,
      observedAt: 9_999_000 };
    const armed = autosend.arm(autosend.createAutoSendState(),
      { binding: BINDING }, PHRASE, true, 1_000_000).state;
    const expired = autosend.decide(armed,
      { binding: BINDING, probe, runId: 'r-1', status: 'completed' },
      1_000_000 + 7 * DAY);
    check(expired.send === false && expired.code === 'authorization_expired',
      'on the 7th day the grant is expired, not renewed (' + expired.code + ')');

    const used = Object.assign({}, armed, { sentCount: 1000 });
    const drained = autosend.decide(used,
      { binding: BINDING, probe, runId: 'r-2', status: 'completed' },
      2_000_000);
    check(drained.send === false && drained.code === 'authorization_exhausted',
      'and after 1000 notices it is exhausted (' + drained.code + ')');
  }

  // ------------------------------------- 4. the real alarm period is 0.5 minutes
  console.log('== T068: a 30s interval actually schedules a 0.5-minute alarm ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't068-a-'));
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    const hostRef = { current: h };
    const chromeMock = createChrome(hostRef);
    globalThis.chrome = chromeMock.api;
    try {
      chromeMock.session.set('t053TargetBindingState',
        { version: 1, revision: 3, binding: BINDING, candidates: [],
          candidateScannedAt: null });
      const bg = await mod('./extension/background.js?reload=t068a');

      const armed = await chromeMock.dispatch({ type: 't059-trigger-arm',
        userGesture: true, confirmation: TRIGGER_PHRASE });
      check(armed && armed.result && armed.result.ok === true,
        'the trigger arms with the default limits');
      check(armed.result.minIntervalMs === 30000 && armed.result.maxPerHour === 100,
        'and reports 30s / 100 per hour (' + armed.result.minIntervalMs + '/'
        + armed.result.maxPerHour + ')');

      // The decisive assertion: the old `Math.max(1, ceil(...))` produced 1 here.
      const created = chromeMock.createCalls
        .filter((call) => call.name === 'dsh-terminal-trigger');
      check(created.length === 1, 'one terminal alarm was created (' +
        created.length + ')');
      check(created[0].info.periodInMinutes === 0.5,
        'with periodInMinutes 0.5, not 1 (' +
        JSON.stringify(created[0].info.periodInMinutes) + ')');

      const state = await chromeMock.dispatch({ type: 't059-trigger-state' });
      check(state.alarm === 0.5,
        'and the popup is told the same 0.5 (' + state.alarm + ')');

      // Re-syncing must not reset the timer.
      const again = await bg.syncTerminalAlarm();
      check(again.periodInMinutes === 0.5 && again.currentPeriod === 0.5,
        'a second sync keeps 0.5 and does not recreate it (' +
        chromeMock.createCalls.length + ' creates)');
      check(chromeMock.createCalls.length === 1,
        'so the alarm timer is not reset every tick (' +
        chromeMock.createCalls.length + ')');

      // A longer interval still scales, and disabling clears the alarm.
      chromeMock.local.set('terminalTrigger',
        Object.assign({}, chromeMock.local.get('terminalTrigger'),
          { minIntervalMs: 300000 }));
      const slow = await bg.syncTerminalAlarm();
      check(slow.periodInMinutes === 5, 'a 5-minute interval gives 5 minutes (' +
        slow.periodInMinutes + ')');
      chromeMock.local.set('terminalTrigger',
        Object.assign({}, chromeMock.local.get('terminalTrigger'),
          { minIntervalMs: 1000 }));
      const floored = await bg.syncTerminalAlarm();
      check(floored.periodInMinutes === 0.5,
        'and anything faster is floored at 0.5 (' + floored.periodInMinutes + ')');
      chromeMock.local.set('terminalTrigger',
        Object.assign({}, chromeMock.local.get('terminalTrigger'),
          { minIntervalMs: 10 * 3600000 }));
      const silly = await bg.syncTerminalAlarm();
      check(silly.periodInMinutes === 60,
        'an absurd interval caps the alarm at 60 minutes (' + silly.periodInMinutes + ')');

      await chromeMock.dispatch({ type: 't059-trigger-disable' });
      check(!chromeMock.alarms.has('dsh-terminal-trigger'),
        'disabling clears the alarm');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // ------------------- 5. history isolation and restarts under the new defaults
  console.log('== T068: the new limits do not open a path to old candidates ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't068-b-'));
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    const hostRef = { current: h };
    const chromeMock = createChrome(hostRef);
    globalThis.chrome = chromeMock.api;
    try {
      chromeMock.local.set('terminalCandidates',
        [{ runId: OLD_RUN, status: 'completed' , origin: 'bridge'}]);
      chromeMock.session.set('t053TargetBindingState',
        { version: 1, revision: 3, binding: BINDING, candidates: [],
          candidateScannedAt: null });
      const bg = await mod('./extension/background.js?reload=t068b');
      const sendOnce = async (candidate) => {
        chromeMock.local.set('writeProbe',
          (chromeMock.local.get('writeProbe') || []).concat([candidate.runId]));
        return { sent: true, status: 'submitted', evidence: { receipt: 'stub' } };
      };
      const writes = () => chromeMock.local.get('writeProbe') || [];

      await chromeMock.dispatch({ type: 't059-trigger-arm',
        userGesture: true, confirmation: TRIGGER_PHRASE });
      const tick = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(tick.fetched && tick.fetched.ok === true, 'the first tick polls');
      check(tick.fetched.baselineEstablished === true,
        'and is still the tick that establishes the baseline');
      check(writes().length === 0, 'the history is not written (' +
        writes().length + ')');
      check(tick.results.some((r) => r.code === 'pre_arm_candidate'),
        'and is still labelled pre-arm');
      check((chromeMock.local.get('terminalCandidates') || []).length === 1,
        'and is still kept for review');

      // With 20/hour, one new completion still goes through.
      writeRuns(ledgerRoot, [{ id: NEW_RUN, status: 'completed' }]);
      const second = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(writes().length === 1 && writes()[0] === NEW_RUN,
        'a new completion is written once (' + JSON.stringify(writes()) + ')');
      check(second.results.some((r) => r.sent === true), 'and settles as sent');

      // Disconnect, then restart the worker: nothing is invented, nothing lost.
      h.stop();
      await new Promise((r) => setTimeout(r, 150));
      const dead = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(dead.fetched && dead.fetched.ok === false,
        'a dead host fails the tick without writing (' + JSON.stringify(
          dead.fetched && dead.fetched.code) + ')');
      check(writes().length === 1, 'and no extra write happens');
      const rec = chromeMock.local.get('terminalChainStatus');
      check(rec && rec.ok === false && rec.added === null,
        'the poll record says failed, with no invented counts');

      const h2 = startHost(join(dir, 'host'), ledgerRoot);
      hostRef.current = h2;
      const revived = await mod('./extension/background.js?reload=t068b2');
      const afterRestart = await revived.runTerminalTrigger({ limit: 3, sendOnce });
      check(afterRestart.fetched && afterRestart.fetched.ok === true,
        'the tick recovers after the host returns');
      check(writes().length === 1,
        'and the already-sent run is not written again (' + writes().length + ')');
      check(afterRestart.results.some((r) => r.code === 'pre_arm_candidate'),
        'the history is still pre-arm after a restart');
      h2.stop();
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // ------------------------------------------- 6. the popup shows real numbers
  console.log('== T068: the popup reports the effective numbers ==');
  {
    const src = readFileSync(new URL('./extension/popup.js', ROOT), 'utf8');
    check(/剩余 ' \+ remaining \+ ' 条/.test(src),
      'T058 shows how many notices are left, not only the total');
    check(/下次人工授权默认：最多 ' \+ defaults\.maxSends/.test(src),
      'T058 separates "this grant" from "next grant default"');
    check(/每小时上限：' \+ state\.maxPerHour \+ ' 条（独立限流）/.test(src),
      'T059 marks the hourly cap as an independent limit');
    check(/调度周期：每 ' \+ alarm \+ ' 分钟检查一次/.test(src),
      'T059 shows the actual alarm period');
    check(/实际可能延后/.test(src), 'and warns that Chrome may delay it');
    check(/下次启用默认：间隔/.test(src), 'T059 shows the next-enable defaults');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
