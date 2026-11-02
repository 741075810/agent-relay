#!/usr/bin/env node
// T190: offline acceptance checker for the "no human typed 完成了" loop.
//
// Input is a redacted, structured record of what someone actually observed -- never a query against the live
// Bridge, the browser or the extension. This tool does not decide that the loop works; it decides whether the
// record a human supplied *could* support that claim, and says which link is missing when it could not.
//
// The distinction it exists to enforce:
//   task completed        the Bridge ledger says the DSH task finished
//   extension submitted   the adapter accepted the notice (page write + click + submit)
//   notice visible        a human read it in the ChatGPT conversation
//   reviewed              ChatGPT independently reviewed the task's result
//   redispatched          a NEW task was created from that review
// Only the third link can be supplied by a human reading the conversation. A host ACK, a Chrome persistence
// event or an adapter `submitted` is never evidence for it.
//
// Usage:
//   node tools/continuation/bridge_loop_acceptance.mjs record.json [--json]
// Exit codes: 0 = every round PASS, 1 = at least one FAIL, 2 = nothing failed but something is UNKNOWN.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGES = Object.freeze(['taskCompleted', 'extensionSubmitted', 'noticeVisible', 'reviewed',
  'redispatched']);

//: Where a stage's fact is allowed to come from.
//:
//: T190R: the goal is *unattended* operation, so requiring a human to eyeball each notice would make a correct
//: loop unpassable. `noticeVisible` therefore accepts observation of the message inside the target ChatGPT
//: conversation -- `chatgpt_conversation_message` (a message the bridge can see in that conversation) or
//: `chatgpt_visible_message` (visible in the conversation view) -- and the ChatGPT turn's own review/dispatch
//: is what proves the message was actually consumed. A human confirmation is still accepted, as one of several
//: valid observations, not as a requirement.
//:
//: What stays forbidden is unchanged: a host ACK, a Chrome persistence event and an adapter `submitted` prove
//: the notice left, never that it arrived; a DSH summary is the worker describing itself; fixtures are not
//: evidence at all.
export const SOURCES = Object.freeze({
  taskCompleted: ['bridge_ledger'],
  extensionSubmitted: ['extension_diagnostic'],
  noticeVisible: ['chatgpt_conversation_message', 'chatgpt_visible_message', 'chatgpt_operator_confirmation'],
  reviewed: ['chatgpt_review'],
  redispatched: ['bridge_ledger'],
});

//: Sources that look like notice evidence but are not: they observe the sending side, or the worker's own
//: description of itself.
export const NOT_ARRIVAL = Object.freeze(['host_ack', 'chrome_persisted', 'extension_diagnostic',
  'adapter_submitted', 'dsh_summary', 'dsh_completion_report', 'task_completed']);

export const MACHINE_SOURCE_HINTS = Object.freeze(['host_ack', 'host_state', 'chrome_persisted',
  'extension_diagnostic', 'bridge_ledger']);

const FIXTURE_SOURCES = Object.freeze(['fixture', 'mock', 'test', 'synthetic', 'replay']);

function timeOf(stage) {
  if (!stage || typeof stage.at !== 'string') return null;
  const ms = Date.parse(stage.at);
  return Number.isNaN(ms) ? null : ms;
}

/** One round, judged stage by stage. `problems` are FAIL reasons; `unknowns` are missing evidence. */
export function judgeRound(round, expected) {
  const problems = [];
  const unknowns = [];
  const states = (round && round.states) || {};

  for (const stage of STAGES) {
    const value = states[stage];
    if (!value || value.observed === undefined || value.observed === null) {
      unknowns.push(`${stage}:not_observed`);
      continue;
    }
    if (value.observed !== true) {
      problems.push(`${stage}:reported_false`);
      continue;
    }
    const source = typeof value.source === 'string' ? value.source : '';
    if (FIXTURE_SOURCES.includes(source)) {
      unknowns.push(`${stage}:fixture_evidence`);
      continue;
    }
    if (!SOURCES[stage].includes(source)) {
      const hint = NOT_ARRIVAL.includes(source) && stage === 'noticeVisible'
        ? ':sending_side_is_not_arrival' : '';
      problems.push(`${stage}:wrong_source(${source || 'none'})${hint}`);
      continue;
    }
    if (timeOf(value) === null) unknowns.push(`${stage}:no_timestamp`);
  }

  // Ordering: each link must be observed no earlier than the one it depends on.
  const ordered = STAGES.map((stage) => timeOf(states[stage])).filter((ms) => ms !== null);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i] < ordered[i - 1]) problems.push('chain:out_of_order');
  }

  if (!round.providerSessionId) {
    // An absent session id is missing evidence, not a contradiction: say which, do not collapse the two.
    unknowns.push('session:absent');
  } else if (expected && expected.providerSessionId
      && round.providerSessionId !== expected.providerSessionId) {
    problems.push(`session:mismatch(${round.providerSessionId})`);
  }
  if (!round.taskId) problems.push('task:absent');
  if (!round.runId) problems.push('run:absent');

  const start = Date.parse(round.startedAt || '');
  const end = Date.parse(round.completedAt || '');
  if (Number.isNaN(start) || Number.isNaN(end)) problems.push('window:unreadable');
  if (!Number.isNaN(start) && !Number.isNaN(end) && end < start) problems.push('window:ends_before_start');

  if (problems.length) return { verdict: 'FAIL', problems, unknowns };
  if (unknowns.length) return { verdict: 'UNKNOWN', problems, unknowns };
  return { verdict: 'PASS', problems, unknowns };
}

/** The whole record: every round, plus the cross-round facts a single round cannot see. */
export function judgeRecord(record) {
  const rounds = Array.isArray(record && record.rounds) ? record.rounds : [];
  const expected = { providerSessionId: record && record.providerSessionId };
  const problems = [];
  const results = rounds.map((round) => ({
    round: round && round.round,
    runId: round && round.runId,
    ...judgeRound(round, expected),
  }));

  const seenRuns = new Map();
  const seenTasks = new Map();
  for (const round of rounds) {
    if (round && round.runId) {
      if (seenRuns.has(round.runId)) problems.push(`duplicate_run:${round.runId}`);
      seenRuns.set(round.runId, round.round);
    }
    if (round && round.taskId) {
      if (seenTasks.has(round.taskId)) problems.push(`duplicate_task:${round.taskId}`);
      seenTasks.set(round.taskId, round.round);
    }
  }

  // Two runs overlapping in time cannot both be "the" round: the loop is one completion at a time.
  const windows = rounds
    .map((round) => ({ round: round && round.round,
      start: Date.parse((round && round.startedAt) || ''),
      end: Date.parse((round && round.completedAt) || '') }))
    .filter((w) => !Number.isNaN(w.start) && !Number.isNaN(w.end))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < windows.length; i += 1) {
    if (windows[i].start < windows[i - 1].end) problems.push(`overlap:${windows[i - 1].round}/${windows[i].round}`);
  }

  // A re-dispatch must point at a task that did not exist yet, and the next round must be that task.
  for (let i = 0; i < rounds.length; i += 1) {
    const next = rounds[i + 1];
    const dispatched = rounds[i] && rounds[i].states && rounds[i].states.redispatched;
    if (!next || !dispatched || !dispatched.taskId) continue;
    if (dispatched.taskId !== next.taskId) problems.push(`redispatch:does_not_lead_to_round_${next.round}`);
  }

  // T190R: nothing in this judgement requires a person. A round whose notice was observed inside the target
  // conversation, and whose review and re-dispatch are on record, passes with no human involvement at all.
  const verdicts = results.map((r) => r.verdict);
  let verdict = 'PASS';
  if (problems.length || verdicts.includes('FAIL')) verdict = 'FAIL';
  else if (verdicts.includes('UNKNOWN') || rounds.length === 0) verdict = 'UNKNOWN';
  return {
    verdict,
    rounds: results,
    problems,
    unattended: verdict === 'PASS' ? true : null,
    note: 'This tool judges a supplied record. A PASS means the record is complete and self-consistent, not that '
      + 'the loop was observed by this program. A PASS needs no human in the loop: an arrival observed inside the '
      + 'target conversation plus the ChatGPT turn\'s own review and re-dispatch is enough. Sending-side facts '
      + '(host ack, Chrome persistence, adapter submitted, DSH summary) and fixtures are never arrival evidence.',
  };
}

function main(argv) {
  const file = argv.find((arg) => !arg.startsWith('--'));
  const asJson = argv.includes('--json');
  if (!file) {
    process.stderr.write('usage: bridge_loop_acceptance.mjs <record.json> [--json]\n');
    return 2;
  }
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read ${file}: ${err.message}\n`);
    return 2;
  }
  const report = judgeRecord(record);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`verdict ${report.verdict}\n`);
    for (const round of report.rounds) {
      process.stdout.write(`  round ${round.round} (${round.runId || 'no run id'}): ${round.verdict}`
        + `${round.problems.length ? ' ' + round.problems.join(',') : ''}`
        + `${round.unknowns.length ? ' unknown:' + round.unknowns.join(',') : ''}\n`);
    }
    for (const problem of report.problems) process.stdout.write(`  ${problem}\n`);
    process.stdout.write(`  ${report.note}\n`);
  }
  return report.verdict === 'PASS' ? 0 : (report.verdict === 'FAIL' ? 1 : 2);
}

// Run only when this file *is* the entry point. A suffix test on the file name was wrong: the test file is
// called `test_bridge_loop_acceptance.mjs`, which ends with this module's name, so importing it from a test ran
// `main()` and returned 2.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
