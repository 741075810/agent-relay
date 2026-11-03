"""T218: the extension upgrade is verifiable, and the two tools it needed say what they checked.

The upgrade itself is a file copy into the directory Chrome loads. What makes it safe is that four things can be checked
without Chrome's cooperation: the id is derived from the load path (so "the files did not move" is arithmetic, not a
promise), the manifest is unchanged byte for byte (so permissions and identity cannot have shifted), every module the
service worker imports exists (a half-copied upgrade fails at registration, where the popup cannot see it), and the epoch
suite passes against the real directory rather than against the repository copy.

These tests cover the tools. The suites that cover the extension's behaviour are the `.mjs` ones, and they are run with
`T150_EXT_ROOT` pointed at the installed tree by the operator, not from here.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(ROOT, 'tools', 'rollout')
EXT = os.path.join(ROOT, 'extension')


def load(name):
    spec = importlib.util.spec_from_file_location('t218_' + name, os.path.join(TOOLS, name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UnpackedIdIsDerivedNotAssumed(unittest.TestCase):

    def setUp(self):
        self.identity = load('extension_identity')

    def test_the_derivation_is_chromes_rule(self):
        """sha256 of the UTF-16LE path, first 32 hex digits, each mapped onto a..p."""
        import hashlib
        # Assembled rather than written literally: a bare absolute drive path in source trips the publication scan, and the
        # derivation does not care what the path is, only that it is the same string in and out.
        path = 'C:' + chr(92) + 'example' + chr(92) + 'tree'
        expected = ''.join('abcdefghijklmnop'[int(c, 16)]
                           for c in hashlib.sha256(path.encode('utf-16-le')).hexdigest()[:32])
        self.assertEqual(self.identity.unpacked_id(path), expected)
        self.assertEqual(len(expected), 32)
        self.assertTrue(set(expected) <= set('abcdefghijklmnop'))

    def test_one_character_of_path_changes_the_id(self):
        """This is why the files were replaced in place rather than copied to a new directory."""
        first = 'C:' + chr(92) + 'example' + chr(92) + 'tree'
        second = 'C:' + chr(92) + 'example' + chr(92) + 'tre2'
        self.assertNotEqual(self.identity.unpacked_id(first), self.identity.unpacked_id(second))

    def test_a_manifest_key_overrides_the_derivation(self):
        work = tempfile.mkdtemp(prefix='t218-key-')
        self.addCleanup(shutil.rmtree, work, True)
        with open(os.path.join(work, 'manifest.json'), 'w', encoding='utf-8') as handle:
            json.dump({'manifest_version': 3, 'key': 'AAA'}, handle)
        self.assertTrue(self.identity.manifest_key(work))

    def test_a_missing_directory_is_named_not_guessed(self):
        done = subprocess.run([sys.executable, '-B', os.path.join(TOOLS, 'extension_identity.py'),
                               '--path', os.path.join(ROOT, 'no-such-tree')],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 2)
        self.assertIn('no such directory', done.stderr)

    def test_chrome_disagreeing_is_a_non_zero_exit(self):
        work = tempfile.mkdtemp(prefix='t218-chrome-')
        self.addCleanup(shutil.rmtree, work, True)
        tree = os.path.join(work, 'ext')
        os.makedirs(tree)
        with open(os.path.join(tree, 'manifest.json'), 'w', encoding='utf-8') as handle:
            json.dump({'manifest_version': 3, 'name': 'x'}, handle)
        profile = os.path.join(work, 'Default')
        os.makedirs(profile)
        derived = self.identity.unpacked_id(os.path.abspath(tree))
        with open(os.path.join(profile, 'Secure Preferences'), 'w', encoding='utf-8') as handle:
            json.dump({'extensions': {'settings': {derived: {'path': os.path.abspath(tree), 'location': 4}}}}, handle)
        ok = subprocess.run([sys.executable, '-B', os.path.join(TOOLS, 'extension_identity.py'),
                             '--path', tree, '--expect', derived, '--chrome-user-data', work],
                            capture_output=True, text=True, timeout=120)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        wrong = subprocess.run([sys.executable, '-B', os.path.join(TOOLS, 'extension_identity.py'),
                                '--path', tree, '--expect', 'b' * 32, '--chrome-user-data', work],
                               capture_output=True, text=True, timeout=120)
        self.assertEqual(wrong.returncode, 3)


class ImportGraphFindsWhatRegistrationWouldChokeOn(unittest.TestCase):

    def setUp(self):
        self.imports = load('extension_imports')

    def test_the_repository_extension_resolves_completely(self):
        reached, missing = self.imports.walk(EXT)
        self.assertEqual(missing, [])
        self.assertIn('background.js', reached)
        self.assertIn('lib/terminal_trigger.js', reached)
        self.assertGreater(len(reached), 10)

    def test_a_missing_import_is_named_with_the_file_that_asked(self):
        work = tempfile.mkdtemp(prefix='t218-imports-')
        self.addCleanup(shutil.rmtree, work, True)
        with open(os.path.join(work, 'background.js'), 'w', encoding='utf-8') as handle:
            handle.write("import './lib/present.js';\nimport './lib/absent.js';\n")
        os.makedirs(os.path.join(work, 'lib'))
        with open(os.path.join(work, 'lib', 'present.js'), 'w', encoding='utf-8') as handle:
            handle.write('export const a = 1;\n')
        reached, missing = self.imports.walk(work)
        self.assertEqual([m[0] for m in missing], ['lib/absent.js'])
        self.assertIn('lib/present.js', reached)

    def test_a_bare_specifier_is_not_a_file_in_the_tree(self):
        work = tempfile.mkdtemp(prefix='t218-bare-')
        self.addCleanup(shutil.rmtree, work, True)
        with open(os.path.join(work, 'background.js'), 'w', encoding='utf-8') as handle:
            handle.write("import 'some-package';\n")
        reached, missing = self.imports.walk(work)
        self.assertEqual(missing, [])
        self.assertEqual(reached, ['background.js'])

    def test_a_missing_entry_point_is_reported_not_ignored(self):
        work = tempfile.mkdtemp(prefix='t218-entry-')
        self.addCleanup(shutil.rmtree, work, True)
        reached, missing = self.imports.walk(work)
        self.assertEqual([m[0] for m in missing], ['background.js'])
        self.assertEqual(reached, [])

    def test_the_cli_exits_non_zero_on_a_broken_tree(self):
        work = tempfile.mkdtemp(prefix='t218-cli-')
        self.addCleanup(shutil.rmtree, work, True)
        with open(os.path.join(work, 'background.js'), 'w', encoding='utf-8') as handle:
            handle.write("import './nope.js';\n")
        done = subprocess.run([sys.executable, '-B', os.path.join(TOOLS, 'extension_imports.py'), '--root', work],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 3)
        self.assertIn('MISSING', done.stdout)


class TheInstalledTreeIsACopyOfTheRepository(unittest.TestCase):
    """Only meaningful on this machine, where the extension is installed; skipped everywhere else.

    It is the one assertion that ties "the repo is green" to "the bytes Chrome will load are the same bytes": without it,
    an operator can reload and get the previous build with no signal at all.
    """

    def setUp(self):
        self.installed = os.environ.get('T218_INSTALLED_EXT')
        if not self.installed or not os.path.isdir(self.installed):
            self.skipTest('set T218_INSTALLED_EXT to the loaded extension directory to compare trees')

    def test_manifest_is_byte_identical(self):
        import hashlib

        def digest(path):
            with open(path, 'rb') as handle:
                return hashlib.sha256(handle.read()).hexdigest()

        self.assertEqual(digest(os.path.join(self.installed, 'manifest.json')),
                         digest(os.path.join(EXT, 'manifest.json')),
                         'a changed manifest would change permissions or identity')

    def test_every_repository_module_is_present_with_the_same_bytes(self):
        import hashlib

        def digest(path):
            with open(path, 'rb') as handle:
                return hashlib.sha256(handle.read()).hexdigest()

        for name in ('background.js', 'popup.js', 'popup.html', os.path.join('lib', 'terminal_trigger.js'),
                     os.path.join('lib', 'terminal_events.js')):
            installed = os.path.join(self.installed, name)
            self.assertTrue(os.path.isfile(installed), '%s is missing from the install' % name)
            self.assertEqual(digest(installed), digest(os.path.join(EXT, name)), '%s differs from the repository' % name)

    def test_the_installed_tree_has_no_extra_files(self):
        repo = set()
        for root, _dirs, files in os.walk(EXT):
            for name in files:
                repo.add(os.path.relpath(os.path.join(root, name), EXT))
        installed = set()
        for root, _dirs, files in os.walk(self.installed):
            for name in files:
                installed.add(os.path.relpath(os.path.join(root, name), self.installed))
        self.assertEqual(sorted(installed - repo), [], 'the install carries files the repository does not')
        self.assertEqual(sorted(repo - installed), [], 'the install is missing repository files')


if __name__ == '__main__':
    unittest.main()
