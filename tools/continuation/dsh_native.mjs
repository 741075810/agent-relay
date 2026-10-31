// T095B155: the native continuation surface that actually exists, and a handoff builder.
//
// Two things live here, both offline and both default-off:
//
//   1. `probeRuntime` / `capabilities` / `continuationVerdict` -- a read-only reading of the shipped
//      runtime manifest plus the live profile bundles and tool names. It answers "which continuation
//      capabilities are installed, which are actually enabled, and which two gaps remain" without
//      touching the harness, the extension or any page.
//   2. `buildGoalHandoff` -- turns a pre-approved plan into the goal text an operator can paste for
//      the fixed native session. It submits nothing: the goal tooling is what continues rounds, and
//      it is the operator who arms it.
//
// The measured product surface (from `desktop-runtime.json`, 287 `@deepseek-ai/*` packages):
//
//   goal            dsh-goal, dsh-goal-round-driver, dsh-tool-goal, dsh-command-goal
//   jobs            dsh-jobs, dsh-jobs-local, dsh-tool-jobs, dsh-api-job-controller
//   schedule        dsh-schedule, dsh-experimental-schedule-bundle, dsh-client-ui-schedule
//   session         dsh-session-persistence-jsonl, dsh-session-query-sqlite,
//                   dsh-session-checkpoint-policy, dsh-api-session-controller
//   workflow        dsh-workflow, dsh-tool-workflow, dsh-workflow-ptc
//   mcp             dsh-mcp-client (0.2.0-rc.2, no per-tool allowlist -- see T153)
//
// Remaining gaps, which this module reports rather than hides:
//   * `no_event_hook` -- nothing supported turns "task X completed" into a new goal round; the
//     Bridge/extension event path is page-side, and the host has no supported trigger;
//   * `no_unattended_resume` -- a persisted goal is disarmed after a session resume/restart and is
//     re-armed only by an explicit `update_goal resume`.

import { createHash } from 'node:crypto';

const CAPABILITY_PACKAGES = {
  goal: ['@deepseek-ai/dsh-goal'],
  goalRounds: ['@deepseek-ai/dsh-goal-round-driver'],
  goalTools: ['@deepseek-ai/dsh-tool-goal'],
  jobs: ['@deepseek-ai/dsh-jobs', '@deepseek-ai/dsh-jobs-local'],
  schedule: ['@deepseek-ai/dsh-schedule'],
  workflow: ['@deepseek-ai/dsh-workflow'],
  sessionPersistence: ['@deepseek-ai/dsh-session-persistence-jsonl'],
  sessionQuery: ['@deepseek-ai/dsh-session-query-sqlite'],
  sessionController: ['@deepseek-ai/dsh-api-session-controller'],
  mcpClient: ['@deepseek-ai/dsh-mcp-client'],
};

/** Extract package names from a runtime manifest. Accepts the shipped shape and a plain name list. */
export function parseManifest(text) {
  const names = new Set();
  const raw = typeof text === 'string' ? text : JSON.stringify(text ?? {});
  for (const match of raw.matchAll(/"(@deepseek-ai\/[a-z0-9-]+)"/g)) names.add(match[1]);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const walk = (value) => {
    if (typeof value === 'string' && value.startsWith('@deepseek-ai/')) names.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(parsed);
  return { version: 1, packages: [...names].sort(), count: names.size };
}

export function capabilities(manifest) {
  const present = new Set(manifest && Array.isArray(manifest.packages) ? manifest.packages : []);
  const out = {};
  for (const [key, names] of Object.entries(CAPABILITY_PACKAGES)) {
    const found = names.filter((name) => present.has(name));
    out[key] = { present: found.length === names.length, packages: found,
      missing: names.filter((name) => !present.has(name)) };
  }
  // The MCP client's lack of a per-tool filter is a measured property, not a guess (T153).
  out.mcpClient.toolAllowlist = false;
  out.mcpClient.note = 'whole server tool set is registered as mcp__<serverName>__<tool>';
  return out;
}

export function continuationVerdict({ manifest, profileBundles = [], toolNames = [] }) {
  const caps = capabilities(manifest);
  const tools = new Set(toolNames);
  const bundles = new Set(profileBundles);
  const enabled = {
    goal: caps.goalTools.present && ['create_goal', 'update_goal', 'get_goal']
      .some((name) => tools.has(name)),
    goalRounds: caps.goalRounds.present && tools.has('update_goal'),
    jobs: caps.jobs.present && (tools.has('jobs') || [...tools].some((n) => /^job_/.test(n))
      || bundles.has('@deepseek-ai/dsh-jobs')),
    schedule: caps.schedule.present && (bundles.has('@deepseek-ai/dsh-schedule')
      || [...tools].some((n) => /^schedule_/.test(n))),
    workflow: caps.workflow.present && tools.has('workflow'),
  };
  // `goalTools` is a detail of `goal`, not a separate capability, so it stays out of this list.
  const supported = Object.entries(caps).filter(([key, value]) => value.present && key !== 'goalTools')
    .map(([key]) => key).sort();
  const gaps = [
    { code: 'no_event_hook',
      why: 'nothing supported turns a task completion into a new goal round: the event sources this '
        + 'project can see are page-side, and the host exposes no documented completion trigger',
      shortestPath: 'approved plan + goal rounds driven by hand, or a product-side event hook that '
        + 'starts a goal round on completion' },
    { code: 'no_unattended_resume',
      why: 'a persisted goal is disarmed after a session resume or app restart and re-armed only by '
        + 'an explicit update_goal resume, so restarts need a human or an agent that is already running',
      shortestPath: 'a supported resume-on-start policy, or an operator action after each restart' },
  ];
  return { supported, enabled, gaps, capabilities: caps,
    autoContinuesWithoutHuman: enabled.goal === true && enabled.goalRounds === true };
}

/** Read-only probe. `readFile` is injected so tests never touch the operator's install. */
export function probeRuntime({ manifestPath, readFile, profileBundles = [], toolNames = [] }) {
  let text;
  try {
    text = readFile(manifestPath);
  } catch (error) {
    return { state: 'unavailable', code: 'manifest_unreadable', capabilities: null,
      reason: String(error && error.message ? error.message : error), manifestPath };
  }
  if (typeof text !== 'string' || text.length === 0) {
    return { state: 'unavailable', code: 'manifest_empty', capabilities: null, manifestPath };
  }
  const manifest = parseManifest(text);
  if (manifest.count === 0) {
    return { state: 'unavailable', code: 'manifest_without_packages', capabilities: null,
      manifestPath };
  }
  const verdict = continuationVerdict({ manifest, profileBundles, toolNames });
  return { state: 'read_only', code: null, manifestPath, packageCount: manifest.count,
    ...verdict };
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Build the handoff an operator pastes for the fixed session. It refuses an incomplete or unapproved
 * plan, and it never asks the harness to submit, schedule or dispatch anything by itself.
 */
export function buildGoalHandoff(plan, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
  if (!plan || typeof plan !== 'object') return { code: 'plan_missing' };
  if (typeof plan.objective !== 'string' || plan.objective.trim().length === 0) {
    return { code: 'objective_missing' };
  }
  if (typeof plan.approvedBy !== 'string' || plan.approvedBy.trim().length === 0) {
    return { code: 'not_approved' };
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return { code: 'tasks_missing' };
  for (const task of plan.tasks) {
    if (!task || typeof task.id !== 'string' || !task.id) return { code: 'task_id_missing' };
    if (typeof task.scope !== 'string' || !task.scope) return { code: 'scope_missing' };
    if (typeof task.acceptance !== 'string' || !task.acceptance) return { code: 'acceptance_missing' };
  }
  if (Number.isFinite(plan.expiresAt) && now > plan.expiresAt) return { code: 'approval_expired' };

  const scopes = [...new Set(plan.tasks.map((task) => task.scope))];
  const list = plan.tasks.map((task, index) => `${index + 1}. [${task.id}] ${task.title || task.id}`
    + ` — scope ${task.scope}; done when: ${task.acceptance}`).join('\n');
  const objective = [
    plan.objective.trim(),
    '',
    'Scope: ' + scopes.join(', '),
    'Approved by: ' + plan.approvedBy + (Number.isFinite(plan.approvedAt)
      ? ' at ' + new Date(plan.approvedAt).toISOString() : ''),
    sessionId ? 'Fixed session: ' + sessionId : 'Fixed session: this one — do not create another',
    '',
    'Approved task order:',
    list,
    '',
    'Rules: work through the list in order, one task at a time; after each task run the full suite',
    'and the release gate before moving on; stop and report if a task needs a scope outside the',
    'approved list; never submit, schedule or dispatch anything on your own; never send a message',
    'to any page.',
  ].join('\n');

  return {
    code: null,
    objective,
    tasks: plan.tasks.map((task) => ({ id: task.id, scope: task.scope, title: task.title || task.id,
      acceptance: task.acceptance })),
    maxRounds: Number.isSafeInteger(plan.maxRounds) && plan.maxRounds > 0 ? plan.maxRounds : 10,
    checklist: [
      'create_goal with the objective above (objective text is the whole authorisation surface)',
      'work one task per round; update_goal action=edit only to narrow, never to widen scope',
      'after a restart: update_goal action=resume with the same objective, before touching files',
      'when the list is done: update_goal action=complete with the evidence summary',
    ],
    stopConditions: [
      'the approved task list is finished',
      'a task would step outside the approved scopes',
      'the round cap (maxRounds) is reached',
      'a gate or suite is red twice in a row for the same reason',
    ],
    autoContinuesAcrossRestart: false,
    planDigest: digest({ objective: plan.objective, tasks: plan.tasks,
      approvedBy: plan.approvedBy, maxRounds: plan.maxRounds ?? 10 }),
  };
}
