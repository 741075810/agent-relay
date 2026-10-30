"""T095B91: ack concurrency, and what the read-only preflight does with a symlink.

Two questions, one suite.

**Acks.** `ack_events`, `pending_events` and `append_events` all take the same OS lock, but
only `append_events` verifies its write. If the lock were not enough -- or if an ack could be
reported without landing -- two consumers' records would silently overwrite each other, which
is the failure that looks like "the notification came twice" months later. Each case below is
deterministic: no sleeps deciding an outcome, only a held lock and a joined thread.

**Symlinks.** The preflight's promise is that it reads what this state directory contains and
changes nothing. A symbolic link at the lock or queue path is neither: following it means
reporting on some other file, and an operator acting on that report would be acting on the
wrong thing. It must be named, not followed.
"""
import io
import json
import os
import shutil
import tempfile
import threading
import time
import unittest

import host

from test_t095b82_queue_consistency import QueueScene, event
from test_t095b90_upgrade_preflight import PREFLIGHT, snapshot


def ack(state_dir, ids, consumer=None):
    return host.ack_events(state_dir, ids, consumer=consumer)


class AckConcurrencyTest(QueueScene):
    def test_two_consumers_ack_the_same_event_and_both_are_kept(self):
        host.append_events(self.state, [event('e1')])
        results = {}
        threads = []
        for name in ('one', 'two'):
            thread = threading.Thread(
                target=lambda n=name: results.__setitem__(n, ack(self.state, ['e1'], n)))
            threads.append(thread)
            thread.start()
        for thread in threads:
            thread.join(30)
        doc = host.load_queue(self.state)
        self.assertEqual(results, {'one': 1, 'two': 1})
        self.assertIn('e1', doc['consumer_acks']['one'])
        self.assertIn('e1', doc['consumer_acks']['two'])

    def test_an_ack_is_idempotent_and_does_not_duplicate(self):
        host.append_events(self.state, [event('e1')])
        self.assertEqual(ack(self.state, ['e1'], 'one'), 1)
        self.assertEqual(ack(self.state, ['e1'], 'one'), 0)
        doc = host.load_queue(self.state)
        self.assertEqual(doc['consumer_acks']['one'], ['e1'])

    def test_an_ack_that_cannot_be_saved_is_not_reported(self):
        host.append_events(self.state, [event('e1')])
        real = host.save_queue

        def refuse(state_dir, doc, expect=None):
            raise OSError('disk is full')

        host.save_queue = refuse
        try:
            with self.assertRaises(OSError):
                ack(self.state, ['e1'], 'one')
        finally:
            host.save_queue = real
        doc = host.load_queue(self.state)
        self.assertNotIn('one', doc.get('consumer_acks') or {},
                         'the ack was recorded although its save failed')

    def test_an_append_cannot_slip_under_an_ack_that_holds_the_lock(self):
        host.append_events(self.state, [event('e1')])
        real = host.save_queue
        holding = threading.Event()
        release = threading.Event()

        def gated(state_dir, doc, expect=None):
            if not holding.is_set() and 'consumer_acks' in doc:
                holding.set()
                release.wait(30)
            return real(state_dir, doc, expect=expect)

        host.save_queue = gated
        box = {}
        try:
            thread = threading.Thread(
                target=lambda: box.__setitem__('ack', ack(self.state, ['e1'], 'one')))
            thread.start()
            self.assertTrue(holding.wait(10), 'the ack never reached its save')
            intruder = threading.Thread(
                target=lambda: box.__setitem__(
                    'append', host.append_events(self.state, [event('e2')])))
            intruder.start()
            time.sleep(0.5)
            during = {e['eventId'] for e in host.load_queue(self.state)['events']}
            self.assertNotIn('e2', during, 'an append entered while an ack held the lock')
            release.set()
            thread.join(30)
            intruder.join(30)
        finally:
            host.save_queue = real
            release.set()
        doc = host.load_queue(self.state)
        self.assertEqual(sorted(e['eventId'] for e in doc['events']), ['e1', 'e2'])
        self.assertIn('e1', doc['consumer_acks']['one'])
        self.assertEqual(box.get('append'), 1)

    def test_a_scoped_ack_does_not_silence_a_global_poll(self):
        host.append_events(self.state, [event('e1')])
        ack(self.state, ['e1'], 'one')
        events, _cursor, _more = host.pending_events(self.state, 0, 10)
        self.assertEqual([e['eventId'] for e in events], ['e1'],
                         'a per-consumer ack suppressed delivery to everyone')

    def test_a_global_ack_does_not_silence_a_scoped_consumer(self):
        host.append_events(self.state, [event('e1')])
        ack(self.state, ['e1'])
        events, _cursor, _more = host.pending_events(self.state, 0, 10, consumer='two')
        self.assertEqual([e['eventId'] for e in events], ['e1'],
                         'a global ack suppressed a scoped consumer that never acked')

    def test_an_old_queue_without_ack_fields_accepts_an_ack(self):
        document = {'version': 1, 'next_seq': 2,
                    'events': [dict(event('legacy'), seq=1, enqueuedAt=1,
                                    deliveredAt=None, deliveries=0)]}
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w',
                     encoding='utf-8') as out:
            json.dump(document, out)
        self.assertEqual(ack(self.state, ['legacy'], 'one'), 1)
        doc = host.load_queue(self.state)
        self.assertIn('legacy', doc['consumer_acks']['one'])

    def test_an_ack_of_an_unknown_event_changes_nothing(self):
        host.append_events(self.state, [event('e1')])
        self.assertEqual(ack(self.state, ['never-existed'], 'one'), 0)
        doc = host.load_queue(self.state)
        self.assertNotIn('never-existed',
                         json.dumps(doc.get('consumer_acks') or {}))


class PreflightSymlinkTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t091-preflight-')
        self.outside = tempfile.mkdtemp(prefix='t091-outside-')

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)
        shutil.rmtree(self.outside, ignore_errors=True)

    def test_a_symlinked_lock_is_named_not_followed(self):
        target = os.path.join(self.outside, 'somebody-elses-lock')
        with io.open(target, 'wb') as out:
            out.write(b'\x00' + host.LOCK_MARKER + b' feedface')
        os.symlink(target, os.path.join(self.state, host.LOCK_FILE))
        before = snapshot(self.state)
        report = PREFLIGHT.inspect(self.state, host_stopped=True)
        self.assertEqual(snapshot(self.state), before)
        self.assertEqual(report['lock']['kind'], 'symlink',
                         'the preflight followed a symlink and reported on another file')
        self.assertNotEqual(report['exit_code'], 0)
        self.assertIn('symbolic link', ' '.join(report['reasons']).lower())

    def test_a_symlinked_queue_is_not_read_through(self):
        target = os.path.join(self.outside, 'somebody-elses-queue.json')
        with io.open(target, 'w', encoding='utf-8') as out:
            json.dump({'version': 1, 'next_seq': 3, 'events': [], 'acked': []}, out)
        os.symlink(target, os.path.join(self.state, host.QUEUE_FILE))
        before = snapshot(self.state)
        report = PREFLIGHT.inspect(self.state, host_stopped=True)
        self.assertEqual(snapshot(self.state), before)
        self.assertFalse(report['queue']['readable'],
                         'the preflight read a queue file from outside the state directory')
        self.assertNotEqual(report['exit_code'], 0)

    def test_an_ordinary_state_directory_is_unaffected(self):
        host.append_events(self.state, [event('e1')])
        report = PREFLIGHT.inspect(self.state, host_stopped=True)
        self.assertEqual(report['verdict'], PREFLIGHT.VERDICT_SAFE)
        self.assertEqual(report['lock']['kind'], 'os_v1')


if __name__ == '__main__':
    unittest.main()
