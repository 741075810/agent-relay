"""T214: consent is a millisecond question, and a number is not a provenance.

Two defects, both on the path that decides whether a finished task may be announced.

*Precision.* `arm_snapshot()` wrote `takenAt = int(time.time())` and `sample()` compared against `takenAt * 1000`. A run
that finished at 12:00:00.500 -- before the operator armed at 12:00:00.900 -- was therefore "after" a boundary of
12:00:00.000 and would be announced: a notice about work already watched finishing. The arm now records `armTakenAtMs`,
while `takenAt` stays whole seconds for older readers. A snapshot that has only the second cannot prove where inside it
the operator armed, so the whole second is treated as before consent -- conservative, and never rounded towards sending.

*Provenance.* `completed_ms()` accepted any numeric `completedAt`. A number arriving from the service without a source,
or with one that contradicts its status, is not partial evidence; it is none. Instants are now trusted only from an
allowlist naming the Bridge's own terminal events, and only when the event kind matches the status being announced.

Real components: shipping `host.py`, real `host_mirror.mjs` sidecar, real Node service, real SQLite with the live Bridge
schema. The JS suite in this round carries the extension consumer.
"""

import json
import os
import sqlite3
import subprocess
import sys
import time
import unittest

import relay_merge
import terminal_source
from test_t095b206_relay_fusion import ORIGIN, ROOT, RelayScene

RUN = 'cafe1111-1111-4222-8333-444455556666'
OTHER = 'cafe2222-1111-4222-8333-444455556666'
OLD_START_MS = 1700000000000


class PrecisionScene(RelayScene):

    def setUp(self):
        super().setUp()
        import tempfile
        self.db = os.path.join(tempfile.mkdtemp(prefix='t214-db-'), 'service.sqlite')
        self.other = tempfile.mkdtemp(prefix='t214-other-')
        sub = os.path.join(self.other, 'b' * 64)
        os.makedirs(sub)
        self.other_ledger = os.path.join(sub, 'endpoint.json.runs.json')
        with open(self.other_ledger, 'w', encoding='utf-8') as handle:
            json.dump([], handle)

    def db_with(self, rows):
        if os.path.isfile(self.db):
            os.remove(self.db)
        conn = sqlite3.connect(self.db)
        conn.executescript(
            'create table bridge_service_tasks (task_id text primary key, status text, provider_run_id text, '
            'failure_code text, created_at real, updated_at real);'
            'create table bridge_service_task_events (event_id integer primary key autoincrement, task_id text, '
            'kind text, summary text, details text, created_at real);')
        for index, (run_id, status, kind, seconds) in enumerate(rows):
            task_id = 'tsk-%02d' % index
            conn.execute('insert into bridge_service_tasks values (?,?,?,?,?,?)',
                         (task_id, status, run_id, None, OLD_START_MS / 1000.0, OLD_START_MS / 1000.0 + 30))
            if kind is not None:
                conn.execute('insert into bridge_service_task_events (task_id, kind, summary, created_at) '
                             'values (?,?,?,?)', (task_id, kind, 'fixture', seconds))
        conn.commit()
        conn.close()

    def other_runs(self, runs):
        with open(self.other_ledger, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

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

    def offered(self, result):
        return [item['runId'] for item in result['candidates']]

    def write_arm(self, taken_at, ids=(), arm_ms=None, epoch='e-t214'):
        doc = {'version': terminal_source.ARM_VERSION, 'epoch': epoch, 'takenAt': taken_at,
               'truncated': False, 'ids': list(ids), 'sources': ['bridge_ledger'], 'relayCovered': False,
               'relayUpstreamComplete': False}
        if arm_ms is not None:
            doc['armTakenAtMs'] = arm_ms
        with open(os.path.join(self.state, terminal_source.ARM_NAME), 'w', encoding='utf-8') as handle:
            json.dump(doc, handle)

    # --- the millisecond boundary ---------------------------------------------------------------------------
    def test_a_run_finishing_in_the_same_second_before_the_arm_is_not_announced(self):
        second = int(time.time())
        self.db_with([(RUN, 'completed', 'task.completed', second + 0.5)])
        self.other_runs([{'requestID': RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        # The operator arms at .900 of that second; the run finished at .500.
        self.write_arm(second, arm_ms=second * 1000 + 900)
        self.sidecar()
        result = self.sample()
        self.assertEqual(self.offered(result), [], 'it finished before consent, in the same second')
        self.assertEqual(result['armPrecision'], 'ms')

    def test_a_run_finishing_in_the_same_second_after_the_arm_is_announced(self):
        second = int(time.time())
        self.db_with([(RUN, 'completed', 'task.completed', second + 0.95)])
        self.other_runs([{'requestID': RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.write_arm(second, arm_ms=second * 1000 + 900)
        self.sidecar()
        result = self.sample()
        self.assertEqual(self.offered(result), [RUN], 'it finished 50 ms after consent')
        self.assertEqual(result['candidates'][0]['postArmEvidence'], 'relay_completed_at')

    def test_an_old_second_only_snapshot_treats_the_whole_second_as_before_consent(self):
        second = int(time.time())
        self.db_with([(RUN, 'completed', 'task.completed', second + 0.5)])
        self.other_runs([{'requestID': RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.write_arm(second)                            # no armTakenAtMs: a snapshot from before this change
        self.sidecar()
        result = self.sample()
        self.assertEqual(result['armPrecision'], 'second')
        self.assertEqual(self.offered(result), [],
                         'an old snapshot cannot prove where inside its second the operator armed')

    def test_an_old_snapshot_still_announces_something_that_finished_after_its_second(self):
        second = int(time.time())
        self.db_with([(RUN, 'completed', 'task.completed', second + 2.5)])
        self.other_runs([{'requestID': RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.write_arm(second)
        self.sidecar()
        self.assertEqual(self.offered(self.sample()), [RUN])

    def test_the_arm_the_host_writes_carries_milliseconds_in_the_same_second(self):
        second = int(time.time())
        self.db_with([])
        self.start_service()
        self.sample()
        reply = self.host('terminal-arm-snapshot', {'epoch': 'e-now'})
        report = reply['result']
        self.assertTrue(report['ok'], report)
        stored = json.load(open(os.path.join(self.state, terminal_source.ARM_NAME), encoding='utf-8'))
        self.assertIn('armTakenAtMs', stored)
        self.assertEqual(stored['takenAt'], stored['armTakenAtMs'] // 1000)
        self.assertGreaterEqual(stored['armTakenAtMs'], second * 1000)

    def test_re_arming_moves_the_boundary_forward(self):
        second = int(time.time())
        self.db_with([(RUN, 'completed', 'task.completed', second + 0.5)])
        self.other_runs([{'requestID': RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.host('terminal-arm-snapshot', {'epoch': 'e-first'})
        self.sidecar()                                     # arrives against the first arm
        first = self.sample()
        self.assertIn(RUN, self.offered(first) + self.source_state().get('relayBaselineIds', []),
                      'either announced or absorbed by the first arm, never lost')
        self.host('terminal-arm-snapshot', {'epoch': 'e-second'})   # re-arm: later boundary, new epoch
        stored = json.load(open(os.path.join(self.state, terminal_source.ARM_NAME), encoding='utf-8'))
        self.assertEqual(stored['epoch'], 'e-second')
        again = self.sample()
        self.assertEqual(self.offered(again), [], 'what was announced is acknowledged territory, not re-offered')

    def test_an_arm_with_a_contradictory_instant_is_refused_not_guessed(self):
        self.db_with([])
        self.start_service()
        self.sample()
        self.write_arm(1793600000, arm_ms=1793600123 * 1000)        # a different second in the two fields
        reply = self.host('terminal-list')
        # The envelope is still a well-formed answer; the report inside it refused.
        self.assertTrue(reply['ok'], reply)
        self.assertFalse(reply['result']['ok'])
        self.assertEqual(reply['result']['code'], 'arm_snapshot_unreadable')
        self.assertIn('different seconds', json.dumps(reply['result']))

    # --- provenance -----------------------------------------------------------------------------------------
    def test_a_number_without_a_source_is_deferred(self):
        self.db_with([])
        self.start_service()
        self.sample()
        self.write_arm(int(time.time()), arm_ms=int(time.time() * 1000))
        self.seed_verbatim([{'runId': RUN, 'terminalStatus': 'completed', 'statusSource': 'bridge.run_facts.status',
                             'hostSource': 'native_host.terminal-mirror', 'origin': 'bridge',
                             'startedAt': OLD_START_MS // 1000, 'completedAt': int(time.time() * 1000) + 60000}])
        result = self.sample()
        self.assertEqual(self.offered(result), [])
        self.assertEqual(result['relaySourceUntrusted'], 1)

    def test_a_source_that_contradicts_the_status_is_deferred(self):
        self.db_with([])
        self.start_service()
        self.sample()
        self.write_arm(int(time.time()), arm_ms=int(time.time() * 1000))
        self.seed_verbatim([{'runId': RUN, 'terminalStatus': 'completed', 'statusSource': 'bridge.run_facts.status',
                             'hostSource': 'native_host.terminal-mirror', 'origin': 'bridge',
                             'startedAt': OLD_START_MS // 1000, 'completedAt': int(time.time() * 1000) + 60000,
                             'completedAtSource': 'bridge.task_events.task.failed'}])
        result = self.sample()
        self.assertEqual(self.offered(result), [])
        self.assertEqual(result['relaySourceUntrusted'], 1)

    def test_an_unknown_source_string_is_deferred(self):
        self.db_with([])
        self.start_service()
        self.sample()
        self.seed_verbatim([{'runId': RUN, 'terminalStatus': 'completed', 'statusSource': 'bridge.run_facts.status',
                             'hostSource': 'native_host.terminal-mirror', 'origin': 'bridge',
                             'startedAt': OLD_START_MS // 1000, 'completedAt': int(time.time() * 1000) + 60000,
                             'completedAtSource': 'unknown'}])
        result = self.sample()
        self.assertEqual(self.offered(result), [])
        self.assertEqual(result['relaySourceUntrusted'], 1)

    def test_late_provenance_recovers_the_run_exactly_once(self):
        real_second = int(time.time())
        self.db_with([(RUN, 'completed', None, None)])
        self.other_runs([{'requestID': RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.write_arm(real_second - 5, arm_ms=(real_second - 5) * 1000)
        self.sidecar()                                     # no event row yet: no source, no number
        self.assertEqual(self.offered(self.sample()), [])
        self.assertIn(RUN, self.source_state().get('relayDeferredIds') or [])
        # now the Bridge commits its terminal event
        conn = sqlite3.connect(self.db)
        conn.execute('insert into bridge_service_task_events (task_id, kind, summary, created_at) values (?,?,?,?)',
                     ('tsk-00', 'task.completed', 'late', real_second + 1.25))
        conn.commit()
        conn.close()
        self.sidecar()
        first = self.sample()
        self.assertEqual(self.offered(first), [RUN])
        self.assertEqual(first['candidates'][0]['postArmSource'], 'bridge.task_events.task.completed')
        self.assertEqual(len(self.sample()['candidates']), 1)
        self.host('terminal-ack', {'acked': [RUN]})
        self.assertEqual(self.sample()['candidates'], [])

    def seed_verbatim(self, items):
        import urllib.request
        token = open(self.token_file, encoding='utf-8').read().strip()
        body = json.dumps({'candidates': items}).encode('utf-8')
        request = urllib.request.Request(
            self.service_url + '/host/terminal-candidates', data=body,
            headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode('utf-8'))


class Units(unittest.TestCase):

    def test_the_boundary_is_exact_or_conservative(self):
        self.assertEqual(terminal_source._arm_boundary({'takenAt': 12, 'armTakenAtMs': 12900}, 0), (12900, 'ms'))
        self.assertEqual(terminal_source._arm_boundary({'takenAt': 12}, 0), (12999, 'second'))
        self.assertEqual(terminal_source._arm_boundary(None, 7), (7, 'activation'))

    def test_the_source_allowlist_matches_status(self):
        ok = {'status': 'completed', 'completedAt': 1793600000000,
              'completedAtSource': 'bridge.task_events.task.completed'}
        self.assertTrue(relay_merge.completion_source_ok(ok))
        self.assertEqual(relay_merge.trusted_completed_ms(ok), 1793600000000)
        self.assertFalse(relay_merge.completion_source_ok(dict(ok, status='failed')))
        self.assertIsNone(relay_merge.trusted_completed_ms(dict(ok, completedAtSource='unknown')))
        self.assertFalse(relay_merge.completion_source_ok({'status': 'completed'}))
        self.assertEqual(sorted(relay_merge.TRUSTED_COMPLETION_SOURCES),
                         ['completed', 'failed', 'interrupted'])


if __name__ == '__main__':
    unittest.main()
