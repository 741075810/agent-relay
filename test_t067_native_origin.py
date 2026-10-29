"""T067R: channel B's only possible source, and the status a notice may claim.

What this suite is holding down
-------------------------------
1. A task a person starts directly in DSH Desktop is invisible to the Bridge
   ledger. If the sampler cannot see DSH's own `turn/end` records, channel B can
   never be offered -- which is the defect these tests exist to prevent.
2. An interrupted run is not a cancellation. The ledger says `cancelled` for the
   desktop event stream ending; the Bridge database says `failed`. The notice must
   say `failed`, or it tells the operator they stopped something they never touched.
3. The two channels must never both offer the same unit of work: the ledger stores
   the DSH `sessionID` and `turn` each run became, so the join is exact.
"""
import json
import os
import shutil
import tempfile
import time
import unittest

import native_turns
import terminal_source as T

try:
    import zstandard
except Exception:                                        # pragma: no cover
    zstandard = None

SESSION_A = 'session-11111111-1111-4111-8111-111111111111'
SESSION_B = 'session-22222222-2222-4222-8222-222222222222'
WORKSPACE = '--E-ApkTest--'


def write_log(root, session_id, records, workspace=WORKSPACE):
    """Write a real zstd session log, in the layout DSH uses."""
    folder = os.path.join(root, workspace, session_id)
    os.makedirs(folder, exist_ok=True)
    body = '\n'.join(json.dumps(rec, sort_keys=True) for rec in records) + '\n'
    path = os.path.join(folder, native_turns.LOG_NAME)
    with open(path, 'wb') as handle:
        handle.write(zstandard.ZstdCompressor().compress(body.encode('utf-8')))
    return path


def turn_records(turn, started, ended, reason):
    return [
        {'type': 'turn/start', 'seq': turn, 'time': started, 'data': {'turn': turn}},
        {'type': 'turn/end', 'seq': turn, 'time': ended,
         'data': {'turn': turn, 'reason': reason}},
    ]


def write_ledger(root, runs):
    folder = os.path.join(root, 'agentstate', 'a' * 64)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, 'endpoint.json.runs.json')
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(runs, handle)
    return path


def run(run_id, status, created, session=SESSION_A, turn=None):
    doc = {'requestID': run_id, 'status': status, 'createdAt': created,
           'sessionID': session}
    if turn is not None:
        doc['turn'] = turn
    return doc


@unittest.skipIf(zstandard is None, 'python-zstandard is not available')
class NativeTurnReading(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_a_terminal_turn_is_read_from_dsh_own_log(self):
        now = int(time.time() * 1000)
        write_log(self.root, SESSION_B, turn_records(
            7, now - 60000, now - 30000, {'kind': 'completed'}))
        report = native_turns.sample(self.root, now=now)
        self.assertTrue(report['ok'], report.get('error'))
        self.assertEqual(len(report['turns']), 1)
        turn = report['turns'][0]
        self.assertEqual(turn['turn'], 7)
        self.assertEqual(turn['status'], 'completed')
        self.assertEqual(turn['sessionId'], SESSION_B)
        self.assertEqual(turn['endedAt'], now - 30000)

    def test_a_provider_error_is_a_failure_not_a_cancellation(self):
        # DSH records the real thing: {"kind":"error","error":{...,"code":"..."}}.
        now = int(time.time() * 1000)
        write_log(self.root, SESSION_B, turn_records(
            8, now - 5000, now - 4000,
            {'kind': 'error', 'error': {'code': 'INVALID_REQUEST'}}))
        report = native_turns.sample(self.root, now=now)
        self.assertEqual(report['turns'][0]['status'], 'failed')
        self.assertEqual(report['turns'][0]['reasonKind'], 'error')

    def test_only_a_user_abort_countss_as_cancelled(self):
        self.assertEqual(native_turns.status_of(
            {'kind': 'aborted', 'reason': {'kind': 'user'}}), 'cancelled')
        # Stopped by something that is not a person: not a cancellation.
        self.assertEqual(native_turns.status_of({'kind': 'aborted'}), 'failed')
        self.assertEqual(native_turns.status_of(
            {'kind': 'aborted', 'reason': {'kind': 'service_restarted'}}), 'failed')
        self.assertEqual(native_turns.status_of({'kind': 'error'}), 'failed')
        # An unrecognised terminal reason is a failure, never a success.
        self.assertEqual(native_turns.status_of({'kind': 'something_new'}), 'failed')
        self.assertEqual(native_turns.status_of({'kind': 'completed'}), 'completed')
        self.assertIsNone(native_turns.status_of({}))
        self.assertIsNone(native_turns.status_of(None))

    def test_turns_older_than_the_horizon_are_not_offered(self):
        now = int(time.time() * 1000)
        write_log(self.root, SESSION_B, turn_records(
            9, now - 40 * 3600 * 1000, now - 39 * 3600 * 1000,
            {'kind': 'completed'}))
        report = native_turns.sample(self.root, now=now)
        self.assertTrue(report['ok'])
        self.assertEqual(report['turns'], [])

    def test_an_unreadable_root_is_reported_not_read_as_empty(self):
        report = native_turns.sample(os.path.join(self.root, 'nope'))
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'native_root_missing')
        # An empty-but-present root with no logs is also not "no turns".
        report = native_turns.sample(self.root)
        self.assertFalse(report['ok'])
        self.assertIn(report['code'], ('native_log_missing', 'native_unreadable'))

    def test_a_corrupt_log_does_not_take_the_reader_down(self):
        folder = os.path.join(self.root, WORKSPACE, SESSION_B)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, native_turns.LOG_NAME), 'wb') as handle:
            handle.write(b'not a zstd frame at all')
        report = native_turns.sample(self.root)
        # Nothing decoded, and it says so instead of claiming zero turns.
        self.assertFalse(report['ok'])
        self.assertEqual(report['turns'], [])

    def test_a_turn_still_classified_after_dedup(self):
        now = int(time.time() * 1000)
        write_log(self.root, SESSION_B, turn_records(
            10, now - 1000, now, {'kind': 'completed'})
            + turn_records(10, now - 1000, now - 500, {'kind': 'completed'}))
        report = native_turns.sample(self.root, now=now)
        self.assertEqual(len(report['turns']), 1)
        self.assertEqual(report['turns'][0]['endedAt'], now)


@unittest.skipIf(zstandard is None, 'python-zstandard is not available')
class ChannelSplit(unittest.TestCase):
    """The join, and the status the notice is allowed to claim."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, 'state')
        self.ledger = os.path.join(self.tmp, 'ledger')
        self.native = os.path.join(self.tmp, 'sessions')
        os.makedirs(self.state, exist_ok=True)
        os.makedirs(self.ledger, exist_ok=True)
        os.makedirs(self.native, exist_ok=True)
        self.now = int(time.time() * 1000)

    def offer(self, runs, facts=None):
        """Run two samples: the first absorbs history, the second offers new work."""
        write_ledger(self.ledger, runs)
        first = T.sample(self.state, self.ledger, bridge_db=self._absent_db(),
                         native_root=self.native)
        self.assertTrue(first['ok'], first.get('error'))
        return first

    def _absent_db(self):
        return os.path.join(self.tmp, 'no-such.sqlite')

    def test_a_direct_turn_is_discovered_and_needs_opt_in(self):
        # No ledger run at all -- this is the case the old code could not see.
        # Written *after* the baseline sample, because that is what "a new turn
        # appeared" means: at baseline time it did not exist yet.
        self.offer([])
        write_log(self.native, SESSION_B, turn_records(
            11, self.now - 90000, self.now - 60000, {'kind': 'completed'}))
        report = T.sample(self.state, self.ledger, bridge_db=self._absent_db(),
                          native_root=self.native)
        self.assertTrue(report['ok'])
        self.assertTrue(report['nativeOk'])
        self.assertEqual(len(report['candidates']), 1)
        candidate = report['candidates'][0]
        self.assertEqual(candidate['origin'], 'direct')
        self.assertEqual(candidate['status'], 'completed')
        self.assertEqual(candidate['nativeTurn'], 11)
        self.assertEqual(candidate['nativeSession'], SESSION_B)
        # The id must satisfy the extension's run-id check, or channel B could
        # never be admitted even after the operator clicked.
        import re
        self.assertRegex(candidate['runId'],
                         r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-'
                         r'[89ab][0-9a-f]{3}-[0-9a-f]{12}$')

    def test_a_turn_the_ledger_already_owns_is_never_offered_again(self):
        # Same (session, turn) on both sides: that is one unit of work, and the
        # ledger already covers it. Written after the baseline so the native turn
        # would otherwise be a fresh channel-B candidate.
        self.offer([run('3e44433c-0255-4413-9379-ad211bed1661', 'completed',
                        self.now - 95000, turn=12)])
        write_log(self.native, SESSION_A, turn_records(
            12, self.now - 90000, self.now - 60000, {'kind': 'completed'}))
        report = T.sample(self.state, self.ledger, bridge_db=self._absent_db(),
                          native_root=self.native)
        self.assertTrue(report['ok'])
        self.assertEqual(report['candidates'], [],
                         'the ledger already covers this turn')
        self.assertEqual(report['nativeTurns'], 1)

    def test_the_ledger_status_is_overruled_by_the_bridge_record(self):
        # The live shape: ledger says cancelled, bridge says failed/event invalid.
        run_id = '9a9f4d17-e457-47b9-b4ac-7e6efb1b8f0e'
        db = os.path.join(self.tmp, 'bridge.sqlite')
        self._make_bridge_db(db, {run_id: ('failed', 'desktop_event_invalid')})
        self.offer([])
        write_ledger(self.ledger, [run(run_id, 'cancelled', self.now - 60000,
                                       turn=153)])
        report = T.sample(self.state, self.ledger, bridge_db=db,
                          native_root=self.native)
        self.assertTrue(report['ok'], report.get('error'))
        self.assertEqual(len(report['candidates']), 1)
        self.assertEqual(report['candidates'][0]['status'], 'failed',
                         'a provider failure must not be announced as cancelled')
        self.assertEqual(report['statusOverrides'], 1)

    def test_an_interrupted_run_is_a_failure(self):
        run_id = '4a23e76c-0000-4000-8000-000000000001'
        db = os.path.join(self.tmp, 'bridge.sqlite')
        self._make_bridge_db(db, {run_id: ('interrupted', None)})
        self.offer([])
        write_ledger(self.ledger, [run(run_id, 'cancelled', self.now - 60000,
                                       turn=128)])
        report = T.sample(self.state, self.ledger, bridge_db=db,
                          native_root=self.native)
        self.assertEqual(report['candidates'][0]['status'], 'failed')

    def test_a_genuine_completion_still_says_completed(self):
        run_id = '3e44433c-0255-4413-9379-ad211bed1661'
        db = os.path.join(self.tmp, 'bridge.sqlite')
        self._make_bridge_db(db, {run_id: ('completed', None)})
        self.offer([])
        write_ledger(self.ledger, [run(run_id, 'completed', self.now - 60000,
                                       turn=149)])
        report = T.sample(self.state, self.ledger, bridge_db=db,
                          native_root=self.native)
        self.assertEqual(report['candidates'][0]['status'], 'completed')
        self.assertEqual(report['statusOverrides'], 0)

    def test_without_the_bridge_record_the_ledger_still_answers(self):
        run_id = '116fbc4d-0000-4000-8000-000000000002'
        self.offer([])
        write_ledger(self.ledger, [run(run_id, 'cancelled', self.now - 60000,
                                       turn=134)])
        report = T.sample(self.state, self.ledger, bridge_db=self._absent_db(),
                          native_root=self.native)
        # No bridge row: nothing to overrule, and the fallback is named.
        self.assertEqual(report['candidates'][0]['status'], 'cancelled')
        self.assertIsNotNone(report['factsError'])

    def test_a_missing_native_root_leaves_channel_a_working(self):
        write_ledger(self.ledger, [run('a' * 8 + '-0000-4000-8000-000000000003',
                                       'completed', self.now - 60000, turn=5)])
        T.sample(self.state, self.ledger, bridge_db=self._absent_db(),
                 native_root=self.native)
        write_ledger(self.ledger, [
            run('a' * 8 + '-0000-4000-8000-000000000003', 'completed',
                self.now - 60000, turn=5),
            run('b' * 8 + '-0000-4000-8000-000000000004', 'completed',
                self.now - 50000, turn=6)])
        report = T.sample(self.state, self.ledger, bridge_db=self._absent_db(),
                          native_root=os.path.join(self.tmp, 'gone'))
        self.assertTrue(report['ok'])
        self.assertFalse(report['nativeOk'])
        self.assertEqual(report['nativeCode'], 'native_root_missing')
        self.assertEqual(len(report['candidates']), 1)
        self.assertEqual(report['candidates'][0]['runId'][:8], 'b' * 8)

    def _make_bridge_db(self, path, facts):
        import sqlite3
        conn = sqlite3.connect(path)
        conn.execute('create table bridge_service_tasks ('
                     'task_id text, provider_run_id text, status text, '
                     'failure_code text)')
        for run_id, (status, failure) in facts.items():
            conn.execute('insert into bridge_service_tasks values (?,?,?,?)',
                         ('tsk-' + run_id[:8], run_id, status, failure))
        conn.commit()
        conn.close()


class NativeIdentifier(unittest.TestCase):
    def test_a_turn_always_gets_the_same_id(self):
        first = T.native_run_id(SESSION_A, 151)
        self.assertEqual(first, T.native_run_id(SESSION_A, 151))
        self.assertNotEqual(first, T.native_run_id(SESSION_A, 152))
        self.assertNotEqual(first, T.native_run_id(SESSION_B, 151))

    def test_the_identifier_cannot_collide_with_a_bridge_run(self):
        # Bridge ids are uuids too, so collisions are only prevented by derivation
        # being a different function -- this documents the assumption.
        self.assertNotEqual(T.native_run_id(SESSION_A, 1),
                            '00000000-0000-4000-8000-000000000000')


if __name__ == '__main__':
    unittest.main()
