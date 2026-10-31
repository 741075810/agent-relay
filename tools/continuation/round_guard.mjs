// T095B158: the two things an unattended round needs and cannot get from prose -- a ledger that
// survives the round, and stop conditions that a program evaluates.
//
// Scope note: this is audit and decision only. It does not create, resume, arm or steer a goal, it
// does not call the harness, and it cannot start a round. A round is driven by `dsh-goal-round-driver`
// on agent idle; what is missing when nobody is watching is a durable record of what each round did
// and a mechanical answer to "may another round start".

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const STOP = {
  DONE: 'done',
  CONTINUE: 'continue',
  BLOCKED: 'blocked',
  STOP_AND_REPORT: 'stop_and_report',
};

const TERMINAL = new Set(['pass', 'fail', 'skip']);

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Append-only ledger. One record per round id; a replay is a no-op, not a second row. */
export function createLedger(file) {
  const read = () => {
    if (!existsSync(file)) return [];
    const text = readFileSync(file, 'utf8').trim();
    if (text.length === 0) return [];
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  return {
    file,
    records: read,
    has(roundId) {
      return read().some((row) => row.roundId === roundId);
    },
    append(entry) {
      const problem = validateEntry(entry);
      if (problem) return { code: problem };
      const existing = read();
      if (existing.some((row) => row.roundId === entry.roundId)) {
        return { code: 'duplicate', roundId: entry.roundId, count: existing.length };
      }
      const row = {
        roundId: entry.roundId,
        at: Number.isFinite(entry.at) ? entry.at : Date.now(),
        taskId: entry.taskId,
        planDigest: entry.planDigest,
        gates: entry.gates.map((gate) => ({ name: gate.name, result: gate.result })),
        outcome: entry.outcome,
        recordDigest: digest([entry.roundId, entry.taskId, entry.planDigest, entry.gates,
          entry.outcome]),
      };
      writeFileSync(file, JSON.stringify(row) + '\n', { flag: 'a' });
      return { code: null, row, count: existing.length + 1 };
    },
  };
}

export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'entry_missing';
  if (typeof entry.roundId !== 'string' || entry.roundId.length === 0) return 'round_id_missing';
  if (typeof entry.taskId !== 'string' || entry.taskId.length === 0) return 'task_id_missing';
  if (typeof entry.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.planDigest)) {
    return 'plan_digest_invalid';
  }
  if (!Array.isArray(entry.gates) || entry.gates.length === 0) return 'gates_missing';
  for (const gate of entry.gates) {
    if (!gate || typeof gate.name !== 'string' || !gate.name) return 'gate_name_missing';
    if (!TERMINAL.has(gate.result)) return 'gate_result_invalid';
  }
  if (![STOP.DONE, STOP.CONTINUE, STOP.BLOCKED, STOP.STOP_AND_REPORT].includes(entry.outcome)) {
    return 'outcome_invalid';
  }
  return null;
}

/**
 * Decide whether another round may start. Inputs are the plan, the ledger records and the task ids
 * that have been finished. Everything is explicit: no state is inferred from "it looked fine".
 */
export function evaluateStop({ plan, records, finishedTaskIds = [], maxRounds }) {
  const tasks = Array.isArray(plan && plan.tasks) ? plan.tasks : [];
  const cap = Number.isSafeInteger(maxRounds) ? maxRounds
    : (Number.isSafeInteger(plan && plan.maxRounds) ? plan.maxRounds : 0);
  const rows = Array.isArray(records) ? records : [];

  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.outcome === STOP.STOP_AND_REPORT) {
      return { code: STOP.STOP_AND_REPORT, why: 'the last round reported a scope stop',
        round: last.roundId, taskId: last.taskId };
    }
    // Same gate red twice in a row for the same reason is the runbook's "blocked", not a retry.
    const failing = (row) => row.gates.filter((gate) => gate.result === 'fail')
      .map((gate) => gate.name).sort().join(',');
    if (rows.length >= 2) {
      const previous = rows[rows.length - 2];
      const now = failing(last);
      // An empty failure list equals another empty one; without the length guard, two clean rounds
      // would "block" on nothing at all.
      if (now.length > 0 && now === failing(previous)) {
        return { code: STOP.BLOCKED, why: 'the same gate failed twice in a row: ' + now,
          round: last.roundId, gate: now };
      }
    }
  }

  const scope = new Set(tasks.map((task) => task.id));
  for (const row of rows) {
    if (!scope.has(row.taskId)) {
      return { code: STOP.STOP_AND_REPORT, why: 'round ' + row.roundId + ' worked outside the plan',
        round: row.roundId, taskId: row.taskId };
    }
  }

  const done = new Set(finishedTaskIds);
  for (const row of rows) {
    if (row.outcome === STOP.DONE) done.add(row.taskId);
  }
  const remaining = tasks.filter((task) => !done.has(task.id)).map((task) => task.id);
  if (tasks.length > 0 && remaining.length === 0) {
    return { code: STOP.DONE, why: 'every approved task is finished', remaining };
  }
  if (cap > 0 && rows.length >= cap) {
    return { code: STOP.BLOCKED, why: 'round cap reached (' + cap + ')', round: rows.length };
  }
  return { code: STOP.CONTINUE, why: remaining.length === 0 ? 'no tasks are listed'
    : 'next task is ' + remaining[0], remaining };
}
