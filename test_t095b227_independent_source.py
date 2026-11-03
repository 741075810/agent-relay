"""T227: an independent terminal source may only be added deliberately, and may only produce correct candidates.

The rules under test are the ones that make a second source safe rather than merely additional: it must not be the Bridge
wearing a different name, it must not replay history, it must not announce twice, it must not reconstruct a completion
instant, and it must not change what consent already decided. All of it runs in a temporary state directory with a fake
source; nothing here reads the operator's files or contacts the Bridge.
"""

import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'tools', 'service'))

import independent_terminal_source as its                       # noqa: E402
import relay_merge                                              # noqa: E402

NOW_MS = 1_800_000_000_000
ARMED_AT = NOW_MS - 3_600_000        # consent an hour ago
AFTER_ARM = ARMED_AT + 60_000
BEFORE_ARM = ARMED_AT - 60_000


def event(run_id, status='completed', ended_at_ms=AFTER_ARM, producer='dsh-session-store',
          provenance='dsh.turn.completed', origin='bridge'):
    return {'run_id': run_id, 'status': status, 'ended_at_ms': ended_at_ms, 'ended_at_source': provenance,
            'produced_by': producer, 'origin': origin}


class FakeSource:
    def __init__(self, events, cursor=0, code=None):
        self.events, self.cursor_value, self.code = events, cursor, code
        self.calls = []

    def fetch(self, cursor, timeout=10):
        self.calls.append(cursor)
        if self.code:
            raise its.SourceError(self.code, 'scripted failure')
        return self.events, self.cursor_value


class IndependenceTest(unittest.TestCase):
    def test_the_bridge_wearing_another_name_is_refused(self):
        for producer, provenance in (
            ('bridge-service', 'dsh.turn.completed'),
            ('codex-bridge', 'dsh.turn.completed'),
            ('dsh-session-store', 'bridge.task_events.task.completed'),
            ('dsh-session-store', 'bridge'),
        ):
            ok, why = its.is_independent(producer, provenance)
            self.assertFalse(ok, '%s / %s was accepted' % (producer, provenance))
            self.assertTrue(why)

    def test_a_bridge_shaped_event_is_refused_rather_than_announced(self):
        state = {'independentCursor': 0}
        arm = {'runIds': [], 'armedAtMs': ARMED_AT}
        events = [event('r1', producer='bridge.service', provenance='bridge.task_events.task.completed')]
        candidates, next_state, report = its.admit(events, state, arm, NOW_MS, 7)
        self.assertEqual(candidates, [])
        self.assertEqual(report['refused'], 1)
        self.assertIn('r1', next_state['independentDeferredIds'])

    def test_nothing_is_bound_in_production(self):
        self.assertEqual(its.PRODUCTION_SOURCES, ())

    def test_no_production_entry_point_imports_the_adapter(self):
        """An independent source may not reach a real notification path without a review and a decision."""
        offenders = []
        for name in ('host.py', 'terminal_source.py', 'relay_merge.py', 'relay_supervisor.py',
                     'host_mirror.mjs', 'relay_service.mjs', 'relay_candidate_intake.mjs',
                     os.path.join('extension', 'lib', 'background.js')):
            path = os.path.join(HERE, name)
            if not os.path.isfile(path):
                continue
            text = open(path, encoding='utf-8').read()
            if 'independent_terminal_source' in text or 'independent_source' in text:
                offenders.append(name)
        self.assertEqual(offenders, [])


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self.state = {'independentCursor': 0, 'relayBaselineIds': [], 'relayAckedIds': []}
        self.arm = {'runIds': [], 'armedAtMs': ARMED_AT}

    def test_a_genuine_post_arm_completion_is_announced_once(self):
        events = [event('r1')]
        candidates, state, report = its.admit(events, self.state, self.arm, NOW_MS, 1)
        self.assertEqual([c['runId'] for c in candidates], ['r1'])
        self.assertEqual(candidates[0]['source'], 'independent')
        self.assertEqual(candidates[0]['completedAtSource'], 'dsh.turn.completed')
        self.assertTrue(candidates[0]['postArm'])
        self.assertEqual(report['offered'], 1)

        # the same source answering again must not produce a second notice
        again, _, report2 = its.admit(events, state, self.arm, NOW_MS, 1)
        self.assertEqual(again, [])
        self.assertEqual(report2['duplicate'], 1)

    def test_a_completion_from_before_consent_becomes_history(self):
        events = [event('old', ended_at_ms=BEFORE_ARM)]
        candidates, state, report = its.admit(events, self.state, self.arm, NOW_MS, 1)
        self.assertEqual(candidates, [])
        self.assertEqual(report['history'], 1)
        self.assertIn('old', state['independentBaselineIds'])

    def test_an_event_in_the_arm_snapshot_is_history_not_a_notice(self):
        arm = {'runIds': ['r9'], 'armedAtMs': ARMED_AT}
        candidates, state, report = its.admit([event('r9')], self.state, arm, NOW_MS, 1)
        self.assertEqual(candidates, [])
        self.assertEqual(report['history'], 1)

    def test_an_undated_event_is_deferred_never_reconstructed(self):
        events = [event('r2', ended_at_ms=None)]
        candidates, state, report = its.admit(events, self.state, self.arm, NOW_MS, 1)
        self.assertEqual(candidates, [])
        self.assertEqual(report['deferred'], 1)
        self.assertEqual(state['independentDeferredIds'], ['r2'])

    def test_an_implausible_instant_is_deferred(self):
        events = [event('r3', ended_at_ms=NOW_MS + relay_merge.CLOCK_SKEW_MS + 1)]
        candidates, _, report = its.admit(events, self.state, self.arm, NOW_MS, 1)
        self.assertEqual(candidates, [])
        self.assertEqual(report['deferred'], 1)

    def test_a_run_already_journalled_by_the_relay_is_not_announced_again(self):
        state = dict(self.state, relayAckedIds=['r4|completed'])
        candidates, _, report = its.admit([event('r4')], state, self.arm, NOW_MS, 1)
        self.assertEqual(candidates, [])
        self.assertEqual(report['duplicate'], 1)

    def test_one_notice_per_run_even_across_statuses(self):
        state = dict(self.state, independentOfferedIds=['r5'])
        state['relayAckedIds'] = ['r5|completed']
        candidates, _, _ = its.admit([event('r5', status='failed')], state, self.arm, NOW_MS, 1)
        self.assertEqual(candidates, [])

    def test_the_state_file_keeps_consent_keys_untouched(self):
        self.state['relayActivatedAt'] = 123
        self.state['ackedIds'] = ['a1']
        _, state, _ = its.admit([event('r6')], self.state, self.arm, NOW_MS, 1)
        self.assertEqual(state['relayActivatedAt'], 123)
        self.assertEqual(state['ackedIds'], ['a1'])
        self.assertEqual(self.state['independentCursor'], 0, 'the input state must not be mutated in place')


class FailureTest(unittest.TestCase):
    def test_nothing_bound_is_a_named_code_not_an_empty_success(self):
        events, cursor, code = its.fetch(None, 0)
        self.assertEqual((events, code), ([], 'independent_source_unconfigured'))
        self.assertEqual(cursor, 0)

    def test_source_down_names_the_failure(self):
        source = FakeSource([], code='independent_source_unavailable')
        events, cursor, code = its.fetch(source, 5)
        self.assertEqual(events, [])
        self.assertEqual(code, 'independent_source_unavailable')
        self.assertEqual(cursor, 5)

    def test_an_unexpected_exception_is_also_a_refusal(self):
        class Exploding:
            def fetch(self, cursor, timeout=10):
                raise RuntimeError('socket closed')

        events, _, code = its.fetch(Exploding(), 3)
        self.assertEqual(events, [])
        self.assertEqual(code, 'independent_source_unavailable')

    def test_a_cursor_that_goes_backwards_is_a_replay_refusal(self):
        source = FakeSource([event('r7')], cursor=2)
        events, cursor, code = its.fetch(source, 9)
        self.assertEqual(events, [])
        self.assertEqual(code, 'independent_source_replay')
        self.assertEqual(cursor, 9, 'the cursor may not move backwards')

    def test_malformed_events_are_refused_not_half_admitted(self):
        for bad in ({'run_id': 'r8'},                                   # missing fields
                    [{'run_id': '', 'status': 'completed', 'ended_at_ms': 1,
                      'ended_at_source': 'x', 'produced_by': 'y'}],     # empty run id
                    [{'run_id': 'r8', 'status': 'maybe', 'ended_at_ms': 1,
                      'ended_at_source': 'x', 'produced_by': 'y'}]):    # unknown status
            events, _, code = its.fetch(FakeSource(bad, cursor=1), 0)
            self.assertEqual(events, [])
            self.assertEqual(code, 'independent_source_malformed', bad)

    def test_the_cursor_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            its.save_state(tmp, {'independentCursor': 41, 'independentOfferedIds': ['r1']})
            self.assertEqual(its.load_state(tmp)['independentCursor'], 41)
            source = FakeSource([], cursor=41)
            events, cursor, code = its.fetch(source, its.load_state(tmp)['independentCursor'])
            self.assertEqual((events, cursor, code), ([], 41, None))
            self.assertEqual(source.calls, [41], 'a restart must continue from the stored cursor')


if __name__ == '__main__':
    unittest.main()
