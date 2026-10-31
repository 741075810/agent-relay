// T095B156: the plan validator CLI, the versioned template and the runbook, pinned by tests.
// Red first: written before goal_plan.mjs existed (first run: ERR_MODULE_NOT_FOUND).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const GP = await import(pathToFileURL(path.join(DIR, 'goal_plan.mjs')).href + '?r=t156'
  + Math.random().toString(36).slice(2));
const CLI = path.join(DIR, 'goal_plan.mjs');
const TEMPLATE = path.join(DIR, 'plans', 'TEMPLATE.json');
const RUNBOOK = path.join(DIR, 'GOAL_RUNBOOK.md');

const GOOD = {
  version: 'goal-plan/1',
  objective: 'Deliver the goal runbook and its validator inside agent-relay, offline.',
  approvedBy: 'operator',
  approvedAt: 1793450000000,
  maxRounds: 6,
  tasks: [
    { id: 'T156-A', scope: 'repo:agent-relay', title: 'runbook', acceptance: 'runbook lists tools' },
    { id: 'T156-B', scope: 'repo:agent-relay', title: 'validator',
      acceptance: 'goal_plan exits 0 on the template' },
  ],
};

function tempPlan(plan) {
  const dir = mkdtempSync(path.join(tmpdir(), 't156-'));
  const file = path.join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify(plan), 'utf8');
  return file;
}

function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}

test('T156: the versioned template is a valid plan shape', () => {
  const plan = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  assert.equal(plan.version, 'goal-plan/1');
  assert.equal(Array.isArray(plan.tasks), true);
  // The template carries placeholders, so validation must refuse it -- a template is not a plan.
  const out = GP.buildFromPlan(plan);
  assert.equal(out.code, 'not_approved', 'placeholders cannot pass as approval');
  assert.equal(out.exitCode, 2);
  // Filling the placeholders makes it acceptable.
  const filled = { ...plan, objective: 'x', approvedBy: 'operator',
    tasks: plan.tasks.map((t, i) => ({ ...t, id: 't' + (i + 1), scope: 'repo:agent-relay',
      title: 'y', acceptance: 'z' })) };
  delete filled._notes;
  assert.equal(GP.buildFromPlan(filled, { now: 1793450000000 }).code, null);
});

test('T156: a good plan yields a digest, rounds and task order', () => {
  const out = GP.buildFromPlan(GOOD, { sessionId: 's', now: 1793450000000 });
  assert.equal(out.code, null);
  assert.equal(out.exitCode, 0);
  assert.match(out.planDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(out.tasks.map((t) => t.id), ['T156-A', 'T156-B']);
  assert.equal(out.maxRounds, 6);
});

test('T156: the digest pins the approved content, so a silent edit is visible', () => {
  const base = GP.buildFromPlan(GOOD, { now: 1 }).planDigest;
  assert.equal(GP.buildFromPlan(GOOD, { now: 999 }).planDigest, base,
    'the wall clock is not part of the approval');
  const widened = { ...GOOD, tasks: [...GOOD.tasks, { id: 'T156-C', scope: 'repo:agent-relay',
    title: 'extra', acceptance: 'x' }] };
  assert.notEqual(GP.buildFromPlan(widened, { now: 1 }).planDigest, base,
    'adding a task changes the digest');
  const reordered = { ...GOOD, tasks: [GOOD.tasks[1], GOOD.tasks[0]] };
  assert.notEqual(GP.buildFromPlan(reordered, { now: 1 }).planDigest, base,
    'reordering changes the digest');
});

test('T156: every refusal code reaches the CLI as exit 2 with the code on stderr', () => {
  const cases = [
    [{ ...GOOD, objective: '' }, 'objective_missing'],
    [{ ...GOOD, approvedBy: '' }, 'not_approved'],
    [{ ...GOOD, tasks: [] }, 'tasks_missing'],
    [{ ...GOOD, tasks: [{ id: 'a', title: 'x', acceptance: 'y' }] }, 'scope_missing'],
    [{ ...GOOD, tasks: [{ id: 'a', scope: 'repo:agent-relay', title: 'x' }] }, 'acceptance_missing'],
    [{ ...GOOD, expiresAt: 5 }, 'approval_expired'],
  ];
  for (const [plan, code] of cases) {
    const out = runCli([tempPlan(plan)]);
    assert.equal(out.code, 2, code);
    assert.match(out.err, new RegExp(code), 'CLI reports ' + code);
  }
});

test('T156: text that asks for automation is refused, not merely warned about', () => {
  const cases = [
    ['submit_task on completion', /submit_task/],
    ['autoApprove everything while I sleep', /autoApprove/],
    ['start a daemon that keeps going', /daemon/],
    ['run unattended for a week', /unattended/],
  ];
  for (const [objective] of cases) {
    const out = GP.buildFromPlan({ ...GOOD, objective }, { now: 1 });
    assert.equal(out.code, 'plan_asks_for_automation', objective);
    assert.equal(out.exitCode, 2);
    assert.equal(out.hits.length > 0, true);
  }
  // The scanner is lexical and does not parse negation: a plan that even *mentions* submit_task is
  // refused, and the fix is to rephrase, not to argue with the scanner. Ordinary text is clean.
  assert.equal(GP.scanText('never submit_task, never start a daemon').length, 2);
  assert.deepEqual(GP.scanText('implement the validator and run the gates'), []);
});

test('T156: the CLI prints the objective and the per-round checklist', () => {
  const out = runCli([tempPlan(GOOD)]);
  assert.equal(out.code, 0);
  assert.match(out.out, /DIGEST\s+[0-9a-f]{64}/);
  assert.match(out.out, /create_goal/);
  assert.match(out.out, /update_goal/);
  assert.match(out.out, /release_gate/);
  assert.match(out.out, /stop conditions/i);
});

test('T156: an unreadable plan is exit 3, distinct from a refusal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 't156-bad-'));
  const file = path.join(dir, 'plan.json');
  writeFileSync(file, '{ not json', 'utf8');
  assert.equal(runCli([file]).code, 3);
  assert.equal(runCli([path.join(dir, 'missing.json')]).code, 3);
});

test('T156: a BOM-prefixed plan is read, not refused as unreadable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 't156-bom-'));
  const file = path.join(dir, 'plan.json');
  writeFileSync(file, '\uFEFF' + JSON.stringify(GOOD), 'utf8');
  const out = runCli([file]);
  assert.equal(out.code, 0, 'a BOM is an encoding detail, not a plan defect');
  assert.match(out.out, /DIGEST/);
});

test('T156: the runbook names the real tools, actions and lifecycle fields', () => {
  const text = readFileSync(RUNBOOK, 'utf8');
  for (const needle of ['create_goal', 'get_goal', 'update_goal', 'max_goal_rounds',
    'revision', 'blocked_reason', 'disarmed', 'phase', 'roundsStarted', 'maxGoalRounds',
    'update_goal action=resume', 'release_gate.py --clean-clone']) {
    assert.equal(text.includes(needle), true, 'runbook documents: ' + needle);
  }
  assert.equal(/no event hook/i.test(text), true, 'the missing event hook is stated');
  assert.equal(/no unattended resume/i.test(text), true, 'the restart boundary is stated');
});
