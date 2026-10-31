// T095B123: T122 gave the *send* a one-shot form; the *trigger* that offers candidates had none.
//
// `terminal_trigger.configure()` accepts `maxTriggers` and `guardSingleCandidate()` refuses a
// second eligible candidate, but nothing in the shipped UI can reach either: the popup's only
// trigger button sends `AUTOTRIGGER <conv>` with no `maxTriggers`, and the background handler
// forwards only `binding`/`minIntervalMs`/`maxPerHour`. So `guardSingleCandidate` always takes
// its `unlimited` branch in production, and a T059 arm keeps firing at the hourly rate long
// after the T058 single shot is spent.
//
// This suite pins the restricted trigger: its own phrase, `maxTriggers` forced to one by the
// module and never read from a message, a 15-minute window that fails closed, and a disarm on
// the first send (or the first uncertain one) that also clears the alarm. The standing path is
// asserted unchanged, because changing it is not what was asked for.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as trigger from './extension/lib/terminal_trigger.js';
import * as autosend from './extension/lib/autosend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, 'extension');

const BINDING = {
  tabId: 4242,
  windowId: 5,
  url: 'https://chatgpt.com/c/conv-t123-0001',
  conversationId: 'conv-t123-0001',
  documentInstanceId: 'doc-t123-0001',
  revision: 7,
  manuallyConfirmed: true,
};

function candidate(runId, startedAtSec, status = 'completed') {
  return { runId, status, origin: trigger.ORIGIN_BRIDGE, startedAt: startedAtSec,
    endedAtMs: startedAtSec * 1000 + 5000 };
}

test('T123: the standing trigger still has no per-arm cap', () => {
  const done = trigger.configure(trigger.createTriggerState(),
    { binding: BINDING }, trigger.CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(done.result.ok, true);
  assert.equal(done.state.maxTriggers, null, 'the standing path must not silently become capped');
  assert.equal(done.state.singleShotTrigger, false);
});

test('T123: a restricted trigger has its own phrase and a hard cap of one', () => {
  const now = 100_000;
  const done = trigger.configureOnce(trigger.createTriggerState(),
    { binding: BINDING }, trigger.ONCE_CONFIRM_PREFIX + BINDING.conversationId, true, now);
  assert.equal(done.result.ok, true, JSON.stringify(done.result));
  assert.equal(done.state.maxTriggers, 1);
  assert.equal(done.state.singleShotTrigger, true);
  assert.equal(done.state.triggers, 0);
  assert.equal(done.state.expiresAt - now, trigger.ONCE_TTL_MS);
  assert.equal(trigger.ONCE_TTL_MS, 15 * 60 * 1000);
});

test('T123: the two trigger phrases are not interchangeable', () => {
  const wrong = trigger.configureOnce(trigger.createTriggerState(), { binding: BINDING },
    trigger.CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(wrong.result.ok, false);
  assert.equal(wrong.result.code, 'trigger_confirmation_mismatch');

  const alsoWrong = trigger.configure(trigger.createTriggerState(), { binding: BINDING },
    trigger.ONCE_CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(alsoWrong.result.ok, false,
    'the once phrase must not arm the standing trigger');
});

test('T123: asking for more than one trigger cannot widen the restricted arm', () => {
  const done = trigger.configureOnce(trigger.createTriggerState(),
    { binding: BINDING, maxTriggers: 50, maxPerHour: 100 },
    trigger.ONCE_CONFIRM_PREFIX + BINDING.conversationId, true, 1000);
  assert.equal(done.state.maxTriggers, 1, 'the module decides, not the caller');
});

test('T123: a restricted trigger that expired refuses fail-closed', () => {
  const now = 300_000;
  const armed = trigger.configureOnce(trigger.createTriggerState(), { binding: BINDING },
    trigger.ONCE_CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  const later = now + trigger.ONCE_TTL_MS + 1;
  const verdict = trigger.admit(armed, candidate('11111111-1111-4111-8111-111111111111',
    later / 1000), later);
  assert.equal(verdict.admit, false);
  assert.equal(verdict.code, 'trigger_expired');
  // And before it expires the same candidate would have been admitted.
  const fresh = trigger.admit(armed, candidate('11111111-1111-4111-8111-111111111111',
    now / 1000 + 1), now + 1000);
  assert.equal(fresh.admit, true, JSON.stringify(fresh));
});

test('T123: two candidates that both ended after the arm are refused', () => {
  const now = 400_000;
  const armed = trigger.configureOnce(trigger.createTriggerState(), { binding: BINDING },
    trigger.ONCE_CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  const a = candidate('22222222-2222-4222-8222-222222222222', now / 1000 + 1);
  const b = candidate('33333333-3333-4333-8333-333333333333', now / 1000 + 2);
  // T142: two completions no longer deadlock the one-shot; the earlier one is released
  // and the other stays queued. Only a real tie is refused.
  const picked = trigger.guardSingleCandidate(armed, [a, b], now + 1000);
  assert.equal(picked.ok, true, JSON.stringify(picked));
  assert.equal(picked.chosen, a.endedAtMs <= b.endedAtMs ? a.runId : b.runId);
  const tie = Object.assign({}, b, { endedAtMs: a.endedAtMs, startedAt: a.startedAt });
  const conflict = trigger.guardSingleCandidate(armed, [a, tie], now + 1000);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'single_shot_multiple_candidates');
  assert.equal(trigger.guardSingleCandidate(armed, [a], now + 1000).ok, true);
});

test('T123: the first send -- or the first uncertain one -- stops the restricted trigger', () => {
  const now = 500_000;
  const armed = trigger.configureOnce(trigger.createTriggerState(), { binding: BINDING },
    trigger.ONCE_CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  const sent = trigger.disarmAfterSendOnce(armed, { sent: true, pageWriteAttempted: true }, now + 10);
  assert.equal(sent.disarmed, true);
  assert.equal(sent.state.enabled, false);
  assert.match(String(sent.state.lastError || ''), /single_shot_trigger_spent/);

  const uncertain = trigger.disarmAfterSendOnce(armed,
    { sent: false, pageWriteAttempted: true }, now + 10);
  assert.equal(uncertain.disarmed, true, 'an uncertain write must stop the trigger too');
  assert.equal(uncertain.state.enabled, false);

  const deferred = trigger.disarmAfterSendOnce(armed,
    { sent: false, pageWriteAttempted: false }, now + 10);
  assert.equal(deferred.disarmed, false, 'a pre-write deferral must not spend the one trigger');
  assert.equal(deferred.state.enabled, true);
});

test('T123: a standing trigger is never disarmed by the single-shot rule', () => {
  const standing = trigger.configure(trigger.createTriggerState(), { binding: BINDING },
    trigger.CONFIRM_PREFIX + BINDING.conversationId, true, 1000).state;
  const done = trigger.disarmAfterSendOnce(standing, { sent: true, pageWriteAttempted: true }, 2000);
  assert.equal(done.disarmed, false);
  assert.equal(done.state.enabled, true, 'the persistent path keeps its existing behaviour');
});

test('T123: a run that ended before the arm is never the restricted trigger', () => {
  const now = 600_000;
  const armed = trigger.configureOnce(trigger.createTriggerState(), { binding: BINDING },
    trigger.ONCE_CONFIRM_PREFIX + BINDING.conversationId, true, now).state;
  const historical = candidate('44444444-4444-4444-8444-444444444444', now / 1000 - 900);
  assert.equal(trigger.completionAfterArm(armed, historical).proven, false);
  const guard = trigger.guardSingleCandidate(armed, [historical], now + 1000);
  assert.equal(guard.count, 0);
});

test('T123: the popup has a restricted trigger control with its own phrase', () => {
  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  for (const id of ['terminalTriggerOncePhrase', 'terminalTriggerOnceConfirmation',
    'terminalTriggerOnceArm']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing control: ' + id);
  }
  assert.match(js, /t059-trigger-arm-once/,
    'the popup must send its own message for the restricted trigger');
  assert.match(js, /onceTriggerPhrase/, 'the popup must show the once-trigger phrase');
  // The standing trigger controls stay.
  for (const id of ['terminalTriggerPhrase', 'terminalTriggerConfirmation',
    'terminalTriggerArm', 'terminalTriggerDisarm']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'standing trigger control disappeared: ' + id);
  }
  const view = fs.readFileSync(path.join(EXT, 'lib', 'single_shot_view.js'), 'utf8');
  const literal = /ONCE_TRIGGER_PREFIX = '([^']+)'/.exec(view);
  assert.ok(literal, 'the view module must publish the once-trigger prefix');
  assert.equal(literal[1], trigger.ONCE_CONFIRM_PREFIX,
    'the popup phrase and the worker phrase must be the same string');
});

test('T123: the background owns the cap, not the message', () => {
  const js = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  assert.match(js, /t059-trigger-arm-once/, 'the popup message must be handled');
  assert.match(js, /configureOnce\(/, 'the restricted arm must go through configureOnce');
  // The handler must not forward a caller-supplied cap: `maxTriggers` may only appear as the
  // module's own decision, never as `msg.maxTriggers`.
  assert.doesNotMatch(js, /msg\.maxTriggers/,
    'the background must not accept maxTriggers from a message');
  // The standing handler must not have grown a cap either.
  assert.doesNotMatch(js, /t059-trigger-arm'[\s\S]{0,600}maxTriggers:\s*[^n]/,
    'the standing arm must not be capped by a message field');
  assert.match(js, /disarmAfterSendOnce/, 'the send path must stop a restricted trigger');
  assert.match(js, /trigger_expired[\s\S]{0,400}syncTerminalAlarm|syncTerminalAlarm[\s\S]{0,400}trigger_expired/,
    'an expired restricted trigger must also clear its alarm');
});
test('T123: the popup has no third phrase literal that could drift from the worker', () => {
  // lib/single_shot_view.js exists so the popup does not carry its own copy of either phrase.
  // popup.js still needs a fallback for the case where that script failed to load, and a
  // fallback *is* a third copy: if it drifted, the operator would read one phrase and the
  // worker would refuse another (`arm_confirmation_mismatch`), with nothing to point at.
  // So the fallbacks are pinned to the source constants here, in both files that own them.
  const popup = fs.readFileSync(path.join(HERE, 'extension', 'popup.js'), 'utf8');
  const sendFallback = /:\s*'(AUTOSEND-ONCE\s)'\s*\+\s*conversationId/.exec(popup);
  const triggerFallback = /:\s*'(AUTOTRIGGER-ONCE\s)'\s*\+\s*conversationId/.exec(popup);
  assert.ok(sendFallback, 'popup.js must keep a fallback phrase for the send grant');
  assert.ok(triggerFallback, 'popup.js must keep a fallback phrase for the trigger grant');
  assert.equal(sendFallback[1], autosend.SINGLE_SHOT_CONFIRM_PREFIX,
    'the popup fallback must be the worker constant, character for character');
  assert.equal(triggerFallback[1], trigger.ONCE_CONFIRM_PREFIX,
    'the popup fallback must be the worker constant, character for character');
  // And the shared view file must agree with both, so the fallback can never be the odd one out.
  const view = fs.readFileSync(path.join(HERE, 'extension', 'lib', 'single_shot_view.js'), 'utf8');
  assert.match(view, /const PREFIX = 'AUTOSEND-ONCE '/);
  assert.match(view, /const ONCE_TRIGGER_PREFIX = 'AUTOTRIGGER-ONCE '/);
});