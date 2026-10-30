"""T095B104: what happens when the filesystem cannot publish the lock atomically?

T101 publishes `queue.lock` by writing a scratch file and `os.link`-ing it into place, so the
path never exists without its marker. The `except OSError` branch was written as "no hard links
here, carry on" -- which silently falls back to `O_CREAT` + write, the very window T101 removed.

This suite injects the errors a real unsupported filesystem produces (EOPNOTSUPP from a FAT or
exFAT volume, EPERM from some network shares, EXDEV across a bind mount) and asks whether the
host refuses or quietly creates the empty file. Refusing is the only answer that keeps the
promise: an empty lock file is indistinguishable from a pre-T088 remnant, so publishing one
hands the next writer a false conclusion.
"""
import errno
import os
import shutil
import tempfile
import unittest

import host

UNSUPPORTED = [
    (errno.EOPNOTSUPP, 'hard links are not supported on this filesystem'),
    (errno.EPERM, 'the filesystem refuses link'),
    (errno.EXDEV, 'the link would cross a device boundary'),
]


class LinkUnavailableTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t104-state-')
        self.lock_path = os.path.join(self.state, host.LOCK_FILE)
        self.original = host.os.link

    def tearDown(self):
        host.os.link = self.original
        shutil.rmtree(self.state, ignore_errors=True)

    def inject(self, exc):
        def failing(_src, _dst):
            raise exc
        host.os.link = failing

    def assert_clean_failure(self, error):
        message = str(error)
        self.assertIn('lock', message.lower())
        self.assertIn('hard link', message.lower(), message)
        self.assertIn(self.state, message, 'the message must name the directory to fix')
        self.assertFalse(os.path.exists(self.lock_path),
                         'an unsupported filesystem must not leave an empty lock behind')
        leftovers = [name for name in os.listdir(self.state) if '.tmp-' in name]
        self.assertEqual(leftovers, [], 'a scratch file survived the refusal: %s' % leftovers)

    def test_each_unsupported_error_refuses_instead_of_falling_back(self):
        for number, why in UNSUPPORTED:
            with self.subTest(errno=number):
                self.inject(OSError(number, os.strerror(number)))
                with self.assertRaises(host.HostError) as caught:
                    host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'run-a',
                                                     'text': 'x'}])
                self.assert_clean_failure(caught.exception)
                self.assertIn(errno.errorcode[number], str(caught.exception),
                              'the operator needs the errno name, not just prose: %s' % why)
                self.assertEqual(os.listdir(self.state), [],
                                 'the state directory must be left exactly as it was found')

    def test_an_existing_lock_is_not_a_refusal(self):
        """FileExistsError means somebody else published it first: keep going."""
        self.inject(FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST)))
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'run-a', 'text': 'x'}])
        known = host.known_event_ids(host.load_queue(self.state))
        self.assertIn('evt-a', known)
        with open(self.lock_path, 'rb') as handle:
            blob = handle.read(64)
        self.assertTrue(blob.startswith(b'\x00' + host.LOCK_MARKER), blob[:32])

    def test_the_normal_path_still_publishes_and_leaves_no_scratch(self):
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'run-a', 'text': 'x'}])
        with open(self.lock_path, 'rb') as handle:
            blob = handle.read(80)
        self.assertTrue(blob.startswith(b'\x00' + host.LOCK_MARKER), blob[:32])
        leftovers = [name for name in os.listdir(self.state) if '.tmp-' in name]
        self.assertEqual(leftovers, [])

    def test_a_legacy_empty_lock_is_still_refused_before_any_link(self):
        with open(self.lock_path, 'wb'):
            pass
        before = os.stat(self.lock_path).st_ino
        with self.assertRaises(host.HostError) as caught:
            host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'run-a',
                                             'text': 'x'}])
        self.assertIn('pre-t088', str(caught.exception).lower())
        self.assertEqual(os.stat(self.lock_path).st_ino, before)
        self.assertEqual(os.path.getsize(self.lock_path), 0)


if __name__ == '__main__':
    unittest.main()
