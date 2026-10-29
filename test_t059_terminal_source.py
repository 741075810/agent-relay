"""T059 integration tests: the `terminal-list` host op over a synthetic ledger.

These exercise the real `terminal_source` module and the real `handle_request`
dispatch, with a fake ledger written into a temporary directory in the *same
layout the real one uses* -- a hash-named subdirectory. The layout is the point:
an earlier version joined the file name to the root and reported
`source_unavailable` while the ledger sat one directory down, and a test with a
file at the root would have hidden that.
"""
import json
import os
import shutil
import tempfile
import unittest

import host
import protocol as P
import terminal_source


def run(run_id, status, created_ms=1759000000000, **extra):
    doc = {
        'requestID': run_id,
        'status': status,
        'createdAt': created_ms,
        'sessionID': 'sess-1',
        'projectPath': r'E:\projects\secret-project',
        'turn': 3,
        'events': [{'eventType': 'failed', 'data': {'reason': 'boom'}}],
    }
    doc.update(extra)
    return doc


def uuid(n):
    return '00000000-0000-4000-8000-%012d' % n


class LedgerTestCase(unittest.TestCase):
    """Builds `<tmp>/<hash>/endpoint.json.runs.json`, exactly like the real one."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t059-root-')
        self.state = tempfile.mkdtemp(prefix='t059-state-')
        self.sub = os.path.join(self.root, 'a' * 64)
        os.makedirs(self.sub)
        self.path = os.path.join(self.sub, 'endpoint.json.runs.json')
        # Hermetic: `sample(state_dir)` falls back to the module default, so
        # without this every host-op test would read the user's real 18 MB
        # ledger. Tests must not depend on it -- and must not read it.
        self._saved_root = terminal_source.DEFAULT_LEDGER
        terminal_source.DEFAULT_LEDGER = self.root
        # T067R: same reasoning for the second source. `native_turns.sample()`
        # defaults to the operator's live ~/.dsh/sessions, and a suite that means to
        # test channel A must not quietly pick up channel-B turns from it. This
        # suite is about the ledger, so the native reader is switched off for its
        # duration; test_t067_native_origin.py exercises it against real fixtures.
        self._saved_native = terminal_source.native_turns.sample
        terminal_source.native_turns.sample = staticmethod(
            lambda *args, **kwargs: {'ok': False, 'code': 'native_disabled_in_test',
                                     'turns': [], 'files': 0, 'sessions': 0,
                                     'error': None})

    def tearDown(self):
        terminal_source.DEFAULT_LEDGER = self._saved_root
        terminal_source.native_turns.sample = self._saved_native
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)

    def write(self, runs):
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)


class DiscoveryTests(LedgerTestCase):

    def test_the_ledger_is_found_one_directory_down(self):
        self.write([run(uuid(1), 'completed')])
        self.assertEqual(terminal_source.ledger_paths(self.root), [self.path])
        self.assertEqual(terminal_source.ledger_path(self.root), self.path)

    def test_a_root_that_is_itself_a_ledger_is_accepted(self):
        self.write([run(uuid(1), 'completed')])
        self.assertEqual(terminal_source.ledger_path(self.path), self.path)

    def test_a_missing_root_is_named_not_guessed(self):
        with self.assertRaises(terminal_source.SourceError) as caught:
            terminal_source.ledger_path(os.path.join(self.root, 'nope'))
        self.assertIn('not a directory', str(caught.exception))

    def test_an_empty_root_says_there_is_no_ledger(self):
        with self.assertRaises(terminal_source.SourceError) as caught:
            terminal_source.ledger_path(self.root)
        self.assertIn('no *', str(caught.exception))

    def test_two_ledgers_are_refused_rather_than_ordered(self):
        self.write([run(uuid(1), 'completed')])
        other = os.path.join(self.root, 'b' * 64)
        os.makedirs(other)
        shutil.copy(self.path, os.path.join(other, 'endpoint.json.runs.json'))
        with self.assertRaises(terminal_source.SourceError) as caught:
            terminal_source.ledger_path(self.root)
        self.assertIn('refusing to guess', str(caught.exception))


class BaselineTests(LedgerTestCase):

    def test_the_first_sample_only_establishes_a_baseline(self):
        self.write([run(uuid(1), 'completed'), run(uuid(2), 'failed')])
        report = terminal_source.sample(self.state, self.root)
        self.assertTrue(report['ok'])
        self.assertTrue(report['baselineEstablished'])
        self.assertEqual(report['candidates'], [])
        self.assertEqual(report['existingTerminalRuns'], 2)

    def test_history_does_not_fire_and_then_a_new_terminal_fires_once(self):
        self.write([run(uuid(1), 'completed'), run(uuid(2), 'completed')])
        terminal_source.sample(self.state, self.root)          # baseline only

        self.write([run(uuid(1), 'completed'), run(uuid(2), 'completed'),
                    run(uuid(3), 'completed', 1759000600000)])
        second = terminal_source.sample(self.state, self.root)
        self.assertEqual([c['runId'] for c in second['candidates']], [uuid(3)])
        self.assertIs(second['confirmed'], False,
                      'an offer is not a delivery')

        # Not acked yet: the offer stands, because "handed out" and "stored by
        # the caller" are different facts and only the second one is known to
        # the caller.
        third = terminal_source.sample(self.state, self.root)
        self.assertEqual([c['runId'] for c in third['candidates']], [uuid(3)])
        self.assertEqual(third['redelivered'], 1)

        # Once acknowledged, it is gone for good.
        terminal_source.acknowledge(self.state, [uuid(3)])
        fourth = terminal_source.sample(self.state, self.root)
        self.assertEqual(fourth['candidates'], [],
                         'an acknowledged terminal state must not fire again')

    def test_a_late_finishing_old_run_is_still_reported(self):
        # Started hours ago, finished after the baseline: an id-set baseline
        # keeps it, a createdAt watermark would have dropped it.
        self.write([run(uuid(1), 'completed', 1759000000000)])
        terminal_source.sample(self.state, self.root)
        self.write([run(uuid(1), 'completed', 1759000000000),
                    run(uuid(2), 'completed', 1758000000000)])
        second = terminal_source.sample(self.state, self.root)
        self.assertEqual([c['runId'] for c in second['candidates']], [uuid(2)])

    def test_a_running_task_is_not_a_candidate(self):
        self.write([run(uuid(1), 'completed')])
        terminal_source.sample(self.state, self.root)
        self.write([run(uuid(1), 'completed'), run(uuid(2), 'running')])
        second = terminal_source.sample(self.state, self.root)
        self.assertEqual(second['candidates'], [])

    def test_statuses_are_mapped_to_the_three_the_trigger_accepts(self):
        self.write([run(uuid(1), 'completed')])
        terminal_source.sample(self.state, self.root)
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'failed', 1759000600000),
                    run(uuid(3), 'cancelled', 1759001200000),
                    run(uuid(4), 'interrupted', 1759001800000)])
        second = terminal_source.sample(self.state, self.root)
        self.assertEqual(sorted((c['runId'], c['status'])
                                for c in second['candidates']),
                         sorted([(uuid(2), 'failed'), (uuid(3), 'cancelled'),
                                 # T067R: an interrupted run is a failure. The
                                 # ledger's own `cancelled` is the event stream
                                 # ending, not the operator stopping the task.
                                 (uuid(4), 'failed')]))

    def test_candidates_carry_a_limited_identifier_set_only(self):
        self.write([run(uuid(1), 'completed')])
        terminal_source.sample(self.state, self.root)
        self.write([run(uuid(1), 'completed'), run(uuid(2), 'completed', 1759000600000)])
        second = terminal_source.sample(self.state, self.root)
        candidate = second['candidates'][0]
        # T091 added `postArm`: a boolean verdict against the arm snapshot, not an
        # identifier. It carries no run data and must not grow into one.
        # T067 added `origin`: a three-valued channel verdict ('bridge' | 'direct'
        # | 'unknown'), also not an identifier. The list stays small on purpose --
        # every field added here is a field that crosses into Chrome and is stored
        # next to the candidate forever.
        self.assertEqual(sorted(candidate.keys()),
                         ['origin', 'postArm', 'runId', 'startedAt', 'status'])
        self.assertIsInstance(candidate['postArm'], (bool, type(None)))
        self.assertIn(candidate['origin'], ('bridge', 'direct', 'unknown'))
        blob = json.dumps(second)
        self.assertNotIn('secret-project', blob)
        self.assertNotIn('sess-1', blob)

    def test_a_broken_ledger_is_refused_not_summarised(self):
        self.write([{'status': 'completed'}])
        report = terminal_source.sample(self.state, self.root)
        self.assertFalse(report['ok'])
        self.assertEqual(report['code'], 'source_unavailable')
        self.assertIn('requestID', report['error'])

    def test_the_report_always_says_unverified_and_undeliverable(self):
        self.write([run(uuid(1), 'completed')])
        report = terminal_source.sample(self.state, self.root)
        self.assertEqual(report['provenance'], 'unverified')
        self.assertIs(report['deliverable'], False)


class HostOpTests(LedgerTestCase):

    def request(self, op, ident='r1'):
        return host.handle_request(self.state,
                                   {'v': P.PROTOCOL_VERSION, 'id': ident, 'op': op})

    def test_terminal_list_is_an_accepted_op(self):
        self.assertIn('terminal-list', P.OPS)

    def test_the_op_establishes_a_baseline_then_returns_new_terminals(self):
        self.write([run(uuid(1), 'completed')])
        first = self.request('terminal-list')
        self.assertTrue(first['ok'])
        self.assertTrue(first['result']['baselineEstablished'])
        self.assertEqual(first['result']['candidates'], [])

        self.write([run(uuid(1), 'completed'), run(uuid(2), 'completed', 1759000600000)])
        second = self.request('terminal-list')
        self.assertEqual([c['runId'] for c in second['result']['candidates']],
                         [uuid(2)])

    def test_the_op_does_not_touch_the_notification_queue(self):
        # The queue is deliverable:false by construction; the candidate query
        # must leave it byte-identical.
        host.append_events(self.state, host.simulated_events(2, 1))
        queue_file = os.path.join(self.state, 'queue.json')
        with open(queue_file, 'rb') as handle:
            before = handle.read()

        self.write([run(uuid(1), 'completed')])
        self.request('terminal-list')
        self.request('terminal-list')

        with open(queue_file, 'rb') as handle:
            after = handle.read()
        self.assertEqual(before, after, 'queue.json changed')

        polled = self.request('poll')
        self.assertEqual(len(polled['result']['events']), 2)
        for event in polled['result']['events']:
            self.assertIs(event['deliverable'], False)

    def test_an_unreadable_source_is_reported_as_a_gap(self):
        saved = terminal_source.DEFAULT_LEDGER
        terminal_source.DEFAULT_LEDGER = os.path.join(self.root, 'missing')
        try:
            reply = self.request('terminal-list')
        finally:
            terminal_source.DEFAULT_LEDGER = saved
        # A protocol-level success carrying a named source gap: "the source is
        # not there" must not be indistinguishable from "nothing is new".
        self.assertTrue(reply['ok'])
        self.assertFalse(reply['result']['ok'])
        self.assertEqual(reply['result']['code'], 'source_unavailable')
        self.assertEqual(reply['result']['candidates'], [])


class BaselineIsFixedTests(LedgerTestCase):
    """The baseline is recorded once and never re-anchored.

    It used to be recomputed on every sample and written back, which made the
    baseline swallow anything the previous answer had not delivered: the second
    sample then treated the whole ledger as "already seen". The visible symptom was
    a hard ceiling -- at most `MAX_CANDIDATES` notices per session, and a task that
    finished while another candidate was still pending never notified at all.
    """

    def test_a_later_completion_is_still_a_candidate(self):
        self.write([])
        first = terminal_source.sample(self.state)
        self.assertTrue(first['baselineEstablished'])
        self.assertEqual(first['candidates'], [])

        self.write([run(uuid(1), 'completed')])
        second = terminal_source.sample(self.state)
        self.assertEqual([item['runId'] for item in second['candidates']], [uuid(1)])
        terminal_source.acknowledge(self.state, [uuid(1)])

        # The delivered run must not re-anchor the baseline onto itself.
        self.write([run(uuid(1), 'completed'), run(uuid(2), 'failed')])
        third = terminal_source.sample(self.state)
        self.assertEqual([item['runId'] for item in third['candidates']], [uuid(2)])

    def test_every_completion_is_eventually_delivered(self):
        self.write([])
        terminal_source.sample(self.state)
        # More than one answer can carry, so several samples are required.
        count = terminal_source.MAX_CANDIDATES + 5
        self.write([run(uuid(n), 'completed') for n in range(count)])

        delivered = []
        for _ in range(6):
            report = terminal_source.sample(self.state)
            ids = [item['runId'] for item in report['candidates']]
            self.assertLessEqual(len(ids), terminal_source.MAX_CANDIDATES)
            delivered.extend(ids)
            if ids:
                terminal_source.acknowledge(self.state, ids)
            if not ids:
                break
        self.assertEqual(len(delivered), count)
        self.assertEqual(len(set(delivered)), count)

    def test_an_unacknowledged_candidate_blocks_then_frees_room(self):
        self.write([])
        terminal_source.sample(self.state)
        self.write([run(uuid(n), 'completed') for n in range(25)])
        first = terminal_source.sample(self.state)
        self.assertEqual(len(first['candidates']), terminal_source.MAX_CANDIDATES)
        # No ACK: these stay pending and are re-offered, taking all the room.
        again = terminal_source.sample(self.state)
        self.assertEqual(len(again['candidates']), terminal_source.MAX_CANDIDATES)
        self.assertEqual(again['redelivered'], terminal_source.MAX_CANDIDATES)
        # Acknowledging frees the room for the remainder.
        terminal_source.acknowledge(
            self.state, [item['runId'] for item in again['candidates']])
        rest = terminal_source.sample(self.state)
        self.assertEqual(len(rest['candidates']), 5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
