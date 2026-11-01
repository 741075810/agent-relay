"""T169: the queue module is wired to the scanner's real ids and the host's real ACK.

Source-verified call chain (this repository, no runtime access):

    host.py:837                      report = terminal_source.running_report(...)
    terminal_source.py:808           due, next_state, info = candidates_from(...)
    terminal_source.py:651           'pendingIds': [item['runId'] for item in offered]
    terminal_source.py:817           save_state(state_dir, next_state)
    host.py:859                      acked = terminal_source.acknowledge(state_dir, args.get('acked'))
    terminal_source.py:703-742       acknowledge() moves ids from pendingIds to ackedIds

So the scanner already fills `pendingIds`: T168's claim that nothing wrote it was wrong at repository
level. What is genuinely missing is a component that can (a) report the pending set with states and
(b) refuse a second row for an event the scanner already queued. That is all `notice_queue` may do, and
this file pins exactly that against the real reader/writer/ACK.
"""

import tempfile
import unittest

import notice_queue
import terminal_source


class WiringTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def seed(self, pending, acked=()):
        """Write the document exactly as the scanner writes it: ids only."""
        terminal_source.save_state(self.dir, {
            'version': terminal_source.STATE_VERSION, 'baselineIds': [],
            'ackedIds': list(acked), 'pendingIds': list(pending)})

    def test_the_scanner_written_pending_row_is_not_duplicated(self):
        # The scanner already queued run-1. Enqueueing the same event must add nothing.
        self.seed(['run-1'])
        report = notice_queue.enqueue(self.dir, [{'runId': 'run-1', 'status': 'completed'}], now=5)
        self.assertEqual(report['added'], [])
        self.assertEqual(report['duplicates'], ['run-1'])
        self.assertEqual(terminal_source.load_state(self.dir)['pendingIds'], ['run-1'])

    def test_an_event_in_the_scanner_queue_is_visible_with_its_state(self):
        self.seed(['run-1', 'run-2'])
        rows = notice_queue.pending(self.dir)
        self.assertEqual([r['key'] for r in rows], ['run-1', 'run-2'])
        self.assertTrue(all(r['state'] == 'queued' for r in rows))

    def test_the_host_ack_removes_it_and_a_later_scan_does_not_requeue(self):
        self.seed(['run-1'])
        out = terminal_source.acknowledge(self.dir, ['run-1'])
        self.assertEqual(out['acked'], 1, 'acknowledge reports a count, not the list')
        self.assertEqual(out['pending'], 0)
        again = notice_queue.enqueue(self.dir, [{'runId': 'run-1', 'status': 'completed'}], now=9)
        self.assertEqual(again['added'], [])
        self.assertEqual(again['alreadyAcked'], ['run-1'])
        self.assertEqual(terminal_source.load_state(self.dir)['pendingIds'], [])

    def test_a_native_turn_reuses_the_scanner_synthesised_id(self):
        session = 'session-11111111-2222-4333-8444-555555555555'
        key, why = notice_queue.queue_key({'sessionId': session, 'turn': 4, 'status': 'completed'})
        self.assertIsNone(why)
        self.assertEqual(key, terminal_source.native_run_id(session, 4))
        # And that id is what the scanner would have queued, so seeding it makes the event a duplicate.
        self.seed([key])
        report = notice_queue.enqueue(self.dir, [{'sessionId': session, 'turn': 4}], now=11)
        self.assertEqual(report['added'], [])
        self.assertEqual(report['duplicates'], [key])

    def test_an_event_without_identity_or_run_id_fails_closed(self):
        self.seed([])
        report = notice_queue.enqueue(self.dir, [{'status': 'completed'},
                                                {'sessionId': 'session-x', 'turn': None}], now=13)
        self.assertEqual(report['added'], [])
        self.assertIn('session_missing', report['drops'])
        self.assertIn('task_missing', report['drops'])
        self.assertEqual(terminal_source.load_state(self.dir)['pendingIds'], [])

    def test_states_travel_without_touching_the_scanners_pending_list(self):
        self.seed(['run-1'])
        notice_queue.mark(self.dir, 'run-1', 'attempted', now=21)
        notice_queue.mark(self.dir, 'run-1', 'written_not_clicked', 'send_button_not_ready', now=22)
        doc = terminal_source.load_state(self.dir)
        self.assertEqual(doc['pendingIds'], ['run-1'], 'pending is the scanner contract: unchanged')
        self.assertEqual(notice_queue.diagnose(self.dir)['byState'],
                         {'written_not_clicked': 1})
        self.assertEqual(terminal_source.acknowledge(self.dir, ['run-1'])['pending'], 0)


if __name__ == '__main__':
    unittest.main()
