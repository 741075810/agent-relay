// T095B159: surviving and reviewing a real goal round run -- the three gaps round_guard.mjs leaves.
//
//   recoverTail    a round killed mid-write leaves a partial last line; the next reader must drop it
//                  and say so, instead of throwing or silently pretending the round never happened
//   openRounds     rounds whose work did not close; a resumed run must see them before starting new ones
//   planDigestOf   the digest `goal_plan.mjs` prints, recomputed from the plan file, so a plan edited
//   verifyPlanBinding  mid-run is caught as drift instead of silently re-authorising the new text
//   buildEvidence  one reviewable record per round: task, outcome, gates, record digest, commit
//
// Nothing here creates, arms, resumes or steers a goal, and nothing reads production state: every
// function takes its input as an argument.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function recoverTail(text) {
  const raw = typeof text === 'string' ? text : '';
  const lines = raw.split('\n');
  const records = [];
  let torn = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      torn = { lineIndex: index, length: trimmed.length,
        reason: String(error && error.message ? error.message : error) };
    }
  });
  return { records, torn: torn && torn.lineIndex === lines.length - 1 ? torn : null,
    unparsable: torn && torn.lineIndex === lines.length - 1 ? [] : [torn].filter(Boolean) };
}

/** A round is open when it has no terminal outcome, or its outcome is `continue` for its task. */
export function openRounds(records, { terminalOutcomes = ['done', 'blocked', 'stop_and_report'] } = {}) {
  const terminal = new Set(terminalOutcomes);
  const open = [];
  const closedTasks = new Set();
  for (const row of Array.isArray(records) ? records : []) {
    const outcome = row && row.outcome;
    if (terminal.has(outcome)) closedTasks.add(row.taskId);
  }
  for (const row of Array.isArray(records) ? records : []) {
    if (!row || typeof row !== 'object') continue;
    if (!row.outcome) open.push({ roundId: row.roundId, taskId: row.taskId, why: 'no_outcome' });
    else if (!terminal.has(row.outcome) && !closedTasks.has(row.taskId)) {
      open.push({ roundId: row.roundId, taskId: row.taskId, why: 'outcome_' + row.outcome });
    }
  }
  return open;
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Same formula as buildGoalHandoff, so the two never disagree about "the approved plan". */
export function planDigestOf(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return digest({ objective: plan.objective, tasks: plan.tasks,
    approvedBy: plan.approvedBy, maxRounds: plan.maxRounds ?? 10 });
}

export function verifyPlanBinding({ records, plan }) {
  const expected = planDigestOf(plan);
  if (expected === null) return { code: 'plan_missing' };
  const rows = Array.isArray(records) ? records : [];
  if (rows.length === 0) return { code: 'ok', planDigest: expected, checked: 0 };
  const drifted = rows.filter((row) => row.planDigest !== expected)
    .map((row) => ({ roundId: row.roundId, recorded: row.planDigest }));
  if (drifted.length > 0) {
    return { code: 'plan_drift', planDigest: expected, checked: rows.length, drifted };
  }
  return { code: 'ok', planDigest: expected, checked: rows.length, drifted: [] };
}

export function buildEvidence({ plan, records, commit, gates = [] }) {
  const tasks = new Map((plan && Array.isArray(plan.tasks) ? plan.tasks : [])
    .map((task) => [task.id, task]));
  const rows = Array.isArray(records) ? records : [];
  const rounds = rows.map((row) => ({
    roundId: row.roundId,
    taskId: row.taskId,
    outcome: row.outcome || null,
    knownTask: tasks.has(row.taskId),
    acceptance: tasks.get(row.taskId) ? tasks.get(row.taskId).acceptance ?? null : null,
    gates: Array.isArray(row.gates) ? row.gates : [],
    recordDigest: row.recordDigest ?? null,
    commit: commit ?? null,
  }));
  const open = openRounds(rows);
  return {
    version: 1,
    planDigest: planDigestOf(plan),
    commit: commit ?? null,
    gates: Array.isArray(gates) ? gates : [],
    rounds,
    open,
    complete: rounds.length > 0 && open.length === 0
      && rounds.every((round) => round.outcome === 'done'),
    evidenceDigest: digest(rounds.map((r) => [r.roundId, r.taskId, r.outcome, r.recordDigest])),
  };
}

export function renderEvidenceMarkdown(bundle) {
  const lines = ['# Round evidence', '',
    '| Round | Task | Outcome | Gates | Commit |',
    '|---|---|---|---|---|'];
  for (const round of bundle.rounds) {
    const gates = round.gates.map((gate) => gate.name + '=' + gate.result).join(' ');
    lines.push('| ' + [round.roundId, round.taskId, round.outcome || '(open)', gates || '-',
      round.commit ? round.commit.slice(0, 7) : '-'].join(' | ') + ' |');
  }
  lines.push('', 'Plan digest: `' + (bundle.planDigest || 'none') + '`');
  lines.push('Open rounds: ' + (bundle.open.length === 0 ? 'none'
    : bundle.open.map((o) => o.roundId + '(' + o.why + ')').join(', ')));
  lines.push('Complete: ' + bundle.complete);
  return lines.join('\n') + '\n';
}

export function readLedgerFile(file) {
  return recoverTail(readFileSync(file, 'utf8'));
}
