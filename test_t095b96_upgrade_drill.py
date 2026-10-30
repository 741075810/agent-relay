"""T095B96: the offline drill, and the one question it exposed.

The drill itself is the deliverable: a repeatable sequence through a legacy state, the
preflight, the hand-removal of the old lock, the new protocol, and the rollback view -- all
inside a temp fixture, with refusals that must leave the fixture byte-identical.

Writing it surfaced a gap the earlier rounds had left as an assumption. The preflight reads
the lock file and recognises its marker, but it never asks whether some process is *holding*
that lock right now, so a live host is indistinguishable from a cleanly stopped one and
`--host-stopped` was doing more work than the tool admits. Taking the OS lock without
blocking is a question with a real answer, so the tool should ask it.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_t095b90_upgrade_preflight import PREFLIGHT
from test_t095b94_tree_kill import take_lock, release

import host

DRILL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools', 'upgrade_drill.py')


def load_drill():
    import importlib.util
    spec = importlib.util.spec_from_file_location('upgrade_drill_under_test', DRILL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DRILL_MODULE = load_drill()


class DrillTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t096-test-')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_the_documented_sequence_is_reproduced(self):
        first = os.path.join(self.root, 'a')
        second = os.path.join(self.root, 'b')
        runs = []
        for directory in (first, second):
            records, verdicts = DRILL_MODULE.drill(directory, attested=True)
            runs.append(([record['stage'] for record in records], verdicts))
        self.assertEqual(runs[0], runs[1], 'the drill is not repeatable')
        stages, verdicts = runs[0]
        self.assertEqual(verdicts[:3], ['legacy_lock_remove_by_hand',
                                        'legacy_lock_remove_by_hand',
                                        'safe_to_start'],
                         'the verdict sequence is not the documented one: %s' % (verdicts,))
        self.assertIn('verify', stages)
        self.assertIn('rollback-view', stages)

    def test_no_event_is_lost_and_the_consumers_stay_separate(self):
        records, _ = DRILL_MODULE.drill(os.path.join(self.root, 'c'), attested=True)
        verify = [record for record in records if record['stage'] == 'verify'][0]
        self.assertTrue(verify['no_event_lost'], verify)
        self.assertEqual(verify['page_sees'], ['evt-c', 'evt-d'], verify)
        self.assertEqual(verify['other_sees'], ['evt-a', 'evt-b', 'evt-c', 'evt-d'], verify)
        self.assertEqual(verify['acked_page'], 2, verify)

    def test_without_an_attestation_the_drill_changes_nothing(self):
        directory = os.path.join(self.root, 'd')
        records, verdicts = DRILL_MODULE.drill(directory, attested=False)
        self.assertEqual(records[-1]['stage'], 'stopped')
        self.assertFalse(records[-1]['attested'])
        self.assertEqual(len(verdicts), 2)
        self.assertTrue(os.path.exists(os.path.join(directory, host.LOCK_FILE)),
                        'the legacy lock was removed without the operator saying the old host '
                        'was stopped')

    def test_the_refusals_leave_the_fixture_untouched(self):
        for case in DRILL_MODULE.refusal_cases():
            self.assertTrue(case['unchanged'], case)
            self.assertNotEqual(case['verdict'], 'safe_to_start', case)
            self.assertNotIn(case['exit_code'], (0,), case)

    def test_the_report_carries_no_absolute_path(self):
        done = subprocess.run([sys.executable, '-B', DRILL, '--attest-stopped'],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
        text = done.stdout.decode('utf-8', 'replace')
        self.assertEqual(done.returncode, 0, text[-800:])
        self.assertNotIn('t096-drill-', text, 'the report carries a temporary absolute path')
        self.assertNotIn(tempfile.gettempdir().lower(), text.lower())
        self.assertIn('legacy_lock_remove_by_hand', text)


class LiveHolderTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t096-holder-')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_lock_that_somebody_holds_is_not_approved(self):
        """`--host-stopped` is the operator's word; holding the lock is a fact."""
        host.append_events(self.root, [{'eventId': 'evt-a', 'runId': 'run-1', 'text': 'x'}])
        with host._Lock(self.root):
            report = PREFLIGHT.inspect(self.root, host_stopped=True)
        self.assertIs(report['lock'].get('held_by_a_process'), True,
                      'the preflight cannot tell a live holder from a stopped host')
        self.assertNotEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE,
                            'a state whose lock is held by a running process was approved')
        self.assertIn('hold', ' '.join(report['reasons']).lower())

    def test_a_lock_nobody_holds_is_approved(self):
        host.append_events(self.root, [{'eventId': 'evt-a', 'runId': 'run-1', 'text': 'x'}])
        with host._Lock(self.root):
            pass
        report = PREFLIGHT.inspect(self.root, host_stopped=True)
        self.assertIs(report['lock'].get('held_by_a_process'), False)
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)

    def test_the_probe_releases_the_lock_it_took(self):
        """The preflight must not leave a lock of its own behind."""
        host.append_events(self.root, [{'eventId': 'evt-a', 'runId': 'run-1', 'text': 'x'}])
        with host._Lock(self.root):
            pass
        PREFLIGHT.inspect(self.root, host_stopped=True)
        handle = take_lock(os.path.join(self.root, host.LOCK_FILE))
        release(handle)
        self.assertIsNotNone(handle, 'the preflight left the lock held')

    def test_an_unprobeable_lock_is_not_approved_silently(self):
        host.append_events(self.root, [{'eventId': 'evt-a', 'runId': 'run-1', 'text': 'x'}])
        real = PREFLIGHT._lock_probe
        PREFLIGHT._lock_probe = lambda path, kind: None
        try:
            report = PREFLIGHT.inspect(self.root, host_stopped=True)
        finally:
            PREFLIGHT._lock_probe = real
        self.assertIsNone(report['lock'].get('held_by_a_process'))
        self.assertNotEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE,
                            'an unverifiable lock was reported as safe')


if __name__ == '__main__':
    unittest.main()
