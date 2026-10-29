// T066: the persisted baseline marker must not fall back on a healthy machine.
//
// The bug this covers: `terminal_source.sample` answers
// `baselineEstablished: true` only on the call that *creates* the baseline and
// `false` on every later successful call. `refreshTerminalCandidates` copied that
// flag straight into the persisted marker, so the second poll cleared it, and the
// read-only self-check -- which refuses to call `terminal-list` without a marker
// (its first call would swallow every pending completion) -- then reported
// `baseline_not_established` forever. On a healthy machine.
//
// Real local host process against a temporary state dir and a temporary ledger.
// The only thing mocked is Chrome itself. No tab is opened, no page is read, and
// nothing here can reach ChatGPT.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'chrome-extension://t066-e2e/';
const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ------------------------------------------------------------- real host driver
function startHost(stateDir, ledgerRoot) {
  // Without an explicit root the host samples the production AgentState. Failing
  // loudly means a forgotten fixture can never read the operator's real ledger.
  if (!ledgerRoot) {
    throw new Error('startHost requires a temporary ledgerRoot; refusing to '
      + 'let the host fall back to the production AgentState');
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
  // Every port handed out gets notified when the process dies, so an in-flight
  // request fails at once instead of waiting out NativeClient's 10s timer.
  const discListeners = new Set();
  let nextId = 0;
  let stderr = '';
  let dead = false;

  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.on('exit', () => {
    dead = true;
    for (const fn of discListeners) {
      try { fn(); } catch (_e) { /* the caller's own callback */ }
    }
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
    get stderr() { return stderr; },
    // A Chrome-style Port, so background.js's real NativeClient can drive it.
    // Chrome disconnects a port immediately when the host is not there, so a port
    // opened *after* the process died must fire `onDisconnect` rather than hang.
    // Without that, NativeClient keeps a dead port and every later request goes
    // silent -- the fixture would then be stuck on a state Chrome never produces.
    port() {
      let listener = null;
      let fired = false;
      const fire = () => {
        if (fired || !listener) return;
        fired = true;
        const fn = listener;
        try { fn(); } catch (_e) { /* the test's own callback */ }
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
          try { child.stdin.write(frame(doc)); }
          catch (_e) { setTimeout(fire, 0); }
        },
      };
    },
    // Direct wire access, used only to prove what the self-check did or did not do.
    async send(op, args) {
      const id = 'probe-' + (nextId += 1);
      const answer = new Promise((resolve) => waiters.set(id, resolve));
      try { child.stdin.write(frame({ v: 1, id, op, args: args || {} })); }
      catch (_e) { return null; }
      return Promise.race([
        answer,
        new Promise((_r, reject) => setTimeout(() =>
          reject(new Error('host timeout on ' + op + ' stderr=' + stderr)), 15000)),
      ]);
    },
    stop() { try { child.kill(); } catch (_e) { /* already gone */ } },
  };
}

function newStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 't066-e2e-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The ledger lives one hash-named directory down and holds `requestID` +
// numeric `createdAt`; anything else is refused by `read_runs`.
function useLedger(ledgerRoot) {
  return { dir: join(ledgerRoot, 'a'.repeat(64)) };
}
function writeRuns(ledgerRoot, runs) {
  const { dir } = useLedger(ledgerRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'endpoint.json.runs.json');
  writeFileSync(file, JSON.stringify(runs.map((run, index) => ({
    requestID: run.id,
    status: run.status,
    createdAt: 1767225600000 + index * 1000,
  })), null, 2), 'utf8');
  return file;
}

// ---------------------------------------------------------------- mock chrome
// background.js registers a lot of chrome.* listeners at module load. Rather than
// enumerating every event Chrome may add, any unknown `on*` property resolves to
// an inert event and any other unknown property to an inert callable. The parts
// that carry meaning (storage, tabs.query/sendMessage, connectNative) stay real.
function stubEvent() {
  return { addListener() {}, removeListener() {}, hasListener() { return false; } };
}
function stubObject() {
  return new Proxy(function () {}, {
    get(_target, prop) {
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
  function area(store) {
    return {
      async get(defaults) {
        const out = {};
        for (const [key, fallback] of Object.entries(defaults || {})) {
          out[key] = store.has(key) ? clone(store.get(key)) : fallback;
        }
        return out;
      },
      async set(obj) {
        for (const [key, value] of Object.entries(obj)) store.set(key, clone(value));
      },
      async remove(key) { store.delete(key); },
    };
  }
  return {
    local,
    session,
    api: shield({
      storage: { local: area(local), session: area(session) },
      runtime: shield({
        id: 'test-extension',
        getURL: (p) => 'chrome-extension://t/' + p,
        // Lazily reconnect: after the host dies NativeClient drops its port and
        // asks again on the next request, so this must hand back a fresh one.
        connectNative: () => hostRef.current.port(),
        lastError: null,
      }),
      tabs: shield({
        async query() { return []; },
        async get() { return null; },
        async sendMessage() { throw new Error('no content script'); },
      }),
      windows: shield({ async get() { return null; } }),
      alarms: shield({
        async get() { return null; },
        async clear() {},
        create() {},
      }),
      action: shield({ async setBadgeText() {} }),
      scripting: shield({ async executeScript() { return []; } }),
    }),
  };
}

async function main() {
  const ledger = await mod('./extension/lib/terminal_trigger.js');
  const autosend = await mod('./extension/lib/autosend.js');

  // ------------------------------------------- A+B: the marker must not regress
  console.log('== T066: a successful sample proves the baseline exists ==');
  {
    const dir = newStateDir();
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    const hostRef = { current: h };
    const chromeMock = createChrome(hostRef);
    globalThis.chrome = chromeMock.api;
    try {
      const bg = await mod('./extension/background.js');

      const first = await bg.refreshTerminalCandidates();
      check(first.ok === true, 'the first poll succeeds');
      check(first.baselineEstablished === true,
        'and this call is the one that created the baseline');
      let marker = chromeMock.local.get('terminalSourceBaseline');
      check(marker && marker.established === true,
        'the marker records that a baseline exists');
      check(marker && marker.establishedNow === true,
        'and records that this call made it');

      const second = await bg.refreshTerminalCandidates();
      check(second.ok === true, 'a later poll also succeeds');
      check(second.baselineEstablished === false,
        'and honestly reports it did not create the baseline');
      marker = chromeMock.local.get('terminalSourceBaseline');
      check(marker && marker.established === true,
        'the marker survives a later successful poll');
      check(marker && marker.establishedNow === false,
        'while establishedNow records that this call did not make it');

      const third = await bg.refreshTerminalCandidates();
      check(third.ok === true, 'a third poll succeeds');
      marker = chromeMock.local.get('terminalSourceBaseline');
      check(marker && marker.established === true,
        'and three polls in a row never clear the marker');

      // --------------------------------- B: the self-check reads the marker
      const report = await bg.readChainSelfCheck();
      check(report.stages.baseline === 'ok',
        'the self-check reads the baseline as ok (' + report.stages.baseline + ')');
      check(report.stages.sourceReady === 'ok',
        'and the source as ok (' + report.stages.sourceReady + ')');
      check(report.stage !== 'baseline',
        'so the report no longer stops at the baseline (' + report.stage + ')');
      check(report.sendEligible === false, 'while still never claiming a send');

      // ------------------------------------------- E: host dies, no invention
      h.stop();
      await new Promise((r) => setTimeout(r, 150));
      const dead = await bg.refreshTerminalCandidates();
      check(dead.ok === false, 'a dead host fails the poll');
      marker = chromeMock.local.get('terminalSourceBaseline');
      check(marker && marker.established === true,
        'and the failure does not clear the marker');
      const whileDown = await bg.readChainSelfCheck();
      check(whileDown.stages.hostOnline !== 'ok',
        'the self-check refuses to call a dead host online');

      // --------------------------------------- F: host comes back, state kept
      const h2 = startHost(join(dir, 'host'), ledgerRoot);
      hostRef.current = h2;
      const revived = await bg.refreshTerminalCandidates();
      check(revived.ok === true,
        'the poll succeeds again after a restart (' + revived.code + ' '
        + (revived.error || '') + ')');
      check(revived.baselineEstablished === false,
        'the sampler still has its original baseline, so it was not re-created');
      marker = chromeMock.local.get('terminalSourceBaseline');
      check(marker && marker.established === true,
        'and the marker is still set after the host returned');
      h2.stop();
    } finally {
      try { h.stop(); } catch (_e) { /* already stopped */ }
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // -------------------------- C: a read-only self-check cannot create a baseline
  console.log('== T066: the self-check cannot initialise the source itself ==');
  {
    const dir = newStateDir();
    const ledgerRoot = join(dir, 'agents');
    // One run already terminal: if the self-check were to call `terminal-list`,
    // the very first sample would absorb it into a fresh baseline.
    writeRuns(ledgerRoot, [
      { id: '11111111-1111-4111-8111-111111111111', status: 'completed' },
    ]);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    const hostRef = { current: h };
    const chromeMock = createChrome(hostRef);
    globalThis.chrome = chromeMock.api;
    try {
      // Cache-busted import: a distinct specifier is a distinct module instance,
      // which is what "the extension was reloaded" actually means. Reusing the
      // cached module would carry over the previous block's NativeClient (and its
      // dead port), so this block would not be testing a fresh extension at all.
      const bg = await import(
        new URL('./extension/background.js?reload=1', ROOT).href);
      const report = await bg.readChainSelfCheck();
      check(report.stages.baseline === 'blocked',
        'an unprimed machine reports the baseline as blocked');
      check(report.stage === 'baseline',
        'and stops at the baseline (' + report.stage + ')');
      check(report.stages.sourceReady === 'unknown',
        'without claiming the source is unreadable -- it was never asked');

      // The decisive test: a real sample now must still be the *first* one.
      const sample = await h.send('terminal-list');
      check(sample && sample.result && sample.result.baselineEstablished === true,
        'the self-check left the source untouched: the next sample is still the first');
      const marker = chromeMock.local.get('terminalSourceBaseline');
      check(marker === undefined,
        'and the self-check wrote no baseline marker of its own');
    } finally {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    }
  }

  // ---------------------------- G: authorization and the trigger stay manual
  console.log('== T066: nothing revives authorization or the trigger by itself ==');
  {
    const binding = {
      tabId: 11, windowId: 4, revision: 3,
      url: 'https://chatgpt.com/c/3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071',
      conversationId: '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071',
      documentInstanceId: 'instance-abcdefghijkl',
      manuallyConfirmed: true, invalidatedReason: null,
    };
    const expired = autosend.arm(autosend.createAutoSendState(),
      { binding, ttlMs: 60000, maxSends: 2 },
      'AUTOSEND ' + binding.conversationId, true, 1_000_000).state;
    const probe = {
      ok: true, tabId: 11, windowId: 4, url: binding.url,
      conversationId: binding.conversationId,
      documentInstanceId: binding.documentInstanceId,
      composerPresent: true, hasEmptyComposer: true, composerEmpty: true,
      hasFocus: true, active: true, visibilityState: 'visible',
      discarded: false, frozen: false, observedAt: 1_199_000,
    };
    const after = autosend.decide(expired,
      { binding, probe, runId: 'r-1', status: 'completed' }, 1_200_000);
    check(after.send === false && after.code === 'authorization_expired',
      'an expired authorization stays expired (' + after.code + ')');

    const unconfigured = ledger.createTriggerState();
    const refused = ledger.admit(unconfigured,
      { runId: '22222222-2222-4222-8222-222222222222', status: 'completed' },
      1_000_000);
    check(refused.admit === false && refused.code === 'trigger_disabled',
      'an unconfigured trigger stays disabled (' + refused.code + ')');

    const wrongPhrase = autosend.arm(autosend.createAutoSendState(),
      { binding, ttlMs: 60000, maxSends: 2 }, 'AUTOSEND nope', true, 1_000_000);
    check(wrongPhrase.result.ok === false
      && wrongPhrase.result.code === 'arm_confirmation_mismatch',
      'and arming still needs the exact confirmation phrase');
  }

  // ------------------- H: a frozen source must not look like a quiet afternoon
  // The 2026-10-29 stop: the bridge stopped recording runs for 90 minutes while
  // every field the panel shows stayed green, because "no candidates" and "the
  // source has not moved" were the same answer. Two things are pinned here: the
  // marker now separates creation time from last-sample time, and eligibility
  // stays id-set based -- so elapsed time can never swallow a completion.
  console.log('== T066: a frozen source is visible, and never swallows a run ==');
  {
    const dir = newStateDir();
    const ledgerRoot = join(dir, 'agents');
    const oldest = 'aaaaaaaa-1111-4111-8111-111111111111';
    const ledgerFile = writeRuns(ledgerRoot, [{ id: oldest, status: 'completed' }]);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    const hostRef = { current: h };
    const chromeMock = createChrome(hostRef);
    globalThis.chrome = chromeMock.api;
    try {
      const bg = await import(
        new URL('./extension/background.js?reload=freeze', ROOT).href);
      const first = await bg.refreshTerminalCandidates();
      check(first.ok === true, 'the first sample succeeds');
      let marker = chromeMock.local.get('terminalSourceBaseline');
      check(Number.isFinite(marker.establishedAt),
        'the marker records when the baseline was created ('
        + marker.establishedAt + ')');
      check(marker.establishedAt === marker.at,
        'which on the establishing poll equals the sample moment');
      const establishedAt = marker.establishedAt;
      const firstSampleAt = marker.at;

      // Age the ledger by 90 minutes: the source has recorded nothing since.
      const aged = new Date(Date.now() - 90 * 60000);
      utimesSync(ledgerFile, aged, aged);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await bg.refreshTerminalCandidates();
      check(second.ok === true, 'a later poll still succeeds on a frozen source');
      check(second.added === 0, 'and offers nothing (' + second.added + ')');
      marker = chromeMock.local.get('terminalSourceBaseline');
      check(marker.establishedAt === establishedAt,
        'the creation time does not move (' + marker.establishedAt + ')');
      check(marker.at > firstSampleAt,
        'while the last-sample time does (' + firstSampleAt + ' -> '
        + marker.at + ')');
      check(marker.ledgerMtime === Math.floor(aged.getTime() / 1000),
        'and the source age comes from the ledger mtime ('
        + marker.ledgerMtime + ')');
      check(marker.newestRunId === oldest,
        'with the newest run the source knows (' + marker.newestRunId + ')');

      // The decisive part: a run appearing after a long quiet stretch is still new.
      const fresh = 'bbbbbbbb-2222-4222-8222-222222222222';
      writeRuns(ledgerRoot, [
        { id: oldest, status: 'completed' },
        { id: fresh, status: 'completed' },
      ]);
      const third = await bg.refreshTerminalCandidates();
      check(third.ok === true, 'the poll after the source wakes succeeds');
      check(third.added === 1,
        'and the new run is offered despite the elapsed time (' + third.added + ')');
      const queued = chromeMock.local.get('terminalCandidates') || [];
      check(queued.some((item) => item.runId === fresh),
        'the candidate is stored for the trigger');
      marker = chromeMock.local.get('terminalSourceBaseline');
      check(marker.newestRunId === fresh,
        'and the freshness line follows the source forward (' + marker.newestRunId + ')');

      const report = await bg.readChainSelfCheck();
      check(report.stages.baseline === 'ok',
        'the self-check still reads the baseline as ok (' + report.stages.baseline + ')');
      h.stop();
    } finally {
      try { h.stop(); } catch (_e) { /* already stopped */ }
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
