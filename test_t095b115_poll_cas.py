"""T095B115: `poll` is the one writer that saves without saying which generation it read.

`append_events` and `ack_events` both pass `expect=doc.get('generation')`, so a stale snapshot is
refused instead of published. `pending_events` writes `deliveredAt`/`deliveries` back with
`save_queue(state_dir, doc)` -- no expectation. That is safe exactly as long as the operating
system lock excludes every other writer, which is true for one process on a well-behaved
filesystem and is *not* a guarantee this code can make (T099: a writable state directory lets
another process replace the lock inode, and then two writers each hold "the lock").

This suite removes the lock deliberately -- a no-op context manager standing in for "the lock did
not exclude" -- and drives a real interleaving: poll takes its snapshot, a committed append lands,
poll writes its stale document back. Then the same scenario with the expectation in place, to show
the difference is a refusal rather than a lost event.

Nothing outside a `mkdtemp` directory is touched.
"""
import errno
import json
import os
import shutil
import tempfile
import time
import unittest

import host


class NullLock(object):
    """`_Lock` that does not exclude: what an ineffective lock behaves like."""

    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def legacy_doc():
    now = int(time.time())
    return {
        'version': 1, 'next_seq': 3,
        'events': [
            {'eventId': 'evt-1', 'runId': 'r', 'seq': 1, 'deliveredAt': None,
             'deliveries': 0, 'message': 'm1'},
        ],
        'acked': [],
        'consumer_acks': {},
    }


class PollStaleSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t115-poll-')
        self.original_lock = host._Lock
        self.original_load = host.load_queue
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(legacy_doc(), handle, indent=1, sort_keys=True)
        # One real write so the queue carries a generation, which is the state the CAS protects.
        host.append_events(self.state, [{'eventId': 'evt-0', 'runId': 'r', 'text': 'seed'}])

    def tearDown(self):
        host._Lock = self.original_lock
        host.load_queue = self.original_load
        shutil.rmtree(self.state, ignore_errors=True)

    def known(self):
        return host.known_event_ids(self.original_load(self.state))

    def interleave(self, commit):
        """Pause poll right after its snapshot, let `commit` land, then let poll write."""
        host._Lock = NullLock
        calls = {'count': 0}
        pausing = {'active': True}

        def loading(state_dir):
            doc = self.original_load(state_dir)
            if pausing['active']:
                pausing['active'] = False
                host.load_queue = self.original_load
                try:
                    commit(state_dir)
                finally:
                    host.load_queue = loading
            calls['count'] += 1
            return doc

        host.load_queue = loading
        try:
            outcome = 'returned'
            try:
                host.pending_events(self.state, cursor=0, limit=5)
            except host.HostError as exc:
                outcome = 'refused: %s' % exc
        finally:
            host.load_queue = self.original_load
            host._Lock = self.original_lock
        return outcome

    def test_a_stale_poll_snapshot_does_not_drop_a_concurrent_append(self):
        def commit(state_dir):
            host.append_events(state_dir, [{'eventId': 'evt-concurrent', 'runId': 'r',
                                            'text': 'landed while poll was reading'}])

        outcome = self.interleave(commit)
        present = self.known()
        self.assertIn('evt-concurrent', present,
                      'a committed append was erased by poll\'s stale snapshot (%s); '
                      'queue now holds %s' % (outcome, sorted(present)))
        self.assertTrue(outcome.startswith('refused'),
                        'the stale save was published instead of refused: %s' % outcome)
        self.assertIn('changed under this writer', outcome)

    def test_a_stale_poll_snapshot_does_not_drop_a_concurrent_ack(self):
        def commit(state_dir):
            host.ack_events(state_dir, ['evt-1'], consumer=None)

        outcome = self.interleave(commit)
        doc = self.original_load(self.state)
        self.assertIn('evt-1', doc['acked'],
                      'a committed ACK was erased by poll\'s stale snapshot (%s)' % outcome)
        self.assertTrue(outcome.startswith('refused'), outcome)


class PollCompatibilityTest(unittest.TestCase):
    """The rest of poll's contract must not change with the expectation added."""

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t115-poll-compat-')
        self.original_lock = host._Lock

    def tearDown(self):
        host._Lock = self.original_lock
        shutil.rmtree(self.state, ignore_errors=True)

    def test_an_empty_poll_writes_nothing(self):
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'r', 'text': 'a'}])
        before = open(os.path.join(self.state, host.QUEUE_FILE), 'rb').read()
        events, _cursor, _more = host.pending_events(self.state, cursor=99, limit=5)
        self.assertEqual(events, [])
        after = open(os.path.join(self.state, host.QUEUE_FILE), 'rb').read()
        self.assertEqual(before, after, 'a poll that returned nothing still rewrote the queue')

    def test_the_first_poll_on_a_legacy_queue_still_writes(self):
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(legacy_doc(), handle, indent=1, sort_keys=True)
        events, cursor, _more = host.pending_events(self.state, cursor=0, limit=5)
        self.assertEqual([event['eventId'] for event in events], ['evt-1'])
        doc = host.load_queue(self.state)
        self.assertEqual(doc['events'][0]['deliveries'], 1)
        self.assertEqual(doc.get('generation'), 1,
                         'the first write on a queue without a generation must still land')

    def test_a_second_poll_continues_the_generation(self):
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'r', 'text': 'a'}])
        host.pending_events(self.state, cursor=0, limit=5)
        first = host.load_queue(self.state).get('generation')
        host.pending_events(self.state, cursor=0, limit=5)
        second = host.load_queue(self.state).get('generation')
        self.assertGreater(second, first, 'poll stopped advancing the generation')

    def test_ack_pruning_happens_only_when_poll_actually_writes(self):
        doc = legacy_doc()
        doc['events'] = []
        doc['acked'] = ['evt-old']
        doc['acked_at'] = {'evt-old': int(time.time()) - 10 ** 6}
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, indent=1, sort_keys=True)
        host.pending_events(self.state, cursor=0, limit=5)
        self.assertEqual(host.load_queue(self.state)['acked'], ['evt-old'],
                         'a poll that returned nothing must not rewrite the queue at all')
        doc['events'] = [{'eventId': 'evt-due', 'runId': 'r', 'seq': 9,
                          'deliveredAt': None, 'deliveries': 0, 'message': 'm'}]
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, indent=1, sort_keys=True)
        host.pending_events(self.state, cursor=0, limit=5)
        self.assertEqual(host.load_queue(self.state)['acked'], [],
                         'the write that poll does make must still prune expired ACK history')

    def test_an_uncertain_directory_sync_still_surfaces_from_poll(self):
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'r', 'text': 'a'}])
        original = host._sync_directory

        def failing(_state_dir):
            raise OSError(errno.EIO, os.strerror(errno.EIO))

        host._sync_directory = failing
        try:
            with self.assertRaises(host.CommitUncertain):
                host.pending_events(self.state, cursor=0, limit=5)
        finally:
            host._sync_directory = original
        self.assertIn('evt-a', host.known_event_ids(host.load_queue(self.state)))


if __name__ == '__main__':
    unittest.main()
