// T065: offline end-to-end test of the automatic-notification chain.
//
// Real local host process (temporary state dir, never the live one), mock Chrome
// API, and a *test double* for the page writer. Nothing here opens a tab, reads a
// page, or can reach ChatGPT: `write()` is a stub whose behaviour each scenario
// declares.
//
// Chain covered:
//   ledger terminal run
//     -> terminal-list (sample + baseline)
//     -> candidate storage
//     -> terminal-ack
//     -> trigger admit
//     -> send gate
//     -> adapter (stub)
//     -> receipt / journal
// Plus the failure modes: host offline then reconnecting, ACK failure and retry,
// duplicate terminal events, navigation during the chain, a busy composer, MV3
// worker restart, and authorization expiry.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}

// ---------------------------------------------------------------- mock chrome
function createChrome() {
  const store = new Map();
  const sent = [];
  const api = {
    storage: {
      local: {
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
      },
    },
    runtime: { id: 'test-extension', getURL: (p) => 'chrome-extension://t/' + p },
    tabs: { async query() { return []; }, async get() { return null; },
      async sendMessage() { throw new Error('no content script'); } },
  };
  return { api, store, sent };
}
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ------------------------------------------------------------- real host driver
// Speaks the real wire format (4-byte little-endian length prefix + JSON), in a
// real child process pointed at a temporary state dir. Nothing here is a mock of
// the host: the baseline semantics, the ACK cursor and its durability are the
// shipped code paths.
const ORIGIN = 'chrome-extension://t065-e2e/';

function startHost(stateDir, ledgerRoot) {
  // Hard stop rather than a default: without an explicit root the host would
  // sample the production AgentState, which this suite must never touch. Making
  // it an error means a forgotten fixture fails loudly instead of silently
  // reading the operator's real ledger.
  if (!ledgerRoot) {
    throw new Error('startHost requires a temporary ledgerRoot; '
      + 'refusing to let the host fall back to the production AgentState');
  }
  const cwd = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1');
  // The host refuses to serve without a caller origin that its manifest allows
  // (there is deliberately no "no origin means allow" branch), so the fixture
  // supplies both -- a throwaway manifest in the temp dir, never the real one.
  const manifestPath = join(stateDir, 'host_manifest.e2e.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({
    name: 'com.dsh.notify', type: 'stdio', allowed_origins: [ORIGIN],
  }, null, 2), 'utf8');
  // T067: this suite exercises channel A (Bridge-dispatched, auto-notified), so it
  // declares every run in its ledger as bridge-dispatched. Channel B and the
  // unprovable case are covered by test_t067_ab_origin.mjs with an explicit list.
  const originFixturePath = join(stateDir, 'bridge-origin.fixture.json');
  writeFileSync(originFixturePath, JSON.stringify({ version: 1, bridge: '*' }),
    'utf8');
  // T067R: this suite is about channel A. The host also reads DSH's own session
  // logs to discover channel B, so point that at an empty directory -- otherwise
  // the operator's live sessions would leak into a hermetic fixture.
  const nativeRoot = join(stateDir, 'native-sessions');
  mkdirSync(nativeRoot, { recursive: true });
  const args = ['-B', 'host.py', ORIGIN, '--state-dir', stateDir,
    '--ledger-root', ledgerRoot, '--manifest', manifestPath,
    '--bridge-db-fixture', originFixturePath,
    '--native-root', nativeRoot];
  const host = spawn(process.env.PYTHON || 'python', args,
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  const waiters = new Map();
  let nextId = 0;
  let stderr = '';
  host.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  host.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.slice(4, 4 + length).toString('utf8');
      buffer = buffer.slice(4 + length);
      let doc;
      try { doc = JSON.parse(body); } catch (_e) { continue; }
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
    host,
    get stderr() { return stderr; },
    async send(op, args) {
      const id = 'req-' + (nextId += 1);
      // Exact envelope the extension sends: `v` is mandatory, and a request
      // without it is refused with version_mismatch. Sending a bare {id,op} here
      // would have tested a protocol the host does not actually accept.
      const doc = { v: 1, id, op, args: args || {} };
      const answer = new Promise((resolve) => waiters.set(id, resolve));
      host.stdin.write(frame(doc));
      return Promise.race([
        answer,
        new Promise((_r, reject) => setTimeout(() =>
          reject(new Error('host timeout on ' + op + ' stderr=' + stderr)), 15000)),
      ]);
    },
    async sendRaw(doc) {
      const answer = new Promise((resolve) => waiters.set(doc.id, resolve));
      host.stdin.write(frame(doc));
      return Promise.race([
        answer,
        new Promise((_r, reject) => setTimeout(() =>
          reject(new Error('host timeout on raw ' + doc.op)), 15000)),
      ]);
    },
    stop() { try { host.kill(); } catch (_e) { /* already gone */ } },
  };
}

function newStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 't065-e2e-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The ledger does not sit at the AgentState root: it lives one hash-named
// directory down, as `<root>/<sha256>/endpoint.json.runs.json`, holding a JSON
// array of runs. The host samples that exact layout, so the fixture writes it.
//
// A run's real fields are `requestID` (string) and `createdAt` (numeric ms).
// `read_runs` refuses anything else and reports `source_unavailable`, which is
// how an earlier version of this fixture failed: it wrote `runId`/`startedAt`
// and the host correctly rejected every run.
const BASE_CREATED_AT = 1767225600000;      // 2026-01-01T00:00:00Z

function useLedger(ledgerRoot) {
  return { dir: join(ledgerRoot, 'a'.repeat(64)) };
}

function writeRuns(ledgerRoot, runs) {
  const { dir } = useLedger(ledgerRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'endpoint.json.runs.json');
  const document = runs.map((run, index) => ({
    requestID: run.id,
    status: run.status,
    createdAt: Number.isFinite(run.createdAt)
      ? run.createdAt : BASE_CREATED_AT + index * 1000,
  }));
  writeFileSync(file, JSON.stringify(document, null, 2), 'utf8');
  return file;
}

function runRecord(id, status, createdAt) {
  return { id, status, createdAt };
}

async function main() {
  const ledger = await mod('./extension/lib/terminal_trigger.js');
  const autosend = await mod('./extension/lib/autosend.js');
  const chain = await mod('./extension/lib/chain_status.js');

  // ---------------------------------------------------------------- fixture
  const CONV = '3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071';
  const URL_OK = 'https://chatgpt.com/c/' + CONV;
  // Both arming phrases are the prefix plus the *conversation id* -- not a tab
  // id, not a free-form word. `arm`/`configure` compare the string exactly, and
  // a mismatch leaves the feature disabled rather than erroring loudly later.
  const ARM_PHRASE = 'AUTOSEND ' + CONV;
  const TRIGGER_PHRASE = 'AUTOTRIGGER ' + CONV;

  function binding(overrides = {}) {
    return Object.assign({
      tabId: 11, windowId: 4, revision: 3, url: URL_OK,
      conversationId: CONV, documentInstanceId: 'instance-abcdefghijkl',
      manuallyConfirmed: true, invalidatedReason: null,
    }, overrides);
  }

  // A probe that passes every gate. Individual scenarios break one field.
  function probe(overrides = {}) {
    return Object.assign({
      ok: true, tabId: 11, windowId: 4, url: URL_OK, conversationId: CONV,
      documentInstanceId: 'instance-abcdefghijkl', pageLoaded: true,
      composerPresent: true, hasFocus: true, active: true,
      visibilityState: 'visible', discarded: false, frozen: false,
      frozenStateKnown: true, frozenStateSource: 'live_probe',
      routeStable: true,
    }, overrides);
  }

  // Every gate here runs on a synthetic clock (1_000_000 and up), but `decide`
  // also refuses a probe older than PROBE_MAX_AGE_MS. Stamping the probe with
  // Date.now() put it decades in the future, so every send came back
  // `probe_stale` and nothing downstream ever ran. This shim stamps the probe on
  // the same clock as the decision; a scenario that tests staleness still passes
  // its own `observedAt`, which is left untouched.
  function decide(state, input, now) {
    const next = Object.assign({}, input);
    if (next.probe && next.probe.observedAt === undefined) {
      next.probe = Object.assign({}, next.probe, { observedAt: now - 1_000 });
    }
    return autosend.decide(state, next, now);
  }

  // ------------------------------------------------ layer 1+2: real host, real
  // temporary state, real baseline semantics.
  console.log('== T065: ledger terminal run -> terminal-list -> candidates ==');
  {
    const dir = newStateDir();
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, [
      { id: '11111111-1111-4111-8111-111111111111', status: 'completed' },
      { id: '22222222-2222-4222-8222-222222222222', status: 'failed' },
    ]);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    try {
      const hello = await h.send('hello');
      check(hello.ok === true, 'host answers hello');
      check(hello.result && hello.result.deliver === false,
        'and still refuses to deliver');

      const first = await h.send('terminal-list');
      check(first.ok === true, 'terminal-list answers');
      const sample = first.result;
      check(sample.baselineEstablished === true,
        'the first sample establishes the baseline');
      check(sample.existingTerminalRuns === 2,
        'and absorbs the 2 pre-existing terminal runs (' + sample.existingTerminalRuns + ')');
      check(Array.isArray(sample.candidates) && sample.candidates.length === 0,
        'producing no candidates, so history is never replayed');

      // A new terminal run after the baseline IS a candidate.
      writeRuns(ledgerRoot, [
        { id: '33333333-3333-4333-8333-333333333333', status: 'completed' },
      ]);
      const second = await h.send('terminal-list');
      const again = second.result;
      check(again.baselineEstablished === false,
        'a later sample does not re-baseline');
      check(again.candidates.length === 1 &&
        again.candidates[0].runId === '33333333-3333-4333-8333-333333333333',
        'and offers exactly the new run (' + again.candidates.length + ')');

      // Duplicate suppression is on the producer side too.
      const third = await h.send('terminal-list');
      check(third.result.candidates.length === 1 &&
        third.result.redelivered === 1,
        'an unacked candidate is re-offered, marked as redelivered (' +
        third.result.redelivered + ')');

      const ack = await h.send('terminal-ack', {
        acked: ['33333333-3333-4333-8333-333333333333'],
      });
      check(ack.ok === true && ack.result.acked === 1, 'terminal-ack accepts it');

      const fourth = await h.send('terminal-list');
      check(fourth.result.candidates.length === 0,
        'and the acknowledged run is not offered again');

      // Gap check: the ACK moved the cursor, so a re-run of the same id is not new.
      writeRuns(ledgerRoot, [
        { id: '33333333-3333-4333-8333-333333333333', status: 'completed' },
      ]);
      const fifth = await h.send('terminal-list');
      check(fifth.result.candidates.length === 0,
        're-writing an already-acked run produces nothing');
    } finally { h.stop(); rmSync(dir, { recursive: true, force: true }); }
  }

  console.log('== T065: ACK failure is retried, not lost ==');
  {
    const dir = newStateDir();
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    try {
      await h.send('terminal-list');          // establish baseline
      writeRuns(ledgerRoot, [
        { id: '44444444-4444-4444-8444-444444444444', status: 'completed' },
      ]);
      const offered = await h.send('terminal-list');
      check(offered.result.candidates.length === 1, 'candidate offered');

      // Simulate the ACK never arriving: ask again without acking.
      const retried = await h.send('terminal-list');
      check(retried.result.candidates.length === 1,
        'still offered while unacked');
      check(retried.result.redelivered === 1, 'flagged as a redelivery');

      // Now ack, and confirm it stops.
      await h.send('terminal-ack', { acked: ['44444444-4444-4444-8444-444444444444'] });
      const settled = await h.send('terminal-list');
      check(settled.result.candidates.length === 0, 'ack clears it permanently');

      // A malformed ACK must not clear anything.
      writeRuns(ledgerRoot, [
        { id: '55555555-5555-4555-8555-555555555555', status: 'completed' },
      ]);
      await h.send('terminal-list');
      const badAck = await h.send('terminal-ack', { acked: 'not-an-array' });
      check(badAck.ok === false || badAck.result.acked === 0,
        'a malformed ACK is refused');
      const survives = await h.send('terminal-list');
      check(survives.result.candidates.length === 1,
        'and the candidate survives bad ACK input');
    } finally { h.stop(); rmSync(dir, { recursive: true, force: true }); }
  }

  console.log('== T065: host restart keeps the ACK cursor ==');
  {
    const dir = newStateDir();
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    let h = startHost(join(dir, 'host'), ledgerRoot);
    try {
      await h.send('terminal-list');
      writeRuns(ledgerRoot, [
        { id: '66666666-6666-4666-8666-666666666666', status: 'completed' },
      ]);
      const offered = await h.send('terminal-list');
      await h.send('terminal-ack', { acked: [offered.result.candidates[0].runId] });
      h.stop();

      // A fresh process reading the same state dir: the cursor is durable.
      h = startHost(join(dir, 'host'), ledgerRoot);
      const after = await h.send('terminal-list');
      check(after.result.candidates.length === 0,
        'an acked run stays acked across a host restart');
      check(after.result.baselineEstablished === false,
        'and the baseline is durable too');
    } finally { h.stop(); rmSync(dir, { recursive: true, force: true }); }
  }

  console.log('== T065: host offline is reported, not fabricated ==');
  {
    const dir = newStateDir();
    const ledgerRoot = join(dir, 'agents');
    const h = startHost(join(dir, 'host'), ledgerRoot);
    h.stop();
    // Give the process a moment to die so the next request cannot answer.
    await new Promise((r) => setTimeout(r, 120));
    let replied = null;
    try {
      replied = await Promise.race([
        h.send('hello'),
        new Promise((r) => setTimeout(() => r(null), 400)),
      ]);
    } catch (_err) { replied = null; }
    check(replied === null || replied === undefined,
      'a dead host produces no reply rather than a stale one');
    // And the summary says "unknown", not "ok". A host that never answered is
    // unknown, not blocked: nothing was observed either way, and calling it
    // blocked would be a claim the self-check cannot support.
    const report = chain.summariseChain({ hello: null, terminalList: null,
      bindingHealth: null, autoSendState: null, triggerState: null,
      candidates: { candidates: [] } }, Date.now());
    check(report.stages.hostOnline === 'unknown',
      'the report marks the host layer unknown, not ok');
    check(report.layers.hostOnline.reason === 'no_host_reply',
      'and says why: no reply at all');
    check(report.stage !== 'ready', 'and never calls the chain ready');
    rmSync(dir, { recursive: true, force: true });
  }

  // ------------------------------------------------- layer 3: authorization
  console.log('== T065: authorization expiry blocks, it does not pass through ==');
  {
    let state = autosend.createAutoSendState();
    const armed = autosend.arm(state, { binding: binding(), ttlMs: 60000,
      maxSends: 2 }, ARM_PHRASE, true, 1_000_000);
    check(armed.result.ok === true, 'arming works with a user gesture');
    state = armed.state;
    const decided = decide(state, { binding: binding(),
      probe: probe(), runId: 'r-1', status: 'completed' }, 1_030_000);
    check(decided.send === true, 'send allowed while valid');
    const expired = decide(state, { binding: binding(),
      probe: probe(), runId: 'r-2', status: 'completed' }, 1_200_000);
    check(expired.send === false && /expired|expir/i.test(expired.code || ''),
      'and refused after expiry (' + expired.code + ')');

    const layer = chain.authorizationLayer(state, 1_200_000);
    check(layer.authorized.value === false, 'the summary marks it unauthorized');
    check(layer.authorized.expired === true, 'and says expiry, not "off"');
    check(layer.authorized.remainingMs === 0, 'with zero time remaining');
  }

  console.log('== T065: send budget exhaustion blocks ==');
  {
    let state = autosend.createAutoSendState();
    state = autosend.arm(state, { binding: binding(), ttlMs: 600000, maxSends: 1 },
      ARM_PHRASE, true, 1_000_000).state;
    const first = decide(state, { binding: binding(), probe: probe(),
      runId: 'r-1', status: 'completed' }, 1_010_000);
    check(first.send === true, 'first send allowed');
    const marked = autosend.recordAttempt(state, { runId: 'r-1', status: 'completed' , origin: 'bridge'}, 1_010_000);
    const done = autosend.settle(marked.state, 'r-1|completed',
      { status: 'submitted', evidence: { receipt: 'ok' } }, 1_011_000);
    const second = decide(done.state, { binding: binding(), probe: probe(),
      runId: 'r-2', status: 'completed' }, 1_020_000);
    check(second.send === false, 'second send refused after the budget is used');
    const layer = chain.authorizationLayer(done.state, 1_020_000);
    check(layer.authorized.exhausted === true, 'and the summary says exhausted');
    check(layer.authorized.remainingSends === 0, 'with zero remaining');
  }

  console.log('== T065: display-only records never become sendable ==');
  {
    // The received store is deliverable:false by construction; the only path to a
    // write is an explicit candidate. `autosend.decide` is status-agnostic -- it
    // only keys its journal by runId|status -- so the status gate is not there
    // and must be proven where it actually lives, in `terminal_trigger.admit`.
    const trig = ledger.configure(ledger.createTriggerState(),
      { minIntervalMs: 30000, maxPerHour: 6, binding: binding() },
      TRIGGER_PHRASE, true, 1_000_000).state;
    const verdict = ledger.admit(trig,
      { runId: 'c0000001-0000-4000-8000-000000000001', status: 'interrupted' , origin: 'bridge'},
      1_010_000);
    check(verdict.admit === false,
      'an unknown/non-terminal status is refused (' + verdict.code + ')');
    check(verdict.code === 'status_not_terminal',
      'and named as a non-terminal status');
  }

  // --------------------------------------------------- the full happy chain
  console.log('== T065: full chain, ledger to receipt ==');
  {
    const dir = newStateDir();
    const ledgerRoot = join(dir, 'agents');
    writeRuns(ledgerRoot, []);
    const h = startHost(join(dir, 'host'), ledgerRoot);
    try {
      const chromeMock = createChrome();

      // --- producer: baseline, then a real terminal run
      await h.send('terminal-list');
      writeRuns(ledgerRoot, [
        { id: '77777777-7777-4777-8777-777777777777', status: 'completed' },
      ]);
      const sample = (await h.send('terminal-list')).result;
      check(sample.candidates.length === 1, 'one candidate from the ledger');

      // --- candidate storage (what background.js does)
      const stored = await chromeMock.api.storage.local.get({ terminalCandidates: [] });
      // T067R: this stand-in has to mirror what `refreshTerminalCandidates` stores.
      // It used to copy only runId/status, which silently dropped the channel -- so
      // the candidate reaching `admit` had no origin and every assertion after this
      // point was testing a shape the product never writes.
      const merged = stored.terminalCandidates.concat(
        sample.candidates.map((c) => {
          const entry = { runId: c.runId, status: c.status };
          if (c.startedAt) entry.startedAt = c.startedAt;
          if (c.origin) entry.origin = c.origin;
          if (Number.isInteger(c.nativeTurn)) entry.nativeTurn = c.nativeTurn;
          if (c.nativeSession) entry.nativeSession = c.nativeSession;
          return entry;
        }));
      await chromeMock.api.storage.local.set({ terminalCandidates: merged });
      const readBack = await chromeMock.api.storage.local.get({ terminalCandidates: [] });
      check(readBack.terminalCandidates.length === 1, 'candidate persisted');

      // --- ACK, only after the write is verified present
      const persisted = new Set(readBack.terminalCandidates.map((c) =>
        ledger.key(c.runId, c.status)));
      const ackable = sample.candidates.filter((c) =>
        persisted.has(ledger.key(c.runId, c.status)));
      check(ackable.length === 1, 'only persisted candidates are ackable');
      const ack = await h.send('terminal-ack', { acked: ackable.map((c) => c.runId) });
      check(ack.result.acked === 1, 'ACK accepted');

      // --- trigger admission
      let trig = ledger.createTriggerState();
      const configured = ledger.configure(trig, { minIntervalMs: 30000,
        maxPerHour: 6, binding: binding() }, TRIGGER_PHRASE, true, 1_000_000);
      check(configured.result.ok === true, 'trigger configured');
      trig = configured.state;

      const candidate = readBack.terminalCandidates[0];
      const admitted = ledger.admit(trig, candidate, 1_060_000);
      check(admitted.admit === true,
        'trigger admits the candidate (' + JSON.stringify({
          code: admitted.code, origin: candidate.origin,
          status: candidate.status, postArm: candidate.postArm,
        }) + ')');
      // `admit` only says "no reason to hold it" and returns a key, not a state.
      // The write-ahead entry comes from `markAttempt`, and `settle` refuses
      // anything that is not `attempting` -- so this step cannot be skipped.
      const trigMarked = ledger.markAttempt(trig, candidate, 1_060_000);

      // --- send gate
      let auto = autosend.arm(autosend.createAutoSendState(),
        { binding: binding(), ttlMs: 3_600_000, maxSends: 5 }, ARM_PHRASE,
        true, 1_050_000).state;
      const verdict = decide(auto, { binding: binding(), probe: probe(),
        runId: candidate.runId, status: candidate.status }, 1_060_000);
      check(verdict.send === true, 'gate allows the write');

      // --- adapter (STUB: no page is touched)
      const written = autosend.recordAttempt(auto, candidate, 1_060_000);
      // One stub receipt feeds two different consumers, and they do not read the
      // same field: `autosend.settle` treats `status: 'submitted'` as a confirmed
      // write, while `terminal_trigger.settle` checks `sent === true`. A shared
      // object therefore has to carry both; feeding either one the other's field
      // silently reads as "not confirmed" and stops the trigger.
      const writeOutcome = {
        status: 'submitted',
        sent: true,
        evidence: { receipt: 'stub-receipt', composerMatched: true },
      };
      const settled = autosend.settle(written.state, ledger.key(candidate.runId,
        candidate.status), writeOutcome, 1_061_000);
      check(settled.result.ok === true, 'receipt settles the attempt');

      const delivery = chain.deliveryLayer(settled.state);
      check(delivery.delivered.value === true, 'the chain reports a confirmed write');
      check(delivery.delivered.confirmedSends === 1, 'exactly one confirmed send');
      check(delivery.needsHumanReview === false, 'with nothing left ambiguous');

      // --- trigger bookkeeping matches
      const trigSettled = ledger.settle(trigMarked.state,
        trigMarked.key, writeOutcome, 1_061_000);
      check(trigSettled.result.ok === true, 'trigger records the same success');

      // --- the summary now shows the whole line green
      const report = chain.summariseChain({
        hello: { ok: true, host: 'com.dsh.notify', hostVersion: '1.0.0',
          protocolVersion: 1, capabilities: { deliver: false } },
        terminalList: { ok: true, baselineEstablished: false, candidates: [] },
        bindingHealth: { ok: true, status: 'bound_healthy', binding: binding(),
          visibilityState: 'visible', hasFocus: true, frozen: false,
          frozenStateKnown: true },
        autoSendState: settled.state,
        triggerState: trigSettled.state,
        candidates: { candidates: [], lastPoll: { at: 1_060_000, added: 1, acked: 1, ok: true } },
      }, 1_062_000);
      check(report.stage === 'ready', 'and every layer reads ok (' + report.stage + ')');
      check(report.sendEligible === false,
        'while sendEligible stays false: the self-check never sends');
      check(report.deliveredMessage === false, 'and claims no message of its own');
    } finally { h.stop(); rmSync(dir, { recursive: true, force: true }); }
  }

  // ------------------------------------------------------------- failure modes
  console.log('== T065: duplicate terminal event is not sent twice ==');
  {
    let auto = autosend.arm(autosend.createAutoSendState(),
      { binding: binding(), ttlMs: 3_600_000, maxSends: 5 }, ARM_PHRASE,
      true, 1_000_000).state;
    const cand = { runId: 'r-dup', status: 'completed' , origin: 'bridge'};
    const first = decide(auto, { binding: binding(), probe: probe(),
      runId: cand.runId, status: cand.status }, 1_010_000);
    check(first.send === true, 'first attempt allowed');
    const written = autosend.recordAttempt(auto, cand, 1_010_000);
    const settled = autosend.settle(written.state, 'r-dup|completed',
      { status: 'submitted', evidence: { receipt: 'ok' } }, 1_011_000);
    const again = decide(settled.state, { binding: binding(),
      probe: probe(), runId: cand.runId, status: cand.status }, 1_020_000);
    check(again.send === false, 'the same run+status is refused (' + again.code + ')');
    check(/duplicate/i.test(again.code || ''), 'and named as a duplicate');
  }

  console.log('== T065: navigation during the chain blocks the write ==');
  {
    const auto = autosend.arm(autosend.createAutoSendState(),
      { binding: binding(), ttlMs: 3_600_000, maxSends: 5 }, ARM_PHRASE,
      true, 1_000_000).state;
    // The page moved to a different conversation between binding and write.
    const verdict = decide(auto, {
      binding: binding(),
      probe: probe({ conversationId: '99999999-9999-4999-8999-999999999999',
        url: 'https://chatgpt.com/c/99999999-9999-4999-8999-999999999999' }),
      runId: 'r-nav', status: 'completed',
    }, 1_010_000);
    check(verdict.send === false, 'a moved page is refused (' + verdict.code + ')');

    // A different document instance in the same conversation is also a mismatch.
    const verdict2 = decide(auto, {
      binding: binding(),
      probe: probe({ documentInstanceId: 'instance-other-doc-xyz' }),
      runId: 'r-nav2', status: 'completed',
    }, 1_010_000);
    check(verdict2.send === false,
      'a reloaded page (new document instance) is refused (' + verdict2.code + ')');
  }

  console.log('== T065: busy composer blocks instead of overwriting ==');
  {
    const auto = autosend.arm(autosend.createAutoSendState(),
      { binding: binding(), ttlMs: 3_600_000, maxSends: 5 }, ARM_PHRASE,
      true, 1_000_000).state;
    const verdict = decide(auto, { binding: binding(),
      probe: probe({ composerPresent: false }),
      runId: 'r-busy', status: 'completed' }, 1_010_000);
    check(verdict.send === false,
      'a missing/busy composer is refused (' + verdict.code + ')');

    const stale = decide(auto, { binding: binding(),
      probe: probe({ observedAt: 1_000_000 }),      // 10s old, past the 5s window
      runId: 'r-stale', status: 'completed' }, 1_010_000);
    check(stale.send === false, 'a stale probe is refused (' + stale.code + ')');
  }

  console.log('== T065: an uncertain page write stops the chain ==');
  {
    let auto = autosend.arm(autosend.createAutoSendState(),
      { binding: binding(), ttlMs: 3_600_000, maxSends: 5 }, ARM_PHRASE,
      true, 1_000_000).state;
    const cand = { runId: 'r-unconfirmed', status: 'completed' , origin: 'bridge'};
    const written = autosend.recordAttempt(auto, cand, 1_010_000);
    const settled = autosend.settle(written.state, 'r-unconfirmed|completed',
      { status: 'unconfirmed', reason: 'no_receipt' }, 1_011_000);
    check(settled.result.ok === false, 'an unconfirmed write is not a success');

    const delivery = chain.deliveryLayer(settled.state);
    check(delivery.delivered.value === false, 'and is not counted as delivered');
    check(delivery.needsHumanReview === true, 'it demands human review');

    // The same candidate must not be retried automatically.
    const retry = decide(settled.state, { binding: binding(),
      probe: probe(), runId: cand.runId, status: cand.status }, 1_020_000);
    check(retry.send === false,
      'and is not silently retried (' + retry.code + ')');
  }

  console.log('== T065: MV3 worker restart reconciles an in-flight attempt ==');
  {
    const cand = { runId: 'r-restart', status: 'completed' , origin: 'bridge'};
    let auto = autosend.arm(autosend.createAutoSendState(),
      { binding: binding(), ttlMs: 3_600_000, maxSends: 5 }, ARM_PHRASE,
      true, 1_000_000).state;
    const written = autosend.recordAttempt(auto, cand, 1_010_000);
    // The worker dies here, between write and settle. No settle is ever called.
    const revived = autosend.reconcileAfterRestart(written.state, 1_020_000);
    check(revived.changed === true, 'restart reconciliation changes state');
    const entry = revived.state.journal['r-restart|completed'];
    check(entry && entry.state === 'ambiguous',
      'the dangling attempt becomes ambiguous, not "sent" (' +
      (entry && entry.state) + ')');

    const delivery = chain.deliveryLayer(revived.state);
    check(delivery.delivered.value === false, 'delivery stays unclaimed');
    check(delivery.needsHumanReview === true, 'and review is required');

    // And it is not retried by itself.
    const retry = decide(revived.state, { binding: binding(),
      probe: probe(), runId: cand.runId, status: cand.status }, 1_030_000);
    check(retry.send === false, 'no automatic retry after a restart');
  }

  console.log('== T065: trigger restart and rate limits ==');
  {
    let trig = ledger.configure(ledger.createTriggerState(),
      { minIntervalMs: 30000, maxPerHour: 2, binding: binding() },
      TRIGGER_PHRASE, true, 1_000_000).state;
    // `admit` validates the id as a real UUID (version 1-8, variant 8/9/a/b) and
    // refuses anything else with `run_id_invalid`, so these fixtures cannot use
    // the short `r-...` labels the rest of this file uses for plain journal keys.
    const RATE_1 = 'aa000001-0000-4000-8000-000000000001';
    const RATE_2 = 'aa000002-0000-4000-8000-000000000002';
    const RATE_3 = 'aa000003-0000-4000-8000-000000000003';
    const RATE_4 = 'aa000004-0000-4000-8000-000000000004';
    const cand = { runId: RATE_1, status: 'completed' , origin: 'bridge'};
    const first = ledger.admit(trig, cand, 1_060_000);
    check(first.admit === true, 'first admitted');
    trig = ledger.settle(ledger.markAttempt(trig, cand, 1_060_000).state,
      first.key, { sent: true }, 1_061_000).state;

    // Inside the minimum interval.
    const tooSoon = ledger.admit(trig, { runId: RATE_2, status: 'completed' , origin: 'bridge'},
      1_070_000);
    check(tooSoon.admit === false, 'refused inside the minimum interval (' +
      tooSoon.code + ')');

    // After the interval, but past the hourly ceiling.
    const second = ledger.admit(trig, { runId: RATE_3, status: 'completed' , origin: 'bridge'},
      1_120_000);
    const afterSecond = second.admit === true
      ? ledger.settle(
        ledger.markAttempt(trig, { runId: RATE_3, status: 'completed' , origin: 'bridge'},
          1_120_000).state,
        second.key, { sent: true }, 1_121_000).state
      : trig;
    const overCeiling = ledger.admit(afterSecond,
      { runId: RATE_4, status: 'completed' , origin: 'bridge'}, 1_180_000);
    check(overCeiling.admit === false,
      'refused once the hourly ceiling is reached (' + overCeiling.code + ')');

    // A restart must not forget that it was armed.
    const restarted = ledger.reconcileAfterRestart(afterSecond, 1_190_000);
    check(restarted.state.enabled === afterSecond.enabled,
      'a restart keeps the trigger switch as the operator left it');
  }

  // ------------------------------------------------------------- summary edges
  console.log('== T065: the summary never upgrades a layer ==');
  {
    // Host up, nothing else known: must not read as ready.
    const partial = chain.summariseChain({
      hello: { ok: true, capabilities: { deliver: false } },
      terminalList: null, bindingHealth: null,
      autoSendState: null, triggerState: null, candidates: { candidates: [] },
    }, 1_000_000);
    check(partial.stages.hostOnline === 'ok', 'host layer is ok');
    check(partial.stages.sourceReady === 'unknown',
      'the source layer stays unknown, not ok');
    check(partial.stage === 'unknown',
      'so the headline stops at the unverified source (' + partial.stage + ')');
    check(/未知/.test(chain.describeStage(partial)),
      'and the headline admits the rest is unknown');

    // An old host that cannot serve terminal ops.
    const oldHost = chain.summariseChain({
      hello: { ok: true, capabilities: {} },
      terminalList: { ok: false, code: 'unknown_op' },
      bindingHealth: null, autoSendState: null, triggerState: null,
      candidates: { candidates: [] },
    }, 1_000_000);
    check(oldHost.detail.host.canProduceCandidates === false,
      'an unknown_op host is reported as unable to produce candidates');
    check(oldHost.stages.sourceReady === 'blocked', 'and the source is blocked');

    // Unreadable source while the host is fine: not "host offline".
    const noSource = chain.summariseChain({
      hello: { ok: true, capabilities: {} },
      terminalList: { ok: false, code: 'source_unavailable' },
      bindingHealth: null, autoSendState: null, triggerState: null,
      candidates: { candidates: [] },
    }, 1_000_000);
    check(noSource.stages.hostOnline === 'ok',
      'the host is still counted as online');
    check(noSource.stages.sourceReady === 'blocked',
      'while the source is the blocked layer');
    check(/终态源/.test(chain.describeStage(noSource)), 'and the headline points at the source');

    // No baseline yet: the self-check declined to ask, so the source was never
    // tested. That is unknown -- only the baseline is genuinely absent.
    const noBaseline = chain.summariseChain({
      hello: { ok: true, capabilities: {} },
      terminalList: { ok: false, code: 'baseline_not_established' },
      bindingHealth: null, autoSendState: null, triggerState: null,
      candidates: { candidates: [] },
    }, 1_000_000);
    check(noBaseline.stages.sourceReady === 'unknown',
      'an un-asked source stays unknown, not blocked');
    check(noBaseline.stages.baseline === 'blocked',
      'while the baseline is the blocked layer');
    check(noBaseline.stage === 'baseline',
      'and the headline stops at the baseline (' + noBaseline.stage + ')');
    check(/基线/.test(chain.describeStage(noBaseline)),
      'and says the baseline is missing');
  }

  console.log('== T065: the self-check cannot be mistaken for a send ==');
  {
    const report = chain.summariseChain({
      hello: { ok: true, capabilities: {} },
      terminalList: { ok: true, baselineEstablished: true },
      bindingHealth: { ok: true, status: 'bound_healthy', binding: binding() },
      autoSendState: autosend.arm(autosend.createAutoSendState(),
        { binding: binding(), ttlMs: 60000, maxSends: 1 }, ARM_PHRASE,
        true, 1_000_000).state,
      triggerState: ledger.configure(ledger.createTriggerState(),
        { minIntervalMs: 30000, maxPerHour: 6, binding: binding() },
        TRIGGER_PHRASE, true, 1_000_000).state,
      candidates: { candidates: [] },
    }, 1_030_000);
    check(report.sendEligible === false, 'sendEligible is false');
    check(report.accountIdentity === 'unverified', 'identity stays unverified');
    check(report.stage === 'delivered',
      'and with everything armed but nothing sent, it stops at "delivered" (' +
      report.stage + ')');
    check(/尚无确认/.test(chain.describeStage(report)),
      'saying outright that no write is confirmed');
    check(report.layers.delivered.value === false,
      'the delivered layer is false, not unknown');
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
