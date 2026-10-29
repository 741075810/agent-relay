// Offline policy tests. No Chrome, DOM mutation, network or send adapter.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = new URL('./extension/lib/send_gate.js', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 't051-send-gate-'));
const copy = join(dir, 'send_gate.mjs');
writeFileSync(copy, readFileSync(source));
const G = await import(pathToFileURL(copy).href);
rmSync(dir, { recursive: true, force: true });

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
function proposal(runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  status = 'completed') {
  return G.createProposal('1'.repeat(64), runId, status).proposal;
}
function report(overrides = {}, now = Date.now()) {
  return Object.assign({
    tabId: 7,
    windowId: 2,
    url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    conversationId: '11111111-1111-4111-8111-111111111111',
    accountFingerprint: 'a'.repeat(64),
    observedAt: now,
    active: true,
    discarded: false,
    visibilityState: 'visible',
    hasFocus: true,
    composerPresent: true,
    redirected: false,
  }, overrides);
}
function boundState() {
  const binding = {
    conversationId: '11111111-1111-4111-8111-111111111111',
    url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    tabId: 7,
    windowId: 2,
    accountFingerprint: 'a'.repeat(64),
    accountVerified: true,
  };
  const bound = G.bindTarget(G.createSendState(), binding,
    'BIND ' + binding.conversationId, true);
  const enabled = G.enableSending(bound.state, 'ENABLE CHAT SEND', true);
  return enabled.state;
}
const reports = [report()];

{
  const state = G.createSendState();
  check(state.enabled === false && state.binding === null,
        'send channel starts disabled and unbound');
  const missing = G.bindTarget(state, {}, '');
  check(!missing.result.ok, 'binding rejects empty target');
}

{
  const state = G.createSendState();
  const bads = [
    [{ conversationId: '11111111-1111-4111-8111-111111111111',
       url: 'https://chatgpt.com/', tabId: 7, windowId: 2,
       accountFingerprint: 'a'.repeat(64), accountVerified: true }, 'x'],
    [{ conversationId: '11111111-1111-4111-8111-111111111111',
       url: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222',
       tabId: 7, windowId: 2, accountFingerprint: 'a'.repeat(64),
       accountVerified: true }, 'BIND 11111111-1111-4111-8111-111111111111'],
    [{ conversationId: '11111111-1111-4111-8111-111111111111',
       url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
       tabId: 7, windowId: 2, accountFingerprint: null,
       accountVerified: true }, 'BIND 11111111-1111-4111-8111-111111111111'],
    [{ conversationId: '11111111-1111-4111-8111-111111111111',
       url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
       tabId: 7, windowId: 2, accountFingerprint: 'a'.repeat(64),
       accountVerified: false }, 'BIND 11111111-1111-4111-8111-111111111111'],
    [{ conversationId: '11111111-1111-4111-8111-111111111111',
       url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111?x=1',
       tabId: 7, windowId: 2, accountFingerprint: 'a'.repeat(64),
       accountVerified: true }, 'BIND 11111111-1111-4111-8111-111111111111'],
  ];
  for (const [candidate, confirmation] of bads) {
    check(!G.bindTarget(state, candidate, confirmation).result.ok,
          'binding rejects malformed URL or unverified account identity');
  }
  const good = {
    conversationId: '11111111-1111-4111-8111-111111111111',
    url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    tabId: 7, windowId: 2, accountFingerprint: 'a'.repeat(64),
    accountVerified: true,
  };
  check(!G.bindTarget(state, good, 'yes').result.ok,
        'binding requires exact conversation confirmation');
  check(!G.bindTarget(state, good,
    'BIND ' + good.conversationId, false).result.ok,
    'binding requires a user gesture');
  check(!G.enableSending(G.bindTarget(state, good,
    'BIND ' + good.conversationId, true).state,
    'ENABLE CHAT SEND', false).result.ok,
    'global enable requires a user gesture');
  const bound = G.bindTarget(state, good,
    'BIND ' + good.conversationId, true);
  check(bound.result.ok && bound.state.enabled === false,
        'confirmed unique binding does not enable sending');
}

{
  const rawHostEvent = {
    eventId: '2'.repeat(64), name: 'task.completed',
    runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'completed',
    deliverable: false, message: 'PRIVATE DSH LOG MUST NOT LEAK',
  };
  const rejected = G.addPending(G.createSendState(), rawHostEvent);
  check(!rejected.result.ok && rejected.result.code === 'proposal_fields_not_allowed',
        'display-only Native Host event cannot enter the separate send channel');
  const p = proposal();
  const withText = Object.assign({}, p, { message: 'secret' });
  check(!G.addPending(G.createSendState(), withText).result.ok,
        'proposal rejects arbitrary text, logs, paths and credentials');
  const fixed = G.fixedTemplate(p);
  check(fixed.ok && fixed.text ===
        'DSH task aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa completed.',
        'fixed template contains only run id and allowlisted status');
  check(!fixed.text.includes('secret') && !fixed.text.includes('PRIVATE'),
        'fixed template has no user-supplied DSH text');
}

{
  const p = proposal();
  const added = G.addPending(G.createSendState(), p, 10);
  check(added.result.ok && added.result.item.statusState === 'pending',
        'proposal enters pending without sending');
  const duplicate = G.addPending(added.state, p, 11);
  check(duplicate.result.duplicate && Object.keys(duplicate.state.items).length === 1,
        'proposal identity deduplicates');
  const collision = G.addPending(added.state,
    G.createProposal(p.proposalId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                     'failed').proposal);
  check(!collision.result.ok, 'proposal id collision is refused');
}

{
  const state = boundState();
  const p = proposal();
  const queued = G.addPending(state, p, Date.now()).state;
  const dry = G.dryRun(queued, p, reports, 7);
  check(dry.ok && dry.wouldSend === false && dry.eligible === true &&
        dry.stateWritten === false,
        'visible preflight dry-run is read-only and never sends');
  const invisible = G.dryRun(state, p, [report({ active: false })], 7);
  check(!invisible.wouldSend && !invisible.eligible &&
        invisible.reason === 'target_not_visible_and_focused',
        'dry-run refuses non-visible target');
  const blank = G.dryRun(state, p, [report({
    url: 'https://chatgpt.com/', conversationId: null,
  })], 7);
  check(blank.reason === 'redirect_or_url_mismatch',
        'dry-run refuses blank/new chat');
}

{
  const state = boundState();
  const p = proposal();
  const negatives = [
    [reports, 8, 'wrong_tab'],
    [[report({ windowId: 9 })], 7, 'wrong_window'],
    [[report({ url: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222',
               conversationId: '22222222-2222-4222-8222-222222222222' })], 7,
      'redirect_or_url_mismatch'],
    [[report({ conversationId: '22222222-2222-4222-8222-222222222222' })], 7,
      'conversation_identity_mismatch'],
    [[report({ accountFingerprint: 'b'.repeat(64) })], 7,
      'account_identity_mismatch'],
    [[report({ accountFingerprint: null })], 7,
      'account_identity_unavailable'],
    [[report({ active: false, visibilityState: 'hidden', hasFocus: false })], 7,
      'target_not_visible_and_focused'],
    [[report({ discarded: true })], 7, 'target_discarded'],
    [[report({ composerPresent: false })], 7, 'composer_unavailable'],
    [[report({ redirected: true })], 7, 'page_redirected'],
    [[report({ observedAt: 0 })], 7, 'probe_stale'],
    [[report({ observedAt: 20000 })], 7, 'probe_stale'],
    [[report(), report()], 7, 'ambiguous_target_tab'],
  ];
  for (const [rs, tab, code] of negatives) {
    const result = G.dryRun(state, p, rs, tab);
    check(!result.eligible && result.reason === code,
          'preflight rejects ' + code);
  }
}

{
  const state = boundState();
  const p = proposal();
  let added = G.addPending(state, p, 100);
  const dry = G.dryRun(added.state, p, reports, 7);
  check(dry.eligible && dry.wouldSend === false,
        'pending item remains dry-run eligible but does not act');
  const noGesture = G.approvePending(added.state, p.proposalId,
    'SEND ' + p.runId, false, 110);
  check(!noGesture.result.ok, 'approval requires a user gesture');
  const wrongPhrase = G.approvePending(added.state, p.proposalId,
    'SEND something else', true, 110);
  check(!wrongPhrase.result.ok, 'approval requires exact run-specific phrase');
  const approved = G.approvePending(added.state, p.proposalId,
    'SEND ' + p.runId, true, 110);
  check(approved.result.ok, 'manual one-item approval is accepted');
  const attempt = G.beginAttempt(approved.state, p.proposalId,
    { reports: [report({}, 120)], requestedTabId: 7 }, 120);
  check(attempt.result.ok && attempt.state.items[p.proposalId].statusState ===
        'attempting' && attempt.state.items[p.proposalId].attemptCount === 1,
        'approved attempt is recorded before any adapter could act');
  const duplicateAttempt = G.beginAttempt(attempt.state, p.proposalId,
    { reports, requestedTabId: 7 }, 121);
  check(!duplicateAttempt.result.ok,
        'attempting proposal cannot be started a second time');
  const disabled = G.disableSending(attempt.state, 122);
  check(!disabled.state.enabled &&
        disabled.state.items[p.proposalId].statusState === 'ambiguous',
        'immediate disable during an attempt marks outcome ambiguous');
}

{
  let clock = 1000;
  const data = { sendPolicyState: G.createSendState() };
  const writes = [];
  const policy = new G.PersistentSendPolicy({
    get: async (defaults) => Object.assign({}, defaults, data),
    set: async (values) => {
      writes.push(values);
      if (values.sendPolicyState) data.sendPolicyState = values.sendPolicyState;
    },
    now: () => clock,
  });
  const p = proposal();
  await policy.addPending(p);
  await policy.bindTarget({
    conversationId: '11111111-1111-4111-8111-111111111111',
    url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111',
    tabId: 7, windowId: 2, accountFingerprint: 'a'.repeat(64),
    accountVerified: true,
  }, 'BIND 11111111-1111-4111-8111-111111111111', true);
  await policy.enable('ENABLE CHAT SEND', true);
  await policy.approve(p.proposalId, 'SEND ' + p.runId, true);
  const before = writes.length;
  const dry = await policy.dryRun(p, [report({}, clock)], 7);
  check(dry.wouldSend === false && writes.length === before,
        'persistent dry-run does not mutate storage');
  const begun = await policy.beginAttempt(p.proposalId,
    { reports: [report({}, clock)], requestedTabId: 7 });
  check(begun.started && data.sendPolicyState.items[p.proposalId].statusState ===
        'attempting', 'attempt state is durable before simulated adapter call');
  const interrupted = await policy.recoverInterruptedAttempts();
  check(interrupted.recovered === 1 &&
        data.sendPolicyState.items[p.proposalId].statusState === 'ambiguous',
        'worker restart turns in-flight attempt into ambiguous');
  const retry = await policy.beginAttempt(p.proposalId,
    { reports, requestedTabId: 7 });
  check(!retry.ok, 'ambiguous attempt is never retried automatically');
  clock += 100000;
}

{
  const state = boundState();
  const p = proposal();
  const pending = G.addPending(state, p, 1).state;
  const approval = G.approvePending(pending, p.proposalId,
    'SEND ' + p.runId, true, 100);
  const expired = G.beginAttempt(approval.state, p.proposalId,
    { reports: [report({}, 61001)], requestedTabId: 7 }, 61001);
  check(!expired.result.ok && expired.result.code ===
        'fresh_manual_approval_required', 'expired approval cannot start');
}

{
  let state = boundState();
  const p = proposal();
  state = G.addPending(state, p, 1).state;
  state = G.approvePending(state, p.proposalId, 'SEND ' + p.runId, true, 10).state;
  state = G.beginAttempt(state, p.proposalId,
    { reports: [report({}, 20)], requestedTabId: 7 }, 20).state;
  const timedOut = G.finishAttempt(state, p.proposalId, { kind: 'timeout' }, 30000);
  check(!timedOut.result.ok && timedOut.result.code === 'ambiguous' &&
        timedOut.state.items[p.proposalId].statusState === 'ambiguous',
        'unconfirmed timeout becomes ambiguous');
  const retry = G.beginAttempt(timedOut.state, p.proposalId,
    { reports, requestedTabId: 7 }, 30001);
  check(!retry.result.ok, 'timeout is not blindly resent');
}

{
  let state = boundState();
  const p = proposal();
  state = G.addPending(state, p, 1).state;
  state = G.approvePending(state, p.proposalId, 'SEND ' + p.runId, true, 10).state;
  state = G.beginAttempt(state, p.proposalId,
    { reports: [report({}, 20)], requestedTabId: 7 }, 20).state;
  const evidence = {
    kind: 'confirmed', proposalId: p.proposalId, runId: p.runId,
    conversationId: state.binding.conversationId,
    tabId: state.binding.tabId, windowId: state.binding.windowId,
    url: state.binding.url,
    accountFingerprint: state.binding.accountFingerprint,
    observedAt: 20,
    visible: true, hasFocus: true,
    exactTemplateMatched: true, composerEmpty: true,
  };
  const confirmed = G.finishAttempt(state, p.proposalId, evidence, 30);
  check(confirmed.result.ok &&
        confirmed.state.items[p.proposalId].statusState === 'confirmed',
        'confirmation requires matching proposal, target and exact evidence');
  const weak = G.finishAttempt(state, p.proposalId,
    Object.assign({}, evidence, { accountFingerprint: 'b'.repeat(64) }), 31);
  check(!weak.result.ok && weak.state.items[p.proposalId].statusState ===
        'ambiguous', 'identity mismatch cannot confirm an attempt');
  const wrongProposal = G.finishAttempt(state, p.proposalId,
    Object.assign({}, evidence, { proposalId: '2'.repeat(64) }), 32);
  check(!wrongProposal.result.ok &&
        wrongProposal.state.items[p.proposalId].statusState === 'ambiguous',
        'evidence for a different proposal cannot confirm');
  const staleEvidence = G.finishAttempt(state, p.proposalId,
    Object.assign({}, evidence, { observedAt: 0 }), 33);
  check(!staleEvidence.result.ok &&
        staleEvidence.state.items[p.proposalId].statusState === 'ambiguous',
        'missing or stale confirmation evidence becomes ambiguous');
}

{
  let state = boundState();
  const p = proposal();
  state = G.addPending(state, p, 1).state;
  state = G.approvePending(state, p.proposalId, 'SEND ' + p.runId, true, 10).state;
  const disabled = G.disableSending(state, 11);
  check(!disabled.state.enabled && !disabled.state.items[p.proposalId].approval,
        'immediate disable clears all pending approvals');
  const enabledAgain = G.enableSending(disabled.state,
    'ENABLE CHAT SEND', true).state;
  const fresh = G.beginAttempt(enabledAgain, p.proposalId,
    { reports, requestedTabId: 7 }, 12);
  check(!fresh.result.ok, 're-enable still requires per-event reapproval');
}

{
  let state = boundState();
  const p = proposal();
  state = G.addPending(state, p, 1).state;
  state = G.approvePending(state, p.proposalId, 'SEND ' + p.runId, true, 10).state;
  const attempted = G.beginAttempt(state, p.proposalId,
    { reports: [report({}, 20)], requestedTabId: 7 }, 20).state;
  const rebound = G.bindTarget(attempted, {
    conversationId: '22222222-2222-4222-8222-222222222222',
    url: 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222',
    tabId: 9, windowId: 3, accountFingerprint: 'b'.repeat(64),
    accountVerified: true,
  }, 'BIND 22222222-2222-4222-8222-222222222222', true);
  check(rebound.state.items[p.proposalId].statusState === 'ambiguous',
        'rebinding during an attempt makes its outcome ambiguous');
}

{
  const state = boundState();
  const p = proposal();
  let pending = G.addPending(state, p, 1).state;
  pending = G.approvePending(pending, p.proposalId,
    'SEND ' + p.runId, true, 10).state;
  const refused = G.beginAttempt(pending, p.proposalId,
    { reports: [report({ active: false }, 20)], requestedTabId: 7 }, 20);
  check(!refused.result.ok && !refused.state.items[p.proposalId].approval,
        'preflight failure burns the one-item approval');
}

{
  const state = G.createSendState();
  for (let index = 0; index < G.MAX_ITEMS; index += 1) {
    const id = index.toString(16).padStart(64, '0');
    const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const p = G.createProposal(id, runId, 'completed').proposal;
    state.items[id] = { proposalId: id, runId, status: 'completed',
      statusState: 'pending', attemptCount: 0 };
  }
  const over = G.addPending(state, proposal('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  check(!over.result.ok && over.result.code === 'send_state_capacity_reached',
        'persistent attempt journal has a hard item cap');
}

{
  let data = { sendPolicyState: boundState() };
  const p = proposal();
  data.sendPolicyState = G.addPending(data.sendPolicyState, p, 1).state;
  data.sendPolicyState = G.approvePending(data.sendPolicyState, p.proposalId,
    'SEND ' + p.runId, true, 10).state;
  let failWrite = true;
  const policy = new G.PersistentSendPolicy({
    get: async (defaults) => Object.assign({}, defaults, data),
    set: async (values) => {
      if (failWrite) throw new Error('simulated storage failure');
      data.sendPolicyState = values.sendPolicyState;
    },
    now: () => 20,
  });
  let rejected = false;
  try {
    await policy.beginAttempt(p.proposalId,
      { reports: [report({}, 20)], requestedTabId: 7 });
  } catch (_err) {
    rejected = true;
  }
  check(rejected && data.sendPolicyState.items[p.proposalId].statusState ===
        'pending', 'failed pre-attempt persistence yields no adapter permission');
  failWrite = false;
}

{
  const documentLike = {
    location: { href: report().url },
    visibilityState: 'visible',
    hasFocus: () => true,
    querySelectorAll: (selector) => selector.includes('prompt-textarea')
      ? [{ getBoundingClientRect: () => ({ width: 20, height: 10 }) }]
      : [],
  };
  const probe = G.probeReadOnly(documentLike, {
    tabId: 7, windowId: 2, active: true,
    accountFingerprint: 'a'.repeat(64),
  });
  check(probe.conversationId === report().conversationId &&
        probe.composerPresent && probe.url === report().url,
        'simulated DOM probe only reads URL, visibility and composer presence');
  const source = readFileSync(sourceFilePath(), 'utf8');
  for (const token of ['.click(', 'dispatchEvent(', 'execCommand(',
                       '.value =', 'innerText', 'textContent']) {
    check(!source.includes(token), 'send gate contains no page write primitive ' + token);
  }
  check(!source.includes('chrome.tabs.update') &&
        !source.includes('chrome.windows.update') &&
        !source.includes('connectNative'),
        'send gate cannot activate tabs/windows or use the native display queue');
  const background = readFileSync(new URL('./extension/background.js',
    import.meta.url), 'utf8');
  const content = readFileSync(new URL('./extension/content.js',
    import.meta.url), 'utf8');
  const popup = readFileSync(new URL('./extension/popup.js',
    import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('./extension/manifest.json',
    import.meta.url), 'utf8'));
  check(!background.includes('send_gate') && !content.includes('send_gate') &&
        !popup.includes('send_gate'),
        'mock send gate is not wired into existing extension scripts');
  // T095B76 widened this list by exactly one entry, `scripting`, so a content script
  // destroyed by an extension reload can be put back into the tab the operator already
  // bound. The boundary is restated rather than removed: nothing broader than
  // `scripting` may be added, and the injection itself is confined to one module.
  check(manifest.permissions.slice().sort().join(',') ===
        ['alarms', 'nativeMessaging', 'storage', 'tabs', 'scripting'].sort().join(','),
        'manifest permissions are exactly the five the code uses ('
        + manifest.permissions.slice().sort().join(',') + ')');
  check(!manifest.permissions.includes('webNavigation') &&
        !manifest.permissions.includes('debugger') &&
        !manifest.permissions.includes('<all_urls>'),
        'and still exclude webNavigation, debugger and <all_urls>');
  const reconnectSource = readFileSync(
    new URL('./extension/lib/content_reconnect.js', import.meta.url), 'utf8');
  check(reconnectSource.includes('scripting.executeScript') &&
        !background.includes('executeScript') &&
        !content.includes('executeScript') &&
        !popup.includes('executeScript'),
        'injection lives in one module; the scripts themselves never inject');
  const contentCode = content.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  check(!contentCode.includes('.click(') &&
        !contentCode.includes('dispatchEvent(') &&
        !contentCode.includes('execCommand(') &&
        !contentCode.includes('innerText') &&
        !contentCode.includes('textContent'),
        'existing content script remains read-only');
  check(!background.includes('chrome.tabs.update') &&
        !background.includes('chrome.windows.update') &&
        !background.includes('executeScript'),
        'background still cannot activate pages or inject code');
}

function sourceFilePath() {
  return new URL('./extension/lib/send_gate.js', import.meta.url);
}

console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
