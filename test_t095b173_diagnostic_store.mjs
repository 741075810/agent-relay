// T173: the delivery outcome survives the trip from a send path to the popup, redacted and honest.
//
// Dynamic end-to-end at the boundary that exists offline: an adapter-shaped result goes through
// `recordDelivery` into a fake `chrome.storage.local`, the popup's reader (`readLatest`) gets it back, and
// the classic formatter renders it. No page, no send, no host, no queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, 'extension');
const STORE = await import(pathToFileURL(path.join(EXT, 'lib', 'diagnostic_store.js')).href
  + '?r=t173' + Math.random().toString(36).slice(2));

const NOTICE = 'DSH task t-173 completed. See the panel for details.';
const CONV = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(defaults, cb) {
      const out = {};
      for (const [key, fallback] of Object.entries(defaults || {})) {
        out[key] = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback;
      }
      cb(out);
    },
    set(patch, cb) { Object.assign(data, patch); if (cb) cb(); },
  };
}

function loadView() {
  const source = readFileSync(path.join(EXT, 'lib', 'diagnostic_view.js'), 'utf8');
  const window = {};
  const context = vm.createContext({ window });
  vm.runInContext(source, context, { filename: 'diagnostic_view.js' });
  return window;
}
const view = loadView();

const cases = {
  written_not_clicked: { status: 'unconfirmed', reason: 'send_button_not_ready',
    composerTouched: true, composerWritten: true, clickPerformed: false,
    evidence: { observedAt: 1793800000000, deliveryMode: 'background', readyWaitedMs: 1500,
      visibilityState: 'hidden', conversationId: CONV, expectedConversationId: CONV } },
  clicked_unknown: { status: 'unconfirmed', reason: 'delivery_not_confirmed',
    composerTouched: true, composerWritten: true, clickPerformed: true,
    evidence: { observedAt: 1793800001000, composerEmpty: false, exactTemplateMatched: false,
      waitedMs: 4000, appeared: 0, visibilityState: 'hidden' } },
  submitted_no_ack: { status: 'submitted', reason: null, composerTouched: true,
    composerWritten: true, clickPerformed: true,
    evidence: { observedAt: 1793800002000, composerEmpty: true, exactTemplateMatched: true,
      appeared: 1, waitedMs: 90, visibilityState: 'visible', hasFocus: true } },
  foreign_text: { status: 'refused', reason: 'composer_not_empty', composerTouched: false,
    composerWritten: false, clickPerformed: false,
    evidence: { observedAt: 1793800003000, composerOccupancy: 'composer_holds_foreign_text' } },
  wrong_conversation: { status: 'refused', reason: 'conversation_changed_at_page',
    composerTouched: false, composerWritten: false, clickPerformed: false,
    evidence: { observedAt: 1793800004000, expected: CONV, found: 'aaaa-5f4e' } },
  unknown_only: { status: 'unconfirmed', reason: 'target_focus_lost', clickPerformed: false,
    evidence: { deliveryMode: 'foreground' } },
};

for (const [name, result] of Object.entries(cases)) {
  test('T173: ' + name + ' reaches the popup with its own class and no invented fields', async () => {
    const storage = fakeStorage();
    const stored = await STORE.recordDelivery(storage, { result }, 1000);
    assert.equal(stored.delivered, false, name + ' must never read as delivered');
    const readout = await STORE.readLatest(storage);
    assert.equal(readout.present, true);
    const lines = view.diagnosticLines(readout);
    assert.equal(lines[0].startsWith('last notice: '), true);
    assert.match(lines[0], /delivered: no/);
    const serialised = JSON.stringify(readout) + lines.join('\n');
    assert.equal(serialised.includes(NOTICE), false, 'no notice text may reach storage or the panel');
    if (name === 'unknown_only') {
      assert.equal(readout.stored.fields.visibilityState, 'unknown');
      assert.ok(readout.stored.unknownFields.includes('visibilityState'));
      assert.match(lines.join('\n'), /visibilityState: unknown/);
    }
    if (name === 'foreign_text') {
      assert.match(lines.join('\n'), /composerOccupancy: composer_holds_foreign_text/);
    }
    if (name === 'submitted_no_ack') {
      // The page accepted it; nothing acked it, so it is still not delivery.
      assert.equal(readout.stored.delivered, false);
      assert.match(lines[0], /not delivered|delivered: no/);
    }
  });
}

test('T173: nothing recorded reads as unknown with a note, never as zero or as success', async () => {
  const readout = await STORE.readLatest(fakeStorage());
  assert.equal(readout.present, false);
  assert.equal(readout.code, 'no_diagnostic_recorded');
  const lines = view.diagnosticLines(readout);
  assert.match(lines[0], /unknown, not zero/);
});

test('T173: a stored record cannot smuggle text or receipt bodies', async () => {
  const storage = fakeStorage();
  await STORE.recordDelivery(storage, { result: { ...cases.clicked_unknown, text: NOTICE,
    evidence: { ...cases.clicked_unknown.evidence, receiptRaw: NOTICE, body: NOTICE } } }, 2000);
  const stored = storage.data.lastDeliveryDiagnostic;
  const keys = Object.keys(stored.fields).sort();
  assert.equal(JSON.stringify(stored).includes(NOTICE), false);
  for (const forbidden of ['text', 'receiptRaw', 'body', 'messageText']) {
    assert.equal(keys.includes(forbidden), false, forbidden + ' must not be a stored field');
  }
});

test('T173: the worker exposes the store on real messages, popup-only for reading', () => {
  const bg = readFileSync(path.join(EXT, 'background.js'), 'utf8');
  assert.match(bg, /import \{ readLatest as readLatestDiagnostic, recordDelivery \} from '\.\/lib\/diagnostic_store\.js'/);
  const readIdx = bg.indexOf("msg.type === 't166-diagnostic'");
  assert.ok(readIdx > 0);
  const readBlock = bg.slice(readIdx, bg.indexOf("msg.type === 't173-record-delivery'"));
  assert.match(readBlock, /extension_popup_required/, 'reading is popup-only');
  const writeIdx = bg.indexOf("msg.type === 't173-record-delivery'");
  const writeBlock = bg.slice(writeIdx, writeIdx + 600);
  assert.match(writeBlock, /extension_worker_required/, 'content scripts cannot post outcomes');
});

test('T173: the popup renders it, and the classic view is loaded before popup.js', () => {
  const popup = readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  assert.match(popup, /ask\(\{ type: 't166-diagnostic' \}\)/);
  assert.match(popup, /window\.diagnosticLines\(diag\.result\)/);
  const html = readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  assert.ok(html.indexOf('lib/diagnostic_view.js') < html.indexOf('src="popup.js"'));
});

test('T173: the normal delivery path is untouched by this change', () => {
  const popup = readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  const block = popup.slice(popup.indexOf("ask({ type: 't166-diagnostic' })"),
    popup.indexOf('// Added to the same panel'));
  assert.doesNotMatch(block, /t058-send|t059-trigger-run|\.click\(/,
    'the diagnostic panel must not trigger a send');
  const store = readFileSync(path.join(EXT, 'lib', 'diagnostic_store.js'), 'utf8');
  // Code, not prose: the comment deliberately mentions `deliverInto` while explaining why it never runs.
  const code = store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /deliverInto|\.click\(/, 'the store formats only');
});
