// T074: the staged evidence model, plus the boundaries it has to survive.
//
// The point of this suite is that *no stage may borrow another stage's evidence*:
// an ACK is not a delivery, a `sent` journal entry is not proof that ChatGPT acted,
// and a missing observation is `unknown` rather than a quiet pass.
//
// Block 1 exercises the delivery edges offline (candidate capacity, duplicate
// offers, a stop on doubt, grant expiry, reload, conversation mismatch). Block 2
// asserts the staged report itself. The host is the real `host.py` against a
// temporary ledger; nothing here touches a browser, a page or a message.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'chrome-extension://t074-e2e/';
const ROOT = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(rel, ROOT).href);
// T086: the arm boundary is proved from a run's creation time, so a fixture run must
// be created when it is written (i.e. after the arm), exactly like a real completion.
// arm is provably created after it; a fixed timestamp would prove nothing.
// (T086) `Date.now()` is used at the call site below, so a run written after the

const CONV = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const BINDING = {
  version: 1, tabId: 11, windowId: 4, url: 'https://chatgpt.com/c/' + CONV,
  conversationId: CONV, documentInstanceId: 'doc-1', manuallyConfirmed: true,
  revision: 5,
};
const runs = (prefix, count) => Array.from({ length: count }, (_v, i) => ({
  id: prefix + String(i).padStart(12, '0'), status: 'completed',
}));

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { passed += 1; console.log('  PASS  ' + label); }
  else { failed += 1; console.log('  FAIL  ' + label); }
}
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// ------------------------------------------------------------------ host, offline
function startHost(stateDir, ledgerRoot) {
  if (!ledgerRoot) {
    throw new Error('startHost requires a temporary ledgerRoot; refusing to let the '
      + 'host read the production AgentState');
  }
  const cwd = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, '$1');
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
    for (const fn of disc) { try { fn(); } catch (_e) { /* caller's */ } }
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
    port() {
      let onDisc = null;
      const fire = () => { if (onDisc) { try { onDisc(); } catch (_e) { /* test */ } } };
      if (dead) setTimeout(fire, 0);
      return {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        onDisconnect: { addListener(fn) { onDisc = fn; disc.add(fire); } },
        postMessage(doc) {
          if (dead) { setTimeout(fire, 0); return; }
          try { child.stdin.write(frame(doc)); } catch (_e) { setTimeout(fire, 0); }
        },
      };
    },
    stop() { try { child.kill(); } catch (_e) { /* gone */ } },
  };
}

// T086: the creation time a synthetic run was given, in the whole seconds the host
// reports. A fixture that re-injects a candidate locally has to carry it too, or
// the arm boundary refuses the entry as unprovable history.
function startedAtOf(ledgerRoot, runId) {
  const path = join(ledgerRoot, 'a'.repeat(64), 'endpoint.json.runs.json');
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  const row = rows.find((item) => item.requestID === runId);
  return row ? Math.floor(row.createdAt / 1000) : undefined;
}

function writeRuns(ledgerRoot, list) {
  const dir = join(ledgerRoot, 'a'.repeat(64));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'endpoint.json.runs.json'), JSON.stringify(
    list.map((run, index) => ({ requestID: run.id, status: run.status,
      createdAt: Date.now() + 2000 + index * 1000 })), null, 2), 'utf8');
}

// ------------------------------------------------------------------- fake chrome
const event = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; } });
function createChrome(hostRef) {
  const stores = { local: new Map(), session: new Map() };
  const alarms = new Map();
  const area = (map) => ({
    async get(defaults) {
      const out = {};
      if (defaults && typeof defaults === 'object') {
        for (const [k, v] of Object.entries(defaults)) {
          out[k] = map.has(k) ? clone(map.get(k)) : v;
        }
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items || {})) map.set(k, clone(v));
    },
    async remove(key) { map.delete(key); },
  });
  const messageListeners = [];
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
      async get() { return undefined; },
      async query() { return []; },
      async sendMessage() { throw new Error('no tab in this suite'); },
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      onAttached: event(), onDetached: event(), onReplaced: event(),
    },
    windows: { onFocusChanged: event() },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    permissions: { async contains() { return false; } },
  };
  return {
    api, stores, alarms,
    read: (key) => clone(stores.local.get(key)),
    write: (key, value) => stores.local.set(key, clone(value)),
    // The real listener, so a suite cannot pass by calling an internal helper the
    // popup would never reach.
    async dispatch(msg, sender = POPUP) {
      const listener = messageListeners[0];
      if (!listener) throw new Error('background registered no onMessage listener');
      let out = null;
      let threw = null;
      let ret;
      try {
        ret = listener(clone(msg), sender, (r) => { out = r; });
      } catch (err) { threw = err; }
      if (threw) throw threw;
      if (ret !== true) return out;
      const started = Date.now();
      while (out === null && Date.now() - started < 8000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return out;
    },
  };
}

const TARM = 'AUTOTRIGGER ' + CONV;
const POPUP = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };

async function open() {
  const dir = mkdtempSync(join(tmpdir(), 't074-'));
  const ledgerRoot = join(dir, 'agents');
  writeRuns(ledgerRoot, []);
  const h = startHost(join(dir, 'host'), ledgerRoot);
  const hostRef = { current: h };
  const chromeMock = createChrome(hostRef);
  globalThis.chrome = chromeMock.api;
  chromeMock.stores.session.set('t053TargetBindingState', {
    version: 1, revision: 5, binding: BINDING, candidates: [], candidateScannedAt: null,
  });
  const bg = await mod('./extension/background.js?t074=' + Date.now()
    + Math.random().toString(16).slice(2));
  const sent = [];
  const env = {
    dir, ledgerRoot, chromeMock, bg, sent,
    dispatch: (msg, sender) => chromeMock.dispatch(msg, sender),
    async arm() {
      return env.dispatch({ type: 't059-trigger-arm', confirmation: TARM,
        userGesture: true });
    },
    tick(options = {}) {
      return bg.runTerminalTrigger(Object.assign({ limit: 4 }, options));
    },
    candidates: () => chromeMock.read('terminalCandidates') || [],
    trigger: () => chromeMock.read('terminalTrigger') || null,
    accepts: () => {
      sent.push(1);
      return { sent: true, status: 'submitted', evidence: { receipt: 'stub' } };
    },
    refuses: (code) => async () => ({ sent: false, code: code || 'test_refusal' }),
    cleanup() {
      h.stop();
      rmSync(dir, { recursive: true, force: true });
      delete globalThis.chrome;
    },
  };
  return env;
}

async function main() {
  // ------------------------------------- 1. capacity: history must not starve work
  //
  // Protected history ("queued before the trigger was armed") is kept for display
  // and is never sent. It also used to count against the same 50-slot budget as
  // deliverable work, so 50 leftovers made `room === 0` forever: the host kept
  // re-offering new completions, the intake kept refusing them, and the chain went
  // quiet with no error anywhere. That is a silent stop, which is the worst kind.
  console.log('== T074: protected history must not starve new candidates ==');
  {
    const env = await open();
    try {
      const armed = await env.arm();
      check(armed && armed.ok === true && armed.result && armed.result.ok === true,
        'the trigger arms (' + JSON.stringify(armed && armed.result) + ')');
      await env.tick({ limit: 1, sendOnce: env.accepts });        // establish baseline

      // Fill the queue *without* sending: `limit: 0` still samples and stores, so
      // the backlog becomes exactly what "protected history" is made of.
      writeRuns(env.ledgerRoot, runs('11111111-1111-4111-8111-', 50));
      for (let i = 0; i < 4; i += 1) {
        await env.tick({ limit: 0, sendOnce: env.refuses('never_called') });
      }
      check(env.candidates().length === 50,
        '50 candidates are sampled and stored (' + env.candidates().length + ')');
      check(env.sent.length === 0, 'and none of them was sent');

      const rearmed = await env.arm();
      check(rearmed.result.ok === true && rearmed.preArm === 50,
        're-arming protects all 50 as history (' + rearmed.preArm + ')');

      // One genuinely new completion. It must still get through.
      writeRuns(env.ledgerRoot, runs('11111111-1111-4111-8111-', 50)
        .concat(runs('22222222-2222-4222-8222-', 1)));
      const seen = [];
      for (let i = 0; i < 6; i += 1) {
        await env.tick({ limit: 4, sendOnce: async (candidate) => {
          seen.push(candidate.runId);
          return { sent: true, status: 'submitted', evidence: { receipt: 'stub' } };
        } });
      }
      check(seen.length >= 1,
        'the new completion still reaches the writer (' + seen.length + ' sent)');
      check(seen.some((id) => id.startsWith('22222222')),
        'and it is the new one, not history (' + JSON.stringify(seen.slice(0, 2)) + ')');
      check(env.candidates().length <= 50,
        'the store stays bounded (' + env.candidates().length + ')');
      const stillHistory = env.candidates().filter((item) =>
        item.runId.startsWith('11111111')).length;
      check(stillHistory >= 1, 'history is still visible, just bounded (' +
        stillHistory + ')');
    } finally { env.cleanup(); }
  }

  const T = await mod('./extension/lib/terminal_trigger.js');
  const S = await mod('./extension/lib/autosend.js');
  const A = await mod('./extension/lib/send_adapter.js');
  const E = await mod('./extension/lib/chain_evidence.js');

  // ------------------------------------------------- 2. a duplicate is not re-sent
  //
  // The host keeps an event in `pendingIds` until it is acknowledged. If the ACK
  // fails after a successful write, the same completion is offered again -- and it
  // has already been delivered. The journal, not the queue, has to be the memory.
  console.log('== T074: a re-offered completion is drained, not written twice ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: env.accepts });
      const batch = runs('33333333-3333-4333-8333-', 1);
      writeRuns(env.ledgerRoot, batch);
      await env.tick({ limit: 2, sendOnce: env.accepts });
      check(env.sent.length === 1, 'the first offer is written once');

      // Simulate a failed ACK: the host offers it again, carrying the same
      // creation time it had the first time.
      const stamp = startedAtOf(env.ledgerRoot, batch[0].id);
      env.chromeMock.write('terminalCandidates',
        (env.candidates()).concat([{ runId: batch[0].id, status: 'completed', origin: 'bridge',
          startedAt: stamp }]));
      const before = env.sent.length;
      const again = await env.tick({ limit: 2, sendOnce: env.accepts });
      check(env.sent.length === before,
        'the duplicate is never handed to the writer (' + env.sent.length + ')');
      const codes = again.results.map((r) => r.code);
      check(codes.includes('duplicate_event') || codes.includes('duplicate_run'),
        'and it is named as a duplicate (' + JSON.stringify(codes) + ')');
      check(!env.candidates().some((item) => item.runId === batch[0].id),
        'the stale queue entry is drained so it cannot block capacity');
    } finally { env.cleanup(); }
  }

  // ---------------------------------------- 3. doubt stops the chain, no second try
  console.log('== T074: an unconfirmed write stops and is never retried ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: env.accepts });
      writeRuns(env.ledgerRoot, runs('44444444-4444-4444-8444-', 1));
      const first = await env.tick({ limit: 1,
        sendOnce: async () => ({ sent: false, code: 'unconfirmed',
          reason: 'delivery_not_confirmed' }) });
      check(first.state.enabled === false, 'an unconfirmed write disables the trigger');
      check(String(first.state.lastError).startsWith('stopped:'),
        'and records a stop reason (' + first.state.lastError + ')');
      check(first.results.some((r) => r.sent === false && r.code === 'unconfirmed'),
        'the tick reports the refusal that caused it (' +
        JSON.stringify(first.results.map((r) => r.code)) + ')');

      writeRuns(env.ledgerRoot, runs('44444444-4444-4444-8444-', 1)
        .concat(runs('55555555-5555-4555-8555-', 1)));
      const before = env.sent.length;
      const second = await env.tick({ limit: 2, sendOnce: env.accepts });
      check(env.sent.length === before, 'nothing is written afterwards');
      check(second.fetched.code === 'trigger_disabled',
        'and the host is not even polled (' + second.fetched.code + ')');
    } finally { env.cleanup(); }
  }

  // ------------------------------------------------ 4. the grant has a hard edge
  console.log('== T074: an expired grant cannot authorise a write ==');
  {
    const at = 1700000000000;
    const armed = S.arm(S.createAutoSendState(), { binding: BINDING },
      'AUTOSEND ' + CONV, true, at);
    check(armed.result.ok === true, 'the grant arms for 7 days');
    const probe = (now) => ({ observedAt: now - 10, tabId: BINDING.tabId,
      windowId: BINDING.windowId, url: BINDING.url, conversationId: CONV,
      documentInstanceId: 'doc-1', active: true, hasFocus: true,
      visibilityState: 'visible', composerPresent: true, composerEmpty: true });
    const atEdge = S.decide(armed.state, { binding: BINDING,
      probe: probe(armed.state.expiresAt), runId: runs('66666666-6666-4666-8666-', 1)[0].id,
      status: 'completed' }, armed.state.expiresAt);
    check(atEdge.send === false && atEdge.code === 'authorization_expired',
      'the exact expiry instant is already expired (' + atEdge.code + ')');
    const before = S.decide(armed.state, { binding: BINDING,
      probe: probe(armed.state.expiresAt - 1),
      runId: runs('66666666-6666-4666-8666-', 1)[0].id, status: 'completed' },
    armed.state.expiresAt - 1);
    check(before.send === true, 'one millisecond earlier it still may (' +
      before.code + ')');
    const spent = Object.assign({}, armed.state, { sentCount: armed.state.maxSends });
    const used = S.decide(spent, { binding: BINDING, probe: probe(at + 1000),
      runId: runs('66666666-6666-4666-8666-', 1)[0].id, status: 'completed' }, at + 1000);
    check(used.send === false && used.code === 'authorization_exhausted',
      'an exhausted grant is refused (' + used.code + ')');
  }

  // ---------------------------------------------- 5. a reload cannot resume a write
  console.log('== T074: a restart turns an in-flight attempt into a stop ==');
  {
    const at = 1700000000000;
    const RUN = runs('77777777-7777-4777-8777-', 1)[0].id;
    let state = T.configure(T.createTriggerState(), { binding: BINDING },
      T.CONFIRM_PREFIX + CONV, true, at).state;
    const marked = T.markAttempt(state, { runId: RUN, status: 'completed' , origin: 'bridge'}, at + 1);
    state = marked.state;
    const after = T.reconcileAfterRestart(state, at + 5000);
    check(after.changed === true, 'the dangling attempt is noticed');
    check(after.state.seen[marked.key].state === 'stopped',
      'and becomes a stop, not a retry (' + after.state.seen[marked.key].state + ')');
    check(after.state.enabled === false,
      'the trigger is disabled until a human re-arms (' + after.state.lastError + ')');
    const admitted = T.admit(after.state, { runId: RUN, status: 'completed' , origin: 'bridge'}, at + 6000);
    check(admitted.admit === false && admitted.code === 'trigger_disabled',
      'and the same run cannot be admitted afterwards (' + admitted.code + ')');

    const sendAt = S.arm(S.createAutoSendState(), { binding: BINDING },
      'AUTOSEND ' + CONV, true, at);
    const pending = S.recordAttempt(sendAt.state,
      { runId: RUN, status: 'completed' , origin: 'bridge'}, at + 1);
    const reconciled = S.reconcileAfterRestart(pending.state, at + 5000);
    check(reconciled.state.journal[pending.key].state === 'ambiguous',
      'the send journal marks it ambiguous (' + reconciled.state.journal[pending.key].state + ')');
    // Audited, not changed: the grant itself stays armed, and the ambiguous run is
    // refused per-run. That is safe because the only unattended path -- the
    // terminal trigger -- is the layer that disables itself on doubt (asserted
    // above). Disarming here too would make `decide` answer `autosend_disabled`
    // instead of the far more useful `previous_attempt_ambiguous`, and an existing
    // assertion depends on the precise reason.
    check(reconciled.state.enabled === true,
      'the grant stays armed (its refusal is per-run)');
    const replayed = S.decide(reconciled.state, { binding: BINDING,
      probe: { observedAt: at + 5010, tabId: BINDING.tabId, windowId: BINDING.windowId,
        url: BINDING.url, conversationId: CONV, documentInstanceId: 'doc-1',
        active: true, hasFocus: true, visibilityState: 'visible',
        composerPresent: true, composerEmpty: true },
      runId: RUN, status: 'completed' }, at + 5100);
    check(replayed.send === false && replayed.code === 'previous_attempt_ambiguous',
      'but the ambiguous run can never be replayed (' + replayed.code + ')');
    check(reconciled.needsHumanReview !== false || reconciled.changed !== false,
      'the restart is reported as a change, not silently accepted');
  }

  // ------------------------------------------ 6. a moved conversation is refused
  console.log('== T074: a page that moved is refused before it is typed into ==');
  {
    const wanted = '123e4567-e89b-42d3-a456-426614174000';
    const other = '223e4567-e89b-42d3-a456-426614174000';
    const now = 1700000000000;
    const clicked = [];
    const composer = { value: '', textContent: '', focus() {}, dispatchEvent() {},
      getBoundingClientRect: () => ({ width: 1, height: 1 }) };
    const page = (path) => ({ doc: {
      location: { pathname: path, href: 'https://chatgpt.com' + path },
      body: { nodeType: 1 },
      querySelectorAll(selector) {
        if (selector.includes('contenteditable')) return [composer];
        if (selector.includes('data-message-author-role')) return [];
        if (selector.includes('send-button')) {
          return [{ click() { clicked.push(1); },
            getBoundingClientRect: () => ({ width: 1, height: 1 }) }];
        }
        return [];
      },
      execCommand() { return false; },
      createEvent() { return { initEvent() {} }; },
    } });
    const moved = page('/c/' + other);
    const refused = await A.deliverInto(moved.doc,
      { runId: wanted, status: 'completed', origin: 'bridge', expectedConversationId: wanted }, now,
      { timeoutMs: 50 });
    check(refused.status === 'refused'
      && refused.reason === 'conversation_changed_at_page',
      'the adapter refuses a different conversation (' + refused.reason + ')');
    check(clicked.length === 0 && composer.value === '',
      'without clicking or typing anything');

    const at = 1700000000000;
    const armed = S.arm(S.createAutoSendState(), { binding: BINDING },
      'AUTOSEND ' + CONV, true, at);
    const mismatch = S.decide(armed.state, { binding: BINDING,
      probe: { observedAt: at + 10, tabId: BINDING.tabId, windowId: BINDING.windowId,
        url: BINDING.url, conversationId: other, documentInstanceId: 'doc-1',
        active: true, hasFocus: true, visibilityState: 'visible',
        composerPresent: true, composerEmpty: true },
      runId: wanted, status: 'completed' }, at + 100);
    check(mismatch.send === false && mismatch.code === 'conversation_identity_mismatch',
      'and the gate refuses it too (' + mismatch.code + ')');
  }

  // ======================================================================
  // The staged report itself.
  //
  // The failure this guards against is a *green* report built out of the wrong
  // record: an ACK read as a delivery, or a DSH task reaching `completed` read as
  // "ChatGPT acted on the notice".
  // ======================================================================

  // -------------------------------- 7. a real submitted write, end to end
  console.log('== T074: a submitted write is page proof, and nothing more ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: env.accepts });
      const batch = runs('88888888-8888-4888-8888-', 1);
      writeRuns(env.ledgerRoot, batch);
      await env.tick({ limit: 1, sendOnce: env.accepts });
      const report = await env.bg.readChainEvidence(batch[0].id);
      check(report.runId === batch[0].id,
        'the report describes the run that was sent (' + report.runId + ')');
      check(report.byId.terminal_observed.state === E.OBSERVED,
        'terminal observation is observed');
      check(report.byId.candidate_created.state === E.OBSERVED,
        'candidate creation is observed');
      check(report.byId.host_acknowledged.state === E.UNKNOWN,
        'the ACK is reported per-run as unknown (' +
        report.byId.host_acknowledged.code + ')');
      check(report.byId.send_attempted.state === E.OBSERVED,
        'the attempt is observed');
      // The suite injects `sendOnce`, so no *send-journal* entry exists -- only the
      // trigger's. The report must call that a contradiction rather than assume the
      // page receipt. This is the honest reading of a stubbed writer.
      check(report.byId.adapter_submitted.state === E.UNKNOWN
        && report.byId.adapter_submitted.code === 'journal_mismatch',
        'a stubbed writer yields journal_mismatch, not a guessed receipt (' +
        report.byId.adapter_submitted.code + ')');
      check(report.deliveryProven === false,
        'and delivery is not claimed on that evidence');
      check(report.loopClosed === false,
        'and the loop is not closed without an independent observation');
      check(report.byId.downstream_confirmed.state === E.UNKNOWN
        && report.byId.downstream_confirmed.code === 'requires_independent_observation',
        'the sixth stage says exactly what is missing');
      check(report.acknowledgementIsNotDelivery === true,
        'and the report states that an ACK is not a delivery');
      check(report.stages.length === 6, 'all six stages are reported');

      // Now write what the *real* send path writes: the controller journals an
      // attempt and settles it on the adapter's `submitted`. Both steps come from
      // the production module, so the record under test is the real one even though
      // the page itself is a stub.
      const armedGrant = S.arm(S.createAutoSendState(), { binding: BINDING },
        'AUTOSEND ' + CONV, true, 1000);
      const attempted = S.recordAttempt(armedGrant.state,
        { runId: batch[0].id, status: 'completed' , origin: 'bridge'}, 1001);
      const settled = S.settle(attempted.state, attempted.key,
        { status: 'submitted' }, 1200);
      env.chromeMock.write('autosend', settled.state);
      const proven = await env.bg.readChainEvidence(batch[0].id);
      check(proven.byId.adapter_submitted.state === E.OBSERVED,
        'a real submitted settlement is observed (' +
        proven.byId.adapter_submitted.code + ')');
      check(proven.deliveryProven === true, 'so page-level delivery is proven');
      check(proven.loopClosed === false,
        'while the loop still is not: no independent observation exists');
    } finally { env.cleanup(); }
  }

  // ------------------------------------- 8. ACKed but never written: not delivery
  console.log('== T074: an ACKed candidate with no write proves nothing ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: env.accepts });
      const batch = runs('99999999-9999-4999-8999-', 3);
      writeRuns(env.ledgerRoot, batch);
      await env.tick({ limit: 0, sendOnce: env.accepts });   // sample, never send
      const poll = env.chromeMock.read('terminalChainStatus');
      check(poll.acked >= 1, 'the host did acknowledge the events (acked=' +
        poll.acked + ')');
      check(env.sent.length === 0, 'and nothing was written');
      const report = await env.bg.readChainEvidence(batch[0].id);
      check(report.deliveryProven === false,
        'an acknowledged candidate is not a delivery');
      check(report.byId.adapter_submitted.state !== E.OBSERVED,
        'the adapter stage is not observed (' + report.byId.adapter_submitted.code + ')');
      check(report.byId.adapter_submitted.code === 'not_attempted_yet',
        'and says it was never attempted');
      check(report.byId.host_acknowledged.state === E.UNKNOWN,
        'while the ACK itself stays un-attributable (' +
        report.byId.host_acknowledged.code + ')');
    } finally { env.cleanup(); }
  }

  // ---------------------------------------------------- 9. a stopped write
  console.log('== T074: a stopped write is reported as a stop ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: env.accepts });
      const batch = runs('aaaaaaaa-aaaa-4aaa-8aaa-', 1);
      writeRuns(env.ledgerRoot, batch);
      await env.tick({ limit: 1, sendOnce: async () => ({ sent: false,
        code: 'unconfirmed', reason: 'delivery_not_confirmed' }) });
      const report = await env.bg.readChainEvidence(batch[0].id);
      check(report.byId.send_attempted.state === E.OBSERVED,
        'the attempt is still observable');
      check(report.byId.adapter_submitted.state === E.ABSENT
        && report.byId.adapter_submitted.code === 'send_stopped',
        'the write is absent, with the stop reason (' +
        report.byId.adapter_submitted.code + ')');
      check(report.deliveryProven === false, 'and nothing claims delivery');
      check(String(report.stopReason).startsWith('stopped:'),
        'the report carries the stop reason (' + report.stopReason + ')');
    } finally { env.cleanup(); }
  }

  // ------------------------------------- 10. contradictory journals are unknown
  console.log('== T074: contradictory evidence is unknown, never a pass ==');
  {
    const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const report = E.describeChainEvidence({
      runId,
      terminalChainStatus: { ok: true, added: 1, acked: 1, at: 1000 },
      terminalSourceBaseline: { established: true, at: 900 },
      candidates: [],
      // The trigger says it sent; the send journal knows nothing about it.
      triggerState: { enabled: true, seen: {
        [runId + '|completed']: { runId, status: 'completed', state: 'sent',
          attemptedAt: 1100, settledAt: 1200 },
      } },
      autoSendState: { enabled: true, journal: {} },
    }, { now: 2000 });
    check(report.byId.adapter_submitted.state === E.UNKNOWN
      && report.byId.adapter_submitted.code === 'journal_mismatch',
      'a trigger-only "sent" does not become page proof (' +
      report.byId.adapter_submitted.code + ')');
    check(report.deliveryProven === false, 'so delivery stays unproven');
  }

  // ------------------------------------------ 11. the only way to close the loop
  console.log('== T074: only an independent observation closes the loop ==');
  {
    const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const base = {
      runId,
      terminalChainStatus: { ok: true, added: 1, acked: 1, at: 1000 },
      terminalSourceBaseline: { established: true, at: 900 },
      candidates: [],
      triggerState: { enabled: true, seen: {
        [runId + '|completed']: { runId, status: 'completed', state: 'sent',
          attemptedAt: 1100, settledAt: 1200 },
      } },
      autoSendState: { enabled: true, journal: {
        [runId + '|completed']: { runId, status: 'completed', state: 'sent',
          attemptedAt: 1100, settledAt: 1200 },
      } },
    };
    const closed = E.describeChainEvidence(Object.assign({}, base, {
      downstream: { source: 'independent_observation',
        taskId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', observedAt: 5000 },
    }), { now: 6000 });
    check(closed.deliveryProven === true && closed.loopClosed === true,
      'an independent observation is what closes the loop');
    check(closed.byId.downstream_confirmed.state === E.OBSERVED,
      'and the sixth stage becomes observed');

    const selfClaim = E.describeChainEvidence(Object.assign({}, base, {
      downstream: { source: 'this_extension', taskId: runId, observedAt: 5000 },
    }), { now: 6000 });
    check(selfClaim.loopClosed === false,
      'a self-claim, or the same run id, cannot close it');

    const line = E.describeEvidenceLine(closed);
    check(typeof line === 'string' && line.includes('独立证实'),
      'the one-line summary says what was proven (' + line + ')');
  }

  // ------------------------------------------------- 12. nothing recorded at all
  console.log('== T074: an empty profile reports unknown, not ready ==');
  {
    const empty = E.describeChainEvidence({}, { now: 1000 });
    check(empty.runId === null, 'no run can be named');
    check(empty.deliveryProven === false && empty.loopClosed === false,
      'nothing is proven');
    check(empty.stages.every((item) => item.state !== E.OBSERVED),
      'and no stage is observed (' +
      JSON.stringify(empty.stages.map((item) => item.state)) + ')');
    check(empty.unverified.length === 6, 'all six are listed as unverified');
    check(E.pickRunId({
      triggerState: { seen: {
        'x|completed': { runId: 'x', state: 'sent', settledAt: 10 },
        'y|completed': { runId: 'y', state: 'sent', settledAt: 20 },
      } },
    }) === 'y', 'the most recently settled run is the one described');
  }

  // ------------------------------------- 13. the message is popup-only and reads only
  console.log('== T074: the evidence message is popup-only and writes nothing ==');
  {
    const env = await open();
    try {
      await env.arm();
      await env.tick({ limit: 1, sendOnce: env.accepts });
      writeRuns(env.ledgerRoot, runs('eeeeeeee-eeee-4eee-8eee-', 1));
      await env.tick({ limit: 0, sendOnce: env.accepts });
      const snapshot = () => JSON.stringify([...env.chromeMock.stores.local.entries()]
        .map(([k, v]) => [k, v]).sort());
      const before = snapshot();
      const pollBefore = env.chromeMock.read('terminalChainStatus');
      const ok = await env.dispatch({ type: 't074-chain-evidence' });
      check(ok && ok.ok === true && ok.result, 'the popup can ask for the report');
      check(ok.result.stages.length === 6, 'and gets all six stages');
      const after = snapshot();
      check(before === after, 'asking changes nothing in storage');
      const pollAfter = env.chromeMock.read('terminalChainStatus');
      check(pollBefore.at === pollAfter.at && pollBefore.acked === pollAfter.acked,
        'and the poll record is untouched (no poll, no ACK)');

      const fromPage = await env.dispatch({ type: 't074-chain-evidence' },
        { id: 'test-extension', url: 'chrome-extension://test-extension/content.js',
          tab: { id: 3 } });
      check(fromPage && fromPage.ok === false
        && fromPage.error === 'extension_popup_required',
        'a content script cannot ask (' + JSON.stringify(fromPage && fromPage.error) + ')');
      check(snapshot() === before, 'and that attempt writes nothing either');
    } finally { env.cleanup(); }
  }

  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});


