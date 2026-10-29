// T095B83: one finished task, at most one notice -- across sources, ticks, restarts.
//
// The host side was fixed in T080 (a ledger holding the same `requestID` twice produced
// two identical candidates). The extension is the second gate, and until now it was only
// *code*: no suite drove duplicate candidates, duplicate ticks or a service-worker restart
// through the real module and counted page writes.
//
// So this suite loads the real `extension/background.js` against the real host subprocess
// and mocks only Chrome, then counts how many times the page writer is entered. The
// adapter is a declared stub: it records the candidate and returns a receipt-shaped
// answer. Nothing here opens a tab, reaches ChatGPT, or touches production state -- the
// host is given an empty temporary native root, so it cannot read the operator's logs.
//
// The last block is a mutation: it copies `extension/` to a temporary directory, removes
// one guard, and shows the same scenario now writes twice. A regression test nobody has
// watched fail is a guess.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'chrome-extension://t095b83-dedup/';
const ROOT = new URL('.', import.meta.url);

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function section(title) { console.log('== ' + title); }
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- the host
function writeLedger(ledgerRoot) {
  const dir = join(ledgerRoot, 'd'.repeat(64));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'endpoint.json.runs.json'), '[]', 'utf8');
}

function startHost(stateDir, ledgerRoot) {
  const cwd = fileURLToPath(ROOT);
  mkdirSync(stateDir, { recursive: true });
  const manifestPath = join(stateDir, 'host_manifest.e2e.json');
  writeFileSync(manifestPath, JSON.stringify({
    name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN],
  }, null, 2), 'utf8');
  const fixturePath = join(stateDir, 'bridge-origin.fixture.json');
  writeFileSync(fixturePath, JSON.stringify({ version: 1, bridge: [] }), 'utf8');
  const nativeRoot = join(stateDir, 'native-sessions');
  mkdirSync(nativeRoot, { recursive: true });
  const child = spawn(process.env.PYTHON || 'python',
    ['-B', 'host.py', ORIGIN, '--state-dir', stateDir,
      '--ledger-root', ledgerRoot, '--manifest', manifestPath,
      '--bridge-db-fixture', fixturePath,
      '--native-root', nativeRoot],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  let stderr = '';
  const ports = [];
  const frame = (doc) => {
    const raw = Buffer.from(JSON.stringify(doc), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(raw.length, 0);
    return Buffer.concat([head, raw]);
  };
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (buffer.length < 4 + size) return;
      const doc = JSON.parse(buffer.slice(4, 4 + size).toString('utf8'));
      buffer = buffer.slice(4 + size);
      for (const port of ports) port.deliver(doc);
    }
  });
  return {
    get stderr() { return stderr; },
    port() {
      const waiting = [];
      const port = {
        deliver(doc) { for (const fn of waiting) fn(doc); },
        onMessage: { addListener(fn) { waiting.push(fn); } },
        onDisconnect: { addListener() {} },
        postMessage(doc) {
          if (child.exitCode !== null) throw new Error('host exited: ' + stderr);
          child.stdin.write(frame(doc));
        },
        disconnect() {},
      };
      ports.push(port);
      return port;
    },
    stop() { try { child.kill(); } catch (_err) { /* already gone */ } },
  };
}

// ---------------------------------------------------------------- chrome mock
const event = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; } });

function createChrome(hostRef) {
  const stores = { local: new Map(), session: new Map() };
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
      id: 'test-extension', getURL: (p) => ORIGIN + p,
      connectNative: () => hostRef.current.port(),
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onInstalled: event(), onStartup: event(), lastError: undefined,
    },
    storage: { local: area(stores.local), session: area(stores.session) },
    alarms: {
      async get() { return undefined; },
      async create() {}, async clear() { return true; }, onAlarm: event(),
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
  return { api, stores };
}

// ------------------------------------------------------------------ fixtures
const ARM = 1789000000000;
const NOW = ARM + 3600000;
const realDateNow = Date.now;
Date.now = () => NOW;          // see test_t073: a past fixture is pruned before the tick

function uuid(n) {
  const pad = String(n).padStart(4, '0');
  return pad + '0000' + '-4000' + '-8001' + '-8' + pad.slice(1) + '-' + pad + '00000000';
}

// One finished task, as the host would describe it.
function candidate(n, overrides) {
  const session = 'session-dedup-' + n;
  const startedAt = Math.floor((ARM + 60000) / 1000);
  const endedAtMs = ARM + 600000 + n * 1000;
  return {
    runId: uuid(200 + n), status: 'completed', origin: 'direct',
    nativeSession: session, nativeTurn: 700 + n,
    startedAt, endedAtMs, endedAt: Math.floor(endedAtMs / 1000), postArm: true,
    ...(overrides || {}),
  };
}

function optIn(entry, n) {
  const session = 'session-dedup-' + n;
  return {
    sessionId: session, turn: 700 + n,
    armedAt: entry.startedAtMs, consumedAt: null, settledAs: null, source: 'popup',
  };
}

function triggerState(overrides) {
  return {
    version: 1, enabled: true, armedAt: ARM, minIntervalMs: 30000,
    maxPerHour: 100, windowStartedAt: ARM, windowCount: 0,
    seen: {}, deferred: {}, preArmCandidateKeys: [],
    ...(overrides || {}),
  };
}

async function world(tag) {
  const dir = mkdtempSync(join(tmpdir(), 't095b83-' + tag + '-'));
  const ledgerRoot = join(dir, 'agents');
  writeLedger(ledgerRoot);
  const stateDir = join(dir, 'host');
  const host = startHost(stateDir, ledgerRoot);
  const hostRef = { current: host };
  const chromeMock = createChrome(hostRef);
  globalThis.chrome = chromeMock.api;
  const bg = await import(new URL('extension/background.js', ROOT).href);
  return { dir, host, chromeMock, bg };
}

// `entries` is a list of {sessionId, turn, armedAt}; candidates carry their own timing.
function seed(chromeMock, candidates, entries, overrides) {
  const optIns = {};
  for (const e of entries || []) optIns[e.sessionId + '|' + e.turn] = e;
  chromeMock.stores.local.set('terminalCandidates', candidates);
  chromeMock.stores.local.set('terminalOptIns', { version: 1, entries: optIns });
  chromeMock.stores.local.set('terminalTrigger', triggerState(overrides));
}

function journalOf(chromeMock) {
  return (chromeMock.stores.local.get('terminalTrigger') || {}).seen || {};
}

// A write counter. `verdict` decides what the adapter answers, so a lost receipt can be
// simulated without any browser.
function adapter(sink, verdict) {
  return async (c) => {
    sink.push(c.runId);
    return verdict ? verdict() : { sent: true, status: 'submitted', code: null };
  };
}

const W = await world('suite');
const { host, chromeMock, bg } = W;

// ---------------------------------------------------------------------- tests
section('T095B83/A  the same candidate offered twice is one candidate');
{
  const one = candidate(1);
  seed(chromeMock, [one, clone(one)], [{
    sessionId: one.nativeSession, turn: one.nativeTurn,
    armedAt: (one.startedAt - 30) * 1000, consumedAt: null, settledAs: null,
    source: 'popup' }]);
  const sent = [];
  await bg.runTerminalTrigger({ limit: 5, now: () => NOW, sendOnce: adapter(sent) });
  check(sent.length === 1, 'two identical entries -> one page write (' + sent.length + ')');
  check(Object.keys(journalOf(chromeMock)).length === 1, 'and one journal entry ('
    + Object.keys(journalOf(chromeMock)).length + ')');
}

section('T095B83/B  one run id reported as both completed and failed is one task');
{
  const done = candidate(2);
  const broke = candidate(2, { status: 'failed', endedAtMs: done.endedAtMs + 5000,
    endedAt: Math.floor((done.endedAtMs + 5000) / 1000) });
  seed(chromeMock, [done, broke], [{
    sessionId: done.nativeSession, turn: done.nativeTurn,
    armedAt: (done.startedAt - 30) * 1000, consumedAt: null, settledAs: null,
    source: 'popup' }]);
  const sent = [];
  await bg.runTerminalTrigger({ limit: 5, now: () => NOW, sendOnce: adapter(sent) });
  check(sent.length === 1, 'a status change is not a second notice (' + sent.length + ')');
}

section('T095B83/C  the same run id arriving down the other channel is one task');
{
  const direct = candidate(3);
  const bridge = candidate(3, {
    origin: 'bridge', status: 'completed',
    nativeSession: 'session-dedup-bridge-3', nativeTurn: 903,
    endedAtMs: direct.endedAtMs + 2000,
    endedAt: Math.floor((direct.endedAtMs + 2000) / 1000) });
  seed(chromeMock, [direct, bridge], [{
    sessionId: direct.nativeSession, turn: direct.nativeTurn,
    armedAt: (direct.startedAt - 30) * 1000, consumedAt: null, settledAs: null,
    source: 'popup' }]);
  const sent = [];
  await bg.runTerminalTrigger({ limit: 5, now: () => NOW, sendOnce: adapter(sent) });
  check(sent.length === 1, 'two sources, one run id -> one write (' + sent.length + ')');
}

section('T095B83/D  a second alarm tick over the same list writes nothing');
{
  const one = candidate(4);
  seed(chromeMock, [one], [{
    sessionId: one.nativeSession, turn: one.nativeTurn,
    armedAt: (one.startedAt - 30) * 1000, consumedAt: null, settledAs: null,
    source: 'popup' }]);
  const sent = [];
  let clock = NOW;
  const step = () => { clock += 31000; return clock; };
  await bg.runTerminalTrigger({ limit: 5, now: step, sendOnce: adapter(sent) });
  const second = await bg.runTerminalTrigger({ limit: 5, now: step, sendOnce: adapter(sent) });
  const secondWrites = ((second && second.results) || []).filter((r) => r.sent === true);
  check(sent.length === 1, 'the second tick wrote nothing (' + sent.length + ' total)');
  check(secondWrites.length === 0, 'and reported no send of its own');
}

section('T095B83/E  a send with no receipt is never recorded as sent, and is not re-sent');
{
  const one = candidate(5);
  seed(chromeMock, [one], [{
    sessionId: one.nativeSession, turn: one.nativeTurn,
    armedAt: (one.startedAt - 30) * 1000, consumedAt: null, settledAs: null,
    source: 'popup' }]);
  const sent = [];
  await bg.runTerminalTrigger({
    limit: 5, now: () => NOW,
    sendOnce: adapter(sent, () => ({ sent: false, status: 'unknown',
      code: 'page_unreachable' })),
  });
  const afterFailure = journalOf(chromeMock)[one.runId + '|completed'] || null;
  check(!(afterFailure && afterFailure.state === 'sent'),
    'a lost receipt is not journalled as sent ('
    + (afterFailure ? afterFailure.state : 'absent') + ')');
  check(Boolean(afterFailure) && afterFailure.state === 'stopped',
    'it is settled as stopped, which is what the operator is shown');

  // The rule this asserts is stricter than "try again": an unacknowledged write is
  // exactly the case where a second attempt could produce the duplicate notice this
  // whole feature exists to prevent, so the run is settled once and never re-sent.
  let clock = NOW;
  const step = () => { clock += 31000; return clock; };
  await bg.runTerminalTrigger({ limit: 5, now: step, sendOnce: adapter(sent) });
  const sentRecords = Object.values(journalOf(chromeMock))
    .filter((e) => e && e.runId === one.runId && e.state === 'sent');
  check(sent.length === 1, 'the page writer was entered exactly once in total ('
    + sent.length + ')');
  check(sentRecords.length === 0, 'and nothing claims the notice was delivered ('
    + sentRecords.length + ')');
}

section('T095B83/F  a service-worker restart does not re-send what the journal holds');
{
  const one = candidate(6);
  seed(chromeMock, [one], [{
    sessionId: one.nativeSession, turn: one.nativeTurn,
    armedAt: (one.startedAt - 30) * 1000, consumedAt: null, settledAs: null,
    source: 'popup' }]);
  const first = [];
  await bg.runTerminalTrigger({ limit: 5, now: () => NOW, sendOnce: adapter(first) });
  // A new module instance over the same storage: the worker was killed and restarted.
  const reborn = await import(new URL('extension/background.js?r=t095b83-1', ROOT).href);
  const sent = [];
  let clock = NOW;
  const step = () => { clock += 31000; return clock; };
  await reborn.runTerminalTrigger({ limit: 5, now: step, sendOnce: adapter(sent) });
  check(first.length === 1, 'the first placement happened once');
  check(sent.length === 0, 'the restarted worker wrote nothing (' + sent.length + ')');
}

section('T095B83/G  fifty candidates cannot add up to more than the one real task');
{
  const stubs = [];
  for (let i = 0; i < 49; i += 1) stubs.push(candidate(50 + i, { origin: 'direct' }));
  const real = candidate(7);
  seed(chromeMock, [...stubs, real, clone(real)], [{
    sessionId: real.nativeSession, turn: real.nativeTurn,
    armedAt: (real.startedAt - 30) * 1000, consumedAt: null, settledAs: null,
    source: 'popup' }]);
  const sent = [];
  await bg.runTerminalTrigger({ limit: 50, now: () => NOW, sendOnce: adapter(sent) });
  check(sent.length === 1, 'fifty entries, one consented duplicate -> one write ('
    + sent.length + ')');
  check(sent[0] === real.runId, 'and it is the consented run');
}

section('T095B83/H  a direct task nobody opted into is refused, and stays visible');
{
  const unwanted = candidate(8);
  seed(chromeMock, [unwanted], []);
  const sent = [];
  const tick = await bg.runTerminalTrigger({ limit: 5, now: () => NOW,
    sendOnce: adapter(sent) });
  const results = (tick && tick.results) || [];
  check(sent.length === 0, 'nothing reached the page writer (' + sent.length + ')');
  check(results.some((r) => r.code === 'direct_not_opted_in'),
    'and the refusal is reported as direct_not_opted_in');
  check(!journalOf(chromeMock)[unwanted.runId + '|completed'],
    'a refusal does not consume the run');
}

section('T095B83/I  mutation: removing the cross-status guard makes B write twice');
{
  // A copy of the extension, one guard disabled. Nothing in the repository changes.
  const dir = mkdtempSync(join(tmpdir(), 't095b83-mutant-'));
  const source = fileURLToPath(new URL('extension', ROOT));
  const copy = join(dir, 'extension');
  cpSync(source, copy, { recursive: true });
  const libPath = join(copy, 'lib', 'terminal_trigger.js');
  const original = readFileSync(libPath, 'utf8');
  const guard = 'for (const item of Object.values(s.seen)) {';
  if (!original.includes(guard)) {
    check(false, 'the guard this mutation targets is gone from terminal_trigger.js');
  } else {
    writeFileSync(libPath,
      original.replace(guard, 'for (const item of []) {'), 'utf8');
    const mutant = await import(new URL(
      'file:///' + join(copy, 'background.js').replace(/\\/g, '/') + '?r=mutant').href);
    const done = candidate(9);
    const broke = candidate(9, { status: 'failed',
      endedAtMs: done.endedAtMs + 5000,
      endedAt: Math.floor((done.endedAtMs + 5000) / 1000) });
    seed(chromeMock, [done, broke], [{
      sessionId: done.nativeSession, turn: done.nativeTurn,
      armedAt: (done.startedAt - 30) * 1000, consumedAt: null, settledAs: null,
      source: 'popup' }]);
    const sent = [];
    let clock = NOW;
    const step = () => { clock += 31000; return clock; };
    await mutant.runTerminalTrigger({ limit: 5, now: step, sendOnce: adapter(sent) });
    check(sent.length === 2,
      'with the guard removed the same task is written twice (' + sent.length
      + '), so B is not a test that can only be green');
  }
}

W.host.stop();
Date.now = realDateNow;
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
