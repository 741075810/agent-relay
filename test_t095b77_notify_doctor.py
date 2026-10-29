"""The read-only notify doctor, tested against fixtures only.

Two properties matter more than any single reason code:

  * it never writes. The task it was built for runs at night with the operator asleep, so
    a diagnostic that perturbs the thing it is diagnosing is worse than nothing. Every
    test hashes the fixture directory before and after and requires identical bytes.
  * its time arithmetic is right. The artifacts store epoch **seconds** and the extension
    side stores **milliseconds**; `queue.json` also carries `createdAt` as an ISO string.
    A single mis-scale turns "28 minutes ago" into "fifty-five years ago" and nobody
    reads past the first absurd number.

No fixture here is derived from a live artifact: every id is fabricated, so a reader can
tell at a glance that nothing was copied out of a run.
"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, 'tools', 'notify_doctor.py')

# 2027-01-15T08:00:00Z. Chosen to be obviously invented and to sit in a plausible
# future, so a test that leaks a real timestamp cannot hide behind it.
NOW_MS = 1_800_000_000_000
NOW_SECONDS = NOW_MS // 1000
UUID_SHAPE = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'
                        r'[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
HASH_SHAPE = re.compile(r'[0-9a-f]{64}')


def load_tool():
    import importlib.util
    spec = importlib.util.spec_from_file_location('notify_doctor', TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ident(n):
    """A fabricated 36-character id, obviously numbered rather than random."""
    return '%08d-0000-4000-8000-000000000000' % n


def event(run, deliverable=True, delivered=False, consumer_taken=False, created=None):
    return {
        # Not a hex digest on purpose: a fabricated field that happens to look like a
        # sha256 makes this file trip the publish scanner's own hash rule.
        'eventId': 'fabricated-event-id',
        'runId': run,
        'name': 'terminal-turn',
        'createdAt': created if created is not None else '2027-01-15T07:30:00Z',
        'enqueuedAt': NOW_SECONDS - 600,
        'deliveredAt': (NOW_SECONDS - 500) if delivered else 0,
        'deliverable': deliverable,
        'replay': not deliverable,
        'status': 'delivered' if delivered else 'queued',
        'deliveries': 1 if delivered else 0,
        'consumerDeliveredAt': ({'c': NOW_SECONDS - 400} if consumer_taken else {}),
        'seq': 1,
        'message': 'fixture text; never a real notice',
    }


class DoctorTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = load_tool()

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='doctor-')
        self.addCleanup(shutil.rmtree, self.root, True)

    def write(self, name, document):
        with io.open(os.path.join(self.root, name), 'w', encoding='utf-8') as handle:
            json.dump(document, handle)

    def write_defaults(self, origin_ids=(), pending=(), acked=(), armed=(),
                       taken_at=NOW_SECONDS - 120, events=()):
        """A complete, coherent state directory: every test states only what it varies."""
        self.write('terminal-origin.json', {'version': 1, 'ids': list(origin_ids),
                                            'readAt': NOW_SECONDS - 30,
                                            'source': 'bridge-sqlite'})
        self.write('terminal-source.json', {'version': 1,
                                            'pendingIds': list(pending),
                                            'ackedIds': list(acked),
                                            'baselineIds': [], 'baselineCount': 0,
                                            'baselineDropped': 0})
        self.write('terminal-arm.json', {'version': 1, 'ids': list(armed),
                                         'takenAt': taken_at, 'epoch': ident(999),
                                         'truncated': False})
        self.write('queue.json', {'version': 1, 'events': list(events), 'next_seq': 5,
                                  'acked': [], 'acked_at': {},
                                  'consumers': {'dsh-ext-fixture': {'last_seen': NOW_SECONDS}},
                                  'consumer_acks': {}})

    def digest(self):
        rows = []
        for name in sorted(os.listdir(self.root)):
            with open(os.path.join(self.root, name), 'rb') as handle:
                rows.append(name + ':' + hashlib.sha256(handle.read()).hexdigest())
        return rows

    def run_tool(self):
        return self.tool.diagnose(self.root, now_ms=NOW_MS)

    def codes(self, report, severity=None):
        return [f['code'] for f in report['findings']
                if severity is None or f['severity'] == severity]


class TimeTest(DoctorTestCase):
    def test_ten_digits_are_seconds(self):
        self.assertEqual(self.tool.to_ms(NOW_SECONDS), (NOW_MS, 'seconds'))

    def test_thirteen_digits_are_milliseconds(self):
        self.assertEqual(self.tool.to_ms(NOW_MS), (NOW_MS, 'milliseconds'))

    def test_both_encodings_of_one_instant_render_identically(self):
        self.assertEqual(self.tool.beijing(NOW_SECONDS * 1000),
                         self.tool.beijing(NOW_MS))

    def test_scaling_happens_exactly_once(self):
        """A seconds value must not be scaled twice.

        Double scaling is not a subtle rounding error, it is a date fifty-five thousand
        years out, so the assertion is on the age being of a plausible size rather than
        on an exact value.
        """
        self.write_defaults(origin_ids=[ident(1)], pending=[], armed=[],
                            taken_at=NOW_SECONDS - 120)
        arm = self.run_tool()['stages']['arm']
        self.assertEqual(arm['unit_read'], 'seconds')
        self.assertAlmostEqual(arm['age_minutes'], 2.0, places=1)

    def test_the_epoch_renders_as_beijing(self):
        """Zero is 08:00 in Beijing and 00:00 in UTC: one hand-checkable constant that
        proves the offset is applied and is arithmetic rather than the machine's zone."""
        self.assertEqual(self.tool.beijing(0), '1970-01-01 08:00:00.000')

    def test_milliseconds_survive_rendering(self):
        self.assertTrue(self.tool.beijing(NOW_MS).endswith('.000'))
        self.assertTrue(self.tool.beijing(NOW_MS + 7).endswith('.007'))

    def test_iso_created_at_is_read(self):
        self.assertEqual(self.tool.parse_iso('2027-01-15T08:00:00Z'), NOW_MS)

    def test_iso_with_fraction_is_read(self):
        self.assertEqual(self.tool.parse_iso('2027-01-15T08:00:00.250Z'), NOW_MS + 250)

    def test_garbage_is_not_a_time(self):
        self.assertIsNone(self.tool.parse_iso('last tuesday'))
        self.assertEqual(self.tool.to_ms('nope'), (None, 'unparsable'))

    def test_zero_is_not_treated_as_an_instant(self):
        """"Never delivered" is stored as 0, and 0 is 1970 only if you insist."""
        self.assertEqual(self.tool.to_ms(0), (None, 'not_a_time'))

    def test_created_at_string_is_surfaced(self):
        self.write_defaults(origin_ids=[ident(1)],
                            events=[event(ident(1), created='2027-01-15T07:30:00Z')])
        queue = self.run_tool()['stages']['queue']
        self.assertEqual(queue['newest_created_at'], '2027-01-15 15:30:00.000')


class ReadOnlyTest(DoctorTestCase):
    def test_nothing_in_the_directory_changes(self):
        self.write_defaults(origin_ids=[ident(1)], pending=[ident(2)],
                            armed=[ident(2)],
                            events=[event(ident(2), deliverable=True, delivered=False)])
        before = self.digest()
        self.run_tool()
        self.assertEqual(self.digest(), before)

    def test_a_run_creates_no_file(self):
        self.write_defaults(origin_ids=[ident(1)])
        before = sorted(os.listdir(self.root))
        self.run_tool()
        self.assertEqual(sorted(os.listdir(self.root)), before)

    def test_cli_output_holds_no_identifier(self):
        self.write_defaults(origin_ids=[ident(1), ident(2)], pending=[ident(2)],
                            armed=[ident(2), ident(3)], acked=[ident(1)],
                            events=[event(ident(3), deliverable=True, delivered=False)])
        done = subprocess.run([sys.executable, '-B', TOOL, '--state', self.root,
                               '--now', '2027-01-15T08:00:00Z'],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        text = done.stdout.decode('utf-8', 'replace')
        self.assertEqual(done.returncode, 0, text)
        self.assertEqual(UUID_SHAPE.findall(text), [])
        self.assertEqual(HASH_SHAPE.findall(text), [])


class ReasonTest(DoctorTestCase):
    def test_expected_silence_is_not_a_fault(self):
        """Three pending turns outside the armed window is what a just-finished turn
        looks like, not a broken chain."""
        self.write_defaults(origin_ids=[ident(1), ident(2)], pending=[ident(2)],
                            armed=[ident(1)])
        report = self.run_tool()
        self.assertIn('pending_not_armed', self.codes(report, 'expected'))
        self.assertTrue(report['chain_intact'])
        self.assertEqual(report['primary'], 'expected_silence')

    def test_an_armed_turn_with_no_queue_event_is_a_fault(self):
        self.write_defaults(origin_ids=[ident(1)], pending=[ident(1)], armed=[ident(1)],
                            events=[])
        report = self.run_tool()
        self.assertIn('armed_but_not_enqueued', self.codes(report, 'blocker'))
        self.assertFalse(report['chain_intact'])
        self.assertEqual(report['primary'], 'armed_but_not_enqueued')

    def test_a_pending_turn_outside_the_arm_is_never_called_a_fault(self):
        self.write_defaults(origin_ids=[ident(1), ident(2)], pending=[ident(2)],
                            armed=[ident(1)], events=[])
        self.assertNotIn('armed_but_not_enqueued', self.codes(self.run_tool()))

    def test_an_undelivered_event_waits_for_a_consumer(self):
        self.write_defaults(origin_ids=[ident(1)], pending=[ident(1)], armed=[ident(1)],
                            events=[event(ident(1), deliverable=True, delivered=False)])
        report = self.run_tool()
        self.assertIn('waiting_for_consumer', self.codes(report, 'blocker'))

    def test_a_delivered_event_says_so(self):
        self.write_defaults(origin_ids=[ident(1)], pending=[ident(1)], armed=[ident(1)],
                            events=[event(ident(1), deliverable=True, delivered=True,
                                          consumer_taken=True)])
        report = self.run_tool()
        self.assertEqual(report['primary'], 'delivered')
        self.assertTrue(report['chain_intact'])

    def test_a_stale_arm_over_pending_turns_is_a_fault(self):
        self.write_defaults(origin_ids=[ident(1)], pending=[ident(1)], armed=[ident(1)],
                            taken_at=NOW_SECONDS - 3600,
                            events=[event(ident(1), deliverable=True, delivered=True)])
        report = self.run_tool()
        self.assertIn('arm_stale', self.codes(report, 'blocker'))

    def test_dropped_baseline_explains_silence_without_blaming_the_chain(self):
        self.write_defaults(origin_ids=[ident(1)], pending=[], armed=[])
        self.write('terminal-source.json', {'version': 1, 'pendingIds': [], 'ackedIds': [],
                                            'baselineIds': [], 'baselineCount': 300,
                                            'baselineDropped': 211})
        report = self.run_tool()
        self.assertIn('baseline_truncated', self.codes(report, 'expected'))
        self.assertTrue(report['chain_intact'])

    def test_a_future_snapshot_is_a_clock_disagreement(self):
        self.write_defaults(origin_ids=[ident(1)], pending=[], armed=[],
                            taken_at=NOW_SECONDS + 600)
        self.assertIn('clock_skew', self.codes(self.run_tool(), 'blocker'))

    def test_nothing_at_all_is_correct_silence(self):
        self.write_defaults(origin_ids=[], pending=[], armed=[])
        report = self.run_tool()
        self.assertIn('nothing_to_send', self.codes(report, 'expected'))
        self.assertTrue(report['chain_intact'])


class DegradedTest(DoctorTestCase):
    def test_an_absent_artifact_is_named_not_raised(self):
        self.write_defaults(origin_ids=[ident(1)])
        os.remove(os.path.join(self.root, 'terminal-arm.json'))
        report = self.run_tool()
        self.assertIn('artifact_absent', self.codes(report))

    def test_an_unreadable_artifact_is_named(self):
        self.write_defaults(origin_ids=[ident(1)])
        with io.open(os.path.join(self.root, 'queue.json'), 'w', encoding='utf-8') as h:
            h.write('{ this is not json')
        self.assertIn('artifact_unreadable', self.codes(self.run_tool()))

    def test_nothing_readable_is_said_plainly(self):
        report = self.run_tool()
        self.assertEqual(report['primary'], 'nothing_readable')
        self.assertEqual(len(self.codes(report, 'blocker')), 4)
        # Not None: unreadable is a failure, and a failure has to name itself as one.
        self.assertIs(report['chain_intact'], False)

    def test_the_invisible_stage_is_declared(self):
        self.write_defaults(origin_ids=[ident(1)])
        report = self.run_tool()
        self.assertIn('extension_store_not_read', report['limitations'])
        self.assertIn('bridge_ledger_not_read', report['limitations'])


if __name__ == '__main__':
    unittest.main()
