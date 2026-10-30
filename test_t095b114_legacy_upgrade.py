"""T095B114: the queue that is actually on disk right now, upgraded offline.

The existing drill builds its "legacy" state by calling today's `append_events` and then dropping
an empty lock file beside it. That proves the drill is self-consistent; it does not prove the code
can read what a pre-T088 host actually wrote. The read-only field reports (T102/T103) describe
that queue: `version:1`, `next_seq` well past the event count, a list of `acked` ids, a
`consumer_acks` map with cursor lists -- and **no `generation` key at all**, because the field did
not exist when it was written. There is no `queue.lock` in the directory either.

So this module writes that shape by hand, with a JSON literal no current writer could produce, and
asks what the new host does with it:

  * does it read every field back without inventing or dropping one?
  * does the first write add the generation, and does that write lose nothing?
  * do the pending ids, the ACKed set, `next_seq`, and the consumer cursors survive?
  * does a real host process, driven over the framed protocol, agree?
  * and what happens if somebody rolls back to the old host afterwards?

Nothing here touches a real state directory; every fixture is a `mkdtemp`.
"""
import hashlib
import json
import os
import shutil
import tempfile
import time
import unittest

import host
import protocol as P

# Written by hand, in the shape the old host leaves: no `generation`, an `acked` list with
# history, `consumer_acks` carrying a cursor, and `next_seq` ahead of the event count so a
# sequence number that was allocated and never used is not silently reused downwards.
LEGACY_ACKED_AT = None  # filled in below, relative to now (T096 prunes old ACK history)

LEGACY_QUEUE = {
    'version': 1,
    'next_seq': 16,
    'events': [
        {'eventId': 'evt-pending-1', 'runId': 'run-old-1', 'name': 'task.completed',
         'status': 'completed', 'createdAt': '2026-10-20T09:00:00Z',
         'enqueuedAt': '2026-10-20T09:00:01Z', 'deliveredAt': None, 'deliveries': 0,
         'message': '[DSH preview] legacy pending', 'replay': True, 'deliverable': False,
         'seq': 13},
    ],
    'acked': ['evt-acked-1', 'evt-acked-2'],
    'acked_at': LEGACY_ACKED_AT,
    'consumer_acks': {'page': ['evt-acked-1', 'evt-acked-2'], 'popup': ['evt-acked-1']},
    'consumer_cursors': {'page': 12},
}
LEGACY_ACKED_AT = {'evt-acked-1': int(time.time()) - 60,
                   'evt-acked-2': int(time.time()) - 30}
LEGACY_QUEUE['acked_at'] = LEGACY_ACKED_AT


class LegacyQueueTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t114-legacy-')
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(LEGACY_QUEUE, handle, indent=1, sort_keys=True)

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)

    def raw(self):
        with open(os.path.join(self.state, host.QUEUE_FILE), encoding='utf-8') as handle:
            return json.load(handle)

    def test_the_handwritten_legacy_queue_is_read_without_invention(self):
        doc = host.load_queue(self.state)
        self.assertEqual(doc['next_seq'], 16)
        self.assertEqual([event['eventId'] for event in doc['events']], ['evt-pending-1'])
        self.assertEqual(doc['acked'], ['evt-acked-1', 'evt-acked-2'])
        self.assertNotIn('generation', doc,
                         'load_queue invented a generation for a queue that has none')
        self.assertEqual(doc['consumer_cursors'], {'page': 12},
                         'a cursor the current writer does not know about was dropped on read')
        self.assertEqual(host.known_event_ids(doc),
                         {'evt-pending-1', 'evt-acked-1', 'evt-acked-2'},
                         'the ACKed ids are part of what the queue knows')

    def test_pending_events_are_delivered_and_the_cursor_is_respected(self):
        events, cursor, more = host.pending_events(self.state, cursor=0, limit=20)
        self.assertEqual([event['eventId'] for event in events], ['evt-pending-1'])
        self.assertEqual(cursor, 13)
        self.assertFalse(more)
        # The legacy cursor of 12 is behind the event's seq of 13, so a consumer that resumes at
        # its old cursor still sees the event rather than losing it.
        resumed, _cursor, _more = host.pending_events(self.state, cursor=12, limit=20)
        self.assertEqual([event['eventId'] for event in resumed], ['evt-pending-1'])

    def test_the_first_new_write_adds_a_generation_and_loses_nothing(self):
        added = host.append_events(self.state, [{'eventId': 'evt-new', 'runId': 'run-new',
                                                 'text': 'after upgrade'}])
        self.assertEqual(added, 1)
        doc = self.raw()
        self.assertEqual(doc.get('generation'), 1, doc.get('generation'))
        self.assertEqual(sorted(host.known_event_ids(doc)),
                         sorted(['evt-new', 'evt-pending-1', 'evt-acked-1', 'evt-acked-2']))
        self.assertEqual(doc['next_seq'], 17, 'next_seq must continue, never restart')
        self.assertEqual(doc['acked'], ['evt-acked-1', 'evt-acked-2'])
        self.assertEqual(doc['consumer_acks'], LEGACY_QUEUE['consumer_acks'])
        self.assertEqual(doc['consumer_cursors'], {'page': 12})
        self.assertEqual(doc['acked_at'], LEGACY_QUEUE['acked_at'],
                         'the ACK timestamps were rewritten by an unrelated append')

    def test_an_ack_after_the_upgrade_keeps_the_old_history(self):
        host.ack_events(self.state, ['evt-pending-1'], consumer='page')
        doc = self.raw()
        self.assertIn('evt-pending-1', host.known_event_ids(doc))
        self.assertIn('evt-pending-1', doc['consumer_acks']['page'],
                      'a scoped ACK lands in the consumer map, not in the global list')
        self.assertEqual(doc['acked'], ['evt-acked-1', 'evt-acked-2'],
                         'the global ACK history must be untouched by a scoped ACK')
        self.assertEqual(doc['consumer_acks']['popup'], ['evt-acked-1'],
                         'another consumer\'s ACKs are not this consumer\'s business')
        self.assertEqual(doc['next_seq'], 16, 'an ACK must not consume a sequence number')

    def test_an_ack_naming_an_event_that_is_gone_is_a_no_op(self):
        """The old host's `acked` list can name ids whose payload is no longer in `events`.
        Acknowledging one of those again must not resurrect a phantom or raise."""
        added = host.ack_events(self.state, ['evt-acked-1'], consumer=None)
        self.assertEqual(added, 0)
        doc = self.raw()
        self.assertEqual(doc['acked'], ['evt-acked-1', 'evt-acked-2'])
        self.assertEqual([event['eventId'] for event in doc['events']], ['evt-pending-1'],
                         'a no-op ACK must not add a placeholder event')

    def test_a_second_append_does_not_invent_the_old_events(self):
        host.append_events(self.state, [{'eventId': 'evt-new', 'runId': 'r', 'text': 'a'}])
        again = host.append_events(self.state, [{'eventId': 'evt-pending-1', 'runId': 'r',
                                                 'text': 'retry'}])
        self.assertEqual(again, 0, 'the legacy event was appended a second time')
        doc = self.raw()
        self.assertEqual(len([event for event in doc['events']
                              if event['eventId'] == 'evt-pending-1']), 1)

    def test_the_framed_protocol_reads_the_legacy_queue(self):
        """The path a running host takes: validate, read, reply."""
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': 'status', 'args': {}}
        reply = host.handle_request(self.state, request)
        self.assertTrue(reply['ok'], reply)
        self.assertEqual(reply['result']['queued'], 1)
        self.assertEqual(reply['result']['acked'], 2)
        self.assertEqual(reply['result']['nextSeq'], 16)
        poll = host.handle_request(self.state, {'v': P.PROTOCOL_VERSION, 'id': 'req-2',
                                                'op': 'poll', 'args': {'limit': 5}})
        self.assertTrue(poll['ok'], poll)
        self.assertEqual([event['eventId'] for event in poll['result']['events']],
                         ['evt-pending-1'])


class RollbackHazardTest(unittest.TestCase):
    """What a rollback to the old host does, stated as a fact instead of assumed safe."""

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t114-rollback-')

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)

    def old_style_write(self, doc):
        """What a pre-T088 host does: load, mutate, dump. It knows nothing about `generation`,
        and this is the whole reason a rollback is not a supported operation."""
        doc = dict(doc)
        doc.pop('generation', None)
        path = os.path.join(self.state, host.QUEUE_FILE)
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, indent=1, sort_keys=True)
        return doc

    def test_a_rolled_back_write_erases_the_generation_and_the_new_host_cannot_tell(self):
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'r', 'text': 'a'}])
        for index in range(3):
            host.append_events(self.state, [{'eventId': 'evt-%d' % index, 'runId': 'r',
                                             'text': 'x'}])
        before = host.load_queue(self.state)
        self.assertGreaterEqual(before.get('generation') or 0, 4)

        rolled = self.old_style_write(before)
        self.assertNotIn('generation', rolled)
        after = host.load_queue(self.state)
        self.assertNotIn('generation', after,
                         'the loader must not paper over a reverted queue')
        # The hazard: the queue now looks exactly like one that was never upgraded. A fresh
        # append starts the generation at 1 again and nothing refuses -- which is why rollback
        # means restoring the downtime backup, not running the old host and hoping.
        host.append_events(self.state, [{'eventId': 'evt-z', 'runId': 'r', 'text': 'z'}])
        self.assertEqual(host.load_queue(self.state).get('generation'), 1,
                         'if this ever refuses, the generation check has become an upgrade '
                         'marker and this test should say so instead')

    def test_an_old_style_write_also_drops_a_cursor_it_does_not_understand(self):
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'r', 'text': 'a'}])
        doc = host.load_queue(self.state)
        doc['consumer_cursors'] = {'page': 1}
        host.save_queue(self.state, doc, expect=doc.get('generation'))
        # A rollback writer round-trips the document it loaded, so a field the *reader* knows is
        # safe -- the danger is a writer that rebuilds the document from its own model.
        rebuilt = {'version': 1, 'next_seq': doc['next_seq'], 'events': doc['events'],
                   'acked': doc['acked']}
        self.old_style_write(rebuilt)
        self.assertNotIn('consumer_cursors', host.load_queue(self.state),
                         'this test is the reason the upgrade notes say "restore the backup, '
                         'do not roll the old binary back"')


class PreflightAgainstLegacyStateTest(unittest.TestCase):
    """The read-only gate an operator runs before starting the new host, against the queue that
    is actually on disk -- no generation, no lock, ACK history and a consumer cursor inside."""

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t114-preflight-')
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            json.dump(LEGACY_QUEUE, handle, indent=1, sort_keys=True)
        self.preflight = _load_preflight()

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)

    def snapshot(self):
        out = {}
        for name in sorted(os.listdir(self.state)):
            path = os.path.join(self.state, name)
            st = os.stat(path)
            with open(path, 'rb') as handle:
                out[name] = (st.st_size, st.st_mtime_ns, hashlib.sha256(handle.read()).hexdigest())
        return out

    def test_a_legacy_queue_with_no_lock_needs_the_operator_to_say_the_host_stopped(self):
        before = self.snapshot()
        report = self.preflight.inspect(self.state)
        self.assertEqual(report['verdict'], self.preflight.VERDICT_CONFIRM,
                         'a missing lock file must never be read as "the host is not running"')
        asked = self.preflight.inspect(self.state, host_stopped=True)
        self.assertEqual(asked['verdict'], self.preflight.VERDICT_SAFE, asked)
        self.assertEqual(before, self.snapshot(), 'the preflight wrote to the state directory')

    def test_the_old_hosts_empty_lock_is_refused_by_name(self):
        with open(os.path.join(self.state, host.LOCK_FILE), 'wb'):
            pass
        report = self.preflight.inspect(self.state, host_stopped=True)
        self.assertEqual(report['verdict'], self.preflight.VERDICT_LEGACY, report)

    def test_a_damaged_queue_is_reported_as_damage_not_as_an_empty_one(self):
        with open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as handle:
            handle.write('{"version": 1, "events": [')
        report = self.preflight.inspect(self.state, host_stopped=True)
        self.assertEqual(report['verdict'], self.preflight.VERDICT_DAMAGED, report)


def _load_preflight():
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        'tools', 'upgrade_preflight.py')
    spec = importlib.util.spec_from_file_location('t114_preflight', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == '__main__':
    unittest.main()
