"""T168: the completion event reaches the queue that already exists, exactly once.

The chain used to work; these tests are about the properties that make it work when it works --
one event, one queue row, nothing lost, failures visible -- driven through the real state document
(`terminal_source.load_state` / `save_state`), not a mock of it.
"""

import os
import tempfile
import unittest

import notice_queue
import terminal_source


def candidate(native_turn=None, **over):
    row = {'origin': 'bridge', 'sessionId': 'session-11111111-2222-4333-8444-555555555555',
           'runId': 'run-1', 'turn': 3, 'status': 'completed'}
    row.update(over)
    return row


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def test_a_bridge_completed_candidate_is_queued_and_persisted(self):
        report = notice_queue.enqueue(self.dir, [candidate()], now=1000)
        self.assertEqual(len(report['added']), 1)
        self.assertEqual(report['pending'], 1)
        # Re-read through the scanner's own reader: persisted, not accepted in memory.
        doc = terminal_source.load_state(self.dir)
        self.assertEqual(len(doc['pendingIds']), 1)
        self.assertEqual(notice_queue.pending(self.dir)[0]['state'], 'queued')

    def test_the_same_event_twice_queues_once(self):
        first = notice_queue.enqueue(self.dir, [candidate()], now=1000)
        second = notice_queue.enqueue(self.dir, [candidate()], now=2000)
        self.assertEqual(len(first['added']), 1)
        self.assertEqual(len(second['added']), 0)
        self.assertEqual(len(second['duplicates']), 1)
        self.assertEqual(len(terminal_source.load_state(self.dir)['pendingIds']), 1)

    def test_a_candidate_that_cannot_name_itself_is_reported_not_invented(self):
        report = notice_queue.enqueue(self.dir, [candidate(sessionId=None), candidate(runId=None)],
                                      now=1000)
        self.assertEqual(report['added'], [])
        self.assertIn('session_missing', report['drops'])
        self.assertIn('task_missing', report['drops'])
        # The drop is visible on the next read too, which is what a failed notification needs.
        self.assertEqual(len(notice_queue.diagnose(self.dir)['drops']), 2)

    def test_an_acknowledged_event_is_not_requeued(self):
        notice_queue.enqueue(self.dir, [candidate()], now=1000)
        terminal_source.save_state(self.dir, {
            'version': terminal_source.STATE_VERSION, 'baselineIds': [],
            'ackedIds': list(terminal_source.load_state(self.dir)['pendingIds']),
            'pendingIds': [], 'noticeStates': {}, 'noticeDrops': []})
        report = notice_queue.enqueue(self.dir, [candidate()], now=3000)
        self.assertEqual(report['added'], [])
        self.assertEqual(len(report['alreadyAcked']), 1)

    def test_states_advance_but_never_to_delivered(self):
        notice_queue.enqueue(self.dir, [candidate()], now=1000)
        key = notice_queue.pending(self.dir)[0]['key']
        notice_queue.mark(self.dir, key, 'attempted', now=1100)
        notice_queue.mark(self.dir, key, 'written_not_clicked', 'send_button_not_ready', now=1200)
        row = notice_queue.pending(self.dir)[0]
        self.assertEqual(row['state'], 'written_not_clicked')
        self.assertEqual(row['lastReason'], 'send_button_not_ready')
        self.assertEqual(row['attempts'], 1)
        with self.assertRaises(notice_queue.QueueError):
            notice_queue.mark(self.dir, key, 'acked')
        with self.assertRaises(notice_queue.QueueError):
            notice_queue.mark(self.dir, key, 'attempted')   # no retry out of an absorbing state

    def test_submitted_is_visible_and_still_pending(self):
        notice_queue.enqueue(self.dir, [candidate()], now=1000)
        key = notice_queue.pending(self.dir)[0]['key']
        notice_queue.mark(self.dir, key, 'attempted', now=1100)
        notice_queue.mark(self.dir, key, 'submitted', now=1200)
        diag = notice_queue.diagnose(self.dir)
        self.assertEqual(diag['byState'].get('submitted'), 1)
        self.assertEqual(diag['acked'], 0)
        self.assertEqual(diag['pending'], 1, 'submitted is not delivered')

    def test_diagnose_counts_every_pending_state(self):
        notice_queue.enqueue(self.dir, [candidate(), candidate(runId='run-2')], now=1000)
        rows = notice_queue.pending(self.dir)
        notice_queue.mark(self.dir, rows[0]['key'], 'attempted', now=1100)
        diag = notice_queue.diagnose(self.dir)
        self.assertEqual(diag['pending'], 2)
        self.assertEqual(diag['byState'], {'queued': 1, 'attempted': 1})
        self.assertEqual(diag['rows'][0]['attempts'], 1)


if __name__ == '__main__':
    unittest.main()
