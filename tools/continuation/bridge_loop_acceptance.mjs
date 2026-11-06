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
// Only an independent conversation-side receipt can support the third link. A host ACK, a Chrome persistence
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
//: `chatgpt_visible_message` (visible in the conversation view) -- and the supplied ChatGPT review/dispatch
//: references support a consumption claim. This checker never observes consumption itself. A human confirmation
//: is still accepted as one of several valid observations, not as a requirement.
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
const EPOCH = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const credited = (stage, value) => value?.observed === true && SOURCES[stage].includes(value.source);

function checkEpoch(value, round, expected) {
  const problems = [], unknowns = [];
  const contexts = [round.bindingEpoch, expected.bindingEpoch].filter(v => v !== undefined);
  const validContexts = contexts.filter(v => typeof v === 'string' && EPOCH.test(v));
  const target = validContexts[0];
  if (!contexts.length) unknowns.push('extensionSubmitted:epoch_context_absent');
  else if (contexts.length !== validContexts.length) unknowns.push('extensionSubmitted:epoch_context_invalid');
  if (new Set(validContexts).size > 1) problems.push('extensionSubmitted:epoch_context_conflict');
  const values = [value.bindingEpoch];
  const aliases = ['runEpoch', 'run_epoch', 'armEpoch', 'postArmEpoch'].filter(key => Object.hasOwn(value, key));
  if (aliases.length && value.epochScope !== 'sender_attempt') unknowns.push('extensionSubmitted:epoch_scope_unverified');
  if (value.epochScope === 'sender_attempt') values.push(...aliases.map(key => value[key]));
  const valid = values.filter(v => typeof v === 'string' && EPOCH.test(v));
  if (values.some(v => v === undefined || v === null || v === '')) unknowns.push('extensionSubmitted:epoch_absent');
  if (values.includes('UNKNOWN')) unknowns.push('extensionSubmitted:epoch_unavailable');
  if (values.some(v => v !== undefined && v !== null && v !== '' && v !== 'UNKNOWN' && (typeof v !== 'string' || !EPOCH.test(v)))) unknowns.push('extensionSubmitted:epoch_invalid');
  if (new Set(valid).size > 1) problems.push('extensionSubmitted:epoch_conflict');
  if (typeof target === 'string' && EPOCH.test(target) && valid.some(v => v !== target)) problems.push('extensionSubmitted:epoch_mismatch');
  return { problems, unknowns };
}

function timeOf(stage) {
  if (!stage || typeof stage.at !== 'string') return null;
  const ms = Date.parse(stage.at);
  return Number.isNaN(ms) ? null : ms;
}

/** One round, judged stage by stage. `problems` are FAIL reasons; `unknowns` are missing evidence. */
function text(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Per-stage credential checks. A stage is only evidence when it names the thing it is evidence *about*:
 *   - the completion names its task and run, and says `completed`;
 *   - the arrival names a message, its conversation, and the run that message was about;
 *   - the review names itself and the task/run it reviewed;
 *   - the re-dispatch names a *new* task.
 * A missing name is UNKNOWN, never a default. This tool cannot verify a signature on any of them -- it can only
 * refuse a record whose own fields do not join up.
 */
function checkStage(stage, value, round, expected = {}) {
  const problems = [];
  const unknowns = [];
  const roundRun = text(round && round.runId);
  const roundTask = text(round && round.taskId);

  if (stage === 'taskCompleted') {
    const status = text(value.status);
    if (!status) unknowns.push('taskCompleted:status_absent');
    else if (status !== 'completed') problems.push(`taskCompleted:status_not_completed(${status})`);
    const taskId = text(value.taskId);
    if (!taskId) unknowns.push('taskCompleted:task_id_absent');
    else if (roundTask && taskId !== roundTask) problems.push(`taskCompleted:task_mismatch(${taskId})`);
    const runId = text(value.runId);
    if (!runId) unknowns.push('taskCompleted:run_id_absent');
    else if (roundRun && runId !== roundRun) problems.push(`taskCompleted:run_mismatch(${runId})`);
  }

  if (stage === 'extensionSubmitted') {
    const runId = text(value.runId);
    if (!runId) unknowns.push('extensionSubmitted:run_id_absent');
    else if (roundRun && runId !== roundRun) problems.push(`extensionSubmitted:run_mismatch(${runId})`);
    const status = text(value.status);
    if (['blocked', 'refused', 'stopped', 'failed', 'interrupted'].includes(status)) problems.push(`extensionSubmitted:status_not_submitted(${status})`);
    else if (status !== 'submitted') unknowns.push('extensionSubmitted:status_unverified');
    const senderState = text(value.state);
    if (['blocked', 'refused', 'stopped', 'failed', 'interrupted'].includes(senderState)) problems.push(`extensionSubmitted:state_not_sent(${senderState})`);
    else if (senderState && !['sent', 'submitted'].includes(senderState)) unknowns.push('extensionSubmitted:state_unverified');
    if (['binding_invalidated', 'binding_changed', 'grant_expired'].includes(value.reason)) problems.push(`extensionSubmitted:blocked(${value.reason})`);
    const epoch = checkEpoch(value, round, expected);
    problems.push(...epoch.problems); unknowns.push(...epoch.unknowns);
  }

  if (stage === 'noticeVisible') {
    const messageId = text(value.messageId);
    if (!messageId) unknowns.push('noticeVisible:message_id_absent');
    const conversationId = text(value.conversationId);
    if (!conversationId) unknowns.push('noticeVisible:conversation_id_absent');
    const targetConversation = text(expected.conversationId) || text(round.conversationId);
    if (text(expected.conversationId) && text(round.conversationId) && expected.conversationId !== round.conversationId) problems.push('noticeVisible:conversation_context_conflict');
    if (!targetConversation) unknowns.push('noticeVisible:target_conversation_absent');
    else if (conversationId && conversationId !== targetConversation) problems.push('noticeVisible:conversation_mismatch');
    const boundRun = text(value.runId);
    const refs = ['eventId', 'bindingId'].filter(key => text(value[key]));
    if (!boundRun && !refs.length) unknowns.push('noticeVisible:run_binding_absent');
    else if (boundRun && roundRun && boundRun !== roundRun) problems.push(`noticeVisible:run_mismatch(${boundRun})`);
    const sender = round.states?.extensionSubmitted;
    for (const key of refs) {
      if (!credited('extensionSubmitted', sender) || !text(sender[key]) || !text(sender.runId)) unknowns.push(`noticeVisible:${key}_binding_unverified`);
      else if (sender.runId !== roundRun || value[key] !== sender[key]) problems.push(`noticeVisible:${key}_binding_mismatch`);
    }
  }

  if (stage === 'reviewed') {
    const reviewId = text(value.reviewId) || text(value.turnId);
    if (!reviewId) unknowns.push('reviewed:review_id_absent');
    const reviewedTask = text(value.taskId);
    if (!reviewedTask) unknowns.push('reviewed:task_id_absent');
    else if (roundTask && reviewedTask !== roundTask) problems.push(`reviewed:task_mismatch(${reviewedTask})`);
    const reviewedRuns = ['runId', 'reviewRunId'].map(key => text(value[key])).filter(Boolean);
    if (!reviewedRuns.length) unknowns.push('reviewed:run_id_absent');
    for (const reviewedRun of reviewedRuns) {
      if (roundRun && reviewedRun !== roundRun) problems.push(`reviewed:run_mismatch(${reviewedRun})`);
    }
    const notice = round.states?.noticeVisible;
    for (const key of ['messageId', 'conversationId']) {
      if (!text(value[key])) unknowns.push(`reviewed:${key}_absent`);
      else if (!credited('noticeVisible', notice) || !text(notice[key])) unknowns.push(`reviewed:${key}_binding_unverified`);
      else if (value[key] !== notice[key]) problems.push(`reviewed:${key}_mismatch`);
    }
  }

  if (stage === 'redispatched') {
    const taskId = text(value.taskId);
    if (!taskId) problems.push('redispatched:task_id_absent');
    else if (roundTask && taskId === roundTask) problems.push(`redispatched:same_task_id(${taskId})`);
    const review = round.states?.reviewed;
    const pairs = [['reviewId', 'reviewId'], ['reviewTurnId', 'turnId']];
    if (!pairs.some(([key]) => text(value[key]))) unknowns.push('redispatched:review_reference_absent');
    for (const [key, target] of pairs) {
      if (!text(value[key])) continue;
      if (!credited('reviewed', review) || !text(review[target])) unknowns.push(`redispatched:${key}_binding_unverified`);
      else if (value[key] !== review[target]) problems.push(`redispatched:${key}_mismatch`);
    }
  }

  return { problems, unknowns };
}

export function judgeRound(round, expected = {}) {
  round = round && typeof round === 'object' ? round : {};
  const problems = [];
  const unknowns = [];
  const stages = {};
  const states = (round && round.states) || {};

  for (const stage of STAGES) {
    const value = states[stage];
    if (!value || value.observed === undefined || value.observed === null) {
      unknowns.push(`${stage}:not_observed`);
      stages[stage] = 'UNKNOWN';
      continue;
    }
    if (value.observed !== true) {
      problems.push(`${stage}:reported_false`);
      stages[stage] = 'FAIL';
      continue;
    }
    const source = typeof value.source === 'string' ? value.source : '';
    if (FIXTURE_SOURCES.includes(source)) {
      unknowns.push(`${stage}:fixture_evidence`);
      stages[stage] = 'UNKNOWN';
      continue;
    }
    if (!SOURCES[stage].includes(source)) {
      const hint = NOT_ARRIVAL.includes(source) && stage === 'noticeVisible'
        ? ':sending_side_is_not_arrival' : '';
      problems.push(`${stage}:wrong_source(${source || 'none'})${hint}`);
      stages[stage] = 'FAIL';
      continue;
    }
    const noTime = timeOf(value) === null;
    if (noTime) unknowns.push(`${stage}:no_timestamp`);
    const credential = checkStage(stage, value, round, expected);
    problems.push(...credential.problems);
    unknowns.push(...credential.unknowns);
    stages[stage] = credential.problems.length ? 'FAIL' : (noTime || credential.unknowns.length ? 'UNKNOWN' : 'PASS');
  }

  // A failed run may be notified, but it is never a passed round, whatever else the record says.
  const completed = states.taskCompleted;
  if (credited('taskCompleted', completed) && text(completed.status) && text(completed.status) !== 'completed') {
    problems.push('round:not_a_successful_completion');
  }

  // Ordering: each link must be observed no earlier than the one it depends on.
  const ordered = STAGES.filter(stage => credited(stage, states[stage])).map((stage) => timeOf(states[stage])).filter((ms) => ms !== null);
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
  for (const stage of STAGES) {
    const at = credited(stage, states[stage]) ? timeOf(states[stage]) : null;
    if (at !== null && ((!Number.isNaN(start) && at < start) || (!Number.isNaN(end) && stage === 'taskCompleted' && at < end))) {
      problems.push(`${stage}:before_run_window`);
      stages[stage] = 'FAIL';
    }
  }

  if (problems.length) return { verdict: 'FAIL', problems, unknowns, stages };
  if (unknowns.length) return { verdict: 'UNKNOWN', problems, unknowns, stages };
  return { verdict: 'PASS', problems, unknowns, stages };
}

/** The whole record: every round, plus the cross-round facts a single round cannot see. */
export function judgeRecord(record) {
  const rounds = Array.isArray(record && record.rounds) ? record.rounds : [];
  const expected = { providerSessionId: record && record.providerSessionId,
    conversationId: record && record.conversationId, bindingEpoch: record && record.bindingEpoch };
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

  // One page message is one notice, and one review turn reviews one run. The same id credited to two
  // rounds would let a single notice (or a single review) pay for two links of the chain, which is the
  // duplicate-notice failure this repository has been chasing -- so it is a FAIL, not missing evidence.
  const seenNotice = new Map();
  const seenReview = new Map();
  for (const round of rounds) {
    const states = (round && round.states) || {};
    const messageId = credited('noticeVisible', states.noticeVisible) ? text(states.noticeVisible.messageId) : null;
    if (messageId) {
      if (seenNotice.has(messageId)) problems.push(`duplicate_notice:${messageId}`);
      else seenNotice.set(messageId, round && round.round);
    }
    const reviewed = states.reviewed || {};
    for (const key of ['reviewId', 'turnId']) {
      const reviewId = credited('reviewed', reviewed) ? text(reviewed[key]) : null;
      if (reviewId) {
        const identity = `${key}:${reviewId}`;
        if (seenReview.has(identity)) problems.push(`duplicate_review:${reviewId}`);
        else seenReview.set(identity, round && round.round);
      }
    }
  }

  // A re-dispatch must point at a task that did not exist yet, and the next round must be that task.
  const completedTasks = new Set();
  for (let i = 0; i < rounds.length; i += 1) {
    if (rounds[i] && rounds[i].taskId) completedTasks.add(rounds[i].taskId);
    const next = rounds[i + 1];
    const dispatched = rounds[i] && rounds[i].states && rounds[i].states.redispatched;
    if (!credited('redispatched', dispatched) || !text(dispatched.taskId)) continue;
    // The last round has no successor record, but still must not loop back into old work.
    if (completedTasks.has(dispatched.taskId)) {
      problems.push(`redispatch:reuses_completed_task:${dispatched.taskId}`);
    }
    if (next && dispatched.taskId !== next.taskId) problems.push(`redispatch:does_not_lead_to_round_${next.round}`);
  }

  // T261: a supplied complete record may describe an unattended loop; this program observes no live loop.
  const verdicts = results.map((r) => r.verdict);
  let verdict = 'PASS';
  if (problems.length || verdicts.includes('FAIL')) verdict = 'FAIL';
  else if (verdicts.includes('UNKNOWN') || rounds.length === 0) verdict = 'UNKNOWN';
  return {
    verdict,
    rounds: results,
    problems,
    unattended: null, // Deprecated: a pure offline checker never observes unattended execution.
    recordSupportsUnattended: verdict === 'PASS' ? true : null,
    evidenceScope: 'supplied_record_only',
    liveObserved: false,
    note: 'This tool judges a supplied record. A PASS means the record is complete and self-consistent, not that '
      + 'the loop was observed by this program. recordSupportsUnattended describes the supplied record only; '
      + 'unattended is UNKNOWN. Sending-side facts '
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
