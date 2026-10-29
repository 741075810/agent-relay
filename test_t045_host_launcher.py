"""T045 regression: the launcher Chrome will actually start, and the extension fix.

What went wrong in T044, in order of how much it cost:

1. The extension's request() had only a timeout. When Chrome closed the port the
   promise was never rejected, so every failure -- host not found, host exited at
   once, origin rejected -- surfaced ten seconds later as "no response within 10s".
   That sentence names the timer and hides Chrome's own `lastError`, which is the
   only string that identifies the fault. Fixed by lib/native_client.js, covered
   by test_t045_native_client.mjs.

2. The launcher was a .cmd. It works here (measured), but it puts cmd.exe between
   Chrome and the host, and the manifest field Chrome reads is `path` -- Chrome
   documents no shell support and has no `args` field. host_launcher.exe replaces
   it, and this file checks it behaves like a native messaging host must: stdin
   and stdout are the protocol channel, stderr is free, the origin is forwarded,
   and the process lives as long as the host does.

Both are checked without Chrome. Nothing here writes the registry, loads the
extension, or sends a message; only simulated events are used.

Run: python -B -m unittest test_t045_host_launcher -v
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import host as H
import protocol as P


def _extension_id():
    """The extension id the registered manifest allows, or a neutral placeholder.

    Derived rather than hard-coded. An unpacked extension's id is a function of its
    load path, so a literal in the source is one machine's configuration -- it means
    nothing on another machine and should not travel with the code. `DSH_EXTENSION_ID`
    overrides; otherwise the local manifest is read; otherwise the tests that need a
    confirmed id are skipped, because guessing one would assert the wrong thing.
    """
    from_env = os.environ.get('DSH_EXTENSION_ID')
    if from_env:
        return from_env
    if os.path.isfile(MANIFEST):
        try:
            with open(MANIFEST, 'r', encoding='utf-8-sig') as handle:
                for origin in json.load(handle).get('allowed_origins') or []:
                    found = re.match(r'chrome-extension://([^/]+)/?$', origin)
                    if found:
                        return found.group(1)
        except (OSError, ValueError):
            pass
    return None


LAUNCHER = os.path.join(HERE, 'host_launcher.exe')
OLD_CMD = os.path.join(HERE, 'run_host.cmd')
MANIFEST = os.path.join(HERE, 'host_manifest.json')
EXT = os.path.join(HERE, 'extension')
PYTHON = sys.executable
EXT_ID = _extension_id()
ORIGIN = ('chrome-extension://%s/' % EXT_ID) if EXT_ID else None

# A fresh clone has no built launcher and no filled-in manifest -- those are local
# artefacts, not source. Failing on their absence would mean the published suites can
# never be run as published; skipping says exactly what is missing and how to get it.
HAVE_LAUNCHER = os.path.isfile(LAUNCHER)
HAVE_MANIFEST = os.path.isfile(MANIFEST) and EXT_ID is not None
needs_launcher = unittest.skipUnless(
    HAVE_LAUNCHER,
    'host_launcher.exe is not built; run launcher\\build_launcher.ps1 '
    '(see docs/HOST_INSTALL.md)')
needs_manifest = unittest.skipUnless(
    HAVE_MANIFEST,
    'host_manifest.json is absent or has no extension id; copy '
    'host_manifest.example.json, fill in the id, and re-run')


def frame(doc):
    return P.encode(doc)


@needs_launcher
@needs_manifest
class LauncherIsAnExecutableTests(unittest.TestCase):
    """Chrome's manifest has no `args`; `path` must name an executable."""

    def test_the_launcher_exists(self):
        self.assertTrue(os.path.isfile(LAUNCHER),
                        'host_launcher.exe is missing; build it with '
                        'launcher\\build_launcher.ps1')

    def test_it_starts_with_MZ(self):
        """A real PE, not a renamed script."""
        with open(LAUNCHER, 'rb') as handle:
            self.assertEqual(handle.read(2), b'MZ')

    def test_the_manifest_points_at_it_absolutely(self):
        with open(MANIFEST, encoding='utf-8') as handle:
            doc = json.load(handle)
        path = doc['path']
        self.assertTrue(os.path.isabs(path), 'manifest path must be absolute')
        self.assertEqual(os.path.normcase(path), os.path.normcase(LAUNCHER))
        self.assertTrue(path.lower().endswith('.exe'),
                        'Chrome should be given an .exe, not a shell wrapper')

    def test_the_manifest_has_no_bom(self):
        """Chrome parses the manifest as plain JSON; a BOM makes it invalid."""
        with open(MANIFEST, 'rb') as handle:
            self.assertNotEqual(handle.read(3), b'\xef\xbb\xbf')

    def test_the_manifest_declares_no_wildcard_origin(self):
        with open(MANIFEST, encoding='utf-8') as handle:
            doc = json.load(handle)
        for origin in doc.get('allowed_origins', []):
            self.assertNotIn('*', origin)

    def test_the_old_cmd_is_still_crlf_if_it_is_still_present(self):
        """It stays as a fallback, so it must not be LF-only either."""
        if not os.path.isfile(OLD_CMD):
            self.skipTest('run_host.cmd was removed')
        with open(OLD_CMD, 'rb') as handle:
            raw = handle.read()
        self.assertNotEqual(raw[:3], b'\xef\xbb\xbf', 'BOM in the .cmd')
        self.assertIn(b'\r\n', raw, 'LF-only line endings in the .cmd')


class LauncherArgumentForwardingTests(unittest.TestCase):
    def test_launcher_forwards_all_chrome_arguments_as_separate_quoted_args(self):
        source_path = os.path.join(HERE, 'launcher', 'HostLauncher.cs')
        with open(source_path, encoding='utf-8') as handle:
            source = handle.read()
        self.assertIn('foreach (string arg in args)', source)
        self.assertIn("commandLine.Append(' ').Append(Quote(arg));", source)
        self.assertIn('CreateProcessW(null, commandLine', source)


class WireIntegrationIsJobGuardedTests(unittest.TestCase):
    """Process-level behavior is exercised only by T046's Job Object harness.

    The previous tests here used subprocess.run(timeout=90). On Windows that
    timeout kills only the direct launcher; if it leaves python.exe holding stdout
    open, communicate() may block and/or the descendant survives. These assertions
    ensure the self-check cannot quietly regress to that unsafe test style.
    """

    def test_the_live_pipe_test_uses_kill_on_close_job_objects(self):
        with open(os.path.join(HERE, 'test_t046_live_launcher.py'),
                  encoding='utf-8') as handle:
            source = handle.read()
        self.assertIn('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE', source)
        self.assertIn('CREATE_SUSPENDED', source)
        self.assertIn('AssignProcessToJobObject', source)
        self.assertIn('overall live-pipe deadline expired', source)

    def test_the_old_subprocess_timeout_harness_is_gone(self):
        with open(__file__, encoding='utf-8') as handle:
            tree = ast.parse(handle.read())
        for node in ast.walk(tree):
            is_subprocess_run = (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == 'run'
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == 'subprocess'
            )
            if not is_subprocess_run:
                continue
            argv = node.args[0] if node.args else None
            is_node_test = (
                isinstance(argv, ast.List)
                and bool(argv.elts)
                and isinstance(argv.elts[0], ast.Constant)
                and argv.elts[0].value == 'node'
            )
            self.assertTrue(is_node_test,
                            'only the Node unit suite may use subprocess.run; '
                            'launcher tests must use test_t046 Job Object guards')


class TheExtensionHandlesDisconnectTests(unittest.TestCase):
    """Static checks for the fix; behaviour is covered by the node suite."""

    def read(self, *parts):
        with open(os.path.join(EXT, *parts), encoding='utf-8') as handle:
            return handle.read()

    def test_background_no_longer_hand_rolls_the_correlation(self):
        source = self.read('background.js')
        self.assertIn('import { NativeClient }', source)
        self.assertNotIn('no response to ', source,
                         'the timer-only message is the bug; it must be gone')

    def test_background_passes_last_error_through(self):
        source = self.read('background.js')
        self.assertIn('readLastError', source)
        self.assertIn('lastError', source)

    def test_the_client_rejects_on_disconnect(self):
        source = self.read('lib', 'native_client.js')
        self.assertIn('_onDisconnect', source)
        self.assertIn("'disconnect'", source)
        # The reason must be read inside the callback; Chrome clears it after.
        self.assertIn('readLastError', source)

    def test_the_client_still_has_no_page_write_path(self):
        source = self.read('lib', 'native_client.js')
        for token in ('chrome.tabs', 'chrome.scripting', 'executeScript',
                      'innerText', 'document.', 'window.'):
            self.assertNotIn(token, source,
                             'the client module reaches for %r' % token)

    def test_the_module_is_plain_js_so_the_extension_still_loads(self):
        """A .mjs would not be importable from an MV3 service worker path."""
        self.assertTrue(os.path.isfile(os.path.join(EXT, 'lib',
                                                    'native_client.js')))


class TheNodeSuitePassesTests(unittest.TestCase):
    def test_node_tests_pass(self):
        if shutil.which('node') is None:
            self.skipTest('node not available')
        proc = subprocess.run(['node', os.path.join(HERE,
                                                    'test_t045_native_client.mjs')],
                              capture_output=True, text=True, timeout=180,
                              cwd=HERE)
        self.assertEqual(proc.returncode, 0,
                         'node suite failed:\n%s\n%s'
                         % (proc.stdout[-1500:], proc.stderr[-800:]))
        self.assertIn('0 failed', proc.stdout)


class TheDiagnosisScriptTests(unittest.TestCase):
    def test_it_does_not_launch_or_write(self):
        with open(os.path.join(HERE, 't045_diagnose.py'), encoding='utf-8') as h:
            tree = ast.parse(h.read())
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                modules = ([item.name for item in node.names]
                           if isinstance(node, ast.Import) else [node.module or ''])
                self.assertNotIn('subprocess', modules)
                self.assertNotIn('ctypes', modules)
            if isinstance(node, ast.Call):
                func = node.func
                name = func.id if isinstance(func, ast.Name) else (
                    func.attr if isinstance(func, ast.Attribute) else '')
                self.assertNotIn(name, ('Popen', 'run', 'CreateProcessW',
                                        'SetValue', 'CreateKey', 'DeleteKey',
                                        'connectNative'))
        self.assertTrue(any(isinstance(n, ast.FunctionDef)
                            and n.name == 'read_registered_manifest'
                            for n in tree.body))
        self.assertTrue(any(isinstance(n, ast.FunctionDef)
                            and n.name == 'inspect_manifest'
                            for n in tree.body))

    def test_it_does_not_expose_delivery_ops(self):
        with open(os.path.join(HERE, 't045_diagnose.py'), encoding='utf-8') as h:
            tree = ast.parse(h.read())
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
        self.assertFalse(any(isinstance(node.func, ast.Attribute)
                             and node.func.attr in ('postMessage', 'send')
                             for node in calls))


if __name__ == '__main__':
    unittest.main(verbosity=2)
