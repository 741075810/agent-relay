"""T209: the relay's activation must be its own, not borrowed from the native baseline.

`terminal_source.sample()` only absorbed relay history on the sample where the *native* baseline was first established.
In the real deployment the native host has been running for months, so that moment is long past: a later, default-off
relay source would find `info['baselineEstablished']` already False and announce every old completion it could see.

These tests are written against the behaviour that is required, and they fail on the code as it stood. Scenarios:

* relay switched on long after the native baseline exists;
* relay unreachable on first contact, then reachable -- a failure must not count as "empty history";
* a successful empty read does count as activation;
* the activation survives a restart, both as state and as behaviour;
* history larger than the state bound must stall and say so, never truncate into a later false notice;
* with an arm snapshot, an old run is absorbed and a run provably after the arm is still announced.
"""

import json
import os
import shutil
import time
import unittest

import relay_merge
import terminal_source
from test_t095b206_relay_fusion import RelayScene, RELAY_RUN

OLD_RUN = '33333333-1111-4222-8333-444455556666'
NEW_RUN = '44444444-1111-4222-8333-444455556666'
NATIVE_RUN = '55555555-1111-4222-8333-444455556666'


class RelayActivation(RelayScene):

    def candidate(self, run_id, status='completed', stamps=None):
        item = {'runId': run_id, 'terminalStatus': status,
                'hostSource': 'native_host.terminal-mirror',
                'statusSource': 'bridge_ledger.status', 'origin': 'bridge'}
        if stamps is not None:
            item['startedAt'], item['completedAt'] = stamps
            item['completedAtSource'] = {'completed': 'bridge.task_events.task.completed',
                                         'failed': 'bridge.task_events.task.failed'}.get(status)
        return item

    def sample(self):
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], reply)
        return reply['result']

    def seed_ids(self, run_ids):
        # Old runs carry a start time well before any activation; new ones a start time far in the future, so the
        # boundary is provable from the data rather than inferred from when the test happened to run.
        # OLD finished long ago; NEW began long ago too but finished after any boundary in these tests.
        plan = {OLD_RUN: (1700000000000, 1700000000000),
                NEW_RUN: (1700000000000, int(time.time() * 1000) + 60000)}
        self.seed_relay([self.candidate(run_id, stamps=plan.get(run_id)) for run_id in run_ids])

    def saved(self):
        return self.source_state()

    def test_relay_enabled_after_the_native_baseline_does_not_replay_history(self):
        # The native host is already running: its baseline is established and a native run has been consumed.
        self.ledger_runs([])
        self.start_service()
        self.assertEqual(self.sample()['candidates'], [])
        self.ledger_runs([{'requestID': NATIVE_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [NATIVE_RUN])
        self.host('terminal-ack', {'acked': [NATIVE_RUN]})
        self.assertEqual(self.sample()['candidates'], [])

        # Only now does the relay come up, carrying a run that finished long ago.
        self.seed_ids([OLD_RUN])
        first = self.sample()
        self.assertFalse(first['baselineEstablished'], 'the native baseline was established rounds ago')
        self.assertEqual([item['runId'] for item in first['candidates']], [],
                         'relay history is not news just because the relay is new')
        self.assertEqual(first['relayAbsorbed'], 1)
        self.assertEqual(first['relayActivation'], 'active')
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [])

        # A run that appears after activation is announced, once.
        self.seed_ids([OLD_RUN, NEW_RUN])
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [NEW_RUN])

    def test_a_failed_first_read_does_not_count_as_an_empty_history(self):
        self.ledger_runs([])
        self.start_service()
        self.service.kill()
        self.service.wait(timeout=10)
        down = self.sample()                                   # native baseline, relay unreachable
        self.assertEqual(down['relayCode'], 'relay_unavailable')
        self.assertNotEqual(down['relayActivation'], 'active',
                            'an unreachable source has not been initialised')
        self.assertNotIn('relayBaselineIds', self.saved())

        # The relay comes back holding an old run: it must be absorbed now, not announced.
        self.start_service_preserving_state()
        self.seed_ids([OLD_RUN])
        back = self.sample()
        self.assertEqual([item['runId'] for item in back['candidates']], [])
        self.assertEqual(back['relayAbsorbed'], 1)
        self.assertEqual(back['relayActivation'], 'active')
        self.seed_ids([OLD_RUN, NEW_RUN])
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [NEW_RUN])

    def test_a_successful_empty_read_is_an_activation(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()
        empty = self.sample()
        self.assertIsNone(empty['relayCode'])
        self.assertEqual(empty['relayActivation'], 'active', 'readable and empty is a real answer')
        self.assertEqual(self.saved().get('relayBaselineIds'), [])
        self.seed_ids([NEW_RUN])
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [NEW_RUN])

    def test_the_activation_survives_a_restart(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()
        self.seed_ids([OLD_RUN])
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [])
        self.service.kill()
        self.service.wait(timeout=10)
        self.start_service_preserving_state()
        after = self.sample()
        self.assertEqual(after['relayActivation'], 'active')
        self.assertEqual(after['relayAbsorbed'], 0, 'absorption happens once, not on every start')
        self.assertEqual([item['runId'] for item in after['candidates']], [])

    def test_history_beyond_the_state_bound_stalls_instead_of_truncating(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()
        many = ['%08d-1111-4222-8333-444455556666' % index
                for index in range(terminal_source.MAX_STATE_IDS + 5)]
        self.seed_relay([self.candidate(run_id, stamps=(1700000000000, 1700000000000)) for run_id in many])
        stalled = self.sample()
        self.assertEqual(stalled['relayActivation'], 'stalled')
        self.assertEqual(stalled['relayCode'], 'relay_history_overflow')
        self.assertEqual([item['runId'] for item in stalled['candidates']], [],
                         'refusing to announce is the safe half; silently re-offering later is not')
        again = self.sample()
        self.assertEqual([item['runId'] for item in again['candidates']], [],
                         'a stalled source keeps refusing rather than replaying a truncated tail')
        self.assertEqual(again['relayCode'], 'relay_history_overflow')
        self.assertLessEqual(len(self.saved().get('relayBaselineIds') or []), terminal_source.MAX_STATE_IDS)

    def test_with_an_arm_snapshot_old_runs_are_absorbed_and_post_arm_runs_are_announced(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()                                          # native baseline
        arm_path = os.path.join(self.state, terminal_source.ARM_NAME)
        with open(arm_path, 'w', encoding='utf-8') as handle:
            # A complete snapshot: the host refuses anything it cannot prove was not truncated.
            json.dump({'version': terminal_source.ARM_VERSION, 'epoch': 'e1',
                       'takenAt': 1793600000, 'truncated': False, 'ids': [OLD_RUN]}, handle)
        self.seed_ids([OLD_RUN, NEW_RUN])
        first = self.sample()
        self.assertEqual(first['relayAbsorbed'], 1, 'only what the arm snapshot proves is history')
        self.assertEqual([item['runId'] for item in first['candidates']], [NEW_RUN],
                         'a run not in the snapshot finished after the operator consented')
        self.assertTrue(first['candidates'][0]['postArm'])
        self.assertIn(OLD_RUN, self.saved().get('relayBaselineIds') or [])

    def start_service_preserving_state(self):
        self.start_service()


class Units(unittest.TestCase):

    def test_absorb_never_invents_capacity(self):
        ids = [{'runId': 'r%d' % index} for index in range(10)]
        self.assertEqual(len(relay_merge.absorb(ids, 4)), 4)

    def test_history_excludes_the_activation_boundary_from_announcement(self):
        state = {'relayBaselineIds': ['r1'], 'relayAckedIds': ['r2']}
        offered = relay_merge.merge([], [{'runId': 'r1', 'status': 'completed'},
                                         {'runId': 'r2', 'status': 'completed'}], state)
        self.assertEqual(offered, [])


if __name__ == '__main__':
    unittest.main()
