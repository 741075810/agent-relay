// T054 offline tests: bound-target + simulated terminal event dry-run.
// No Chrome, no DOM, no page writes, no Native Host queue, no send adapter.
import { readFileSync } from 'node:fs';

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
const CONV2 = '22222222-2222-4222-8222-222222222222';
const URL1 = 'https://chatgpt.com/c/' + CONV1;
const URL2 = 'https://chatgpt.com/c/' + CONV2;
const DOC1 = 'document-instance-aaaaaaaaaa1';
const DOC2 = 'document-instance-bbbbbbbbbb2';
const NOW = 1000000000000;

function binding(overrides = {}) {
  return Object.assign({
    version: 1,
    revision: 3,
    boundAt: NOW - 60000,
    tabId: 7,
    windowId: 2,
    url: URL1,
    conversationId: CONV1,
    documentInstanceId: DOC1,
    accountIdentity: 'unverified',
    accountVerified: false,
    manuallyConfirmed: true,
    invalidatedReason: null,
    invalidatedAt: null,
  }, overrides);
}

function health(overrides = {}) {
  return Object.assign({
    ok: true,
    status: 'bound_healthy',
    binding: binding(),
    observedAt: NOW - 1000,
    active: false,
    visibilityState: 'hidden',
    hasFocus: false,
    discarded: false,
    frozen: false,
    frozenStateKnown: true,
    composerPresent: true,
    routeStable: true,
    accountIdentity: 'unverified',
    sendEligible: false,
  }, overrides);
}

function event(overrides = {}) {
  return Object.assign({
    runId: RUN1,
    status: 'completed',
    proposalId: P.createProposalId(RUN1, 'completed', 1),
  }, overrides);
}

function run(overrides = {}) {
  return P.evaluateBoundDryRun(Object.assign({
    now: NOW,
    binding: binding(),
    health: health(),
    event: event(),
    history: [],
  }, overrides));
}

function evaluateWithHealth(probe) {
  return run({ health: probe });
}

// -- Happy path: review only, never a send authorization -----------------
{
  const out = run();
  check(out.reviewAllowed === true && out.blocked === false &&
        out.sendEligible === false && out.wouldSend === false &&
        out.pageWriteEligible === false,
        'healthy bound target allows human review only, never sending');
  check(out.proposal.text === 'DSH task ' + RUN1 + ' completed.' &&
        out.proposal.simulated === true,
        'proposal uses the fixed template and is marked simulated');
  check(out.target.conversationId === CONV1 && out.target.tabId === 7 &&
        out.target.windowId === 2 && out.target.revision === 3,
        'result carries the exact bound page identity');
  check(out.checks.some((c) => c.code === 'health_fresh' && c.ok) &&
        out.checks.some((c) => c.code === 'event_not_seen_in_session' && c.ok),
        'fresh health and first-seen event are recorded as passing checks');
}

// -- Real T053 health shape: composer/route fields are absent, not false ----
{
  const realShape = health();
  delete realShape.composerPresent;
  delete realShape.routeStable;
  delete realShape.frozenStateKnown;
  const out = evaluateWithHealth(realShape);
  check(out.reviewAllowed,
        'a real T053 bound_healthy result omits composer/route fields and still allows review');
  const contradiction = health({ composerPresent: false });
  const blocked = evaluateWithHealth(contradiction);
  check(!blocked.reviewAllowed && blocked.reasons.includes('composer_unavailable'),
        'an explicit composer contradiction is still blocked');
}

// -- Binding presence and validity --------------------------------------
{
  const out = run({ binding: null, health: null });
  check(!out.reviewAllowed && out.reasons.includes('target_not_bound'),
        'missing binding blocks review');
  check(out.target === null, 'missing binding never invents a target');
}

{
  const out = run({ binding: binding({ invalidatedReason: 'navigation_or_redirect' }) });
  check(!out.reviewAllowed && out.reasons.includes('binding_invalidated'),
        'an invalidated binding blocks review');
  check(out.issues.some((i) => i.detail === 'navigation_or_redirect'),
        'invalidation reason is surfaced to the reviewer');
}

{
  const out = run({ binding: binding({ invalidatedReason: 'tab_closed' }),
    health: { ok: false, status: 'binding_invalidated', reason: 'tab_closed' } });
  check(!out.reviewAllowed && out.reasons.includes('binding_invalidated'),
        'closed tab binding is blocked even with a stale health object');
}

{
  const cases = [
    [{ url: URL2 }, 'binding_record_invalid'],
    [{ conversationId: CONV2 }, 'binding_record_invalid'],
    [{ url: 'https://chatgpt.com/c/' + CONV1 + '?x=1' }, 'binding_record_invalid'],
    [{ revision: 0 }, 'binding_record_invalid'],
    [{ accountVerified: true }, 'binding_record_invalid'],
    [{ manuallyConfirmed: false }, 'binding_record_invalid'],
    [{ documentInstanceId: 'short' }, 'binding_record_invalid'],
    [{ tabId: -1 }, 'binding_record_invalid'],
  ];
  for (const [overrides, code] of cases) {
    const out = run({ binding: binding(overrides) });
    check(!out.reviewAllowed && out.reasons.includes(code),
          'malformed binding record blocks review: ' + JSON.stringify(overrides));
  }
}

// -- Expired binding -----------------------------------------------------
{
  const out = run({ binding: binding({
    boundAt: NOW - P.BINDING_REVIEW_MAX_AGE_MS - 1 }) });
  check(!out.reviewAllowed && out.reasons.includes('binding_expired'),
        'binding older than the review window is expired');
  const edge = run({ binding: binding({
    boundAt: NOW - P.BINDING_REVIEW_MAX_AGE_MS }) });
  check(edge.reviewAllowed, 'binding exactly at the age limit is still accepted');
  const early = run({ binding: binding({ boundAt: NOW + 1 }) });
  check(!early.reviewAllowed && early.reasons.includes('binding_timestamp_invalid'),
        'future binding timestamp is rejected');
  const missing = run({ binding: binding({ boundAt: undefined }) });
  check(missing.reviewAllowed,
        'missing boundAt is reported but does not fabricate an expiry');
}

// -- Health failure taxonomy --------------------------------------------
{
  const cases = [
    [null, null, 'health_unavailable'],
    [{ ok: false, status: 'probe_timeout' }, null, 'probe_timeout'],
    [{ ok: false, status: 'content_unavailable' }, null, 'content_unavailable'],
    [{ ok: false, status: 'probe_stale' }, null, 'probe_stale'],
    [{ ok: false, status: 'binding_unavailable', reason: 'probe_timeout' },
      null, 'probe_timeout'],
    [{ ok: false, status: 'binding_unavailable', reason: 'frozen' },
      null, 'target_frozen'],
    [{ ok: false, status: 'binding_unavailable', reason: 'discarded' },
      null, 'target_discarded'],
    [{ ok: false, status: 'binding_unavailable',
      reason: 'frozen_state_unknown' }, null, 'frozen_state_unknown'],
    [{ ok: false, status: 'binding_unavailable',
      reason: 'route_changed_during_probe' }, null, 'route_changed'],
    [{ ok: false, status: 'binding_unavailable',
      reason: 'conversation_identity_mismatch' }, null,
    'conversation_identity_mismatch'],
    [{ ok: false, status: 'binding_unavailable',
      reason: 'binding_identity_mismatch' }, null, 'binding_identity_mismatch'],
  ];
  for (const [probe, _unused, expected] of cases) {
    const out = run({ health: probe });
    check(!out.reviewAllowed && out.reasons.includes(expected),
          'health failure maps to a specific reason: ' + expected);
  }
}

// -- Health snapshot contradictions -------------------------------------
{
  const cases = [
    [{ discarded: true }, 'target_discarded'],
    [{ frozen: true }, 'target_frozen'],
    [{ frozenStateKnown: false }, 'frozen_state_unknown'],
    [{ composerPresent: false }, 'composer_unavailable'],
    [{ routeStable: false }, 'route_changed'],
    [{ observedAt: NOW - P.PROPOSAL_MAX_AGE_MS - 1 }, 'health_stale'],
    [{ observedAt: NOW + 1 }, 'health_stale'],
  ];
  for (const [overrides, code] of cases) {
    const out = run({ health: health(overrides) });
    check(!out.reviewAllowed && out.reasons.includes(code),
          'inconsistent page snapshot blocks review: ' + code);
  }
}

// -- Cross tab / window / conversation ----------------------------------
{
  const cases = [
    [{ tabId: 8 }, 'binding_tab_mismatch'],
    [{ windowId: 3 }, 'binding_window_mismatch'],
    [{ url: URL2 }, 'binding_url_mismatch'],
    [{ conversationId: CONV2 }, 'binding_conversation_mismatch'],
    [{ documentInstanceId: DOC2 }, 'binding_document_mismatch'],
  ];
  for (const [overrides, code] of cases) {
    const out = run({ health: health(overrides) });
    check(!out.reviewAllowed && out.reasons.includes(code),
          'other tab/window/page cannot stand in for the bound target: ' + code);
  }
  const otherBinding = run({ health: health({ binding: binding({ revision: 4 }) }) });
  check(!otherBinding.reviewAllowed &&
        otherBinding.reasons.includes('binding_revision_changed'),
        'a newer binding revision during the probe blocks review');
  const noEvidence = run({ health: health({ binding: null }) });
  check(!noEvidence.reviewAllowed &&
        noEvidence.reasons.includes('health_binding_evidence_missing'),
        'health without binding evidence cannot be treated as matching');
}

// -- Simulated event validation -----------------------------------------
{
  const bads = [
    [{ metadata: 'x' }, 'event_fields_not_allowed'],
    [{ runId: 'not-a-uuid' }, 'run_id_invalid'],
    [{ status: 'running' }, 'event_status_not_allowed'],
    [{ status: 'unknown' }, 'event_status_not_allowed'],
    [{ status: undefined }, 'event_status_not_allowed'],
  ];
  for (const [overrides, code] of bads) {
    const out = run({ event: event(overrides) });
    check(!out.reviewAllowed && out.reasons.includes(code),
          'simulated event validation blocks: ' + code);
  }
  for (const status of P.ALLOWED_STATUSES) {
    const out = run({ event: event({ status,
      proposalId: P.createProposalId(RUN1, status, 1) }) });
    check(out.reviewAllowed && out.proposal.status === status,
          'allowed terminal status is reviewable: ' + status);
  }
}

// -- Duplicate events ----------------------------------------------------
{
  const first = run();
  const history = [{ kind: 't054-dry-run', runId: RUN1, status: 'completed',
    proposalId: first.proposal.proposalId }];
  const duplicate = run({ history });
  check(!duplicate.reviewAllowed && duplicate.reasons.includes('duplicate_event'),
        'the same run/status in session history is blocked as duplicate');
  const differentStatus = run({ history, event: event({ status: 'failed',
    proposalId: P.createProposalId(RUN1, 'failed', 2) }) });
  check(differentStatus.reviewAllowed,
        'a different terminal status for the same run is not a duplicate');
  const otherRun = run({ history, event: event({ runId: RUN2,
    proposalId: P.createProposalId(RUN2, 'completed', 2) }) });
  check(otherRun.reviewAllowed, 'a different run is not a duplicate');
  const unrelated = run({ history: [{ kind: 'other', runId: RUN1,
    status: 'completed' }] });
  check(unrelated.reviewAllowed,
        'history from a different subsystem does not suppress the event');
}

// -- Multiple failures are all reported ---------------------------------
{
  const out = run({ binding: binding({ invalidatedReason: 'tab_closed' }),
    health: health({ tabId: 9, frozen: true, composerPresent: false }) });
  check(!out.reviewAllowed && out.reasons.includes('binding_invalidated') &&
        (out.reasons.includes('binding_tab_mismatch') ||
          out.reasons.includes('target_frozen')),
        'multiple failures are retained instead of only the first');
}

// -- Proposal helpers ---------------------------------------------------
{
  check(P.createProposalId(RUN1, 'completed', 1) !==
        P.createProposalId(RUN1, 'completed', 2),
        'each local proposal sequence gets a distinct id');
  check(P.createProposalId(RUN1, 'running', 1) === null,
        'proposal id helper rejects statuses outside the allowlist');
  check(P.proposalText({ runId: RUN1, status: 'failed' }) ===
        'DSH task ' + RUN1 + ' failed.',
        'fixed template formats a failed terminal event');
  check(P.proposalText({ runId: RUN1, status: 'cancelled' }) ===
        'DSH task ' + RUN1 + ' cancelled.',
        'fixed template formats a cancelled terminal event');
  check(P.proposalText({ runId: 'bad', status: 'completed' }) === null,
        'fixed template refuses a malformed run id');
}

// -- Isolation: module has no Chrome, DOM, queue or send surface --------
{
  const source = readFileSync(
    new URL('./extension/lib/bound_dry_run.js', import.meta.url), 'utf8');
  const forbidden = [
    'chrome.', 'document.', 'window.', 'fetch(', 'sendMessage',
    'executeScript', 'innerText', 'textContent', 'querySelector',
    '.click(', 'dispatchEvent(', 'send_gate', 'nativeMessaging',
    'storage.local', 'storage.session', 'XMLHttpRequest',
  ];
  for (const token of forbidden) {
    check(!source.includes(token),
          'bound dry-run module does not reference: ' + token);
  }
}

console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
