// T233: one click, one whitelisted document, and the doctor can read it.
//
// Two things are being checked, and the second is the reason the first matters:
//   1. what the popup would produce -- bounded, whitelisted, statuses preserved, page visibility always unknown;
//   2. that the produced bytes are what `tools/notify_doctor.py` actually parses, proven by writing them into a
//      temporary state directory and running the real tool against it. A formatter whose output the reader cannot
//      read is the defect this test exists to catch.
//
// Everything here is offline: a fake `chrome.storage.local`, the real `diagnostic_export.js`, the real doctor. No
// Chrome, no page, no host, no queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, 'extension');
const PYTHON = process.env.PYTHON || 'python';
const NOW = 1_800_000_000_000;
const CONV = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const DOC_ID = 'document-instance-that-must-not-travel';
const URL_WITH_SECRET = 'https://chatgpt.com/c/' + CONV + '?token=sk-live-must-not-travel';

function loadModule() {
  const source = readFileSync(path.join(EXT, 'lib', 'diagnostic_export.js'), 'utf8');
  const window = {};
  const context = vm.createContext({ window, TextEncoder, Date, JSON, Number, Object, Array, String });
  vm.runInContext(source, context, { filename: 'diagnostic_export.js' });
  return window;
}

const mod = loadModule();

function record(overrides = {}) {
  return {
    schema: 't166-diagnostic/1',
    at: NOW - 60_000,
    runId: '00000001-0000-4000-8000-000000000001',
    classification: 'submitted',
    delivered: false,
    deliveredWhy: 'not delivered: no acknowledgement observed (a write or a click is not delivery)',
    unknownFields: [],
    fields: {
      status: 'submitted', reason: null, clickPerformed: true, composerWritten: true,
      composerTouched: true, composerOccupancy: 0, appeared: 1, exactTemplateMatched: true,
      // The four that must not leave the machine:
      receiptRaw: 'DSH task 00000001-0000-4000-8000-000000000001 completed.',
      text: 'DSH task 00000001-0000-4000-8000-000000000001 completed.',
      conversationId: CONV, expectedConversationId: CONV,
      documentId: DOC_ID, url: URL_WITH_SECRET,
      receiptPath: 'main > div:nth-child(3) > article',
      conversationMatched: true, documentInstanceMatched: true,
      visibilityState: 'visible', hasFocus: true,
    },
    ...overrides,
  };
}

function build(last, history) {
  return mod.buildDiagnosticExport(last, history, { now: NOW });
}

test('the export carries the verdicts and nothing that identifies a page', () => {
  const built = build(record(), []);
  const text = built.text;
  for (const secret of ['sk-live', CONV, DOC_ID, 'main > div:nth-child(3)', 'completed.']) {
    assert.equal(text.includes(secret), false, 'export leaked ' + secret);
  }
  const doc = built.document;
  assert.equal(doc.schema, 't233-diagnostic-export/1');
  assert.equal(doc.records.length, 1);
  assert.equal(doc.records[0].status, 'submitted');
  assert.equal(doc.records[0].fields.exactTemplateMatched, true);
  assert.equal(doc.records[0].fields.conversationMatched, true);
  assert.equal(doc.records[0].fields.receiptPath, undefined, 'a DOM path is page structure, not a verdict');
  assert.equal(doc.scope.pageVisible, 'unknown');
  assert.equal(doc.scope.upload.indexOf('never'), 0);
  assert.equal(doc.exportedBy, 'popup-button', 'an export that claims a timer would be a background transfer');
});

test('the three statuses survive, and an unrecognised one becomes unknown', () => {
  const built = build(null, [
    record(), record({ runId: '00000002-0000-4000-8000-000000000002',
      fields: { ...record().fields, status: 'unconfirmed', appeared: 0, exactTemplateMatched: false } }),
    record({ runId: '00000003-0000-4000-8000-000000000003',
      fields: { ...record().fields, status: 'refused', clickPerformed: false, composerWritten: false } }),
    record({ runId: '00000004-0000-4000-8000-000000000004',
      fields: { ...record().fields, status: 'something_new' } }),
  ]);
  const counts = built.document.counts;
  assert.deepEqual([counts.submitted, counts.unconfirmed, counts.refused, counts.unknown], [1, 1, 1, 1]);
  assert.equal(built.document.records.every((row) => ['submitted', 'unconfirmed', 'refused', 'unknown']
    .includes(row.status)), true);
});

test('the entry cap holds and the dropped count is stated', () => {
  const history = [];
  for (let i = 0; i < 40; i += 1) {
    history.push(record({ runId: String(i).padStart(8, '0') + '-0000-4000-8000-000000000000',
      at: NOW - i * 1000 }));
  }
  const built = build(record(), history);
  assert.equal(built.document.records.length, 20, 'MAX_RECORDS');
  assert.equal(built.document.counts.dropped, 21, 'last plus 40 history entries, 20 kept');
  assert.ok(built.bytes <= mod.DIAGNOSTIC_EXPORT.maxBytes);
});

test('the byte cap holds even for pathological records', () => {
  const history = [];
  for (let i = 0; i < 9; i += 1) {
    const fat = record({ runId: String(i).padStart(8, '0') + '-0000-4000-8000-000000000000',
      at: NOW - i * 1000 });
    fat.fields.visibilityState = 'v'.repeat(5000);
    history.push(fat);
  }
  const built = build(null, history);
  assert.ok(built.bytes <= mod.DIAGNOSTIC_EXPORT.maxBytes, 'bytes ' + built.bytes);
  assert.equal(built.document.counts.dropped > 0, true);
});

test('nothing to export is an empty document, not an invented one', () => {
  const built = build(null, []);
  assert.equal(built.document.records.length, 0);
  assert.equal(built.document.counts.records, 0);
  assert.equal(built.document.scope.pageVisible, 'unknown');
});

function stateDir(built) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 't233-state-'));
  const write = (name, value) => writeFileSync(path.join(dir, name), JSON.stringify(value));
  write('terminal-origin.json', { version: 1, ids: ['00000001-0000-4000-8000-000000000001'],
    readAt: NOW / 1000 - 30, source: 'bridge-sqlite' });
  write('terminal-source.json', { version: 1, pendingIds: [],
    ackedIds: ['00000001-0000-4000-8000-000000000001'], baselineIds: [], baselineCount: 0,
    baselineDropped: 0 });
  write('terminal-arm.json', { version: 1, ids: [], takenAt: NOW / 1000 - 120,
    epoch: '00000009-0000-4000-8000-000000000009', truncated: false });
  write('queue.json', { version: 1, events: [], next_seq: 5, acked: [], acked_at: {},
    consumers: {}, consumer_acks: {} });
  write('delivery-diagnostic.json', built.document);
  return dir;
}

function doctor(dir) {
  const result = spawnSync(PYTHON, ['-B', path.join(HERE, 'tools', 'notify_doctor.py'),
    '--state', dir, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the doctor reads what the popup produces', (t) => {
  const built = build(record(), []);
  const dir = stateDir(built);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = doctor(dir);
  assert.equal(report.stages.diagnostic.exported, true);
  assert.equal(report.stages.diagnostic.submitted, 1);
  assert.equal(report.attribution.submit_confirmed, 'submitted');
  assert.equal(report.attribution.page_visible, 'unknown',
    'the page accepting a message is never a person reading it');
  assert.equal(report.limitations.includes('delivery_diagnostic_not_exported'), false);
});

test('an unconfirmed export reads back as unconfirmed, never as delivery', (t) => {
  const unconfirmed = record({ fields: { ...record().fields, status: 'unconfirmed',
    appeared: 0, exactTemplateMatched: false } });
  const dir = stateDir(build(unconfirmed, []));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = doctor(dir);
  assert.equal(report.attribution.submit_confirmed, 'unconfirmed');
  assert.equal(report.attribution.page_visible, 'unknown');
  assert.notEqual(report.delivery, 'delivered');
  assert.notEqual(report.evidence, 'user_visible_unverified');
});

test('a record that claims delivery it cannot support is discarded by the doctor, not by trust', (t) => {
  const liar = record({ delivered: true, deliveredWhy: 'acknowledged after a verified receipt',
    fields: { ...record().fields, status: 'unconfirmed', appeared: 0, exactTemplateMatched: false } });
  const dir = stateDir(build(liar, []));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = doctor(dir);
  assert.equal(report.stages.diagnostic.inconsistent, 1);
  assert.equal(report.findings.some((f) => f.code === 'diagnostic_self_inconsistent'), true);
  assert.equal(report.attribution.submit_confirmed, 'unconfirmed');
  assert.equal(report.attribution.page_visible, 'unknown');
});
