// T165: the stranded-draft state, tested at the decision it actually turns on.
//
// The live symptom: the extension put `DSH task … completed.` into the ChatGPT composer and nothing was
// sent. Retrying hit "a non-empty composer belongs to whoever typed into it", which refuses correctly
// but cannot tell our own stranded write from the operator's typing.
//
// This suite pins the decision that separates them (`composerOccupancy`) and the rules that must hold in
// every stranded state: never report delivery, never clear the draft, never click twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'extension', 'lib', 'send_adapter.js');
const AS = await import(pathToFileURL(SRC).href + '?r=t165' + Math.random().toString(36).slice(2));

const NOTICE = 'DSH task t-165 completed. See the panel for details.';

test('T165: an empty composer is empty', () => {
  for (const before of ['', '   ', '\n\t ']) {
    const out = AS.composerOccupancy(before, NOTICE);
    assert.equal(out.code, 'composer_empty');
    assert.equal(out.ours, false);
  }
});

test('T165: our own notice still sitting there is recognised as ours, not as operator text', () => {
  const out = AS.composerOccupancy(NOTICE, NOTICE);
  assert.equal(out.code, 'composer_holds_notice');
  assert.equal(out.ours, true);
});

test('T165: a page that appended whitespace does not turn our draft into a stranger', () => {
  const out = AS.composerOccupancy(NOTICE + '\n', NOTICE);
  assert.equal(out.code, 'composer_holds_notice');
  assert.equal(out.ours, true);
  assert.equal(out.normalised, true);
});

test('T165: text that merely starts like our notice is still somebody else typing', () => {
  for (const before of [NOTICE.replace('completed', 'complete'),
    NOTICE + ' and one more thing',
    'DSH task t-165 completed.']) {
    const out = AS.composerOccupancy(before, NOTICE);
    assert.equal(out.ours, false, JSON.stringify(before));
    assert.equal(out.code, 'composer_holds_foreign_text');
  }
});

test('T165: a missing or empty notice never claims the composer', () => {
  for (const notice of ['', null, undefined]) {
    const out = AS.composerOccupancy('anything typed', notice);
    assert.equal(out.ours, false);
  }
  // ...and a non-string composer value is not a match either.
  assert.equal(AS.composerOccupancy(null, NOTICE).code, 'composer_empty');
});

test('T165: the call site keeps the pinned refusal code and adds the diagnosis in evidence', () => {
  const source = readFileSync(SRC, 'utf8');
  const i = source.indexOf("if (before.trim() !== '') {");
  const block = source.slice(i, i + 1600);
  assert.match(block, /composerOccupancy\(before, text\)/,
    'the occupancy decision must be consulted before refusing');
  // The code stays `composer_not_empty` -- three existing suites pin it and a refusal that changes name
  // silently is its own hazard -- while every stranded-draft fact travels in evidence.
  assert.match(block, /reason: 'composer_not_empty'/);
  for (const field of ['composerOccupancy', 'composerHoldsNotice', 'priorWriteDetected']) {
    assert.ok(block.includes(field), 'evidence carries ' + field);
  }
  assert.match(block, /clickPerformed: false/, 'a stranded draft is never clicked');
  assert.match(block, /composerWritten: false/, 'and nothing is written over it');
});

test('T165: every pre-click refusal still reports no click, so a draft can never look sent', () => {
  const source = readFileSync(SRC, 'utf8');
  const deliver = source.slice(source.indexOf('export async function deliverInto'));
  // The writtenNoClick class is the only pre-click path that has touched the composer.
  assert.match(deliver, /const writtenNoClick = \(reason, extra\) => \(\{\s*status: 'unconfirmed'/);
  assert.match(deliver, /clickPerformed: false/);
  // "submitted" exists in exactly one place, and it requires the composer to be empty plus an exact
  // template match: no stranded draft can reach it.
  assert.equal((deliver.match(/status: 'submitted'/g) || []).length, 1);
  assert.match(deliver, /if \(evidence\.composerEmpty && evidence\.exactTemplateMatched\)/);
});
