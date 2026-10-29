"""T068: deciding about a task while it is still running.

The defect this suite guards: T067 could only list tasks that had already ended, so a
task that runs for an hour was invisible for that hour and the whole point of the
feature -- "tell me when this finishes, I'm going to walk away" -- was unavailable
until it was too late.

Three properties are load-bearing and each is tested here:

  * a running turn is discovered from DSH's own log and excluded from channel A by
    the ledger's `(sessionID, turn)`, never by time or by prompt text;
  * the offer fails closed -- an unreadable ledger or an unreadable session log
    produces `ok: False` with a code, never a silent empty list;
  * a turn that stopped mid-log (host killed before `turn/end`) does not stay
    "running" forever.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import native_turns                                                   # noqa: E402
import terminal_source                                                # noqa: E402

try:
    import zstandard
except Exception:                                                     # pragma: no cover
    zstandard = None

# T095B77: SESSION_DIR was a real DSH session id copied out of the operator's own
# machine, and BRIDGE_SESSION kept a real-looking first two groups with a fabricated
# tail. Both are fixtures -- they name a temporary directory and are compared to
# themselves -- so they can be synthetic without weakening a single assertion. The
# published-repository scan now looks for `session-<uuid>` precisely because this gate
# claimed to protect against identifiers and did not look for the commonest one here.
SESSION_DIR = 'session-cccccccc-0000-4000-8000-000000000068'
BRIDGE_SESSION = 'session-dddddddd-0000-4000-8000-000000000069'
DIRECT_SESSION = 'session-11111111-2222-4333-8444-555555555555'
WORKSPACE = '--E-ApkTest--'
BASE_MS = 1793260000000


def encode(text):
    return zstandard.ZstdCompressor().compress(text.encode('utf-8'))


def rec(kind, seq, time_ms, data):
    return json.dumps({'type': kind, 'seq': seq, 'time': time_ms, 'data': data})


def write_log(root, session, records):
    directory = os.path.join(root, WORKSPACE, session)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, native_turns.LOG_NAME)
    with open(path, 'wb') as handle:
        handle.write(encode('\n'.join(records) + '\n'))
    return path


def start(turn, time_ms):
    return rec('turn/start', turn * 10, time_ms, {'turn': turn})


def end(turn, time_ms, reason=None):
    return rec('turn/end', turn * 10 + 1, time_ms,
               {'turn': turn, 'reason': reason or {'kind': 'completed'}})


def activity(turn, time_ms, kind='tool/call'):
    return rec(kind, turn * 10 + 2, time_ms, {'turn': turn, 'payload': {}})


def write_ledger(path, runs):
    # The real ledger is a flat list and `read_runs` validates `requestID` +
    # `createdAt` on every entry, so the fixture has to satisfy the same contract --
    # a test that only needs `sessionID`/`turn` must still be a ledger the product
    # would accept, otherwise it proves nothing about the product's own reading.
    entries = []
    for index, run in enumerate(runs):
        entries.append({
            'requestID': run.get('runId') or ('req-%d' % index),
            'createdAt': run.get('createdAt', BASE_MS // 1000),
            'sessionID': run.get('sessionID'),
            'turn': run.get('turn'),
            'status': run.get('status', 'completed'),
        })
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(entries, handle)


@unittest.skipIf(zstandard is None, 'python-zstandard is not installed')
class RunningDetection(unittest.TestCase):
    """The reader side: what DSH's own log proves about a turn in flight."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t068-native-')
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_a_turn_without_an_end_is_reported_running(self):
        write_log(self.root, SESSION_DIR, [
            start(154, BASE_MS),
            end(154, BASE_MS + 1000),
            start(155, BASE_MS + 2000),
            activity(155, BASE_MS + 3000),
        ])
        report = native_turns.sample(self.root, now=BASE_MS + 4000)
        self.assertTrue(report['ok'])
        self.assertEqual([item['turn'] for item in report['running']], [155])
        running = report['running'][0]
        self.assertEqual(running['sessionId'], SESSION_DIR)
        self.assertEqual(running['startedAt'], BASE_MS + 2000)
        self.assertEqual(running['evidence'], 'turn_start')
        self.assertEqual(running['activityCount'], 1)

    def test_a_turn_with_an_end_is_not_running(self):
        write_log(self.root, SESSION_DIR, [
            start(1, BASE_MS), end(1, BASE_MS + 1000),
        ])
        report = native_turns.sample(self.root, now=BASE_MS + 2000)
        self.assertTrue(report['ok'])
        self.assertEqual(report['running'], [])
        self.assertEqual(len(report['turns']), 1)

    def test_an_old_unfinished_turn_is_not_running_when_a_later_one_started(self):
        # Turn 10 has no `turn/end` in the window; turn 11 does. Turn 10 therefore
        # ended before the window began, and reporting it as running would be a lie
        # that never expires.
        write_log(self.root, SESSION_DIR, [
            activity(10, BASE_MS),
            start(11, BASE_MS + 5000),
            end(11, BASE_MS + 6000),
        ])
        report = native_turns.sample(self.root, now=BASE_MS + 7000)
        self.assertEqual(report['running'], [])

    def test_a_long_turn_is_visible_after_its_start_scrolled_out(self):
        # The tail window cuts everything before the last tool calls: there is no
        # `turn/start` for turn 155 at all, only in-turn activity. It must still be
        # reported, with `startedAt: None` -- an unknown start, not a guessed one.
        records = [start(154, BASE_MS), end(154, BASE_MS + 1000)]
        records += [activity(155, BASE_MS + 2000 + i * 1000) for i in range(5)]
        write_log(self.root, SESSION_DIR, records)
        report = native_turns.sample(self.root, now=BASE_MS + 8000)
        running = report['running']
        self.assertEqual(len(running), 1)
        self.assertEqual(running[0]['turn'], 155)
        self.assertIsNone(running[0]['startedAt'])
        self.assertEqual(running[0]['evidence'], 'activity_only')
        self.assertEqual(running[0]['observedSince'], BASE_MS + 2000)

    def test_a_turn_stuck_mid_log_stops_being_reported(self):
        path = write_log(self.root, SESSION_DIR, [
            start(155, BASE_MS), activity(155, BASE_MS + 1000),
        ])
        fresh = native_turns.sample(self.root, now=BASE_MS + 2000)
        self.assertEqual(len(fresh['running']), 1)
        # The file is still freshly *written* (mtime now) but the turn's own newest
        # evidence is a day old. mtime alone would keep reporting this turn forever;
        # the record's own timestamp is what stops it.
        import os as _os
        _os.utime(path, None)
        stale = native_turns.sample(
            self.root, now=BASE_MS + native_turns.RUNNING_MAX_AGE_MS + 2000)
        self.assertEqual(stale['running'], [])
        self.assertEqual(stale['runningStale'], 1)
        # Past the horizon the file is not even opened -- cheaper, and stricter.
        gone = native_turns.sample(
            self.root, now=BASE_MS + native_turns.HORIZON_MS
            + native_turns.MTIME_SLACK_MS + 60000)
        self.assertEqual(gone['running'], [])

    def test_the_running_list_is_bounded(self):
        records = []
        directory = os.path.join(self.root)
        for index in range(native_turns.MAX_RUNNING + 5):
            records.append(start(100 + index,
                                 BASE_MS + index * 10))
            records.append(activity(100 + index, BASE_MS + index * 10 + 5))
            name = 'session-%08d-2222-4333-8444-555555555555' % index
            write_log(directory, name, records)
            records = []
        report = native_turns.sample(self.root, now=BASE_MS + 10 * 1000)
        self.assertLessEqual(len(report['running']), native_turns.MAX_RUNNING)

    def test_the_newest_running_turn_is_listed_first(self):
        write_log(self.root, 'session-aaaaaaaa-2222-4333-8444-555555555555', [
            start(1, BASE_MS), activity(1, BASE_MS + 1000),
        ])
        write_log(self.root, 'session-bbbbbbbb-2222-4333-8444-555555555555', [
            start(2, BASE_MS + 50000), activity(2, BASE_MS + 51000),
        ])
        report = native_turns.sample(self.root, now=BASE_MS + 60000)
        self.assertEqual([item['turn'] for item in report['running']], [2, 1])


@unittest.skipIf(zstandard is None, 'python-zstandard is not installed')
class RunningOffer(unittest.TestCase):
    """The join side: running turns minus what the Bridge dispatched."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t068-ledger-')
        self.addCleanup(shutil.rmtree, self.root, True)
        self.native = tempfile.mkdtemp(prefix='t068-native-')
        self.addCleanup(shutil.rmtree, self.native, True)
        self.state = tempfile.mkdtemp(prefix='t068-state-')
        self.addCleanup(shutil.rmtree, self.state, True)
        self.ledger = os.path.join(self.root, 'endpoint.json.runs.json')

    def offer(self, now=BASE_MS + 20000):
        return terminal_source.running_report(
            self.state, root=self.root, native_root=self.native, now=now)

    def test_a_direct_running_turn_is_offered(self):
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), activity(7, BASE_MS + 1000),
        ])
        write_ledger(self.ledger, [])
        report = self.offer()
        self.assertTrue(report['ok'])
        self.assertEqual(report['runningCount'], 1)
        self.assertEqual(report['bridgeRunning'], 0)
        row = report['running'][0]
        self.assertEqual(row['origin'], 'direct')
        self.assertEqual(row['turn'], 7)
        self.assertEqual(row['sessionId'], DIRECT_SESSION)
        # The id is derived from (session, turn), so it is stable across polls -- the
        # hard-coded shape is asserted because the extension validates it as a UUID.
        self.assertEqual(row['runId'],
                         terminal_source.native_run_id(DIRECT_SESSION, 7))

    def test_a_bridge_running_turn_is_excluded(self):
        write_log(self.native, BRIDGE_SESSION, [
            start(133, BASE_MS), activity(133, BASE_MS + 1000),
        ])
        write_ledger(self.ledger, [{
            'runId': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            'sessionID': BRIDGE_SESSION, 'turn': 133,
        }])
        report = self.offer()
        self.assertTrue(report['ok'])
        self.assertEqual(report['runningCount'], 0)
        self.assertEqual(report['bridgeRunning'], 1)

    def test_mixed_turns_are_split_by_the_ledger_not_by_time(self):
        # Both turns happen to straddle the same instant. The only thing that
        # separates them is the ledger's own (sessionID, turn).
        write_log(self.native, BRIDGE_SESSION, [
            start(133, BASE_MS), activity(133, BASE_MS + 9000),
        ])
        write_log(self.native, DIRECT_SESSION, [
            start(5, BASE_MS + 100), activity(5, BASE_MS + 9000),
        ])
        write_ledger(self.ledger, [{
            'runId': 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            'sessionID': BRIDGE_SESSION, 'turn': 133,
        }])
        report = self.offer()
        self.assertEqual([row['sessionId'] for row in report['running']],
                         [DIRECT_SESSION])
        self.assertEqual(report['bridgeRunning'], 1)

    def test_an_unreadable_ledger_fails_closed(self):
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), activity(7, BASE_MS + 1000),
        ])
        report = self.offer()
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'ledger_unavailable')
        self.assertEqual(report['running'], [])
        self.assertTrue(report['ledgerError'])

    def test_an_unreadable_native_source_fails_closed(self):
        write_ledger(self.ledger, [])
        report = self.offer()
        self.assertFalse(report['ok'])
        self.assertFalse(report['nativeOk'])
        self.assertEqual(report['running'], [])

    def test_nothing_running_is_ok_and_empty(self):
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), end(7, BASE_MS + 1000),
        ])
        write_ledger(self.ledger, [])
        report = self.offer()
        self.assertTrue(report['ok'])
        self.assertEqual(report['runningCount'], 0)
        self.assertEqual(report['running'], [])

    def test_the_offer_writes_nothing(self):
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), activity(7, BASE_MS + 1000),
        ])
        write_ledger(self.ledger, [])
        before = sorted(os.listdir(self.state))
        self.offer()
        self.assertEqual(sorted(os.listdir(self.state)), before)

    def test_the_offer_does_not_touch_the_ledger(self):
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), activity(7, BASE_MS + 1000),
        ])
        write_ledger(self.ledger, [{'runId': 'x', 'sessionID': 'y', 'turn': 1}])
        with open(self.ledger, 'rb') as handle:
            before = handle.read()
        self.offer()
        with open(self.ledger, 'rb') as handle:
            self.assertEqual(handle.read(), before)

    def test_started_at_is_seconds_and_absent_when_unproven(self):
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), activity(7, BASE_MS + 1000),
        ])
        write_ledger(self.ledger, [])
        row = self.offer()['running'][0]
        self.assertEqual(row['startedAt'], BASE_MS // 1000)
        write_log(self.native, SESSION_DIR, [
            activity(9, BASE_MS + 1500),
        ])
        rows = {item['turn']: item for item in self.offer()['running']}
        self.assertIsNone(rows[9]['startedAt'])
        self.assertEqual(rows[9]['observedSince'], (BASE_MS + 1500) // 1000)


@unittest.skipIf(zstandard is None, 'python-zstandard is not installed')
class TerminalEndStillWins(unittest.TestCase):
    """The handover: a turn that stops running becomes a normal T067 candidate."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t068-handover-')
        self.addCleanup(shutil.rmtree, self.root, True)
        self.native = tempfile.mkdtemp(prefix='t068-native-')
        self.addCleanup(shutil.rmtree, self.native, True)
        self.state = tempfile.mkdtemp(prefix='t068-state-')
        self.addCleanup(shutil.rmtree, self.state, True)
        self.ledger = os.path.join(self.root, 'endpoint.json.runs.json')
        write_ledger(self.ledger, [])

    def test_the_run_id_is_identical_before_and_after_it_ends(self):
        # This is why a running opt-in survives the transition: the key the operator
        # clicked is the key the finished task is offered under.
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), activity(7, BASE_MS + 1000),
        ])
        # `sample` is stateful on the host side: its first call establishes the
        # baseline and deliberately offers nothing. Prime it first, so the assertion
        # below is about the handover rather than about the baseline.
        terminal_source.sample(self.state, root=self.root,
                               native_root=self.native, now=BASE_MS + 1500)
        running = terminal_source.running_report(
            self.state, root=self.root, native_root=self.native,
            now=BASE_MS + 2000)['running'][0]
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), activity(7, BASE_MS + 1000),
            end(7, BASE_MS + 3000),
        ])
        report = terminal_source.sample(
            self.state, root=self.root, native_root=self.native,
            now=BASE_MS + 4000)
        finished = [item for item in report['candidates']
                    if item.get('nativeTurn') == 7]
        self.assertEqual(len(finished), 1)
        self.assertEqual(finished[0]['runId'], running['runId'])
        self.assertEqual(finished[0]['status'], 'completed')

    def test_a_running_turn_is_never_a_candidate(self):
        write_log(self.native, DIRECT_SESSION, [
            start(7, BASE_MS), activity(7, BASE_MS + 1000),
        ])
        report = terminal_source.sample(
            self.state, root=self.root, native_root=self.native,
            now=BASE_MS + 2000)
        self.assertEqual(report['candidates'], [])
        self.assertEqual(report['nativeRunning'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
