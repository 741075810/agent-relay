"""T095B116: two writers that both loaded a queue with no generation.

T115 closed the stale-snapshot hole for queues that carry a generation. The pre-upgrade queue has
none, so every caller passed `expect=None`, and `save_queue` reads that as "do not compare" --
which is not the same statement as "the file I read had no generation". Two writers can therefore
both load the legacy document, the first commits `generation: 1` plus its event, and the second
publishes its own stale document on top: the first writer's event or ACK is gone and both reported
success. That is the same failure T100 fixed for upgraded queues, sitting in the one window where
the queue has not been upgraded yet.

The fix keeps `expect=None` meaning what it always meant (no comparison, for callers that have no
snapshot to defend) and adds a sentinel for "I read the file and it had no generation". A writer
holding that snapshot is refused if somebody else created the generation first, and creates
`generation: 1` itself when nobody did.

Everything runs in a `mkdtemp`; the lock is removed on purpose to model "the lock did not exclude"
(T099), because with a working lock these interleavings cannot happen.
"""
import json
import os
import shutil
import tempfile
import time
import unittest

import host


class NullLock(object):
    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def legacy_doc(next_seq=3):
    return {
        'version': 1, 'next_seq': next_seq,
        'events': [
            {'eventId': 'evt-legacy', 'runId': 'r', 'seq': 1, 'deliveredAt': None,
             'deliveries': 0, 'message': 'legacy'},
        ],
        'acked': [],
        'consumer_acks': {},
    }


class LegacyFirstWriteTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t116-legacy-')
        self.original_lock = host._Lock
        self.original_load = host.load_queue
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(legacy_doc(), handle, indent=1, sort_keys=True)

    def tearDown(self):
        host._Lock = self.original_lock
        host.load_queue = self.original_load
        shutil.rmtree(self.state, ignore_errors=True)

    def known(self):
        return host.known_event_ids(self.original_load(self.state))

    def generation(self):
        return self.original_load(self.state).get('generation')

    def interleave(self, operation, commit):
        """Run `operation` with a snapshot taken, let `commit` land, then let it save."""
        host._Lock = NullLock
        state = {'first': True}

        def loading(state_dir):
            doc = self.original_load(state_dir)
            if state['first']:
                state['first'] = False
                host.load_queue = self.original_load
                try:
                    commit(state_dir)
                finally:
                    host.load_queue = loading
            return doc

        host.load_queue = loading
        outcome = 'returned'
        try:
            operation()
        except host.HostError as exc:
            outcome = 'refused: %s' % exc
        finally:
            host.load_queue = self.original_load
            host._Lock = self.original_lock
        return outcome

    def test_a_second_first_writer_does_not_erase_the_one_that_committed(self):
        """Both writers get their event, and the loser gets it by reloading, not by winning
        a race it should have lost."""

        def commit(state_dir):
            host.append_events(state_dir, [{'eventId': 'evt-first', 'runId': 'r',
                                            'text': 'the writer that won'}])

        outcome = self.interleave(
            lambda: host.append_events(self.state, [{'eventId': 'evt-second', 'runId': 'r',
                                                     'text': 'the writer that was late'}]),
            commit)
        present = self.known()
        self.assertIn('evt-first', present,
                      'the committed event was erased by a stale pre-upgrade snapshot (%s); '
                      'queue holds %s' % (outcome, sorted(present)))
        self.assertIn('evt-second', present, 'the late writer gave up instead of retrying')
        self.assertEqual(self.generation(), 2,
                         'two committed writes on a legacy queue must leave generation 2')

    def test_save_queue_refuses_a_snapshot_that_predates_the_generation(self):
        """The precise unit: the sentinel means "I read a queue with no generation"."""
        stale = self.original_load(self.state)
        self.assertNotIn('generation', stale)
        host.append_events(self.state, [{'eventId': 'evt-first', 'runId': 'r', 'text': 'won'}])
        with self.assertRaises(host.HostError) as caught:
            host.save_queue(self.state, dict(stale), expect=host.NO_GENERATION)
        self.assertIn('changed under this writer', str(caught.exception))
        self.assertIn('evt-first', self.known(), 'the refused save still published')

    def test_the_sentinel_still_writes_when_nobody_else_has(self):
        doc = self.original_load(self.state)
        host.save_queue(self.state, dict(doc), expect=host.NO_GENERATION)
        self.assertEqual(self.generation(), 1)

    def test_expect_none_is_still_no_comparison(self):
        """Callers with no snapshot keep the behaviour they had."""
        doc = self.original_load(self.state)
        host.append_events(self.state, [{'eventId': 'evt-first', 'runId': 'r', 'text': 'x'}])
        doc['events'].append({'eventId': 'evt-forced', 'runId': 'r', 'seq': 2,
                              'deliveredAt': None, 'deliveries': 0, 'message': 'm'})
        host.save_queue(self.state, doc, expect=None)
        # No comparison, as documented: the write lands even though it is stale, and the
        # append that happened in between is gone. This is the reason no call site in host.py
        # passes None -- the assertion records the hazard rather than pretending it is safe.
        self.assertIn('evt-forced', self.known())
        self.assertNotIn('evt-first', self.known(),
                         'expect=None started comparing; callers that rely on it being a plain '
                         'write would now raise')

    def test_a_late_poll_on_a_legacy_queue_does_not_erase_a_committed_append(self):
        def commit(state_dir):
            host.append_events(state_dir, [{'eventId': 'evt-first', 'runId': 'r', 'text': 'won'}])

        outcome = self.interleave(
            lambda: host.pending_events(self.state, cursor=0, limit=5), commit)
        self.assertIn('evt-first', self.known(), outcome)
        self.assertTrue(outcome.startswith('refused'), outcome)

    def test_a_late_ack_on_a_legacy_queue_does_not_erase_a_committed_append(self):
        def commit(state_dir):
            host.append_events(state_dir, [{'eventId': 'evt-first', 'runId': 'r', 'text': 'won'}])

        outcome = self.interleave(
            lambda: host.ack_events(self.state, ['evt-legacy'], consumer=None), commit)
        self.assertIn('evt-first', self.known(), outcome)
        self.assertTrue(outcome.startswith('refused'), outcome)

    # -- the cases that must keep working ------------------------------------------------
    def test_the_only_first_writer_still_upgrades_the_queue(self):
        added = host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'r', 'text': 'a'}])
        self.assertEqual(added, 1)
        self.assertEqual(self.generation(), 1)
        self.assertEqual(sorted(self.known()),
                         sorted(['evt-legacy', 'evt-a', 'evt-acked-none'][:2]))

    def test_a_brand_new_state_directory_still_gets_its_first_write(self):
        fresh = tempfile.mkdtemp(prefix='t116-fresh-')
        try:
            host.append_events(fresh, [{'eventId': 'evt-a', 'runId': 'r', 'text': 'a'}])
            self.assertEqual(host.load_queue(fresh).get('generation'), 1)
            host.append_events(fresh, [{'eventId': 'evt-b', 'runId': 'r', 'text': 'b'}])
            self.assertEqual(host.load_queue(fresh).get('generation'), 2,
                             'a normal second write was refused as if it were stale')
        finally:
            shutil.rmtree(fresh, ignore_errors=True)

    def test_sequential_writers_are_never_refused(self):
        for index in range(4):
            host.append_events(self.state, [{'eventId': 'evt-%d' % index, 'runId': 'r',
                                             'text': 'x'}])
        self.assertEqual(self.generation(), 4)
        host.ack_events(self.state, ['evt-legacy'], consumer=None)
        host.pending_events(self.state, cursor=0, limit=5)
        self.assertGreaterEqual(self.generation(), 5)


class IllegalGenerationTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t116-illegal-')
        self.original_load = host.load_queue

    def tearDown(self):
        host.load_queue = self.original_load
        shutil.rmtree(self.state, ignore_errors=True)

    def write(self, doc):
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, indent=1, sort_keys=True)

    def refuse(self, generation):
        doc = legacy_doc()
        doc['generation'] = generation
        self.write(doc)
        with self.assertRaises(host.HostError) as caught:
            host.append_events(self.state, [{'eventId': 'evt-x', 'runId': 'r', 'text': 'x'}])
        self.assertNotIn('changed under this writer', str(caught.exception),
                         'an unreadable generation was reported as a concurrent writer: %s'
                         % caught.exception)
        self.assertIn('generation', str(caught.exception).lower())

    def test_a_generation_that_is_a_string_is_refused(self):
        self.refuse('7')

    def test_a_generation_that_is_a_boolean_is_refused(self):
        self.refuse(True)

    def test_a_negative_generation_is_refused(self):
        self.refuse(-1)


class UncertainCommitStillSurfacesTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t116-uncertain-')
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(legacy_doc(), handle, indent=1, sort_keys=True)

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)

    def test_a_failing_directory_sync_on_the_first_write_is_still_uncertain(self):
        original = host._sync_directory

        def failing(_state_dir):
            raise OSError(5, 'Input/output error')

        host._sync_directory = failing
        try:
            with self.assertRaises(host.CommitUncertain):
                host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'r', 'text': 'a'}])
        finally:
            host._sync_directory = original
        doc = host.load_queue(self.state)
        self.assertIn('evt-a', host.known_event_ids(doc))
        self.assertEqual(doc.get('generation'), 1, 'the first write created the generation')


if __name__ == '__main__':
    unittest.main()
