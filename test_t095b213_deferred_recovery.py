"""T213: a run whose completion instant has not arrived yet must stay recoverable.

T212 deferred candidates by writing them into `relayBaselineIds`, the permanent history set. The Bridge writes a task's
terminal status and its terminal event in separate transactions, so a run can legitimately appear as terminal with no
event row yet; when the sidecar re-pushed it minutes later with a real `completedAt`, `relay_merge.history()` answered
for that run forever and the notice was lost with no trace.

Now there are three outcomes, not two:

  * *history* -- proven to have finished at or before the consent boundary, or present in an arm snapshot: permanent;
  * *deferred* -- terminal, but nothing yet proves when: never sent, never absorbed, recorded with its reason, bounded;
  * *announced* -- proven to have finished after the boundary: offered once, then the ACK journal owns it.

Real components: shipping `host.py`, real `host_mirror.mjs` sidecar, real Node service, real SQLite built with the live
Bridge schema, real extension consumption module in the JS suite.
"""

import json
import os
import sqlite3
import subprocess
import sys
import time
import unittest

import terminal_source
from test_t095b206_relay_fusion import ORIGIN, ROOT, RelayScene

LATE_RUN = 'beef1111-1111-4222-8333-444455556666'
OLD_RUN = 'beef2222-1111-4222-8333-444455556666'
NATIVE_RUN = 'beef3333-1111-4222-8333-444455556666'
OLD_START_MS = 1700000000000


class DeferralScene(RelayScene):
    """The Bridge's write order is the test: status first, terminal event later."""

    def setUp(self):
        super().setUp()
        import tempfile
        self.db = os.path.join(tempfile.mkdtemp(prefix='t213-db-'), 'service.sqlite')
        self.other = tempfile.mkdtemp(prefix='t213-other-')
        sub = os.path.join(self.other, 'a' * 64)
        os.makedirs(sub)
        self.other_ledger = os.path.join(sub, 'endpoint.json.runs.json')
        with open(self.other_ledger, 'w', encoding='utf-8') as handle:
            json.dump([], handle)
        self.init_db()

    # --- the two transactions -----------------------------------------------------------------------------
    def init_db(self):
        if os.path.isfile(self.db):
            os.remove(self.db)
        conn = sqlite3.connect(self.db)
        conn.executescript(
            'create table bridge_service_tasks (task_id text primary key, status text, provider_run_id text, '
            'failure_code text, created_at real, updated_at real);'
            'create table bridge_service_task_events (event_id integer primary key autoincrement, task_id text, '
            'kind text, summary text, details text, created_at real);')
        conn.commit()
        conn.close()

    def task_row(self, run_id, status='completed'):
        """Transaction one: the task is terminal, and the Bridge has not written its event row yet."""
        conn = sqlite3.connect(self.db)
        conn.execute('insert into bridge_service_tasks values (?,?,?,?,?,?)',
                     ('tsk-' + run_id[:8], status, run_id, None, OLD_START_MS / 1000.0, OLD_START_MS / 1000.0 + 30))
        conn.commit()
        conn.close()

    def event_row(self, run_id, kind, seconds):
        """Transaction two: the terminal event, its own instant, possibly much later."""
        conn = sqlite3.connect(self.db)
        conn.execute('insert into bridge_service_task_events (task_id, kind, summary, created_at) values (?,?,?,?)',
                     ('tsk-' + run_id[:8], kind, 'late event', seconds))
        conn.commit()
        conn.close()

    def other_runs(self, runs):
        with open(self.other_ledger, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    # --- plumbing ---------------------------------------------------------------------------------------
    def host(self, op, args=None, relay=True):
        import io
        import protocol as P
        argv = [sys.executable, '-B', os.path.join(ROOT, 'host.py'), ORIGIN,
                '--state-dir', self.state, '--ledger-root', self.root, '--manifest', self.manifest,
                '--bridge-db', self.db, '--bridge-db-fixture', self.fixture, '--native-root', self.native]
        if relay:
            argv += ['--relay-url', self.service_url, '--relay-token-file', self.token_file]
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op}
        if args is not None:
            request['args'] = args
        proc = subprocess.run(argv, input=P.encode(request), capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        return P.read_message(io.BytesIO(proc.stdout))

    def sidecar(self):
        proc = subprocess.run(
            ['node', os.path.join(ROOT, 'tools', 'service', 'host_mirror.mjs'),
             '--host-script', os.path.join(ROOT, 'host.py'), '--python', sys.executable, '--origin', ORIGIN,
             '--state-dir', self.state, '--ledger-root', self.other, '--bridge-db', self.db,
             '--bridge-db-fixture', self.fixture, '--native-root', self.native, '--manifest', self.manifest,
             '--service-url', self.service_url, '--service-token-file', self.token_file, '--once'],
            capture_output=True, env=dict(os.environ, PYTHON=sys.executable))
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        return json.loads(proc.stdout.decode('utf-8').strip().splitlines()[0])

    def sample(self):
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], reply)
        return reply['result']

    def arm(self, epoch='e-t213'):
        reply = self.host('terminal-arm-snapshot', {'epoch': epoch})
        self.assertTrue(reply['result']['ok'], reply)
        return reply['result']

    def offered(self, result):
        return [item['runId'] for item in result['candidates']]

    # --- the recovery path -------------------------------------------------------------------------------
    def test_a_terminal_run_without_an_event_is_deferred_not_buried(self):
        self.task_row(LATE_RUN)
        self.other_runs([{'requestID': LATE_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.sidecar()
        result = self.sample()
        self.assertEqual(self.offered(result), [], 'no instant: nothing may be sent')
        state = self.source_state()
        self.assertIn(LATE_RUN, state.get('relayDeferredIds') or [], 'recorded as unknown, with a reason')
        self.assertNotIn(LATE_RUN, state.get('relayBaselineIds') or [],
                         'and definitely not written into the permanent history set')
        self.assertEqual(result['relayDeferred'], 1)

    def test_the_late_event_authorises_the_run_exactly_once(self):
        self.task_row(LATE_RUN)
        self.other_runs([{'requestID': LATE_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.sidecar()                                    # mirrored first, no event yet
        self.assertEqual(self.offered(self.sample()), [])
        self.event_row(LATE_RUN, 'task.completed', time.time() + 2)   # the Bridge commits its event later
        self.sidecar()                                    # re-mirrored with the real instant
        first = self.sample()
        self.assertEqual(self.offered(first), [LATE_RUN])
        self.assertEqual(first['candidates'][0]['postArmSource'], 'bridge.task_events.task.completed')
        second = self.sample()
        self.assertEqual(self.offered(second), [LATE_RUN], 'still offered until acknowledged')
        self.assertEqual(len(second['candidates']), 1, 'and never twice in one answer')
        ack = self.host('terminal-ack', {'acked': [LATE_RUN]})
        self.assertIn(LATE_RUN, ack['result']['relayAcked'])
        self.assertEqual(self.sample()['candidates'], [], 'once acknowledged it is finished')

    def test_an_event_that_proves_it_finished_before_consent_buries_it(self):
        self.task_row(OLD_RUN)
        self.other_runs([{'requestID': OLD_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.sidecar()
        self.assertEqual(self.offered(self.sample()), [])
        self.event_row(OLD_RUN, 'task.completed', 1700000000.5)        # 2023
        self.sidecar()
        result = self.sample()
        self.assertEqual(self.offered(result), [])
        state = self.source_state()
        self.assertIn(OLD_RUN, state.get('relayBaselineIds') or [], 'proven history, permanently')
        self.assertNotIn(OLD_RUN, state.get('relayDeferredIds') or [], 'and no longer deferred')

    def test_a_deferral_survives_a_restart_and_still_recovers(self):
        self.task_row(LATE_RUN)
        self.other_runs([{'requestID': LATE_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.sidecar()
        self.assertEqual(self.offered(self.sample()), [])
        self.service.kill()
        self.service.wait(timeout=10)
        self.start_service()                              # restart: state dir is the same
        self.assertEqual(self.offered(self.sample()), [], 'still deferred after a restart')
        self.event_row(LATE_RUN, 'task.completed', time.time() + 2)
        self.sidecar()
        self.assertEqual(self.offered(self.sample()), [LATE_RUN])

    def test_a_relay_disconnect_does_not_turn_a_deferral_into_history(self):
        self.task_row(LATE_RUN)
        self.other_runs([{'requestID': LATE_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.sidecar()
        self.assertEqual(self.offered(self.sample()), [])
        self.service.kill()
        self.service.wait(timeout=10)
        down = self.sample()
        self.assertEqual(down['relayCode'], 'relay_unavailable')
        self.service = None
        self.assertIn(LATE_RUN, self.source_state().get('relayDeferredIds') or [])
        self.assertNotIn(LATE_RUN, self.source_state().get('relayBaselineIds') or [])
        self.start_service()                              # a fresh service, same dir
        self.sidecar()
        self.event_row(LATE_RUN, 'task.completed', time.time() + 2)
        self.sidecar()
        self.assertEqual(self.offered(self.sample()), [LATE_RUN])

    def test_a_status_correction_is_re_decided_from_the_new_event(self):
        self.task_row(LATE_RUN, status='completed')
        self.other_runs([{'requestID': LATE_RUN, 'status': 'failed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.sidecar()                                    # status now failed, no event -> deferred
        self.assertEqual(self.offered(self.sample()), [])
        self.event_row(LATE_RUN, 'task.failed', time.time() + 2)
        conn = sqlite3.connect(self.db)
        conn.execute("update bridge_service_tasks set status='failed' where provider_run_id=?", (LATE_RUN,))
        conn.commit()
        conn.close()
        self.sidecar()
        result = self.sample()
        self.assertEqual(self.offered(result), [LATE_RUN])
        self.assertEqual(result['candidates'][0]['status'], 'failed')
        self.assertEqual(result['candidates'][0]['postArmSource'], 'bridge.task_events.task.failed')

    def test_the_native_source_is_unaffected_by_a_deferral(self):
        self.task_row(LATE_RUN)
        self.other_runs([{'requestID': LATE_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()                                     # the native baseline is this first, empty read
        self.ledger_runs([{'requestID': NATIVE_RUN, 'status': 'completed', 'createdAt': 1793600000000}])
        self.sidecar()
        result = self.sample()
        self.assertEqual(self.offered(result), [NATIVE_RUN],
                         'the native candidate is offered on its own path while the relay one waits')
        self.assertEqual(result['relayDeferred'], 1)
        self.assertIn(LATE_RUN, self.source_state().get('relayDeferredIds') or [])

    def test_the_deferral_record_is_bounded(self):
        self.start_service()
        self.sample()
        self.sidecar()
        token = open(self.token_file, encoding='utf-8').read().strip()
        import urllib.request
        many = ['ffffffff-0000-4222-8333-%012d' % index for index in range(terminal_source.MAX_DEFERRED_IDS + 5)]
        body = json.dumps({'candidates': [{'runId': run_id, 'terminalStatus': 'completed',
                                          'statusSource': 'bridge.run_facts.status',
                                          'hostSource': 'native_host.terminal-mirror', 'origin': 'bridge',
                                          'startedAt': OLD_START_MS // 1000} for run_id in many]}).encode()
        request = urllib.request.Request(
            self.service_url + '/host/terminal-candidates', data=body,
            headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read()
        result = self.sample()
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['relayDeferred'], terminal_source.MAX_DEFERRED_IDS)
        self.assertEqual(result['relayDeferredDropped'], 5)
        again = self.sample()
        self.assertLessEqual(again['relayDeferred'], terminal_source.MAX_DEFERRED_IDS, 'no unbounded growth')


class Semantics(unittest.TestCase):

    def test_deferred_is_not_history(self):
        state = {'baselineIds': [], 'relayBaselineIds': ['a'], 'relayDeferredIds': ['b'],
                 'pendingIds': [], 'ackedIds': [], 'relayAckedIds': []}
        import relay_merge
        known = relay_merge.history(state)
        self.assertIn('a', known)
        self.assertNotIn('b', known, 'a deferral must never answer for the run')

    def test_merge_refuses_a_deferred_candidate_even_though_it_is_not_history(self):
        import relay_merge
        state = {'baselineIds': [], 'relayBaselineIds': [], 'pendingIds': [], 'ackedIds': [],
                 'relayAckedIds': [], 'relayDeferredIds': ['b']}
        candidates = [{'runId': 'b', 'status': 'completed', 'origin': 'bridge',
                       'statusSource': 'bridge_ledger.status'}]
        self.assertEqual(relay_merge.merge([], candidates, state, allow=set()), [],
                         'the allow set, not the history set, keeps a deferral out')


if __name__ == '__main__':
    unittest.main()
