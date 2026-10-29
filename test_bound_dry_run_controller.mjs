// T054 controller tests with fake T053 binding + session storage.
// No Chrome, no DOM, no page writes, no Native Host, no send adapter.
import { readFileSync } from 'node:fs';

const C = await import(
  new URL('./extension/lib/bound_dry_run_controller.js', import.meta.url).href);
const P = await import(
  new URL('./extension/lib/bound_dry_run.js', import.meta.url).href);

let passed = 0;
let failed = 0;
function check(value, label) {
  if (value) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failed += 1;
    console.log('  FAIL  ' + label);
  }
}

const RUN1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONV1 = '11111111-1111-4111-8111-111111111111';
const URL1 = 'https://chatgpt.com/c/' + CONV1;
const DOC1 = 'document-instance-aaaaaaaaaa1';
const NOW = 1000000000000;

function binding(overrides = {}) {
  return Object.assign({
    version: 1, revision: 1, boundAt: NOW - 1000,
    tabId: 7, windowId: 2, url: URL1, conversationId: CONV1,
    documentInstanceId: DOC1, accountIdentity: 'unverified',
    accountVerified: false, manuallyConfirmed: true,
    invalidatedReason: null, invalidatedAt: null,
  }, overrides);
}

function health(overrides = {}) {
  return Object.assign({
    ok: true, status: 'bound_healthy', binding: binding(),
    observedAt: NOW - 500, active: false, visibilityState: 'hidden',
    hasFocus: false, discarded: false, frozen: false,
    frozenStateKnown: true, composerPresent: true, routeStable: true,
    accountIdentity: 'unverified', sendEligible: false,
  }, overrides);
}

function fakeStorage(initial) {
  const store = new Map();
  if (initial) store.set(C.DRY_RUN_HISTORY_KEY, initial);
  return {
    store,
    calls: { get: 0, set: 0 },
    async get(defaults) {
      this.calls.get += 1;
      const out = {};
      for (const [key, value] of Object.entries(defaults)) {
        out[key] = store.has(key) ? store.get(key) : value;
      }
      return out;
    },
    async set(values) {
      this.calls.set += 1;
      for (const [key, value] of Object.entries(values)) store.set(key, value);
    },
  };
}

function fakeTarget(state, nextHealth) {
  return {
    calls: { getState: 0, health: 0 },
    async getState() {
      this.calls.getState += 1;
      return typeof state === 'function' ? state() : state;
    },
    async health() {
      this.calls.health += 1;
      return typeof nextHealth === 'function' ? nextHealth() : nextHealth;
    },
  };
}

function clock() {
  let value = NOW;
  return { now: () => value, advance(ms) { value += ms; } };
}

function event(overrides = {}) {
  return Object.assign({ runId: RUN1, status: 'completed' }, overrides);
}

// -- Happy path ----------------------------------------------------------
{
  const session = fakeStorage();
  const target = fakeTarget({ ok: true, status: 'bound_saved',
    binding: binding() }, health({ binding: binding() }));
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const out = await c.run(event());
  check(out.ok && out.reviewAllowed && out.blocked === false &&
        out.historyRecorded === true,
        'healthy bound target yields a reviewable simulated proposal');
  check(out.sendEligible === false && out.pageWriteEligible === false &&
        out.wouldSend === false && out.deliveryReceipt === 'unsupported',
        'controller result never authorizes send or page write');
  check(out.bindingStatus === 'bound_saved' &&
        out.proposal.text === 'DSH task ' + RUN1 + ' completed.',
        'controller reports binding status and fixed template');
  const stored = session.store.get(C.DRY_RUN_HISTORY_KEY);
  check(Array.isArray(stored) && stored.length === 1 &&
        stored[0].runId === RUN1,
        'reviewable event is recorded once in session history');
  const again = await c.run(event());
  check(!again.reviewAllowed && again.reasons.includes('duplicate_event'),
        'rerunning the same event is blocked as duplicate');
  check(session.store.get(C.DRY_RUN_HISTORY_KEY).length === 1,
        'duplicate attempt does not add a second history record');
}

// -- Binding failures ----------------------------------------------------
{
  const session = fakeStorage();
  const target = fakeTarget({ ok: true, status: 'not_bound', binding: null },
    null);
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const out = await c.run(event());
  check(!out.reviewAllowed && out.reasons.includes('target_not_bound') &&
        target.calls.health === 0,
        'unbound target is blocked without probing a page');
  check(out.historyRecorded === false &&
        !(session.store.get(C.DRY_RUN_HISTORY_KEY) || []).length,
        'blocked review does not consume the event history slot');
}

{
  const session = fakeStorage();
  const target = fakeTarget({ ok: false, status: 'binding_state_invalid',
    binding: null }, null);
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const out = await c.run(event());
  check(!out.reviewAllowed && out.bindingStatus === 'binding_state_invalid',
        'unreadable binding state blocks review');
}

{
  const session = fakeStorage();
  const target = fakeTarget({ ok: true, status: 'binding_invalidated',
    binding: binding({ invalidatedReason: 'navigation_or_redirect' }) },
    { ok: false, status: 'binding_invalidated',
      reason: 'navigation_or_redirect' });
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const out = await c.run(event());
  check(!out.reviewAllowed && out.reasons.includes('binding_invalidated'),
        'invalidated binding blocks review');
}

// -- Frozen / discarded / cross-tab health ------------------------------
{
  const cases = [
    [{ status: 'bound_healthy', frozen: true }, 'target_frozen'],
    [{ status: 'bound_healthy', discarded: true }, 'target_discarded'],
    [{ status: 'bound_healthy', tabId: 9 }, 'binding_tab_mismatch'],
    [{ status: 'bound_healthy', windowId: 5 }, 'binding_window_mismatch'],
    [{ status: 'bound_healthy', documentInstanceId: 'document-instance-zzzzzzzzz9' },
      'binding_document_mismatch'],
  ];
  for (const [overrides, code] of cases) {
    const session = fakeStorage();
    const probe = health(overrides);
    if (overrides.status !== 'bound_healthy') probe.status = overrides.status;
    const target = fakeTarget({ ok: true, status: 'bound_saved',
      binding: binding() }, probe);
    const c = C.createBoundDryRunController({}, { targetBinding: target,
      session, now: clock().now });
    const out = await c.run(event());
    check(!out.reviewAllowed && out.reasons.includes(code),
          'page or identity mismatch blocks review: ' + code);
  }
}

// -- Expired binding -----------------------------------------------------
{
  const session = fakeStorage();
  const clk = clock();
  const target = fakeTarget({ ok: true, status: 'bound_saved',
    binding: binding({ boundAt: NOW - P.BINDING_REVIEW_MAX_AGE_MS - 1 }) },
    health());
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clk.now });
  const out = await c.run(event());
  check(!out.reviewAllowed && out.reasons.includes('binding_expired'),
        'binding past the review window blocks the dry-run');
}

// -- Frozen / discarded through the real T053 health shape --------------
{
  const cases = [
    ['frozen', 'target_frozen'],
    ['discarded', 'target_discarded'],
    ['frozen_state_unknown', 'frozen_state_unknown'],
  ];
  for (const [reason, code] of cases) {
    const session = fakeStorage();
    const target = fakeTarget({ ok: true, status: 'bound_saved',
      binding: binding() },
    { ok: false, status: 'binding_unavailable', reason,
      accountIdentity: 'unverified', sendEligible: false });
    const c = C.createBoundDryRunController({}, { targetBinding: target,
      session, now: clock().now });
    const out = await c.run(event());
    check(!out.reviewAllowed && out.reasons.includes(code),
          'T053 unavailable reason blocks review: ' + code);
    check(!(session.store.get(C.DRY_RUN_HISTORY_KEY) || []).length,
          'blocked frozen/discarded review is not recorded: ' + code);
  }
}

// -- Event validation ----------------------------------------------------
{
  const session = fakeStorage();
  const target = fakeTarget({ ok: true, status: 'bound_saved', binding: binding() },
    health());
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const bad = await c.run({ runId: RUN1, status: 'running' });
  check(!bad.ok && bad.status === 'event_invalid' &&
        bad.sendEligible === false,
        'unknown terminal status is rejected before any probe');
  check(target.calls.getState === 0 && target.calls.health === 0,
        'invalid event is rejected without touching Chrome state');
  const extra = await c.run({ runId: RUN1, status: 'completed', message: 'x' });
  check(!extra.ok && extra.status === 'event_invalid',
        'extra event fields such as free text are rejected');
}

// -- Concurrency: duplicate runs are serialized -------------------------
{
  const session = fakeStorage();
  const target = fakeTarget({ ok: true, status: 'bound_saved', binding: binding() },
    health());
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const [a, b] = await Promise.all([c.run(event()), c.run(event())]);
  const allowed = [a, b].filter((item) => item.reviewAllowed);
  const blocked = [a, b].filter((item) => !item.reviewAllowed);
  check(allowed.length === 1 && blocked.length === 1 &&
        blocked[0].reasons.includes('duplicate_event'),
        'concurrent identical runs allow exactly one review');
  check(session.store.get(C.DRY_RUN_HISTORY_KEY).length === 1,
        'concurrent identical runs record one history entry');
}

// -- History storage failures -------------------------------------------
{
  const session = fakeStorage();
  session.set = async () => { throw new Error('quota'); };
  const target = fakeTarget({ ok: true, status: 'bound_saved', binding: binding() },
    health());
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const out = await c.run(event());
  check(!out.reviewAllowed && out.historyError === 'review_history_unavailable',
        'unrecordable review is blocked rather than looking repeatable');
  check(out.sendEligible === false, 'storage failure still cannot enable send');
}

{
  const session = fakeStorage();
  session.get = async () => { throw new Error('denied'); };
  const target = fakeTarget({ ok: true, status: 'bound_saved', binding: binding() },
    health());
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const out = await c.run(event());
  check(!out.ok && out.status === 'session_storage_unavailable',
        'unreadable history fails closed');
  const st = await c.state();
  check(!st.ok && st.status === 'session_storage_unavailable',
        'state exposes history storage failure');
}

// -- History corruption --------------------------------------------------
{
  const session = fakeStorage([{ kind: 't054-dry-run', runId: 5 }]);
  const target = fakeTarget({ ok: true, status: 'bound_saved', binding: binding() },
    health());
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const out = await c.run(event());
  check(!out.ok && out.status === 'dry_run_history_invalid',
        'malformed history is rejected and never auto-reset');
}

// -- History cap ---------------------------------------------------------
{
  const seed = [];
  for (let i = 0; i < C.MAX_HISTORY + 5; i += 1) {
    seed.push({ kind: 't054-dry-run',
      runId: 'cccccccc-cccc-4ccc-8ccc-' + String(i).padStart(12, '0'),
      status: 'completed', proposalId: 'old-' + i, at: NOW - 1000 });
  }
  const session = fakeStorage(seed);
  const target = fakeTarget({ ok: true, status: 'bound_saved', binding: binding() },
    health());
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const out = await c.run(event());
  const stored = session.store.get(C.DRY_RUN_HISTORY_KEY);
  check(out.reviewAllowed && stored.length === C.MAX_HISTORY &&
        stored[stored.length - 1].runId === RUN1,
        'history is bounded and keeps the newest entry');
}

// -- Two different runs --------------------------------------------------
{
  const session = fakeStorage();
  const target = fakeTarget({ ok: true, status: 'bound_saved', binding: binding() },
    health());
  const c = C.createBoundDryRunController({}, { targetBinding: target,
    session, now: clock().now });
  const a = await c.run(event());
  const b = await c.run(event({ runId: RUN2 }));
  check(a.reviewAllowed && b.reviewAllowed,
        'different runs are reviewable independently');
  check((session.store.get(C.DRY_RUN_HISTORY_KEY) || []).length === 2,
        'both distinct runs are recorded');
}

// -- Isolation -----------------------------------------------------------
{
  const source = readFileSync(
    new URL('./extension/lib/bound_dry_run_controller.js', import.meta.url),
    'utf8');
  for (const token of ['chrome.', 'document.', 'sendMessage', 'send_gate',
    'executeScript', 'nativeMessaging', 'storage.local', 'innerText',
    'textContent', '.click(', 'fetch(']) {
    check(!source.includes(token),
          'controller does not reference: ' + token);
  }
}

console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
