"""T241: configured install bytes, unchecked config and Chrome runtime are separate facts.

All directories are temporary. No browser, private profile, production state, service or network.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

from test_release_gate import load_gate
from test_t095b240_extension_deploy_sync import deploy, make_extension, tree_hashes, write

HERE = Path(__file__).resolve().parent


class PreflightCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='t241-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / '仓库 with spaces'
        self.source = self.root / 'extension'
        self.target = Path(self.temp.name) / '安装 extension'
        make_extension(str(self.source))
        shutil.copytree(self.source, self.target)
        self.gate = load_gate()
        self.env = dict(os.environ)
        for key in deploy.INSTALL_ENV:
            self.env.pop(key, None)

    def report(self, **kwargs):
        return deploy.preflight(str(self.source), str(self.target), environ={}, **kwargs)

    def cli(self, *extra, configured=False):
        env = dict(self.env, PYTHONIOENCODING='cp1252')
        args = ['--source', str(self.source), '--preflight']
        if configured:
            env['DSH_EXTENSION_INSTALL'] = str(self.target)
        return subprocess.run([sys.executable, '-B', str(HERE / 'tools' / 'extension_deploy_sync.py')]
                              + args + list(extra), env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=30)

    def gate_part(self, require=False, configured=True):
        # The copied tools must compare this fixture root, not their original checkout.
        shutil.copytree(HERE / 'tools', self.root / 'tools', dirs_exist_ok=True)
        env = dict(self.env)
        if configured:
            env['DSH_EXTENSION_INSTALL'] = str(self.target)
        with mock.patch.dict(os.environ, env, clear=True):
            return self.gate.extension_install(str(self.root), require)

    def render_part(self, part, mode='text'):
        result = {'ok': part['ok'], 'parts': [part], 'clean_clone': None}
        stream = io.StringIO()
        with mock.patch.object(self.gate, 'gate', return_value=result), contextlib.redirect_stdout(stream):
            code = self.gate.main([] if mode == 'text' else ['--' + mode])
        return code, stream.getvalue()

    def test_missing_config_is_unchecked_and_reads_nothing(self):
        with mock.patch.object(deploy, '_preflight_snapshot', side_effect=AssertionError('unexpected read')):
            report = deploy.preflight(str(self.source), environ={})
        self.assertEqual((report['state'], report['checked'], report['code']),
                         ('unchecked', False, 'missing_config'))
        self.assertIn('NOT compared', report['marker'])
        self.assertEqual(report['loaded_runtime'], 'unknown')

    def test_normal_consistency_is_disk_only_and_read_only(self):
        before = tree_hashes(self.temp.name)
        report = self.report()
        self.assertEqual(report['state'], 'in_sync')
        self.assertEqual(report['differing_count'], 0)
        self.assertEqual(report['loaded_runtime'], 'unknown')
        self.assertIn('Chrome loaded runtime UNKNOWN', report['marker'])
        self.assertEqual(before, tree_hashes(self.temp.name))

    def test_drift_has_exact_marker_full_hashes_and_no_writes(self):
        write(str(self.source / 'background.js'), 'console.log("new source");\n')
        before = tree_hashes(self.temp.name)
        report = self.report()
        self.assertEqual(report['state'], 'drift')
        self.assertEqual(report['marker'], deploy.DRIFT_MARKER)
        self.assertEqual(report['differing'], ['background.js'])
        self.assertEqual(len(report['differences'][0]['source']), 64)
        self.assertEqual(len(report['differences'][0]['target']), 64)
        self.assertEqual(before, tree_hashes(self.temp.name))

    def test_stamp_only_change_is_drift_even_if_tree_digest_matches(self):
        write(str(self.target / 'lib' / 'build_stamp.js'), "const BUILD_STAMP = 'T112-00000000';\n")
        report = self.report()
        self.assertTrue(report['stamp_match'])
        self.assertEqual(report['state'], 'drift')
        self.assertEqual(report['differing'], ['lib/build_stamp.js'])

    def test_crlf_is_raw_byte_drift_not_false_byte_equality(self):
        file = self.target / 'background.js'
        file.write_bytes(file.read_bytes().replace(b'\n', b'\r\n'))
        self.assertEqual(self.report()['state'], 'drift')

    def test_missing_and_extra_files_are_both_reported(self):
        (self.target / 'popup.html').unlink()
        write(str(self.target / 'old.js'), 'old\n')
        report = self.report()
        self.assertEqual({row['state'] for row in report['differences']}, {'missing', 'extra'})

    def test_env_precedence_blank_values_and_no_parent_mutation(self):
        env = {'DSH_EXTENSION_INSTALL': '  ', 'T218_INSTALLED_EXT': str(self.target)}
        before = dict(env)
        self.assertEqual(deploy.configured_target(env), str(self.target))
        self.assertEqual(env, before)
        env['DSH_EXTENSION_INSTALL'] = str(self.source / 'missing')
        self.assertEqual(deploy.preflight(str(self.source), environ=env)['state'], 'unchecked')
        self.assertEqual(deploy.configured_target(env), env['DSH_EXTENSION_INSTALL'])

    def test_explicit_target_overrides_an_invalid_environment_target(self):
        env = {'DSH_EXTENSION_INSTALL': str(self.source / 'missing')}
        self.assertEqual(deploy.preflight(str(self.source), str(self.target), env)['state'], 'in_sync')

    def test_profiles_are_rejected_before_content_access(self):
        for root in ('User Data', 'Local Extension Settings', 'Sync Extension Settings'):
            target = Path(self.temp.name) / root / 'Default'
            with mock.patch.object(deploy, '_preflight_snapshot', side_effect=AssertionError('profile read')):
                report = deploy.preflight(str(self.source), str(target), {})
            self.assertEqual(report['code'], 'profile_path')

    def test_same_directory_and_nested_directory_are_unchecked(self):
        for target in (self.source, self.source / 'child'):
            target.mkdir(exist_ok=True)
            report = deploy.preflight(str(self.source), str(target), {})
            self.assertEqual(report['code'], 'overlapping_directories')
            self.assertFalse(report['checked'])

    def test_windows_reparse_attributes_are_rejected_before_content_access(self):
        original = os.lstat
        def lstat(path, *args, **kwargs):
            if os.path.normcase(str(path)) == os.path.normcase(str(self.target)):
                info = original(path, *args, **kwargs)
                return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return original(path, *args, **kwargs)
        with mock.patch.object(os, 'lstat', side_effect=lstat), mock.patch.object(
                deploy, '_preflight_snapshot', side_effect=AssertionError('reparse read')):
            report = self.report()
        self.assertEqual(report['code'], 'unsafe_link')

    def test_nested_file_reparse_point_is_not_hashed(self):
        real_scandir = os.scandir
        class Entry:
            def __init__(self, entry):
                self.name, self.path, self.entry = entry.name, entry.path, entry
            def stat(self, **kwargs):
                info = self.entry.stat(**kwargs)
                return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
        @contextlib.contextmanager
        def scan(path):
            with real_scandir(path) as entries:
                yield [Entry(item) if item.name == 'background.js' else item for item in entries]
        with mock.patch.object(os, 'scandir', side_effect=scan), mock.patch.object(
                deploy, 'sha256_file', side_effect=AssertionError('linked file read')):
            self.assertEqual(self.report()['code'], 'unsafe_link')

    def test_missing_source_and_missing_manifest_are_not_in_sync(self):
        shutil.rmtree(self.source)
        self.assertEqual(self.report()['state'], 'unchecked')
        make_extension(str(self.source))
        (self.target / 'manifest.json').unlink()
        self.assertEqual(self.report()['code'], 'missing_manifest')

    def test_malformed_manifest_and_scan_errors_remain_unchecked(self):
        write(str(self.target / 'manifest.json'), '[]')
        self.assertEqual(self.report()['code'], 'invalid_manifest')
        with mock.patch.object(os, 'scandir', side_effect=PermissionError('denied')):
            report = self.report()
        self.assertEqual((report['state'], report['code']), ('unchecked', 'read_failed'))

    def test_concurrent_change_is_not_a_successful_snapshot(self):
        actual = deploy._preflight_snapshot
        calls = 0
        def snapshot(root):
            nonlocal calls
            calls += 1
            result = actual(root)
            if calls == 3:
                result['background.js'] = 'changed'
            return result
        with mock.patch.object(deploy, '_preflight_snapshot', side_effect=snapshot):
            self.assertEqual(self.report()['code'], 'files_changed_during_check')

    def test_cli_three_json_reports_and_windows_codepage(self):
        result = self.cli('--json')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(json.loads(result.stdout)['code'], 'missing_config')
        result = self.cli('--json', configured=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['target'], str(self.target))
        write(str(self.source / '中文 script.js'), 'changed\n')
        result = self.cli('--json', configured=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)['state'], 'drift')
        text = self.cli(configured=True)
        self.assertEqual(text.returncode, 1, text.stderr)
        self.assertIn(deploy.DRIFT_MARKER.encode('ascii'), text.stdout)
        self.assertEqual(text.stderr, b'')

    def test_preflight_rejects_every_write_option_without_copying(self):
        before = tree_hashes(self.temp.name)
        for option in (['--apply'], ['--sync-manifest'], ['--backup-dir', str(self.target / 'backup')]):
            result = self.cli(*option, configured=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn(b'read-only', result.stderr)
        self.assertEqual(before, tree_hashes(self.temp.name))

    def test_gate_missing_config_is_skip_not_pass_and_strict_fails(self):
        part = self.gate_part(configured=False)
        self.assertEqual((part['mark'], part['detail']['checked']), ('SKIP', False))
        code, text = self.render_part(part)
        self.assertEqual(code, 0)
        self.assertIn('SKIP', text)
        self.assertIn('NOT compared', text)
        self.assertEqual(self.gate_part(require=True, configured=False)['mark'], 'FAIL')

    def test_gate_consistent_is_pass_but_loaded_generation_unknown(self):
        part = self.gate_part()
        self.assertEqual(part['mark'], 'PASS')
        self.assertEqual(part['detail']['source'], str(self.source))
        self.assertIn('Chrome loaded runtime UNKNOWN', self.render_part(part)[1])

    def test_gate_drift_warns_optional_and_fails_required(self):
        write(str(self.source / 'background.js'), 'changed\n')
        for require, mark in ((False, 'WARN'), (True, 'FAIL')):
            part = self.gate_part(require=require)
            self.assertEqual(part['mark'], mark)
            self.assertIn(deploy.DRIFT_MARKER, self.render_part(part)[1])

    def test_gate_configured_missing_install_fails_not_skip(self):
        shutil.rmtree(self.target)
        part = self.gate_part()
        self.assertFalse(part['ok'])
        self.assertEqual(part['mark'], 'FAIL')
        self.assertFalse(part['detail']['checked'])

    def test_gate_json_preserves_each_install_status_and_runtime_scope(self):
        for state in ('unchecked', 'in_sync', 'drift'):
            if state == 'drift':
                write(str(self.source / 'background.js'), 'changed\n')
            part = self.gate_part(configured=state != 'unchecked')
            code, text = self.render_part(part, 'json')
            parsed = json.loads(text)['parts'][0]
            self.assertEqual(parsed['detail']['state'], state)
            self.assertEqual(parsed['mark'], part['mark'])
            self.assertEqual(parsed['detail']['loaded_runtime'], 'unknown')
            self.assertEqual(code, 0)

    def test_github_reports_skip_and_drift_without_private_paths(self):
        for configured in (False, True):
            if configured:
                write(str(self.source / 'background.js'), 'changed\n')
            part = self.gate_part(configured=configured)
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                self.gate.github_report({'ok': part['ok'], 'parts': [part], 'clean_clone': None})
            text = stream.getvalue()
            self.assertIn('title=gate install', text)
            self.assertNotIn(self.temp.name, text)
            self.assertNotIn(str(self.target), text)
            if configured:
                self.assertIn('::warning', text)
                self.assertIn(self.gate.github_escape(deploy.DRIFT_MARKER), text)
            else:
                self.assertIn('missing_config', text)

    def test_required_error_annotations_preserve_code_not_path(self):
        part = {'name': 'install', 'ok': False, 'mark': 'FAIL',
                'detail': {'state': 'unchecked', 'code': 'read_failed',
                           'marker': 'private ' + str(self.target)}}
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            self.gate.github_report({'ok': False, 'parts': [part], 'clean_clone': None})
        self.assertIn('read_failed', stream.getvalue())
        self.assertNotIn(str(self.target), stream.getvalue())

    def test_subprocess_json_shape_exit_mismatch_and_timeout_fail_closed(self):
        shutil.copytree(HERE / 'tools', self.root / 'tools')
        valid = self.report()
        cases = [(document, 0, False) for document in ('[]', 'null', '{}', '{',
                  json.dumps({'state': 'in_sync'}))]
        cases += [(json.dumps(valid), 1, False), (json.dumps(valid), 0, True)]
        for output, rc, timeout in cases:
            answer = {'output': output, 'returncode': rc, 'timeout': timeout}
            with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(
                    self.gate, 'run', return_value=answer):
                part = self.gate.extension_install(str(self.root))
            self.assertEqual((part['mark'], part['detail']['code']), ('FAIL', 'preflight_failed'))

    def test_git_head_reference_is_only_claimed_for_clean_extension_bytes(self):
        for command in (['init', '-q'], ['config', 'user.name', 'fixture'],
                        ['config', 'user.email', 'fixture@localhost'], ['add', 'extension'],
                        ['commit', '-qm', 'fixture']):
            result = subprocess.run(['git'] + command, cwd=self.root, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)
        part = self.gate_part()
        self.assertTrue(part['detail']['source_matches_head'])
        self.assertEqual(part['detail']['source_reference'], 'HEAD')
        self.assertEqual(len(part['detail']['source_head']), 40)
        write(str(self.source / 'uncommitted.js'), 'changed\n')
        part = self.gate_part()
        self.assertFalse(part['detail']['source_matches_head'])
        self.assertEqual(part['detail']['source_reference'], 'working_tree')
        (self.source / 'uncommitted.js').unlink()
        write(str(self.root / '.gitignore'), 'extension/ignored.js\n')
        write(str(self.source / 'ignored.js'), 'not HEAD\n')
        part = self.gate_part()
        self.assertFalse(part['detail']['source_matches_head'])
        self.assertEqual(part['detail']['source_reference'], 'working_tree')

    def test_test_children_do_not_inherit_either_install_opt_in(self):
        sentinel = {'DSH_EXTENSION_INSTALL': 'DO_NOT_READ_PRIMARY',
                    'T218_INSTALLED_EXT': 'DO_NOT_READ_LEGACY'}
        with mock.patch.dict(os.environ, sentinel):
            before = dict(os.environ)
            env = self.gate.child_env()
            self.assertTrue(all(key not in env for key in sentinel))
            result = self.gate.run([sys.executable, '-B', '-c',
                                   'import os; print(os.environ.get("DSH_EXTENSION_INSTALL")); '
                                   'print(os.environ.get("T218_INSTALLED_EXT"))'], str(self.root))
            self.assertEqual(result['output'].strip().splitlines(), ['None', 'None'])
            self.assertEqual(dict(os.environ), before)

    def test_existing_fixture_gate_launchers_isolate_ambient_config(self):
        import test_release_gate
        import test_release_gate_timeout
        answer = types.SimpleNamespace(returncode=0, stdout=b'fixture')
        with mock.patch.dict(os.environ, {'DSH_EXTENSION_INSTALL': 'DO_NOT_READ',
                                         'T218_INSTALLED_EXT': 'DO_NOT_READ'}):
            ordinary = test_release_gate.TreeCase('runTest')
            ordinary.root = str(self.root)
            with mock.patch.object(subprocess, 'run', return_value=answer) as called:
                ordinary.run_gate()
                env = called.call_args.kwargs['env']
                self.assertTrue(all(key not in env for key in deploy.INSTALL_ENV))
            timeout = test_release_gate_timeout.Tree('runTest')
            timeout.root = str(self.root)
            with mock.patch.object(subprocess, 'run', return_value=answer) as called:
                timeout.gate()
                env = called.call_args.kwargs['env']
                self.assertTrue(all(key not in env for key in deploy.INSTALL_ENV))


if __name__ == '__main__':
    unittest.main()
