"""T266: an interrupted Bridge task must keep its own completion instant, and the relay must trust it.

The defect this pins, reproduced before the fix. `terminal_source.resolve_status` maps a Bridge fact
`interrupted` to the announceable status `failed` (see `FACT_TO_STATUS`, and `relay_service.mjs`'s note that
`interrupted` is never a status the service may receive). `run_origin.completion_for_status` then looked the
instant up with a *single* expected event per status -- `failed -> task.failed` -- so the Bridge's own
`task.interrupted` row was treated as a contradiction and the instant was thrown away.

Consequence, end to end: `terminal-mirror` reports `completedAt: null, completedAtSource: unknown` for exactly
the runs the Bridge proved it knew ended; the sidecar fills nothing in; the host's relay fusion then sees
`evidence is None`, refuses the run as `relay_unverified` and defers it for ever. An interrupted task is
therefore indistinguishable from a task nobody can account for, and no notice is ever produced -- which is the
observed T265 shape (Bridge task interrupted, no final report, no notice, while the work continued).

The invariant that must survive: an event that *contradicts* the resolved status is still not evidence. That is
why `task.completed` next to `failed` stays unknown below, and why `task.interrupted` is only accepted for the
status the same table maps an interruption to.

Everything here is hermetic: a real SQLite database with the live schema in a temporary directory, a real
ledger file, and the real `terminal_source.mirror_report` / `relay_merge` functions. No production path is read.
"""

import json
import os
import sqlite3
import tempfile
import unittest

import relay_merge
import run_origin
import terminal_source as T

RUN = 'aa11bb22-cc33-4d44-8e55-ff6677889900'
EVENT_SECONDS = 1793453704.945753
EVENT_MS = 1793453704946
OLD_START_MS = 1700000000000


def build_bridge_db(path, rows):
    """`rows` is `(run_id, task_status, event_kind, created_at)`; `event_kind=None` means no terminal event."""
    conn = sqlite3.connect(path)
    conn.executescript(
        'create table bridge_service_tasks (task_id TEXT primary key, status TEXT, provider_run_id TEXT, '
        'failure_code TEXT, created_at REAL, updated_at REAL);'
        'create table bridge_service_task_events (event_id integer primary key autoincrement, task_id TEXT, '
        'kind TEXT, summary TEXT, details TEXT, created_at REAL);')
    for index, (run_id, status, kind, at) in enumerate(rows):
        task_id = 'tsk-%02d' % index
        conn.execute('insert into bridge_service_tasks (task_id, status, provider_run_id, failure_code, '
                     'created_at, updated_at) values (?,?,?,?,?,?)',
                     (task_id, status, run_id, None, OLD_START_MS / 1000.0, (OLD_START_MS / 1000.0) + 60))
        if kind is not None:
            conn.execute('insert into bridge_service_task_events (task_id, kind, summary, created_at) '
                         'values (?,?,?,?)', (task_id, kind, 'fixture', at))
    conn.commit()
    conn.close()


class InterruptedInstant(unittest.TestCase):
    """`completion_for_status` must accept the event that justifies the status it was resolved to."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='t266-db-')
        self.db = os.path.join(self.tmp, 'service.sqlite')

    def test_an_interrupted_task_keeps_the_instant_the_bridge_wrote(self):
        build_bridge_db(self.db, [(RUN, 'interrupted', 'task.interrupted', EVENT_SECONDS)])
        times, error = run_origin.read_terminal_times(self.db)
        self.assertIsNone(error)
        self.assertEqual(times[RUN]['event'], 'task.interrupted')
        # The status the rest of the system announces for this run.
        self.assertEqual(T.resolve_status('completed', {'status': 'interrupted'}), 'failed')
        self.assertEqual(run_origin.completion_for_status(RUN, 'failed', times), EVENT_MS)

    def test_a_contradicting_event_is_still_not_evidence(self):
        # Unchanged by this fix: a `task.completed` event next to a `failed` status proves nothing.
        build_bridge_db(self.db, [(RUN, 'failed', 'task.completed', EVENT_SECONDS)])
        times, _ = run_origin.read_terminal_times(self.db)
        self.assertIsNone(run_origin.completion_for_status(RUN, 'failed', times))

    def test_an_interruption_event_does_not_justify_completed(self):
        build_bridge_db(self.db, [(RUN, 'interrupted', 'task.interrupted', EVENT_SECONDS)])
        times, _ = run_origin.read_terminal_times(self.db)
        self.assertIsNone(run_origin.completion_for_status(RUN, 'completed', times))


class MirrorReportsIt(unittest.TestCase):
    """The real mirror path: a real ledger, a real Bridge database, the shipping `mirror_report`."""

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t266-state-')
        self.root = tempfile.mkdtemp(prefix='t266-ledger-')
        self.db = os.path.join(tempfile.mkdtemp(prefix='t266-bridge-'), 'service.sqlite')
        sub = os.path.join(self.root, 'd' * 64)
        os.makedirs(sub)
        self.ledger = os.path.join(sub, 'endpoint.json.runs.json')
        with open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump([{
                'requestID': RUN, 'createdAt': OLD_START_MS, 'status': 'completed',
                'turn': 4, 'sessionID': 'session-644cd4ce-7fe7-432e-b48e-33eef537214b',
            }], handle)

    def report(self):
        return T.mirror(self.state, root=self.root, bridge_db=self.db)

    def test_the_candidate_carries_the_instant_and_the_interruption_provenance(self):
        build_bridge_db(self.db, [(RUN, 'interrupted', 'task.interrupted', EVENT_SECONDS)])
        report = self.report()
        self.assertTrue(report['ok'], report)
        self.assertEqual(len(report['candidates']), 1)
        candidate = report['candidates'][0]
        # The status is the announceable one, exactly as before this fix.
        self.assertEqual(candidate['status'], 'failed')
        # The instant and its provenance are what the fix restores.
        self.assertEqual(candidate['completedAt'], EVENT_MS)
        self.assertEqual(candidate['completedAtSource'], 'bridge.task_events.task.interrupted')
        self.assertEqual(report['counts']['completedAtKnown'], 1)
        self.assertEqual(report['counts']['completedAtUnknown'], 0)

    def test_a_run_with_no_terminal_event_still_reports_unknown(self):
        build_bridge_db(self.db, [(RUN, 'interrupted', None, None)])
        candidate = self.report()['candidates'][0]
        self.assertEqual(candidate['status'], 'failed')
        self.assertIsNone(candidate['completedAt'])
        self.assertEqual(candidate['completedAtSource'], 'unknown')

    def test_the_mirror_output_satisfies_the_relay_decision(self):
        """The two conditions `terminal_source` uses to decide `deferred` from `announce`/`history`, on real output.

        Before the fix both were false (no instant, and the provenance would have been refused anyway), so the run
        landed in `relayDeferredIds` and could never leave it. Here the same candidate clears both.
        """
        build_bridge_db(self.db, [(RUN, 'interrupted', 'task.interrupted', EVENT_SECONDS)])
        candidate = self.report()['candidates'][0]
        self.assertEqual(relay_merge.completed_ms(candidate), EVENT_MS)
        self.assertTrue(relay_merge.completion_source_ok(candidate))
        self.assertEqual(relay_merge.trusted_completed_ms(candidate), EVENT_MS)
        # Consent is still decided by the instant, not by the fix: earlier than the arm boundary is history.
        self.assertLessEqual(relay_merge.trusted_completed_ms(candidate), EVENT_MS)


class RelayTrustsIt(unittest.TestCase):
    """The consumer side: `completion_source_ok` must agree with the same fact table."""

    def item(self, status, source):
        return {'status': status, 'completedAtSource': source, 'completedAt': EVENT_MS}

    def test_an_interruption_event_is_trusted_for_failed(self):
        self.assertTrue(relay_merge.completion_source_ok(
            self.item('failed', 'bridge.task_events.task.interrupted')))
        self.assertEqual(relay_merge.trusted_completed_ms(
            self.item('failed', 'bridge.task_events.task.interrupted')), EVENT_MS)

    def test_the_previous_answers_are_unchanged(self):
        self.assertTrue(relay_merge.completion_source_ok(
            self.item('completed', 'bridge.task_events.task.completed')))
        self.assertTrue(relay_merge.completion_source_ok(
            self.item('failed', 'bridge.task_events.task.failed')))
        self.assertFalse(relay_merge.completion_source_ok(
            self.item('completed', 'bridge.task_events.task.interrupted')))
        self.assertFalse(relay_merge.completion_source_ok(
            self.item('failed', 'bridge.task_events.task.completed')))
        self.assertFalse(relay_merge.completion_source_ok(self.item('failed', 'unknown')))
        self.assertFalse(relay_merge.completion_source_ok({'status': 'failed'}))
        self.assertFalse(relay_merge.completion_source_ok(None))


if __name__ == '__main__':
    unittest.main()
