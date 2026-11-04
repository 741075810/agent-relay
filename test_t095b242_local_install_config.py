"""T242: normal gate resolves private repo-local install config across independent processes."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from test_release_gate import load_gate
from test_t095b240_extension_deploy_sync import make_extension, write

HERE = Path(__file__).resolve().parent
KEY = 'agentrelay.extensionInstall'


class LocalInstallConfig(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='t242-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / '仓库 with spaces'
        self.target = Path(self.temp.name) / '实际 安装 copy'
        make_extension(str(self.root / 'extension'))
        shutil.copytree(self.root / 'extension', self.target)
        shutil.copytree(HERE / 'tools', self.root / 'tools')
        write(str(self.root / 'test_seed.py'),
              'import unittest\nclass Seed(unittest.TestCase):\n    def test_ok(self): pass\n')
        self.env = dict(os.environ)
        for name in ('DSH_EXTENSION_INSTALL', 'T218_INSTALLED_EXT'):
            self.env.pop(name, None)
        self.git('init', '-q')
        self.git('config', '--local', 'user.name', 'fixture')
        self.git('config', '--local', 'user.email', 'fixture@localhost')
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')
        self.gate = load_gate()

    def git(self, *args, cwd=None, check=True):
        result = subprocess.run(['git', *args], cwd=cwd or self.root, env=self.env,
                                capture_output=True, encoding='utf-8')
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def configure(self):
        self.git('config', '--local', '--replace-all', KEY, str(self.target))

    def part(self, env=None):
        with mock.patch.dict(os.environ, self.env if env is None else env, clear=True):
            return self.gate.extension_install(str(self.root))

    def fresh_gate(self, env=None):
        # A real new process, real main(), normal options: no target argument or install environment.
        return subprocess.run([sys.executable, '-B', str(self.root / 'tools' / 'release_gate.py'), '--json'],
                              cwd=self.temp.name, env=self.env if env is None else env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    def test_normal_gate_in_fresh_process_reads_local_config_and_passes(self):
        self.configure()
        result = self.fresh_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        part = next(item for item in report['parts'] if item['name'] == 'install')
        self.assertEqual((part['mark'], part['detail']['state']), ('PASS', 'in_sync'))
        self.assertEqual(part['detail']['configured_by'], 'git-local:' + KEY)
        self.assertEqual(part['detail']['target'], str(self.target))
        self.assertEqual(part['detail']['loaded_runtime'], 'unknown')

    def test_local_drift_warns_and_missing_target_fails_not_skip(self):
        self.configure()
        write(str(self.target / 'background.js'), 'old install\n')
        self.assertEqual(self.part()['mark'], 'WARN')
        shutil.rmtree(self.target)
        self.assertEqual(self.part()['mark'], 'FAIL')

    def test_env_override_has_priority_and_does_not_change_local_setting(self):
        self.configure()
        env = dict(self.env, DSH_EXTENSION_INSTALL=str(self.target / 'missing'))
        part = self.part(env)
        self.assertEqual(part['mark'], 'FAIL')
        self.assertEqual(part['detail']['configured_by'], 'DSH_EXTENSION_INSTALL')
        self.assertEqual(self.git('config', '--local', '--get', KEY).stdout.strip(), str(self.target))

    def test_global_config_is_not_an_install_opt_in(self):
        global_file = Path(self.temp.name) / 'global-config'
        global_file.write_text('[agentrelay]\n\textensionInstall = SHOULD_NOT_READ\n', encoding='utf-8')
        env = dict(self.env, GIT_CONFIG_GLOBAL=str(global_file))
        part = self.part(env)
        self.assertEqual((part['mark'], part['detail']['code']), ('SKIP', 'missing_config'))

    def test_clone_does_not_copy_private_config_and_config_is_untracked(self):
        self.configure()
        self.assertNotIn('.git/config', self.git('ls-files').stdout.splitlines())
        self.assertEqual(self.git('status', '--porcelain').stdout.strip(), '')
        clone = Path(self.temp.name) / 'clone'
        self.git('clone', '-q', str(self.root), str(clone))
        self.assertEqual(self.git('config', '--local', '--get', KEY, cwd=clone, check=False).returncode, 1)
        with mock.patch.dict(os.environ, self.env, clear=True):
            self.assertEqual(self.gate.extension_install(str(clone))['mark'], 'SKIP')

    def test_read_failure_is_unchecked_failure_not_false_skip(self):
        original = self.gate.run
        def run(command, cwd, *args, **kwargs):
            if command[:2] == ['git', 'config']:
                return {'returncode': 128, 'output': '', 'timeout': False}
            return original(command, cwd, *args, **kwargs)
        with mock.patch.object(self.gate, 'run', side_effect=run):
            part = self.part()
        self.assertEqual((part['mark'], part['detail']['code']), ('FAIL', 'local_config_failed'))

    def test_unset_rolls_back_to_unchecked_without_environment_mutation(self):
        self.configure()
        with mock.patch.dict(os.environ, self.env, clear=True):
            before = dict(os.environ)
            self.assertEqual(self.gate.extension_install(str(self.root))['mark'], 'PASS')
            self.assertEqual(dict(os.environ), before)
        self.git('config', '--local', '--unset-all', KEY)
        self.assertEqual(self.part()['mark'], 'SKIP')

    def test_run_has_no_visible_child_console(self):
        if os.name != 'nt':
            result = self.gate.run([sys.executable, '-B', '-c', 'print("posix")'], str(self.root))
            self.assertEqual(result['returncode'], 0)
            return
        code = ('import ctypes,json; k=ctypes.WinDLL("kernel32"); u=ctypes.WinDLL("user32"); '
                'k.GetConsoleWindow.restype=ctypes.c_void_p; '
                'u.IsWindowVisible.argtypes=[ctypes.c_void_p]; '
                'h=k.GetConsoleWindow(); print(json.dumps({"console":bool(h),'
                '"visible":bool(h and u.IsWindowVisible(h))}))')
        result = self.gate.run([sys.executable, '-B', '-c', code], str(self.root))
        self.assertEqual(result['returncode'], 0)
        self.assertEqual(json.loads(result['output']), {'console': False, 'visible': False})


if __name__ == '__main__':
    unittest.main()
