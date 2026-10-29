"""T095B82: the notification queue across interruption, error and restart.

`host.load_queue` and `host.save_queue` are already careful -- the read refuses a damaged
file instead of calling it empty, the write uses a pid-unique temporary and fsyncs, and
the read-modify-write is serialised by a create-based lock that breaks a stale one rather
than waiting forever. Careful code with no test of the careful part is one refactor away
from being careful code that no longer is.

These cases are about the states a killed host leaves behind:

  * a queue file truncated or emptied by a crash -- the chain must stop, and must say so,
    rather than read silence as "nothing is pending";
  * a lock file whose owner is gone -- delivery must not wedge forever;
  * a save that fails halfway -- no debris on every later retry;
  * a restart in the middle of the two-phase exchange -- an acknowledged event never comes
    back, an unacknowledged one does, and the cursor survives;
  * a repeated append of the same event id -- skipped, and without consuming a sequence.

Every fixture is a temporary directory. Nothing here reads or writes a production state.
"""
import io
import json
import os
import shutil
import tempfile
import time
import unittest

import host
import protocol as P


def event(ident, created=1759000000):
    return {'eventId': ident, 'runId': 'run-' + ident, 'name': 'terminal-turn',
            'createdAt': created, 'deliverable': True, 'message': 'fixture'}


class QueueScene(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t082-state-')
        self.queue_file = os.path.join(self.state, host.QUEUE_FILE)

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)

    def read_bytes(self):
        with open(self.queue_file, 'rb') as handle:
            return handle.read()

    def rpc(self, op, args=None):
        """One round trip through the real serve loop, with a permissive manifest."""
        manifest = os.path.join(self.state, 'host_manifest.json')
        with io.open(manifest, 'w', encoding='utf-8') as handle:
            json.dump({'allowed_origins':
                       ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']}, handle)
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op}
        if args is not None:
            request['args'] = args
        out = io.BytesIO()
        host.serve(self.state, manifest, io.BytesIO(P.encode(request)), out)
        out.seek(0)
        return P.read_message(out)

    def debris(self):
        return [name for name in os.listdir(self.state) if '.tmp-' in name]


class DamagedQueueTest(QueueScene):
    def test_a_truncated_queue_is_a_named_error_not_an_empty_queue(self):
        host.append_events(self.state, [event('e1')])
        good = self.read_bytes()
        with open(self.queue_file, 'wb') as handle:
            handle.write(good[:len(good) // 2])
        reply = self.rpc('poll')
        self.assertIs(reply.get('ok'), False, reply)
        self.assertIn('unreadable', json.dumps(reply))
        # And the damaged file is evidence, not something to overwrite.
        self.assertEqual(self.read_bytes(), good[:len(good) // 2])

    def test_an_empty_queue_file_is_not_read_as_no_events(self):
        host.append_events(self.state, [event('e1')])
        with open(self.queue_file, 'wb') as handle:
            handle.write(b'')
        reply = self.rpc('poll')
        self.assertIs(reply.get('ok'), False, reply)

    def test_a_queue_from_the_future_is_refused_rather_than_misread(self):
        host.append_events(self.state, [event('e1')])
        document = json.loads(self.read_bytes().decode('utf-8'))
        document['version'] = 99
        with io.open(self.queue_file, 'w', encoding='utf-8') as handle:
            json.dump(document, handle)
        reply = self.rpc('poll')
        self.assertIs(reply.get('ok'), False, reply)

    def test_a_damaged_queue_does_not_block_the_restarted_request(self):
        """The host must keep answering after refusing: a thrown error would take down
        the pipe for everything else the popup asks. Anything that reports on the queue
        may legitimately refuse while the file is damaged; what must not happen is the
        next request going unanswered."""
        host.append_events(self.state, [event('e1')])
        with open(self.queue_file, 'wb') as handle:
            handle.write(b'{')
        refused = self.rpc('poll')
        self.assertIs(refused.get('ok'), False)
        self.assertIn('unreadable', json.dumps(refused))
        after = self.rpc('status')
        self.assertEqual(after.get('id'), 'req-1', 'the second request was not answered')
        self.assertIn('ok', after)


class StaleLockTest(QueueScene):
    def test_a_lock_left_by_a_killed_host_is_broken(self):
        lock = os.path.join(self.state, host.LOCK_FILE)
        with io.open(lock, 'w', encoding='utf-8') as handle:
            handle.write('999999')                     # a pid that is gone
        started = time.time()
        added = host.append_events(self.state, [event('e1')])
        elapsed = time.time() - started
        self.assertEqual(added, 1)
        self.assertLess(elapsed, 12.0,
                        'a stale lock held delivery for %.1fs' % elapsed)
        self.assertFalse(os.path.exists(lock), 'the broken lock was left behind')

    def test_delivery_resumes_after_the_stale_lock_is_cleared(self):
        host.append_events(self.state, [event('e1')])
        lock = os.path.join(self.state, host.LOCK_FILE)
        with io.open(lock, 'w', encoding='utf-8') as handle:
            handle.write('1')
        added = host.append_events(self.state, [event('e2')])
        self.assertEqual(added, 1)
        delivered = self.rpc('poll')['result']['events']
        self.assertEqual(sorted(e['eventId'] for e in delivered), ['e1', 'e2'])


class FailedSaveTest(QueueScene):
    def test_a_save_that_fails_leaves_no_temporary_behind(self):
        """Otherwise a full disk fills the state directory with debris on every retry."""
        original = host.json.dump

        def explode(*_args, **_kwargs):
            raise ValueError('simulated: no space on the device')

        host.json.dump = explode
        try:
            with self.assertRaises(Exception):
                host.append_events(self.state, [event('e1')])
        finally:
            host.json.dump = original
        self.assertEqual(self.debris(), [], 'a temporary survived the failed save')

    def test_a_failed_save_does_not_destroy_the_previous_queue(self):
        host.append_events(self.state, [event('e1')])
        before = self.read_bytes()
        original = host.json.dump
        host.json.dump = lambda *_a, **_k: (_ for _ in ()).throw(ValueError('boom'))
        try:
            with self.assertRaises(Exception):
                host.append_events(self.state, [event('e2')])
        finally:
            host.json.dump = original
        self.assertEqual(self.read_bytes(), before, 'the failed save published something')
        delivered = self.rpc('poll')['result']['events']
        self.assertEqual([e['eventId'] for e in delivered], ['e1'])


class RestartTest(QueueScene):
    def test_an_ack_is_remembered_across_a_restart_and_spares_only_its_own_consumer(self):
        """Two Chrome profiles can load the same extension against one host, so an ack is
        per consumer. Across a restart, the consumer that acked must not be offered the
        event again, and the one that did not must still get it."""
        host.append_events(self.state, [event('e1'), event('e2')])
        mine = self.rpc('poll', {'consumer': 'profile-a'})['result']['events']
        self.assertEqual([e['eventId'] for e in mine], ['e1', 'e2'])
        acked = self.rpc('ack', {'acked': ['e1'], 'consumer': 'profile-a'})
        self.assertTrue(acked['ok'], acked)

        # A new process: nothing in memory, everything read back from disk.
        again = self.rpc('poll', {'consumer': 'profile-a'})['result']['events']
        self.assertEqual([e['eventId'] for e in again], ['e2'],
                         'an acknowledged event came back after the restart')
        other = self.rpc('poll', {'consumer': 'profile-b'})['result']['events']
        self.assertEqual([e['eventId'] for e in other], ['e1', 'e2'],
                         "another profile's ack suppressed this one's delivery")

    def test_the_cursor_survives_a_restart(self):
        host.append_events(self.state, [event('e1'), event('e2')])
        page = self.rpc('poll', {'limit': 1})['result']
        self.assertEqual([e['eventId'] for e in page['events']], ['e1'])
        cursor = page.get('cursor')
        self.assertTrue(cursor, 'the page reports no cursor: %r' % (page,))
        rest = self.rpc('poll', {'cursor': cursor})['result']['events']
        self.assertEqual([e['eventId'] for e in rest], ['e2'])

    def test_repeating_an_append_is_skipped_without_consuming_a_sequence(self):
        first = host.append_events(self.state, [event('e1')])
        seq = json.loads(self.read_bytes().decode('utf-8'))['next_seq']
        second = host.append_events(self.state, [event('e1')])
        self.assertEqual((first, second), (1, 0))
        self.assertEqual(json.loads(self.read_bytes().decode('utf-8'))['next_seq'], seq,
                         'a duplicate append consumed a sequence number')


if __name__ == '__main__':
    unittest.main()
