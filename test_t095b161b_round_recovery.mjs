// T095B161 round 2: recovery decisions, from the states that actually appear after a restart.
//
// The order of these checks is the whole point: a torn tail outranks everything (you cannot judge rounds
// you cannot read), revision drift outranks a plan mismatch (an edited goal invalidates the approval
// itself), an open round outranks "the goal is armed" (otherwise the next round overlaps half-done work),
// and a disarmed goal outranks "resume ok" (the driver will not run).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const RC = await import(pathToFileURL(path.join(DIR, 'round_recovery.mjs')).href + '?r=t161b'
  + Math.random().toString(36).slice(2));
const RE = await import(pathToFileURL(path.join(DIR, 'round_evidence.mjs')).href + '?r=t161b'
  + Math.random().toString(36).slice(2));

const PLAN = { objective: 'x', approvedBy: 'op', maxRounds: 5,
  tasks: [{ id: 'R1', acceptance: 'a' }, { id: 'R2', acceptance: 'b' }] };
const OWN = RE.planDigestOf(PLAN);
const goal = (over = {}) => ({ id: 'goal-x', revision: 1, phase: 'active', activation: 'armed',
  roundsStarted: 1, ...over });
const row = (roundId, taskId, outcome, over = {}) => ({ roundId, taskId, at: 1, planDigest: OWN,
  revision: 1, gates: [{ name: 'js', result: 'pass' }], outcome, recordDigest: 'b'.repeat(64), ...over });

test('T161-2: a clean armed run resumes, and says not to start a round by hand', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN, records: [row('r1', 'R1', 'done')] });
  assert.equal(out.code, RC.DECISION.RESUME_OK);
  assert.match(out.steps.join(' '), /do not start one by hand/);
  assert.equal(out.planDigest, OWN);
});

test('T161-2: a torn tail outranks every other judgement', () => {
  const tailText = [JSON.stringify(row('r1', 'R1', 'continue')), '{"roundId":"r2","tas'].join('\n');
  const out = RC.assessRecovery({ goal: goal({ activation: 'disarmed' }), plan: PLAN, tailText });
  assert.equal(out.code, RC.DECISION.DISCARD_TAIL);
  assert.equal(out.tornLineIndex, 1);
  assert.equal(out.keptRounds, 1);
  assert.match(out.steps.join(' '), /keep every complete round/);
});

test('T161-2: an open round stops the next one even though the goal is armed', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN,
    records: [row('r1', 'R1', 'done'), row('r2', 'R2', 'continue')] });
  assert.equal(out.code, RC.DECISION.FINISH_OPEN_FIRST);
  assert.deepEqual(out.open, ['r2(outcome_continue)']);
  assert.match(out.steps[0], /before any new work/);
});

test('T161-2: revision drift is reported as drift, not as a plan problem', () => {
  const out = RC.assessRecovery({ goal: goal({ revision: 1 }), plan: PLAN,
    records: [row('r1', 'R1', 'done', { revision: 3 })] });
  assert.equal(out.code, RC.DECISION.REVISION_DRIFT);
  assert.equal(out.goalRevision, 1);
  assert.deepEqual(out.rounds, ['r1']);
});

test('T161-2: a plan edited after approval stops the run', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN,
    records: [row('r1', 'R1', 'done', { planDigest: 'c'.repeat(64) })] });
  assert.equal(out.code, RC.DECISION.PLAN_CHANGED);
  assert.deepEqual(out.drifted.map((d) => d.roundId), ['r1']);

  const byDigest = RC.assessRecovery({ goal: goal(), planDigest: OWN,
    records: [row('r1', 'R1', 'done', { planDigest: 'd'.repeat(64) })] });
  assert.equal(byDigest.code, RC.DECISION.PLAN_CHANGED);
});

test('T161-2: a missing plan is blocked with a code, not resumed on hope', () => {
  const out = RC.assessRecovery({ goal: goal(), plan: null, records: [row('r1', 'R1', 'done')] });
  assert.equal(out.code, RC.DECISION.BLOCKED);
  assert.equal(out.why, 'plan_missing');
});

test('T161-2: a disarmed goal needs a human resume, and must not spawn a second goal', () => {
  const out = RC.assessRecovery({ goal: goal({ activation: 'disarmed' }), plan: PLAN,
    records: [row('r1', 'R1', 'done')] });
  assert.equal(out.code, RC.DECISION.NEEDS_HUMAN_RESUME);
  assert.equal(out.why, 'activation=disarmed');
  assert.match(out.steps.join(' '), /do not create a second goal/);
});

test('T161-2: a complete goal has nothing to do, whatever the ledger says', () => {
  const out = RC.assessRecovery({ goal: goal({ phase: 'complete', activation: 'disarmed' }),
    plan: PLAN, records: [row('r1', 'R1', 'continue')] });
  assert.equal(out.code, RC.DECISION.NOTHING_TO_DO);
});

test('T161-2: a torn tail is reported even when the goal already says complete', () => {
  const tailText = [JSON.stringify(row('r1', 'R1', 'done')), '{"roundId":"r2"'].join('\n');
  const out = RC.assessRecovery({ goal: goal({ phase: 'complete', activation: 'disarmed' }),
    plan: PLAN, tailText });
  assert.equal(out.code, RC.DECISION.DISCARD_TAIL,
    'completion may have been decided from a view missing its last round');
  assert.equal(out.recheckCompletion, true);
  assert.equal(out.keptRounds, 1);
});

test('T161-2: a ledger row that cannot name its revision blocks instead of passing the drift check', () => {
  const legacy = { roundId: 'r1', taskId: 'R1', at: 1, planDigest: OWN, outcome: 'done',
    gates: [{ name: 'js', result: 'pass' }], recordDigest: 'b'.repeat(64) };
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN, records: [legacy] });
  assert.equal(out.code, RC.DECISION.BLOCKED);
  assert.match(out.why, /row_revision_missing:r1/);
});

test('T301: Host exit with no round outcome stays open despite stale duplicate completion', () => {
  // Synthetic ledger only: a transport failure is not proof the upstream rejected work.
  // The older completion shares a task but does not settle this distinct open round.
  const unfinished = row('new-round', 'R1', null, {
    failure_code: 'desktop_host_exited', acceptance: 'unknown',
  });
  const stale = row('old-round', 'R1', 'done');
  for (const activation of ['armed', 'disarmed']) {
    for (const records of [
      [unfinished, stale], [stale, unfinished],
      [stale, unfinished, stale], [unfinished, stale, unfinished],
    ]) {
      const input = { goal: goal({ activation }), plan: PLAN, records };
      const before = structuredClone(input);
      const result = RC.assessRecovery(input);
      assert.equal(result.code, RC.DECISION.FINISH_OPEN_FIRST);
      assert.ok(result.open.includes('new-round(no_outcome)'));
      assert.notEqual(result.code, RC.DECISION.RESUME_OK);
      assert.deepEqual(input, before, 'assessment must not close/rewrite the ledger or rearm goal');
    }
  }
  // A missing terminal callback must not be synthesized from the Host failure code.
  const out = RC.assessRecovery({ goal: goal(), plan: PLAN, records: [unfinished] });
  assert.deepEqual(out.open, ['new-round(no_outcome)']);
});

test('T302: another round terminal record cannot settle later nonterminal work', () => {
  for (const outcome of ['continue', 'unknown', 'desktop_host_exited']) {
    for (const closedOutcome of ['done', 'blocked', 'stop_and_report']) {
      const older = row('older', 'R1', closedOutcome, { at: 1 });
      const later = row('later', 'R1', outcome, { at: 2 });
      for (const records of [[older, later], [later, older], [older, later, older]]) {
        for (const activation of ['armed', 'disarmed']) {
          const input = { goal: goal({ activation }), plan: PLAN, records };
          const before = structuredClone(input);
          assert.deepEqual(RE.openRounds(records), [
            { roundId: 'later', taskId: 'R1', why: 'outcome_' + outcome },
          ]);
          assert.equal(RC.assessRecovery(input).code, RC.DECISION.FINISH_OPEN_FIRST);
          assert.equal(RE.buildEvidence({ plan: PLAN, records }).complete, false);
          assert.deepEqual(input, before);
        }
      }
    }
  }
});

test('T302: terminal-only rounds remain settled; conflicting duplicate stays conservative', () => {
  const done = row('settled', 'R1', 'done');
  assert.deepEqual(RE.openRounds([done, done]), []);
  assert.equal(RC.assessRecovery({ goal: goal(), plan: PLAN, records: [done, done] }).code,
    RC.DECISION.RESUME_OK);
  const conflict = row('settled', 'R1', 'unknown');
  for (const records of [[done, conflict], [conflict, done]]) {
    assert.equal(RC.assessRecovery({ goal: goal(), plan: PLAN, records }).code,
      RC.DECISION.FINISH_OPEN_FIRST);
  }
});

test('T161-2: no goal is its own answer', () => {
  for (const bad of [null, {}, { id: '' }]) {
    assert.equal(RC.assessRecovery({ goal: bad }).code, 'goal_missing');
  }
});

test('T161-2: every decision has steps, and the renderer names the decision', () => {
  const decisions = [
    RC.assessRecovery({ goal: goal(), plan: PLAN, records: [] }),
    RC.assessRecovery({ goal: goal(), plan: PLAN, tailText: '{"x' }),
    RC.assessRecovery({ goal: goal(), plan: PLAN, records: [row('r1', 'R1', 'continue')] }),
    RC.assessRecovery({ goal: goal({ activation: 'disarmed' }), plan: PLAN, records: [] }),
    RC.assessRecovery({ goal: goal({ phase: 'complete' }), plan: PLAN, records: [] }),
  ];
  for (const out of decisions) {
    assert.ok(Array.isArray(out.steps) && out.steps.length > 0, out.code + ' has steps');
    assert.match(RC.renderRecoveryMarkdown(out), new RegExp('Decision: `' + out.code + '`'));
  }
});
