"""T270: the mirror's ACK label belongs to the fact it names, not to the run.

The Host journals ACKs per (runId, status) since T268 (`ackedForms` / `pendingForms`), but the mirror -- the reader
the sidecar feeds into the relay service -- still answered from the bare id sets. A run announced `failed`, acked,
and later really completed therefore went out labelled `acked` again, and the service stored the completion as
consumed although nobody had been told about it.

These cases run the real `terminal_source.mirror` against a temp ledger and a temp state file: the `failed` ack must
not vouch for the `completed` fact, a genuine per-fact ack must still say `acked`, and a pre-journal state file
(bare ids only) must keep its old meaning rather than lose an ACK it really had.
"""

import json
import os
import shutil
import tempfile
import unittest

import terminal_source

RUN = '5859fb48-8421-4590-870b-6ffceb651674'
OTHER = '5eebbb69-bc3d-4657-85a0-365eef08907a'
COMPLETED_MS = 1793968186202


class FactAckLabelTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t270-root-')
        self.state = tempfile.mkdtemp(prefix='t270-state-')
        sub = os.path.join(self.root, 'c' * 64)
        os.makedirs(sub)
        self.path = os.path.join(sub, 'endpoint.json.runs.json')
        # No Bridge of any kind: the facts come from the ledger alone, and the origin classification from a fixture,
        # so nothing here can read the operator's production database.
        self.bridge = os.path.join(self.state, 'absent-bridge.sqlite')
        self.origin_fixture = os.path.join(self.state, 'origin.fixture.json')
        with open(self.origin_fixture, 'w', encoding='utf-8') as handle:
            json.dump({'version': 1, 'bridge': '*'}, handle)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)

    def ledger(self, runs):
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def sampler(self, **state):
        doc = {'version': 1, 'baselineIds': [], 'baselineCount': 0, 'baselineDropped': 0,
               'pendingIds': [], 'pendingForms': [], 'ackedIds': [], 'ackedForms': [],
               'relayActivatedAt': None, 'relayActivation': None, 'relayBaselineIds': [],
               'relayOfferedIds': [], 'relayAckedIds': [], 'relayDeferredIds': []}
        doc.update(state)
        with open(os.path.join(self.state, terminal_source.STATE_NAME), 'w', encoding='utf-8') as handle:
            json.dump(doc, handle)

    def mirrored(self):
        report = terminal_source.mirror(self.state, self.root, bridge_db=self.bridge,
                                        origin_fixture=self.origin_fixture)
        self.assertTrue(report['ok'], report)
        return {item['runId']: item for item in report['candidates']}

    def test_a_failed_ack_does_not_vouch_for_the_completion(self):
        self.ledger([{'requestID': RUN, 'status': 'completed', 'createdAt': 1793965592}])
        self.sampler(ackedIds=[RUN], ackedForms=['%s|failed' % RUN])
        item = self.mirrored()[RUN]
        self.assertEqual(item['status'], 'completed')
        self.assertEqual(item['hostAck'], 'unseen',
                         'the host was told about the failure, not about the completion')

    def test_a_completion_that_was_offered_is_pending_until_acked(self):
        self.ledger([{'requestID': RUN, 'status': 'completed', 'createdAt': 1793965592}])
        self.sampler(pendingIds=[RUN], pendingForms=['%s|completed' % RUN], ackedIds=[RUN],
                     ackedForms=['%s|failed' % RUN])
        self.assertEqual(self.mirrored()[RUN]['hostAck'], 'pending')

    def test_a_completion_that_was_acked_says_acked(self):
        self.ledger([{'requestID': RUN, 'status': 'completed', 'createdAt': 1793965592}])
        self.sampler(ackedIds=[RUN], ackedForms=['%s|failed' % RUN, '%s|completed' % RUN])
        self.assertEqual(self.mirrored()[RUN]['hostAck'], 'acked')

    def test_the_other_status_keeps_its_own_label(self):
        self.ledger([
            {'requestID': RUN, 'status': 'completed', 'createdAt': 1793965592},
            {'requestID': OTHER, 'status': 'failed', 'createdAt': 1793958534},
        ])
        self.sampler(ackedIds=[RUN, OTHER], ackedForms=['%s|failed' % RUN, '%s|failed' % OTHER])
        by_id = self.mirrored()
        self.assertEqual(by_id[RUN]['hostAck'], 'unseen')
        self.assertEqual(by_id[OTHER]['hostAck'], 'acked',
                         'a fact that really was consumed keeps its confirmation')

    def test_a_state_file_from_before_the_journal_keeps_its_bare_ack(self):
        self.ledger([{'requestID': RUN, 'status': 'completed', 'createdAt': 1793965592}])
        doc = {'version': 1, 'baselineIds': [], 'pendingIds': [], 'ackedIds': [RUN],
               'baselineCount': 0, 'baselineDropped': 0}
        with open(os.path.join(self.state, terminal_source.STATE_NAME), 'w', encoding='utf-8') as handle:
            json.dump(doc, handle)
        self.assertEqual(self.mirrored()[RUN]['hostAck'], 'acked',
                         'an upgraded install must not turn a genuine ACK into unseen')

    def test_an_unacked_run_is_unseen(self):
        self.ledger([{'requestID': RUN, 'status': 'completed', 'createdAt': 1793965592}])
        self.sampler()
        self.assertEqual(self.mirrored()[RUN]['hostAck'], 'unseen')

    def test_the_label_is_still_not_a_delivery_claim(self):
        self.ledger([{'requestID': RUN, 'status': 'completed', 'createdAt': 1793965592}])
        self.sampler(ackedIds=[RUN], ackedForms=['%s|completed' % RUN])
        report = terminal_source.mirror(self.state, self.root, bridge_db=self.bridge,
                                        origin_fixture=self.origin_fixture)
        self.assertEqual(report['pageDelivery'], 'unknown')
        self.assertEqual(report['candidates'][0]['pageDelivery'], 'unknown')
        self.assertEqual(report['counts']['acked'], 1)

    def test_mirroring_still_writes_nothing(self):
        self.ledger([{'requestID': RUN, 'status': 'completed', 'createdAt': 1793965592}])
        self.sampler(ackedIds=[RUN], ackedForms=['%s|failed' % RUN])
        state_file = os.path.join(self.state, terminal_source.STATE_NAME)
        with open(state_file, 'rb') as handle:
            before = handle.read()
        self.mirrored()
        with open(state_file, 'rb') as handle:
            self.assertEqual(handle.read(), before, 'the mirror must not move any bookkeeping')


if __name__ == '__main__':
    unittest.main()
