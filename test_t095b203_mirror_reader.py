"""T203: the read-only mirror reads a real ledger and writes nothing.

Runs against the same synthetic ledger shape the other terminal suites use, and asserts the two properties the
sidecar depends on: the announced status is the host's resolved status (not a guess from `pending`/`acked`), and the
call leaves no trace in the sampler state -- no `pendingIds`, no ACK, no file.
"""

import json
import os
import shutil
import tempfile
import unittest

import terminal_source


class MirrorTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t203m-root-')
        self.state = tempfile.mkdtemp(prefix='t203m-state-')
        self.sub = os.path.join(self.root, 'c' * 64)
        os.makedirs(self.sub)
        self.path = os.path.join(self.sub, 'endpoint.json.runs.json')
        self._saved = terminal_source.DEFAULT_LEDGER
        terminal_source.DEFAULT_LEDGER = self.root

    def tearDown(self):
        terminal_source.DEFAULT_LEDGER = self._saved
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)

    def ledger(self, runs):
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def mirrored(self):
        return terminal_source.mirror(self.state, self.root)

    def test_completed_and_failed_keep_their_own_status(self):
        self.ledger([
            {'requestID': 'run-completed-0001', 'status': 'completed', 'createdAt': 1793600000000},
            {'requestID': 'run-failed-0002', 'status': 'failed', 'createdAt': 1793600001000},
        ])
        report = self.mirrored()
        self.assertTrue(report['ok'])
        self.assertEqual(report['source'], 'native_host.terminal-mirror')
        by_id = {item['runId']: item for item in report['candidates']}
        self.assertEqual(by_id['run-completed-0001']['status'], 'completed')
        self.assertEqual(by_id['run-failed-0002']['status'], 'failed')
        self.assertEqual(report['counts']['completed'], 1)
        self.assertEqual(report['counts']['failed'], 1)

    def test_a_running_task_is_not_a_candidate(self):
        self.ledger([{'requestID': 'run-running-0003', 'status': 'running', 'createdAt': 1793600000000}])
        report = self.mirrored()
        self.assertTrue(report['ok'])
        self.assertEqual(report['candidates'], [])

    def test_every_candidate_names_its_status_source(self):
        self.ledger([{'requestID': 'run-completed-0004', 'status': 'completed', 'createdAt': 1793600000000}])
        item = self.mirrored()['candidates'][0]
        self.assertIn(item['statusSource'], ('bridge_ledger.status', 'bridge.run_facts.status'))
        self.assertEqual(item['pageDelivery'], 'unknown', 'an ack is not a delivered page')
        self.assertIn(item['hostAck'], ('acked', 'pending', 'unseen'))

    def test_mirroring_writes_no_state(self):
        self.ledger([{'requestID': 'run-completed-0005', 'status': 'completed', 'createdAt': 1793600000000}])
        state_file = os.path.join(self.state, terminal_source.STATE_NAME)
        self.mirrored()
        self.assertFalse(os.path.exists(state_file),
                         'mirror must not create terminal-source.json; only terminal-list does that')

    def test_an_unreadable_ledger_is_reported_with_a_code(self):
        with open(self.path, 'w', encoding='utf-8') as handle:
            handle.write('{ this is not json')
        report = self.mirrored()
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'source_unavailable')
        self.assertEqual(report['candidates'], [])
        self.assertTrue(report['readOnly'])

    def test_a_duplicated_ledger_record_appears_once(self):
        self.ledger([
            {'requestID': 'run-dup-0006', 'status': 'completed', 'createdAt': 1793600000000},
            {'requestID': 'run-dup-0006', 'status': 'completed', 'createdAt': 1793600005000},
        ])
        report = self.mirrored()
        self.assertEqual([item['runId'] for item in report['candidates']], ['run-dup-0006'])

    def test_acked_runs_are_marked_acked_but_never_delivered(self):
        with open(os.path.join(self.state, terminal_source.STATE_NAME), 'w', encoding='utf-8') as handle:
            json.dump({'version': 1, 'pendingIds': [], 'ackedIds': ['run-acked-0007'],
                       'baselineIds': [], 'baselineCount': 0, 'baselineDropped': 0}, handle)
        self.ledger([{'requestID': 'run-acked-0007', 'status': 'completed', 'createdAt': 1793600000000}])
        item = self.mirrored()['candidates'][0]
        self.assertEqual(item['hostAck'], 'acked')
        self.assertEqual(item['pageDelivery'], 'unknown')


if __name__ == '__main__':
    unittest.main()
