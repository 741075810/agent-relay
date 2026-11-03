"""T208: two ways a notice can be wrong — replaying history, and swallowing a run nobody saw.

1. **History replayed.** The native side absorbs whatever was already terminal at the first sample. The relay had no
   such rule: enabling it offered every run that had finished before anyone consented, which is exactly the notice the
   one inviolable rule forbids.
2. **A run swallowed.** `acknowledge_relay()` journalled any id that was not native-owned, including runs that had never
   been handed out. A stray or pre-emptive ACK therefore cancelled the notice for a run that had not even finished yet,
   and nothing would ever have reported it.

Real components: the shipping `host.py` subprocess and the real Node service, over the real wire format.
"""

import os
import unittest

import relay_merge
from test_t095b206_relay_fusion import RelayScene, RELAY_RUN

LATE_RUN = 'ffffffff-1111-4222-8333-444455556666'


class HistoryIsNotNews(RelayScene):

    def relay_candidate(self, run_id, status='completed', origin='bridge'):
        # Old runs carry a start time before any activation; LATE_RUN one far after it. The boundary is in the data.
        stamp = 4000000000000 if run_id == LATE_RUN else 1700000000000
        return {'runId': run_id, 'terminalStatus': status, 'startedAt': stamp,
                'hostSource': 'native_host.terminal-mirror',
                'statusSource': 'bridge_ledger.status', 'origin': origin}

    def offer(self):
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], reply)
        return reply['result']

    def test_a_run_that_finished_before_enabling_is_never_announced(self):
        # The relay already knows about a finished run when the feature is first switched on.
        self.start_service()
        self.seed_relay([self.relay_candidate(RELAY_RUN)])
        first = self.offer()
        self.assertEqual([item['runId'] for item in first['candidates']], [],
                         'enabling the relay must not replay what already finished')
        self.assertEqual(first['relayAbsorbed'], 1, 'and it must say that it absorbed something')
        second = self.offer()
        self.assertEqual([item['runId'] for item in second['candidates']], [],
                         'history stays history on the next sample too')
        self.assertEqual(second['relayAbsorbed'], 0)
        self.assertIn(RELAY_RUN, self.source_state().get('relayBaselineIds') or [])

    def test_a_run_that_finishes_after_enabling_is_announced_once(self):
        self.start_service()
        self.seed_relay([self.relay_candidate(RELAY_RUN)])
        self.offer()                                          # absorbs RELAY_RUN as history
        self.seed_relay([self.relay_candidate(RELAY_RUN), self.relay_candidate(LATE_RUN)])
        offered = [item['runId'] for item in self.offer()['candidates']]
        self.assertEqual(offered, [LATE_RUN], 'only the new one is announced')
        self.assertEqual([item['runId'] for item in self.offer()['candidates']], [LATE_RUN],
                         'and it is re-offered until acknowledged, never duplicated in one answer')

    def test_a_native_baseline_run_is_not_reintroduced_by_the_relay(self):
        self.start_service()
        self.ledger_runs([])
        self.offer()                                          # native baseline: empty
        # the same run reaches the host through both sources, and the native side saw it first
        self.ledger_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        native_offer = [item['runId'] for item in self.offer()['candidates']]
        self.assertEqual(native_offer, [RELAY_RUN])
        self.host('terminal-ack', {'acked': [RELAY_RUN]})
        self.seed_relay([self.relay_candidate(RELAY_RUN)])
        self.assertEqual([item['runId'] for item in self.offer()['candidates']], [],
                         'a run the native queue already consumed is not relay news')

    def test_absorption_survives_a_restart(self):
        self.start_service()
        self.seed_relay([self.relay_candidate(RELAY_RUN)])
        self.assertEqual([item['runId'] for item in self.offer()['candidates']], [])
        self.service.kill()
        self.service.wait(timeout=10)
        self.start_service_preserving_state()
        self.assertEqual([item['runId'] for item in self.offer()['candidates']], [],
                         'the absorbed ids are in the state file, not in memory')

    def start_service_preserving_state(self):
        self.start_service()


class AckCannotSwallowAnUnannouncedRun(RelayScene):

    def relay_candidate(self, run_id, status='completed'):
        # Everything in this scene is a post-activation completion; the act of finishing is what makes it announceable.
        return {'runId': run_id, 'terminalStatus': status, 'startedAt': 4000000000000,
                'hostSource': 'native_host.terminal-mirror',
                'statusSource': 'bridge_ledger.status', 'origin': 'bridge'}

    def offer_ids(self):
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], reply)
        return [item['runId'] for item in reply['result']['candidates']]

    def test_an_ack_for_a_run_that_was_never_offered_is_refused(self):
        self.start_service()
        self.seed_relay([])
        self.assertEqual(self.offer_ids(), [])                 # baseline
        self.assertEqual(self.offer_ids(), [])
        answer = self.host('terminal-ack', {'acked': [RELAY_RUN]})
        self.assertTrue(answer['ok'], answer)
        state = self.source_state()
        self.assertEqual(list(state.get('relayAckedIds') or []), [],
                         'an id nobody was given must not enter the journal')
        self.assertEqual(list(answer['result'].get('relayAcked') or []), [])
        # the run finishes afterwards and is still announced
        self.seed_relay([self.relay_candidate(RELAY_RUN)])
        self.assertEqual(self.offer_ids(), [RELAY_RUN],
                         'the pre-emptive ACK must not have cancelled the real completion')

    def test_an_ack_for_a_run_that_was_offered_is_still_final(self):
        self.start_service()
        self.seed_relay([])
        self.offer_ids()
        self.seed_relay([self.relay_candidate(RELAY_RUN)])
        self.assertEqual(self.offer_ids(), [RELAY_RUN])
        self.host('terminal-ack', {'acked': [RELAY_RUN]})
        self.assertEqual(self.offer_ids(), [])
        self.assertIn(RELAY_RUN, self.source_state().get('relayAckedIds') or [])

    def test_the_offer_record_is_bounded_and_persisted(self):
        self.start_service()
        self.seed_relay([])
        self.offer_ids()
        self.seed_relay([self.relay_candidate(RELAY_RUN), self.relay_candidate(LATE_RUN)])
        self.assertEqual(sorted(self.offer_ids()), sorted([RELAY_RUN, LATE_RUN]))
        offered = self.source_state().get('relayOfferedIds') or []
        self.assertIn(RELAY_RUN + '|completed', offered)
        self.assertIn(LATE_RUN + '|completed', offered)
        self.assertLessEqual(len(offered), 500)


class Units(unittest.TestCase):

    def test_absorb_keeps_the_newest_and_drops_duplicates(self):
        candidates = [{'runId': 'a'}, {'runId': 'b'}, {'runId': 'a'}, {'runId': 'c'}]
        self.assertEqual(relay_merge.absorb(candidates, 2), ['b', 'c'])
        self.assertEqual(relay_merge.absorb([], 10), [])

    def test_history_includes_every_namespace(self):
        state = {'baselineIds': ['n1'], 'relayBaselineIds': ['r1'], 'pendingIds': ['n2'],
                 'ackedIds': ['n3'], 'relayAckedIds': ['r2']}
        self.assertEqual(relay_merge.history(state), {'n1', 'n2', 'n3', 'r1', 'r2'})

    def test_was_offered_accepts_both_spellings(self):
        offered = [RELAY_RUN + '|completed']
        self.assertTrue(relay_merge.was_offered(offered, RELAY_RUN))
        self.assertTrue(relay_merge.was_offered(offered, RELAY_RUN, 'completed'))
        self.assertFalse(relay_merge.was_offered(offered, LATE_RUN))
        self.assertFalse(relay_merge.was_offered([], RELAY_RUN))


if __name__ == '__main__':
    unittest.main()
