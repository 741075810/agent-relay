"""T212: the relay service is a cache with a delay, so its emptiness proves nothing.

`relayCovered: true` only ever meant "the relay service was read". That service is filled by the `host_mirror.mjs`
sidecar on its own schedule, so a run that finished long ago can be missing from a freshly armed snapshot and arrive
minutes later. T211 read that absence as consent and authorised the notice -- a message about work the operator had
already watched finish, which is the one outcome this repository exists to prevent.

The rule now: authorisation needs positive evidence about *this run* -- a credible completion instant from the original
terminal source. No snapshot authorises by absence. What a snapshot does still do, and what needs no such trust, is
mark everything it contained as history.

Real components throughout: shipping `host.py`, the real `host_mirror.mjs` sidecar, the real Node service, a real
SQLite database with the live Bridge schema, and a second ledger root standing in for another host.
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

OLD_RUN = 'abcd1111-1111-4222-8333-444455556666'
NEW_RUN = 'abcd2222-1111-4222-8333-444455556666'
FAILED_RUN = 'abcd3333-1111-4222-8333-444455556666'
OLD_START_MS = 1700000000000
ANCIENT_SECONDS = 1700000000.5


def build_db(path, rows):
    """`rows` is `(run_id, status, kind, seconds)`; `kind=None` means no terminal event at all."""
    if os.path.isfile(path):
        os.remove(path)
    conn = sqlite3.connect(path)
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


class AsyncMirrorLag(RelayScene):
    """The sidecar's delay is the attack: arm while the service is empty, mirror afterwards."""

    def setUp(self):
        super().setUp()
        import tempfile
        self.db = os.path.join(tempfile.mkdtemp(prefix='t212-db-'), 'service.sqlite')
        self.other = tempfile.mkdtemp(prefix='t212-other-')
        other_sub = os.path.join(self.other, 'e' * 64)
        os.makedirs(other_sub)
        self.other_ledger = os.path.join(other_sub, 'endpoint.json.runs.json')
        with open(self.other_ledger, 'w', encoding='utf-8') as handle:
            json.dump([], handle)

    def other_runs(self, runs):
        with open(self.other_ledger, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def host(self, op, args=None, relay=True):
        import io
        import protocol as P
        argv = [sys.executable, '-B', os.path.join(ROOT, 'host.py'), ORIGIN,
                '--state-dir', self.state, '--ledger-root', self.root,
                '--manifest', self.manifest, '--bridge-db', self.db,
                '--bridge-db-fixture', self.fixture, '--native-root', self.native]
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
             '--host-script', os.path.join(ROOT, 'host.py'), '--python', sys.executable,
             '--origin', ORIGIN, '--state-dir', self.state, '--ledger-root', self.other,
             '--bridge-db', self.db, '--bridge-db-fixture', self.fixture,
             '--native-root', self.native, '--manifest', self.manifest,
             '--service-url', self.service_url, '--service-token-file', self.token_file, '--once'],
            capture_output=True, env=dict(os.environ, PYTHON=sys.executable))
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        return json.loads(proc.stdout.decode('utf-8').strip().splitlines()[0])

    def arm(self, epoch='e-t212'):
        reply = self.host('terminal-arm-snapshot', {'epoch': epoch})
        self.assertTrue(reply['ok'], reply)
        return reply['result']

    def sample(self):
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], reply)
        return reply['result']

    # --- the defect -------------------------------------------------------------------------------------------
    def test_a_run_with_no_instant_that_is_mirrored_after_the_arm_is_held_by_absence(self):
        build_db(self.db, [(OLD_RUN, 'completed', None, None)])
        self.other_runs([{'requestID': OLD_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()                                     # activation, relay empty
        armed = self.arm()
        self.assertTrue(armed['relayCovered'], armed)     # it did read the service -- that is all that means
        self.assertFalse(armed['relayUpstreamComplete'], armed)
        self.assertEqual(armed['relaySource'], 'service-cache')
        pushed = self.sidecar()                           # the ancient completion arrives only now
        self.assertEqual(pushed['candidates'], 1, pushed)
        result = self.sample()
        self.assertEqual([item['runId'] for item in result['candidates']], [],
                         'the service had not mirrored it at arm time; its absence proves nothing')
        self.assertEqual(result['relayAbsenceRefused'], 1)
        self.assertEqual(result['relayCode'], 'relay_completion_unknown')
        self.assertEqual(result['relaySnapshotAuthorised'], 0)

    def test_a_completion_that_follows_the_arm_still_flows(self):
        build_db(self.db, [(NEW_RUN, 'completed', 'task.completed', time.time() + 2)])
        self.other_runs([{'requestID': NEW_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.arm()
        self.sidecar()
        listed = self.sample()['candidates']
        self.assertEqual([item['runId'] for item in listed], [NEW_RUN])
        self.assertEqual(listed[0]['postArmEvidence'], 'relay_completed_at')
        self.assertEqual(listed[0]['postArmSource'], 'bridge.task_events.task.completed')

    def test_a_completion_that_precedes_the_arm_but_is_mirrored_later_is_held_by_its_instant(self):
        build_db(self.db, [(OLD_RUN, 'completed', 'task.completed', ANCIENT_SECONDS)])
        self.other_runs([{'requestID': OLD_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        armed = self.arm()
        self.assertTrue(armed['relayCovered'], armed)
        self.sidecar()
        result = self.sample()
        self.assertEqual([item['runId'] for item in result['candidates']], [],
                         'the instant says it finished before consent, whatever the cache did')
        self.assertEqual(result['relaySnapshotAuthorised'], 0)

    def test_an_old_and_a_new_completion_arriving_together_are_separated(self):
        build_db(self.db, [(OLD_RUN, 'completed', None, None),
                           (NEW_RUN, 'completed', 'task.completed', time.time() + 2)])
        self.other_runs([{'requestID': OLD_RUN, 'status': 'completed', 'createdAt': OLD_START_MS},
                         {'requestID': NEW_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.arm()
        self.sidecar()
        result = self.sample()
        self.assertEqual([item['runId'] for item in result['candidates']], [NEW_RUN])
        self.assertEqual(result['relayAbsenceRefused'], 1, 'the old one is refused by name, not silently dropped')

    def test_a_failed_run_follows_the_same_rule(self):
        build_db(self.db, [(FAILED_RUN, 'failed', 'task.failed', ANCIENT_SECONDS)])
        self.other_runs([{'requestID': FAILED_RUN, 'status': 'failed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.arm()
        self.sidecar()
        self.assertEqual([item['runId'] for item in self.sample()['candidates']], [])

    def test_a_run_with_no_terminal_event_is_held_even_with_an_arm(self):
        build_db(self.db, [(OLD_RUN, 'completed', None, None)])
        self.other_runs([{'requestID': OLD_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.arm()
        self.sidecar()
        result = self.sample()
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['relayCode'], 'relay_completion_unknown')

    def test_the_refusal_survives_a_restart_and_a_relay_reconnect(self):
        build_db(self.db, [(OLD_RUN, 'completed', 'task.completed', ANCIENT_SECONDS)])
        self.other_runs([{'requestID': OLD_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.sample()
        self.arm()
        self.sidecar()
        self.assertEqual(self.sample()['candidates'], [])
        self.service.kill()
        self.service.wait(timeout=10)
        self.start_service()                              # a reconnect: same state dir, same service dir
        again = self.sample()
        self.assertEqual(again['candidates'], [])
        self.assertIn(OLD_RUN, self.source_state().get('relayBaselineIds') or [])

    def test_a_re_post_cannot_move_a_completion_instant_later(self):
        # A refresh that pushed the instant past an arm would turn an old run into a new one. The service keeps the
        # earliest instant it was told.
        token = None
        build_db(self.db, [])
        self.start_service()
        token = open(self.token_file, encoding='utf-8').read().strip()
        import urllib.request

        def post(instant, source):
            body = json.dumps({'candidates': [{
                'runId': OLD_RUN, 'terminalStatus': 'completed', 'statusSource': 'bridge.run_facts.status',
                'hostSource': 'native_host.terminal-mirror', 'origin': 'bridge',
                'startedAt': OLD_START_MS // 1000, 'completedAt': instant, 'completedAtSource': source}]}).encode()
            request = urllib.request.Request(
                self.service_url + '/host/terminal-candidates', data=body,
                headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))

        first = post(int(ANCIENT_SECONDS * 1000), 'bridge.task_events.task.completed')
        self.assertTrue(first['accepted'][0]['duplicate'] is False)
        later = post(int((time.time() + 3600) * 1000), 'bridge.task_events.task.completed')
        self.assertFalse(later['accepted'][0]['refreshed'])
        record = json.load(open(os.path.join(self.service_dir, 'relay.json'), encoding='utf-8'))
        kept = [run for run in record['runs'] if run['runId'] == OLD_RUN][0]
        self.assertEqual(kept['completedAt'], int(ANCIENT_SECONDS * 1000), 'the earliest instant wins')
        self.assertEqual(kept['terminalStatus'], 'completed')

    def test_a_status_correction_does_not_keep_the_old_instant(self):
        build_db(self.db, [])
        self.start_service()
        token = open(self.token_file, encoding='utf-8').read().strip()
        import urllib.request

        def post(status, instant, source):
            body = json.dumps({'candidates': [{
                'runId': OLD_RUN, 'terminalStatus': status, 'statusSource': 'bridge.run_facts.status',
                'hostSource': 'native_host.terminal-mirror', 'origin': 'bridge',
                'startedAt': OLD_START_MS // 1000, 'completedAt': instant, 'completedAtSource': source}]}).encode()
            request = urllib.request.Request(
                self.service_url + '/host/terminal-candidates', data=body,
                headers={'content-type': 'application/json', 'authorization': 'Bearer ' + token})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))

        post('completed', int(ANCIENT_SECONDS * 1000), 'bridge.task_events.task.completed')
        post('failed', None, 'unknown')
        record = json.load(open(os.path.join(self.service_dir, 'relay.json'), encoding='utf-8'))
        kept = [run for run in record['runs'] if run['runId'] == OLD_RUN][0]
        self.assertEqual(kept['terminalStatus'], 'failed')
        self.assertIsNone(kept['completedAt'], 'an instant from the previous status is not evidence for the new one')
        self.assertEqual(kept['completedAtSource'], 'unknown')


class SnapshotHonesty(unittest.TestCase):

    def test_the_arm_report_never_claims_upstream_completeness(self):
        import tempfile
        state = tempfile.mkdtemp(prefix='t212-arm-')
        root = tempfile.mkdtemp(prefix='t212-root-')
        sub = os.path.join(root, 'f' * 64)
        os.makedirs(sub)
        with open(os.path.join(sub, 'endpoint.json.runs.json'), 'w', encoding='utf-8') as handle:
            json.dump([], handle)
        doc = terminal_source.arm_snapshot(state, root, 'e1')
        self.assertTrue(doc['ok'], doc)
        self.assertFalse(doc['relayCovered'])
        self.assertFalse(doc['relayUpstreamComplete'])
        self.assertIsNone(doc['relaySource'])
        stored = json.load(open(os.path.join(state, terminal_source.ARM_NAME), encoding='utf-8'))
        self.assertIs(stored['relayUpstreamComplete'], False)


if __name__ == '__main__':
    unittest.main()
