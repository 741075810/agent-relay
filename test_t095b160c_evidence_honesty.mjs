// T095B160 round C: the evidence bundle must not lie.
//
// `complete: true` is the one claim a reader trusts without re-deriving it, so it must be the hardest
// claim to satisfy: every round against a plan task, every round closed with `done`, every round
// carrying the digest that binds it to the ledger, and no round id appearing twice. Each of those is
// attacked here from the side that would otherwise pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const RE = await import(pathToFileURL(path.join(DIR, 'round_evidence.mjs')).href + '?r=t160c'
  + Math.random().toString(36).slice(2));

const PLAN = {
  objective: 'x', approvedBy: 'operator', maxRounds: 3,
  tasks: [{ id: 'C1', acceptance: 'a1' }, { id: 'C2', acceptance: 'a2' }],
};
const OWN = RE.planDigestOf(PLAN);
const row = (roundId, taskId, outcome, over = {}) => ({
  roundId, taskId, at: 1, planDigest: OWN, gates: [{ name: 'js', result: 'pass' }],
  outcome, recordDigest: 'b'.repeat(64), ...over,
});

test('T160-C: a clean run is complete, with no problems listed', () => {
  const bundle = RE.buildEvidence({ plan: PLAN, commit: 'c'.repeat(40), records: [
    row('r1', 'C1', 'done'), row('r2', 'C2', 'done')] });
  assert.equal(bundle.complete, true);
  assert.deepEqual(bundle.problems, []);
  const md = RE.renderEvidenceMarkdown(bundle);
  assert.match(md, /Complete: true/);
  assert.equal(/Problems:/.test(md), false, 'a clean run does not print an empty problems line');
});

test('T160-C: an open round keeps complete false, and the reason is named', () => {
  const bundle = RE.buildEvidence({ plan: PLAN, records: [
    row('r1', 'C1', 'done'), row('r2', 'C2', 'continue')] });
  assert.equal(bundle.complete, false);
  assert.deepEqual(bundle.problems, ['open_round:r2']);
  assert.match(RE.renderEvidenceMarkdown(bundle), /Problems: open_round:r2/);
});

test('T160-C: a done round against a task the plan never had is not completion', () => {
  // This is the false positive round C exists for: every round says done, but one of them is not a
  // plan task, so the approved three-round list cannot be considered finished.
  const bundle = RE.buildEvidence({ plan: PLAN, records: [
    row('r1', 'C1', 'done'), row('r2', 'C-Z', 'done')] });
  assert.equal(bundle.complete, false);
  assert.deepEqual(bundle.problems, ['out_of_plan:r2:C-Z']);
  assert.equal(bundle.rounds[1].knownTask, false);
});

test('T160-C: a round without a record digest cannot close the run', () => {
  const bundle = RE.buildEvidence({ plan: PLAN, records: [
    row('r1', 'C1', 'done'), row('r2', 'C2', 'done', { recordDigest: undefined })] });
  assert.equal(bundle.complete, false);
  assert.deepEqual(bundle.problems, ['missing_record_digest:r2']);
});

test('T160-C: the same round id twice is reported, because one copy may be a replay', () => {
  const bundle = RE.buildEvidence({ plan: PLAN, records: [
    row('r1', 'C1', 'done'), row('r1', 'C1', 'done'), row('r2', 'C2', 'done')] });
  assert.equal(bundle.complete, false);
  assert.deepEqual(bundle.problems, ['duplicate_round:r1']);
});

test('T160-C: every problem is reported, not just the first', () => {
  const bundle = RE.buildEvidence({ plan: PLAN, records: [
    row('r1', 'C1', 'continue'), row('r2', 'C-Z', 'done', { recordDigest: undefined })] });
  assert.equal(bundle.complete, false);
  assert.equal(bundle.problems.length, 3, JSON.stringify(bundle.problems));
  assert.ok(bundle.problems.some((p) => p.startsWith('open_round:r1')));
  assert.ok(bundle.problems.some((p) => p.startsWith('out_of_plan:r2')));
  assert.ok(bundle.problems.some((p) => p.startsWith('missing_record_digest:r2')));
});

test('T160-C: evidenceDigest changes when the commit or a record digest changes', () => {
  const base = RE.buildEvidence({ plan: PLAN, commit: 'c'.repeat(40),
    records: [row('r1', 'C1', 'done')] });
  const otherCommit = RE.buildEvidence({ plan: PLAN, commit: 'd'.repeat(40),
    records: [row('r1', 'C1', 'done')] });
  const otherRecord = RE.buildEvidence({ plan: PLAN, commit: 'c'.repeat(40),
    records: [row('r1', 'C1', 'done', { recordDigest: 'e'.repeat(64) })] });
  assert.notEqual(base.evidenceDigest, otherCommit.evidenceDigest,
    'the bundle must be bound to the commit it describes');
  assert.notEqual(base.evidenceDigest, otherRecord.evidenceDigest);
  assert.equal(base.evidenceDigest,
    RE.buildEvidence({ plan: PLAN, commit: 'c'.repeat(40),
      records: [row('r1', 'C1', 'done')] }).evidenceDigest, 'same input, same digest');
});

test('T160-C: an empty run is not complete, and says so plainly', () => {
  const bundle = RE.buildEvidence({ plan: PLAN, records: [] });
  assert.equal(bundle.complete, false);
  assert.deepEqual(bundle.problems, ['no_rounds']);
  assert.match(RE.renderEvidenceMarkdown(bundle), /Complete: false/);
});
