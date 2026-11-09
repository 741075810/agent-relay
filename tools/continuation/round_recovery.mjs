// T095B161 round 2: what to do after a restart, decided from artefacts instead of from memory.
//
// A run that comes back after a restart or a kill has four things to reconcile: how far the goal got
// (`roundsStarted`, `revision`), whether the goal is still armed, whether the ledger's last line was cut
// off, and whether any round is still open. The dangerous state is not "damaged ledger" -- it is
// "healthy-looking ledger with an unfinished round", because the next round then overlaps work that was
// already half done under a previous approval.
//
// `assessRecovery` returns exactly one decision and the ordered steps that follow from it. It never
// starts a round, never touches a goal, and takes every input as an argument.

import { recoverTail, openRounds, planDigestOf, verifyPlanBinding } from './round_evidence.mjs';

export const DECISION = {
  RESUME_OK: 'resume_ok',
  FINISH_OPEN_FIRST: 'finish_open_round_first',
  DISCARD_TAIL: 'discard_tail',
  NEEDS_HUMAN_RESUME: 'needs_human_resume',
  PLAN_CHANGED: 'plan_changed',
  REVISION_DRIFT: 'revision_drift',
  NOTHING_TO_DO: 'nothing_to_do',
  BLOCKED: 'blocked',
};

const STEPS = {
  [DECISION.RESUME_OK]: [
    'verify the plan digest still matches the approved plan',
    'let the driver start the next round; do not start one by hand',
  ],
  [DECISION.FINISH_OPEN_FIRST]: [
    'record how the open round ended (done or stop_and_report) before any new work',
    'if the round cannot be reconstructed, mark it stop_and_report with the reason instead of guessing',
    'only then allow the next round',
  ],
  [DECISION.DISCARD_TAIL]: [
    'drop the torn last line; keep every complete round ahead of it',
    're-check for open rounds after the drop',
    'record the torn line index in the run log so the loss is visible',
  ],
  [DECISION.NEEDS_HUMAN_RESUME]: [
    'stop: a disarmed goal does not continue on its own',
    'ask for an explicit update_goal action=resume with the current revision',
    'do not create a second goal for the same work',
  ],
  [DECISION.PLAN_CHANGED]: [
    'stop the run; the rounds were approved against a different plan text',
    're-approve the plan and record the new digest before continuing',
  ],
  [DECISION.REVISION_DRIFT]: [
    'stop: a round claims a goal revision the current goal has already moved past',
    'read get_goal, compare roundsStarted, and report the gap instead of re-running the round',
  ],
  [DECISION.NOTHING_TO_DO]: ['report the finished run; no further round is warranted'],
  [DECISION.BLOCKED]: [
    'stop and report the blocking condition with its code',
    'do not retry the same failure twice in a row',
  ],
};

/**
 * `tailText` is the raw ledger text, so a torn write is visible. `records` may be passed instead for
 * callers with a complete validated record set. Passing only recoverTail().records loses
 * rejected-line evidence; use tailText when assessing raw ledger integrity.
 */
export function assessRecovery({ goal, tailText, records, plan, planDigest, commits = [] }) {
  if (!goal || typeof goal !== 'object' || !goal.id) return { code: 'goal_missing', steps: [] };
  let rows = Array.isArray(records) ? records : [];
  let torn = null;
  if (typeof tailText === 'string') {
    const tail = recoverTail(tailText);
    rows = tail.records;
    torn = tail.torn;
    // Valid survivors are not a complete ledger when other lines were rejected.
    // Block before completion/torn-tail advice; never suggest deleting evidence
    // to turn an unknown interior round into permission to resume.
    if (tail.invalid.length > 0 || tail.unparsable.length > 0) {
      return { code: DECISION.BLOCKED, why: 'ledger_corrupt', goalId: goal.id,
        steps: ['stop and preserve the entire ledger; do not drop or rewrite rejected lines',
          'reconcile the missing round evidence before any resume or retry'],
        invalidLineIndexes: tail.invalid.map((item) => item.lineIndex),
        unparsableLineIndexes: tail.unparsable.map((item) => item.lineIndex),
        tornLineIndex: torn ? torn.lineIndex : null, keptRounds: rows.length };
    }
  }
  // Without interior corruption, a torn tail precedes even "the goal is complete": completion
  // may have been decided from a view that was missing its last round.
  if (torn) {
    return { code: DECISION.DISCARD_TAIL, steps: STEPS[DECISION.DISCARD_TAIL], goalId: goal.id,
      tornLineIndex: torn.lineIndex, keptRounds: rows.length,
      goalPhase: goal.phase ?? null, recheckCompletion: goal.phase === 'complete' };
  }

  if (goal.phase === 'complete') {
    return { code: DECISION.NOTHING_TO_DO, steps: STEPS[DECISION.NOTHING_TO_DO],
      goalId: goal.id, roundsStarted: goal.roundsStarted ?? null };
  }

  // A row that cannot name the revision it ran under cannot be tied to an approval at all. Reporting it
  // as "no drift" would let an older ledger format bypass every revision check.
  const noRevision = rows.filter((row) => !Number.isSafeInteger(row.revision));
  if (noRevision.length > 0) {
    return { code: DECISION.BLOCKED, steps: STEPS[DECISION.BLOCKED], goalId: goal.id,
      why: 'row_revision_missing:' + noRevision.map((row) => row.roundId).join(',') };
  }

  // A round recorded against a newer revision than the goal now reports means the goal was edited or
  // resumed under the run; the rounds cannot be trusted to be part of the same approval.
  const driftRows = rows.filter((row) => Number.isSafeInteger(row.revision)
    && Number.isSafeInteger(goal.revision) && row.revision > goal.revision);
  if (driftRows.length > 0) {
    return { code: DECISION.REVISION_DRIFT, steps: STEPS[DECISION.REVISION_DRIFT], goalId: goal.id,
      rounds: driftRows.map((row) => row.roundId), goalRevision: goal.revision };
  }

  if (plan !== undefined) {
    const binding = verifyPlanBinding({ records: rows, plan });
    if (binding.code === 'plan_drift') {
      return { code: DECISION.PLAN_CHANGED, steps: STEPS[DECISION.PLAN_CHANGED], goalId: goal.id,
        drifted: binding.drifted };
    }
    if (binding.code === 'plan_missing') {
      return { code: DECISION.BLOCKED, steps: STEPS[DECISION.BLOCKED], goalId: goal.id,
        why: 'plan_missing' };
    }
  }
  if (typeof planDigest === 'string' && rows.some((row) => row.planDigest !== planDigest)) {
    return { code: DECISION.PLAN_CHANGED, steps: STEPS[DECISION.PLAN_CHANGED], goalId: goal.id,
      drifted: rows.filter((row) => row.planDigest !== planDigest).map((row) => row.roundId) };
  }

  const open = openRounds(rows);
  if (open.length > 0) {
    return { code: DECISION.FINISH_OPEN_FIRST, steps: STEPS[DECISION.FINISH_OPEN_FIRST],
      goalId: goal.id, open: open.map((item) => item.roundId + '(' + item.why + ')') };
  }

  if (goal.activation !== 'armed') {
    return { code: DECISION.NEEDS_HUMAN_RESUME, steps: STEPS[DECISION.NEEDS_HUMAN_RESUME],
      goalId: goal.id, why: 'activation=' + String(goal.activation), revision: goal.revision ?? null };
  }

  return { code: DECISION.RESUME_OK, steps: STEPS[DECISION.RESUME_OK], goalId: goal.id,
    roundsStarted: goal.roundsStarted ?? null, ledgerRounds: rows.length,
    planDigest: typeof planDigest === 'string' ? planDigest
      : (plan ? planDigestOf(plan) : null) };
}

export function renderRecoveryMarkdown(decision) {
  const lines = ['# Recovery decision', '', 'Decision: `' + decision.code + '`'];
  if (decision.goalId) lines.push('Goal: `' + decision.goalId + '`');
  if (decision.tornLineIndex !== undefined && decision.tornLineIndex !== null) {
    lines.push('Torn line index: ' + decision.tornLineIndex
      + ' (kept rounds: ' + decision.keptRounds + ')');
  }
  if (Array.isArray(decision.open) && decision.open.length > 0) {
    lines.push('Open rounds: ' + decision.open.join(', '));
  }
  if (Array.isArray(decision.steps) && decision.steps.length > 0) {
    lines.push('', 'Steps:');
    decision.steps.forEach((step, index) => lines.push('  ' + (index + 1) + '. ' + step));
  }
  return lines.join('\n') + '\n';
}
