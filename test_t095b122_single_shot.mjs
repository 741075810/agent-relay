// T095B122: the popup could only ask for the *standing* grant.
//
// T058's arm call from the popup passes no `maxSends` and no `ttlMs`, so the numbers the operator
// gets are the defaults: 1000 sends, 7 days. T059's trigger is the same shape -- default 100 per
// hour. A person who says "one test message" cannot express that with either control, and the
// only way to get one message out is to arm something far wider than what they agreed to.
//
// This suite pins the restricted path: a single-shot grant (1 send, 15 minutes), bound to the
// current binding revision, armed by typing its own phrase, isolated from candidates that ended
// before the arm, and consumed -- disarmed -- by *any* outcome, including an ambiguous one. The
// standing behaviour is asserted unchanged, because widening it is not what was asked for.
//
// Pure modules only; no chrome mock is needed and nothing here reaches a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as autosend from './extension/lib/autosend.js';
import * as trigger from './extension/lib/terminal_trigger.js';
import * as gate from './extension/lib/send_gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BINDING = {
  tabId: 4242,
  windowId: 5,
  url: 'https://chatgpt.com/c/conv-t122-0001',
  conversationId: 'conv-t122-0001',
  documentInstanceId: 'doc-t122-0001',
  revision: 7,
  manuallyConfirmed: true,
};

function terminalCandidate(runId, startedAtSec, origin = trigger.ORIGIN_BRIDGE) {
  return { runId, status: 'completed', origin, startedAt: startedAtSec,
    endedAtMs: startedAtSec * 1000 + 5000 };
}

test('T122: the standing arm is 1000 sends over 7 days -- far wider than "one test"', () => {
  const { result, state } = autosend.arm(autosend.createAutoSendState(),
    { binding: BINDING }, autosend.CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(result.ok, true);
  assert.equal(state.maxSends, autosend.DEFAULT_MAX_SENDS, 'the default is what the popup gets');
  assert.equal(state.maxSends, 1000);
  assert.equal(state.expiresAt - 1000, autosend.DEFAULT_TTL_MS);
  assert.equal(autosend.DEFAULT_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(state.singleShot, false, 'a standing grant is not a single shot');
});

test('T122: the trigger default is 100 per hour, also not "one"', () => {
  const { result, state } = trigger.configure(trigger.createTriggerState(),
    { binding: BINDING }, trigger.CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(result.ok, true);
  assert.equal(state.maxPerHour, 100);
  assert.equal(state.maxTriggers, null, 'no per-arm cap on the standing path');
});

test('T122: a single-shot arm is one send, fifteen minutes, its own phrase', () => {
  const now = 1_000_000;
  const { result, state } = autosend.arm(autosend.createAutoSendState(),
    { binding: BINDING, singleShot: true },
    autosend.SINGLE_SHOT_CONFIRM_PREFIX + BINDING.conversationId, true, now);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(state.singleShot, true);
  assert.equal(state.maxSends, 1);
  assert.equal(state.sentCount, 0);
  assert.equal(state.expiresAt - now, autosend.SINGLE_SHOT_TTL_MS);
  assert.equal(autosend.SINGLE_SHOT_TTL_MS, 15 * 60 * 1000);
  assert.equal(state.bindingRevision, BINDING.revision);
  assert.equal(state.conversationId, BINDING.conversationId);
});

test('T122: the single-shot phrase cannot be reused for the standing grant', () => {
  const once = autosend.arm(autosend.createAutoSendState(), { binding: BINDING },
    autosend.SINGLE_SHOT_CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(once.result.ok, false);
  assert.equal(once.result.code, 'arm_confirmation_mismatch');

  const standingPhrase = autosend.arm(autosend.createAutoSendState(),
    { binding: BINDING, singleShot: true },
    autosend.CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(standingPhrase.result.ok, false,
    'the standing phrase must not arm the restricted grant');
});

test('T122: a single shot cannot be widened by asking for more', () => {
  const { state } = autosend.arm(autosend.createAutoSendState(),
    { binding: BINDING, singleShot: true, maxSends: 50, ttlMs: 7 * 24 * 60 * 60 * 1000 },
    autosend.SINGLE_SHOT_CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(state.maxSends, 1, 'the ceiling for a single shot is one, whatever is asked');
  assert.equal(state.expiresAt - 1000, autosend.SINGLE_SHOT_TTL_MS);
});

test('T122: any outcome consumes the single shot -- no retry, no second message', () => {
  const now = 1000;
  const armed = autosend.arm(autosend.createAutoSendState(), { binding: BINDING, singleShot: true },
    autosend.SINGLE_SHOT_CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  for (const outcome of ['sent', 'ambiguous', 'blocked', 'written_not_clicked']) {
    const done = autosend.consumeSingleShot(armed, outcome, now + 10);
    assert.equal(done.consumed, true, outcome + ' must consume the grant');
    assert.equal(done.state.enabled, false, outcome + ' must leave nothing armed');
    assert.match(String(done.state.lastError || ''), /single_shot/, outcome);
    assert.equal(done.state.singleShotOutcome, outcome);
  }
  const done = autosend.consumeSingleShot(armed, 'deferred', now + 10);
  assert.equal(done.consumed, false, 'a deferral is not a send: the shot must survive it');
  assert.equal(done.state.enabled, true);
});

test('T122: consuming a standing grant never disarms it', () => {
  const standing = autosend.arm(autosend.createAutoSendState(), { binding: BINDING },
    autosend.CONFIRM_PREFIX + BINDING.conversationId, true, 1000).state;
  const done = autosend.consumeSingleShot(standing, 'sent', 2000);
  assert.equal(done.consumed, false);
  assert.equal(done.state.enabled, true, 'the long-term path must behave exactly as before');
});

test('T122: an expired single shot arms nothing', () => {
  const now = 5000;
  const state = autosend.arm(autosend.createAutoSendState(), { binding: BINDING, singleShot: true },
    autosend.SINGLE_SHOT_CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  const later = now + autosend.SINGLE_SHOT_TTL_MS + 1;
  assert.equal(autosend.grantIsLive(state, later), false, 'the grant must be dead after its window');
  assert.equal(autosend.grantIsLive(state, now + 60_000), true);
});

test('T122: the trigger carries a one-shot cap and refuses after it is spent', () => {
  const now = 10_000;
  const configured = trigger.configure(trigger.createTriggerState(),
    { binding: BINDING, maxTriggers: 1 },
    trigger.CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  assert.equal(configured.maxTriggers, 1);
  const candidate = terminalCandidate('11111111-1111-4111-8111-111111111111', now / 1000);
  const first = trigger.admit(configured, candidate, now + 1000);
  assert.equal(first.admit, true, JSON.stringify(first));
  const marked = trigger.markAttempt(configured, candidate, now + 2000);
  // T142: the marker is a barrier; the *outcome* is what spends the cap.
  assert.equal(trigger.admit(marked.state, terminalCandidate(
    '22222222-2222-4222-8222-222222222222', now / 1000), now + 3000).code,
  'attempt_in_flight');
  const spent = trigger.settle(marked.state, marked.key,
    { sent: true, pageWriteAttempted: true }, now + 2500).state;
  const second = trigger.admit(spent, terminalCandidate('22222222-2222-4222-8222-222222222222',
    now / 1000), now + 3000);
  assert.equal(second.admit, false);
  assert.equal(second.code, 'trigger_limit_reached');
});

test('T122: two candidates that both ended after the arm are refused, not raced', () => {
  const now = 20_000;
  const armed = trigger.configure(trigger.createTriggerState(),
    { binding: BINDING, maxTriggers: 1 },
    trigger.CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  const a = terminalCandidate('33333333-3333-4333-8333-333333333333', now / 1000 + 1);
  const b = terminalCandidate('44444444-4444-4444-8444-444444444444', now / 1000 + 2);
  // T142: the earliest completion after the arm is what this arm is about.
  const picked = trigger.guardSingleCandidate(armed, [a, b], now + 5000);
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.equal(picked.count, 2);
  assert.equal(picked.chosen, a.endedAtMs <= b.endedAtMs ? a.runId : b.runId);
  // A genuine tie cannot be ordered, so it is still refused rather than guessed.
  const tie = Object.assign({}, b, { endedAtMs: a.endedAtMs, startedAt: a.startedAt });
  const conflict = trigger.guardSingleCandidate(armed, [a, tie], now + 5000);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'single_shot_multiple_candidates');
  assert.deepEqual(conflict.runIds.slice().sort(), [a.runId, tie.runId].sort());

  const one = trigger.guardSingleCandidate(armed, [a], now + 5000);
  assert.equal(one.ok, true, JSON.stringify(one));
  const none = trigger.guardSingleCandidate(armed, [], now + 5000);
  assert.equal(none.ok, true, 'nothing eligible is not a conflict');
  assert.equal(none.count, 0);
});

test('T122: a run that ended before the arm is never the single shot', () => {
  const now = 30_000;
  const armed = trigger.configure(trigger.createTriggerState(),
    { binding: BINDING, maxTriggers: 1 },
    trigger.CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  const historical = terminalCandidate('55555555-5555-4555-8555-555555555555', now / 1000 - 600);
  const guard = trigger.guardSingleCandidate(armed, [historical], now + 1000);
  assert.equal(guard.count, 0, 'a candidate that ended before the arm is not eligible');
  assert.equal(trigger.completionAfterArm(armed, historical).proven, false);
});

test('T122: a page without focus is still refused under a single shot', () => {
  const proposalId = 'a'.repeat(64);
  const runId = '66666666-6666-4666-8666-666666666666';
  const convId = '77777777-7777-4777-8777-777777777777';
  const proposal = gate.createProposal(proposalId, runId, 'completed');
  assert.equal(proposal.ok, true, JSON.stringify(proposal));
  let state = gate.createSendState();
  const bound = gate.bindTarget(state, {
    conversationId: convId,
    url: 'https://chatgpt.com/c/' + convId,
    tabId: BINDING.tabId, windowId: 9,
    accountFingerprint: 'a'.repeat(64),
    accountVerified: true,
  }, 'BIND ' + convId, true);
  assert.equal(bound.result.ok, true, JSON.stringify(bound.result));
  state = bound.state;
  state = gate.enableSending(state, 'ENABLE CHAT SEND', true).state;
  state = gate.addPending(state, proposal.proposal, 1000).state;
  const reports = [{ tabId: BINDING.tabId, windowId: 9, observedAt: 1500,
    url: 'https://chatgpt.com/c/' + convId, conversationId: convId,
    accountFingerprint: 'a'.repeat(64), active: true, hasFocus: false,
    visibilityState: 'visible' }];
  const dry = gate.dryRun(state, proposal.proposal, reports, BINDING.tabId, 2000);
  assert.equal(dry.wouldSend, false, 'losing focus must stop the write');
  assert.equal(dry.reason, 'target_not_visible_and_focused');
});

test('T122: the popup offers the restricted control, next to the standing one', () => {
  const html = fs.readFileSync(path.join(HERE, 'extension', 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(HERE, 'extension', 'popup.js'), 'utf8');
  for (const id of ['notifyAuthOnceState', 'notifyAuthOncePhrase',
    'notifyAuthOnceConfirmation', 'notifyAuthOnceArm']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing control: ' + id);
  }
  assert.match(js, /t058-arm-once/, 'the popup must send its own message for the restricted arm');
  assert.match(js, /singleShotPhrase/,
    'the restricted arm must show the phrase from the shared view module');
  // The one literal lives in lib/single_shot_view.js; it must equal the worker's constant, or
  // the operator would copy a phrase the worker refuses.
  const view = fs.readFileSync(path.join(HERE, 'extension', 'lib', 'single_shot_view.js'), 'utf8');
  const literal = /const PREFIX = '([^']+)'/.exec(view);
  assert.ok(literal, 'the view module must declare its prefix');
  assert.equal(literal[1], autosend.SINGLE_SHOT_CONFIRM_PREFIX,
    'the popup phrase and the worker phrase must be the same string');
  assert.match(html, /lib\/single_shot_view\.js/,
    'popup.html must load the view module before popup.js');
  // The standing controls stay where they are: this is an addition, not a replacement.
  for (const id of ['notifyAuthPhrase', 'notifyAuthConfirmation', 'notifyAuthArm']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'standing control disappeared: ' + id);
  }
});

test('T122: the background consumes the single shot and guards concurrent candidates', () => {
  const js = fs.readFileSync(path.join(HERE, 'extension', 'background.js'), 'utf8');
  const controller = fs.readFileSync(path.join(HERE, 'extension', 'lib',
    'autosend_controller.js'), 'utf8');
  assert.match(controller, /consumeSingleShot/,
    'the send path must consume the single shot');
  assert.match(controller, /armOnce/, 'the controller must expose the restricted arm');
  assert.match(controller, /singleShotConsumed/,
    'the caller must be able to see that the shot was spent');
  assert.match(js, /guardSingleCandidate/, 'the loop must refuse two eligible candidates');
  assert.match(js, /t058-arm-once/, 'the popup message must be handled');
  assert.match(js, /armOnce\(/, 'the handler must go through the restricted arm');
  // The handler must not accept limits from the message: that is how "one" becomes "many".
  assert.match(js, /armOnce\(\s*msg\.confirmation,\s*msg\.userGesture === true\)/,
    'the restricted arm must be called with the phrase and a gesture only');
});

// The controller is where "arm" and "send" meet, so the one-shot property has to hold across
// both: one write, then nothing -- including when the write's outcome is uncertain.
test('T122: end to end -- one write, then the grant is gone', async () => {
  const { createAutoSendController } = await import(
    './extension/lib/autosend_controller.js');
  const writes = [];
  let stored = null;
  const probeReport = (now) => ({
    tabId: BINDING.tabId, windowId: 5, observedAt: now,
    url: 'https://chatgpt.com/c/' + BINDING.conversationId,
    conversationId: BINDING.conversationId,
    documentInstanceId: BINDING.documentInstanceId,
    active: true, hasFocus: true, visibilityState: 'visible',
    composerEmpty: true, composerPresent: true,
  });
  let clock = 1000;
  const controller = createAutoSendController({
    now: () => clock,
    load: async () => stored,
    save: async (next) => { stored = JSON.parse(JSON.stringify(next)); },
    readBinding: async () => BINDING,
    probe: async () => probeReport(clock),
    write: async (candidate) => {
      writes.push(candidate.runId);
      return { status: 'submitted', reason: null,
        evidence: { composerEmpty: true } };
    },
  });

  const armed = await controller.armOnce(
    autosend.SINGLE_SHOT_CONFIRM_PREFIX + BINDING.conversationId, true);
  assert.equal(armed.ok, true, JSON.stringify(armed));
  assert.equal(armed.maxSends, 1);

  clock += 100;
  const first = await controller.sendOnce({ runId: '77777777-7777-4777-8777-777777777777',
    status: 'completed' });
  assert.equal(first.sent, true, JSON.stringify(first));
  assert.equal(first.singleShotConsumed, true);
  assert.equal(writes.length, 1);

  const second = await controller.sendOnce({ runId: '88888888-8888-4888-8888-888888888888',
    status: 'completed' });
  assert.equal(second.sent, false);
  assert.equal(writes.length, 1, 'the second message must never reach the page');
  assert.ok(['autosend_disabled', 'authorization_exhausted'].includes(second.code),
    'second attempt refused by the spent grant, got ' + second.code);
});

test('T122: an uncertain write also ends the grant -- no retry loop', async () => {
  const { createAutoSendController } = await import(
    './extension/lib/autosend_controller.js');
  let writes = 0;
  let stored = null;
  let clock = 2000;
  const controller = createAutoSendController({
    now: () => clock,
    load: async () => stored,
    save: async (next) => { stored = JSON.parse(JSON.stringify(next)); },
    readBinding: async () => BINDING,
    probe: async () => ({
      tabId: BINDING.tabId, windowId: 5, observedAt: clock,
      url: 'https://chatgpt.com/c/' + BINDING.conversationId,
      conversationId: BINDING.conversationId,
      documentInstanceId: BINDING.documentInstanceId,
      active: true, hasFocus: true, visibilityState: 'visible',
      composerEmpty: true, composerPresent: true,
    }),
    write: async () => { writes += 1; return { status: 'unconfirmed', reason: 'timeout' }; },
  });
  await controller.armOnce(autosend.SINGLE_SHOT_CONFIRM_PREFIX + BINDING.conversationId, true);
  clock += 100;
  const first = await controller.sendOnce({ runId: '99999999-9999-4999-8999-999999999999',
    status: 'completed' });
  assert.equal(first.sent, false);
  assert.equal(first.pageWriteAttempted, true, 'an unconfirmed write still touched the page');
  assert.equal(first.singleShotConsumed, true, 'uncertain means stop, not retry');
  assert.equal(stored.enabled, false);

  clock += 100;
  const again = await controller.sendOnce({ runId: '99999999-9999-4999-8999-999999999998',
    status: 'completed' });
  assert.equal(again.sent, false);
  assert.equal(writes, 1, 'no second write after an ambiguous one');
});
