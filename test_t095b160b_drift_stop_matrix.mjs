// T095B160 round B: the counter-example matrix for plan drift and stop decisions.
//
// A stop code is only worth having if the *reason* it reports is the reason that actually happened.
// So this file attacks each code from the wrong side: a drift that looks like agreement, a scope
// violation that looks like progress, a repeated failure that looks like a fresh one, a cap that looks
// like room to continue, and a finished list that still has an open round.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const RE = await import(pathToFileURL(path.join(DIR, 'round_evidence.mjs')).href + '?r=t160b'
  + Math.random().toString(36).slice(2));
const RG = await import(pathToFileURL(path.join(DIR, 'round_guard.mjs')).href + '?r=t160b'
  + Math.random().toString(36).slice(2));

const PLAN = {
  objective: 'x', approvedBy: 'operator', maxRounds: 3,
  tasks: [
    { id: 'B1', scope: 'repo:agent-relay', acceptance: 'a1' },
    { id: 'B2', scope: 'repo:agent-relay', acceptance: 'a2' },
  ],
};
const OWN = RE.planDigestOf(PLAN);
const row = (roundId, taskId, outcome, gates = [['js', 'pass']], planDigest = OWN) => ({
  roundId, taskId, at: 1, planDigest, gates: gates.map(([name, result]) => ({ name, result })),
  outcome, recordDigest: 'b'.repeat(64),
});

test('T160-B: drift is named per round, including the digest that differed', () => {
  const out = RE.verifyPlanBinding({ plan: PLAN, records: [
    row('r1', 'B1', 'done'),
    row('r2', 'B2', 'continue', [['js', 'pass']], 'c'.repeat(64)),
  ] });
  assert.equal(out.code, 'plan_drift');
  assert.equal(out.checked, 2);
  assert.deepEqual(out.drifted.map((d) => d.roundId), ['r2'],
    'only the round recorded against another plan is named');
  assert.equal(out.drifted[0].recorded, 'c'.repeat(64));
  assert.equal(out.planDigest, OWN);
});

test('T160-B: a plan whose approval text changed is drift even if the task list did not', () => {
  const widened = { ...PLAN, approvedBy: 'someone-else' };
  const out = RE.verifyPlanBinding({ plan: widened, records: [row('r1', 'B1', 'done')] });
  assert.equal(out.code, 'plan_drift', 'approval is part of what was authorised');
  const extra = { ...PLAN, tasks: [...PLAN.tasks, { id: 'B3', scope: 'repo:agent-relay' }] };
  assert.equal(RE.verifyPlanBinding({ plan: extra, records: [row('r1', 'B1', 'done')] }).code,
    'plan_drift', 'a task added after approval is drift');
});

test('T160-B: a round with no recorded digest counts as drift, not as agreement', () => {
  const orphan = { roundId: 'r1', taskId: 'B1', at: 1, gates: [{ name: 'js', result: 'pass' }],
    outcome: 'done' };
  const out = RE.verifyPlanBinding({ plan: PLAN, records: [orphan] });
  assert.equal(out.code, 'plan_drift');
  assert.equal(out.drifted[0].recorded, undefined);
});

test('T160-B: missing plan is reported as its own code, never as ok', () => {
  for (const plan of [null, undefined, 42, 'x']) {
    assert.equal(RE.verifyPlanBinding({ plan, records: [row('r1', 'B1', 'done')] }).code,
      'plan_missing');
  }
});

test('T160-B: an out-of-plan task stops the run and names both round and task', () => {
  const out = RG.evaluateStop({ plan: PLAN, records: [row('r1', 'B9', 'done')] });
  assert.equal(out.code, RG.STOP.STOP_AND_REPORT);
  assert.equal(out.taskId, 'B9');
  assert.match(out.why, /outside the plan/);
});

test('T160-B: a scope stop in the last round outranks a later-looking success', () => {
  const out = RG.evaluateStop({ plan: PLAN, records: [
    row('r1', 'B1', 'done'),
    row('r2', 'B2', RG.STOP.STOP_AND_REPORT),
  ] });
  assert.equal(out.code, RG.STOP.STOP_AND_REPORT);
  assert.match(out.why, /scope stop/);
});

test('T160-B: the same gate failing twice blocks with the gate named, and a skip does not', () => {
  const twice = RG.evaluateStop({ plan: PLAN, records: [
    row('r1', 'B1', 'continue', [['js', 'fail'], ['python', 'pass']]),
    row('r2', 'B2', 'continue', [['js', 'fail'], ['python', 'pass']]),
  ] });
  assert.equal(twice.code, RG.STOP.BLOCKED);
  assert.equal(twice.gate, 'js');
  assert.match(twice.why, /twice in a row/);

  const skipped = RG.evaluateStop({ plan: PLAN, records: [
    row('r1', 'B1', 'continue', [['js', 'skip']]),
    row('r2', 'B2', 'continue', [['js', 'skip']]),
  ] });
  assert.equal(skipped.code, RG.STOP.CONTINUE, 'skips are not failures');

  const mixed = RG.evaluateStop({ plan: PLAN, records: [
    row('r1', 'B1', 'continue', [['js', 'fail'], ['python', 'fail']]),
    row('r2', 'B2', 'continue', [['python', 'fail'], ['js', 'fail']]),
  ] });
  assert.equal(mixed.code, RG.STOP.BLOCKED, 'gate order does not hide a repeat');
  assert.equal(mixed.gate, 'js,python');
});

test('T160-B: the cap blocks, and a finished list still wins over it', () => {
  const cap = RG.evaluateStop({ plan: PLAN, maxRounds: 2, records: [
    row('r1', 'B1', 'continue'), row('r2', 'B2', 'continue')] });
  assert.equal(cap.code, RG.STOP.BLOCKED);
  assert.match(cap.why, /round cap reached \(2\)/);

  const finished = RG.evaluateStop({ plan: PLAN, maxRounds: 2, records: [
    row('r1', 'B1', 'done'), row('r2', 'B2', 'done')] });
  assert.equal(finished.code, RG.STOP.DONE);
  assert.deepEqual(finished.remaining, []);
});

test('T160-B: an empty ledger asks for the first task instead of claiming done', () => {
  const out = RG.evaluateStop({ plan: PLAN, records: [] });
  assert.equal(out.code, RG.STOP.CONTINUE);
  assert.deepEqual(out.remaining, ['B1', 'B2']);
  const empty = RG.evaluateStop({ plan: { objective: 'x', approvedBy: 'op', tasks: [] },
    records: [] });
  assert.equal(empty.code, RG.STOP.CONTINUE, 'no tasks is not "done"');
  assert.match(empty.why, /no tasks/);
});

test('T160-B: an unreadable ledger row is an unsafe state, not a crash and not a clean run', () => {
  // Found by this matrix: a row without `gates` used to throw TypeError out of evaluateStop.
  const noGates = { roundId: 'r2', taskId: 'B2', at: 2, planDigest: OWN, outcome: 'continue' };
  const out = RG.evaluateStop({ plan: PLAN, records: [row('r1', 'B1', 'continue'), noGates] });
  assert.equal(out.code, RG.STOP.BLOCKED);
  assert.match(out.why, /not a usable round: gates_missing/);
  assert.equal(out.round, 'r2');

  for (const [bad, needle] of [
    [{ ...row('r1', 'B1', 'done'), taskId: '' }, 'task_id_missing'],
    [{ ...row('r1', 'B1', 'done'), gates: [{ name: 'js', result: 'maybe' }] },
      'gate_result_invalid'],
    [null, 'row_not_an_object'],
  ]) {
    const verdict = RG.evaluateStop({ plan: PLAN, records: [bad] });
    assert.equal(verdict.code, RG.STOP.BLOCKED, needle);
    assert.match(verdict.why, new RegExp(needle));
  }
});

test('T160-B: every stop code carries a why a human can act on', () => {
  const cases = [
    RG.evaluateStop({ plan: PLAN, records: [] }),
    RG.evaluateStop({ plan: PLAN, records: [row('r1', 'B1', 'done'), row('r2', 'B2', 'done')] }),
    RG.evaluateStop({ plan: PLAN, records: [row('r1', 'B9', 'done')] }),
    RG.evaluateStop({ plan: PLAN, maxRounds: 1, records: [row('r1', 'B1', 'continue')] }),
  ];
  for (const out of cases) {
    assert.equal(typeof out.why, 'string');
    assert.ok(out.why.length > 8, out.code + ' explains itself: ' + out.why);
    assert.ok(Object.values(RG.STOP).includes(out.code), 'unknown code ' + out.code);
  }
});
