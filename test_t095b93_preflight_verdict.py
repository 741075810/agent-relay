"""T095B93: what the preflight is allowed to call `safe_to_start`.

T092 taught it to notice that a path goes through a link, and to notice that a file changed
between the check and the open. Neither changed the verdict, so a green light could still be
printed about a directory the operator did not name, or about a tree that was swapped while
it was being read.

Three claims are pinned here, and each one is a red test before the change:

  * recognising a redirected path is not the same as being allowed to approve it -- the
    resolved location has to be acknowledged explicitly before it can be called safe;
  * the lock and the queue must be proven to come from the same directory, so the directory's
    own identity is compared before and after the reads;
  * a queue whose `version` this code does not know is not something to approve quietly.
"""
import io
import json
import os
import shutil
import tempfile
import unittest

import host

from test_t095b90_upgrade_preflight import PREFLIGHT, snapshot


class Base(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t093-state-')
        self.outside = tempfile.mkdtemp(prefix='t093-outside-')

    def tearDown(self):
        for path in (self.state, self.outside):
            shutil.rmtree(path, ignore_errors=True)

    def write_queue(self, document):
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w',
                     encoding='utf-8') as out:
            json.dump(document, out)


class RedirectedPathTest(Base):
    def test_a_redirected_state_path_is_not_approved_on_its_own(self):
        real = os.path.join(self.outside, 'real-state')
        os.makedirs(real)
        host.append_events(real, [{'eventId': 'e1', 'runId': 'run-e1', 'text': 'x'}])
        link = os.path.join(self.outside, 'linked-state')
        os.symlink(real, link)
        report = PREFLIGHT.inspect(link, host_stopped=True)
        self.assertEqual(report['paths']['realpath'], os.path.realpath(real))
        self.assertTrue(report['paths']['through_symlink'])
        self.assertNotEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE,
                            'a path that resolves elsewhere was approved without anyone '
                            'saying that the resolution was expected')

    def test_acknowledging_the_resolved_path_restores_approval(self):
        real = os.path.join(self.outside, 'real-state')
        os.makedirs(real)
        host.append_events(real, [{'eventId': 'e1', 'runId': 'run-e1', 'text': 'x'}])
        link = os.path.join(self.outside, 'linked-state')
        os.symlink(real, link)
        report = PREFLIGHT.inspect(link, host_stopped=True,
                                   accept_realpath=os.path.realpath(real))
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)

    def test_acknowledging_a_different_path_does_not(self):
        real = os.path.join(self.outside, 'real-state')
        os.makedirs(real)
        link = os.path.join(self.outside, 'linked-state')
        os.symlink(real, link)
        report = PREFLIGHT.inspect(link, host_stopped=True,
                                   accept_realpath=os.path.join(self.outside, 'somewhere-else'))
        self.assertNotEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)

    def test_an_ordinary_directory_still_approves_without_any_acknowledgement(self):
        host.append_events(self.state, [{'eventId': 'e1', 'runId': 'run-e1', 'text': 'x'}])
        report = PREFLIGHT.inspect(self.state, host_stopped=True)
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)
        self.assertFalse(report['paths']['through_symlink'])


class DirectoryIdentityTest(Base):
    def test_a_directory_replaced_between_the_reads_is_not_approved(self):
        """The lock and the queue must be shown to come from one tree. If the directory
        itself is swapped mid-inspection, the two halves of the report describe different
        installations and neither describes "the" state."""
        host.append_events(self.state, [{'eventId': 'e1', 'runId': 'run-e1', 'text': 'x'}])
        real = PREFLIGHT._dir_identity
        seen = {'count': 0}

        def changing(path):
            seen['count'] += 1
            value = real(path)
            return value if seen['count'] == 1 else (value[0], value[1] + 4242)

        PREFLIGHT._dir_identity = changing
        try:
            report = PREFLIGHT.inspect(self.state, host_stopped=True)
        finally:
            PREFLIGHT._dir_identity = real
        self.assertGreaterEqual(seen['count'], 2,
                                'the directory identity was not checked twice')
        self.assertNotEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)
        self.assertIn('director', ' '.join(report['reasons']).lower())


class QueueVersionTest(Base):
    def test_a_queue_version_this_code_does_not_know_is_not_approved(self):
        self.write_queue({'version': 99, 'next_seq': 1, 'events': [], 'acked': []})
        report = PREFLIGHT.inspect(self.state, host_stopped=True)
        self.assertNotEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE,
                            'a queue from an unknown version of this code was approved')
        self.assertIn('version', ' '.join(report['reasons']).lower())

    def test_the_known_version_is_approved(self):
        self.write_queue({'version': 1, 'next_seq': 1, 'events': [], 'acked': []})
        report = PREFLIGHT.inspect(self.state, host_stopped=True)
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)

    def test_a_queue_without_a_version_field_is_refused_not_migrated(self):
        """load_queue requires version 1, so a document without it is not this code's
        queue. The preflight reports that rather than quietly treating it as the oldest
        format -- a guess here would be a guess about somebody's data."""
        self.write_queue({'next_seq': 1, 'events': [], 'acked': []})
        report = PREFLIGHT.inspect(self.state, host_stopped=True)
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_DAMAGED)
        self.assertEqual(report['exit_code'], PREFLIGHT.EXIT_DAMAGED)
        self.assertIn('queue', report['queue']['error'].lower())


class ReadOnlyStillHoldsTest(Base):
    def test_the_directory_is_unchanged_for_every_verdict(self):
        self.write_queue({'version': 99, 'next_seq': 1, 'events': [], 'acked': []})
        before = snapshot(self.state)
        PREFLIGHT.inspect(self.state, host_stopped=True)
        self.assertEqual(snapshot(self.state), before)


if __name__ == '__main__':
    unittest.main()
