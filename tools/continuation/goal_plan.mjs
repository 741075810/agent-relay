// T095B156: `goal_plan.mjs` -- validate a pre-approved goal plan and emit the exact text an operator
// hands to the fixed native session. It never creates a goal, never submits anything, never starts a
// timer: it is a formatter with a refusal list.
//
//   node tools/continuation/goal_plan.mjs <plan.json> [--json]
//
// Exit codes: 0 accepted, 2 refused (with the reason code), 3 unreadable/invalid JSON.
//
// The plan shape is the one `buildGoalHandoff` accepts:
//   { version, objective, approvedBy, approvedAt?, expiresAt?, maxRounds?,
//     tasks: [{ id, scope, title, acceptance }] }
// Refusals come from `dsh_native.mjs` unchanged; this file adds the operator-facing output and one
// extra check: the emitted text must not ask for a submit tool, auto-approval, a daemon or an
// unattended run. That check is here because a plan is written by hand, and a hand-written plan is
// exactly where "just run it unattended" tends to sneak in.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { buildGoalHandoff } from './dsh_native.mjs';

export const FORBIDDEN = [
  { pattern: /submit_task|submitTask/, why: 'submission is not part of a goal handoff' },
  { pattern: /autoApprove|auto_approve|--yes\b/, why: 'approval is not a goal handoff\'s to grant' },
  { pattern: /\bdaemon\b|systemd|schtasks|startup folder/i, why: 'no background service is started' },
  { pattern: /unattended|no human|without (?:the )?operator/i,
    why: 'a goal run still needs the operator for restart/resume' },
];

export function scanText(text) {
  const hits = [];
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) hits.push({ pattern: String(rule.pattern), why: rule.why });
  }
  return hits;
}

export function buildFromPlan(plan, options = {}) {
  const handoff = buildGoalHandoff(plan, options);
  if (handoff.code !== null) return { ...handoff, exitCode: 2 };
  const hits = scanText(handoff.objective);
  if (hits.length > 0) {
    return { code: 'plan_asks_for_automation', hits, exitCode: 2 };
  }
  return { ...handoff, hits: [], exitCode: 0 };
}

function main(argv) {
  const file = argv[2];
  const asJson = argv.includes('--json');
  if (!file) {
    console.error('usage: node tools/continuation/goal_plan.mjs <plan.json> [--json]');
    return 3;
  }
  let plan;
  try {
    // Windows editors and PowerShell's `Set-Content -Encoding utf8` write a BOM; JSON.parse rejects
    // it. Stripping one leading BOM is harmless and keeps the refusal list about plans, not encodings.
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    plan = JSON.parse(text);
  } catch (error) {
    console.error(JSON.stringify({ code: 'plan_unreadable',
      reason: String(error && error.message ? error.message : error) }));
    return 3;
  }
  const out = buildFromPlan(plan, { sessionId: 'fixed:this-session', now: Date.now() });
  if (asJson) {
    console.log(JSON.stringify({ code: out.code, planDigest: out.planDigest,
      maxRounds: out.maxRounds, taskIds: (out.tasks || []).map((t) => t.id),
      hits: out.hits || [], exitCode: out.exitCode }, null, 2));
  } else if (out.code === null) {
    console.log('DIGEST  ' + out.planDigest);
    console.log('ROUNDS  ' + out.maxRounds);
    console.log('TASKS   ' + out.tasks.map((t) => t.id).join(', '));
    console.log('');
    console.log('--- objective (paste into create_goal) ---');
    console.log(out.objective);
    console.log('');
    console.log('--- per-round checklist ---');
    out.checklist.forEach((line, i) => console.log('  ' + (i + 1) + '. ' + line));
    console.log('');
    console.log('--- stop conditions ---');
    out.stopConditions.forEach((line) => console.log('  - ' + line));
  } else {
    console.error('REFUSED ' + out.code + (out.hits
      ? ' -> ' + out.hits.map((h) => h.pattern + ': ' + h.why).join('; ') : ''));
  }
  return out.exitCode;
}

// exact basename, not a suffix: `test_..._goal_plan.mjs` also ends with 'goal_plan.mjs'
if (process.argv[1] && basename(process.argv[1]) === 'goal_plan.mjs') {
  process.exit(main(process.argv));
}
