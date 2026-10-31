// T095B161 round 1: round provenance -- make "this round really came from the goal driver" checkable
// from repository artefacts alone.
//
// The ledger already records what a round did and the goal tool reports how many rounds ran, but
// nothing joins the two. So a commit that says "native goal round N" is a claim, not evidence. This
// module joins them and refuses the joins that cannot be true:
//
//   * a record whose `goalId` differs from the goal being explained;
//   * a record whose `roundsStarted` does not match any observed goal state;
//   * two records claiming the same `roundsStarted` for one goal;
//   * `roundsStarted` going backwards between records (the counter only goes up);
//   * a commit that is not in the supplied git log, or a round with no commit when the round is `done`;
//   * a ledger round whose planDigest differs from the goal's plan.
//
// Every function takes its input as an argument; nothing reads DSH state, the extension, or the network.

import { createHash } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{7,40}$/;

export function normalizeRecord(input) {
  const problems = [];
  if (!input || typeof input !== 'object') return { code: 'record_not_an_object', problems };
  const goal = input.goal || {};
  const record = {
    goalId: goal.id ?? input.goalId ?? null,
    revision: Number.isSafeInteger(goal.revision) ? goal.revision : input.revision ?? null,
    roundsStarted: Number.isSafeInteger(goal.roundsStarted) ? goal.roundsStarted
      : input.roundsStarted ?? null,
    phase: goal.phase ?? input.phase ?? null,
    activation: goal.activation ?? input.activation ?? null,
    taskId: input.taskId ?? null,
    planDigest: input.planDigest ?? null,
    commit: input.commit ?? null,
    outcome: input.outcome ?? null,
    at: Number.isFinite(input.at) ? input.at : null,
  };
  if (!record.goalId) problems.push('goal_id_missing');
  if (record.roundsStarted === null) problems.push('rounds_started_missing');
  if (record.revision === null) problems.push('revision_missing');
  if (!record.taskId) problems.push('task_id_missing');
  if (!HEX64.test(String(record.planDigest))) problems.push('plan_digest_invalid');
  if (record.commit !== null && !SHA.test(String(record.commit))) problems.push('commit_invalid');
  if (!['active', 'paused', 'blocked', 'complete'].includes(record.phase)) problems.push('phase_invalid');
  if (!['armed', 'disarmed'].includes(record.activation)) problems.push('activation_invalid');
  return { code: problems.length === 0 ? null : 'record_invalid', record, problems };
}

/**
 * Join records against the goal they claim to belong to and the commits that actually exist.
 * `commits` is the output of `git log --pretty=%H` (full or short shas).
 */
export function linkProvenance({ goal, records, commits = [], planDigest = null }) {
  const problems = [];
  const linked = [];
  if (!goal || typeof goal !== 'object' || !goal.id) return { code: 'goal_missing', linked, problems };
  const knownCommits = new Set(commits.map((sha) => String(sha).slice(0, 40).toLowerCase()));
  const seenRounds = new Map();
  let previous = -1;

  for (const raw of Array.isArray(records) ? records : []) {
    const normalized = normalizeRecord(raw);
    if (normalized.code !== null) {
      problems.push('unreadable_record:' + normalized.problems.join('+'));
      continue;
    }
    const record = normalized.record;
    if (record.goalId !== goal.id) {
      problems.push('foreign_goal:' + record.goalId + ':' + record.roundsStarted);
      continue;
    }
    if (seenRounds.has(record.roundsStarted)) {
      problems.push('duplicate_rounds_started:' + record.roundsStarted);
    }
    seenRounds.set(record.roundsStarted, true);
    if (record.roundsStarted < previous) {
      problems.push('rounds_started_went_backwards:' + previous + '->' + record.roundsStarted);
    }
    previous = Math.max(previous, record.roundsStarted);
    if (planDigest !== null && record.planDigest !== planDigest) {
      problems.push('plan_mismatch:' + record.roundsStarted);
    }
    if (record.outcome === 'done') {
      if (!record.commit) problems.push('done_without_commit:' + record.roundsStarted);
      else if (knownCommits.size > 0 && !knownCommits.has(record.commit.toLowerCase())) {
        problems.push('commit_not_in_log:' + record.commit);
      }
    }
    // Tri-state on purpose: true = the commit is in the supplied log, false = it is not, null = no log
    // was supplied so existence could not be checked. "Never checked" must not read as "present".
    linked.push({ ...record, commitPresent: !record.commit ? false
      : (knownCommits.size === 0 ? null : knownCommits.has(record.commit.toLowerCase())) });
  }

  const observed = [...seenRounds.keys()].sort((a, b) => a - b);
  const accounted = Number.isSafeInteger(goal.roundsStarted) ? goal.roundsStarted : null;
  if (accounted !== null) {
    const highest = observed.length === 0 ? 0 : observed[observed.length - 1];
    if (highest > accounted) {
      problems.push('ledger_ahead_of_goal:' + highest + '>' + accounted);
    }
    if (highest < accounted) {
      // Not a defect: rounds can run before a ledger row exists. Reported so nobody reads silence as
      // "nothing happened".
      problems.push('goal_ahead_of_ledger:' + accounted + '>' + highest);
    }
  }

  return {
    code: problems.length === 0 ? 'ok' : 'provenance_gap',
    goalId: goal.id,
    roundsStarted: accounted,
    accountedRounds: observed.length,
    linked,
    problems,
    digest: createHash('sha256')
      .update(JSON.stringify(linked.map((r) => [r.roundsStarted, r.taskId, r.commit, r.outcome])))
      .digest('hex'),
  };
}

export function renderProvenanceMarkdown(report) {
  const lines = ['# Round provenance', '',
    'Goal: `' + (report.goalId || 'none') + '`  roundsStarted: ' + report.roundsStarted
      + '  accounted: ' + report.accountedRounds, '',
    '| roundsStarted | task | commit | outcome | commit in log |', '|---|---|---|---|---|'];
  for (const row of report.linked) {
    lines.push('| ' + [row.roundsStarted, row.taskId, row.commit ? row.commit.slice(0, 7) : '-',
      row.outcome || '-', row.commit
        ? (row.commitPresent === null ? 'unverified' : (row.commitPresent ? 'yes' : 'no')) : '-']
      .join(' | ') + ' |');
  }
  lines.push('', 'Verdict: ' + report.code);
  if (report.problems.length > 0) lines.push('Problems: ' + report.problems.join(', '));
  lines.push('Digest: `' + (report.digest || 'none') + '`');
  return lines.join('\n') + '\n';
}
