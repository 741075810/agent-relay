"""The publish gate, tested.

`AGENTS.md` described this gate in prose for the whole life of the repository, and the
same file records what that cost: a genuine unpacked-extension id shipped in the first
published commit "despite a report claiming it had been replaced", because the scan the
report cited did not look for ids at all. Prose cannot be run, so it is not a gate.

Two things make this one different, and both are asserted here:

  * it proves it works (`--self-test` plants a canary per rule and requires every one to
    be caught, plus a clean file that must stay silent);
  * it runs as part of the normal suite, so a release cannot be green while the gate is
    broken or while the tree holds an unexplained identifier.

The canaries in this file are fabricated. Building them from fragments is not
decoration: this file is scanned by the scanner it tests, so a literal would be reported
against itself, and a real value pasted here "as an example" would be the leak.
"""
import io
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, 'tools', 'hygiene_scan.py')


def load_tool():
    """Load tools/hygiene_scan.py by path -- it is a script, not an installed package."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('hygiene_scan', TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def is_git_checkout(root):
    try:
        done = subprocess.run(['git', 'rev-parse', '--is-inside-work-tree'], cwd=root,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        return False
    return done.returncode == 0 and done.stdout.strip() == b'true'


BSLASH = chr(92)
FAKE_SESSION = 'session-' + 'a1b2c3d4' + '-5e6f-4a7b-8c9d-' + '0e1f2a3b4c5d'


class RuleTest(unittest.TestCase):
    """Each rule, on a fabricated canary, through the scanner's own entry point."""

    @classmethod
    def setUpClass(cls):
        cls.tool = load_tool()

    def scan(self, text, name='canary.py'):
        return self.tool.scan_text(name, text)

    def rules(self, text, name='canary.py'):
        return sorted({finding['rule'] for finding in self.scan(text, name)})

    def test_a_session_id_that_is_not_patterned_is_a_leak(self):
        findings = self.scan("SESSION = '%s'\n" % FAKE_SESSION)
        self.assertIn('session-id', self.rules("SESSION = '%s'\n" % FAKE_SESSION))
        self.assertEqual(findings[0]['severity'], 'leak')

    def test_a_patterned_session_id_passes(self):
        self.assertEqual(self.rules(
            "S = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'\n"), [])

    def test_an_escaped_path_is_visible(self):
        """The defect that hid a real interpreter path for months.

        Source code stores one separator as two characters, so a rule written for a
        single literal separator never matched. This asserts the rule still tolerates
        the escaped form; the naive pattern is asserted to fail on the same text, so the
        test cannot pass by accident if someone rewrites it that way again.
        """
        two = BSLASH + BSLASH
        text = 'RUN = r"E:' + two + 'program' + two + 'python312"\n'
        self.assertIn('windows-path', self.rules(text))
        naive = re.compile(r'[A-Za-z]:[\\][A-Za-z0-9_.$~-]+')
        self.assertIsNone(naive.search(text),
                          'a single-separator rule must not match this text, which is '
                          'why the old gate could not see it')

    def test_a_forward_slash_path_is_visible(self):
        text = "const H = '" + 'E:' + '/' + 'machine' + '/' + 'tree' + "';\n"
        self.assertIn('windows-path', self.rules(text, 'canary.mjs'))

    def test_a_user_directory_is_a_leak(self):
        two = BSLASH + BSLASH
        findings = self.scan('{"p": "' + 'C:' + two + 'Users' + two + 'x"}')
        self.assertIn('windows-user-path', [f['rule'] for f in findings])
        self.assertEqual([f['severity'] for f in findings
                          if f['rule'] == 'windows-user-path'], ['leak'])

    def test_a_self_evidently_synthetic_extension_id_passes(self):
        self.assertEqual(self.rules(
            "O = 'chrome-extension://" + 'a' * 32 + "'\n"), [])

    def test_a_random_looking_extension_id_is_reported(self):
        ident = 'abcdefghijklmnop' * 2
        self.assertIn('extension-id', self.rules("O = 'chrome-extension://" + ident + "'\n"))

    def test_findings_are_masked(self):
        """A finding must not become the leak it reports: CI logs are public."""
        findings = self.scan("SESSION = '%s'\n" % FAKE_SESSION)
        excerpt = findings[0]['excerpt']
        self.assertNotIn(FAKE_SESSION, excerpt)
        self.assertNotIn('0e1f2a3b4c5d', excerpt)
        self.assertIn('...', excerpt)

    def test_a_clean_file_produces_nothing(self):
        text = ("CONV = '11111111-1111-4111-8111-111111111111'\n"
                "O = 'chrome-extension://" + 'a' * 32 + "'\n")
        self.assertEqual(self.scan(text), [])


class AllowlistTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = load_tool()

    def parse(self, body):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, '.hygiene-allow.txt')
            with io.open(path, 'w', encoding='utf-8') as handle:
                handle.write(body)
            return self.tool.load_allowlist(root)

    def test_an_entry_without_a_reason_is_refused(self):
        with self.assertRaises(ValueError):
            self.parse('windows-path  some/file.py\n')

    def test_an_entry_with_a_reason_is_accepted(self):
        entries = self.parse('# comment\n\nwindows-path  some/file.py  a real reason\n')
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['rule'], 'windows-path')
        self.assertEqual(entries[0]['reason'], 'a real reason')

    def test_a_stale_entry_is_detected(self):
        """An entry that excuses nothing is how an exception outlives its value."""
        allowlist = [{'rule': 'windows-path', 'path': 'gone.py', 'reason': 'r'}]
        findings = [{'rule': 'windows-path', 'path': 'other.py', 'line': 1,
                     'severity': 'review', 'excerpt': 'x', 'why': 'w'}]
        self.assertEqual(len(self.tool.stale_entries(allowlist, findings)), 1)
        findings.append({'rule': 'windows-path', 'path': 'gone.py', 'line': 2,
                         'severity': 'review', 'excerpt': 'x', 'why': 'w'})
        self.assertEqual(self.tool.stale_entries(allowlist, findings), [])


class TreeTest(unittest.TestCase):
    """The gate applied to the tree that would actually be published."""

    @classmethod
    def setUpClass(cls):
        cls.tool = load_tool()

    def test_self_test_passes(self):
        done = subprocess.run([sys.executable, '-B', TOOL, '--self-test'],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(done.returncode, 0, done.stdout.decode('utf-8', 'replace'))

    def test_the_published_tree_has_no_unexplained_finding(self):
        if not is_git_checkout(HERE):
            self.skipTest('not a git checkout: the publish gate answers for the '
                          'repository, and this directory is a working copy')
        done = subprocess.run([sys.executable, '-B', TOOL, '--all', '--root', HERE],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        output = done.stdout.decode('utf-8', 'replace')
        self.assertEqual(done.returncode, 0,
                         'the tree that would be published is not clean:\n' + output)
        self.assertIn('0 unexplained', output)
        self.assertIn('0 stale', output)

    def test_only_source_and_config_are_scanned(self):
        """A document that explains these patterns has to contain them."""
        if not is_git_checkout(HERE):
            self.skipTest('not a git checkout')
        names = [name for name, _full in self.tool.iter_tracked(HERE)]
        self.assertTrue(names)
        self.assertIn('host.py', names)
        self.assertNotIn('AGENTS.md', names)
        self.assertFalse(any(name.endswith('.md') for name in names))

    def test_the_gate_scans_itself_once_it_is_would_be_published(self):
        """The scanner must be in its own scan set, or it could carry the very thing it
        forbids. Before `git add` it legitimately is not: the publish set is `git
        ls-files`, so an untracked file is not going out. This asserts the two views
        agree rather than asserting a race against the staging area."""
        if not is_git_checkout(HERE):
            self.skipTest('not a git checkout')
        names = [name for name, _full in self.tool.iter_tracked(HERE)]
        rel_tool = os.path.relpath(TOOL, HERE).replace('\\', '/')
        if rel_tool in names:
            return
        others = subprocess.run(['git', 'ls-files', '--others', '--exclude-standard',
                                 rel_tool], cwd=HERE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
        self.assertTrue(others.stdout.strip(),
                        'the scanner exists on disk but git reports it as neither '
                        'tracked nor untracked: the publish set and the tree disagree')

    def test_ignored_scratch_is_not_scanned(self):
        """`inbox_*` holds locally-scoped probes and is gitignored; a gate that fails on
        someone's scratch file is a gate that gets switched off."""
        if not is_git_checkout(HERE):
            self.skipTest('not a git checkout')
        names = [name for name, _full in self.tool.iter_tracked(HERE)]
        self.assertFalse(any(os.path.basename(name).startswith('inbox') for name in names))


if __name__ == '__main__':
    unittest.main()
