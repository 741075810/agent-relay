// T067: two defects around candidates and the self-check.
//
// 1. `readChainSelfCheck()` wrote its own reading into `terminalChainStatus`,
//    the same key the popup shows as "最近轮询/ACK". Clicking the self-check
//    replaced the real poll record with `added:null acked:null at:<now>`, which
//    reads like "the last poll produced nothing" instead of "nobody polled".
// 2. `runTerminalTrigger()` looped over *every* stored candidate, so candidates
//    already pending when the operator enabled the trigger were written to the
//    page on the first tick -- history turned into messages.
//
// Real local host against a temporary state dir and ledger; only Chrome is mocked.
// The page write is a declared stub: nothing here opens a tab or reaches ChatGPT.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'chrome-extension://t067-e2e/';
const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
// T086: the arm boundary is proved from a run's creation time, so a fixture run must
// be created when it is written (i.e. after the arm), exactly like a real completion.
// arm is provably created after it; a fixed timestamp would prove nothing.
// (T086) `Date.now()` is used at the call site below, so a run written after the

const CONV = '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071';
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
        () => reject(new Error('host timeout ' + op + ' ' + stderr)), 15000))]);
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
// Any `on*` the background registers resolves to an inert event, and anything
// else unknown to an inert callable. storage / connectNative / sendMessage stay
// real, because those are what the scenarios measure.
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
      async sendMessage(_tabId, msg) {
        // The send double: records the intent, touches no page.
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
    setWriteReply(reply) { writeReply = reply; },
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
  const BINDING = {
    tabId: 11, windowId: 4, revision: 3, url: 'https://chatgpt.com/c/' + CONV,
    conversationId: CONV, documentInstanceId: 'instance-abcdefghijkl',
    manuallyConfirmed: true, invalidatedReason: null,
  };

  // ------------------------------------- 1. the self-check must not fake a poll
  console.log('== T067: the self-check cannot overwrite the real poll record ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't067-a-'));
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    const hostRef = { current: h };
    const chromeMock = createChrome(hostRef);
    globalThis.chrome = chromeMock.api;
    try {
      const bg = await mod('./extension/background.js');
      const first = await bg.refreshTerminalCandidates();
      check(first.ok === true, 'the first real poll succeeds');

      // A new terminal run, so the real poll has something to count.
      writeRuns(ledgerRoot, [{ id: NEW_RUN, status: 'completed' }]);
      const real = await bg.refreshTerminalCandidates();
      check(real.added === 1 && real.acked === 1,
        'the second real poll adds and acknowledges one candidate ('
        + real.added + '/' + real.acked + ')');

      const before = chromeMock.local.get('terminalChainStatus');
      check(before && before.ok === true, 'the poll record says ok');
      check(before && before.added === 1 && before.acked === 1,
        'and carries the real added/acked counts');
      check(before && Number.isFinite(before.at),
        'and a real timestamp');

      // Two self-checks, as if the operator clicked the button twice.
      const r1 = await bg.readChainSelfCheck();
      const r2 = await bg.readChainSelfCheck();
      check(r1.ok === true && r2.ok === true, 'the self-check runs');

      const after = chromeMock.local.get('terminalChainStatus');
      check(after && after.at === before.at,
        'the real poll timestamp survives two self-checks');
      check(after && after.added === 1 && after.acked === 1,
        'and so do the real added/acked counts');
      check(after && after.ok === true, 'and its ok flag');

      // What the popup shows must describe the poll, not the click.
      check(r2.detail.candidates.lastPoll
        && r2.detail.candidates.lastPoll.added === 1,
        'the report shows the real poll, not itself ('
        + JSON.stringify(r2.detail.candidates.lastPoll && r2.detail.candidates.lastPoll.added) + ')');
      check(r2.sendEligible === false, 'and still claims no send');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // ------------------------- 2+3. history is not sent; only new work is sent
  console.log('== T067: candidates pending before arming are never written ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't067-b-'));
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    const hostRef = { current: h };
    const chromeMock = createChrome(hostRef);
    globalThis.chrome = chromeMock.api;
    try {
      // The extension has history: one candidate left over from an earlier arm.
      chromeMock.local.set('terminalCandidates',
        [{ runId: OLD_RUN, status: 'completed' , origin: 'bridge'}]);
      chromeMock.session.set('t053TargetBindingState',
        { version: 1, revision: 3, binding: BINDING, candidates: [],
          candidateScannedAt: null });

      const bg = await mod('./extension/background.js?reload=t067');
      const armed = await chromeMock.dispatch({ type: 't059-trigger-arm',
        minIntervalMs: 30000, maxPerHour: 6, userGesture: true,
        confirmation: 'AUTOTRIGGER ' + CONV });
      check(armed && armed.ok === true && armed.result.ok === true,
        'the trigger arms ('
        + JSON.stringify(armed && armed.result && armed.result.code) + ')');

      // The page writer, declared per scenario. Records the candidate and reports
      // a confirmed write; no page is touched.
      const sendOnce = async (candidate) => {
        chromeMock.writeCalls.push({ runId: candidate.runId,
          status: candidate.status });
        return { sent: true, status: 'submitted',
          evidence: { receipt: 'stub' } };
      };

      // First tick: this is the call the bug used to turn into a page write.
      const tick = await bg.runTerminalTrigger({ limit: 3, sendOnce: sendOnce });
      check(tick.fetched && tick.fetched.ok === true,
        'the first tick polls successfully');
      check(tick.fetched.baselineEstablished === true,
        'and this is the tick that establishes the baseline');
      check(chromeMock.writeCalls.length === 0,
        'it writes nothing to the page (' + chromeMock.writeCalls.length + ' writes)');

      const seen = Object.keys((tick.state && tick.state.seen) || {});
      check(seen.length === 0, 'no attempt was journalled for history (' +
        JSON.stringify(seen) + ')');
      const stillThere = chromeMock.local.get('terminalCandidates') || [];
      check(stillThere.length === 1 && stillThere[0].runId === OLD_RUN,
        'the old candidate is kept, visible, not silently deleted');
      check(tick.results.some((r) => r.code === 'pre_arm_candidate'),
        'and is reported as pre-arm, not as a send (' +
        JSON.stringify(tick.results.map((r) => r.code)) + ')');

      // A real task now completes. Only this one may be written.
      writeRuns(ledgerRoot, [{ id: NEW_RUN, status: 'completed' }]);
      const second = await bg.runTerminalTrigger({ limit: 3, sendOnce: sendOnce });
      check(chromeMock.writeCalls.length === 1,
        'exactly one write for one new completion (' + chromeMock.writeCalls.length + ')');
      check(chromeMock.writeCalls[0] && chromeMock.writeCalls[0].runId === NEW_RUN,
        'and it is the new run, not the history');
      check(second.results.some((r) => r.sent === true), 'the new one is settled sent');

      // The old one is still refused, and dedupe still holds for the new one.
      const third = await bg.runTerminalTrigger({ limit: 3, sendOnce: sendOnce });
      check(chromeMock.writeCalls.length === 1,
        'a further tick writes nothing new (' + chromeMock.writeCalls.length + ')');
      check(third.results.some((r) => r.code === 'pre_arm_candidate'),
        'history is still pre-arm on later ticks too');
      const leftover = chromeMock.local.get('terminalCandidates') || [];
      check(leftover.some((c) => c.runId === OLD_RUN),
        'and history is still visible for manual review');

      // Rate limit still applies to fresh work, not to history.
      const freshRun = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      writeRuns(ledgerRoot, [{ id: NEW_RUN, status: 'completed' },
        { id: freshRun, status: 'completed' }]);
      const fourth = await bg.runTerminalTrigger({ limit: 3, sendOnce: sendOnce });
      check(chromeMock.writeCalls.length === 1,
        'a fresh candidate inside the minimum interval is refused (' +
        chromeMock.writeCalls.length + ' writes)');
      check(fourth.results.some((r) => r.code === 'rate_limited'),
        'and named as rate limited (' +
        JSON.stringify(fourth.results.map((r) => r.code)) + ')');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // ------------------------------- 4. restart keeps the arm snapshot honest
  console.log('== T067: a restart neither forgets nor promotes history ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't067-c-'));
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
      const bg = await mod('./extension/background.js?reload=t067c');
      await chromeMock.dispatch({ type: 't059-trigger-arm',
        minIntervalMs: 30000, maxPerHour: 6, userGesture: true,
        confirmation: 'AUTOTRIGGER ' + CONV });

      const state = chromeMock.local.get('terminalTrigger');
      check(Array.isArray(state && state.preArmCandidateKeys)
        && state.preArmCandidateKeys.length === 1,
        'arming snapshots what was already pending');

      // Simulate a worker restart: the module re-runs, storage does not change.
      const revived = await mod('./extension/background.js?reload=t067c2');
      const sendOnce = async (candidate) => {
        chromeMock.writeCalls.push({ runId: candidate.runId,
          status: candidate.status });
        return { sent: true, status: 'submitted',
          evidence: { receipt: 'stub' } };
      };
      const tick = await revived.runTerminalTrigger({ limit: 3, sendOnce: sendOnce });
      check(chromeMock.writeCalls.length === 0,
        'after the restart the history still produces no write ('
        + chromeMock.writeCalls.length + ')');
      check(tick.results.some((r) => r.code === 'pre_arm_candidate'),
        'and is still reported as pre-arm');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // ----------------------------- 5. a failed ACK leaves the candidate pending
  console.log('== T067: a failed ACK keeps candidates pending, not lost ==');
  {
    const dir = mkdtempSync(join(tmpdir(), 't067-d-'));
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
      const bg = await mod('./extension/background.js?reload=t067d');
      await bg.refreshTerminalCandidates();          // baseline
      writeRuns(ledgerRoot, [{ id: NEW_RUN, status: 'completed' }]);
      const poll = await bg.refreshTerminalCandidates();
      check(poll.added === 1 && poll.acked === 1, 'the candidate is queued and acked');
      // Kill the host, then ask again: nothing may claim a successful ACK.
      h.stop();
      await new Promise((r) => setTimeout(r, 150));
      const dead = await bg.refreshTerminalCandidates();
      check(dead.ok === false, 'a dead host fails the poll');
      const rec = chromeMock.local.get('terminalChainStatus');
      check(rec && rec.ok === false && typeof rec.code === 'string',
        'and the record says so instead of claiming ok (' +
        JSON.stringify(rec && rec.code) + ')');
      check(rec && rec.added === null && rec.acked === null,
        'with no invented added/acked counts');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
