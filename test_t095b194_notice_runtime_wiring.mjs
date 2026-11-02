// T194: the runtime block must be driven by the schemas the extension actually stores.
//
// The first version read `trigger.mode` (does not exist), read the binding from `local` (it lives in `session`),
// and hard-coded the ACK to unknown. These tests would have failed on all three, because they use records shaped
// exactly like `createTriggerState()` / the T053 binding / `terminalChainStatus.lastPoll`.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib');
// The real factory, so the record under test is the one the extension actually stores.
const { createTriggerState } = await import(pathToFileURL(path.join(LIB, 'terminal_trigger.js')).href);

function load() {
  const window = {};
  vm.runInContext(readFileSync(path.join(LIB, 'notice_runtime_view.js'), 'utf8'),
    vm.createContext({ window }), { filename: 'notice_runtime_view.js' });
  return window.noticeRuntimeLines;
}
const out = (input) => load()(input);
const line = (input, prefix) => out(input).find((l) => l.startsWith(prefix));

test('T194: a real createTriggerState() is not "unknown" -- mode is derived, not read', () => {
  const standing = createTriggerState();
  standing.enabled = true;
  standing.armedAt = Date.now();
  const text = line({ trigger: standing }, 'trigger:');
  assert.equal(text.includes('unknown'), false, text);
  assert.match(text, /standing enabled/);

  const oneShot = createTriggerState();
  oneShot.enabled = true;
  oneShot.singleShotTrigger = true;
  oneShot.maxTriggers = 1;
  oneShot.triggers = 1;
  const spent = line({ trigger: oneShot }, 'trigger:');
  assert.match(spent, /single_shot/);
  assert.match(spent, /remaining=0/);
  assert.match(spent, /spent/);
});

test('T194: an expired one-shot arm and its error code are both visible', () => {
  const expired = createTriggerState();
  expired.enabled = false;
  expired.singleShotTrigger = true;
  expired.maxTriggers = 1;
  expired.expiresAt = Date.now() - 60000;
  expired.lastError = 'single_shot_trigger_expired';
  const text = line({ trigger: expired }, 'trigger:');
  assert.match(text, /EXPIRED/);
  assert.match(text, /single_shot_trigger_expired/);
});

test('T194: the ACK line reports the last poll and its time, and says what it is', () => {
  const at = Date.parse('2026-11-02T09:19:48Z');
  const text = line({ lastPoll: { acked: 3, at } }, 'host ack:');
  assert.match(text, /confirmed 3 candidate/);
  assert.match(text, /2026-11-02T09:19:48/);
  assert.match(text, /not page delivery/);
  assert.equal(line({}, 'host ack:').includes('unknown'), true, 'no reading is unknown, not zero');
});

test('T194: a binding read from session is a saved binding, not proof the page still matches', () => {
  const sessionBound = line({ binding: { bound: true, source: 'session', validated: null } }, 'binding:');
  assert.match(sessionBound, /bound_saved \(session\)/);
  assert.match(sessionBound, /health unknown/);

  const probed = line({ binding: { bound: true, source: 'session', validated: true } }, 'binding:');
  assert.match(probed, /current/);

  const stale = line({ binding: { bound: true, source: 'local', validated: false } }, 'binding:');
  assert.match(stale, /stale/);
  assert.match(stale, /saved mirror/);

  const none = line({ binding: { bound: false, invalidatedReason: 'navigation_or_redirect' } }, 'binding:');
  assert.match(none, /no saved binding/);
  assert.match(none, /navigation_or_redirect/);
});

test('T194: the adapter line is labelled as the last recorded result, and unattributed without a run id', () => {
  const unlinked = line({ diagnostic: { present: true, stored: { fields: { status: 'submitted' } } } },
    'last recorded page adapter result:');
  assert.match(unlinked, /unknown for the current run/);

  const linked = line({ diagnostic: { present: true,
    stored: { runId: 'run-1', fields: { status: 'unconfirmed', reason: 'composer_not_empty' } } } },
  'last recorded page adapter result:');
  assert.match(linked, /run-1/);
  assert.match(linked, /composer_not_empty/);
  assert.equal(/unknown for the current run/.test(linked), false);
});

test('T194: delivery is unknown on every path, whatever the record claims', () => {
  for (const input of [{}, { lastPoll: { acked: 9 } },
    { diagnostic: { present: true, stored: { delivered: true, fields: { status: 'submitted' } } } }]) {
    assert.match(line(input, 'delivery:'), /unknown/);
    assert.match(line(input, 'delivery:'), /not page display/);
  }
});

test('T194: the worker reads session for the binding and local for the rest', () => {
  const bg = readFileSync(path.join(HERE, 'extension', 'background.js'), 'utf8');
  const at = bg.indexOf("msg.type === 't193-notice-runtime'");
  const block = bg.slice(at, at + 2200);
  assert.match(block, /chrome\.storage\.session\.get\(\{ t053TargetBindingState/);
  assert.match(block, /terminalChainStatus/);
  assert.match(block, /extension_popup_required/);
  assert.doesNotMatch(block, /storage\.(local|session)\.set|terminal-ack|sendMessage\(/);
});

test('T194: the popup passes the real last-poll reading, not a hard-coded null', () => {
  const popup = readFileSync(path.join(HERE, 'extension', 'popup.js'), 'utf8');
  const at = popup.indexOf("t193-notice-runtime");
  const block = popup.slice(at, at + 900);
  assert.match(block, /lastPoll: runtime\.result\.lastPoll/);
  assert.doesNotMatch(block, /ackedIds: null/);
});
