// T190: the acceptance checker's own tests. Every case is a *record*, not a live observation -- the point of the
// tool is to refuse a record that cannot support the claim, so the negative cases matter more than the pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeRecord } from './tools/continuation/bridge_loop_acceptance.mjs';

const SESSION = 'session-644cd4ce-7fe7-432e-b48e-33eef537214b';

function round(over = {}) {
  const base = {
    round: 190,
    providerSessionId: SESSION,
    taskId: 'tsk-15e55a61-6197-4ebc-8a04-e613066982fc',
    runId: '0266f468-20c6-458e-9da4-07e172efbb75',
    startedAt: '2026-11-02T10:00:00Z',
    completedAt: '2026-11-02T10:30:00Z',
    states: {
      taskCompleted: { observed: true, source: 'bridge_ledger', at: '2026-11-02T10:30:00Z' },
      extensionSubmitted: { observed: true, source: 'extension_diagnostic', at: '2026-11-02T10:30:05Z',
        status: 'submitted' },
      noticeVisible: { observed: true, source: 'chatgpt_operator_confirmation', at: '2026-11-02T10:30:30Z' },
      reviewed: { observed: true, source: 'chatgpt_review', at: '2026-11-02T10:35:00Z' },
      redispatched: { observed: true, source: 'bridge_ledger', at: '2026-11-02T10:36:00Z',
        taskId: 'tsk-191-new-task' },
    },
  };
  return { ...base, ...over, states: { ...base.states, ...(over.states || {}) } };
}

test('T190: a complete, self-consistent round passes', () => {
  const report = judgeRecord({ providerSessionId: SESSION, rounds: [round()] });
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.rounds[0].verdict, 'PASS');
});

test('T190: a host ack is not a visible notice, so a missing notice fails', () => {
  const report = judgeRecord({
    providerSessionId: SESSION,
    rounds: [round({ states: {
      noticeVisible: { observed: true, source: 'host_ack', at: '2026-11-02T10:30:30Z' },
    } })],
  });
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.rounds[0].problems.join(','), /noticeVisible:wrong_source\(host_ack\)/);
});

test('T190: a round with no independent review fails', () => {
  const report = judgeRecord({
    providerSessionId: SESSION,
    rounds: [round({ states: { reviewed: { observed: false, source: 'chatgpt_review' } } })],
  });
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.rounds[0].problems.join(','), /reviewed:reported_false/);
});

test('T190: a different provider session fails, and an absent one is unknown', () => {
  const wrong = judgeRecord({
    providerSessionId: SESSION,
    rounds: [round({ providerSessionId: 'session-00000000-0000-0000-0000-000000000000' })],
  });
  assert.equal(wrong.verdict, 'FAIL');
  assert.match(wrong.rounds[0].problems.join(','), /session:mismatch/);

  const absent = judgeRecord({ providerSessionId: SESSION,
    rounds: [round({ providerSessionId: undefined })] });
  assert.equal(absent.verdict, 'UNKNOWN');
  assert.match(absent.rounds[0].unknowns.join(','), /session:absent/);
});

test('T190: a duplicated run or task fails', () => {
  const two = [round(), round({ round: 191, startedAt: '2026-11-02T11:00:00Z',
    completedAt: '2026-11-02T11:30:00Z' })];
  const report = judgeRecord({ providerSessionId: SESSION, rounds: two });
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.problems.join(','), /duplicate_run:/);
  assert.match(report.problems.join(','), /duplicate_task:/);
});

test('T190: overlapping run windows fail', () => {
  const two = [
    round({ completedAt: '2026-11-02T10:30:00Z' }),
    round({ round: 191, runId: 'run-191', taskId: 'tsk-191',
      startedAt: '2026-11-02T10:20:00Z', completedAt: '2026-11-02T10:50:00Z' }),
  ];
  const report = judgeRecord({ providerSessionId: SESSION, rounds: two });
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.problems.join(','), /overlap:190\/191/);
});

test('T190: fixture sources can never be read as real evidence', () => {
  const report = judgeRecord({
    providerSessionId: SESSION,
    rounds: [round({ states: {
      noticeVisible: { observed: true, source: 'fixture', at: '2026-11-02T10:30:30Z' },
    } })],
  });
  assert.equal(report.verdict, 'UNKNOWN', 'a fixture is missing evidence, not a failed run');
  assert.match(report.rounds[0].unknowns.join(','), /noticeVisible:fixture_evidence/);
});

test('T190: stages observed out of order fail, and an empty record is unknown', () => {
  const outOfOrder = judgeRecord({
    providerSessionId: SESSION,
    rounds: [round({ states: {
      noticeVisible: { observed: true, source: 'chatgpt_operator_confirmation', at: '2026-11-02T09:00:00Z' },
    } })],
  });
  assert.equal(outOfOrder.verdict, 'FAIL');
  assert.match(outOfOrder.rounds[0].problems.join(','), /chain:out_of_order/);

  const empty = judgeRecord({ providerSessionId: SESSION, rounds: [] });
  assert.equal(empty.verdict, 'UNKNOWN');
});

test('T190: a re-dispatch that does not lead to the next round fails', () => {
  const two = [
    round(),
    round({ round: 191, runId: 'run-191', taskId: 'tsk-different',
      startedAt: '2026-11-02T11:00:00Z', completedAt: '2026-11-02T11:30:00Z' }),
  ];
  const report = judgeRecord({ providerSessionId: SESSION, rounds: two });
  assert.equal(report.verdict, 'FAIL');
  assert.match(report.problems.join(','), /redispatch:does_not_lead_to_round_191/);
});

test('T190: the report never claims the program observed the loop itself', () => {
  const report = judgeRecord({ providerSessionId: SESSION, rounds: [round()] });
  assert.match(report.note, /not that the loop was observed by this program/);
});
