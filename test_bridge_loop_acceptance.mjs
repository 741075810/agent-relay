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
        runId: RUN, status: 'submitted' },
      noticeVisible: { observed: true, source: 'chatgpt_visible_message', at: '2026-11-02T10:30:30Z',
        messageId: 'msg-777', conversationId: 'conv-55', runId: RUN },
      reviewed: { observed: true, source: 'chatgpt_review', at: '2026-11-02T10:35:00Z',
        reviewId: 'rev-1', taskId: TASK, runId: RUN },
      redispatched: { observed: true, source: 'bridge_ledger', at: '2026-11-02T10:36:00Z',
        taskId: 'tsk-192-next' },
    },
  };
  return { ...base, ...over, states: { ...base.states, ...(over.states || {}) } };
}

const judge = (rounds, extra = {}) => judgeRecord({ providerSessionId: SESSION, rounds, ...extra });
const withStage = (stage, patch) => round({ states: { [stage]: { ...round().states[stage], ...patch } } });

test('T191: a fully credentialed unattended round passes', () => {
  const report = judge([round()]);
  assert.equal(report.verdict, 'PASS', JSON.stringify(report.rounds[0]));
  assert.equal(report.unattended, true);
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
  const report = judge([withStage('noticeVisible', { runId: undefined, eventId: 'evt-9' })]);
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

  const viaTurn = judge([withStage('reviewed', { reviewId: undefined, turnId: 'turn-4' })]);
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
        taskId: 'tsk-192-next' },
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
        runId: `run-${n}` },
      noticeVisible: { observed: true, source: 'chatgpt_conversation_message',
        at: `2026-11-02T1${i}:30:30Z`, messageId: `msg-${n}`, conversationId: 'conv-55', runId: `run-${n}` },
      reviewed: { observed: true, source: 'chatgpt_review', at: `2026-11-02T1${i}:35:00Z`,
        reviewId: `rev-${n}`, taskId: `tsk-${n}`, runId: `run-${n}` },
      redispatched: { observed: true, source: 'bridge_ledger', at: `2026-11-02T1${i}:36:00Z`,
        taskId: `tsk-${n + 1}` },
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
      extensionSubmitted: { observed: true, source: 'extension_diagnostic', at: `2026-11-02T1${i}:30:05Z`, runId: `run-${n}` },
      noticeVisible: { observed: true, source: 'chatgpt_conversation_message', at: `2026-11-02T1${i}:30:30Z`,
        messageId: `msg-${n}`, conversationId: 'conv-55', runId: `run-${n}` },
      reviewed: { observed: true, source: 'chatgpt_review', at: `2026-11-02T1${i}:35:00Z`,
        reviewId: `rev-${n}`, taskId: `tsk-${n}`, runId: `run-${n}` },
      redispatched: { observed: true, source: 'bridge_ledger', at: `2026-11-02T1${i}:36:00Z`, taskId: `tsk-${n + 1}` },
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

test('T191: the report never claims this program observed the loop', () => {
  const report = judge([round()]);
  assert.match(report.note, /not that the loop was observed by this program/);
  assert.match(report.note, /no human/);
  assert.equal(judge([]).verdict, 'UNKNOWN');
});
