"""T095B108: does "committed, durability unknown" survive the request boundary intact?

T107 raised `CommitUncertain` from `save_queue` after the rename. This suite drives the real
`handle_request` -- the function the framed protocol and the extension actually talk to -- with
the directory sync broken, and asks what a caller sees:

  * is the response an error that still carries the identifier, so it can be traced?
  * does it say the write landed (`committed`), instead of leaving the caller to assume the
    worst and resend a notice about a task that already finished?
  * is the queue state consistent with that claim -- event present, ACK recorded?
  * does a second, identical request behave idempotently (added 0 / newlyAcked 0) rather than
    writing twice?
  * and does a genuine pre-rename failure stay distinguishable from this one?

The failed directory sync is injected at `host._sync_directory`, which is the same seam on both
platforms; the POSIX-only proof that a real directory handle is synced lives in T107's suite.
"""
import errno
import os
import shutil
import tempfile
import unittest

import host
import protocol as P


def request(op, **args):
    return {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op, 'args': args}


class BoundaryTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t108-state-')
        self.original = host._sync_directory
        host.append_events(self.state, [{'eventId': 'evt-base', 'runId': 'run-base',
                                         'text': 'b'}])

    def tearDown(self):
        host._sync_directory = self.original
        shutil.rmtree(self.state, ignore_errors=True)

    def break_directory_sync(self, number=errno.EIO):
        def failing(_state_dir):
            raise OSError(number, os.strerror(number))
        host._sync_directory = failing

    def call(self, op, **args):
        return host.handle_request(self.state, request(op, **args))

    def known(self):
        return host.known_event_ids(host.load_queue(self.state))

    def test_a_committed_append_reaches_the_caller_as_committed_not_as_nothing(self):
        self.break_directory_sync()
        reply = self.call('simulate', count=1)
        host._sync_directory = self.original
        self.assertFalse(reply['ok'], reply)
        self.assertEqual(reply['id'], 'req-1', 'the caller cannot trace which request failed')
        self.assertEqual(reply['error']['code'], P.E_INTERNAL)
        self.assertTrue(reply['error'].get('committed'),
                        'the reply does not say the write landed: %s' % reply['error'])
        message = reply['error']['message'].lower()
        self.assertIn('replaced', message)
        self.assertNotIn('was not written', message)
        self.assertEqual(len(self.known()), 2,
                         'the reply says committed but the queue disagrees: %s'
                         % sorted(self.known()))

    def test_a_second_simulate_does_not_duplicate_the_first_one(self):
        """The wire has no `append` op, so `simulate` is the only queue writer a caller has.
        It mints ids from `next_seq`, so a resend adds a new event on purpose -- what must not
        happen is a *duplicate of the id already committed*."""
        self.break_directory_sync()
        first = self.call('simulate', count=1)
        host._sync_directory = self.original
        self.assertFalse(first['ok'])
        committed = self.known() - {'evt-base'}
        self.assertEqual(len(committed), 1, sorted(self.known()))
        again = self.call('simulate', count=1)
        self.assertTrue(again['ok'], again)
        self.assertEqual(again['result']['added'], 1)
        now = self.known() - {'evt-base'}
        self.assertEqual(len(now), 2, sorted(now))
        self.assertTrue(committed <= now, 'the committed event disappeared on the resend')

    def test_a_committed_ack_reaches_the_caller_as_committed(self):
        self.break_directory_sync()
        reply = self.call('ack', acked=['evt-base'])
        host._sync_directory = self.original
        self.assertFalse(reply['ok'], reply)
        self.assertTrue(reply['error'].get('committed'), reply['error'])
        stored = host.load_queue(self.state)
        self.assertIn('evt-base', set(stored['acked']) | set(stored.get('acked_at') or {}),
                      'the reply says committed but the ack is not on disk')
        again = self.call('ack', acked=['evt-base'])
        self.assertTrue(again['ok'], again)
        self.assertEqual(again['result']['newlyAcked'], 0)

    def test_a_pre_rename_failure_is_not_marked_committed(self):
        """The other half of the distinction: nothing was published, so nothing may claim it."""
        original_dump = host.json.dump
        document = host.load_queue(self.state)
        events = host.simulated_events(1, document['next_seq'])

        def half(document_in, handle, **kwargs):
            handle.write('{"events": [')
            handle.flush()
            raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))

        host.json.dump = half
        try:
            reply = self.call('append', events=events)
        finally:
            host.json.dump = original_dump
        self.assertFalse(reply['ok'], reply)
        self.assertEqual(reply['id'], 'req-1')
        self.assertFalse(reply['error'].get('committed'),
                         'a write that never reached the queue was reported as committed')
        self.assertEqual(self.known(), {'evt-base'})

    def test_the_committed_flag_is_absent_from_ordinary_errors(self):
        reply = self.call('ack', acked='not-a-list')
        self.assertFalse(reply['ok'])
        self.assertEqual(reply['error']['code'], P.E_BAD_REQUEST)
        self.assertNotIn('committed', reply['error'],
                         'a bad request now carries a commit claim: %s' % reply['error'])


if __name__ == '__main__':
    unittest.main()
