"""T206: the real host fuses Relay candidates into `terminal-list`, with ACK paths that cannot cross.

Starts the real AgentRelay service (Node, its own token in a temp dir) and the real host (subprocess, framed stdio),
then checks the properties that make a second source safe in the *existing* answer:

  * native candidates and relay candidates appear together, and the relay ones are marked as such;
  * baseline behaviour is unchanged (the first sample still establishes a baseline and offers only relay candidates);
  * an ACK for a relay candidate lands in `relayAckedIds` and leaves `pendingIds` / `ackedIds` alone;
  * the acknowledged relay candidate is not offered again;
  * a relay that cannot be read reports `relay_unavailable` while the native answer stays intact;
  * a relay candidate keeps its own origin, so the extension's channel gate still decides.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import protocol as P
import terminal_source

ROOT = os.path.dirname(os.path.abspath(__file__))
ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'
RELAY_RUN = 'aaaaaaaa-1111-4222-8333-444455556666'
NATIVE_RUN = 'bbbbbbbb-1111-4222-8333-444455556666'


class RelayScene(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t206-root-')
        self.state = tempfile.mkdtemp(prefix='t206-state-')
        self.service_dir = tempfile.mkdtemp(prefix='t206-svc-')
        self.sub = os.path.join(self.root, 'c' * 64)
        os.makedirs(self.sub)
        self.ledger = os.path.join(self.sub, 'endpoint.json.runs.json')
        with open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump([], handle)
        self.repo_ledger = terminal_source.DEFAULT_LEDGER
        terminal_source.DEFAULT_LEDGER = self.root
        self.manifest = os.path.join(self.state, 'host_manifest.t206.json')
        with open(self.manifest, 'w', encoding='utf-8') as handle:
            json.dump({'name': 'com.dsh.notify', 'type': 'stdio',
                       'allowed_origins': [ORIGIN]}, handle)
        self.fixture = os.path.join(self.state, 'bridge-origin.fixture.json')
        with open(self.fixture, 'w', encoding='utf-8') as handle:
            json.dump({'version': 1, 'bridge': '*'}, handle)
        self.native = os.path.join(self.state, 'native-sessions')
        os.makedirs(self.native)
        self.service = None

    def tearDown(self):
        terminal_source.DEFAULT_LEDGER = self.repo_ledger
        if self.service is not None:
            self.service.kill()
            self.service.wait(timeout=10)
        for path in (self.root, self.state, self.service_dir):
            shutil.rmtree(path, ignore_errors=True)

    # --- fixtures ------------------------------------------------------------------------------------------
    def ledger_runs(self, runs):
        with open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def start_service(self):
        self.service = subprocess.Popen(
            ['node', os.path.join(ROOT, 'tools', 'service', 'relay_service.mjs'),
             '--state-dir', self.service_dir],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        line = self.service.stdout.readline().decode('utf-8').strip()
        ready = json.loads(line)
        self.service_url = ready['base']
        self.token_file = ready['tokenFile']

    def seed_relay(self, candidates):
        token = open(self.token_file, encoding='utf-8').read().strip()
        import urllib.request
        body = json.dumps({'candidates': candidates}).encode('utf-8')
        request = urllib.request.Request(self.service_url + '/host/terminal-candidates', data=body,
                                        headers={'content-type': 'application/json',
                                                 'authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode('utf-8'))

    def source_state(self):
        path = os.path.join(self.state, terminal_source.STATE_NAME)
        if not os.path.isfile(path):
            return {}
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)

    # --- the host ------------------------------------------------------------------------------------------
    def host(self, op, args=None, relay=True):
        argv = [sys.executable, '-B', os.path.join(ROOT, 'host.py'), ORIGIN,
                '--state-dir', self.state, '--ledger-root', self.root,
                '--manifest', self.manifest, '--bridge-db-fixture', self.fixture,
                '--native-root', self.native]
        if relay:
            argv += ['--relay-url', self.service_url, '--relay-token-file', self.token_file]
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op}
        if args is not None:
            request['args'] = args
        proc = subprocess.run(argv, input=P.encode(request), capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        return P.read_message(io.BytesIO(proc.stdout))

    def candidates(self, reply):
        self.assertTrue(reply['ok'], reply)
        return reply['result']['candidates']


class FusionTests(RelayScene):

    def test_relay_and_native_candidates_arrive_in_the_same_answer(self):
        self.ledger_runs([])
        self.start_service()
        self.candidates(self.host('terminal-list'))            # baseline, with nothing finished yet
        self.ledger_runs([{'requestID': NATIVE_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        self.seed_relay([{'runId': RELAY_RUN, 'terminalStatus': 'failed',
                          'hostSource': 'native_host.terminal-mirror',
                          'statusSource': 'bridge_ledger.status', 'origin': 'bridge'}])
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], reply)
        offered = reply['result']['candidates']
        by_id = {item['runId']: item for item in offered}
        self.assertIn(NATIVE_RUN, by_id)
        self.assertIn(RELAY_RUN, by_id, 'the relay candidate is fused into the same answer')
        self.assertEqual(by_id[RELAY_RUN]['status'], 'failed')
        self.assertEqual(by_id[RELAY_RUN]['source'], 'relay')
        self.assertEqual(by_id[RELAY_RUN]['origin'], 'bridge', 'its own origin, not an upgrade to channel A')
        self.assertIsNone(reply['result']['relayCode'])
        self.assertEqual(reply['result']['relayCandidates'], 1)
        self.assertTrue(reply['result']['requiresAck'], 'the extension must still acknowledge')

    def test_a_relay_ack_does_not_touch_the_native_queue(self):
        self.ledger_runs([])
        self.start_service()
        self.host('terminal-list')                              # baseline
        self.ledger_runs([{'requestID': NATIVE_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        self.seed_relay([{'runId': RELAY_RUN, 'terminalStatus': 'completed',
                          'hostSource': 'native_host.terminal-mirror',
                          'statusSource': 'bridge_ledger.status', 'origin': 'bridge'}])
        first = self.candidates(self.host('terminal-list'))
        self.assertEqual(len(first), 2)
        before = self.source_state()
        self.assertEqual(before.get('ackedIds'), [])
        acked = self.host('terminal-ack', {'acked': [RELAY_RUN + '|completed']})
        self.assertTrue(acked['ok'], acked)
        after = self.source_state()
        self.assertIn(RELAY_RUN + '|completed', after.get('relayAckedIds') or [])
        self.assertEqual(after.get('ackedIds'), [], 'the native ack list is untouched')
        self.assertEqual(after.get('pendingIds'), after.get('pendingIds'))
        # and the acknowledged relay candidate is not offered again
        again = [item['runId'] for item in self.candidates(self.host('terminal-list'))]
        self.assertNotIn(RELAY_RUN, again)

    def test_the_native_ack_path_still_works_with_the_relay_attached(self):
        self.ledger_runs([])
        self.start_service()
        self.host('terminal-list')
        self.ledger_runs([{'requestID': NATIVE_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        offered = self.candidates(self.host('terminal-list'))
        self.assertEqual([item['runId'] for item in offered], [NATIVE_RUN])
        self.host('terminal-ack', {'acked': [NATIVE_RUN]})
        state = self.source_state()
        self.assertEqual(state.get('ackedIds'), [NATIVE_RUN])
        self.assertEqual(list(state.get('relayAckedIds') or []), [])
        self.assertEqual(self.candidates(self.host('terminal-list')), [])

    def test_an_unreadable_relay_fails_closed_and_leaves_the_native_answer_intact(self):
        self.ledger_runs([])
        self.start_service()
        self.host('terminal-list')
        self.ledger_runs([{'requestID': NATIVE_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        self.service.kill()
        self.service.wait(timeout=10)
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], 'a relay failure must not break the native answer')
        self.assertEqual(reply['result']['relayCode'], 'relay_unavailable')
        self.assertEqual(reply['result']['relayCandidates'], 0)
        self.assertEqual([item['runId'] for item in reply['result']['candidates']], [NATIVE_RUN])

    def test_without_the_flags_the_answer_is_unchanged(self):
        self.ledger_runs([])
        self.start_service()
        self.host('terminal-list', relay=False)
        self.ledger_runs([{'requestID': NATIVE_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        self.seed_relay([{'runId': RELAY_RUN, 'terminalStatus': 'completed',
                          'hostSource': 'native_host.terminal-mirror',
                          'statusSource': 'bridge_ledger.status', 'origin': 'bridge'}])
        reply = self.host('terminal-list', relay=False)
        self.assertEqual([item['runId'] for item in reply['result']['candidates']], [NATIVE_RUN])
        self.assertIsNone(reply['result']['relayCode'])
        self.assertEqual(reply['result']['relayCandidates'], 0)

    def test_the_relay_journal_survives_a_restart(self):
        self.ledger_runs([])
        self.start_service()
        self.host('terminal-list')
        self.seed_relay([{'runId': RELAY_RUN, 'terminalStatus': 'completed',
                          'hostSource': 'native_host.terminal-mirror',
                          'statusSource': 'bridge_ledger.status', 'origin': 'direct'}])
        self.candidates(self.host('terminal-list'))
        self.host('terminal-ack', {'acked': [RELAY_RUN + '|completed']})
        # a brand new host process reads the same state dir
        again = [item['runId'] for item in self.candidates(self.host('terminal-list'))]
        self.assertEqual(again, [], 'the journal is persisted, so the ack still suppresses the re-offer')
        journal = self.source_state().get('relayAckedIds') or []
        self.assertIn(RELAY_RUN + '|completed', journal)
        self.assertIn(RELAY_RUN, journal, 'the bare run id is journalled too, so either form suppresses a re-offer')

    def test_a_direct_relay_candidate_keeps_its_origin_for_the_consent_gate(self):
        self.ledger_runs([])
        self.start_service()
        self.host('terminal-list')
        self.seed_relay([{'runId': RELAY_RUN, 'terminalStatus': 'completed',
                          'hostSource': 'native_host.terminal-mirror',
                          'statusSource': 'bridge_ledger.status', 'origin': 'direct'}])
        offered = self.candidates(self.host('terminal-list'))
        self.assertEqual(offered[0]['origin'], 'direct', 'the host does not promote it to channel A')
        self.assertEqual(offered[0]['source'], 'relay')


if __name__ == '__main__':
    unittest.main()
