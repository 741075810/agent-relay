"""T095B80: fault injection against the real host wire, and what the doctor then says.

The suites this joins already cover the happy path well: `test_t059_terminal_wire.py`
walks baseline, one terminal, redelivery until acked, ACK idempotence, a bad payload, an
unknown id and the pending cap; `test_queue_wire_multi_consumer.py` adds two consumers;
`test_t068_running_optin.py` covers discovery and fail-closed offers. What none of them
cover is what happens when the *source* misbehaves rather than the consumer:

  * the same run recorded twice in the ledger -- a resume, a retry, or a writer that
    appended instead of replacing. Two candidates would mean two notices for one finished
    task, which is the failure this feature exists to avoid;
  * the host going away between offering a candidate and receiving the ACK. The two-phase
    ACK exists for this, and the property that matters is that recovery re-offers the
    offer rather than losing the completion;
  * a duplicated record whose copy carries a *later* timestamp, which must not look like
    a new run;
  * and then the diagnosis: after all of that, `notify_doctor` must never report a
    delivery that did not happen. A tool that says "delivered" for an offer nobody took is
    worse than no tool, because it closes the case.

Every fixture is synthetic: ids come from a counter, times from one fixed base, and no
record carries a path or a prompt. `test_t059_terminal_wire.py` explains why the native
sampler is stubbed out for the duration -- the same reasoning applies here, and it is
repeated rather than shared so one suite's isolation cannot be broken by another's edit.
"""
import io
import json
import os
import shutil
import tempfile
import unittest

import host
import protocol as P
import terminal_source
from test_t059_terminal_wire import run, uuid


def _load_doctor():
    """`tools/` is not on `sys.path` under discovery from the repository root."""
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        'notify_doctor', os.path.join(here, 'tools', 'notify_doctor.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


notify_doctor = _load_doctor()

# One fixed instant for every scenario: 2025-09-27T19:06:40Z, obviously invented.
BASE_MS = 1759000000000


class FaultScene(unittest.TestCase):
    """A real host state directory, a synthetic ledger, and nothing else."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t080-root-')
        self.state = tempfile.mkdtemp(prefix='t080-state-')
        self.sub = os.path.join(self.root, 'd' * 64)
        os.makedirs(self.sub)
        self.path = os.path.join(self.sub, 'endpoint.json.runs.json')
        self._saved_ledger = terminal_source.DEFAULT_LEDGER
        self._saved_native = terminal_source.native_turns.sample
        terminal_source.DEFAULT_LEDGER = self.root
        # Channel B off: the operator's real session logs must never become a candidate
        # while this suite runs.
        terminal_source.native_turns.sample = staticmethod(
            lambda root=None, now=None, **_kwargs: {
                'ok': True, 'code': None, 'turns': [], 'running': [],
                'runningStale': 0, 'sessions': 1, 'files': 1, 'error': None,
                'source': 'stub', 'root': root})

    def tearDown(self):
        terminal_source.native_turns.sample = self._saved_native
        terminal_source.DEFAULT_LEDGER = self._saved_ledger
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)

    # --- the source ------------------------------------------------------------
    def ledger(self, runs):
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    # --- the host --------------------------------------------------------------
    def manifest(self):
        path = os.path.join(self.state, 'host_manifest.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump({'allowed_origins':
                       ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']}, handle)
        return path

    def rpc(self, op, args=None):
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op}
        if args is not None:
            request['args'] = args
        wire = io.BytesIO(P.encode(request))
        out = io.BytesIO()
        host.serve(self.state, self.manifest(), wire, out)
        out.seek(0)
        return P.read_message(out)

    def source_state(self):
        with open(os.path.join(self.state, terminal_source.STATE_NAME),
                  encoding='utf-8') as handle:
            return json.load(handle)

    def ids_in(self, key):
        value = self.source_state().get(key) or []
        return list(value)


class DuplicateSourceRecordTest(FaultScene):
    """One finished run, recorded twice. The operator must be told once."""

    def test_a_duplicated_record_offers_the_run_once(self):
        self.ledger([run(uuid(1), 'completed')])
        self.assertTrue(self.rpc('terminal-list')['ok'])          # baseline
        # The writer appended instead of replacing.
        self.ledger([run(uuid(1), 'completed'),
                     run(uuid(2), 'completed', BASE_MS + 1000),
                     run(uuid(2), 'completed', BASE_MS + 1000)])
        offered = self.rpc('terminal-list')['result']['candidates']
        self.assertEqual([c['runId'] for c in offered], [uuid(2)])

    def test_a_duplicated_record_whose_copy_is_newer_is_still_one_run(self):
        """A later timestamp on the copy is a re-write, not a second completion."""
        self.ledger([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.ledger([run(uuid(1), 'completed'),
                     run(uuid(2), 'completed', BASE_MS + 1000),
                     run(uuid(2), 'completed', BASE_MS + 9000)])
        offered = self.rpc('terminal-list')['result']['candidates']
        self.assertEqual([c['runId'] for c in offered], [uuid(2)])

    def test_acking_a_duplicated_run_consumes_it_exactly_once(self):
        self.ledger([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.ledger([run(uuid(1), 'completed'),
                     run(uuid(2), 'completed', BASE_MS + 1000),
                     run(uuid(2), 'completed', BASE_MS + 1000)])
        self.rpc('terminal-list')
        acked = self.rpc('terminal-ack', {'acked': [uuid(2)]})['result']
        self.assertEqual(acked['acked'], 1)
        self.assertEqual(acked['pending'], 0)

        state = self.source_state()
        self.assertEqual(sorted(self.ids_in('ackedIds')).count(uuid(2)), 1,
                         'one run, one journal entry: %r' % (state,))
        self.assertEqual(self.ids_in('pendingIds'), [])
        # And the duplicated record still on disk changes nothing.
        self.assertEqual(self.rpc('terminal-list')['result']['candidates'], [])


class ColdStartRecoveryTest(FaultScene):
    """The host process stops between offering and acking.

    Every `serve` call here is a new process in the real world, so nothing is allowed to
    live only in memory: the offer has to be recoverable from the state directory.
    """

    def test_an_offer_survives_a_cold_start_and_is_not_duplicated(self):
        self.ledger([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.ledger([run(uuid(1), 'completed'),
                     run(uuid(2), 'completed', BASE_MS + 1000)])
        first = self.rpc('terminal-list')['result']
        self.assertEqual([c['runId'] for c in first['candidates']], [uuid(2)])
        self.assertEqual(self.ids_in('pendingIds'), [uuid(2)])

        # A different host process, same directory. `redelivered` must be counted, and
        # the candidate set must be identical rather than doubled.
        second = self.rpc('terminal-list')['result']
        self.assertEqual([c['runId'] for c in second['candidates']], [uuid(2)])
        self.assertEqual(second['redelivered'], 1)
        self.assertEqual(self.ids_in('pendingIds'), [uuid(2)])

        self.rpc('terminal-ack', {'acked': [uuid(2)]})
        self.assertEqual(self.ids_in('pendingIds'), [])
        self.assertEqual(self.rpc('terminal-list')['result']['candidates'], [])

    def test_a_lost_ack_does_not_turn_into_a_second_journal_entry(self):
        """The ACK never arrives, so the offer repeats. Repeated offers are not repeated
        notices: the journal is what the extension saves, and it stays at one."""
        self.ledger([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.ledger([run(uuid(1), 'completed'),
                     run(uuid(2), 'completed', BASE_MS + 1000)])
        for _ in range(3):
            self.assertEqual([c['runId'] for c in
                              self.rpc('terminal-list')['result']['candidates']],
                             [uuid(2)])
        acked = self.rpc('terminal-ack', {'acked': [uuid(2)]})['result']
        self.assertEqual(acked['acked'], 1)
        self.assertEqual(sorted(self.ids_in('ackedIds')).count(uuid(2)), 1)
        # An ACK for something already consumed is a no-op, not a second entry.
        self.assertEqual(self.rpc('terminal-ack', {'acked': [uuid(2)]})['result']['acked'], 0)
        self.assertEqual(sorted(self.ids_in('ackedIds')).count(uuid(2)), 1)


class DoctorAgreesWithTheFaultsTest(FaultScene):
    """The diagnosis of the artifacts the faults produced.

    This is the causal half: the tool is not asked what it thinks in general, it is asked
    about a state directory whose history is known exactly -- one run offered, three
    times, never acknowledged.
    """

    def test_an_offer_nobody_took_is_never_reported_as_delivered(self):
        self.ledger([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.ledger([run(uuid(1), 'completed'),
                     run(uuid(2), 'completed', BASE_MS + 1000)])
        for _ in range(3):
            self.rpc('terminal-list')

        report = notify_doctor.diagnose(self.state, now_ms=BASE_MS + 60000)
        stats = notify_doctor.stats_only(report)
        self.assertNotEqual(stats['primary'], 'delivered')
        self.assertEqual(stats['delivery'], 'nothing_deliverable')
        self.assertEqual(stats['stages']['source']['pending'], 1,
                         'the doctor must see the untaken offer: %r' % (stats,))

    def test_the_stats_form_carries_no_run_id_and_no_path(self):
        self.ledger([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.ledger([run(uuid(1), 'completed'),
                     run(uuid(2), 'completed', BASE_MS + 1000)])
        self.rpc('terminal-list')
        text = json.dumps(notify_doctor.stats_only(
            notify_doctor.diagnose(self.state, now_ms=BASE_MS + 60000)),
            ensure_ascii=False)
        for secret in (uuid(1), uuid(2), 'sess-1', 'secret-project',
                       self.state, self.root):
            self.assertNotIn(secret, text, 'the stats form leaked %r' % (secret,))

    def test_a_consumed_run_leaves_the_doctor_nothing_to_explain(self):
        self.ledger([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.ledger([run(uuid(1), 'completed'),
                     run(uuid(2), 'completed', BASE_MS + 1000)])
        self.rpc('terminal-list')
        self.rpc('terminal-ack', {'acked': [uuid(2)]})
        stats = notify_doctor.stats_only(
            notify_doctor.diagnose(self.state, now_ms=BASE_MS + 60000))
        self.assertEqual(stats['stages']['source']['pending'], 0)
        self.assertNotEqual(stats['primary'], 'delivered')


if __name__ == '__main__':
    unittest.main()
