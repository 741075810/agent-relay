"""T211: the completion instant has to come from the real data path, not from a test's imagination.

T210 made consent depend on `completedAt`, but nothing real produced it: `terminal_source.mirror()` carried only
`startedAt`, and `host_mirror.mjs` forwarded only that. Every genuine Host -> Service -> Host candidate was therefore
held, and only hand-written fixtures passed.

Where the instant actually lives, verified read-only against the live database before any of this was written:

  * `*.runs.json` (the ledger): `requestID`, `createdAt`, `status`, `turn`, `sessionID`, `cursor`, `events` -- no
    completion time, so nothing here can be derived from it;
  * `bridge_service_tasks`: `created_at` and `updated_at` only, and `updated_at` moves on any edit;
  * `bridge_service_task_events`: `task.completed` / `task.failed` / `task.interrupted` with their own `created_at`,
    epoch **seconds**. 231 of the 336 terminal-by-status runs have one; the rest genuinely have no completion instant.

Real components: shipping `host.py` subprocess, the real `host_mirror.mjs` sidecar, the real Node service, and a real
SQLite database built with the live schema.
"""

import json
import os
import sqlite3
import subprocess
import sys
import time
import unittest

import relay_merge
import run_origin
import terminal_source
from test_t095b206_relay_fusion import ORIGIN, ROOT, RelayScene

RELAY_RUN = 'eeee1111-1111-4222-8333-444455556666'
OTHER_RUN = 'ffff2222-1111-4222-8333-444455556666'
EVENT_SECONDS = 1793453704.945753
EVENT_MS = 1793453704946
OLD_START_MS = 1700000000000


def build_bridge_db(path, rows):
    """A real database with the live schema: `rows` is `(run_id, status, kind, created_at)`.

    `kind=None` means "no terminal event for this run", which is the live case for 105 of 336 runs.
    """
    conn = sqlite3.connect(path)
    conn.executescript(
        'create table bridge_service_tasks (task_id TEXT primary key, status TEXT, provider_run_id TEXT, '
        'failure_code TEXT, created_at REAL, updated_at REAL);'
        'create table bridge_service_task_events (event_id integer primary key autoincrement, task_id TEXT, '
        'kind TEXT, summary TEXT, details TEXT, created_at REAL);')
    for index, (run_id, status, kind, at) in enumerate(rows):
        task_id = 'tsk-%02d' % index
        conn.execute('insert into bridge_service_tasks (task_id, status, provider_run_id, failure_code, created_at, '
                     'updated_at) values (?,?,?,?,?,?)',
                     (task_id, status, run_id, None, OLD_START_MS / 1000.0, (OLD_START_MS / 1000.0) + 60))
        if kind is not None:
            conn.execute('insert into bridge_service_task_events (task_id, kind, summary, created_at) '
                         'values (?,?,?,?)', (task_id, kind, 'fixture', at))
    conn.commit()
    conn.close()


class BridgeCompletion(unittest.TestCase):

    def setUp(self):
        import tempfile
        self.db = os.path.join(tempfile.mkdtemp(prefix='t211-db-'), 'service.sqlite')

    def test_a_terminal_event_supplies_the_instant_and_its_source(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', 'task.completed', EVENT_SECONDS)])
        times, error = run_origin.read_terminal_times(self.db)
        self.assertIsNone(error)
        self.assertEqual(times[RELAY_RUN]['completedAtMs'], EVENT_MS)
        self.assertEqual(times[RELAY_RUN]['event'], 'task.completed')

    def test_seconds_are_converted_rather_than_read_as_milliseconds(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', 'task.completed', EVENT_SECONDS)])
        times, _ = run_origin.read_terminal_times(self.db)
        self.assertEqual(times[RELAY_RUN]['completedAtMs'], EVENT_MS)
        self.assertNotEqual(times[RELAY_RUN]['completedAtMs'], int(EVENT_SECONDS))
        # and a database that already stores milliseconds keeps them
        self.assertEqual(run_origin._epoch_ms(1793453704945), 1793453704945)

    def test_a_run_without_a_terminal_event_has_no_instant(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', None, None)])
        times, error = run_origin.read_terminal_times(self.db)
        self.assertIsNone(error)
        self.assertEqual(times, {})
        self.assertIsNone(run_origin.completion_for_status(RELAY_RUN, 'completed', times))

    def test_a_contradicting_event_is_not_evidence(self):
        # `failed` status next to a `task.completed` event: the sources disagree, so the instant is unknown.
        build_bridge_db(self.db, [(RELAY_RUN, 'failed', 'task.completed', EVENT_SECONDS)])
        times, _ = run_origin.read_terminal_times(self.db)
        self.assertIsNotNone(times.get(RELAY_RUN))
        self.assertIsNone(run_origin.completion_for_status(RELAY_RUN, 'failed', times))

    def test_a_per_command_event_is_never_a_completion(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', 'execution.command_completed', EVENT_SECONDS)])
        times, _ = run_origin.read_terminal_times(self.db)
        self.assertEqual(times, {})

    def test_missing_database_is_unknown_not_empty(self):
        times, error = run_origin.read_terminal_times(os.path.join(os.path.dirname(self.db), 'absent.sqlite'))
        self.assertEqual(times, {})
        self.assertIn('not a file', error)


class RealDataPath(RelayScene):
    """The whole chain: real host -> real sidecar -> real service -> real host sample."""

    def setUp(self):
        super().setUp()
        import tempfile
        self.db = os.path.join(tempfile.mkdtemp(prefix='t211-bridge-'), 'service.sqlite')
        # The ledger the sidecar mirrors: a different host's, so the sampling host has never seen these runs.
        self.other = tempfile.mkdtemp(prefix='t211-other-')
        other_sub = os.path.join(self.other, 'd' * 64)
        os.makedirs(other_sub)
        self.other_ledger = os.path.join(other_sub, 'endpoint.json.runs.json')
        with open(self.other_ledger, 'w', encoding='utf-8') as handle:
            json.dump([], handle)

    def other_runs(self, runs):
        with open(self.other_ledger, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def host(self, op, args=None, relay=True, ledger_root=None):
        # Same as the shared scene, plus the real database this suite builds.
        argv = [sys.executable, '-B', os.path.join(ROOT, 'host.py'), ORIGIN,
                '--state-dir', self.state, '--ledger-root', ledger_root or self.root,
                '--manifest', self.manifest, '--bridge-db', self.db,
                '--bridge-db-fixture', self.fixture, '--native-root', self.native]
        if relay:
            argv += ['--relay-url', self.service_url, '--relay-token-file', self.token_file]
        import io
        import protocol as P
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op}
        if args is not None:
            request['args'] = args
        proc = subprocess.run(argv, input=P.encode(request), capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        return P.read_message(io.BytesIO(proc.stdout))

    def mirror(self):
        reply = self.host('terminal-mirror', relay=False, ledger_root=self.other)
        self.assertTrue(reply['ok'], reply)
        return reply['result']

    def sidecar(self):
        """Push the mirror through the real sidecar, exactly as a deployed service would."""
        proc = subprocess.run(
            ['node', os.path.join(ROOT, 'tools', 'service', 'host_mirror.mjs'),
             '--host-script', os.path.join(ROOT, 'host.py'), '--state-dir', self.state,
             '--ledger-root', self.other, '--bridge-db', self.db, '--bridge-db-fixture', self.fixture,
             '--native-root', self.native, '--manifest', self.manifest,
             '--service-url', self.service_url, '--service-token-file', self.token_file, '--once'],
            capture_output=True, env=dict(os.environ, PYTHON=sys.executable))
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        return json.loads(proc.stdout.decode('utf-8').strip().splitlines()[0])

    def test_the_mirror_carries_the_instant_and_says_where_it_came_from(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', 'task.completed', EVENT_SECONDS)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        report = self.mirror()
        self.assertEqual(report['counts']['candidates'], 1)
        candidate = report['candidates'][0]
        self.assertEqual(candidate['completedAt'], EVENT_MS)
        self.assertEqual(candidate['completedAtSource'], 'bridge.task_events.task.completed')
        self.assertEqual(candidate['startedAt'], OLD_START_MS // 1000)
        self.assertEqual(report['counts']['completedAtKnown'], 1)

    def test_a_run_without_a_terminal_event_says_unknown_rather_than_guessing(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', None, None)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        report = self.mirror()
        candidate = report['candidates'][0]
        self.assertIsNone(candidate['completedAt'])
        self.assertEqual(candidate['completedAtSource'], 'unknown')
        self.assertEqual(report['counts']['completedAtUnknown'], 1)

    def test_an_unreadable_events_table_is_reported_not_silently_empty(self):
        conn = sqlite3.connect(self.db)
        conn.execute('create table bridge_service_tasks (task_id TEXT, status TEXT, provider_run_id TEXT, '
                     'failure_code TEXT, created_at REAL, updated_at REAL)')
        conn.commit()
        conn.close()
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        report = self.mirror()
        self.assertIn('terminal event tables', report['completionError'])
        self.assertIsNone(report['candidates'][0]['completedAt'])

    def test_the_real_chain_announces_a_run_it_could_never_have_announced_before(self):
        # The instant must be after the activation this test is about to create, so it is taken now.
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', 'task.completed', time.time() + 1)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.host('terminal-list')                       # activation with an empty relay
        pushed = self.sidecar()
        self.assertTrue(pushed['ok'], pushed)
        self.assertEqual(pushed['candidates'], 1)
        reply = self.host('terminal-list')
        self.assertTrue(reply['ok'], reply)
        listed = reply['result']['candidates']
        self.assertEqual([item['runId'] for item in listed], [RELAY_RUN],
                         'a run carried through the real sidecar carries its own completion evidence')
        self.assertTrue(listed[0]['postArm'] is None or listed[0]['postArm'] is True)

    def test_a_failed_run_travels_with_its_own_event(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'failed', 'task.failed', time.time() + 1)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'failed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.host('terminal-list')
        self.sidecar()
        reply = self.host('terminal-list')
        listed = reply['result']['candidates']
        self.assertEqual([(item['runId'], item['status']) for item in listed], [(RELAY_RUN, 'failed')])

    def test_a_long_run_is_announced_by_its_completion_not_its_start(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', 'task.completed', time.time() + 1)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.host('terminal-list')
        self.sidecar()
        listed = self.host('terminal-list')['result']['candidates']
        self.assertEqual([item['runId'] for item in listed], [RELAY_RUN])

    def test_a_complete_snapshot_authorises_without_a_completion_instant(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', None, None)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.host('terminal-list')                       # activation, relay empty
        # Arm through the host: it reads the relay source and records that it covered it. The run has not arrived yet,
        # so the snapshot does not contain it.
        arm = self.host('terminal-arm-snapshot', {'epoch': 'e-t211'})
        self.assertTrue(arm['result']['relayCovered'], arm)
        pushed = self.sidecar()
        self.assertTrue(pushed['ok'], pushed)
        after = self.host('terminal-list')['result']
        self.assertEqual([item['runId'] for item in after['candidates']], [RELAY_RUN],
                         'the snapshot read this source and did not contain the run, so it finished after consent')
        self.assertEqual(after['candidates'][0]['postArmEvidence'], 'relay_complete_snapshot')
        self.assertEqual(after['relaySnapshotAuthorised'], 1)

    def test_a_ledger_only_snapshot_never_authorises_that_way(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', None, None)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.host('terminal-list')
        self.sidecar()
        with open(os.path.join(self.state, terminal_source.ARM_NAME), 'w', encoding='utf-8') as handle:
            json.dump({'version': terminal_source.ARM_VERSION, 'epoch': 'e-ledger', 'takenAt': 1793600000,
                       'truncated': False, 'ids': [OTHER_RUN], 'sources': ['bridge_ledger'],
                       'relayCovered': False}, handle)
        result = self.host('terminal-list')['result']
        self.assertEqual([item['runId'] for item in result['candidates']], [],
                         'a snapshot that never read the relay cannot prove anything about a relay run')
        self.assertEqual(result['relaySnapshotAuthorised'], 0)
        self.assertFalse(result['armRelayCovered'])

    def test_a_dead_relay_leaves_nothing_authorised_and_says_so(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', 'task.completed', time.time() + 1)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.host('terminal-list')
        self.sidecar()
        self.service.kill()
        self.service.wait(timeout=10)
        result = self.host('terminal-list')['result']
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['relayCode'], 'relay_unavailable')
        self.assertEqual(result['relayActivation'], 'active', 'a read failure does not undo an activation')
        self.service = None

    def test_a_bare_run_id_ack_is_final_across_the_real_path(self):
        build_bridge_db(self.db, [(RELAY_RUN, 'completed', 'task.completed', time.time() + 1)])
        self.other_runs([{'requestID': RELAY_RUN, 'status': 'completed', 'createdAt': OLD_START_MS}])
        self.start_service()
        self.host('terminal-list')
        self.sidecar()
        listed = self.host('terminal-list')['result']['candidates']
        self.assertEqual([item['runId'] for item in listed], [RELAY_RUN])
        ack = self.host('terminal-ack', {'acked': [RELAY_RUN]})
        self.assertTrue(ack['ok'], ack)
        self.assertIn(RELAY_RUN, ack['result']['relayAcked'])
        self.assertEqual(self.host('terminal-list')['result']['candidates'][:1], [])


class Units(unittest.TestCase):

    def test_a_complete_snapshot_is_the_only_absence_evidence(self):
        self.assertTrue(relay_merge.completed_ms({'completedAt': EVENT_MS}) == EVENT_MS)
        self.assertIsNone(relay_merge.completed_ms({'completedAtSource': 'bridge.task_events.task.completed'}))


if __name__ == '__main__':
    unittest.main()
