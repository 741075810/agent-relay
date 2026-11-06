"""T267: one run, two terminal events -- the later kind must still be usable as evidence.

The defect this pins, reproduced before the fix. A Bridge task can be interrupted and then finish anyway: the Bridge
writes `task.interrupted`, DSH keeps working, and a later `task.completed` lands for the same task. That is exactly
the shape T265/T266 were about (Bridge terminal `interrupted` while the native session kept producing work).

`run_origin.read_terminal_times` used to keep a single event per run -- the earliest one -- and
`completion_for_status` compared the resolved status against that single kind. So:

  * the resolved status became `completed` (the Bridge's latest fact), but the only recorded kind was
    `task.interrupted`, which does not justify `completed`;
  * the instant was therefore dropped, the mirror reported `completedAt: null`,
  * and the relay -- which will not decide a run without a credible instant -- deferred it for ever, unannounced.

The fix keeps the earliest instant *per kind* and lets the status choose among the kinds that justify it.

Two properties must survive, and are asserted below:

  * a contradicting kind is still not evidence (`task.interrupted` alone never justifies `completed`);
  * the chosen instant is never the *later* of two agreeing kinds, so a fix like this cannot make a run look newer
    than it is and slip past a consent boundary.

Everything is hermetic: a real SQLite database with the live schema and a real ledger file in temporary directories,
driven through the shipping `terminal_source.mirror` and `run_origin` / `relay_merge` functions.
"""

import json
import os
import sqlite3
import tempfile
import unittest

import relay_merge
import run_origin
import terminal_source as T

RUN = 'bb22cc33-dd44-4e55-8f66-aa7788990011'
START_MS = 1793450000000
INTERRUPT_SECONDS = 1793453704.945753      # the interruption
INTERRUPT_MS = 1793453704946
COMPLETE_SECONDS = 1793457001.5            # the later completion of the same run
COMPLETE_MS = 1793457001500


def build_bridge_db(path, run_id, task_status, events):
    """`events` is a list of `(kind, created_at_seconds)`; the live schema, nothing else."""
    conn = sqlite3.connect(path)
    conn.executescript(
        'create table bridge_service_tasks (task_id TEXT primary key, status TEXT, provider_run_id TEXT, '
        'failure_code TEXT, created_at REAL, updated_at REAL);'
        'create table bridge_service_task_events (event_id integer primary key autoincrement, task_id TEXT, '
        'kind TEXT, summary TEXT, details TEXT, created_at REAL);')
    conn.execute('insert into bridge_service_tasks (task_id, status, provider_run_id, failure_code, created_at, '
                 'updated_at) values (?,?,?,?,?,?)',
                 ('tsk-01', task_status, run_id, None, START_MS / 1000.0, START_MS / 1000.0 + 600))
    for kind, at in events:
        conn.execute('insert into bridge_service_task_events (task_id, kind, summary, created_at) values (?,?,?,?)',
                     ('tsk-01', kind, 'fixture', at))
    conn.commit()
    conn.close()


class TwoEvents(unittest.TestCase):
    """`read_terminal_times` keeps per-kind instants; `completion_evidence` picks by status."""

    def setUp(self):
        self.db = os.path.join(tempfile.mkdtemp(prefix='t267-db-'), 'service.sqlite')

    def times(self, events, status='completed'):
        build_bridge_db(self.db, RUN, status, events)
        times, error = run_origin.read_terminal_times(self.db)
        self.assertIsNone(error)
        return times

    def test_the_later_kind_is_reachable(self):
        times = self.times([('task.interrupted', INTERRUPT_SECONDS), ('task.completed', COMPLETE_SECONDS)])
        # The single-event fields keep their old meaning: when this run first became terminal, and by what.
        self.assertEqual(times[RUN]['completedAtMs'], INTERRUPT_MS)
        self.assertEqual(times[RUN]['event'], 'task.interrupted')
        self.assertEqual(times[RUN]['events'], 2)
        # The resolved status is what the rest of the system announces, and its evidence is the completing event.
        self.assertEqual(T.resolve_status('running', {'status': 'completed'}), 'completed')
        self.assertEqual(run_origin.completion_evidence(RUN, 'completed', times), (COMPLETE_MS, 'task.completed'))
        self.assertEqual(run_origin.completion_for_status(RUN, 'completed', times), COMPLETE_MS)

    def test_a_failed_status_still_uses_the_earlier_interruption(self):
        # `failed` absorbs `interrupted`, so both kinds justify it; the earliest must win, never the later one.
        times = self.times([('task.interrupted', INTERRUPT_SECONDS), ('task.completed', COMPLETE_SECONDS)],
                           status='interrupted')
        self.assertEqual(run_origin.completion_evidence(RUN, 'failed', times),
                         (INTERRUPT_MS, 'task.interrupted'))

    def test_a_contradicting_kind_is_still_not_evidence(self):
        times = self.times([('task.interrupted', INTERRUPT_SECONDS)], status='completed')
        self.assertEqual(run_origin.completion_evidence(RUN, 'completed', times), (None, None))
        self.assertIsNone(run_origin.completion_for_status(RUN, 'completed', times))

    def test_one_event_behaves_exactly_as_before(self):
        times = self.times([('task.completed', COMPLETE_SECONDS)])
        self.assertEqual(run_origin.completion_evidence(RUN, 'completed', times), (COMPLETE_MS, 'task.completed'))
        self.assertEqual(times[RUN]['kinds'], {'task.completed': COMPLETE_MS})

    def test_a_run_with_no_event_stays_unknown(self):
        times = self.times([])
        self.assertEqual(times, {})
        self.assertEqual(run_origin.completion_evidence(RUN, 'completed', times), (None, None))


class MirrorReportsIt(unittest.TestCase):
    """The real mirror path, with a real ledger and a real database in temporary directories."""

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t267-state-')
        self.root = tempfile.mkdtemp(prefix='t267-ledger-')
        self.db = os.path.join(tempfile.mkdtemp(prefix='t267-bridge-'), 'service.sqlite')
        sub = os.path.join(self.root, 'e' * 64)
        os.makedirs(sub)
        self.ledger = os.path.join(sub, 'endpoint.json.runs.json')
        with open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump([{
                'requestID': RUN, 'createdAt': START_MS, 'status': 'running',
                'turn': 9, 'sessionID': 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            }], handle)

    def candidate(self, events, status):
        build_bridge_db(self.db, RUN, status, events)
        report = T.mirror(self.state, root=self.root, bridge_db=self.db)
        self.assertTrue(report['ok'], report)
        self.assertEqual(len(report['candidates']), 1)
        return report['candidates'][0], report['counts']

    def test_the_resumed_run_carries_the_completion_and_its_own_provenance(self):
        candidate, counts = self.candidate(
            [('task.interrupted', INTERRUPT_SECONDS), ('task.completed', COMPLETE_SECONDS)], 'completed')
        self.assertEqual(candidate['status'], 'completed')
        self.assertEqual(candidate['completedAt'], COMPLETE_MS)
        self.assertEqual(candidate['completedAtSource'], 'bridge.task_events.task.completed')
        self.assertEqual(counts['completedAtKnown'], 1)
        self.assertEqual(counts['completedAtUnknown'], 0)

    def test_the_consumer_can_now_decide_it(self):
        candidate, _ = self.candidate(
            [('task.interrupted', INTERRUPT_SECONDS), ('task.completed', COMPLETE_SECONDS)], 'completed')
        # The same two conditions the relay fusion uses; before the fix both were false and the run was deferred for
        # ever, so no notice could ever be produced for it.
        self.assertEqual(relay_merge.completed_ms(candidate), COMPLETE_MS)
        self.assertTrue(relay_merge.completion_source_ok(candidate))
        self.assertEqual(relay_merge.trusted_completed_ms(candidate), COMPLETE_MS)

    def test_an_interrupted_only_run_reports_the_interruption(self):
        candidate, _ = self.candidate([('task.interrupted', INTERRUPT_SECONDS)], 'interrupted')
        self.assertEqual(candidate['status'], 'failed')
        self.assertEqual(candidate['completedAt'], INTERRUPT_MS)
        self.assertEqual(candidate['completedAtSource'], 'bridge.task_events.task.interrupted')


if __name__ == '__main__':
    unittest.main()
