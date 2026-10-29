"""T069: the terminal instant must reach the extension at the precision DSH recorded.

The defect this file exists for: `native_turns` reads `turn/end`'s `time`, which is an
epoch in milliseconds, and hands it on faithfully -- but `terminal_source` floored it to
whole seconds before putting it in a candidate. Everything downstream then had to guess,
and the guess it made (`(endedAt + 1) * 1000`) admitted a click made up to 999 ms *after*
a task had already finished.

These tests pin the carriage itself: what the host emits, at what precision, and what it
emits when it does not know. The consent rule that consumes it is tested in
`test_t069_terminal_precision.mjs`, against the same numbers.
"""
import json
import os
import shutil
import tempfile
import unittest

import native_turns
import terminal_source


WORKSPACE = '--E-ApkTest--'
SESSION = 'session-11111111-2222-4333-8444-555555555555'
# A whole second, so the truncation the old code performed is visible as a difference.
BASE_MS = 1793260000000
WHOLE_SECOND_MS = BASE_MS + 900          # .900 into that second

try:
    import zstandard
except ImportError:                      # pragma: no cover - environment probe
    zstandard = None


def zstd_bytes(body):
    """Compress a session-log fixture with whatever this machine has.

    Two paths, because neither dependency is guaranteed: the `zstandard` module is an
    optional install, and `zlib.zstdCompressSync` arrived in Node 22.15. The first
    version of this used `check=True` on the Node fallback, so a runner with Node 20
    reported six *errors* -- tracebacks from `subprocess` -- instead of one honest
    "this environment cannot build the fixture". CI ran red for six pushes because of it.
    A missing optional tool is a skip with a reason, never an error.
    """
    if zstandard is not None:
        return zstandard.ZstdCompressor().compress(body)
    import subprocess
    done = subprocess.run(['node', '-e',
                           'process.stdout.write(require("node:zlib")'
                           '.zstdCompressSync(require("node:fs")'
                           '.readFileSync(0)))'],
                          input=body, capture_output=True)
    if done.returncode != 0:
        detail = done.stderr.decode('utf-8', 'replace').strip().splitlines()
        raise unittest.SkipTest(
            'no zstd compressor here: the zstandard module is not installed and this '
            'Node has no zlib.zstdCompressSync (needs 22.15+); %s'
            % (detail[-1] if detail else 'node exited %d' % done.returncode))
    return done.stdout


def record(kind, seq, time_ms, data):
    return json.dumps({'type': kind, 'seq': seq, 'time': time_ms, 'data': data})


class TerminalPrecision(unittest.TestCase):
    """What the host hands the extension, and at what precision."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t069-root-')
        self.native = tempfile.mkdtemp(prefix='t069-native-')
        self.state_dir = tempfile.mkdtemp(prefix='t069-state-')
        sub = os.path.join(self.root, 'c' * 64)
        os.makedirs(sub)
        self.ledger = os.path.join(sub, 'endpoint.json.runs.json')
        self.write_ledger([])
        # The first sample absorbs everything already terminal as history -- that is
        # the whole point of the baseline, and it means a fixture that writes the log
        # *before* the first sample can never be offered. Establish it against the
        # empty source, then create the turn.
        first = terminal_source.sample(self.state_dir, root=self.root,
                                      native_root=self.native, now=BASE_MS - 1000)
        self.assertIs(first['ok'], True, str(first))
        self.assertIs(first['baselineEstablished'], True, str(first))

    def tearDown(self):
        for path in (self.root, self.native, self.state_dir):
            shutil.rmtree(path, ignore_errors=True)

    # ------------------------------------------------------------------ fixtures

    def write_ledger(self, runs):
        with open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def write_log(self, session, records):
        session_dir = os.path.join(self.native, WORKSPACE, session)
        os.makedirs(session_dir, exist_ok=True)
        body = ('\n'.join(records) + '\n').encode('utf-8')
        with open(os.path.join(session_dir, native_turns.LOG_NAME), 'wb') as handle:
            handle.write(zstd_bytes(body))

    def one_second_turn(self, end_ms=WHOLE_SECOND_MS):
        # DSH writes `data.reason.kind`, not a flat status; `native_turns.status_of`
        # maps it. A fixture using the wrong key yields no candidate at all, which is
        # how this test first failed.
        self.write_log(SESSION, [
            record('turn/start', 10, BASE_MS, {'turn': 7}),
            record('tool/call', 12, BASE_MS + 100, {'turn': 7}),
            record('turn/end', 14, end_ms,
                   {'turn': 7, 'reason': {'kind': 'completed'}}),
        ])

    def offered(self, now):
        """What one sample offers on channel B."""
        report = terminal_source.sample(self.state_dir, root=self.root,
                                       native_root=self.native, now=now)
        self.assertIs(report['ok'], True, 'sample must succeed: ' + str(report))
        return [c for c in report['candidates'] if c.get('origin') == 'direct']

    def emitted_ended_ms(self, value):
        """The emitter's rule for one synthetic turn, read from a real candidate."""
        saved = native_turns.sample

        def fake(root=None, now=None, **_kwargs):
            return {'ok': True, 'code': None, 'turns': [
                {'sessionId': SESSION, 'turn': 7, 'status': 'completed',
                 'endedAt': value, 'startedAt': None}],
                'running': [], 'runningStale': 0, 'sessions': 1, 'files': 1,
                'error': None, 'source': 'stub', 'root': root}

        native_turns.sample = staticmethod(fake)
        try:
            rows = self.offered(now=BASE_MS + 6000)
        finally:
            native_turns.sample = saved
        self.assertEqual(len(rows), 1, rows)
        return rows[0]['endedAtMs']

    # ------------------------------------------------------- the field is carried

    def test_the_end_instant_keeps_its_milliseconds(self):
        self.one_second_turn()
        rows = self.offered(now=BASE_MS + 6000)
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]['endedAtMs'], WHOLE_SECOND_MS,
                         'the millisecond instant must survive the host')

    def test_the_seconds_field_is_still_there_and_still_floored(self):
        self.one_second_turn()
        row = self.offered(now=BASE_MS + 6000)[0]
        # The compatibility field is unchanged: a build older than T069 reads this and
        # must keep working. It is simply no longer what the consent rule decides from.
        self.assertEqual(row['endedAt'], WHOLE_SECOND_MS // 1000)
        self.assertNotEqual(row['endedAt'] * 1000, row['endedAtMs'],
                            'the fixture must actually exercise truncation')

    def test_two_ends_inside_one_second_stay_distinguishable(self):
        # 700 ms apart, same truncated second. Under the old shape these were equal,
        # which is the whole defect: the consumer could not tell .100 from .800.
        self.one_second_turn(end_ms=BASE_MS + 100)
        first = self.offered(now=BASE_MS + 6000)[0]
        shutil.rmtree(self.native)
        os.makedirs(self.native)
        self.one_second_turn(end_ms=BASE_MS + 800)
        second = self.offered(now=BASE_MS + 7000)[0]
        self.assertEqual(first['endedAt'], second['endedAt'],
                         'both are in the same truncated second')
        self.assertEqual(second['endedAtMs'] - first['endedAtMs'], 700,
                         'and the milliseconds tell them apart')

    def test_a_missing_end_instant_is_null_not_zero_and_not_guessed(self):
        # A consumer must be able to tell "unknown" from "the epoch". `0` is falsy and
        # could read as "no constraint"; `None` is unambiguous, and the consent rule
        # refuses on it.
        self.assertIsNone(self.emitted_ended_ms(None))

    def test_zero_and_negative_are_treated_as_unknown(self):
        # Both calls share the state directory: the first offers the run, which lands
        # in `pendingIds`, and an unacknowledged candidate is re-offered -- so the
        # second value is exercised against the same turn rather than a fresh baseline
        # that would absorb it.
        for bad in (0, -5):
            with self.subTest(endedAt=bad):
                self.assertIsNone(self.emitted_ended_ms(bad),
                                  'endedAt=%r must not become a usable instant' % bad)

    def test_the_key_is_always_present_so_absence_means_nothing(self):
        # A consumer must never have to distinguish "the key is missing" (a shape it
        # does not understand) from "the value is null" (a fact it does understand).
        self.one_second_turn()
        row = self.offered(now=BASE_MS + 6000)[0]
        self.assertIn('endedAtMs', row)

    # ------------------------------------------- the running side is not disturbed

    def test_the_running_report_does_not_invent_an_end_time(self):
        # A running turn has no end instant, and if this release started emitting one,
        # `optInUsable` would begin admitting decisions made after a turn ended -- the
        # exact defect being fixed, reintroduced through the other door.
        self.write_log(SESSION, [
            record('turn/start', 10, BASE_MS, {'turn': 7}),
            record('tool/call', 12, BASE_MS + 100, {'turn': 7}),
        ])
        report = terminal_source.running_report(self.state_dir, root=self.root,
                                                native_root=self.native,
                                                now=BASE_MS + 5000)
        self.assertIs(report['ok'], True, str(report))
        self.assertEqual(report['runningCount'], 1, report)
        self.assertNotIn('endedAtMs', report['running'][0],
                         'a running turn has no end instant to report')

    def test_bridge_exclusion_still_works_with_the_new_field(self):
        # The ledger index is what keeps channel A out of the opt-in list. Adding a
        # field must not disturb the join it is keyed on.
        self.write_log(SESSION, [
            record('turn/start', 10, BASE_MS, {'turn': 7}),
            record('turn/end', 14, WHOLE_SECOND_MS,
                   {'turn': 7, 'reason': {'kind': 'completed'}}),
        ])
        self.write_ledger([{'requestID': 'r1', 'createdAt': BASE_MS // 1000,
                            'sessionID': SESSION, 'turn': 7}])
        self.assertEqual(self.offered(now=BASE_MS + 6000), [],
                         'a Bridge-dispatched turn must not be offered to B')


if __name__ == '__main__':
    unittest.main()
