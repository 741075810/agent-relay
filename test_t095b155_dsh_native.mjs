// T095B155: what the *product* already provides for unattended multi-round work, and a handoff
// builder for the operator. Red first.
//
// Findings this file encodes (read-only, from the installed runtime manifest):
//   * `@deepseek-ai/dsh-goal`, `dsh-goal-round-driver`, `dsh-tool-goal`, `dsh-command-goal` --
//     persisted goal + automatic continuation rounds, i.e. the same native session keeps working
//     without any page in front. The `create_goal`/`update_goal` tools this session has are that
//     package's tool surface.
//   * `@deepseek-ai/dsh-jobs`, `dsh-jobs-local`, `dsh-tool-jobs`, `dsh-api-job-controller` -- a
//     local job facility.
//   * `@deepseek-ai/dsh-schedule`, `dsh-experimental-schedule-bundle`, `dsh-client-ui-schedule` --
//     timer-driven work.
//   * `@deepseek-ai/dsh-session-persistence-jsonl`, `dsh-session-query-sqlite`,
//     `dsh-session-checkpoint-policy`, `dsh-api-session-controller` -- session persistence,
//     querying and resumption.
//
// What is still missing is narrower than "no continuation exists": there is no supported
// *event hook* that turns a task completion into a new goal round, and after a restart a goal is
// disarmed until someone resumes it. Those two are the remaining product gaps, and this module
// reports them as gaps instead of papering over them.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.T155_DIR || path.join(HERE, 'tools', 'continuation');
const N = await import(pathToFileURL(path.join(DIR, 'dsh_native.mjs')).href
  + '?r=t155' + Math.random().toString(36).slice(2));

const MANIFEST = '/opt/dsh/desktop-runtime.json';

function manifestText(names) {
  return JSON.stringify({ packages: names.map((name) => ({ name, version: '0.2.0-rc.2' })) });
}

const FULL = [
  '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-goal-round-driver', '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-schedule', '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-query-sqlite', '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-mcp-client',
];

const PLAN = {
  objective: 'Ship the continuation handoff for agent-relay without touching production.',
  maxRounds: 12,
  approvedBy: 'operator',
  approvedAt: 1793450000000,
  tasks: [
    { id: 't1', scope: 'repo:agent-relay', title: 'probe', acceptance: 'probe reports gaps' },
    { id: 't2', scope: 'repo:agent-relay', title: 'handoff', acceptance: 'goal text emitted' },
  ],
};

test('T155: the shipped manifest yields a capability matrix, not a yes/no guess', () => {
  const caps = N.capabilities(N.parseManifest(manifestText(FULL)));
  assert.equal(caps.goal.present, true);
  assert.equal(caps.goalRounds.present, true);
  assert.equal(caps.jobs.present, true);
  assert.equal(caps.schedule.present, true);
  assert.equal(caps.sessionPersistence.present, true);
  assert.equal(caps.sessionQuery.present, true);
  assert.equal(caps.sessionController.present, true);
  assert.equal(caps.mcpClient.present, true);
  assert.equal(caps.mcpClient.toolAllowlist, false,
    'the MCP client has no per-tool filter -- T153 finding, kept visible here');
});

test('T155: a stripped manifest reports what is absent instead of assuming it', () => {
  const caps = N.capabilities(N.parseManifest(manifestText(['@deepseek-ai/dsh-goal'])));
  assert.equal(caps.goal.present, true);
  assert.equal(caps.jobs.present, false);
  assert.equal(caps.schedule.present, false);
  assert.equal(caps.sessionController.present, false);
  assert.equal(caps.goalRounds.present, false);
});

test('T155: enabled is derived from the profile bundles and the live tool set', () => {
  const manifest = N.parseManifest(manifestText(FULL));
  const verdict = N.continuationVerdict({
    manifest,
    profileBundles: ['@deepseek-ai/dsh-base', 'dsh-advisor'],
    toolNames: ['create_goal', 'update_goal', 'get_goal'],
  });
  assert.equal(verdict.enabled.goal, true, 'the goal tools are in this session');
  assert.equal(verdict.enabled.goalRounds, true, 'rounds are what the round driver does');
  assert.equal(verdict.enabled.jobs, false, 'no jobs tool in this session');
  assert.equal(verdict.enabled.schedule, false);
  assert.deepEqual(verdict.supported.sort(), ['goal', 'goalRounds', 'jobs', 'mcpClient',
    'schedule', 'sessionController', 'sessionPersistence', 'sessionQuery']);
});

test('T155: the two real gaps are named, not smoothed over', () => {
  const verdict = N.continuationVerdict({ manifest: N.parseManifest(manifestText(FULL)),
    profileBundles: [], toolNames: ['create_goal'] });
  assert.deepEqual(verdict.gaps.map((g) => g.code).sort(),
    ['no_event_hook', 'no_unattended_resume']);
  const hook = verdict.gaps.find((g) => g.code === 'no_event_hook');
  assert.match(hook.why, /completion/);
  assert.match(hook.shortestPath, /goal|schedule/);
  const resume = verdict.gaps.find((g) => g.code === 'no_unattended_resume');
  assert.match(resume.why, /disarm|resume/);
});

test('T155: the handoff builder emits goal text for the fixed session and nothing else', () => {
  const out = N.buildGoalHandoff(PLAN, { sessionId: 'session-11111111-2222-4333-8444-555555555555',
    now: 1793450000000 });
  assert.equal(out.code, null);
  assert.match(out.objective, /Ship the continuation handoff/);
  assert.match(out.objective, /repo:agent-relay/);
  assert.equal(out.tasks.length, 2);
  assert.match(out.checklist.join('\n'), /create_goal/);
  assert.match(out.checklist.join('\n'), /update_goal/);
  assert.equal(/submit_task|autoApprove|daemon|unattended|--yes/i.test(out.objective), false,
    'the handoff never asks for a submit tool, auto-approval, a daemon or an unattended run');
  assert.equal(out.planDigest.length, 64, 'a digest pins which plan was approved');
});

test('T155: an incomplete or unapproved plan is refused with a code', () => {
  const cases = [
    [{ ...PLAN, objective: '' }, 'objective_missing'],
    [{ ...PLAN, approvedBy: '' }, 'not_approved'],
    [{ ...PLAN, tasks: [] }, 'tasks_missing'],
    [{ ...PLAN, tasks: [{ id: 't1', scope: 'repo:agent-relay', title: 'x' }] },
      'acceptance_missing'],
    [{ ...PLAN, tasks: [{ id: 't1', title: 'x', acceptance: 'y' }] }, 'scope_missing'],
  ];
  for (const [plan, code] of cases) {
    assert.equal(N.buildGoalHandoff(plan, { sessionId: 's', now: 1 }).code, code);
  }
});

test('T155: an expired approval is refused, and the reason says which clock decided', () => {
  const plan = { ...PLAN, expiresAt: 1793450000000 };
  assert.equal(N.buildGoalHandoff(plan, { sessionId: 's', now: 1793450000001 }).code,
    'approval_expired');
  assert.equal(N.buildGoalHandoff(plan, { sessionId: 's', now: 1793449999999 }).code, null);
});

test('T155: task order and count are preserved exactly, with no implicit continuation', () => {
  const out = N.buildGoalHandoff(PLAN, { sessionId: 's', now: 1793450000000 });
  assert.deepEqual(out.tasks.map((t) => t.id), ['t1', 't2']);
  assert.equal(out.maxRounds, 12);
  assert.match(out.stopConditions.join(' '), /round/i);
  assert.equal(out.autoContinuesAcrossRestart, false,
    'a restart disarms the goal; the handoff says so rather than implying otherwise');
});

test('T155: a missing runtime manifest is unavailable, never an empty capability set', () => {
  const probe = N.probeRuntime({ manifestPath: MANIFEST, readFile: () => { throw new Error('ENOENT'); },
    profileBundles: [], toolNames: [] });
  assert.equal(probe.state, 'unavailable');
  assert.equal(probe.code, 'manifest_unreadable');
  assert.equal(probe.capabilities, null);
});
