// T095B157: the documented round/delivery claims, the T157 plan, and the profile-diff draft.
// Red first: written before native_rounds.mjs, plans/T157.json and the draft existed.
//
// These tests are the falsifier for this round's conclusion. If a package version stops saying
// "stays disarmed until an explicit human-authorized resume", the probe fails here rather than the
// runbook quietly going stale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'tools', 'continuation');
const NR = await import(pathToFileURL(path.join(DIR, 'native_rounds.mjs')).href + '?r=t157'
  + Math.random().toString(36).slice(2));
const CLI = path.join(DIR, 'goal_plan.mjs');
const PLAN = path.join(DIR, 'plans', 'T157.json');
const DRAFT = path.join(DIR, 'plans', 'T157_schedule_bundle.draft.yml');

const DRIVER_README = [
  'It automatically continues an active goal in the same session while the agent is idle,',
  'continuation is armed, and the configured round allowance remains.',
  'A round starts only at whole-agent idle.',
  'Mounting the driver over an existing agent never arms a goal, and after session resume or fork',
  'an active goal stays disarmed until an explicit human-authorized resume.',
  'No abnormal auto-retry: transient provider failures require a later human-authorized resume.',
].join('\n');

const SCHEDULE_README = [
  'Schedule delivers one-shot, fixed-rate, daily, weekly, and cron wall-clock reminders as',
  'follow-up messages in their original Session. Tasks remain available after Host restart.',
  'The shipped Web composition carries no `schedule` row; enable the optional experimental bundle',
  '`@deepseek-ai/dsh-experimental-schedule-bundle` from the Plugins page.',
  'The Agent receives `schedule_create`, `schedule_list`, `schedule_delete`, and `schedule_update`.',
  'ScheduleService owns one version-1 `schedule` domain and one Host timer.',
].join('\n');

test('T157: every documented claim is satisfied by the README text it names', () => {
  const out = NR.report([
    { name: 'dsh-goal-round-driver', version: '0.2.0-rc.2', readme: DRIVER_README },
    { name: 'dsh-schedule', version: '0.2.0-rc.2', readme: SCHEDULE_README },
  ]);
  assert.equal(out.allSatisfied, true, JSON.stringify(out.packages, null, 2));
  const driver = out.packages[0];
  assert.equal(driver.total, 5);
  assert.equal(driver.satisfied, 5);
  assert.match(out.digest, /^[0-9a-f]{64}$/);
});

test('T157: a README that stops saying "disarmed" flips the probe red', () => {
  const mutated = DRIVER_README.replace(
    /Mounting the driver over an existing agent never arms a goal, and after session resume or fork\s*\n?\s*an active goal stays disarmed until an explicit human-authorized resume\./,
    '');
  const out = NR.report([{ name: 'dsh-goal-round-driver', version: '9.9.9', readme: mutated }]);
  assert.equal(out.allSatisfied, false);
  const failing = out.packages[0].checks.filter((c) => !c.ok).map((c) => c.id);
  assert.ok(failing.includes('armed') || failing.includes('no_auto_arm'),
    'the disarm claim is load-bearing: ' + failing.join(','));
});

test('T157: an unknown package is reported as unknown, not as satisfied', () => {
  const out = NR.verifyDocClaims({ name: 'dsh-jobs-local', version: '0.2.0-rc.2', readme: 'x' });
  assert.equal(out.known, false);
  assert.equal(out.total, 0);
  assert.equal(NR.report([{ name: 'dsh-jobs-local', version: '1', readme: 'x' }]).allSatisfied, true,
    'unknown packages do not fail the report, but they contribute no claims');
});

test('T157: the committed 3-round plan validates and names its acceptance checks', () => {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
  // The shipped plan is unapproved, so the validator must refuse it -- and a filled copy must pass.
  const filled = path.join(mkdtempSync(path.join(tmpdir(), 't157-fill-')), 'plan.json');
  writeFileSync(filled, JSON.stringify({ ...plan, approvedBy: 'operator' }), 'utf8');
  const out = execFileSync(process.execPath, [CLI, filled], { encoding: 'utf8' });
  assert.match(out, /DIGEST\s+[0-9a-f]{64}/);
  assert.match(out, /T157-A, T157-B, T157-C/);
  assert.equal(plan.maxRounds, 3);
  assert.equal(plan.tasks.length, 3);
  for (const task of plan.tasks) {
    assert.ok(task.acceptance.length > 20, task.id + ' has a checkable acceptance');
    assert.equal(task.scope, 'repo:agent-relay');
  }
  assert.equal(plan.approvedBy, '', 'the plan ships unapproved on purpose');
});

test('T157: the plan is refused until the operator fills approvedBy', () => {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
  const dir = mkdtempSync(path.join(tmpdir(), 't157-'));
  const file = path.join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify(plan), 'utf8');
  let code = 0;
  try { execFileSync(process.execPath, [CLI, file], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (error) { code = error.status; }
  assert.equal(code, 2, 'shipping an unapproved plan must not look like success');
});

test('T157: the profile draft is additive, names the exact bundle, and carries rollback', () => {
  const draft = readFileSync(DRAFT, 'utf8');
  assert.match(draft, /NOT APPLIED/);
  assert.match(draft, /@deepseek-ai\/dsh-experimental-schedule-bundle/);
  assert.match(draft, /- insert:/);
  assert.equal(/- disable:/.test(draft), false, 'nothing existing is disabled or overridden');
  assert.match(draft, /rollback/i);
  assert.match(draft, /stays disarmed until an explicit human-authorized resume/,
    'the draft repeats the disarm limit instead of promising unattended continuation');
  // One insert entry, no config overrides of existing rows.
  assert.equal((draft.match(/^\s*name: /gm) || []).length, 1);
});
