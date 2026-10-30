"""T095B90: the upgrade preflight says which way it failed, and changes nothing.

T089 established that the old and new lock protocols cannot exclude each other, so the
upgrade is a stop-the-old-host operation with a manual step in the middle. This suite pins
the tool that tells an operator where they are in that sequence.

The two properties worth a test rather than a paragraph:

  * **read-only** -- every case snapshots the directory (size, mtime_ns, sha256) and demands
    it be identical afterwards. A preflight that repairs what it finds is an outage with good
    intentions.
  * **it does not guess** -- five states get five verdicts, and "no host is running" is an
    operator attestation because no read-only check can prove a negative. The mutation block
    at the end proves these assertions bite: it neuters the legacy branch in a copy of the
    tool and shows the suite's own expectation change.
"""
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

import host

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    'tools', 'upgrade_preflight.py')


def load_tool():
    import importlib.util
    spec = importlib.util.spec_from_file_location('upgrade_preflight_under_test', TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PREFLIGHT = load_tool()


def snapshot(directory):
    everything = {}
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        with open(path, 'rb') as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        info = os.stat(path)
        everything[name] = (info.st_size, info.st_mtime_ns, digest)
    return everything


def event(ident):
    return {'eventId': ident, 'runId': 'run-' + ident, 'text': 'x'}


class State(object):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t090-preflight-')

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)

    def lock(self, payload):
        path = os.path.join(self.state, host.LOCK_FILE)
        with open(path, 'wb') as handle:
            handle.write(payload)
        return path

    def inspect(self, **kwargs):
        before = snapshot(self.state)
        report = PREFLIGHT.inspect(self.state, **kwargs)
        self.assertEqual(snapshot(self.state), before,
                         'the preflight modified the directory it inspected')
        return report


class VerdictTest(State, unittest.TestCase):
    def test_an_absent_lock_with_an_attestation_is_safe(self):
        host.append_events(self.state, [event('e1')])
        report = self.inspect(host_stopped=True)
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)
        self.assertEqual(report['exit_code'], 0)
        self.assertEqual(report['queue']['events'], 1)
        self.assertEqual(report['queue']['unacknowledged'], 1)

    def test_without_an_attestation_nothing_is_called_safe(self):
        report = self.inspect()
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_CONFIRM)
        self.assertEqual(report['exit_code'], PREFLIGHT.EXIT_CONFIRM)
        self.assertIn('no read-only check can prove',
                      ' '.join(report['reasons']))

    def test_an_empty_lock_is_the_old_protocol_and_is_not_removed(self):
        path = self.lock(b'')
        report = self.inspect(host_stopped=True)
        self.assertEqual(report['lock']['kind'], 'legacy_empty')
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_LEGACY)
        self.assertEqual(report['exit_code'], PREFLIGHT.EXIT_CONFIRM)
        self.assertTrue(os.path.exists(path), 'the preflight deleted the lock file')

    def test_an_unknown_lock_is_refused(self):
        self.lock(b'\x00pid: 4242\n')
        report = self.inspect(host_stopped=True)
        self.assertEqual(report['lock']['kind'], 'unknown')
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_UNKNOWN_LOCK)
        self.assertNotEqual(report['exit_code'], 0)

    def test_this_protocols_lock_is_recognised_with_its_token(self):
        self.lock(b'\x00' + host.LOCK_MARKER + b' deadbeefdeadbeef')
        report = self.inspect(host_stopped=True)
        self.assertEqual(report['lock']['kind'], 'os_v1')
        self.assertEqual(report['lock']['token'], 'deadbeefdeadbeef')
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)

    def test_a_damaged_queue_is_named_not_guessed(self):
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as out:
            out.write('{"version": 1, "events": [')
        report = self.inspect(host_stopped=True)
        self.assertFalse(report['queue']['readable'])
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_DAMAGED)
        self.assertEqual(report['exit_code'], PREFLIGHT.EXIT_DAMAGED)
        self.assertIn('damaged', ' '.join(report['reasons']))

    def test_an_interrupted_save_is_reported(self):
        host.append_events(self.state, [event('e1')])
        with open(os.path.join(self.state, host.QUEUE_FILE + '.tmp-999'), 'w') as out:
            out.write('half a document')
        report = self.inspect(host_stopped=True)
        self.assertEqual(len(report['debris']), 1)
        self.assertNotEqual(report['exit_code'], 0)
        self.assertIn('did not finish', ' '.join(report['reasons']))


class AckIndependenceTest(State, unittest.TestCase):
    def test_one_consumers_ack_does_not_hide_the_event_from_the_report(self):
        host.append_events(self.state, [event('a1'), event('a2')])
        host.ack_events(self.state, ['a1'], consumer='one')
        report = self.inspect(host_stopped=True)
        # 'a1' is acknowledged for consumer one and still owed to consumer two.
        self.assertEqual(report['queue']['unacknowledged'], 1)
        self.assertEqual(report['queue']['consumers'], {'one': 1})

    def test_polled_is_reported_as_handed_over_not_as_seen(self):
        host.append_events(self.state, [event('a1')])
        host.pending_events(self.state, 0, 10, consumer='c')
        report = self.inspect(host_stopped=True)
        self.assertEqual(report['queue']['handed_over'], 1)
        self.assertIn('polled is not the same as seen', ' '.join(report['reasons']))


class MutationTest(State, unittest.TestCase):
    def test_neutering_the_legacy_branch_changes_the_verdict(self):
        """If this still passed with a permissive copy, the suite would be decoration."""
        self.lock(b'')
        copy = os.path.join(self.state, 'permissive_preflight.py')
        with io.open(TOOL, 'r', encoding='utf-8') as handle:
            source = handle.read()
        mutant = source.replace("        needs_manual = True\n    elif lock['kind'] == 'unknown':",
                                "        needs_manual = False\n    elif lock['kind'] == 'unknown':")
        self.assertNotEqual(mutant, source, 'the mutation target moved')
        with io.open(copy, 'w', encoding='utf-8') as handle:
            handle.write(mutant)
        import importlib.util
        spec = importlib.util.spec_from_file_location('mutant_preflight', copy)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        report = module.inspect(self.state, host_stopped=True)
        self.assertEqual(report['lock']['kind'], 'legacy_empty')
        self.assertEqual(report['verdict'], module.VERDICT_SAFE,
                         'the mutant was supposed to be permissive; the mutation is wrong')
        self.assertNotEqual(report['verdict'], PREFLIGHT.VERDICT_LEGACY,
                            'the real tool and the mutant agree, so the assertion in '
                            'test_an_empty_lock_is_the_old_protocol proves nothing')


if __name__ == '__main__':
    unittest.main()
