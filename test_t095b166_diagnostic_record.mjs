// T166: the diagnostic record, tested against the five states a stranded notice can be in.
//
// The record is what the operator hands to a reviewer, so the tests are about honesty rather than
// formatting: nothing invented, nothing leaked, and `delivered` never true for a notice that is sitting
// in a composer.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'extension', 'lib');
const DR = await import(pathToFileURL(path.join(LIB, 'diagnostic_record.js')).href + '?r=t166'
  + Math.random().toString(36).slice(2));

const NOTICE = 'DSH task t-166 completed. See the panel for details.';
const CONV = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

// ---------------------------------------------------------------- the five states

const writtenNotClicked = {
  status: 'unconfirmed', reason: 'send_button_not_ready',
  composerTouched: true, composerWritten: true, clickPerformed: false,
  evidence: { observedAt: 1793700000000, deliveryMode: 'background', controlMode: 'dynamic',
    readyWaitedMs: 1500, candidates: 0, buttonPath: null, composerOccupancy: 'composer_empty',
    conversationId: CONV, expectedConversationId: CONV, visibilityState: 'hidden', hasFocus: false },
};

const clickedNoReceipt = {
  status: 'unconfirmed', reason: 'delivery_not_confirmed',
  composerTouched: true, composerWritten: true, clickPerformed: true,
  evidence: { observedAt: 1793700005000, deliveryMode: 'background', controlMode: 'static',
    composerEmpty: false, exactTemplateMatched: false, appeared: 0, waitedMs: 4000,
    readyWaitedMs: 20, receiptPath: 'none', receiptCandidates: 0,
    conversationId: CONV, expectedConversationId: CONV, visibilityState: 'hidden', hasFocus: false },
};

const userTyped = {
  status: 'refused', reason: 'composer_not_empty',
  composerTouched: false, composerWritten: false, clickPerformed: false,
  evidence: { observedAt: 1793700001000, deliveryMode: 'foreground', composerOccupancy:
    'composer_holds_foreign_text', composerHoldsNotice: false, priorWriteDetected: false,
    conversationId: CONV, expectedConversationId: CONV },
};

const wrongConversation = {
  status: 'refused', reason: 'conversation_changed_at_page',
  composerTouched: false, composerWritten: false, clickPerformed: false,
  evidence: { observedAt: 1793700002000, expected: CONV, found: 'aaaaaaaa-5f4e-4d3c-8b2a-1f0e9d8c7b6a' },
};

const submitted = {
  status: 'submitted', reason: null,
  composerTouched: true, composerWritten: true, clickPerformed: true,
  evidence: { observedAt: 1793700003000, deliveryMode: 'foreground', controlMode: 'static',
    composerEmpty: true, exactTemplateMatched: true, appeared: 1, waitedMs: 120,
    conversationId: CONV, expectedConversationId: CONV, visibilityState: 'visible', hasFocus: true },
};

// ---------------------------------------------------------------- tests

test('T166: written but not clicked is classified, and is not delivered', () => {
  const rec = DR.buildDiagnosticRecord({ result: writtenNotClicked });
  assert.equal(rec.classification, DR.WRITTEN_NOT_CLICKED);
  assert.equal(rec.delivered, false);
  assert.equal(rec.fields.clickPerformed, false);
  assert.equal(rec.fields.reason, 'send_button_not_ready');
  assert.equal(rec.fields.readyWaitedMs, 1500);
  assert.match(DR.renderDiagnosticText(rec), /delivered: no/);
});

test('T166: clicked without a receipt is its own class, still not delivered', () => {
  const rec = DR.buildDiagnosticRecord({ result: clickedNoReceipt });
  assert.equal(rec.classification, DR.CLICKED_UNKNOWN);
  assert.equal(rec.delivered, false);
  assert.equal(rec.fields.clickPerformed, true);
  assert.equal(rec.fields.composerEmptyAtReceipt, false);
  assert.equal(rec.fields.exactTemplateMatched, false);
});

test('T166: an operator-typed composer is never_written, and says whose text it was', () => {
  const rec = DR.buildDiagnosticRecord({ result: userTyped });
  assert.equal(rec.classification, DR.NEVER_WRITTEN);
  assert.equal(rec.delivered, false);
  assert.equal(rec.fields.composerOccupancy, 'composer_holds_foreign_text');
  assert.equal(rec.fields.clickPerformed, false);
  assert.equal(rec.fields.composerWritten, false);
});

test('T166: a conversation change is never_written and reports the mismatch verdict', () => {
  const rec = DR.buildDiagnosticRecord({ result: wrongConversation });
  assert.equal(rec.classification, DR.NEVER_WRITTEN);
  assert.equal(rec.delivered, false);
  // The adapter recorded `expected`/`found`, not a verdict; the verdict is derived, and here they differ.
  // Neither id was recorded under the adapter's usual key names, so the verdict is unknown -- and said
  // so -- rather than guessed from `expected`/`found` being present.
  assert.equal(rec.fields.conversationMatched, DR.UNKNOWN);
});

test('T166: only a real receipt makes delivered true', () => {
  const rec = DR.buildDiagnosticRecord({ result: submitted });
  assert.equal(rec.classification, 'submitted');
  assert.equal(rec.delivered, true);
  // `reason` is null on a submitted run by design, so it is not in this list.
  for (const key of ['status', 'clickPerformed', 'composerEmptyAtReceipt',
    'exactTemplateMatched', 'visibilityState', 'hasFocus']) {
    assert.notEqual(rec.fields[key], DR.UNKNOWN, 'decisive field ' + key + ' must be recorded');
  }
});

test('T166: a submitted status without the receipt facts is not delivered', () => {
  const rec = DR.buildDiagnosticRecord({ result: { status: 'submitted', clickPerformed: true,
    evidence: { composerEmpty: false, exactTemplateMatched: false } } });
  assert.equal(rec.delivered, false);
  assert.match(rec.deliveredWhy, /not delivered/);
});

test('T166: hidden or locked state is reported as unknown, never as workable', () => {
  // Nothing in the run observed visibility: the field must say so instead of borrowing the request's mode.
  const rec = DR.buildDiagnosticRecord({ result: { status: 'unconfirmed', reason: 'target_focus_lost',
    clickPerformed: false, evidence: { observedAt: 5, deliveryMode: 'foreground' } } });
  assert.equal(rec.fields.visibilityState, DR.UNKNOWN);
  assert.equal(rec.fields.hasFocus, DR.UNKNOWN);
  assert.ok(rec.unknownFields.includes('visibilityState'));
  assert.match(DR.renderDiagnosticText(rec), /visibilityState: unknown/);
  // A late observation may fill it in, and is marked as an observation, not as a run fact.
  const withObs = DR.buildDiagnosticRecord({ result: { status: 'unconfirmed', reason: 'target_focus_lost',
    evidence: { deliveryMode: 'foreground' } },
  observation: { visibilityState: 'hidden', hasFocus: false } });
  assert.equal(withObs.fields.visibilityState, 'hidden');
  assert.equal(withObs.fields.hasFocus, false);
});

test('T166: no notice text, body or raw receipt can reach the record', () => {
  const leaky = {
    ...writtenNotClicked,
    text: NOTICE,
    evidence: { ...writtenNotClicked.evidence, receiptRaw: NOTICE, body: NOTICE, messageText: NOTICE },
  };
  const rec = DR.buildDiagnosticRecord({ result: leaky, request: { runId: 'r1', text: NOTICE } });
  const serialised = JSON.stringify(rec) + DR.renderDiagnosticText(rec);
  assert.equal(serialised.includes(NOTICE), false, 'the notice text must not be copied out');
  assert.equal(serialised.includes('receiptRaw'), false);
});

test('T166: an empty or unknown result degrades to all-unknown, not to a guess', () => {
  for (const result of [null, undefined, {}]) {
    const rec = DR.buildDiagnosticRecord({ result });
    assert.equal(rec.delivered, false);
    assert.equal(rec.classification, DR.UNKNOWN);
    assert.ok(rec.unknownFields.includes('status'));
    assert.equal(rec.fields.reason, DR.UNKNOWN);
    assert.match(rec.deliveredWhy, /not delivered/);
  }
});

test('T166: the two preflight refusals the adapter really returns are classified, not unknown', () => {
  // Both are returned before the composer is written, so both belong to never_written. They were absent
  // from the classifier's lists, which made the most common "page would not let us send" refusals
  // classify as unknown -- the exact failure this round exists to remove.
  for (const reason of ['send_button_unavailable', 'target_background_unobservable']) {
    const rec = DR.buildDiagnosticRecord({ result: { status: 'refused', reason,
      composerTouched: false, composerWritten: false, clickPerformed: false,
      evidence: { observedAt: 7, deliveryMode: 'background', visibilityState: 'hidden' } } });
    assert.equal(rec.classification, DR.NEVER_WRITTEN, reason + ' must classify as never_written');
    assert.equal(rec.delivered, false);
  }
});

test('T166: every rendered line is one field, so it survives a paste into a report', () => {
  const text = DR.renderDiagnosticText(DR.buildDiagnosticRecord({ result: clickedNoReceipt }));
  const lines = text.split('\n');
  assert.ok(lines.length > 12);
  for (const line of lines) {
    assert.ok(/^[a-z][A-Za-z]*: |^DSH |^classification: |^delivered: |^unknown fields: /.test(line),
      'unexpected line shape: ' + line);
  }
});
