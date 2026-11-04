"""T231: the doctor's attribution rows, and the one row that must never be guessed (the page).

What is being pinned here is a vocabulary, not a feature. Each row is a different fact, and the last one is the only
row about a page:

    upstream_completion  the host read the turn
    native_consume       pending / acked on the native path
    relay_mirror         offered on the relay path -- a second transport of the *same* Bridge ledger
    ack                  an acknowledgement of an event that is still in the queue
    page_visible         always `unknown`, because the extension store is not read here

A relay offer is exactly the case where a report is tempted to say "delivered": the run was seen on another channel, so
it feels proven. It is not -- the relay reads the same table the native path reads, and neither of them can say a page
showed anything. Every test below therefore asserts the same invariant from a different direction: no combination of
artifacts produces `delivered` or `user_visible` in this tool's output.
"""
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, 'tools', 'notify_doctor.py')
NOW_MS = 1_800_000_000_000
NOW_SECONDS = NOW_MS // 1000
DELIVERED_WORDS = ('delivered', 'user_visible')


def load_tool():
    import importlib.util
    spec = importlib.util.spec_from_file_location('notify_doctor_t231', TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ident(n):
    return '%08d-0000-4000-8000-000000000000' % n


def event(event_id, run, deliverable=True, replay=False):
    return {'eventId': event_id, 'runId': run, 'name': 'terminal-turn',
            'createdAt': '2027-01-15T07:30:00Z', 'enqueuedAt': NOW_SECONDS - 600,
            'deliveredAt': 0, 'deliverable': deliverable, 'replay': replay,
            'status': 'queued', 'deliveries': 0, 'consumerDeliveredAt': {},
            'seq': 1, 'message': 'fixture text; never a real notice'}


class DoctorCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = load_tool()

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='doctor-t231-')
        self.addCleanup(shutil.rmtree, self.root, True)

    def write(self, name, document):
        with io.open(os.path.join(self.root, name), 'w', encoding='utf-8') as handle:
            json.dump(document, handle)

    def write_state(self, relay=None, pending=(), acked=(), events=(), origin_ids=(1, 2)):
        self.write('terminal-origin.json', {'version': 1, 'ids': [ident(n) for n in origin_ids],
                                            'readAt': NOW_SECONDS - 30, 'source': 'bridge-sqlite'})
        source = {'version': 1, 'pendingIds': [ident(n) for n in pending],
                  'ackedIds': [ident(n) for n in acked], 'baselineIds': [], 'baselineCount': 0,
                  'baselineDropped': 0}
        if relay is not None:
            source.update(relay)
        self.write('terminal-source.json', source)
        self.write('terminal-arm.json', {'version': 1, 'ids': [], 'takenAt': NOW_SECONDS - 120,
                                         'epoch': ident(999), 'truncated': False})
        self.write('queue.json', {'version': 1, 'events': list(events), 'next_seq': 5,
                                  'acked': [], 'acked_at': {}, 'consumers': {},
                                  'consumer_acks': {}})

    def digest(self):
        rows = []
        for name in sorted(os.listdir(self.root)):
            with open(os.path.join(self.root, name), 'rb') as handle:
                rows.append(name + ':' + hashlib.sha256(handle.read()).hexdigest())
        return rows

    def diagnose(self):
        before = self.digest()
        report = self.tool.diagnose(self.root, now_ms=NOW_MS)
        self.assertEqual(before, self.digest(), 'the doctor must not write to the state directory')
        return report

    def codes(self, report):
        return [f['code'] for f in report['findings']]

    def assertNeverClaimsDelivery(self, report):
        self.assertNotIn(report.get('delivery'), DELIVERED_WORDS,
                         'delivery was claimed: %r' % (report.get('delivery'),))
        self.assertNotIn(report.get('evidence'), DELIVERED_WORDS)
        self.assertNotEqual(report.get('primary'), 'delivered')
        self.assertEqual(report['attribution']['page_visible'], 'unknown',
                         'page visibility is never knowable from these artifacts')


class RelayStageTest(DoctorCase):
    def test_never_activated_is_a_stage_not_a_finding(self):
        self.write_state()
        report = self.diagnose()
        self.assertFalse(report['stages']['relay']['activated'])
        self.assertEqual(report['attribution']['relay_mirror'], 'never_activated')
        self.assertNotIn('relay_candidate_offered', self.codes(report),
                         'a state the reader can already see is not a finding')
        self.assertNeverClaimsDelivery(report)

    def test_an_offer_is_reported_as_unknown_never_as_delivery(self):
        self.write_state(relay={'relayActivatedAt': NOW_SECONDS - 900,
                                'relayActivation': 'operator',
                                'relayOfferedIds': [ident(1)], 'relayDeferredIds': [],
                                'relayBaselineIds': [ident(2)]},
                         acked=[1], events=[event('fabricated-event-id', ident(1))])
        report = self.diagnose()
        relay = report['stages']['relay']
        self.assertTrue(relay['activated'])
        self.assertEqual(relay['offered'], 1)
        self.assertEqual(relay['baseline_ids'], 1)
        self.assertEqual(report['attribution']['relay_mirror'], 'offered')
        self.assertIn('relay_candidate_offered', self.codes(report))
        unknown = [f for f in report['findings'] if f['code'] == 'relay_candidate_offered']
        self.assertEqual(unknown[0]['severity'], 'unknown')
        self.assertIn('relay_page_delivery_not_read', report['limitations'])
        self.assertNeverClaimsDelivery(report)

    def test_the_mirror_says_what_it_mirrors(self):
        self.write_state(relay={'relayActivatedAt': NOW_SECONDS - 900, 'relayOfferedIds': [],
                                'relayDeferredIds': [], 'relayBaselineIds': []})
        report = self.diagnose()
        self.assertEqual(report['stages']['relay']['mirrors'], 'bridge_service_task_events')
        self.assertEqual(report['attribution']['relay_is'],
                         'second_transport_of_the_same_bridge_ledger')


class CompetitionTest(DoctorCase):
    def test_a_run_seen_by_both_channels_is_counted_once(self):
        """The interesting failure is double counting: the same run acked natively *and* offered by the relay."""
        shared = ident(1)
        self.write_state(relay={'relayActivatedAt': NOW_SECONDS - 900, 'relayOfferedIds': [shared],
                                'relayDeferredIds': [], 'relayBaselineIds': []},
                         acked=[1], events=[event('fabricated-event-id', shared)])
        report = self.diagnose()
        self.assertEqual(report['stages']['source']['acked'], 1)
        self.assertEqual(report['stages']['relay']['offered'], 1)
        self.assertEqual(report['stages']['queue']['events'], 1)
        self.assertEqual(report['attribution']['ack'], 'no_current_ack',
                         'an event in the queue that was not acknowledged is not acknowledged, whichever '
                         'channel offered it')
        self.assertNeverClaimsDelivery(report)


class RestartTest(DoctorCase):
    def test_acknowledged_history_is_not_a_current_acknowledgement(self):
        self.write_state(acked=[1, 2, 3], events=[event('fabricated-event-id', ident(4))])
        report = self.diagnose()
        self.assertEqual(report['stages']['source']['acked'], 3, 'history is still counted as history')
        self.assertEqual(report['stages']['queue']['acknowledged'], 0,
                         'but it says nothing about the events currently queued')
        self.assertEqual(report['attribution']['ack'], 'no_current_ack')
        self.assertNeverClaimsDelivery(report)

    def test_an_empty_queue_after_a_restart_is_expected_silence(self):
        self.write_state(acked=[1, 2], events=[])
        report = self.diagnose()
        self.assertEqual(report['stages']['queue']['events'], 0)
        self.assertIn(report['primary'], ('expected_silence', 'no_reason_found'))
        self.assertNeverClaimsDelivery(report)


class MissingRecordTest(DoctorCase):
    def test_a_missing_source_artifact_is_named_and_claims_nothing(self):
        self.write_state(relay={'relayActivatedAt': NOW_SECONDS - 900, 'relayOfferedIds': [ident(1)],
                                'relayDeferredIds': [], 'relayBaselineIds': []})
        os.remove(os.path.join(self.root, 'terminal-source.json'))
        report = self.diagnose()
        self.assertIn('artifact_absent', self.codes(report))
        relay = report['stages']['relay']
        self.assertFalse(relay['known'], 'the relay stage says it does not know')
        self.assertIsNone(relay['activated'],
                          'and does not swing the other way and assert it was never activated')
        self.assertEqual(report['attribution']['relay_mirror'], 'unknown')
        self.assertFalse(report['chain_intact'])
        self.assertNeverClaimsDelivery(report)

    def test_everything_missing_says_nothing_readable(self):
        report = self.diagnose()
        self.assertEqual(report['primary'], 'nothing_readable')
        self.assertFalse(report['chain_intact'])
        self.assertIn('extension_store_not_read', report['limitations'])


class ReplayTest(DoctorCase):
    def test_a_replayed_event_is_suppressed_and_never_delivered(self):
        self.write_state(events=[event('fabricated-event-id', ident(1), deliverable=False, replay=True)])
        report = self.diagnose()
        self.assertEqual(report['stages']['queue']['suppressed'], 1)
        self.assertEqual(report['stages']['queue']['deliverable'], 0)
        self.assertEqual(report['delivery'], 'nothing_deliverable')
        self.assertIn('suppressed_by_gate', self.codes(report))
        self.assertNeverClaimsDelivery(report)

    def test_a_replay_does_not_become_relay_evidence(self):
        self.write_state(relay={'relayActivatedAt': NOW_SECONDS - 900, 'relayOfferedIds': [ident(1)],
                                'relayDeferredIds': [], 'relayBaselineIds': []},
                         events=[event('fabricated-event-id', ident(1), deliverable=False, replay=True)])
        report = self.diagnose()
        self.assertEqual(report['attribution']['relay_mirror'], 'offered')
        self.assertEqual(report['delivery'], 'nothing_deliverable')
        self.assertNeverClaimsDelivery(report)


if __name__ == '__main__':
    unittest.main()
