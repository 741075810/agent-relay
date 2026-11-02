// T193: the aggregated runtime block must keep six facts apart and say `unknown` where it has nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib');

function load() {
  const window = {};
  const source = readFileSync(path.join(LIB, 'notice_runtime_view.js'), 'utf8');
  vm.runInContext(source, vm.createContext({ window }), { filename: 'notice_runtime_view.js' });
  return window.noticeRuntimeLines;
}

const lines = (input) => load()(input);
const find = (out, prefix) => out.find((line) => line.startsWith(prefix));

test('T193: an empty input says unknown everywhere and never implies delivery', () => {
  const out = lines({});
  for (const prefix of ['host ack:', 'trigger:', 'autosend:', 'binding:', 'page adapter:', 'delivery:']) {
    const line = find(out, prefix);
    assert.ok(line, prefix + ' line exists');
    assert.match(line, /unknown|no record|not page display/i, prefix);
  }
  assert.equal(find(out, 'delivery:').includes('delivered by'), false);
});

test('T193: a host ack is rendered as persistence, not as page delivery', () => {
  const out = lines({ readiness: { ackedIds: 460 } });
  const ack = find(out, 'host ack:');
  assert.match(ack, /460/);
  assert.match(ack, /persistence, not page delivery/);
  assert.match(find(out, 'delivery:'), /not page display/);
});

test('T193: one-shot and standing triggers are distinguishable, and spent is visible', () => {
  const standing = find(lines({ trigger: { enabled: true, mode: 'standing' } }), 'trigger:');
  assert.match(standing, /standing enabled/);
  assert.equal(/spent/.test(standing), false);

  const spent = find(lines({ trigger: { enabled: false, mode: 'single_shot', spentAt: 1 } }), 'trigger:');
  assert.match(spent, /single_shot/);
  assert.match(spent, /spent/);

  const expired = find(lines({ trigger: { enabled: false, mode: 'single_shot',
    lastError: 'single_shot_trigger_expired' } }), 'trigger:');
  assert.match(expired, /single_shot_trigger_expired/);
});

test('T193: the permit line shows the quota, the mode and expiry', () => {
  const live = find(lines({ autosend: { enabled: true, sentCount: 1, maxSends: 3 } }), 'autosend:');
  assert.match(live, /enabled/);
  assert.match(live, /1\/3 used/);

  const oneShot = find(lines({ autosend: { enabled: true, singleShot: true, sentCount: 1, maxSends: 1,
    expiresAt: Date.now() + 60000 } }), 'autosend:');
  assert.match(oneShot, /single-shot/);
  assert.match(oneShot, /unexpired/);

  const expired = find(lines({ autosend: { enabled: true, expiresAt: Date.now() - 1000 } }), 'autosend:');
  assert.match(expired, /EXPIRED/);
  assert.match(expired, /quota unknown/);
});

test('T193: binding distinguishes bound / stale / unreadable', () => {
  assert.match(find(lines({ binding: { conversationId: 'c', stale: false } }), 'binding:'), /current/);
  assert.match(find(lines({ binding: { conversationId: 'c', stale: true } }), 'binding:'), /STALE/);
  assert.match(find(lines({ binding: {} }), 'binding:'), /no conversation, unknown/);
});

test('T193: the adapter line reports the real result, including a refusal reason', () => {
  const refused = find(lines({ diagnostic: { present: true, stored: { delivered: false,
    fields: { status: 'unconfirmed', reason: 'composer_not_empty', clickPerformed: false,
      visibilityState: 'hidden' } } } }), 'page adapter:');
  assert.match(refused, /unconfirmed/);
  assert.match(refused, /composer_not_empty/);
  assert.match(refused, /click=false/);
  assert.match(refused, /vis=hidden/);

  assert.match(find(lines({ diagnostic: { present: false } }), 'page adapter:'), /unknown \(no record\)/);
});

test('T193: a record claiming delivery is labelled unverified, not repeated as fact', () => {
  const out = lines({ diagnostic: { present: true, stored: { delivered: true, fields: {} } } });
  assert.match(find(out, 'delivery:'), /unverified here/);
});

test('T193: the worker message is popup-only and writes nothing', () => {
  const bg = readFileSync(path.join(HERE, 'extension', 'background.js'), 'utf8');
  const at = bg.indexOf("msg.type === 't193-notice-runtime'");
  assert.ok(at > 0);
  const block = bg.slice(at, at + 900);
  assert.match(block, /extension_popup_required/);
  assert.match(block, /chrome\.storage\.local\.get/);
  assert.doesNotMatch(block, /storage\.local\.set|request\(|terminal-ack|sendMessage/);
  const html = readFileSync(path.join(HERE, 'extension', 'popup.html'), 'utf8');
  assert.ok(html.indexOf('lib/notice_runtime_view.js') < html.indexOf('src="popup.js"'));
  const popup = readFileSync(path.join(HERE, 'extension', 'popup.js'), 'utf8');
  assert.match(popup, /t193-notice-runtime/);
});
