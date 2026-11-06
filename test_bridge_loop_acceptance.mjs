// T191: the acceptance checker's own tests.
//
// Every case is a *record*, not a live observation. The negative cases are the point: a record can be internally
// formatted and still fail, because the tool now requires each stage to name the thing it is evidence about --
// message id + conversation + run for arrival, review id + task + run for review, a genuinely new task for
// re-dispatch, and a `completed` status for the round to count at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeRecord } from './tools/continuation/bridge_loop_acceptance.mjs';

// A fabricated session id: the real one lives in the dispatch record, not in this repository
// (tools/hygiene_scan.py flags a real `session-<uuid>` as a leak).
const SESSION = 'session-11111111-1111-4111-8111-111111111111';
const RUN = '0266f468-20c6-458e-9da4-07e172efbb75';
const TASK = 'tsk-15e55a61-6197-4ebc-8a04-e613066982fc';
const EPOCH = '11111111-1111-4111-8111-111111111111';

function round(over = {}) {
  const base = {
    round: 191,
    providerSessionId: SESSION,
    taskId: TASK,
    runId: RUN,
    startedAt: '2026-11-02T10:00:00Z',
    completedAt: '2026-11-02T10:30:00Z',
    states: {
      taskCompleted: { observed: true, source: 'bridge_ledger', at: '2026-11-02T10:30:00Z',
        status: 'completed', taskId: TASK, runId: RUN },
      extensionSubmitted: { observed: true, source: 'extension_diagnostic', at: '2026-11-02T10:30:05Z',
        runId: RUN, status: 'submitted', bindingEpoch: EPOCH },
      noticeVisible: { observed: true, source: 'chatgpt_visible_message', at: '2026-11-02T10:30:30Z',
        messageId: 'msg-777', conversationId: 'conv-55', runId: RUN },
      reviewed: { observed: true, source: 'chatgpt_review', at: '2026-11-02T10:35:00Z',
        reviewId: 'rev-1', taskId: TASK, runId: RUN, messageId: 'msg-777', conversationId: 'conv-55' },
      redispatched: { observed: true, source: 'bridge_ledger', at: '2026-11-02T10:36:00Z',
        taskId: 'tsk-192-next', reviewId: 'rev-1' },
    },
  };
  return { ...base, ...over, states: { ...base.states, ...(over.states || {}) } };
}

const judge = (rounds, extra = {}) => judgeRecord({ providerSessionId: SESSION, conversationId: 'conv-55', bindingEpoch: EPOCH, rounds, ...extra });
const withStage = (stage, patch) => round({ states: { [stage]: { ...round().states[stage], ...patch } } });

test('T191: a fully credentialed unattended round passes', () => {
  const report = judge([round()]);
  assert.equal(report.verdict, 'PASS', JSON.stringify(report.rounds[0]));
  assert.equal(report.recordSupportsUnattended, true);
  assert.equal(report.unattended, null);
});

test('T191: a failed completion never passes, even when everything else is credited', () => {
  for (const status of ['failed', 'timeout', 'cancelled']) {
    const report = judge([withStage('taskCompleted', { status })]);
    assert.equal(report.verdict, 'FAIL', status);
    const joined = report.rounds[0].problems.join(',');
    assert.match(joined, new RegExp(`taskCompleted:status_not_completed\\(${status}\\)`));
    assert.match(joined, /round:not_a_successful_completion/);
  }
});

test('T191: arrival must name a message, a conversation and the run', () => {
  const noMessage = judge([withStage('noticeVisible', { messageId: undefined })]);
  assert.equal(noMessage.verdict, 'UNKNOWN');
  assert.match(noMessage.rounds[0].unknowns.join(','), /noticeVisible:message_id_absent/);

  const noConversation = judge([withStage('noticeVisible', { conversationId: undefined })]);
  assert.equal(noConversation.verdict, 'UNKNOWN');
  assert.match(noConversation.rounds[0].unknowns.join(','), /noticeVisible:conversation_id_absent/);

  const noBinding = judge([withStage('noticeVisible', { runId: undefined })]);
  assert.equal(noBinding.verdict, 'UNKNOWN');
  assert.match(noBinding.rounds[0].unknowns.join(','), /noticeVisible:run_binding_absent/);

  const wrongRun = judge([withStage('noticeVisible', { runId: 'run-other' })]);
  assert.equal(wrongRun.verdict, 'FAIL');
  assert.match(wrongRun.rounds[0].problems.join(','), /noticeVisible:run_mismatch\(run-other\)/);
});

test('T191: an arrival bound by event id instead of run id is accepted', () => {
  const candidate = withStage('noticeVisible', { runId: undefined, eventId: 'evt-9' });
  candidate.states.extensionSubmitted.eventId = 'evt-9';
  const report = judge([candidate]);
  assert.equal(report.verdict, 'PASS', JSON.stringify(report.rounds[0]));
});

test('T191: a review must name itself and the task/run it reviewed', () => {
  const noId = judge([withStage('reviewed', { reviewId: undefined, turnId: undefined })]);
  assert.equal(noId.verdict, 'UNKNOWN');
  assert.match(noId.rounds[0].unknowns.join(','), /reviewed:review_id_absent/);

  const wrongTask = judge([withStage('reviewed', { taskId: 'tsk-other' })]);
  assert.equal(wrongTask.verdict, 'FAIL');
  assert.match(wrongTask.rounds[0].problems.join(','), /reviewed:task_mismatch\(tsk-other\)/);

  const wrongRun = judge([withStage('reviewed', { runId: 'run-other' })]);
  assert.equal(wrongRun.verdict, 'FAIL');
  assert.match(wrongRun.rounds[0].problems.join(','), /reviewed:run_mismatch\(run-other\)/);

  const turnCandidate = withStage('reviewed', { reviewId: undefined, turnId: 'turn-4' });
  turnCandidate.states.redispatched.reviewId = undefined;
  turnCandidate.states.redispatched.reviewTurnId = 'turn-4';
  const viaTurn = judge([turnCandidate]);
  assert.equal(viaTurn.verdict, 'PASS');
});

test('T191: a re-dispatch must name a new task, and never the round\'s own task', () => {
  const absent = judge([withStage('redispatched', { taskId: undefined })]);
  assert.equal(absent.verdict, 'FAIL');
  assert.match(absent.rounds[0].problems.join(','), /redispatched:task_id_absent/);

  const same = judge([withStage('redispatched', { taskId: TASK })]);
  assert.equal(same.verdict, 'FAIL');
  assert.match(same.rounds[0].problems.join(','), new RegExp(`redispatched:same_task_id\\(${TASK}\\)`));
});

test('T191: sending-side facts and the worker\'s own summary are never arrival evidence', () => {
  for (const source of ['host_ack', 'chrome_persisted', 'extension_diagnostic', 'adapter_submitted',
    'dsh_summary', 'dsh_completion_report', 'task_completed']) {
    const report = judge([withStage('noticeVisible', { source })]);
    assert.equal(report.verdict, 'FAIL', source);
    assert.match(report.rounds[0].problems.join(','), /sending_side_is_not_arrival/);
  }
});

test('T191: a fixture source is missing evidence, never a pass', () => {
  for (const source of ['fixture', 'mock', 'test', 'synthetic', 'replay']) {
    const report = judge([withStage('noticeVisible', { source })]);
    assert.equal(report.verdict, 'UNKNOWN', source);
    assert.match(report.rounds[0].unknowns.join(','), /noticeVisible:fixture_evidence/);
  }
});

test('T191: a legacy record without the new credentials is UNKNOWN, not quietly defaulted', () => {
  const legacy = round({
    states: {
      taskCompleted: { observed: true, source: 'bridge_ledger', at: '2026-11-02T10:30:00Z' },
      extensionSubmitted: { observed: true, source: 'extension_diagnostic', at: '2026-11-02T10:30:05Z' },
      noticeVisible: { observed: true, source: 'chatgpt_operator_confirmation', at: '2026-11-02T10:30:30Z' },
      reviewed: { observed: true, source: 'chatgpt_review', at: '2026-11-02T10:35:00Z' },
      redispatched: { observed: true, source: 'bridge_ledger', at: '2026-11-02T10:36:00Z',
        taskId: 'tsk-192-next', reviewId: 'rev-1' },
    },
  });
  const report = judge([legacy]);
  assert.equal(report.verdict, 'UNKNOWN', 'the T190-era shape can no longer reach PASS');
  const unknowns = report.rounds[0].unknowns.join(',');
  for (const code of ['taskCompleted:status_absent', 'noticeVisible:message_id_absent',
    'reviewed:review_id_absent']) {
    assert.match(unknowns, new RegExp(code.replace(/[:()]/g, '\\$&')));
  }
});

test('T191: a different provider session fails, an absent one is UNKNOWN', () => {
  const wrong = judge([round({ providerSessionId: 'session-00000000-0000-0000-0000-000000000000' })]);
  assert.equal(wrong.verdict, 'FAIL');
  assert.match(wrong.rounds[0].problems.join(','), /session:mismatch/);

  const absent = judge([round({ providerSessionId: undefined })]);
  assert.equal(absent.verdict, 'UNKNOWN');
  assert.match(absent.rounds[0].unknowns.join(','), /session:absent/);
});

test('T191: duplicate runs or tasks, and overlapping windows, fail', () => {
  const dup = judge([round(), round({ round: 192, startedAt: '2026-11-02T11:00:00Z',
    completedAt: '2026-11-02T11:30:00Z' })]);
  assert.equal(dup.verdict, 'FAIL');
  assert.match(dup.problems.join(','), /duplicate_run:/);
  assert.match(dup.problems.join(','), /duplicate_task:/);

  const overlap = judge([
    round(),
    round({ round: 192, runId: 'run-192', taskId: 'tsk-192',
      startedAt: '2026-11-02T10:20:00Z', completedAt: '2026-11-02T10:50:00Z' }),
  ]);
  assert.equal(overlap.verdict, 'FAIL');
  assert.match(overlap.problems.join(','), /overlap:191\/192/);
});

test('T191: the chain must lead on -- a re-dispatch that does not match the next round fails', () => {
  const report = judge([
    round(),
    round({ round: 192, runId: 'run-192', taskId: 'tsk-different',
      startedAt: '2026-11-02T11:00:00Z', completedAt: '2026-11-02T11:30:00Z' }),
  ]);
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.problems.join(','), /redispatch:does_not_lead_to_round_192/);
});

test('T191: four rounds pass -- three is a sample size, not a cap', () => {
  const rounds = [191, 192, 193, 194].map((n, i) => round({
    round: n,
    runId: `run-${n}`,
    taskId: `tsk-${n}`,
    startedAt: `2026-11-02T1${i}:00:00Z`,
    completedAt: `2026-11-02T1${i}:30:00Z`,
    states: {
      taskCompleted: { observed: true, source: 'bridge_ledger', at: `2026-11-02T1${i}:30:00Z`,
        status: 'completed', taskId: `tsk-${n}`, runId: `run-${n}` },
      extensionSubmitted: { observed: true, source: 'extension_diagnostic', at: `2026-11-02T1${i}:30:05Z`,
        runId: `run-${n}`, status: 'submitted', bindingEpoch: EPOCH },
      noticeVisible: { observed: true, source: 'chatgpt_conversation_message',
        at: `2026-11-02T1${i}:30:30Z`, messageId: `msg-${n}`, conversationId: 'conv-55', runId: `run-${n}` },
      reviewed: { observed: true, source: 'chatgpt_review', at: `2026-11-02T1${i}:35:00Z`,
        reviewId: `rev-${n}`, taskId: `tsk-${n}`, runId: `run-${n}`, messageId: `msg-${n}`, conversationId: 'conv-55' },
      redispatched: { observed: true, source: 'bridge_ledger', at: `2026-11-02T1${i}:36:00Z`,
        taskId: `tsk-${n + 1}`, reviewId: `rev-${n}` },
    },
  }));
  const report = judge(rounds);
  assert.equal(report.verdict, 'PASS', JSON.stringify(report.rounds.filter((r) => r.verdict !== 'PASS')));
  assert.equal(report.rounds.length, 4);
});

test('T248: the final redispatch cannot reuse any task already completed in the record', () => {
  const rounds = [191, 192, 193, 194].map((n, i) => round({
    round: n, runId: `run-${n}`, taskId: `tsk-${n}`,
    startedAt: `2026-11-02T1${i}:00:00Z`, completedAt: `2026-11-02T1${i}:30:00Z`,
    states: {
      taskCompleted: { observed: true, source: 'bridge_ledger', at: `2026-11-02T1${i}:30:00Z`,
        status: 'completed', taskId: `tsk-${n}`, runId: `run-${n}` },
      extensionSubmitted: { observed: true, source: 'extension_diagnostic', at: `2026-11-02T1${i}:30:05Z`, runId: `run-${n}`, status: 'submitted', bindingEpoch: EPOCH },
      noticeVisible: { observed: true, source: 'chatgpt_conversation_message', at: `2026-11-02T1${i}:30:30Z`,
        messageId: `msg-${n}`, conversationId: 'conv-55', runId: `run-${n}` },
      reviewed: { observed: true, source: 'chatgpt_review', at: `2026-11-02T1${i}:35:00Z`,
        reviewId: `rev-${n}`, taskId: `tsk-${n}`, runId: `run-${n}`, messageId: `msg-${n}`, conversationId: 'conv-55' },
      redispatched: { observed: true, source: 'bridge_ledger', at: `2026-11-02T1${i}:36:00Z`, taskId: `tsk-${n + 1}`, reviewId: `rev-${n}` },
    },
  }));
  assert.equal(judge(rounds).verdict, 'PASS', 'a genuinely new final task remains accepted');
  for (const prior of rounds) {
    const mutated = structuredClone(rounds);
    mutated.at(-1).states.redispatched.taskId = prior.taskId;
    const report = judge(mutated);
    assert.equal(report.verdict, 'FAIL', `final redispatch back to ${prior.taskId}`);
    assert.ok(report.problems.includes(`redispatch:reuses_completed_task:${prior.taskId}`));
    assert.equal(report.unattended, null, 'a cycle into old work is never credited as unattended');
  }
});

test('T248: one notice and one review cannot be credited to two rounds', () => {
  const first = round({ states: { redispatched: { observed: true, source: 'bridge_ledger',
    at: '2026-11-02T10:36:00Z', taskId: 'tsk-192', reviewId: 'rev-1' } } });
  const secondRound = (notice = {}, review = {}) => round({
    round: 192, runId: 'run-192', taskId: 'tsk-192',
    startedAt: '2026-11-02T11:00:00Z', completedAt: '2026-11-02T11:30:00Z',
    states: {
      taskCompleted: { observed: true, source: 'bridge_ledger', at: '2026-11-02T11:30:00Z',
        status: 'completed', taskId: 'tsk-192', runId: 'run-192' },
      extensionSubmitted: { observed: true, source: 'extension_diagnostic', at: '2026-11-02T11:30:05Z',
        runId: 'run-192', status: 'submitted', bindingEpoch: EPOCH },
      noticeVisible: { observed: true, source: 'chatgpt_conversation_message', at: '2026-11-02T11:30:30Z',
        messageId: 'msg-192', conversationId: 'conv-55', runId: 'run-192', ...notice },
      reviewed: { observed: true, source: 'chatgpt_review', at: '2026-11-02T11:35:00Z',
        reviewId: 'rev-192', taskId: 'tsk-192', runId: 'run-192', messageId: 'msg-192', conversationId: 'conv-55', ...review },
      redispatched: { observed: true, source: 'bridge_ledger', at: '2026-11-02T11:36:00Z', taskId: 'tsk-193', reviewId: 'rev-192' },
    },
  });

  const clean = judge([first, secondRound()]);
  assert.equal(clean.verdict, 'PASS', 'two notices in one conversation, each with its own message, still pass');

  const reusedNotice = judge([first, secondRound({ messageId: 'msg-777' })]);
  assert.equal(reusedNotice.verdict, 'FAIL', 'the same page message cannot be round 192\'s notice too');
  assert.ok(reusedNotice.problems.includes('duplicate_notice:msg-777'));
  assert.equal(reusedNotice.unattended, null);

  const reusedReview = judge([first, secondRound({}, { reviewId: 'rev-1' })]);
  assert.equal(reusedReview.verdict, 'FAIL', 'the same review turn cannot review two runs');
  assert.ok(reusedReview.problems.includes('duplicate_review:rev-1'));
  assert.equal(reusedReview.unattended, null);

  const both = judge([first, secondRound({ messageId: 'msg-777' }, { reviewId: 'rev-1' })]);
  assert.equal(both.verdict, 'FAIL');
  assert.deepEqual(both.problems.filter((p) => p.startsWith('duplicate_')).sort(),
    ['duplicate_notice:msg-777', 'duplicate_review:rev-1']);
});

// T261: expanded offline contract; all IDs and source labels below are fabricated test inputs.
for (const [status, verdict] of [['blocked', 'FAIL'], ['refused', 'FAIL'], ['stopped', 'FAIL'],
  ['unconfirmed', 'UNKNOWN'], ['ambiguous', 'UNKNOWN'], ['UNKNOWN', 'UNKNOWN'], [undefined, 'UNKNOWN']]) {
  test(`T261 sender status ${status} is ${verdict}`, () => {
    const report = judge([withStage('extensionSubmitted', { status })]);
    assert.equal(report.verdict, verdict);
    assert.equal(report.rounds[0].stages.extensionSubmitted, verdict);
    assert.equal(report.unattended, null);
  });
}
for (const reason of ['binding_invalidated', 'binding_changed', 'grant_expired']) {
  test(`T261 submitted cannot hide ${reason}`, () => {
    const report = judge([withStage('extensionSubmitted', { reason })]);
    assert.equal(report.verdict, 'FAIL');
    assert.ok(report.rounds[0].problems.includes(`extensionSubmitted:blocked(${reason})`));
  });
}
test('T261 submitted plus blocked state is contradictory', () => {
  assert.equal(judge([withStage('extensionSubmitted', { state: 'blocked' })]).verdict, 'FAIL');
});
for (const [name, patch, extra, verdict] of [
  ['missing context', {}, { bindingEpoch: undefined }, 'UNKNOWN'],
  ['missing actual', { bindingEpoch: undefined }, {}, 'UNKNOWN'],
  ['invalid actual', { bindingEpoch: 'UNKNOWN' }, {}, 'UNKNOWN'],
  ['mismatch', { bindingEpoch: '22222222-2222-4222-8222-222222222222' }, {}, 'FAIL'],
  ['undeclared alias scope', { armEpoch: EPOCH }, {}, 'UNKNOWN'],
  ['scoped agreeing aliases', { epochScope: 'sender_attempt', armEpoch: EPOCH, postArmEpoch: EPOCH }, {}, 'PASS'],
  ['scoped conflicting aliases', { epochScope: 'sender_attempt', armEpoch: EPOCH,
    postArmEpoch: '22222222-2222-4222-8222-222222222222' }, {}, 'FAIL'],
  ['scoped invalid alias', { epochScope: 'sender_attempt', armEpoch: null }, {}, 'UNKNOWN'],
]) {
  test(`T261 epoch ${name}`, () => {
    const report = judge([withStage('extensionSubmitted', patch)], extra);
    assert.equal(report.verdict, verdict, JSON.stringify(report));
  });
}
for (const key of ['eventId', 'bindingId']) {
  test(`T261 ${key} requires same-key sender binding`, () => {
    const candidate = withStage('noticeVisible', { runId: undefined, [key]: 'notice-other' });
    assert.equal(judge([candidate]).verdict, 'UNKNOWN');
    candidate.states.extensionSubmitted[key] = 'notice-correct';
    assert.equal(judge([candidate]).verdict, 'FAIL');
    candidate.states.extensionSubmitted[key] = 'notice-other';
    assert.equal(judge([candidate]).verdict, 'PASS');
    candidate.states.noticeVisible.runId = RUN;
    candidate.states.extensionSubmitted[key] = 'notice-correct';
    assert.equal(judge([candidate]).verdict, 'FAIL', 'a matching run cannot conceal a conflicting reference');
  });
}
test('T261 event and binding namespaces may differ but each must match', () => {
  const candidate = withStage('noticeVisible', { eventId: 'event-1', bindingId: 'binding-2' });
  Object.assign(candidate.states.extensionSubmitted, { eventId: 'event-1', bindingId: 'binding-2' });
  assert.equal(judge([candidate]).verdict, 'PASS');
});
test('T261 absent or different target conversation is not a pass', () => {
  assert.equal(judge([round()], { conversationId: undefined }).verdict, 'UNKNOWN');
  assert.equal(judge([withStage('noticeVisible', { conversationId: 'other-conversation' })]).verdict, 'FAIL');
});
for (const key of ['messageId', 'conversationId']) {
  test(`T261 review must link exact page ${key}`, () => {
    assert.equal(judge([withStage('reviewed', { [key]: undefined })]).verdict, 'UNKNOWN');
    assert.equal(judge([withStage('reviewed', { [key]: 'unrelated' })]).verdict, 'FAIL');
  });
}
test('T261 every populated review run alias must join', () => {
  assert.equal(judge([withStage('reviewed', { reviewRunId: 'other-run' })]).verdict, 'FAIL');
  assert.equal(judge([withStage('reviewed', { reviewRunId: RUN })]).verdict, 'PASS');
});
test('T261 redispatch needs an exact independently supplied review reference', () => {
  assert.equal(judge([withStage('redispatched', { reviewId: undefined })]).verdict, 'UNKNOWN');
  assert.equal(judge([withStage('redispatched', { reviewId: 'other-review' })]).verdict, 'FAIL');
});
test('T261 reviewId and turnId are separate reference namespaces', () => {
  const candidate = withStage('reviewed', { turnId: 'turn-different' });
  candidate.states.redispatched.reviewTurnId = 'turn-different';
  assert.equal(judge([candidate]).verdict, 'PASS');
  candidate.states.redispatched.reviewId = 'turn-different';
  assert.equal(judge([candidate]).verdict, 'FAIL');
});
test('T261 earlier completed event cannot pay for the current window', () => {
  const candidate = withStage('taskCompleted', { at: '2026-11-02T10:29:00Z' });
  assert.equal(judge([candidate]).verdict, 'FAIL');
  for (const value of Object.values(candidate.states)) value.at = value.at.replace('2026-11-02', '2026-11-01');
  assert.equal(judge([candidate]).verdict, 'FAIL');
});
test('T261 missing evidence remains UNKNOWN after later review and dispatch', () => {
  const candidate = withStage('extensionSubmitted', { status: 'unconfirmed' });
  const report = judge([candidate]);
  assert.equal(report.verdict, 'UNKNOWN');
  assert.equal(report.rounds[0].stages.reviewed, 'PASS');
  assert.equal(report.rounds[0].stages.redispatched, 'PASS');
  assert.equal(report.unattended, null);
});
test('T261 excluded fixture completion status and timestamps do not become failures', () => {
  const candidate = withStage('taskCompleted', { source: 'fixture', status: 'failed', at: '2050-01-01T00:00:00Z' });
  assert.equal(judge([candidate]).verdict, 'UNKNOWN');
});

function twoRounds() {
  const first = round();
  const next = structuredClone(round());
  next.round = 192; next.runId = 'run-192'; next.taskId = first.states.redispatched.taskId;
  next.startedAt = '2026-11-02T11:00:00Z'; next.completedAt = '2026-11-02T11:30:00Z';
  for (const value of Object.values(next.states)) {
    value.at = value.at.replace('T10:', 'T11:');
    if (Object.hasOwn(value, 'runId')) value.runId = next.runId;
  }
  next.states.taskCompleted.taskId = next.taskId;
  Object.assign(next.states.noticeVisible, { messageId: 'msg-next' });
  Object.assign(next.states.reviewed, { taskId: next.taskId, reviewId: 'rev-next', messageId: 'msg-next' });
  Object.assign(next.states.redispatched, { taskId: 'tsk-193-next', reviewId: 'rev-next' });
  return [first, next];
}
for (const stage of ['noticeVisible', 'reviewed', 'redispatched']) {
  test(`T261 excluded ${stage} identities cannot produce cross-round failures`, () => {
    for (const patch of [{ source: 'fixture' }, { observed: undefined }]) {
      const rounds = twoRounds();
      const first = rounds[0].states[stage];
      Object.assign(first, patch);
      if (stage === 'noticeVisible') first.messageId = rounds[1].states.noticeVisible.messageId;
      if (stage === 'reviewed') first.reviewId = rounds[1].states.reviewed.reviewId;
      if (stage === 'redispatched') first.taskId = rounds[0].taskId;
      const report = judge(rounds);
      assert.equal(report.verdict, 'UNKNOWN', JSON.stringify(report));
      assert.deepEqual(report.problems, []);
    }
  });
}
test('T261 genuine duplicate facts fail even with unrelated timestamp missing', () => {
  const rounds = twoRounds();
  rounds[0].states.noticeVisible.messageId = rounds[1].states.noticeVisible.messageId;
  rounds[0].states.noticeVisible.at = undefined;
  const report = judge(rounds);
  assert.equal(report.verdict, 'FAIL');
  assert.ok(report.problems.includes('duplicate_notice:msg-next'));
});
test('T261 shared grant epoch across sequential runs is not duplicate evidence', () => {
  const report = judge(twoRounds());
  assert.equal(report.verdict, 'PASS', JSON.stringify(report));
  assert.equal(report.evidenceScope, 'supplied_record_only');
  assert.equal(report.liveObserved, false);
});
test('T261 epoch absence, unavailability and invalidity remain distinct diagnostics', () => {
  for (const [bindingEpoch, code] of [[undefined, 'epoch_absent'], ['UNKNOWN', 'epoch_unavailable'], ['bad-epoch', 'epoch_invalid']]) {
    const report = judge([withStage('extensionSubmitted', { bindingEpoch })]);
    assert.equal(report.verdict, 'UNKNOWN');
    assert.ok(report.rounds[0].unknowns.includes(`extensionSubmitted:${code}`));
  }
});

test('T261 populated record and round contexts cannot silently override', () => {
  const candidate = round({ bindingEpoch: '22222222-2222-4222-8222-222222222222' });
  candidate.states.extensionSubmitted.bindingEpoch = candidate.bindingEpoch;
  assert.equal(judge([candidate]).verdict, 'FAIL');
  assert.equal(judge([round({ conversationId: 'other-conversation' })]).verdict, 'FAIL');
  const perRound = round({ bindingEpoch: EPOCH, conversationId: 'conv-55' });
  assert.equal(judge([perRound], { bindingEpoch: undefined, conversationId: undefined }).verdict, 'PASS');
});

test('T261 malformed round fails closed rather than throwing', () => {
  assert.equal(judge([null]).verdict, 'FAIL');
});

test('T191: the report never claims this program observed the loop', () => {
  const report = judge([round()]);
  assert.match(report.note, /not that the loop was observed by this program/);
  assert.match(report.note, /recordSupportsUnattended/);
  assert.equal(report.unattended, null);
  assert.equal(judge([]).verdict, 'UNKNOWN');
});
