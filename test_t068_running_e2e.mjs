// T068: end-to-end, against the real host and the real background.js.
//
// The unit suites prove the store's rules. This one proves the *product* does what
// those rules promise, by running the actual code paths an operator's click would:
//
//   real host subprocess  -> `terminal-running`, `terminal-list`
//   real background.js    -> readRunningState / armRunningOptIn / runTerminalTrigger
//   real native log       -> a compressed session.v4.jsonl.zstd with turn/start,
//                            in-turn activity, and later a turn/end
//
// Only Chrome is mocked, and the page write is a declared stub that records the
// message it would have sent. Nothing here opens a tab or reaches ChatGPT.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const ORIGIN = 'chrome-extension://t068-run-e2e/';
const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);

const CONV = '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071';
const BRIDGE_RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BRIDGE_SESSION = 'session-dddddddd-0000-4000-8000-000000000069';
const DIRECT_SESSION = 'session-11111111-2222-4333-8444-555555555555';
const WORKSPACE = '--E-ApkTest--';
const HOUR = 60 * 60 * 1000;

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// ------------------------------------------------------------- native log writer
function rec(kind, seq, timeMs, data) {
  return JSON.stringify({ type: kind, seq, time: timeMs, data });
}
function writeNativeLog(nativeRoot, session, records) {
  const dir = join(nativeRoot, WORKSPACE, session);
  mkdirSync(dir, { recursive: true });
  const body = Buffer.from(records.join('\n') + '\n', 'utf8');
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(body));
}
function turnStart(turn, t) { return rec('turn/start', turn * 10, t, { turn }); }
function turnEnd(turn, t, reason) {
  return rec('turn/end', turn * 10 + 1, t, {
    turn, reason: reason || { kind: 'completed' } });
}
function activity(turn, t) {
  return rec('tool/call', turn * 10 + 2, t, { turn, payload: {} });
}

// ------------------------------------------------------------- real host driver
function startHost(stateDir, ledgerRoot) {
  if (!ledgerRoot) throw new Error('startHost needs a temporary ledgerRoot');
  const cwd = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1');
  const manifestPath = join(stateDir, 'host_manifest.e2e.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN],
  }, null, 2), 'utf8');
  // Explicitly *not* `bridge: '*'`: only the run this suite names is Bridge-dispatched,
  // so every other turn in the native log is channel B by construction.
  const fixturePath = join(stateDir, 'bridge-origin.fixture.json');
  writeFileSync(fixturePath, JSON.stringify({
    version: 1, bridge: [BRIDGE_RUN] }), 'utf8');
  const nativeRoot = join(stateDir, 'native-sessions');
  mkdirSync(nativeRoot, { recursive: true });
  const child = spawn(process.env.PYTHON || 'python',
    ['-B', 'host.py', ORIGIN, '--state-dir', stateDir,
      '--ledger-root', ledgerRoot, '--manifest', manifestPath,
      '--bridge-db-fixture', fixturePath,
      '--native-root', nativeRoot],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  const waiters = new Map();
  const portListeners = [];
  const discListeners = new Set();
  let nextId = 0;
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
      const waiter = waiters.get(doc.id);
      if (waiter) { waiters.delete(doc.id); waiter(doc); }
    }
  });
  function frame(doc) {
    const body = Buffer.from(JSON.stringify(doc), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    return Buffer.concat([head, body]);
  }
  return {
    async send(op, args) {
      const id = 'probe-' + (nextId += 1);
      const answer = new Promise((r) => waiters.set(id, r));
      try { child.stdin.write(frame({ v: 1, id, op, args: args || {} })); }
      catch (_e) { return null; }
      return Promise.race([answer, new Promise((_r, reject) => setTimeout(
        () => reject(new Error('host timeout ' + op + ' ' + stderr)), 20000))]);
    },
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
        onDisconnect: {
          addListener(fn) {
            listener = fn;
            discListeners.add(fire);
            if (dead) setTimeout(fire, 0);
          },
        },
        postMessage(doc) {
          if (dead) { setTimeout(fire, 0); return; }
          try { child.stdin.write(frame(doc)); } catch (_e) { setTimeout(fire, 0); }
        },
      };
    },
    stop() { try { child.kill(); } catch (_e) { /* gone */ } },
    nativeRoot,
  };
}

function writeRuns(ledgerRoot, runs) {
  const dir = join(ledgerRoot, 'a'.repeat(64));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'endpoint.json.runs.json'), JSON.stringify(
    runs.map((run, index) => ({ requestID: run.id, status: run.status,
      sessionID: run.sessionID, turn: run.turn,
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
  const messageListeners = [];
  const writeCalls = [];
  const writeReply = { ok: true, result: { sent: true, status: 'submitted',
    evidence: { receipt: 'stub' } } };
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
      async sendMessage(_tabId, msg) {
        writeCalls.push(clone(msg));
        return clone(writeReply);
      },
    }),
    windows: shield({ async get() { return null; } }),
    alarms: shield({ async get() { return null; }, async clear() {}, create() {} }),
    action: shield({ async setBadgeText() {} }),
    scripting: shield({ async executeScript() { return []; } }),
  });
  return {
    api, local, session, writeCalls,
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

function newWorld(tag) {
  const dir = mkdtempSync(join(tmpdir(), 't068e2e-' + tag + '-'));
  const ledgerRoot = join(dir, 'agents');
  writeRuns(ledgerRoot, []);
  const h = startHost(join(dir, 'host'), ledgerRoot);
  const hostRef = { current: h };
  const chromeMock = createChrome(hostRef);
  globalThis.chrome = chromeMock.api;
  return { dir, ledgerRoot, h, chromeMock };
}

function seedBinding(chromeMock) {
  const BINDING = {
    tabId: 11, windowId: 4, revision: 3, url: 'https://chatgpt.com/c/' + CONV,
    conversationId: CONV, documentInstanceId: 'instance-abcdefghijkl',
    manuallyConfirmed: true, invalidatedReason: null,
  };
  chromeMock.session.set('t053TargetBindingState',
    { version: 1, revision: 3, binding: BINDING, candidates: [],
      candidateScannedAt: null });
}

// The declared page write: records what would have been written, touches nothing.
function stubSender(chromeMock) {
  return async (candidate) => {
    chromeMock.writeCalls.push({ runId: candidate.runId,
      status: candidate.status });
    return { sent: true, status: 'submitted', evidence: { receipt: 'stub' } };
  };
}

async function armTrigger(chromeMock) {
  return chromeMock.dispatch({ type: 't059-trigger-arm',
    minIntervalMs: 30000, maxPerHour: 6, userGesture: true,
    confirmation: 'AUTOTRIGGER ' + CONV });
}

let reload = 0;
const load = () => mod('./extension/background.js?r=t068e2e' + (reload += 1));

async function main() {
  // ------------------------------------------------ 1. a running turn is offered
  console.log('== T068: a running direct turn is listed before it ends ==');
  {
    const w = newWorld('a');
    try {
      const log = w.h.nativeRoot;
      writeNativeLog(log, DIRECT_SESSION, [
        turnStart(7, Date.now() - 60_000), activity(7, Date.now() - 1000),
      ]);
      const direct = await w.h.send('terminal-running');
      check(direct && direct.ok === true, 'the host answers terminal-running');
      check(direct.result && direct.result.ok === true,
        'and reports the source as readable');
      check(direct.result && direct.result.runningCount === 1,
        'one running turn is offered (' + (direct.result || {}).runningCount + ')');
      const row = (direct.result.running || [])[0] || {};
      check(row.origin === 'direct', 'and it is channel B, not the Bridge');
      check(row.turn === 7 && row.sessionId === DIRECT_SESSION,
        'identified by its own (session, turn)');
      check(typeof row.runId === 'string'
        && /^[0-9a-f-]{36}$/i.test(row.runId),
        'with a derived, stable id (' + row.runId + ')');
      check(direct.result.bridgeRunning === 0,
        'nothing was excluded as Bridge-dispatched');

      // The running list is not a candidate list: nothing may be sendable yet.
      check(Array.isArray(direct.result.running)
        && !('candidates' in direct.result),
        'the running report carries no candidates at all');
    } finally { w.h.stop(); }
  }

  // ------------------------------------- 2. Bridge-dispatched running is excluded
  console.log('== T068: a running turn the Bridge dispatched is not offered ==');
  {
    const w = newWorld('b');
    try {
      writeNativeLog(w.h.nativeRoot, BRIDGE_SESSION, [
        turnStart(133, Date.now() - 60_000), activity(133, Date.now() - 1000),
      ]);
      writeRuns(w.ledgerRoot, [{ id: BRIDGE_RUN, status: 'running',
        sessionID: BRIDGE_SESSION, turn: 133 }]);
      const direct = await w.h.send('terminal-running');
      check(direct.result.runningCount === 0,
        'it is not offered for opt-in (' + direct.result.runningCount + ')');
      check(direct.result.bridgeRunning === 1,
        'and is counted as the Bridge\'s own');
    } finally { w.h.stop(); }
  }

  // ------------------------------------------------ 3. opt-in / opt-out via popup
  console.log('== T068: the popup can opt in and back out while it runs ==');
  {
    const w = newWorld('c');
    try {
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 60_000), activity(7, Date.now() - 1000),
      ]);
      seedBinding(w.chromeMock);
      const bg = await load();

      const before = await bg.readRunningState();
      check(before.ok === true && before.rows.length === 1,
        'the popup sees one running task');
      check(before.rows[0].optedIn === false, 'default is NOT opted in');
      check(before.nothingRunning === false, 'and it does not claim "nothing running"');

      const armed = await bg.armRunningOptIn(DIRECT_SESSION, 7);
      check(armed.ok === true, 'the click records the decision (' + armed.code + ')');
      check(armed.triggerEnabled === false,
        'and says the trigger is not armed, so nothing will be sent yet');

      const after = await bg.readRunningState();
      check(after.rows[0].optedIn === true, 'the row now shows as chosen');
      check(after.counts.optedIn === 1, 'the count agrees');

      const revoked = await bg.revokeRunningOptIn(DIRECT_SESSION, 7);
      check(revoked.ok === true, 'the choice can be taken back');
      const back = await bg.readRunningState();
      check(back.rows[0].optedIn === false, 'and the row shows it is off again');

      // The message boundary: a content script must not reach these.
      const denied = await w.chromeMock.dispatch({ type: 't068-running-optin',
        sessionId: DIRECT_SESSION, turn: 7, userGesture: true },
        { id: 'test-extension', url: 'chrome-extension://t/content.js', tab: {} });
      check(denied && denied.error === 'extension_popup_required',
        'a content script cannot opt a task in (' + (denied || {}).error + ')');

      const noGesture = await w.chromeMock.dispatch({ type: 't068-running-optin',
        sessionId: DIRECT_SESSION, turn: 7, userGesture: false });
      check(noGesture.result && noGesture.result.code === 'operator_gesture_required',
        'and a message without a real click is refused');
    } finally { w.h.stop(); }
  }

  // ------------------------------------ 4. default off: ends, still not sent
  console.log('== T068: a direct task that was never opted in is not notified ==');
  {
    const w = newWorld('d');
    try {
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 60_000), activity(7, Date.now() - 1000),
      ]);
      seedBinding(w.chromeMock);
      const bg = await load();
      await armTrigger(w.chromeMock);
      const sendOnce = stubSender(w.chromeMock);
      // Baseline first, so the completion below is genuinely post-arm.
      await bg.runTerminalTrigger({ limit: 3, sendOnce });
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 120_000), activity(7, Date.now() - 1000),
        turnEnd(7, Date.now()),
      ]);
      const tick = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(tick.fetched.ok === true, 'the poll succeeds');
      check(w.chromeMock.writeCalls.length === 0,
        'and nothing is written (' + w.chromeMock.writeCalls.length + ' writes)');
      const codes = tick.results.map((r) => r.code);
      check(codes.includes('direct_not_opted_in'),
        'the refusal is named: ' + JSON.stringify(codes));
    } finally { w.h.stop(); }
  }

  // --------------------------- 5. the real thing: opt in while running, then it ends
  console.log('== T068: opted in while running -> notified when it actually ends ==');
  {
    const w = newWorld('e');
    try {
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 60_000), activity(7, Date.now() - 1000),
      ]);
      seedBinding(w.chromeMock);
      const bg = await load();
      await armTrigger(w.chromeMock);
      const sendOnce = stubSender(w.chromeMock);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });   // baseline

      const armed = await bg.armRunningOptIn(DIRECT_SESSION, 7);
      check(armed.ok === true, 'opted in while it was still running');
      check(w.chromeMock.writeCalls.length === 0,
        'and that click alone wrote nothing to the page');

      // Now it ends. The end must be strictly *after* the click: T069 compares the two
      // instants in milliseconds and refuses the same millisecond, and a fixture that
      // writes `turnEnd(7, Date.now())` right after `armRunningOptIn` lands in that same
      // millisecond often enough to make this scenario flaky (observed: click .181,
      // end .182 passes; click and end both .853 is refused). The product is right --
      // there is no ordering to prove at one instant -- so the fixture states the
      // ordering it means to test.
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 120_000), activity(7, Date.now() - 1000),
        turnEnd(7, Date.now() + 5000),
      ]);
      const tick = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(w.chromeMock.writeCalls.length === 1,
        'exactly one write once it ended (' + w.chromeMock.writeCalls.length + ')');
      check(w.chromeMock.writeCalls[0] && w.chromeMock.writeCalls[0].status
        === 'completed', 'and the status is the real one, completed');

      const journal = Object.values((tick.state && tick.state.seen) || {});
      check(journal.length === 1 && journal[0].state === 'sent',
        'the attempt is journalled as sent');
      check(journal.length === 1 && journal[0].origin === 'direct',
        'with channel B recorded');
      check(journal.length === 1 && journal[0].consent === 'running_opt_in',
        'and the running opt-in named as what authorised it');

      const stores = w.chromeMock.local.get('terminalOptIns');
      const entries = Object.values((stores && stores.entries) || {});
      check(entries.length === 1 && Number.isFinite(entries[0].consumedAt),
        'the opt-in is spent, so it cannot authorise a second notice');

      // A second tick must not repeat it.
      await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(w.chromeMock.writeCalls.length === 1,
        'a further tick writes nothing new (' + w.chromeMock.writeCalls.length + ')');
    } finally { w.h.stop(); }
  }

  // --------------------------------------------- 6. a long task keeps its choice
  console.log('== T068: a six-hour task keeps the choice made in its first minutes ==');
  {
    const w = newWorld('f');
    try {
      // The decision was taken six hours ago; the task ended a minute ago.
      const sixHoursAgo = Date.now() - 6 * HOUR;
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, sixHoursAgo - 60_000),
        activity(7, sixHoursAgo + 1000),
        activity(7, Date.now() - 120_000),
        turnEnd(7, Date.now() - 60_000),
      ]);
      // A pre-existing opt-in from six hours ago, exactly as the store would hold it.
      w.chromeMock.local.set('terminalOptIns', {
        version: 1,
        entries: {
          [DIRECT_SESSION + '|7']: {
            sessionId: DIRECT_SESSION, turn: 7, armedAt: sixHoursAgo,
            consumedAt: null, settledAs: null, source: 'popup',
          },
        },
      });
      const optIns = w.chromeMock.local.get('terminalOptIns');
      check(Object.values(optIns.entries)[0].armedAt === sixHoursAgo,
        'the opt-in is six hours old, far beyond the 30-minute candidate TTL');

      seedBinding(w.chromeMock);
      const bg = await load();
      await armTrigger(w.chromeMock);
      const sendOnce = stubSender(w.chromeMock);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });   // baseline
      const tick = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(w.chromeMock.writeCalls.length === 1,
        'it is still notified (' + w.chromeMock.writeCalls.length + ' writes)');
      const journal = Object.values((tick.state && tick.state.seen) || {});
      check(journal.length === 1 && journal[0].consent === 'running_opt_in',
        'authorised by the old running opt-in (' + JSON.stringify(
          journal.map((j) => j.consent)) + ')');
    } finally { w.h.stop(); }
  }

  // ------------------------------------------------ 7. channel A is untouched
  console.log('== T068: a Bridge-dispatched run still notifies with no click ==');
  {
    const w = newWorld('g');
    try {
      seedBinding(w.chromeMock);
      writeRuns(w.ledgerRoot, []);
      const bg = await load();
      await armTrigger(w.chromeMock);
      const sendOnce = stubSender(w.chromeMock);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });   // baseline
      writeRuns(w.ledgerRoot, [{ id: BRIDGE_RUN, status: 'completed',
        sessionID: BRIDGE_SESSION, turn: 133 }]);
      const tick = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(w.chromeMock.writeCalls.length === 1,
        'it is written once, unattended (' + w.chromeMock.writeCalls.length + ')');
      const journal = Object.values((tick.state && tick.state.seen) || {});
      check(journal.length === 1 && journal[0].origin === 'bridge',
        'and journalled as channel A');
      check(journal.length === 1 && journal[0].consent === 'none',
        'no opt-in was involved');
    } finally { w.h.stop(); }
  }

  // ------------------------------------------------------- 8. failed / cancelled
  console.log('== T068: a failed direct task says failed, not cancelled ==');
  {
    const w = newWorld('h');
    try {
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 60_000), activity(7, Date.now() - 1000),
      ]);
      seedBinding(w.chromeMock);
      const bg = await load();
      await armTrigger(w.chromeMock);
      const sendOnce = stubSender(w.chromeMock);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });   // baseline
      await bg.armRunningOptIn(DIRECT_SESSION, 7);
      // A provider error, not a cancellation. The end is deliberately after the click:
      // see the note in the previous scenario about same-millisecond refusals.
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 120_000), activity(7, Date.now() - 1000),
        turnEnd(7, Date.now() + 5000, { kind: 'error',
          error: { message: 'upstream 400', code: 'INVALID_REQUEST' } }),
      ]);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(w.chromeMock.writeCalls.length === 1,
        'it is notified once (' + w.chromeMock.writeCalls.length + ')');
      check(w.chromeMock.writeCalls[0]
        && w.chromeMock.writeCalls[0].status === 'failed',
        'and the status is failed, not cancelled ('
        + ((w.chromeMock.writeCalls[0] || {}).status) + ')');
    } finally { w.h.stop(); }
  }

  // ------------------------------------ 9. a human stopping the turn is `cancelled`
  console.log('== T068: a turn the person aborted is reported as cancelled ==');
  {
    const w = newWorld('i');
    try {
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 60_000), activity(7, Date.now() - 1000),
      ]);
      seedBinding(w.chromeMock);
      const bg = await load();
      await armTrigger(w.chromeMock);
      const sendOnce = stubSender(w.chromeMock);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });   // baseline
      await bg.armRunningOptIn(DIRECT_SESSION, 7);
      // Again the end is after the click, so the ordering being tested is unambiguous.
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 120_000), activity(7, Date.now() - 1000),
        turnEnd(7, Date.now() + 5000, { kind: 'aborted', reason: { kind: 'user' } }),
      ]);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(w.chromeMock.writeCalls.length === 1, 'it is notified once');
      check(w.chromeMock.writeCalls[0]
        && w.chromeMock.writeCalls[0].status === 'cancelled',
        'and the status is cancelled ('
        + ((w.chromeMock.writeCalls[0] || {}).status) + ')');
    } finally { w.h.stop(); }
  }

  // ---------------------------------------- 10. opt-out is honoured at the end
  console.log('== T068: revoking before the end means it is never notified ==');
  {
    const w = newWorld('j');
    try {
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 60_000), activity(7, Date.now() - 1000),
      ]);
      seedBinding(w.chromeMock);
      const bg = await load();
      await armTrigger(w.chromeMock);
      const sendOnce = stubSender(w.chromeMock);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });   // baseline
      await bg.armRunningOptIn(DIRECT_SESSION, 7);
      await bg.revokeRunningOptIn(DIRECT_SESSION, 7);
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 120_000), activity(7, Date.now() - 1000),
        turnEnd(7, Date.now()),
      ]);
      const tick = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(w.chromeMock.writeCalls.length === 0,
        'nothing is written after the opt-out (' + w.chromeMock.writeCalls.length + ')');
      check(tick.results.map((r) => r.code).includes('direct_not_opted_in'),
        'and the refusal is named');
    } finally { w.h.stop(); }
  }

  // ---------------------------------------- 11. a stale click cannot back-date
  console.log('== T068: an opt-in recorded after the end authorises nothing ==');
  {
    const w = newWorld('k');
    try {
      // The task ended at `endedAt`; the opt-in claims a later instant.
      const endedAt = Date.now() - 10 * 60_000;
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, endedAt - 60_000), activity(7, endedAt - 1000),
        turnEnd(7, endedAt),
      ]);
      w.chromeMock.local.set('terminalOptIns', {
        version: 1,
        entries: {
          [DIRECT_SESSION + '|7']: {
            sessionId: DIRECT_SESSION, turn: 7, armedAt: Date.now(),
            consumedAt: null, settledAs: null, source: 'popup',
          },
        },
      });
      seedBinding(w.chromeMock);
      const bg = await load();
      await armTrigger(w.chromeMock);
      const sendOnce = stubSender(w.chromeMock);
      await bg.runTerminalTrigger({ limit: 3, sendOnce });   // baseline
      const tick = await bg.runTerminalTrigger({ limit: 3, sendOnce });
      check(w.chromeMock.writeCalls.length === 0,
        'no notice is written for a click made after the end ('
        + w.chromeMock.writeCalls.length + ')');
      const codes = tick.results.map((r) => r.code);
      // T069: the refusal is now specific. The click exists, so "nobody asked"
      // (`direct_not_opted_in`) would be a false statement -- the click was made, it
      // was just made after the task had already finished.
      check(codes.includes('opt_in_after_terminal'),
        'the stale opt-in is refused as too late: ' + JSON.stringify(codes));
      check(!codes.includes('direct_not_opted_in'),
        'and not reported as "nobody ever asked": ' + JSON.stringify(codes));
    } finally { w.h.stop(); }
  }

  // ------------------------------------------------- 12. unreadable source: fail closed
  console.log('== T068: with no readable evidence, nothing is offered ==');
  {
    const w = newWorld('l');
    try {
      seedBinding(w.chromeMock);
      const bg = await load();
      const empty = await bg.readRunningState();
      check(empty.ok === false, 'an empty session directory is not "readable"');
      check(empty.rows.length === 0, 'and offers nothing');
      check(empty.nothingRunning === false,
        'it does not claim "nothing is running" when it could not look');
      check(String(empty.code).length > 0, 'the reason is named: ' + empty.code);
      check(empty.error !== null, 'and there is an error string to show');

      // A turn on disk, but the ledger gone: channel A cannot be excluded.
      writeNativeLog(w.h.nativeRoot, DIRECT_SESSION, [
        turnStart(7, Date.now() - 60_000), activity(7, Date.now() - 1000),
      ]);
      const good = await bg.readRunningState();
      check(good.ok === true && good.rows.length === 1,
        'with the log present it reads again');
    } finally { w.h.stop(); }
  }

  console.log('');
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('SUITE ERROR: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
