"""T059: real Host RPC over a synthetic ledger, plus the two-phase ACK.

Unlike the unit tests, these drive the wire format itself: a JSON request is
encoded, written to a pipe-shaped stream, and decoded by the real `host.serve`
loop. That is the layer where "the extension asked and got a well-formed answer"
is actually decided, and it is where an unwrapping mistake is fatal rather than
merely awkward.

Covered here: baseline, a new terminal, cancel/fail mapping, single-delivery,
redelivery after an unacknowledged answer, ACK idempotence, refusing to consume
something never handed out, and the queue staying byte-identical.

Every test is hermetic: the ledger root is a temp directory in the real
`<root>/<hash>/endpoint.json.runs.json` layout, and the module default is
patched so nothing reads the user's live 18 MB ledger.
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


def uuid(n):
    return '00000000-0000-4000-8000-%012d' % n


def run(run_id, status, created_ms=1759000000000, **extra):
    doc = {'requestID': run_id, 'status': status, 'createdAt': created_ms,
           'sessionID': 'sess-1', 'projectPath': r'E:\projects\secret-project'}
    doc.update(extra)
    return doc


class WireTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t059w-root-')
        self.state = tempfile.mkdtemp(prefix='t059w-state-')
        self.sub = os.path.join(self.root, 'c' * 64)
        os.makedirs(self.sub)
        self.path = os.path.join(self.sub, 'endpoint.json.runs.json')
        self._saved = terminal_source.DEFAULT_LEDGER
        terminal_source.DEFAULT_LEDGER = self.root
        # T068: `native_turns.sample()` defaults to the operator's live
        # `~/.dsh/sessions`. Without this, a real turn *ending* while this suite runs
        # becomes a channel-B candidate and appears in `terminal-list`, so an assertion
        # about exactly which runs are offered fails intermittently -- observed once in
        # a full-suite run, on `..._unacked_offer_is_repeated...`, and never in
        # isolation. This suite is about the wire format for channel A, so the second
        # source is switched off for its duration; test_t067_native_origin and
        # test_t068_running_optin exercise it against real fixtures instead.
        self._saved_native = terminal_source.native_turns.sample
        terminal_source.native_turns.sample = staticmethod(
            lambda root=None, now=None, **_kwargs: {
                'ok': True, 'code': None, 'turns': [], 'running': [],
                'runningStale': 0, 'sessions': 1, 'files': 1, 'error': None,
                'source': 'stub', 'root': root})

    def tearDown(self):
        terminal_source.native_turns.sample = self._saved_native
        terminal_source.DEFAULT_LEDGER = self._saved
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)

    def write(self, runs):
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def rpc(self, op, args=None):
        """One real round trip through the host's serve loop."""
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op}
        if args is not None:
            request['args'] = args
        wire = io.BytesIO(P.encode(request))
        out = io.BytesIO()
        host.serve(self.state, self.manifest(), wire, out)
        out.seek(0)
        return P.read_message(out)

    def manifest(self):
        # A synthetic id, not this machine's: the manifest here is a fixture, and an
        # unpacked extension's real id encodes its load path, so publishing one would
        # be publishing local configuration that means nothing anywhere else.
        path = os.path.join(self.state, 'host_manifest.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump({'allowed_origins':
                       ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']},
                      handle)
        return path

    def test_baseline_over_the_wire_then_one_new_terminal(self):
        self.write([run(uuid(1), 'completed'), run(uuid(2), 'failed')])
        first = self.rpc('terminal-list')
        self.assertTrue(first['ok'])
        result = first['result']
        self.assertTrue(result['baselineEstablished'])
        self.assertEqual(result['candidates'], [])
        self.assertIs(result['requiresAck'], True)
        self.assertIs(result['confirmed'], False)
        self.assertIs(result['deliverable'], False)
        self.assertEqual(result['provenance'], 'unverified')

        self.write([run(uuid(1), 'completed'), run(uuid(2), 'failed'),
                    run(uuid(3), 'cancelled', 1759000900000)])
        second = self.rpc('terminal-list')
        self.assertEqual([(c['runId'], c['status']) for c in second['result']['candidates']],
                         [(uuid(3), 'cancelled')])

    def test_a_successful_answer_is_re_offered_until_acked(self):
        self.write([run(uuid(1), 'completed')])
        self.rpc('terminal-list')                      # baseline
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'completed', 1759000600000)])
        first = self.rpc('terminal-list')
        self.assertEqual([c['runId'] for c in first['result']['candidates']],
                         [uuid(2)])
        # The extension crashed / disconnected before saving: the same run must
        # come back rather than vanish.
        again = self.rpc('terminal-list')
        self.assertEqual([c['runId'] for c in again['result']['candidates']],
                         [uuid(2)])
        self.assertEqual(again['result']['redelivered'], 1)

    def test_ack_consumes_and_is_idempotent(self):
        self.write([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'completed', 1759000600000)])
        self.rpc('terminal-list')

        acked = self.rpc('terminal-ack', {'acked': [uuid(2)]})
        self.assertEqual(acked['result']['acked'], 1)
        self.assertEqual(acked['result']['pending'], 0)

        after = self.rpc('terminal-list')
        self.assertEqual(after['result']['candidates'], [],
                         'an acknowledged run is never offered again')

        twice = self.rpc('terminal-ack', {'acked': [uuid(2)]})
        self.assertEqual(twice['result']['acked'], 0, 'acking twice is a no-op')

    def test_ack_refuses_something_never_handed_out(self):
        self.write([run(uuid(1), 'completed')])
        self.rpc('terminal-list')                      # baseline only
        reply = self.rpc('terminal-ack', {'acked': [uuid(99)]})
        self.assertEqual(reply['result']['acked'], 0)
        # And the live run is still not consumed by that mistake.
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'completed', 1759000600000)])
        offered = self.rpc('terminal-list')
        self.assertEqual([c['runId'] for c in offered['result']['candidates']],
                         [uuid(2)])

    def test_a_bad_ack_payload_is_an_error_not_a_crash(self):
        reply = self.rpc('terminal-ack', {'acked': 'nope'})
        self.assertFalse(reply['ok'])
        self.assertEqual(reply['error']['code'], P.E_BAD_REQUEST)
        self.assertIn('list of run ids', reply['error']['message'])
        self.assertTrue(self.rpc('status')['ok'], 'the host still answers after it')

    def test_the_queue_stays_untouched_across_the_whole_flow(self):
        host.append_events(self.state, host.simulated_events(2, 1))
        queue_file = os.path.join(self.state, 'queue.json')
        with open(queue_file, 'rb') as handle:
            before = handle.read()

        self.write([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'failed', 1759000700000)])
        self.rpc('terminal-list')
        self.rpc('terminal-ack', {'acked': [uuid(2)]})

        with open(queue_file, 'rb') as handle:
            after = handle.read()
        self.assertEqual(before, after, 'queue.json changed')

        polled = self.rpc('poll')
        self.assertEqual(len(polled['result']['events']), 2)
        for event in polled['result']['events']:
            self.assertIs(event['deliverable'], False)

    def test_an_unreadable_source_keeps_the_pending_list_intact(self):
        # Baseline, then offer, then break the source: pending must survive so
        # the completion is not lost while the ledger is temporarily unreadable.
        self.write([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'completed', 1759000600000)])
        self.rpc('terminal-list')

        # Move the ledger file away rather than renaming its directory: the
        # directory rename still leaves a *.runs.json reachable under the root
        # only if the walk finds it, and a same-named copy would make this test
        # pass for the wrong reason.
        os.rename(self.path, self.path + '.away')
        broken = self.rpc('terminal-list')
        self.assertFalse(broken['result']['ok'])
        self.assertEqual(broken['result']['code'], 'source_unavailable')
        self.assertEqual(broken['result']['candidates'], [])

        os.rename(self.path + '.away', self.path)
        recovered = self.rpc('terminal-list')
        self.assertEqual([c['runId'] for c in recovered['result']['candidates']],
                         [uuid(2)], 'the pending offer survived the outage')


    def test_an_unacked_offer_is_repeated_until_the_ack_arrives(self):
        """The Chrome side may answer, save, then fail to ACK.

        The host must keep offering the same run every time until it hears an
        ACK, and must not lose it in between. Three offers, then the ACK.
        """
        self.write([run(uuid(1), 'completed')])
        self.rpc('terminal-list')                       # baseline
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'completed', 1759000600000)])

        offers = []
        for _ in range(3):
            reply = self.rpc('terminal-list')
            offers.append([c['runId'] for c in reply['result']['candidates']])
        self.assertEqual(offers, [[uuid(2)], [uuid(2)], [uuid(2)]],
                         'the same offer is repeated until acknowledged')
        self.assertTrue(self.rpc('terminal-list')['result']['requiresAck'])

        self.assertEqual(self.rpc('terminal-ack',
                                  {'acked': [uuid(2)]})['result']['acked'], 1)
        self.assertEqual(
            self.rpc('terminal-list')['result']['candidates'], [],
            'and it stops once acknowledged')

    def test_a_lost_ack_does_not_reorder_or_drop_the_pending_set(self):
        self.write([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'completed', 1759000600000),
                    run(uuid(3), 'failed', 1759000700000)])
        first = self.rpc('terminal-list')['result']['candidates']
        self.assertEqual([c['runId'] for c in first], [uuid(2), uuid(3)])

        # Acknowledge only the first; the second must survive untouched.
        self.rpc('terminal-ack', {'acked': [uuid(2)]})
        second = self.rpc('terminal-list')['result']['candidates']
        self.assertEqual([c['runId'] for c in second], [uuid(3)])

    def test_pending_survives_a_restart_of_the_sampler(self):
        # Nothing in the state file is in-memory: a fresh process re-reads the
        # pending list and offers the same run again.
        self.write([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.write([run(uuid(1), 'completed'),
                    run(uuid(2), 'completed', 1759000600000)])
        self.rpc('terminal-list')
        on_disk = terminal_source.load_state(self.state)
        self.assertEqual(on_disk['pendingIds'], [uuid(2)])
        self.assertEqual(on_disk['ackedIds'], [])
        again = self.rpc('terminal-list')['result']['candidates']
        self.assertEqual([c['runId'] for c in again], [uuid(2)])


class PendingCapacityTests(unittest.TestCase):
    """The pending list is bounded; say what the bound costs."""

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t059cap-')

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)

    def test_the_pending_cap_is_documented_and_applied(self):
        self.assertEqual(terminal_source.MAX_STATE_IDS, 5000)
        self.assertEqual(terminal_source.MAX_CANDIDATES, 20)
        # One answer never exceeds the per-answer bound, so a single round can
        # always be fully acknowledged by the caller.
        runs = [run(uuid(n), 'completed', 1759000000000 + n) for n in range(60)]
        terminal_source.save_state(self.state, {
            'version': terminal_source.STATE_VERSION, 'baselineIds': [],
            'pendingIds': [], 'ackedIds': [],
        })
        due, nxt, info = terminal_source.candidates_from(runs, terminal_source.load_state(self.state))
        self.assertEqual(len(due), terminal_source.MAX_CANDIDATES)
        self.assertEqual(info['baselineEstablished'], False)
        self.assertLessEqual(len(nxt['pendingIds']), terminal_source.MAX_STATE_IDS)


if __name__ == '__main__':
    unittest.main(verbosity=2)
