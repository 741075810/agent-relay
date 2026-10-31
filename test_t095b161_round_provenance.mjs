// T095B161 round 1: provenance joins, attacked from the side that would look fine.
//
// A commit message saying "native goal round N" is a claim. These tests make it evidence: a record must
// name the goal, carry the counter the goal reported, point at a commit that exists, and agree with the
// plan digest. Each case below is a way the join could lie while looking healthy.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const PV = await import(pathToFileURL(path.join(DIR, 'round_provenance.mjs')).href + '?r=t161'
  + Math.random().toString(36).slice(2));

const GOAL_ID = 'goal-49b23d89-fa1c-4b37-9f0e-f39a745ac7b1';
const PLAN = 'a'.repeat(64);
const COMMIT = 'c'.repeat(40);
const goal = (roundsStarted, extra = {}) => ({ id: GOAL_ID, revision: 1, phase: 'active',
  activation: 'armed', roundsStarted, ...extra });
const rec = (roundsStarted, extra = {}) => ({ goal: goal(roundsStarted), taskId: 'P1',
  planDigest: PLAN, commit: COMMIT, outcome: 'done', at: 1793500000000, ...extra });

test('T161-1: a well-formed record links, and the report is ok', () => {
  const report = PV.linkProvenance({ goal: goal(1), records: [rec(1)], commits: [COMMIT],
    planDigest: PLAN });
  assert.equal(report.code, 'ok', JSON.stringify(report.problems));
  assert.equal(report.accountedRounds, 1);
  assert.equal(report.linked[0].commitPresent, true);
  assert.match(report.digest, /^[0-9a-f]{64}$/);
  assert.match(PV.renderProvenanceMarkdown(report), /Verdict: ok/);
});

test('T161-1: a record for another goal is foreign, not merged', () => {
  const report = PV.linkProvenance({ goal: goal(1), records: [
    rec(1, { goal: goal(1, { id: 'goal-other' }) })], commits: [COMMIT], planDigest: PLAN });
  assert.equal(report.code, 'provenance_gap');
  assert.ok(report.problems.includes('foreign_goal:goal-other:1'));
  assert.equal(report.linked.length, 0);
});

test('T161-1: a commit that is not in the log makes the round unproven', () => {
  const report = PV.linkProvenance({ goal: goal(1), records: [rec(1, { commit: 'd'.repeat(40) })],
    commits: [COMMIT], planDigest: PLAN });
  assert.equal(report.code, 'provenance_gap');
  assert.ok(report.problems.includes('commit_not_in_log:' + 'd'.repeat(40)));
});

test('T161-1: a done round with no commit is a claim with nothing behind it', () => {
  const report = PV.linkProvenance({ goal: goal(1), records: [rec(1, { commit: null })],
    commits: [COMMIT], planDigest: PLAN });
  assert.ok(report.problems.includes('done_without_commit:1'));
});

test('T161-1: the round counter may not repeat or go backwards', () => {
  const report = PV.linkProvenance({ goal: goal(2), records: [
    rec(2, { taskId: 'P2' }), rec(1)], commits: [COMMIT], planDigest: PLAN });
  assert.ok(report.problems.includes('duplicate_rounds_started:1') === false);
  assert.ok(report.problems.includes('rounds_started_went_backwards:2->1'),
    JSON.stringify(report.problems));

  const duplicate = PV.linkProvenance({ goal: goal(1), records: [rec(1), rec(1, { taskId: 'P1b' })],
    commits: [COMMIT], planDigest: PLAN });
  assert.ok(duplicate.problems.includes('duplicate_rounds_started:1'));
});

test('T161-1: a ledger ahead of the goal counter is a gap, and so is the reverse', () => {
  const ahead = PV.linkProvenance({ goal: goal(1), records: [rec(1), rec(2)], commits: [COMMIT],
    planDigest: PLAN });
  assert.ok(ahead.problems.includes('ledger_ahead_of_goal:2>1'), JSON.stringify(ahead.problems));

  const behind = PV.linkProvenance({ goal: goal(3), records: [rec(1)], commits: [COMMIT],
    planDigest: PLAN });
  assert.equal(behind.code, 'provenance_gap');
  assert.ok(behind.problems.includes('goal_ahead_of_ledger:3>1'),
    'a goal counter with no ledger rows is reported, not treated as clean');
});

test('T161-1: a plan mismatch is named per round', () => {
  const report = PV.linkProvenance({ goal: goal(1), records: [rec(1, { planDigest: 'b'.repeat(64) })],
    commits: [COMMIT], planDigest: PLAN });
  assert.ok(report.problems.includes('plan_mismatch:1'));
});

test('T161-1: a record missing the fields that make it checkable is unreadable, not skipped', () => {
  const report = PV.linkProvenance({ goal: goal(1), records: [{ taskId: 'P1' }], commits: [COMMIT],
    planDigest: PLAN });
  assert.equal(report.code, 'provenance_gap');
  const problem = report.problems.find((p) => p.startsWith('unreadable_record:'));
  assert.ok(problem, JSON.stringify(report.problems));
  for (const field of ['goal_id_missing', 'rounds_started_missing', 'revision_missing',
    'plan_digest_invalid', 'phase_invalid', 'activation_invalid']) {
    assert.ok(problem.includes(field), 'names ' + field);
  }
});

test('T161-1: no goal at all is its own code, never ok', () => {
  for (const bad of [null, undefined, {}, { id: '' }]) {
    assert.equal(PV.linkProvenance({ goal: bad, records: [rec(1)] }).code, 'goal_missing');
  }
});

test('T161-1: an empty commit list disables the log check instead of failing every round', () => {
  const report = PV.linkProvenance({ goal: goal(1), records: [rec(1)], commits: [], planDigest: PLAN });
  assert.equal(report.code, 'ok', JSON.stringify(report.problems));
  assert.equal(report.linked[0].commitPresent, null,
    'no log supplied means unverified, which is neither present nor proven absent');
  assert.match(PV.renderProvenanceMarkdown(report), /unverified/);
});
