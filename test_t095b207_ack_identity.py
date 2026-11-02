"""T207: the ACK identity the production extension actually sends, and the regression it caused.

The extension acknowledges `terminal-list` with a **bare run id**; its own trigger journal keys on `runId|status`. T206
journalled both spellings on write but only compared one on read, so an acknowledged relay candidate was offered again
on the next sample -- a re-push loop, and the defect this file exists to keep fixed.

Real components throughout: the shipping `host.py` subprocess, the real Node service, a throwaway manifest and an
empty native root. Nothing here simulates the task state machine.
"""

import io
import json
import os
import sys
import unittest

import protocol as P
import relay_merge
from test_t095b206_relay_fusion import RelayScene, RELAY_RUN, NATIVE_RUN


class AckIdentity(RelayScene):

    def offer(self):
        return [item['runId'] for item in self.candidates(self.host('terminal-list'))]

    def seed(self):
        self.seed_relay([{'runId': RELAY_RUN, 'terminalStatus': 'completed',
                          'hostSource': 'native_host.terminal-mirror',
                          'statusSource': 'bridge_ledger.status', 'origin': 'bridge'}])

    def test_a_bare_run_id_ack_suppresses_the_next_offer(self):
        # The production extension's ACK shape. Before the fix this offered the candidate again.
        self.start_service()
        self.host('terminal-list')
        self.seed()
        self.assertEqual(self.offer(), [RELAY_RUN])
        self.host('terminal-ack', {'acked': [RELAY_RUN]})
        self.assertEqual(self.offer(), [], 'a bare-id ACK must be as final as a runId|status ACK')
        self.assertEqual(self.source_state().get('relayAckedIds'), [RELAY_RUN])

    def test_both_ack_spellings_suppress_and_neither_pollutes_the_native_lists(self):
        self.start_service()
        self.host('terminal-list')
        self.seed()
        self.assertEqual(self.offer(), [RELAY_RUN])
        self.host('terminal-ack', {'acked': [RELAY_RUN + '|completed']})
        state = self.source_state()
        self.assertIn(RELAY_RUN + '|completed', state.get('relayAckedIds') or [])
        self.assertIn(RELAY_RUN, state.get('relayAckedIds') or [],
                      'the bare form is journalled too, so an ACK in either shape is final')
        self.assertEqual(state.get('ackedIds'), [])
        self.assertEqual(state.get('pendingIds'), [])
        self.assertEqual(self.offer(), [])

    def test_a_native_ack_never_enters_the_relay_journal(self):
        self.start_service()
        self.host('terminal-list')
        self.ledger_runs([{'requestID': NATIVE_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        self.assertEqual(self.offer(), [NATIVE_RUN])
        self.host('terminal-ack', {'acked': [NATIVE_RUN]})
        state = self.source_state()
        self.assertEqual(state.get('ackedIds'), [NATIVE_RUN])
        self.assertEqual(list(state.get('relayAckedIds') or []), [],
                         'a native run must not be recorded as relay-sourced')
        self.assertEqual(self.offer(), [])

    def test_a_status_change_after_the_ack_does_not_announce_the_run_twice(self):
        self.start_service()
        self.host('terminal-list')
        self.seed()
        self.assertEqual(self.offer(), [RELAY_RUN])
        self.host('terminal-ack', {'acked': [RELAY_RUN]})
        # the relay's own record changes its mind about the terminal status
        self.seed_relay([{'runId': RELAY_RUN, 'terminalStatus': 'failed',
                          'hostSource': 'native_host.terminal-mirror',
                          'statusSource': 'bridge_ledger.status', 'origin': 'bridge'}])
        self.assertEqual(self.offer(), [], 'one notice per run, whatever status it settles on')

    def test_an_ack_survives_a_restart_and_a_dead_relay(self):
        self.start_service()
        self.host('terminal-list')
        self.seed()
        self.assertEqual(self.offer(), [RELAY_RUN])
        self.host('terminal-ack', {'acked': [RELAY_RUN]})
        self.service.kill()
        self.service.wait(timeout=10)
        reply = self.host('terminal-list')                     # fresh process, relay now unreachable
        self.assertTrue(reply['ok'])
        self.assertEqual(reply['result']['relayCode'], 'relay_unavailable')
        self.assertEqual([item['runId'] for item in reply['result']['candidates']], [])
        self.start_service_preserving_state()
        self.assertEqual(self.offer(), [], 'still suppressed after the source comes back')

    # --- helper -------------------------------------------------------------------------------------------
    def start_service_preserving_state(self):
        self.start_service()


class MergeUnits(unittest.TestCase):
    """The comparison itself, without a host in the way."""

    def candidate(self, status='completed'):
        return {'runId': RELAY_RUN, 'status': status, 'origin': 'bridge', 'source': 'relay'}

    def test_a_journalled_bare_id_suppresses_every_status(self):
        state = {'pendingIds': [], 'ackedIds': [], 'relayAckedIds': [RELAY_RUN]}
        self.assertEqual(relay_merge.merge([], [self.candidate('completed')], state), [])
        self.assertEqual(relay_merge.merge([], [self.candidate('failed')], state), [])

    def test_a_journalled_composite_id_suppresses_the_same_status(self):
        state = {'relayAckedIds': [RELAY_RUN + '|completed']}
        self.assertEqual(relay_merge.merge([], [self.candidate('completed')], state), [])

    def test_a_native_owned_run_is_never_offered_as_relay(self):
        state = {'pendingIds': [], 'ackedIds': [RELAY_RUN], 'relayAckedIds': []}
        self.assertEqual(relay_merge.merge([], [self.candidate('completed')], state), [])

    def test_an_unacknowledged_candidate_is_offered_once(self):
        state = {'pendingIds': [], 'ackedIds': [], 'relayAckedIds': []}
        offered = relay_merge.merge([], [self.candidate('completed'), self.candidate('failed')], state)
        self.assertEqual([item['runId'] for item in offered], [RELAY_RUN],
                         'two statuses for one run are still one notice')


if __name__ == '__main__':
    unittest.main()
