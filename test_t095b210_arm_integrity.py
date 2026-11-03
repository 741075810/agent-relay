"""T210: an arm snapshot is a statement about the sources it read.

`arm_snapshot()` only ever listed runs from the Bridge ledger, yet T209 treated a relay candidate's *absence* from that
list as proof it finished after consent. A run the relay knows and the ledger does not -- exactly the Relay-only history
this whole chain exists for -- therefore arrived as `postArm: True`, i.e. as an authorised new notice.

The rule now: absence from a snapshot proves nothing about a source the snapshot did not read. Relay consent is decided
per run from a **completion** stamp (never `startedAt`, which only says completion is at or after creation), that stamp
must be plausible against the wall clock, and anything unprovable is held with a reason.

Real components: shipping `host.py` subprocess, real Node service.
"""

import json
import os
import time
import unittest

import relay_merge
import terminal_source
from test_t095b206_relay_fusion import RelayScene

OLD_RUN = '88888888-1111-4222-8333-444455556666'
NEW_RUN = '99999999-1111-4222-8333-444455556666'
RELAY_ONLY = 'aaaabbbb-1111-4222-8333-444455556666'
ARM_TAKEN_AT = 1793600000                       # seconds, as the snapshot stores it
OLD_MS = 1700000000000
FUTURE_MS = int(time.time() * 1000) + 120000


class ArmIntegrity(RelayScene):

    def candidate(self, run_id, completed_at=None, started_at=OLD_MS, status='completed'):
        item = {'runId': run_id, 'terminalStatus': status, 'startedAt': started_at,
                'hostSource': 'native_host.terminal-mirror',
                'statusSource': 'bridge_ledger.status', 'origin': 'bridge'}
        if completed_at is not None:
            item['completedAt'] = completed_at
        return item

    def seed(self, items):
        import urllib.request
        token = open(self.token_file, encoding='utf-8').read().strip()
        body = json.dumps({'candidates': items}).encode('utf-8')
        request = urllib.request.Request(
            self.service_url + '/host/terminal-candidates', data=body,
            headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode('utf-8'))

    def sample(self):
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], reply)
        return reply['result']

    def write_arm(self, ids, relay_covered=False):
        with open(os.path.join(self.state, terminal_source.ARM_NAME), 'w', encoding='utf-8') as handle:
            json.dump({'version': terminal_source.ARM_VERSION, 'epoch': 'e1', 'takenAt': ARM_TAKEN_AT,
                       'truncated': False, 'ids': ids, 'sources': ['bridge_ledger'],
                       'relayCovered': relay_covered}, handle)

    def test_a_relay_only_run_absent_from_a_ledger_snapshot_is_not_authorised(self):
        # The snapshot was built from the Bridge ledger and never saw the relay. Absence is not evidence.
        self.ledger_runs([])
        self.start_service()
        self.sample()
        self.write_arm([OLD_RUN])                              # no relay coverage recorded
        self.sample()                                          # activation absorbs the empty relay
        self.seed([self.candidate(RELAY_ONLY)])                # no completion stamp at all
        reply = self.sample()
        self.assertEqual([item['runId'] for item in reply['candidates']], [],
                         'a run the snapshot never saw cannot be inferred to be post-arm')
        self.assertEqual(reply['relayUnverified'], 1)
        self.assertEqual(reply['relayCode'], 'relay_completion_unknown')
        self.assertFalse(reply['armRelayCovered'])

    def test_a_relay_run_with_a_completion_stamp_after_the_arm_is_authorised(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()
        self.write_arm([OLD_RUN])
        self.sample()
        self.seed([self.candidate(NEW_RUN, completed_at=FUTURE_MS)])
        reply = self.sample()
        self.assertEqual([item['runId'] for item in reply['candidates']], [NEW_RUN])
        self.assertTrue(reply['candidates'][0]['postArm'])
        self.assertEqual(reply['candidates'][0]['postArmEvidence'], 'relay_completed_at')

    def test_a_long_run_that_started_before_the_arm_and_finished_after_is_announced(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()
        self.write_arm([OLD_RUN])
        self.sample()
        # created before consent, finished after it: the case a start-time comparison gets wrong
        self.seed([self.candidate(NEW_RUN, started_at=OLD_MS, completed_at=FUTURE_MS)])
        reply = self.sample()
        self.assertEqual([item['runId'] for item in reply['candidates']], [NEW_RUN])

    def test_a_run_that_finished_before_the_arm_is_not_announced(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()
        self.write_arm([OLD_RUN])
        self.sample()
        self.seed([self.candidate(OLD_RUN, completed_at=OLD_MS)])
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [])

    def test_an_implausible_completion_stamp_is_refused_not_trusted(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()
        self.write_arm([OLD_RUN])
        self.sample()
        far_future = int(time.time() * 1000) + 10 * 365 * 24 * 3600 * 1000
        self.seed([self.candidate(NEW_RUN, completed_at=far_future),
                   self.candidate(RELAY_ONLY, completed_at=12345)])
        reply = self.sample()
        self.assertEqual([item['runId'] for item in reply['candidates']], [])
        self.assertEqual(reply['relayImplausible'], 2)
        self.assertEqual(reply['relayCode'], 'relay_completion_unknown')

    def test_arming_includes_the_relay_and_refuses_when_it_cannot_be_read(self):
        self.ledger_runs([])
        self.start_service()
        self.seed([self.candidate(RELAY_ONLY, completed_at=OLD_MS)])
        arm = self.host('terminal-arm-snapshot', {'epoch': 'e-relay'})
        self.assertTrue(arm['result']['ok'], arm)
        self.assertTrue(arm['result']['relayCovered'])
        self.assertEqual(arm['result']['sources'], ['bridge_ledger', 'relay'])
        self.assertEqual(arm['result']['relayCount'], 1)
        snapshot = json.load(open(os.path.join(self.state, terminal_source.ARM_NAME), encoding='utf-8'))
        self.assertIn(RELAY_ONLY, snapshot['ids'])
        self.assertTrue(snapshot['relayCovered'])
        # and the same run is not announced afterwards: the snapshot proves it was already terminal
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [])

        self.service.kill()
        self.service.wait(timeout=10)
        refused = self.host('terminal-arm-snapshot', {'epoch': 'e-relay-2'})
        # The envelope is still a well-formed answer; it is the report inside it that refused.
        self.assertTrue(refused['ok'], refused)
        self.assertFalse(refused['result']['ok'])
        self.assertEqual(refused['result']['code'], 'relay_source_unavailable_for_arm')

    def test_a_held_candidate_stays_held_across_a_restart(self):
        self.ledger_runs([])
        self.start_service()
        self.sample()
        self.write_arm([OLD_RUN])
        self.sample()
        self.seed([self.candidate(RELAY_ONLY)])
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [])
        self.service.kill()
        self.service.wait(timeout=10)
        self.start_service_preserving_state()
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [],
                         'held is not a queue that drains later')
        # T213: the refusal is recorded as *deferred*, not as history. The two used to be the same set, which is how a
        # late legitimate completion became unrecoverable; the property under test here -- that it is not announced --
        # is unchanged, and so is the fact that it is remembered across the restart.
        state = self.source_state()
        self.assertIn(RELAY_ONLY, state.get('relayDeferredIds') or [])
        self.assertNotIn(RELAY_ONLY, state.get('relayBaselineIds') or [])

    def start_service_preserving_state(self):
        self.start_service()


class Units(unittest.TestCase):

    def test_completion_is_never_taken_from_a_start_time(self):
        self.assertIsNone(relay_merge.completed_ms({'startedAt': OLD_MS}))
        self.assertEqual(relay_merge.completed_ms({'completedAt': OLD_MS}), OLD_MS)
        self.assertEqual(relay_merge.completed_ms({'endedAtMs': OLD_MS}), OLD_MS)
        self.assertEqual(relay_merge.completed_ms({'endedAt': 1793600000}), 1793600000000)

    def test_plausibility_rejects_both_directions(self):
        now = 1793600000000
        self.assertTrue(relay_merge.plausible(now - 1000, now))
        self.assertFalse(relay_merge.plausible(now + relay_merge.CLOCK_SKEW_MS + 1, now))
        self.assertFalse(relay_merge.plausible(relay_merge.EARLIEST_MS - 1, now))
        self.assertFalse(relay_merge.plausible(None, now))


if __name__ == '__main__':
    unittest.main()
