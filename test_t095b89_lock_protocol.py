"""T095B89: the old lock and the new lock cannot see each other.

T088 replaced a create-and-delete lock file with an operating-system lock on a file that is
never deleted. Both protocols use the same path, and neither can see the other:

  * the old host creates the file with `O_EXCL` and unlinks it when done -- it holds no OS
    lock, so the new host's `flock` succeeds straight through the middle of its write;
  * worse, that `O_EXCL` create fails while the new host's file exists, so an old host that
    is running spins and then **unlinks the new host's lock**, after which a third process
    creates a fresh inode and excludes someone else instead.

An upgrade is therefore not transparent. The safe posture is to refuse rather than to
pretend the two are mutually exclusive: if the lock file is not the one this code wrote, it
is somebody else's protocol, and the queue must not be touched.
"""
import json
import os
import threading
import time
import unittest

import host

from test_t095b82_queue_consistency import QueueScene, event


class LegacyProtocolTest(QueueScene):
    def test_a_legacy_lock_file_is_refused_not_adopted(self):
        """An empty lock file is what the pre-T088 host creates, and it is not ours."""
        legacy = os.path.join(self.state, host.LOCK_FILE)
        with open(legacy, 'wb'):
            pass                                        # the old host's empty artefact
        started = time.time()
        with self.assertRaises(host.HostError) as caught:
            host.append_events(self.state, [event('too-early')])
        message = str(caught.exception)
        self.assertIn('lock', message.lower())
        self.assertGreater(time.time() - started, 1.0,
                           'the refusal came so fast that nothing was waited for')
        self.assertFalse(
            os.path.exists(os.path.join(self.state, host.QUEUE_FILE)),
            'the queue was written while a foreign lock file was in place')

    def test_a_lock_file_from_an_unknown_writer_is_refused(self):
        foreign = os.path.join(self.state, host.LOCK_FILE)
        with open(foreign, 'wb') as handle:
            handle.write(b'999999')                     # a pid, from a protocol not ours
        with self.assertRaises(host.HostError):
            host.append_events(self.state, [event('nope')])

    def test_our_own_lock_file_is_accepted(self):
        """Round trip: the first write leaves a file this code recognises."""
        self.assertEqual(host.append_events(self.state, [event('first')]), 1)
        with open(os.path.join(self.state, host.LOCK_FILE), 'rb') as handle:
            self.assertEqual(handle.read().strip(), host.LOCK_MARKER)
        self.assertEqual(host.append_events(self.state, [event('second')]), 1)

    @unittest.skipIf(os.name == 'nt',
                     'Windows refuses to unlink a file that is open, so the old host cannot '
                     'replace a held lock there; on POSIX it can and does')
    def test_a_lock_swapped_under_the_holder_is_detected(self):
        """If the path stops naming the file we locked, exclusion is gone -- and the old
        host's unlink does exactly that."""
        real_save = host.save_queue
        swapped = {}

        def save_after_swap(state_dir, doc, expect=None):
            if not swapped:
                swapped['done'] = True
                path = os.path.join(state_dir, host.LOCK_FILE)
                os.unlink(path)                       # an old host breaking the lock
                with open(path, 'wb') as handle:      # a peer creating a fresh one
                    handle.write(host.LOCK_MARKER)
            return real_save(state_dir, doc, expect=expect)

        host.save_queue = save_after_swap
        try:
            with self.assertRaises(host.HostError):
                host.append_events(self.state, [event('inside')])
        finally:
            host.save_queue = real_save
        self.assertTrue(swapped.get('done'), 'the swap was never injected')


class ConcurrencyStillHoldsTest(QueueScene):
    def test_two_consumers_ack_different_events_without_eating_each_other(self):
        host.append_events(self.state, [event('a1'), event('a2')])
        host.ack_events(self.state, ['a1'], consumer='one')
        host.ack_events(self.state, ['a2'], consumer='two')
        doc = host.load_queue(self.state)
        self.assertIn('a1', doc['consumer_acks']['one'])
        self.assertIn('a2', doc['consumer_acks']['two'])

    def test_a_lock_timeout_refuses_instead_of_reporting_success(self):
        held = threading.Event()
        release = threading.Event()

        def hog():
            with host._Lock(self.state, timeout_s=30):
                held.set()
                release.wait(30)

        thread = threading.Thread(target=hog)
        thread.start()
        self.assertTrue(held.wait(10))
        try:
            started = time.time()
            with self.assertRaises(host.HostError) as caught:
                with host._Lock(self.state, timeout_s=0.5):
                    pass
            self.assertIn('lock', str(caught.exception).lower())
            self.assertLess(time.time() - started, 10.0)
        finally:
            release.set()
            thread.join(30)


if __name__ == '__main__':
    unittest.main()
