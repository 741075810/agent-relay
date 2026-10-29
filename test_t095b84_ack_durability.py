"""T095B84: an ACK that is durable, and what may follow it.

Three different things get called "delivered" in this system, and the whole point of the
journal is to keep them apart:

  * the **queue ACK** -- a consumer saying it has seen an event;
  * **host consumption** -- the sampler being told a candidate was taken, so it is no
    longer offered;
  * **a page write** -- the notice actually appearing in the composer, with a receipt.

Only the last one means the recipient knows. The dangerous sequence this suite hunts is
the ACK being persisted and then *the next write failing or the process dying*: that is
where a system either loses a notice silently, sends it twice, counts it twice, or quietly
promotes "acknowledged" into "delivered".

Every fixture is a temporary directory; every id is counted, not random.
"""
import io
import json
import os
import shutil
import tempfile
import unittest

import host
import protocol as P
import terminal_source
from test_t059_terminal_wire import run, uuid

BASE_MS = 1759000000000


def load_doctor():
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        'notify_doctor', os.path.join(here, 'tools', 'notify_doctor.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def event(ident, created=BASE_MS // 1000):
    return {'eventId': ident, 'runId': 'run-' + ident, 'name': 'terminal-turn',
            'createdAt': created, 'deliverable': True, 'message': 'fixture'}


class Scene(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t084-root-')
        self.state = tempfile.mkdtemp(prefix='t084-state-')
        sub = os.path.join(self.root, 'e' * 64)
        os.makedirs(sub)
        self.ledger = os.path.join(sub, 'endpoint.json.runs.json')
        self._saved = terminal_source.DEFAULT_LEDGER
        self._saved_native = terminal_source.native_turns.sample
        terminal_source.DEFAULT_LEDGER = self.root
        terminal_source.native_turns.sample = staticmethod(
            lambda root=None, now=None, **_k: {
                'ok': True, 'code': None, 'turns': [], 'running': [],
                'runningStale': 0, 'sessions': 1, 'files': 1, 'error': None,
                'source': 'stub', 'root': root})
        self.manifest = os.path.join(self.state, 'host_manifest.json')
        with io.open(self.manifest, 'w', encoding='utf-8') as handle:
            json.dump({'allowed_origins':
                       ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']}, handle)

    def tearDown(self):
        terminal_source.native_turns.sample = self._saved_native
        terminal_source.DEFAULT_LEDGER = self._saved
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)

    def rpc(self, op, args=None):
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op}
        if args is not None:
            request['args'] = args
        out = io.BytesIO()
        host.serve(self.state, self.manifest, io.BytesIO(P.encode(request)), out)
        out.seek(0)
        return P.read_message(out)

    def fail_next_queue_save(self):
        """Make the next queue write fail, the way a full disk or a killed process does."""
        original = host.json.dump
        calls = {'n': 0}

        def explode(*args, **kwargs):
            calls['n'] += 1
            raise ValueError('simulated: the device is full')

        host.json.dump = explode
        return lambda: setattr(host.json, 'dump', original)

    def queue_document(self):
        path = os.path.join(self.state, host.QUEUE_FILE)
        with io.open(path, 'r', encoding='utf-8') as handle:
            return json.load(handle)


class AckThenFailureTest(Scene):
    """The ACK is durable, then the *next* write fails. What survives?"""

    def test_an_acknowledged_event_is_not_delivered_again_after_a_failed_write(self):
        host.append_events(self.state, [event('e1'), event('e2')])
        page = self.rpc('poll', {'consumer': 'profile-a'})['result']['events']
        self.assertEqual([e['eventId'] for e in page], ['e1', 'e2'])
        acked = self.rpc('ack', {'acked': ['e1'], 'consumer': 'profile-a'})
        self.assertTrue(acked['ok'], acked)

        # A later poll from the same consumer would stamp delivery and save; that save
        # fails. The ACK from before must still be on disk afterwards.
        restore = self.fail_next_queue_save()
        try:
            self.rpc('poll', {'consumer': 'profile-a'})
        except Exception:                                  # noqa: BLE001 - the point
            pass
        finally:
            restore()

        again = self.rpc('poll', {'consumer': 'profile-a'})['result']['events']
        self.assertEqual([e['eventId'] for e in again], ['e2'],
                         'a failed write resurrected an acknowledged event')

    def test_a_failed_write_does_not_report_the_ack_it_did_not_make(self):
        host.append_events(self.state, [event('e1')])
        self.rpc('poll', {'consumer': 'profile-a'})
        restore = self.fail_next_queue_save()
        try:
            reply = self.rpc('ack', {'acked': ['e1'], 'consumer': 'profile-a'})
            failed = reply.get('ok') is False
        finally:
            restore()
        if failed:
            # Refused: then the event must still be there, and nothing may claim it was
            # acknowledged.
            document = self.queue_document()
            self.assertNotIn('e1', document.get('acked', []))
            again = self.rpc('poll', {'consumer': 'profile-a'})['result']['events']
            self.assertEqual([e['eventId'] for e in again], ['e1'])
        else:
            # Reported success: then it must be on disk, or the caller was lied to.
            document = self.queue_document()
            acked = set(document.get('acked', []))
            for values in (document.get('consumer_acks') or {}).values():
                acked |= set(values)
            self.assertIn('e1', acked,
                          'the ack was reported ok but is not durable')

    def test_a_failed_write_during_poll_loses_no_event(self):
        host.append_events(self.state, [event('e1'), event('e2')])
        restore = self.fail_next_queue_save()
        try:
            self.rpc('poll', {'consumer': 'profile-a'})
        except Exception:                                  # noqa: BLE001
            pass
        finally:
            restore()
        after = self.rpc('poll', {'consumer': 'profile-a'})['result']['events']
        self.assertEqual(sorted(e['eventId'] for e in after), ['e1', 'e2'],
                         'a failed delivery stamp lost an event')


class TwoConsumersTest(Scene):
    def test_one_consumers_ack_survives_another_consumers_failed_write(self):
        host.append_events(self.state, [event('e1'), event('e2')])
        self.rpc('poll', {'consumer': 'profile-a'})
        self.assertTrue(self.rpc('ack', {'acked': ['e1'],
                                         'consumer': 'profile-a'})['ok'])
        restore = self.fail_next_queue_save()
        try:
            self.rpc('poll', {'consumer': 'profile-b'})
        except Exception:                                  # noqa: BLE001
            pass
        finally:
            restore()
        for_a = self.rpc('poll', {'consumer': 'profile-a'})['result']['events']
        for_b = self.rpc('poll', {'consumer': 'profile-b'})['result']['events']
        self.assertEqual([e['eventId'] for e in for_a], ['e2'])
        self.assertEqual([e['eventId'] for e in for_b], ['e1', 'e2'],
                         "another profile's failed write changed this one's mailbox")


class CandidateAckTest(Scene):
    """The sampler's own ACK is a different file from the queue."""

    def offer(self):
        with io.open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump([run(uuid(1), 'completed')], handle)
        self.rpc('terminal-list')
        with io.open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump([run(uuid(1), 'completed'),
                       run(uuid(2), 'completed', BASE_MS + 1000)], handle)
        reply = self.rpc('terminal-list')['result']
        self.assertEqual([c['runId'] for c in reply['candidates']], [uuid(2)])
        return reply

    def test_a_candidate_ack_that_cannot_be_saved_is_not_reported_as_taken(self):
        self.offer()
        restore = self.fail_next_queue_save()
        # The sampler writes its own file, not the queue, so break that one instead.
        original = terminal_source._atomic_write

        def explode(path, doc):
            raise OSError('simulated: cannot write the state file')

        terminal_source._atomic_write = explode
        try:
            reply = self.rpc('terminal-ack', {'acked': [uuid(2)]})
            reported = reply.get('ok') is not False
        finally:
            terminal_source._atomic_write = original
            restore()

        again = self.rpc('terminal-list')['result']
        offered = [c['runId'] for c in again['candidates']]
        if reported:
            self.assertNotIn(uuid(2), offered,
                             'the host said the candidate was taken but kept offering it')
        else:
            self.assertEqual(offered, [uuid(2)],
                             'the host refused the ack but dropped the candidate anyway')

    def test_the_candidate_comes_back_when_the_ack_never_reached_the_disk(self):
        self.offer()
        original = terminal_source._atomic_write
        terminal_source._atomic_write = lambda path, doc: (_ for _ in ()).throw(
            OSError('simulated: killed before the rename'))
        try:
            self.rpc('terminal-ack', {'acked': [uuid(2)]})
        finally:
            terminal_source._atomic_write = original
        again = self.rpc('terminal-list')['result']
        self.assertEqual([c['runId'] for c in again['candidates']], [uuid(2)],
                         'a completion was lost because its ack did not reach the disk')


class DeliveryClaimTest(Scene):
    """The doctor must keep three different facts apart.

    A bare `poll` makes the host stamp `deliveredAt`, and `delivery_evidence()` accepts
    that as evidence -- the host describing what it did, which is "handed this to the
    consumer", not "the composer showed it". The distinction the operator needs is carried
    elsewhere: the report always records that the extension's own store was **not** read,
    so no verdict here can stand in for a page receipt. That boundary is asserted rather
    than assumed, because it is the one an ACK could quietly cross.
    """

    def test_a_handover_never_stands_in_for_a_page_receipt(self):
        host.append_events(self.state, [event('e1')])
        self.rpc('poll', {'consumer': 'profile-a'})
        self.assertTrue(self.rpc('ack', {'acked': ['e1'],
                                         'consumer': 'profile-a'})['ok'])
        doctor = load_doctor()
        report = doctor.diagnose(self.state, now_ms=BASE_MS + 60000)
        stats = doctor.stats_only(report)
        self.assertEqual(stats['delivery'], 'evidenced',
                         'a bare poll should be reported as the host handover it is')
        self.assertIn('extension_store_not_read', stats.get('limitations', []),
                      'the report must say the only witness to a page write was not read')

    def test_an_event_with_no_timestamp_at_all_is_never_delivered(self):
        host.append_events(self.state, [event('e1')])
        doctor = load_doctor()
        stats = doctor.stats_only(doctor.diagnose(self.state, now_ms=BASE_MS + 60000))
        self.assertNotEqual(stats['delivery'], 'evidenced')
        self.assertNotEqual(stats['primary'], 'delivered')
        self.assertEqual(stats.get('evidenced', 0), 0)

    def test_a_receipt_without_a_time_is_a_claim_and_graded_unknown(self):
        """The failure this tool was built for: a receipt stub with no timestamp read as
        proof that a notice arrived."""
        host.append_events(self.state, [event('e1')])
        document = self.queue_document()
        document['events'][0]['consumerDeliveredAt'] = {'receipt': 'stub'}
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w',
                     encoding='utf-8') as handle:
            json.dump(document, handle)
        doctor = load_doctor()
        stats = doctor.stats_only(doctor.diagnose(self.state, now_ms=BASE_MS + 60000))
        self.assertIn('delivery_claimed_without_timestamp', stats['codes'])
        self.assertEqual(stats['delivery'], 'claimed_only',
                         'a receipt with no time is a claim, and is labelled as one')
        self.assertNotEqual(stats['primary'], 'delivered')
        self.assertEqual(stats['grades']['unknown'], 1)


if __name__ == '__main__':
    unittest.main()
