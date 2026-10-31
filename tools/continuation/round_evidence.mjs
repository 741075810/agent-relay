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
  const raw = typeof text === "string" ? text : "";
  const lines = raw.split(/\r?\n/);
  const records = [];
  const invalid = [];
  const unparsable = [];
  let torn = null;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const item = { lineIndex: index, length: trimmed.length,
        reason: String(error && error.message ? error.message : error) };
      if (index === lines.length - 1) torn = item;
      else unparsable.push(item);
      return;
    }
    // A line can parse and still not be a round: `null`, a number, a string or an array. Those are
    // dropped with a reason instead of reaching openRounds/buildEvidence as objects with no fields.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      invalid.push({ lineIndex: index, reason: 'non_object_json_line',
        parsedType: parsed === null ? 'null' : typeof parsed, isArray: Array.isArray(parsed) });
      return;
    }
    records.push(parsed);
  });
  return { records, torn, invalid, unparsable };
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
  const all = Array.isArray(records) ? records : [];
  // Garbage that slipped into the input must not become a round with undefined fields.
  const rows = all.filter((row) => row && typeof row === "object" && !Array.isArray(row));
  const invalid = all.length - rows.length;
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

  // `complete` is the claim a reader trusts without re-deriving it, so it is derived from problems
  // rather than from the absence of visible ones: an out-of-plan round, a round with no record digest,
  // a duplicated round id or any open round all keep the run open (round C's audit).
  const problems = [];
  const seen = new Set();
  for (const row of rows) {
    const roundId = row.roundId;
    if (seen.has(roundId)) {
      if (!problems.includes('duplicate_round:' + roundId)) problems.push('duplicate_round:' + roundId);
    }
    seen.add(roundId);
    if (!tasks.has(row.taskId)) problems.push('out_of_plan:' + roundId + ':' + row.taskId);
    if (typeof row.recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(row.recordDigest)) {
      problems.push('missing_record_digest:' + roundId);
    }
  }
  for (const item of open) problems.push('open_round:' + item.roundId);
  if (rows.length === 0) problems.push('no_rounds');

  return {
    version: 1,
    planDigest: planDigestOf(plan),
    commit: commit ?? null,
    gates: Array.isArray(gates) ? gates : [],
    rounds,
    invalid,
    open,
    problems,
    complete: problems.length === 0,
    evidenceDigest: digest([commit ?? null,
      rounds.map((r) => [r.roundId, r.taskId, r.outcome, r.recordDigest])]),
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
  if (Array.isArray(bundle.problems) && bundle.problems.length > 0) {
    lines.push('Problems: ' + bundle.problems.join(', '));
  }
  if (Number.isInteger(bundle.invalid) && bundle.invalid > 0) {
    lines.push('Invalid lines: ' + bundle.invalid + ' (not rounds)');
  }
  lines.push('Complete: ' + bundle.complete);
  return lines.join('\n') + '\n';
}

export function readLedgerFile(file) {
  return recoverTail(readFileSync(file, 'utf8'));
}
