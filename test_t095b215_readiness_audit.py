"""T215: the readiness audit and the shadow observer, and the promises they make about the production machine.

Two properties are load-bearing and are tested against real files and a real SQLite database:

  * **default off** -- without its explicit flag a tool reads nothing and starts nothing;
  * **cannot write** -- the audit opens the Bridge database read-only (`mode=ro` + `query_only`) and SQLite itself must
    refuse a write through that handle; the shadow observer works on a copy inside a temporary directory, and the
    production database's bytes are unchanged afterwards.

The audit's verdict is also tested, because a NO-GO that flips to GO because a component is simply missing would be
worse than no audit at all.
"""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
AUDIT = os.path.join(ROOT, 'tools', 'rollout', 'readiness_audit.py')
SHADOW = os.path.join(ROOT, 'tools', 'rollout', 'shadow_observe.py')
EXT = 'chrome-extension://' + 'a' * 32 + '/'


def run(script, *args, **kwargs):
    return subprocess.run([sys.executable, '-B', script] + list(args), capture_output=True, text=True, **kwargs)


def build_bridge(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        'create table bridge_service_tasks (task_id text primary key, status text, provider_run_id text, '
        'failure_code text, created_at real, updated_at real);'
        'create table bridge_service_task_events (event_id integer primary key autoincrement, task_id text, '
        'kind text, summary text, details text, created_at real);')
    conn.execute('insert into bridge_service_tasks values (?,?,?,?,?,?)',
                 ('tsk-1', 'completed', 'run-1', None, 1793400000.0, 1793400030.0))
    conn.execute('insert into bridge_service_task_events (task_id, kind, summary, created_at) values (?,?,?,?)',
                 ('tsk-1', 'task.completed', 'done', 1793400010.5))
    conn.execute('insert into bridge_service_tasks values (?,?,?,?,?,?)',
                 ('tsk-2', 'completed', 'run-2', None, 1793400000.0, 1793400030.0))
    conn.commit()
    conn.close()


def build_tree(root, with_epoch_binding=True, with_relay=True, with_arm_ms=True):
    """A stand-in install: the capabilities are the point, not the code."""
    os.makedirs(os.path.join(root, 'extension', 'lib'), exist_ok=True)
    host = ['import sys', 'OPS = ("terminal-arm-snapshot",)']
    if with_relay:
        host.append("RELAY = '--relay-url'")
    if with_arm_ms:
        host.append("PRECISION = 'armTakenAtMs'")
    with open(os.path.join(root, 'host.py'), 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(host) + '\n')
    worker = ['const x = 1;', '// postArm is honoured']
    if with_epoch_binding:
        worker.append('// postArmEpoch binds the verdict to its snapshot')
    with open(os.path.join(root, 'extension', 'background.js'), 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(worker) + '\n')
    trigger = 'export function postArmUsable() {}\n' if with_epoch_binding else 'export const x = 1;\n'
    with open(os.path.join(root, 'extension', 'lib', 'terminal_trigger.js'), 'w', encoding='utf-8') as handle:
        handle.write(trigger)
    with open(os.path.join(root, 'extension', 'manifest.json'), 'w', encoding='utf-8') as handle:
        json.dump({'name': 'DSH Notify Bridge', 'version': '0.1.1', 'manifest_version': 3}, handle)
    with open(os.path.join(root, 'host_launcher.exe'), 'wb') as handle:
        handle.write(b'MZ' + b'\x00' * 30)
    manifest = os.path.join(root, 'host_manifest.json')
    with open(manifest, 'w', encoding='utf-8') as handle:
        json.dump({'name': 'com.dsh.notify', 'type': 'stdio',
                   'path': os.path.join(root, 'host_launcher.exe'),
                   'allowed_origins': [EXT]}, handle)
    return manifest


class DefaultOff(unittest.TestCase):

    def test_the_audit_does_nothing_without_its_flag(self):
        done = run(AUDIT)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('disabled', done.stdout)

    def test_the_shadow_observer_does_nothing_without_its_flag(self):
        done = run(SHADOW)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('disabled', done.stdout)

    def test_the_shadow_observer_does_not_even_read_a_database_it_was_pointed_at(self):
        work = tempfile.mkdtemp(prefix='t215-off-')
        self.addCleanup(shutil.rmtree, work, True)
        db = os.path.join(work, 'service.sqlite')
        build_bridge(db)
        before = os.stat(db).st_mtime_ns
        done = run(SHADOW, '--bridge-db', db)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(os.stat(db).st_mtime_ns, before, 'the flag is what turns reading on, and it was absent')


class ReadOnly(unittest.TestCase):

    def setUp(self):
        self.work = tempfile.mkdtemp(prefix='t215-ro-')
        self.addCleanup(shutil.rmtree, self.work, True)
        self.repo = os.path.join(self.work, 'repo')
        os.makedirs(self.repo)
        self.db = os.path.join(self.work, 'service.sqlite')
        build_bridge(self.db)
        self.installed = os.path.join(self.work, 'installed')
        os.makedirs(self.installed)
        self.manifest = build_tree(self.installed)
        self.state = os.path.join(self.work, 'state')
        os.makedirs(self.state)

    def audit(self, *extra):
        done = run(AUDIT, '--audit', '--repo-root', self.repo, '--installed-root', self.installed,
                   '--manifest', self.manifest, '--bridge-db', self.db, '--state-dir', self.state, *extra)
        return done

    def test_the_audit_leaves_every_file_it_read_exactly_as_it_was(self):
        watched = {}
        for base, _dirs, files in os.walk(self.work):
            for name in files:
                path = os.path.join(base, name)
                watched[path] = (os.stat(path).st_mtime_ns, os.path.getsize(path))
        done = self.audit()
        self.assertIn(done.returncode, (0, 3), done.stderr)
        for path, (mtime, size) in watched.items():
            self.assertEqual((os.stat(path).st_mtime_ns, os.path.getsize(path)), (mtime, size),
                             '%s was modified by a read-only audit' % os.path.basename(path))

    def test_the_database_handle_refuses_a_write(self):
        sys.path.insert(0, os.path.join(ROOT, 'tools', 'rollout'))
        import readiness_audit
        conn = readiness_audit.open_readonly(self.db)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute('create table audit_write_probe(x)')
        finally:
            conn.close()
        conn = sqlite3.connect(self.db)
        try:
            tables = {row[0] for row in conn.execute("select name from sqlite_master where type='table'")}
        finally:
            conn.close()
        self.assertNotIn('audit_write_probe', tables)

    def test_the_shadow_observer_copies_the_database_and_leaves_the_original_untouched(self):
        done = run(SHADOW, '--enable', '--repo-root', ROOT, '--bridge-db', self.db, '--json')
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads(done.stdout)
        self.assertEqual(report['productionWrites'], 0)
        self.assertTrue(report['readOnlyProof'].startswith('refused'), report['readOnlyProof'])
        self.assertFalse(report['sourceDigestChanged'], 'a frozen database must not move')
        conn = sqlite3.connect(self.db)
        try:
            self.assertEqual(conn.execute('select count(*) from bridge_service_task_events').fetchone()[0], 1)
        finally:
            conn.close()


class Redaction(unittest.TestCase):

    def setUp(self):
        self.work = tempfile.mkdtemp(prefix='t215-red-')
        self.addCleanup(shutil.rmtree, self.work, True)
        self.db = os.path.join(self.work, 'service.sqlite')
        build_bridge(self.db)
        self.installed = os.path.join(self.work, 'installed')
        os.makedirs(self.installed)
        self.manifest = build_tree(self.installed)
        self.token = os.path.join(self.work, 'service.token')
        with open(self.token, 'w', encoding='utf-8') as handle:
            handle.write('SECRET-TOKEN-VALUE-' + 'x' * 24 + '\n')

    def test_the_extension_id_is_replaced_and_the_token_value_never_appears(self):
        done = run(AUDIT, '--audit', '--repo-root', ROOT, '--installed-root', self.installed,
                   '--manifest', self.manifest, '--bridge-db', self.db, '--token-file', self.token, '--json')
        self.assertIn(done.returncode, (0, 3), done.stderr)
        report = json.loads(done.stdout)
        self.assertNotIn('a' * 32, done.stdout, 'the real extension id must not be printed')
        self.assertIn('<EXT_ID>', json.dumps(report['manifest']['origins']))
        self.assertNotIn('SECRET-TOKEN-VALUE', done.stdout)
        self.assertTrue(report['token']['present'])
        self.assertEqual(report['token']['length'], len('SECRET-TOKEN-VALUE-' + 'x' * 24))


class Verdict(unittest.TestCase):

    def setUp(self):
        self.work = tempfile.mkdtemp(prefix='t215-verdict-')
        self.addCleanup(shutil.rmtree, self.work, True)
        self.db = os.path.join(self.work, 'service.sqlite')
        build_bridge(self.db)
        self.state = os.path.join(self.work, 'state')
        os.makedirs(self.state)

    def audit(self, installed):
        manifest = os.path.join(installed, 'host_manifest.json')
        done = run(AUDIT, '--audit', '--repo-root', ROOT, '--installed-root', installed,
                   '--manifest', manifest, '--bridge-db', self.db, '--state-dir', self.state, '--json')
        return json.loads(done.stdout)

    def test_a_capable_install_is_go(self):
        installed = os.path.join(self.work, 'good')
        os.makedirs(installed)
        build_tree(installed)
        with open(os.path.join(self.state, 'terminal-arm.json'), 'w', encoding='utf-8') as handle:
            json.dump({'version': 1, 'epoch': 'e1', 'takenAt': 1793400000, 'armTakenAtMs': 1793400000123,
                       'ids': [], 'truncated': False}, handle)
        report = self.audit(installed)
        self.assertEqual(report['verdict']['decision'], 'GO', report['verdict'])
        self.assertEqual(report['state']['armPrecision'], 'ms')

    def test_an_install_without_the_epoch_binding_is_no_go_and_says_why(self):
        installed = os.path.join(self.work, 'stale')
        os.makedirs(installed)
        build_tree(installed, with_epoch_binding=False, with_relay=False, with_arm_ms=False)
        report = self.audit(installed)
        self.assertEqual(report['verdict']['decision'], 'NO-GO')
        self.assertIn('installed_host_reads_relay', report['verdict']['blocking_failed'])
        self.assertIn('installed_ext_epoch_bound', report['verdict']['blocking_failed'])
        self.assertIn('installed_host_arm_ms', report['verdict']['blocking_failed'])

    def test_a_missing_database_is_a_named_failure_not_an_empty_success(self):
        installed = os.path.join(self.work, 'good2')
        os.makedirs(installed)
        build_tree(installed)
        manifest = os.path.join(installed, 'host_manifest.json')
        done = run(AUDIT, '--audit', '--repo-root', ROOT, '--installed-root', installed, '--manifest', manifest,
                   '--bridge-db', os.path.join(self.work, 'absent.sqlite'), '--json')
        report = json.loads(done.stdout)
        self.assertIn('error', report['bridge'])
        self.assertEqual(report['verdict']['decision'], 'NO-GO')
        self.assertIn('bridge_db_readable', report['verdict']['blocking_failed'])

    def test_runs_without_a_terminal_event_are_counted_rather_than_hidden(self):
        installed = os.path.join(self.work, 'good3')
        os.makedirs(installed)
        build_tree(installed)
        report = self.audit(installed)
        self.assertEqual(report['bridge']['terminal_without_event'], 1)
        self.assertEqual(report['bridge']['terminal_runs'], 1)


class ShadowVerdicts(unittest.TestCase):

    def test_a_candidate_with_evidence_but_no_arm_is_not_called_authorised(self):
        sys.path.insert(0, os.path.join(ROOT, 'tools', 'rollout'))
        import shadow_observe
        result = {'candidates': [{'runId': 'run-1', 'status': 'completed', 'completedAt': 1793400010500,
                                  'completedAtSource': 'bridge.task_events.task.completed'}]}
        self.assertEqual(shadow_observe.classify(result, None)[0]['verdict'], 'evidence-ok (no arm supplied)')
        self.assertEqual(shadow_observe.classify(result, 1793400010500)[0]['verdict'], 'history (before consent)')
        self.assertEqual(shadow_observe.classify(result, 1793400010000)[0]['verdict'], 'would-announce')

    def test_an_unknown_source_is_deferred_in_the_shadow_view(self):
        sys.path.insert(0, os.path.join(ROOT, 'tools', 'rollout'))
        import shadow_observe
        result = {'candidates': [{'runId': 'run-2', 'status': 'completed', 'completedAt': None,
                                  'completedAtSource': 'unknown'}]}
        self.assertEqual(shadow_observe.classify(result, 1)[0]['verdict'], 'deferred (no terminal event)')


if __name__ == '__main__':
    unittest.main()
