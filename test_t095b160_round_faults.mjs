// T095B160 round A: fault-injection on the crash-safe ledger reader.
//
// The premise being attacked: "a ledger that survived a kill can always be read". Real ledgers pick up
// blank lines, CRLF from a Windows editor, a BOM from the first writer, JSON that parses to a non-object
// (`null`, a number, a string, an array), a line truncated mid-object, and a very long line. Each of
// those must be classified, not thrown on and not silently accepted as a round.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const RE = await import(pathToFileURL(path.join(DIR, 'round_evidence.mjs')).href + '?r=t160'
  + Math.random().toString(36).slice(2));

const D = 'a'.repeat(64);
const good = (roundId, taskId = 'T159-A', outcome = 'done') => ({
  roundId, taskId, at: 1, planDigest: D, gates: [{ name: 'js', result: 'pass' }],
  outcome, recordDigest: 'b'.repeat(64),
});

test('T160-A: blank lines and CRLF are separators, not records', () => {
  const text = [JSON.stringify(good('r1')), '', '   ', JSON.stringify(good('r2'))].join('\r\n');
  const out = RE.recoverTail(text);
  assert.equal(out.records.length, 2);
  assert.equal(out.torn, null);
  assert.deepEqual(out.invalid, []);
});

test('T160-A: a BOM on the first line does not corrupt the first round', () => {
  const out = RE.recoverTail('\uFEFF' + JSON.stringify(good('r1')) + '\n');
  assert.equal(out.records.length, 1, 'a BOM is an encoding detail, not a broken round');
  assert.equal(out.records[0].roundId, 'r1');
});

test('T160-A: JSON that parses to a non-object is invalid, not a round', () => {
  const text = ['null', '123', '"a string"', '[]', JSON.stringify(good('r1'))].join('\n');
  const out = RE.recoverTail(text);
  assert.equal(out.records.length, 1, 'only the real round is a record');
  assert.equal(out.invalid.length, 4, 'four non-object lines are classified as invalid');
  for (const item of out.invalid) assert.equal(typeof item.reason, 'string');
});

test('T160-A: a truncated last line is torn, and the surviving rounds stay usable', () => {
  const out = RE.recoverTail([JSON.stringify(good('r1')), '{"roundId":"r2","taskI'].join('\n'));
  assert.equal(out.records.length, 1);
  assert.equal(out.torn.lineIndex, 1);
});

test('T160-A: a very long line is read, not dropped', () => {
  const big = { ...good('r1'), note: 'x'.repeat(200000) };
  const out = RE.recoverTail(JSON.stringify(big) + '\n');
  assert.equal(out.records.length, 1);
  assert.equal(out.records[0].note.length, 200000);
});

test('T160-A: openRounds ignores invalid lines and still names the open round', () => {
  const text = ['null', JSON.stringify(good('r1', 'T159-A', 'continue')), '{"broken"'].join('\n');
  const { records } = RE.recoverTail(text);
  const open = RE.openRounds(records);
  assert.deepEqual(open.map((o) => o.roundId), ['r1']);
});

test('T160-A: buildEvidence refuses to crash on a ledger that contained garbage', () => {
  const plan = { objective: 'x', approvedBy: 'op', maxRounds: 3,
    tasks: [{ id: 'T159-A', acceptance: 'a' }] };
  const { records, invalid } = RE.recoverTail(['null', '123', JSON.stringify(good('r1'))].join('\n'));
  const bundle = RE.buildEvidence({ plan, records: [...records, ...invalid.map(() => null)],
    commit: 'c'.repeat(40) });
  assert.equal(bundle.rounds.length, 1, 'garbage must not appear as a round');
  assert.equal(bundle.invalid, 2, 'the bundle reports how many lines were dropped');
  assert.equal(bundle.complete, true);
  const md = RE.renderEvidenceMarkdown(bundle);
  assert.match(md, /Invalid lines: 2/);
});

test('T160-A: the file reader survives a ledger whose only content is a torn line', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 't160-a-'));
  const file = path.join(dir, 'rounds.jsonl');
  writeFileSync(file, '{"roundId":"r1","task', 'utf8');
  const out = RE.readLedgerFile(file);
  assert.equal(out.records.length, 0);
  assert.equal(out.torn.lineIndex, 0);
});
