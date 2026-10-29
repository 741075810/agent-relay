"""T095B86: the queue under concurrency, and what a lost update costs.

`host._Lock` is a create-based lock with a 5 s timeout, and when the timeout expires it
**breaks the lock and proceeds**. That is a deliberate trade -- a dead host must not wedge
delivery forever -- but it means a live holder can be evicted and its write can land after
someone else's. The interesting question is not whether the lock is airtight (it is not,
by design) but whether the loss is *silent*.

It was. Two writers, the second of which entered after evicting the first:

    writer A  read queue -> [slow save] -> wrote [A]        (its own event, at 6.5 s)
    writer B  waited 5 s, broke the lock, read, wrote [A, B] (at 5.2 s)
    disk      [A]                                            -- B's append is gone, and
                                                                 append_events returned 1

The caller was told its event was added and it never was. That is the same class of defect
as T084's swallowed write, one layer lower: not "no answer" but "a confident wrong one".

Fixtures are temporary directories throughout; every id is counted.
"""
import threading
import time
import unittest
import io
import json
import os

import host

from test_t095b82_queue_consistency import QueueScene, event


def _queue_document(self):
    with io.open(os.path.join(self.state, host.QUEUE_FILE), 'r',
                 encoding='utf-8') as handle:
        return json.load(handle)


# T082's scene has the rpc loop; T084's has this reader. One attribute is cheaper than a
# shared base class for a suite that only needs both halves.
QueueScene.queue_document = _queue_document


class LostUpdateTest(QueueScene):
    def slow_save_when(self, marker):
        """Make the save slow for documents containing `marker`, keeping the lock held."""
        real = host.save_queue

        def slow(state_dir, doc):
            events = (doc or {}).get('events') or []
            if any(marker in str((e or {}).get('eventId')) for e in events):
                time.sleep(6.5)
            return real(state_dir, doc)

        host.save_queue = slow
        return lambda: setattr(host, 'save_queue', real)

    def test_a_slow_writer_is_not_silently_overwritten(self):
        restore = self.slow_save_when('slow')
        box = {}
        try:
            writer = threading.Thread(
                target=lambda: box.update(added=host.append_events(
                    self.state, [event('slow')])))
            writer.start()
            time.sleep(0.3)                        # A is inside the lock, in its save
            host.append_events(self.state, [event('fast')])
            writer.join(20)
        finally:
            restore()
        ids = sorted(e['eventId'] for e in self.queue_document()['events'])
        self.assertEqual(ids, ['fast', 'slow'],
                         'one of two concurrent appends was lost (disk holds %r)' % (ids,))
        self.assertEqual(box.get('added'), 1)

    def test_a_slow_ack_cannot_be_silently_dropped(self):
        host.append_events(self.state, [event('e1')])
        restore = self.slow_save_when('e1')
        try:
            writer = threading.Thread(
                target=lambda: self.rpc('ack', {'acked': ['e1'],
                                                'consumer': 'slow-consumer'}))
            writer.start()
            time.sleep(0.3)
            self.rpc('ack', {'acked': ['e1'], 'consumer': 'fast-consumer'})
            writer.join(20)
        finally:
            restore()
        document = self.queue_document()
        acked = set(document.get('acked') or [])
        for values in (document.get('consumer_acks') or {}).values():
            acked |= set(values)
        self.assertIn('e1', acked, 'the acknowledgement vanished from disk')
        consumers = set(document.get('consumer_acks') or {})
        self.assertIn('fast-consumer', consumers,
                      'the second consumer\'s ack was overwritten')

    def test_a_verification_failure_is_reported_rather_than_swallowed(self):
        """If the write cannot be made to stick, the caller must hear about it -- an
        append that reports success and leaves nothing behind is worse than an error."""
        real = host.save_queue
        host.save_queue = lambda state_dir, doc: None        # pretends to write
        try:
            with self.assertRaises(Exception):
                host.append_events(self.state, [event('e9')])
        finally:
            host.save_queue = real


class ConcurrentAppendTest(QueueScene):
    def test_two_fast_appends_both_survive(self):
        box = {}

        def add(name):
            box[name] = host.append_events(self.state, [event(name)])

        threads = [threading.Thread(target=add, args=('t%d' % i,)) for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(20)
        ids = sorted(e['eventId'] for e in self.queue_document()['events'])
        self.assertEqual(ids, ['t0', 't1', 't2', 't3'], 'concurrent appends lost events: %r'
                         % (ids,))
        self.assertEqual(sorted(box.values()), [1, 1, 1, 1])


class CursorTest(QueueScene):
    def test_a_cursor_page_neither_repeats_nor_skips(self):
        host.append_events(self.state, [event('a'), event('b'), event('c')])
        first = self.rpc('poll', {'consumer': 'p', 'limit': 2})['result']
        self.assertEqual([e['eventId'] for e in first['events']], ['a', 'b'])
        cursor = first['cursor']
        host.append_events(self.state, [event('d')])
        rest = self.rpc('poll', {'consumer': 'p', 'cursor': cursor})['result']['events']
        self.assertEqual([e['eventId'] for e in rest], ['c', 'd'],
                         'the page after the cursor is wrong: %r'
                         % ([e['eventId'] for e in rest],))


if __name__ == '__main__':
    unittest.main()
