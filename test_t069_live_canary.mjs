// T069: the popup <-> background message interface, and the 100/hour limit.
//
// Why this file exists: T068 verified the limit *constants* by importing the library
// directly, and every assertion passed while the real extension was broken. The
// background referenced `autosend.DEFAULT_TTL_MS` without importing the module, so
// `t058-state` threw "autosend is not defined" and the popup showed a red read
// failure. A constants-only test cannot see that. Everything here goes through the
// actual `chrome.runtime.onMessage` handler, with a popup-shaped sender, so a
// missing import or a renamed field fails here instead of in the user's browser.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'chrome-extension://t069-e2e/';
const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
// T086: the arm boundary is proved from a run's creation time, so a fixture run must
// be created when it is written (i.e. after the arm), exactly like a real completion.
// arm is provably created after it; a fixed timestamp would prove nothing.
// (T086) `Date.now()` is used at the call site below, so a run written after the

const CONV = '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071';
const OLD_RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_RUN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ARM = 'AUTOSEND ' + CONV;
const TARM = 'AUTOTRIGGER ' + CONV;
const ALARM = 'dsh-terminal-trigger';

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
      try { const doc = JSON.parse(body); for (const fn of portListeners) fn(doc); }
      catch (_e) { /* partial frame */ }
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

const POPUP = { id: 'test-extension', url: 'chrome-extension://t/popup.html' };

function createChrome(hostRef) {
  const local = new Map();
  const session = new Map();
  const alarms = new Map();
  const createCalls = [];
  const messageListeners = [];
  const writeCalls = [];
  let writeReply = { ok: true, result: { sent: true, status: 'submitted',
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
      async sendMessage(tabId, msg) {
        writeCalls.push({ tabId, msg: clone(msg) });
        return clone(writeReply);
      },
    }),
    windows: shield({ async get() { return null; } }),
    alarms: shield({
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

  // Send a message the way Chrome does: through the registered listener, with the
  // handler deciding whether to answer synchronously or via sendResponse.
  function dispatch(msg, sender) {
    return new Promise((resolve) => {
      const fn = messageListeners[messageListeners.length - 1];
      if (!fn) { resolve({ __nohandler: true }); return; }
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      let ret;
      try {
        ret = fn(msg, sender || POPUP, done);
      } catch (err) {
        // A synchronous throw is exactly the shape of "autosend is not defined".
        done({ __threw: String(err && err.message ? err.message : err) });
        return;
      }
      if (ret !== true) done(undefined);
      // Guard against a handler that returns true but never answers.
      setTimeout(() => done({ __timeout: true }), 8000);
    });
  }

  return {
    api, local, session, alarms, createCalls, writeCalls, dispatch,
    setWriteReply(reply) { writeReply = reply; },
  };
}

async function main() {
  const BINDING = {
    tabId: 11, windowId: 4, revision: 3, url: 'https://chatgpt.com/c/' + CONV,
    conversationId: CONV, documentInstanceId: 'instance-abcdefghijkl',
    manuallyConfirmed: true, invalidatedReason: null,
  };

  // ----------------------- 1. the real popup interface answers without throwing
  console.log('== T069: t058-state / arm / disarm answer through runtime.onMessage ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't069-a-'));
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
      const bg = await mod('./extension/background.js?reload=t069a');

      // This is the call that used to throw ReferenceError.
      const st = await chromeMock.dispatch({ type: 't058-state' });
      check(st && st.__threw === undefined,
        't058-state does not throw (' + JSON.stringify(st && (st.__threw || 'ok')) + ')');
      check(st && st.ok === true,
        'and answers ok (' + JSON.stringify(st && st.error) + ')');
      check(st && st.result && st.result.enabled === false,
        'a fresh profile is unauthorized, not silently armed');
      check(st && st.defaults && st.defaults.maxSends === 1000,
        'and reports the 1000-notice default (' +
        JSON.stringify(st && st.defaults && st.defaults.maxSends) + ')');
      check(st.defaults.ttlDays === 7,
        'with a 7-day default (' + st.defaults.ttlDays + ')');
      check(st.defaults.maxSendsCeiling === 1000 && st.defaults.maxTtlMs === 30 * 86400000,
        'and the hard bounds the arm will clamp to');

      const armed = await chromeMock.dispatch({ type: 't058-arm',
        confirmation: ARM, userGesture: true });
      check(armed && armed.ok === true && armed.result.ok === true,
        't058-arm succeeds through the real handler (' +
        JSON.stringify(armed && armed.result && armed.result.code) + ')');
      check(armed.result.maxSends === 1000,
        'and grants 1000 notices (' + armed.result.maxSends + ')');
      const state = chromeMock.local.get('autosend');
      check(state && state.maxSends === 1000 && state.enabled === true,
        'which is persisted, not just returned');
      const days = (state.expiresAt - state.armedAt) / 86400000;
      check(Math.round(days * 100) / 100 === 7,
        'with a 7-day lifetime (' + days + ' days)');

      const off = await chromeMock.dispatch({ type: 't058-disarm' });
      check(off && off.ok === true && off.result.ok === true,
        't058-disarm succeeds (' + JSON.stringify(off && off.result && off.result.code) + ')');
      const stopped = chromeMock.local.get('autosend');
      check(stopped && stopped.enabled === false, 'and leaves it disarmed');

      // The popup-only guard must still hold.
      const wrong = await chromeMock.dispatch({ type: 't058-state' },
        { id: 'test-extension', url: 'chrome-extension://t/other.html' });
      check(wrong && wrong.ok === false && wrong.error === 'extension_popup_required',
        'a non-popup sender is still refused (' + JSON.stringify(wrong && wrong.error) + ')');
      const tabbed = await chromeMock.dispatch({ type: 't058-state' },
        Object.assign({ tab: { id: 1 } }, POPUP));
      check(tabbed && tabbed.ok === false,
        'and so is a content-script sender (' + JSON.stringify(tabbed && tabbed.error) + ')');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // ------------------------------- 2. T059 answers with 30s / 100 per hour
  console.log('== T069: t059 reports 30s / 100 per hour and a 0.5-minute alarm ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't069-b-'));
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
      const bg = await mod('./extension/background.js?reload=t069b');
      const armed = await chromeMock.dispatch({ type: 't059-trigger-arm',
        confirmation: TARM, userGesture: true });
      check(armed && armed.__threw === undefined && armed.result.ok === true,
        't059-trigger-arm succeeds (' +
        JSON.stringify(armed && (armed.__threw || armed.result.code)) + ')');
      check(armed.result.minIntervalMs === 30000,
        'the minimum interval stays 30s (' + armed.result.minIntervalMs + ')');
      check(armed.result.maxPerHour === 100,
        'and the hourly limit is 100 (' + armed.result.maxPerHour + ')');
      check(armed.preArm === 0, 'with an empty pre-arm snapshot (' + armed.preArm + ')');

      const alarm = chromeMock.alarms.get(ALARM);
      check(alarm && alarm.periodInMinutes === 0.5,
        'the alarm runs every 0.5 minutes (' +
        JSON.stringify(alarm && alarm.periodInMinutes) + ')');

      const st = await chromeMock.dispatch({ type: 't059-trigger-state' });
      check(st && st.ok === true, 't059-trigger-state answers ok');
      check(st.alarm === 0.5, 'reports the real alarm period (' + st.alarm + ')');
      check(st.defaults && st.defaults.maxPerHour === 100
        && st.defaults.maxPerHourCeiling === 100,
        'and both the default and ceiling are 100');
      check(st.defaults.windowMs === 3600000,
        'and the window is 60 minutes (' + st.defaults.windowMs + ')');
      check(st.result.windowStartedAt === st.result.armedAt,
        'the counting window is anchored at arm time, not sliding');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // ------------------- 3. 101 onwards is refused; dedupe and 30s stay separate
  console.log('== T069: the 101st notice in one window is refused ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't069-c-'));
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
      const bg = await mod('./extension/background.js?reload=t069c');
      const sendOnce = async (candidate) => {
        chromeMock.local.set('writes',
          (chromeMock.local.get('writes') || []).concat([candidate.runId]));
        return { sent: true, status: 'submitted', evidence: { receipt: 'stub' } };
      };
      const writes = () => chromeMock.local.get('writes') || [];
      await chromeMock.dispatch({ type: 't059-trigger-arm',
        confirmation: TARM, userGesture: true });
      await bg.runTerminalTrigger({ limit: 1, sendOnce });     // establish baseline

      // 104 distinct completions, all after the baseline. Wall time cannot be spent,
      // so each tick is given a clock 30.5s later: past the pacing floor but inside
      // the same 60-minute window, which is the only way the count can be the
      // refusal reason.
      const runs = [];
      for (let i = 0; i < 104; i += 1) {
        runs.push({ id: 'eeeeeeee-eeee-4eee-8eee-' + String(i).padStart(12, '0'),
          status: 'completed' });
      }
      writeRuns(ledgerRoot, runs);
      let clock = Date.now();
      const codes = [];
      for (let i = 0; i < 108; i += 1) {
        clock += 30500;
        const tick = await bg.runTerminalTrigger({ limit: 2, sendOnce,
          now: () => clock });
        for (const r of tick.results) if (r.code) codes.push(r.code);
        if (process.env.DBG) console.log('T' + i + ' w=' + writes().length + ' wc=' + (chromeMock.local.get('terminalTrigger')||{}).windowCount + ' codes=' + JSON.stringify(tick.results.map((r)=>r.code)) + ' fetched=' + JSON.stringify([tick.fetched.ok, tick.fetched.added, tick.fetched.acked]));
      }
      check(writes().length === 100,
        'exactly 100 are written in one window (' + writes().length + ')');
      check(new Set(writes()).size === 100, 'and no run is written twice');
      const windowRefusals = codes.filter((c) => c === 'rate_window_exceeded').length;
      check(windowRefusals >= 4,
        'the next ones are refused by the window, not by pacing (' +
        windowRefusals + ')');

      // Dedupe is separate from the window: the same completion never doubles up.
      const st = chromeMock.local.get('terminalTrigger');
      check(st.windowCount === 100, 'the window counter sits at the limit (' +
        st.windowCount + ')');
      check(st.enabled === true, 'and a pure rate refusal does not disable it');
      const replayed = await bg.runTerminalTrigger({ limit: 4, sendOnce,
        now: () => clock });
      check(writes().length === 100,
        'a further tick still writes nothing (' + writes().length + ')');
      check(replayed.results.every((r) => r.code !== null || r.sent !== true),
        'and reports refusals rather than silent success');

      // A new window frees the count. The backlog that the window refused comes
      // first -- that is the correct order -- so this only asserts that the count
      // reset and delivery resumed. Pacing is measured on its own in the next block.
      clock += 3600000;
      const next = await bg.runTerminalTrigger({ limit: 2, sendOnce,
        now: () => clock });
      check(writes().length === 101,
        'a new window admits more work (' + writes().length + ')');
      check(!codes.includes('trigger_disabled'),
        'and a pure rate refusal never disabled the trigger');
      check(chromeMock.local.get('terminalTrigger').windowCount === 1,
        'with the counter restarted (' +
        chromeMock.local.get('terminalTrigger').windowCount + ')');
      check(next.fetched.ok === true, 'and polling keeps working after the rollover');

      // The popup must disclose that a fixed window is not a rolling rate. Assert
      // the visible string, not the comment: the acceptance criterion is that the
      // operator can see it.
      const popupSrc = readFileSync(new URL('./extension/popup.js', ROOT), 'utf8');
      check(/计数窗口：固定 /.test(popupSrc) && /非滑动/.test(popupSrc),
        'the popup names the counter as a fixed window, not rolling');
      check(/跨窗口边界时窗口会再放行一批/.test(popupSrc)
        && /理论上限 2×/.test(popupSrc) && /实际上限约为/.test(popupSrc),
        'and discloses the 2x window allowance *and* the lower reachable cap');
      check(/调度周期：每/.test(popupSrc) && /实际可能延后/.test(popupSrc),
        'and that Chrome may delay the tick');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  console.log('== T069: 30s pacing, history isolation, and unknown writes ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't069-d-'));
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    const hostRef = { current: h };
    const chromeMock = createChrome(hostRef);
    globalThis.chrome = chromeMock.api;
    try {
      // History first: two candidates that predate the arm.
      chromeMock.local.set('terminalCandidates',
        [{ runId: OLD_RUN, status: 'completed' , origin: 'bridge'},
          { runId: 'a2aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'failed' , origin: 'bridge'}]);
      chromeMock.session.set('t053TargetBindingState',
        { version: 1, revision: 3, binding: BINDING, candidates: [],
          candidateScannedAt: null });
      const bg = await mod('./extension/background.js?reload=t069d');
      const writes = [];
      let reply = { sent: true, status: 'submitted', evidence: { receipt: 'stub' } };
      const sendOnce = async (candidate) => { writes.push(candidate.runId); return reply; };

      const armed = await chromeMock.dispatch({ type: 't059-trigger-arm',
        confirmation: TARM, userGesture: true });
      check(armed.preArm === 2, 'arming snapshots the two historical candidates (' +
        armed.preArm + ')');

      let clock = Date.now();
      const first = await bg.runTerminalTrigger({ limit: 5, sendOnce,
        now: () => clock });
      check(first.fetched.baselineEstablished === true, 'the first tick builds the baseline');
      check(writes.length === 0, 'and writes nothing at all (' + writes.length + ')');
      check(first.results.filter((r) => r.code === 'pre_arm_candidate').length === 2,
        'both historical candidates are reported as pre-arm');
      check((chromeMock.local.get('terminalCandidates') || []).length === 2,
        'and are kept for review, not deleted');

      // A real completion arrives: 30s pacing is what limits it, not the window.
      const R1 = '11111111-1111-4111-8111-111111111111';
      const R2 = '22222222-2222-4222-8222-222222222222';
      writeRuns(ledgerRoot, [{ id: R1, status: 'completed' }]);
      clock += 31000;
      const sent1 = await bg.runTerminalTrigger({ limit: 5, sendOnce, now: () => clock });
      check(writes.length === 1 && writes[0] === R1,
        'the new completion is written (' + JSON.stringify(writes) + ')');
      check(sent1.results.some((r) => r.sent === true), 'and settled as sent');
      check(chromeMock.local.get('terminalTrigger').windowCount === 1,
        'consuming one unit of window budget');

      writeRuns(ledgerRoot, [{ id: R1, status: 'completed' },
        { id: R2, status: 'completed' }]);
      clock += 20000;                            // only 20s since the last send
      const tooSoon = await bg.runTerminalTrigger({ limit: 5, sendOnce,
        now: () => clock });
      check(writes.length === 1, 'a notice 20s later is held back (' + writes.length + ')');
      check(tooSoon.results.some((r) => r.code === 'rate_limited'),
        'and named rate_limited (' +
        JSON.stringify(tooSoon.results.map((r) => r.code)) + ')');
      check(tooSoon.results.every((r) => r.code !== 'rate_window_exceeded'),
        'while the hourly window is untouched');
      check(chromeMock.local.get('terminalTrigger').windowCount === 1,
        'so the pacing refusal costs no budget');

      clock += 11000;                            // 31s since the last send
      await bg.runTerminalTrigger({ limit: 5, sendOnce, now: () => clock });
      check(writes.length === 2 && writes[1] === R2,
        'then goes through once 30s have passed (' + JSON.stringify(writes) + ')');
      check(writes[0] === R1 && writes[1] === R2, 'and in ledger order, not reversed');
      check(!writes.includes(OLD_RUN), 'the historical candidate was never written');

      // An unconfirmed write must stop everything, immediately.
      const R3 = '33333333-3333-4333-8333-333333333333';
      writeRuns(ledgerRoot, [{ id: R1, status: 'completed' },
        { id: R2, status: 'completed' }, { id: R3, status: 'completed' }]);
      reply = { sent: false, status: 'unconfirmed', reason: 'no_ack_from_page' };
      clock += 31000;
      const doubtful = await bg.runTerminalTrigger({ limit: 5, sendOnce,
        now: () => clock });
      check(writes.length === 3, 'the doubtful attempt is still recorded (' +
        writes.length + ')');
      const off = chromeMock.local.get('terminalTrigger');
      check(off.enabled === false,
        'an unconfirmed write disables the trigger at once');
      check(typeof off.lastError === 'string' && off.lastError.length > 0,
        'with a reason kept for the operator (' + JSON.stringify(off.lastError) + ')');
      check(doubtful.results.some((r) => r.sent === false),
        'and it is never reported as sent');

      clock += 31000;
      writeRuns(ledgerRoot, [{ id: R1, status: 'completed' },
        { id: R2, status: 'completed' }, { id: R3, status: 'completed' },
        { id: '44444444-4444-4444-8444-444444444444', status: 'completed' }]);
      const afterwards = await bg.runTerminalTrigger({ limit: 5, sendOnce,
        now: () => clock });
      check(writes.length === 3,
        'nothing more is written until a human re-arms (' + writes.length + ')');
      check(afterwards.fetched.code === 'trigger_disabled',
        'and the poll is not even attempted (' + afterwards.fetched.code + ')');

      // The read-only diagnostics must not send, and must not touch the poll record.
      // The read-only canary diagnostic: before arming it must list what is
      // missing, after arming it must not invent a green light, and either way it
      // must send nothing and poll nothing.
      const cold = await chromeMock.dispatch({ type: 't069-canary-readiness' });
      check(cold && cold.ok === true && cold.result, 'the readiness diagnostic answers');
      check(cold.result.ok === false, 'an unarmed profile is not canary-ready');
      check(cold.result.blockedBy.some((c) => c === 'trigger_disabled'),
        'and names the disabled trigger (' + JSON.stringify(cold.result.blockedBy) + ')');
      check(cold.result.blockedBy.some((c) => c === 'authorization_inactive'),
        'and the missing authorization');
      check(cold.result.blockedBy.some((c) => String(c).startsWith('binding')
        || String(c).startsWith('tab_')), 'and the unavailable binding (' +
        JSON.stringify(cold.result.blockedBy) + ')');
      check(writes.length === 3, 'without writing anything (' + writes.length + ')');

      const wrongSender = await chromeMock.dispatch({ type: 't069-canary-readiness' },
        { id: 'test-extension', url: 'chrome-extension://t/page.html', tab: { id: 3 } });
      check(wrongSender && wrongSender.ok === false
        && wrongSender.error === 'extension_popup_required',
        'and a page cannot ask it (' + JSON.stringify(wrongSender && wrongSender.error) + ')');
      check(writes.length === 3, 'still nothing written (' + writes.length + ')');
      const statusBefore = chromeMock.local.get('terminalChainStatus');
      const diag = await chromeMock.dispatch({ type: 't065-chain-selfcheck' });
      check(diag && diag.ok === true, 'the self-check answers ok');
      check(writes.length === 3, 'and sends nothing (' + writes.length + ')');
      const statusAfter = chromeMock.local.get('terminalChainStatus');
      check(statusBefore === statusAfter
        || (statusBefore && statusAfter && statusBefore.at === statusAfter.at),
        'and leaves the real poll record alone');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  console.log('== T069: the adapter refuses a page that navigated after the gate ==');
  {
    const adapter = await mod('./extension/lib/send_adapter.js');
    // A minimal fake page: one visible composer, one enabled send button.
    function fakePage(path, { composerText = '' } = {}) {
      const clicks = [];
      const composer = {
        value: composerText,
        textContent: composerText,
        focus() {},
        dispatchEvent() {},
        getBoundingClientRect: () => ({ width: 400, height: 60 }),
      };
      const button = {
        disabled: false,
        getBoundingClientRect: () => ({ width: 30, height: 30 }),
        click() {
          clicks.push(1);
          // A real page turns the composer contents into a user message.
          const typed = composer.value || composer.textContent || '';
          if (typed) messages.push(typed);
          composer.value = '';
          composer.textContent = '';
        },
      };
      const messages = [];
      const doc = {
        location: { pathname: path, href: 'https://chatgpt.com' + path },
        querySelectorAll(selector) {
          if (selector.includes('contenteditable')) return [composer];
          if (selector.includes('[data-message-author-role="user"]')) {
            return messages.map((text) => ({ textContent: text }));
          }
          if (selector === 'button[data-testid="send-button"]') return [button];
          return [];
        },
        execCommand() { return false; },
        createEvent() { return { initEvent() {} }; },
      };
      return { doc, clicks, messages, composer, button };
    }

    const convA = CONV;
    const convB = '99999999-9999-4999-8999-999999999999';

    // Mismatch: refuse before typing anything.
    const moved = fakePage('/c/' + convB);
    const refusedMismatch = await adapter.deliverInto(moved.doc,
      { runId: NEW_RUN, status: 'completed', origin: 'bridge', expectedConversationId: convA }, 1);
    check(refusedMismatch.status === 'refused',
      'a mismatched conversation is a refusal (' + refusedMismatch.status + ')');
    check(refusedMismatch.reason === 'conversation_changed_at_page',
      'named conversation_changed_at_page (' + refusedMismatch.reason + ')');
    check(moved.clicks.length === 0, 'and the send button was never clicked');
    check(moved.composer.value === '',
      'and the composer was left untouched, so no draft was disturbed');

    // Not on a conversation route at all: also refused.
    const home = fakePage('/');
    const refusedRoute = await adapter.deliverInto(home.doc,
      { runId: NEW_RUN, status: 'completed', origin: 'bridge', expectedConversationId: convA }, 2);
    check(refusedRoute.status === 'refused' &&
      refusedRoute.reason === 'conversation_route_changed',
      'leaving the conversation route is refused too (' + refusedRoute.reason + ')');

    // The bound conversation still works, and reports the id it saw.
    const right = fakePage('/c/' + convA);
    const done = await adapter.deliverInto(right.doc,
      { runId: NEW_RUN, status: 'completed', origin: 'bridge', expectedConversationId: convA }, 3);
    check(done.status === 'submitted',
      'the bound conversation still submits (' + done.status + '/' + done.reason + ')');
    check(right.clicks.length === 1, 'exactly one click');
    check(done.evidence.conversationId === convA,
      'and the receipt names the conversation (' + done.evidence.conversationId + ')');

    // Case difference is not a mismatch.
    const upper = fakePage('/c/' + convA.toUpperCase());
    const cased = await adapter.deliverInto(upper.doc,
      { runId: NEW_RUN, status: 'completed', origin: 'bridge', expectedConversationId: convA }, 4);
    check(cased.status === 'submitted', 'a differently-cased id still matches');

    // No expectation supplied keeps the old behaviour (unit tests, dry runs).
    const bare = fakePage('/c/' + convB);
    const noExpectation = await adapter.deliverInto(bare.doc,
      { runId: NEW_RUN, status: 'completed' , origin: 'bridge'}, 5);
    check(noExpectation.status === 'submitted',
      'without an expectation the adapter behaves as before');

    // A half-written draft is still never merged with.
    const draft = fakePage('/c/' + convA, { composerText: 'my half-written note' });
    const kept = await adapter.deliverInto(draft.doc,
      { runId: NEW_RUN, status: 'completed', origin: 'bridge', expectedConversationId: convA }, 6);
    check(kept.status === 'refused' && kept.reason === 'composer_not_empty',
      'a non-empty composer is still refused (' + kept.reason + ')');
    check(draft.clicks.length === 0 && draft.composer.value === 'my half-written note',
      'and the operator draft is untouched');

    // The notice text is fixed: no prose can be smuggled through the id fields.
    const fixed = adapter.composeNotice(NEW_RUN, 'completed');
    check(fixed.ok === true && fixed.text.includes(NEW_RUN),
      'the notice carries the run id');
    check(!/[{}<>\n]/.test(fixed.text),
      'and no structure or newline that could carry extra text');
    check(adapter.composeNotice('x', 'completed').ok === false,
      'a malformed run id is refused before any typing');
  }

  console.log('== T069: the disclosed per-hour cap is the reachable one ==');
  {
    const T = await mod('./extension/lib/terminal_trigger.js');
    const B = Object.assign({ manuallyConfirmed: true }, BINDING);
    // Walk the real admit/settle path at exactly 30s spacing, with the window
    // boundary placed at several offsets, and measure the worst 60-minute span.
    // The popup promises "2x permitted by the window, ~121 actually reachable",
    // so both halves of that sentence need to be true.
    function worstSpan(startAt) {
      let st = T.configure(T.createTriggerState(), { binding: B },
        TARM, true, 0).state;
      const sentAt = [];
      let t = startAt;
      for (let i = 0; i < 400; i += 1) {
        const runId = 'eeeeeeee-eeee-4eee-8eee-' + String(i).padStart(12, '0');
        // T067: `origin: 'bridge'`. This helper measures the densest hourly span
        // the limits allow, so its runs must be the auto-notifiable channel; a
        // direct run would be stopped by the channel gate and prove nothing.
        const v = T.admit(st, { runId, status: 'completed', origin: 'bridge' }, t);
        if (v.admit) {
          const m = T.markAttempt(st,
            { runId, status: 'completed', origin: 'bridge' }, t);
          st = T.settle(m.state, v.key, { sent: true }, t).state;
          sentAt.push(t);
        }
        t += 30000;
      }
      let best = 0;
      for (const s of sentAt) {
        const n = sentAt.filter((x) => x >= s && x < s + 3600000).length;
        if (n > best) best = n;
      }
      return best;
    }
    const pacingCap = Math.floor(3600000 / 30000) + 1;
    const samples = [0, 54 * 60000, Math.round(29.5 * 60000)];
    const worst = Math.max(...samples.map(worstSpan));
    check(worst <= pacingCap,
      'no 60-minute span ever exceeds the pacing cap (' + worst + ' <= '
      + pacingCap + ')');
    check(worst > 100,
      'a boundary can push one span past the nominal 100 (' + worst + ')');
    check(worst < 200,
      'but the theoretical 2x=200 is not reachable (' + worst + ' < 200)');
    // Which is exactly what the popup claims.
    const popupSrc = readFileSync(new URL('./extension/popup.js', ROOT), 'utf8');
    check(/Math\.floor\(3600000 \/ interval\) \+ 1/.test(popupSrc),
      'and the popup derives that same number rather than a literal');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
