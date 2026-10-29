"""T095B85: the layers between "the host queued it" and "the person saw it".

`tools/notify_doctor.py` used to read a host-written `deliveredAt` as evidence of
delivery. The host stamps that field when a consumer **polls** -- `host.py` writes both
`deliveredAt` and `consumerDeliveredAt[consumer]` there -- so the verdict
`delivery: evidenced / primary: delivered` described a hand-over, and the report then said
a notice had arrived. Nobody had seen anything: the extension's own store was never read
(`extension_store_not_read` says so in the same report).

What the read-only artifacts can actually show, strongest first:

  host_appended        the event is in the queue and nobody has taken it
  consumer_polled      the host handed it over (its own stamp; transport, not visibility)
  consumer_acknowledged  a consumer acknowledged it (still a claim, not a sighting)
  user_visible_unverified  a receipt-shaped value the host could not have written: the
                       consumer reported a page write, and that is as far as this tool can
                       see. A page-level confirmation needs the extension's journal, which
                       this tool does not read -- so it says so and stops there.

The rule is one-directional: an ACK may never be promoted into "the recipient saw it", and
a missing timestamp is never a fault in a chain that was merely quiet.
"""
import io
import json
import os
import shutil
import tempfile
import unittest

import host
import protocol as P

from test_t095b84_ack_durability import Scene, event, load_doctor, BASE_MS


class EvidenceLayerTest(Scene):
    def stats(self, now_ms=BASE_MS + 60000):
        doctor = load_doctor()
        return doctor.stats_only(doctor.diagnose(self.state, now_ms=now_ms))

    def test_an_appended_event_is_queued_and_nothing_more(self):
        host.append_events(self.state, [event('e1')])
        stats = self.stats()
        self.assertEqual(stats['evidence'], 'host_appended')
        self.assertNotEqual(stats['primary'], 'delivered')
        self.assertEqual(stats['delivery'], 'none')

    def test_a_polled_event_is_a_handover_and_never_a_delivery(self):
        host.append_events(self.state, [event('e1')])
        self.rpc('poll', {'consumer': 'profile-a'})
        stats = self.stats()
        self.assertEqual(stats['evidence'], 'consumer_polled',
                         'the host handed it over; nobody has seen anything')
        self.assertEqual(stats['delivery'], 'consumer_polled')
        self.assertNotEqual(stats['primary'], 'delivered')
        self.assertEqual(stats.get('user_visible', 0), 0)

    def test_an_acknowledged_event_is_still_only_a_claim(self):
        host.append_events(self.state, [event('e1')])
        self.rpc('poll', {'consumer': 'profile-a'})
        self.assertTrue(self.rpc('ack', {'acked': ['e1'],
                                         'consumer': 'profile-a'})['ok'])
        stats = self.stats()
        self.assertEqual(stats['evidence'], 'consumer_acknowledged')
        self.assertNotEqual(stats['primary'], 'delivered')
        self.assertEqual(stats.get('user_visible', 0), 0)

    def test_a_consumer_receipt_is_reported_as_unverified_visibility(self):
        """A receipt the host could not have written: the strongest thing these artifacts
        contain, and still not a page confirmation."""
        host.append_events(self.state, [event('e1')])
        document = self.queue_document()
        document['events'][0]['pageReceipt'] = {'shownAt': BASE_MS + 1000}
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w',
                     encoding='utf-8') as handle:
            json.dump(document, handle)
        stats = self.stats()
        self.assertEqual(stats['evidence'], 'user_visible_unverified')
        self.assertEqual(stats.get('user_visible', 0), 1)
        self.assertNotEqual(stats['primary'], 'delivered',
                            'even a receipt is not verified against the page')

    def test_a_receipt_with_no_timestamp_stays_a_claim(self):
        host.append_events(self.state, [event('e1')])
        document = self.queue_document()
        document['events'][0]['consumerDeliveredAt'] = {'receipt': 'stub'}
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w',
                     encoding='utf-8') as handle:
            json.dump(document, handle)
        stats = self.stats()
        self.assertEqual(stats['delivery'], 'claimed_only')
        self.assertEqual(stats['grades']['unknown'], 1)
        self.assertNotEqual(stats['primary'], 'delivered')

    def test_a_malformed_event_is_not_counted_as_anything_good(self):
        host.append_events(self.state, [event('e1')])
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'r',
                     encoding='utf-8') as handle:
            document = json.load(handle)
        document['events'].append({'deliverable': True,
                                   'consumerDeliveredAt': 'not-a-time'})
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w',
                     encoding='utf-8') as handle:
            json.dump(document, handle)
        stats = self.stats()
        self.assertNotEqual(stats['primary'], 'delivered')
        self.assertNotEqual(stats['evidence'], 'user_visible_unverified')

    def test_a_quiet_chain_is_not_diagnosed_as_a_failure(self):
        """Nothing appended, nothing polled: silence is the correct answer, and it must
        not come back as a blocker."""
        stats = self.stats()
        self.assertIn(stats['delivery'], ('none', 'nothing_deliverable', None))
        self.assertNotEqual(stats['primary'], 'delivered')

    def test_two_consumers_do_not_promote_each_other(self):
        host.append_events(self.state, [event('e1')])
        self.rpc('poll', {'consumer': 'profile-a'})
        self.rpc('poll', {'consumer': 'profile-b'})
        self.assertTrue(self.rpc('ack', {'acked': ['e1'],
                                         'consumer': 'profile-a'})['ok'])
        stats = self.stats()
        self.assertEqual(stats['evidence'], 'consumer_acknowledged')
        self.assertNotEqual(stats['primary'], 'delivered')
        stage = stats['stages']['queue']
        self.assertGreaterEqual(stage['handed_over'], 1)

    def test_a_skewed_clock_is_named_and_never_a_delivery(self):
        host.append_events(self.state, [event('e1')])
        self.rpc('poll', {'consumer': 'profile-a'})
        # A poll stamped far in the future: the two sides do not share a clock.
        document = self.queue_document()
        document['events'][0]['deliveredAt'] = BASE_MS + 86400000
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w',
                     encoding='utf-8') as handle:
            json.dump(document, handle)
        stats = self.stats()
        self.assertNotEqual(stats['primary'], 'delivered')

    def test_the_report_says_the_only_page_witness_was_not_read(self):
        host.append_events(self.state, [event('e1')])
        self.rpc('poll', {'consumer': 'profile-a'})
        stats = self.stats()
        self.assertIn('extension_store_not_read', stats.get('limitations', []))
        self.assertNotEqual(stats['delivery'], 'evidenced',
                            'no verdict may be named after evidence this tool lacks')


if __name__ == '__main__':
    unittest.main()
