// T095B158: the ledger and the stop-condition evaluator, pinning what an unattended round leaves
// behind. Red first: written before tools/continuation/round_guard.mjs existed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const RG = await import(pathToFileURL(path.join(DIR, 'round_guard.mjs')).href + '?r=t158'
  + Math.random().toString(36).slice(2));
const CLI = path.join(DIR, 'goal_plan.mjs');
const PLAN_FILE = path.join(DIR, 'plans', 'T158.json');
const RUNBOOK = path.join(DIR, 'GOAL_RUNBOOK.md');

const DIGEST = 'a'.repeat(64);
const PLAN = {
  maxRounds: 3,
  tasks: [
    { id: 'T158-A', scope: 'repo:agent-relay' },
    { id: 'T158-B', scope: 'repo:agent-relay' },
    { id: 'T158-C', scope: 'repo:agent-relay' },
  ],
};

const entry = (roundId, taskId, gates, outcome = RG.STOP.CONTINUE) => ({
  roundId, taskId, at: 1793460000000, planDigest: DIGEST,
  gates: gates.map(([name, result]) => ({ name, result })), outcome,
});

function ledgerInTemp() {
  const dir = mkdtempSync(path.join(tmpdir(), 't158-ledger-'));
  return RG.createLedger(path.join(dir, 'rounds.jsonl'));
}

test('T158: a round is recorded once, and replaying it changes nothing', () => {
  const ledger = ledgerInTemp();
  const first = ledger.append(entry('r1', 'T158-A', [['js', 'pass'], ['gate', 'pass']]));
  assert.equal(first.code, null);
  assert.match(first.row.recordDigest, /^[0-9a-f]{64}$/);
  assert.equal(ledger.has('r1'), true);

  const again = ledger.append(entry('r1', 'T158-A', [['js', 'pass'], ['gate', 'pass']]));
  assert.equal(again.code, 'duplicate');
  assert.equal(again.count, 1, 'a replay must not append a second row');
  assert.equal(ledger.records().length, 1);
});

test('T158: a malformed round is refused instead of half-written', () => {
  const ledger = ledgerInTemp();
  const cases = [
    [null, 'entry_missing'],
    [entry('', 'T158-A', [['js', 'pass']]), 'round_id_missing'],
    [entry('r1', '', [['js', 'pass']]), 'task_id_missing'],
    [{ ...entry('r1', 'T158-A', [['js', 'pass']]), planDigest: 'nothex' }, 'plan_digest_invalid'],
    [entry('r1', 'T158-A', []), 'gates_missing'],
    [entry('r1', 'T158-A', [['js', 'maybe']]), 'gate_result_invalid'],
    [{ ...entry('r1', 'T158-A', [['js', 'pass']]), outcome: 'fine' }, 'outcome_invalid'],
  ];
  for (const [bad, code] of cases) {
    assert.equal(ledger.append(bad).code, code);
  }
  assert.equal(ledger.records().length, 0, 'nothing partial reached the file');
});

test('T158: the same gate failing twice in a row blocks, a different gate does not', () => {
  const same = RG.evaluateStop({ plan: PLAN, records: [
    entry('r1', 'T158-A', [['js', 'fail'], ['gate', 'pass']], RG.STOP.CONTINUE),
    entry('r2', 'T158-B', [['js', 'fail'], ['gate', 'pass']], RG.STOP.CONTINUE),
  ] });
  assert.equal(same.code, RG.STOP.BLOCKED);
  assert.equal(same.gate, 'js');

  const different = RG.evaluateStop({ plan: PLAN, records: [
    entry('r1', 'T158-A', [['js', 'fail'], ['gate', 'pass']], RG.STOP.CONTINUE),
    entry('r2', 'T158-B', [['js', 'pass'], ['gate', 'fail']], RG.STOP.CONTINUE),
  ] });
  assert.equal(different.code, RG.STOP.CONTINUE, 'one red gate is a fix, not a stop');
});

test('T158: work outside the plan stops the run, and the round is named', () => {
  const out = RG.evaluateStop({ plan: PLAN, records: [
    entry('r1', 'T158-Z', [['js', 'pass']], RG.STOP.STOP_AND_REPORT),
  ] });
  assert.equal(out.code, RG.STOP.STOP_AND_REPORT);
  assert.equal(out.taskId, 'T158-Z');
});

test('T158: done, cap and continue are decided from the ledger, not from optimism', () => {
  const done = RG.evaluateStop({ plan: PLAN, records: [
    entry('r1', 'T158-A', [['js', 'pass']], RG.STOP.DONE),
    entry('r2', 'T158-B', [['js', 'pass']], RG.STOP.DONE),
    entry('r3', 'T158-C', [['js', 'pass']], RG.STOP.DONE),
  ] });
  assert.equal(done.code, RG.STOP.DONE);
  assert.deepEqual(done.remaining, []);

  const capped = RG.evaluateStop({ plan: { ...PLAN, maxRounds: 2 }, records: [
    entry('r1', 'T158-A', [['js', 'pass']], RG.STOP.CONTINUE),
    entry('r2', 'T158-B', [['js', 'pass']], RG.STOP.CONTINUE),
  ] });
  assert.equal(capped.code, RG.STOP.BLOCKED);
  assert.match(capped.why, /cap/);

  // A `continue` round means the task is not finished yet, so it stays in the remaining list --
  // only an outcome of `done` retires a task.
  const stillOpen = RG.evaluateStop({ plan: PLAN, records: [
    entry('r1', 'T158-A', [['js', 'pass']], RG.STOP.CONTINUE),
  ] });
  assert.equal(stillOpen.code, RG.STOP.CONTINUE);
  assert.deepEqual(stillOpen.remaining, ['T158-A', 'T158-B', 'T158-C']);

  const advanced = RG.evaluateStop({ plan: PLAN, records: [
    entry('r1', 'T158-A', [['js', 'pass']], RG.STOP.DONE),
  ] });
  assert.equal(advanced.code, RG.STOP.CONTINUE);
  assert.deepEqual(advanced.remaining, ['T158-B', 'T158-C']);
});

test('T158: a finished task list wins over the cap, so a capped run can still close', () => {
  const out = RG.evaluateStop({ plan: { ...PLAN, maxRounds: 3 }, records: [
    entry('r1', 'T158-A', [['js', 'pass']], RG.STOP.DONE),
    entry('r2', 'T158-B', [['js', 'pass']], RG.STOP.DONE),
    entry('r3', 'T158-C', [['js', 'pass']], RG.STOP.DONE),
  ] });
  assert.equal(out.code, RG.STOP.DONE);
});

test('T158: the shipped 3-round plan validates once approved and refuses while it is not', () => {
  const plan = JSON.parse(readFileSync(PLAN_FILE, 'utf8'));
  assert.equal(plan.approvedBy, '', 'the production approval field stays empty');
  assert.equal(plan.maxRounds, 3);
  assert.deepEqual(plan.tasks.map((t) => t.id), ['T158-A', 'T158-B', 'T158-C']);
  for (const task of plan.tasks) {
    assert.equal(task.scope, 'repo:agent-relay');
    assert.ok(task.acceptance.length > 20, task.id + ' has a checkable acceptance');
  }

  let refused = 0;
  try { execFileSync(process.execPath, [CLI, PLAN_FILE], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (error) { refused = error.status; }
  assert.equal(refused, 2, 'an unapproved plan must not validate');

  const filled = path.join(mkdtempSync(path.join(tmpdir(), 't158-ok-')), 'plan.json');
  writeFileSync(filled, JSON.stringify({ ...plan, approvedBy: 'synthetic-preflight' }), 'utf8');
  const out = execFileSync(process.execPath, [CLI, filled], { encoding: 'utf8' });
  assert.match(out, /DIGEST\s+[0-9a-f]{64}/);
  assert.match(out, /T158-A, T158-B, T158-C/);
  assert.match(out, /create_goal/);
});

test('T158: the runbook documents the ledger fields and the four stop codes', () => {
  const text = readFileSync(RUNBOOK, 'utf8');
  for (const needle of ['round_guard.mjs', 'roundId', 'planDigest', 'recordDigest',
    'stop_and_report', 'blocked', 'done']) {
    assert.equal(text.includes(needle), true, 'runbook documents: ' + needle);
  }
});
