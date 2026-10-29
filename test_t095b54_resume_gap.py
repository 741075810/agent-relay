"""T095B-54: the invariants behind the manual-resume gap, locked as tests.

Context, because the tests are only meaningful with it: a run exists in the Bridge
ledger only when the Bridge itself issued `run/start` with a `requestID`. When the
operator stops a task in the DSH Desktop GUI and later presses Continue, the
Desktop resumes the native session in-process -- no Bridge RPC, so no new run is
recorded, and the run that was interrupted stays terminal (`runs.mjs` skips
terminal runs in `consume`/`consumeRun`, so it can never be revived either).

The reader must therefore stay silent about that resumed work. The danger this
file guards is the opposite behaviour: a future "fix" that treats the old
cancelled run as a completion, or that invents an identity for work the ledger
never recorded. Both are asserted impossible here, on the pure function, so the
tests need no ledger, no state directory and no host.

Run: python -B -W ignore::ResourceWarning -m unittest test_t095b54_resume_gap -v
"""
import unittest

import terminal_source as T

OLD = '116fbc4d-2c23-4993-88c4-e68775e2c46f'
NEW = '9b1d6f10-77c4-4a0e-9c1d-1f0d8a5e6b22'
T0 = 1793300000000        # the interrupted run
T1 = 1793300600000        # a later run in the same session


def run(request_id, status='completed', created=T0):
    return {'requestID': request_id, 'status': status, 'createdAt': created}


def state(acked=(), pending=(), baseline=()):
    return {'version': T.STATE_VERSION,
            'baselineIds': list(baseline),
            'pendingIds': list(pending),
            'ackedIds': list(acked),
            'baselineDropped': 0,
            'baselineCount': None}


def ids(items):
    return [item['runId'] for item in items]


class OnlyTheLedgerDecidesWhatCompleted(unittest.TestCase):
    def test_completed_is_reachable_only_from_a_completed_status(self):
        # A reason word such as `interrupted` must never be read upward.
        self.assertEqual(T.TERMINAL['completed'], 'completed')
        # T067R: `interrupted` is a failure, not a cancellation. The live machine
        # proves it: every ledger run marked `cancelled` that the Bridge database
        # also knows about is `failed` or `interrupted` there -- 9a9f4d17 is
        # `cancelled` in the ledger and `failed/desktop_event_invalid` in the Bridge.
        # Announcing that as "cancelled" told the operator they had stopped
        # something they never touched.
        self.assertEqual(T.TERMINAL['interrupted'], 'failed')
        self.assertEqual(T.TERMINAL['cancelled'], 'cancelled')
        self.assertEqual([k for k, v in T.TERMINAL.items() if v == 'completed'],
                         ['completed'])

    def test_a_running_run_is_not_terminal(self):
        due, _next, _info = T.candidates_from([run(NEW, 'running', T1)],
                                              state())
        self.assertEqual(due, [])


class TheInterruptedRunIsNeverReplayed(unittest.TestCase):
    def test_an_acknowledged_cancellation_is_not_offered_again(self):
        due, nxt, _info = T.candidates_from([run(OLD, 'cancelled')],
                                            state(acked=[OLD]))
        self.assertEqual(due, [])
        self.assertIn(OLD, nxt['ackedIds'])
        self.assertNotIn(OLD, nxt['pendingIds'])

    def test_a_session_that_only_ever_recorded_the_cancellation_yields_nothing(self):
        # This is the shape of the T53 gap: the ledger holds the interrupted run,
        # the resumed turn is absent, so there is exactly one terminal run and the
        # reader still offers nothing. Absence must not become a completion.
        due, _nxt, info = T.candidates_from([run(OLD, 'cancelled')],
                                            state(acked=[OLD]))
        self.assertEqual(due, [])
        self.assertEqual(info['existingTerminalRuns'], 1)


class TwoRunsStaySeparate(unittest.TestCase):
    def test_the_new_completion_is_offered_and_the_cancellation_is_not(self):
        due, _nxt, _info = T.candidates_from(
            [run(OLD, 'cancelled', T0), run(NEW, 'completed', T1)],
            state(acked=[OLD]))
        self.assertEqual(ids(due), [NEW])
        self.assertEqual(due[0]['status'], 'completed')

    def test_the_new_completion_notifies_once(self):
        runs = [run(OLD, 'cancelled', T0), run(NEW, 'completed', T1)]
        _due, nxt, _info = T.candidates_from(runs, state(acked=[OLD]))
        # Chrome acknowledged it, which is the only way an offer becomes history.
        acked_state = state(acked=nxt['ackedIds'] + [NEW])
        due, _nxt2, _info2 = T.candidates_from(runs, acked_state)
        self.assertEqual(due, [])

    def test_an_unacknowledged_offer_is_repeated_rather_than_lost(self):
        runs = [run(OLD, 'cancelled', T0), run(NEW, 'completed', T1)]
        _due, nxt, _info = T.candidates_from(runs, state(acked=[OLD]))
        self.assertEqual(nxt['pendingIds'], [NEW])
        due, _nxt2, info2 = T.candidates_from(runs, nxt)
        self.assertEqual(ids(due), [NEW])
        self.assertEqual(info2['redelivered'], 1)


class NoIdentityIsInvented(unittest.TestCase):
    def test_every_offered_id_comes_from_the_ledger(self):
        runs = [run(OLD, 'cancelled', T0), run(NEW, 'completed', T1)]
        due, _nxt, _info = T.candidates_from(runs, state(acked=[OLD]))
        known = {item['requestID'] for item in runs}
        for item in due:
            self.assertIn(item['runId'], known)

    def test_a_run_without_a_request_id_is_refused_not_repaired(self):
        # `read_runs` is the gate; the pure function would key on None. The ledger
        # read must refuse such an entry rather than manufacture an identity.
        import json
        import os
        import tempfile
        handle = tempfile.NamedTemporaryFile('w', suffix='.runs.json',
                                             delete=False, encoding='utf-8')
        path = handle.name
        try:
            json.dump([{'status': 'completed', 'createdAt': T0}], handle)
            handle.close()
            with self.assertRaises(T.SourceError):
                T.read_runs(path)
        finally:
            if not handle.closed:
                handle.close()
            os.unlink(path)


if __name__ == '__main__':
    unittest.main(verbosity=2)
