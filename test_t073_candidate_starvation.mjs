// T073 regression: a consented candidate must not be starved by un-consented ones.
//
// The production failure this locks down: an operator clicked "notify me when this
// finishes" on a *running* task, the popup recorded it, the task ended, the host produced
// the candidate with the correct millisecond end instant -- and no notice was written.
//
// The candidate was never wrong. It sat at the end of a 50-entry local list while
// `runTerminalTrigger` walked `fresh.slice(0, limit)` with `limit` defaulting to 3. The
// first three entries were channel-B candidates nobody had opted into: `admit` refuses
// them with `direct_not_opted_in`, which -- by design -- neither journals them nor drops
// them from the list. So the same three were re-refused on every tick, forever, and the
// consented candidate behind them was never reached.
//
// The invariant: the per-tick budget bounds *page work*, not *inspection*. A candidate
// that cannot be admitted costs nothing to look at, so it must not consume the budget.
//
// Real host, real background.js, only Chrome mocked. Nothing here touches a page.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const ORIGIN = 'chrome-extension://t073-starvation/';
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
  const dir = join(ledgerRoot, 'c'.repeat(64));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'endpoint.json.runs.json'), '[]', 'utf8');
}

function startHost(stateDir, ledgerRoot) {
  if (!ledgerRoot) throw new Error('startHost requires a temporary ledgerRoot');
  const cwd = fileURLToPath(ROOT);
  mkdirSync(stateDir, { recursive: true });
  const manifestPath = join(stateDir, 'host_manifest.e2e.json');
  writeFileSync(manifestPath, JSON.stringify({
    name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN],
  }, null, 2), 'utf8');
  const fixturePath = join(stateDir, 'bridge-origin.fixture.json');
  writeFileSync(fixturePath, JSON.stringify({ version: 1, bridge: [] }), 'utf8');
  // An empty native root: this suite's channel-B candidates are seeded into storage, so
  // the host must not discover any of its own (and must not read live sessions).
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
  // One reader for the whole process. Attaching a listener per `port()` would let two
  // ports consume the same bytes and would lose frames spliced across chunks.
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
const ARM = 1789000000000;                  // trigger armed
const NOW = ARM + 3600000;                  // one tick, an hour later

// Freeze the wall clock. `readOptIns` -> `normalizeOptIns(doc)` defaults its `now` to
// `Date.now()`, so a fixture positioned in the past is pruned as expired before the tick
// ever sees it -- the consent silently disappears and every candidate then looks
// un-consented, which is a convincing but entirely fictional failure. Freezing the clock
// is what makes the fixture's timing mean what it says.
const realDateNow = Date.now;
const frozenNow = () => NOW;
Date.now = frozenNow;

// A run id the extension will accept. `admit` validates the canonical UUID shape, so
// each group has to satisfy its own constraint -- notably the fourth, which must begin
// with one of 8/9/a/b.
function uuid(n) {
  const pad = String(n).padStart(4, '0');
  return pad + '0000'            // 8 hex
    + '-4000'                    // 4 hex
    + '-8001'                    // 4 hex, first char 1-8
    + '-8' + pad.slice(1)        // 4 hex, first char 8-9-a-b
    + '-' + pad + '00000000';    // 12 hex
}

// A channel-B candidate the operator never clicked. `admit` refuses it with
// `direct_not_opted_in`, which is not a journal event and not a drain.
function unConsentedCandidate(index) {
  const startedAt = Math.floor((ARM + 60000 * index) / 1000);
  return {
    runId: uuid(index + 1), status: 'completed', origin: 'direct',
    nativeSession: 'session-unwanted-' + index, nativeTurn: index,
    startedAt,
    endedAtMs: ARM + 600000 + index * 1000,
    endedAt: Math.floor((ARM + 600000 + index * 1000) / 1000),
    postArm: true,
  };
}

// The one the operator opted into while it was running: clicked 30 s after it started,
// which is strictly before its own end instant.
function consentedCandidate(index, turn) {
  const session = 'session-wanted-' + index;
  const startedAt = Math.floor((ARM + 60000 * index) / 1000);
  const endedAtMs = ARM + 600000 + index * 1000;
  return {
    candidate: {
      runId: uuid(index + 100), status: 'completed', origin: 'direct',
      nativeSession: session, nativeTurn: turn,
      startedAt,
      endedAtMs, endedAt: Math.floor(endedAtMs / 1000),
      postArm: true,
    },
    entry: {
      sessionId: session, turn, armedAt: startedAt * 1000 + 30000,
      consumedAt: null, settledAs: null, source: 'popup',
    },
  };
}

// `minIntervalMs` defaults to the production 30 s between notices. Scenario B needs it
// out of the way: it is testing the per-tick budget, and with a 30 s floor on the clock
// a tick that writes three candidates would report a `rate_limited` refusal instead --
// a true answer to a different question.
function triggerState(overrides) {
  return {
    version: 1, enabled: true, armedAt: ARM, minIntervalMs: 30000,
    maxPerHour: 100, windowStartedAt: ARM, windowCount: 0,
    seen: {}, deferred: {}, preArmCandidateKeys: [],
    ...(overrides || {}),
  };
}

async function world(tag) {
  const dir = mkdtempSync(join(tmpdir(), 't073-' + tag + '-'));
  const ledgerRoot = join(dir, 'agents');
  writeLedger(ledgerRoot);
  const stateDir = join(dir, 'host');
  const host = startHost(stateDir, ledgerRoot);
  const hostRef = { current: host };
  const chromeMock = createChrome(hostRef);
  globalThis.chrome = chromeMock.api;
  const bg = await import(new URL('extension/background.js', ROOT).href);
  return { dir, host, chromeMock, bg, nativeRoot: join(stateDir, 'native-sessions') };
}

function seed(chromeMock, candidates, entries, overrides) {
  chromeMock.stores.local.set('terminalCandidates', candidates);
  chromeMock.stores.local.set('terminalOptIns', { version: 1, entries: entries || {} });
  chromeMock.stores.local.set('terminalTrigger', triggerState(overrides));
}

// ------------------------------------------------------------ native log writer
// The host discovers channel B by reading DSH's own session logs, so the only way to
// make it *offer* a candidate is to write one. This is the same format T068 uses.
function rec(kind, seq, timeMs, data) {
  return JSON.stringify({ type: kind, seq, time: timeMs, data });
}
function writeNativeLog(nativeRoot, session, workspace, records) {
  const dir = join(nativeRoot, workspace, session);
  mkdirSync(dir, { recursive: true });
  const body = Buffer.from(records.join('\n') + '\n', 'utf8');
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(body));
}

// One host for the whole suite. `native_client` opens its connection once and reuses it,
// so a second host would never be spoken to -- a fact worth encoding here rather than
// discovering as an inexplicable empty answer.
const W = await world('suite');
const { host, chromeMock, bg } = W;

// ---------------------------------------------------------------------- tests
section('T073/A  a consented candidate behind un-consented ones is still delivered');
{
  const stale = [0, 1, 2, 3].map(unConsentedCandidate);
  const wanted = consentedCandidate(4, 404);
  // The consented one goes LAST, exactly as it did in production: the list is
  // append-ordered, so a fresh completion always lands behind the backlog.
  seed(chromeMock, [...stale, wanted.candidate], {
    [wanted.entry.sessionId + '|' + wanted.entry.turn]: wanted.entry });
  const sent = [];
  const tick = await bg.runTerminalTrigger({
    limit: 3, now: () => NOW,
    sendOnce: async (candidate) => {
      sent.push(candidate.runId);
      return { sent: true, status: 'submitted', code: null };
    },
  });
  const results = (tick && tick.results) || [];
  const refusals = results.filter((r) => r.code === 'direct_not_opted_in');
  const journal = (chromeMock.stores.local.get('terminalTrigger') || {}).seen || {};
  const journalEntry = journal[wanted.candidate.runId + '|completed'];

  check(sent.length === 1, 'exactly one candidate reached the page writer ('
    + sent.length + ')');
  check(sent[0] === wanted.candidate.runId,
    'and it is the one the operator opted into');
  check(Boolean(journalEntry), 'the journal records the attempt');
  check(Boolean(journalEntry) && journalEntry.state === 'sent',
    'and records it as sent');
  check(Boolean(journalEntry) && journalEntry.consent === 'running_opt_in',
    'with the running consent as its authority');
  check(!sent.includes(stale[0].runId) && !sent.includes(stale[1].runId),
    'no un-consented candidate was written');
  // The refusals must still be *visible*: the popup reads `results` to explain why
  // something was not delivered, and a fix that hid them would trade one blind spot
  // for another.
  check(refusals.length === 4,
    'all four un-consented candidates were still inspected and reported ('
    + refusals.length + ')');
}

section('T073/B  the budget still bounds real page work, not inspection');
{
  // Four consented candidates, all admissible. With limit 3 the tick must write three
  // and leave the fourth for the next tick -- the bound exists so a burst of
  // completions cannot turn into a burst of page writes.
  const wanted = [0, 1, 2, 3].map((i) => consentedCandidate(i, 500 + i));
  const entries = {};
  for (const w of wanted) entries[w.entry.sessionId + '|' + w.entry.turn] = w.entry;
  seed(chromeMock, wanted.map((w) => w.candidate), entries);
  const sent = [];
  // The 30 s spacing between notices is a floor, not a preference: `minIntervalMs` is
  // clamped up to `MIN_INTERVAL_FLOOR_MS`, so a fixed clock can only ever produce one
  // write per tick and would measure the rate limiter instead of the budget. The clock
  // therefore steps forward on every read. It has to step on `settle` too -- that call
  // is what records `lastSentAt`, so advancing only inside `sendOnce` would set the
  // stamp to the very instant the next candidate is checked and refuse it.
  let clock = NOW;
  const stepClock = () => { clock += 31000; return clock; };
  const tick = await bg.runTerminalTrigger({
    limit: 3, now: stepClock,
    sendOnce: async (candidate) => {
      sent.push(candidate.runId);
      return { sent: true, status: 'submitted', code: null };
    },
  });
  check(sent.length === 3, 'four admissible candidates, limit 3 -> three writes ('
    + sent.length + ')');
}

section('T073/C  one slot is enough when the backlog cannot be admitted');
{
  const stale = [0, 1, 2, 3, 4, 5].map(unConsentedCandidate);
  const wanted = consentedCandidate(9, 909);
  seed(chromeMock, [...stale, wanted.candidate], {
    [wanted.entry.sessionId + '|' + wanted.entry.turn]: wanted.entry });
  const sent = [];
  // limit 1: a single unit of page work. Six un-admittable candidates stand in
  // front of the consented one and must cost none of it.
  await bg.runTerminalTrigger({
    limit: 1, now: () => NOW,
    sendOnce: async (candidate) => {
      sent.push(candidate.runId);
      return { sent: true, status: 'submitted', code: null };
    },
  });
  check(sent.length === 1, 'the consented candidate was reached at limit 1 ('
    + sent.length + ')');
  check(sent[0] === wanted.candidate.runId, 'and it is the right one');
}

section('T073/D  a refusal that cannot change is not retried as work, but stays visible');
{
  const stale = [0, 1, 2].map(unConsentedCandidate);
  const wanted = consentedCandidate(5, 505);
  seed(chromeMock, [...stale, wanted.candidate], {
    [wanted.entry.sessionId + '|' + wanted.entry.turn]: wanted.entry });
  const send = async () => ({ sent: true, status: 'submitted', code: null });
  const first = await bg.runTerminalTrigger({ limit: 3, now: () => NOW, sendOnce: send });
  // Same clock, nothing changed: the second tick must not write again, and must
  // still be able to describe the backlog.
  const second = await bg.runTerminalTrigger({ limit: 3, now: () => NOW, sendOnce: send });
  const secondSent = ((second && second.results) || [])
    .filter((r) => r.sent === true);
  check(secondSent.length === 0,
    'a second tick does not write the same completion twice (' + secondSent.length + ')');
  check(((first && first.results) || []).length > 0, 'the first tick reported work');
}

section('T073/E  the operator\'s own path: real host offers it, real intake queues it');
{
  // Everything above seeds storage directly, which proves the tick but skips intake.
  // This scenario is the production path end to end: a DSH session log that really
  // ends, the real host discovering it, the real `refreshTerminalCandidates` admitting
  // it against a *full* backlog, and the real tick delivering it.
  //
  // It is also the only scenario that can fail for the second defect: with 50
  // un-consented entries in the list, `room` used to be 0, so the host could offer this
  // completion every 30 s for ever and it would never be stored -- and therefore never
  // inspected, never consented, never sent.
  Date.now = realDateNow;
  try {
    const now = realDateNow();
    const startMs = now - 10 * 60 * 1000;      // the task began ten minutes ago
    const endMs = now - 5 * 60 * 1000;         // and finished five minutes ago
    const session = 'session-073e-4444-4555-8666-777777777777';
    const turn = 777;
    const workspace = '--E-ApkTest-T073--';
    writeNativeLog(W.nativeRoot, session, workspace, [
      rec('turn/start', 1, startMs, { turn }),
      rec('tool/call', 2, startMs + 60000, { turn, payload: {} }),
      rec('turn/end', 3, endMs, { turn, reason: { kind: 'completed' } }),
    ]);

    // The backlog: a full list of channel-B completions nobody ever opted into.
    const backlog = [];
    for (let i = 0; i < 50; i += 1) backlog.push(unConsentedCandidate(200 + i));
    // The operator's click, made while the task was running.
    const optedIn = {
      sessionId: session, turn, armedAt: startMs + 60000,
      consumedAt: null, settledAs: null, source: 'popup',
    };
    seed(chromeMock, backlog, { [session + '|' + turn]: optedIn });
    const sent = [];
    const tick = await bg.runTerminalTrigger({
      limit: 3, now: realDateNow,
      sendOnce: async (candidate) => {
        sent.push(candidate.nativeSession + '|' + candidate.nativeTurn);
        return { sent: true, status: 'submitted', code: null };
      },
    });
    const stored = chromeMock.stores.local.get('terminalCandidates') || [];
    const added = tick && tick.fetched ? tick.fetched.added : null;
    // Intake is what the second defect broke, and `added` is its own counter: the
    // entry is consumed from storage the moment the notice is written, so looking for
    // it there afterwards would check the wrong instant.
    check(added === 1, 'the completion was admitted by intake through a full backlog ('
      + added + ')');
    check(stored.length <= 50, 'the list stayed within its bound (' + stored.length + ')');
    check(sent.length === 1, 'and exactly one notice was written (' + sent.length + ')');
    check(sent[0] === session + '|' + turn,
      'for the task the operator opted into');
  } finally {
    Date.now = frozenNow;
  }
}

console.log('');
Date.now = realDateNow;
console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
