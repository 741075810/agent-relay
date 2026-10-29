"""The release gate's own failure behaviour, tested.

The gate exists to say "do not push". A gate that says "may be pushed" for a broken tree
is worse than no gate, because it converts an unchecked push into an apparently checked
one. Until this file there was no test of that: the gate had only ever been observed
succeeding, and the first time it mattered -- on GitHub Actions -- it was red for six
pushes while reporting, in prose, that it should have been green.

Each case below builds a small throwaway repository and runs the real gate against it. No
case touches this repository, the live extension state, or the network.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, 'tools', 'release_gate.py')


def load_gate():
    import importlib.util
    spec = importlib.util.spec_from_file_location('release_gate', GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(root, *args):
    return subprocess.run(['git'] + list(args), cwd=root, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT)


class TreeCase(unittest.TestCase):
    """A minimal repository: the tools, and whatever the case adds."""

    @classmethod
    def setUpClass(cls):
        cls.gate = load_gate()

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='gate-case-')
        self.addCleanup(shutil.rmtree, self.root, True)
        shutil.copytree(os.path.join(HERE, 'tools'), os.path.join(self.root, 'tools'))
        self.write('seed.py', 'VALUE = 1\n')
        # Every case starts with one passing test. A tree with no Python test at all
        # fails the gate on its own (unittest exits 5 and prints NO TESTS RAN), which
        # would mask whatever the case is actually about.
        self.write('test_seed_ok.py',
                   'import unittest\n'
                   'class Seed(unittest.TestCase):\n'
                   '    def test_it(self):\n'
                   '        self.assertTrue(True)\n')

    def write(self, name, body):
        path = os.path.join(self.root, name)
        with io.open(path, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(body)
        return path

    def commit_all(self):
        git(self.root, 'init', '--quiet')
        git(self.root, 'config', 'user.email', 'fixture@localhost')
        git(self.root, 'config', 'user.name', 'fixture')
        git(self.root, 'add', '-A')
        git(self.root, 'commit', '--quiet', '-m', 'fixture')
        return git(self.root, 'status', '--porcelain').stdout.strip()

    def run_gate(self, *extra):
        done = subprocess.run([sys.executable, '-B', GATE, '--root', self.root,
                               '--github'] + list(extra),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return done.returncode, done.stdout.decode('utf-8', 'replace')


class VerdictTest(TreeCase):
    def test_a_clean_tree_may_be_pushed(self):
        self.write('test_ok.py',
                   'import unittest\n'
                   'class Ok(unittest.TestCase):\n'
                   '    def test_it(self):\n'
                   '        self.assertTrue(True)\n')
        self.assertEqual(self.commit_all(), b'')
        code, out = self.run_gate()
        self.assertEqual(code, 0, out)
        self.assertIn('may be pushed', out)
        self.assertIn('::notice title=gate::', out)
        self.assertNotIn('::error', out)

    def test_a_failing_python_test_blocks_the_push(self):
        self.write('test_bad.py',
                   'import unittest\n'
                   'class Bad(unittest.TestCase):\n'
                   '    def test_it(self):\n'
                   '        self.assertEqual(1, 2, "the gate must say why")\n')
        self.commit_all()
        code, out = self.run_gate()
        self.assertEqual(code, 1, out)
        self.assertIn('DO NOT PUSH', out)
        self.assertIn('::error title=gate python suite', out)
        # The assertion, not the traceback, has to reach the annotation.
        self.assertIn('the gate must say why', out)

    def test_uncommitted_work_blocks_the_push(self):
        self.commit_all()
        self.write('scratch.py', 'VALUE = 2\n')
        code, out = self.run_gate()
        self.assertEqual(code, 1, out)
        self.assertIn('uncommitted changes', out)

    def test_the_worktree_check_can_be_set_aside_before_committing(self):
        self.write('test_ok.py',
                   'import unittest\nclass Ok(unittest.TestCase):\n'
                   '    def test_it(self):\n        pass\n')
        self.commit_all()
        self.write('uncommitted.py', 'VALUE = 3\n')
        code, out = self.run_gate('--skip-worktree')
        self.assertEqual(code, 0, out)


class JavaScriptVerdictTest(TreeCase):
    def test_a_suite_that_reports_a_failure_is_caught_even_when_it_exits_zero(self):
        """Exit code is not the only signal: a suite that prints `1 failed` and exits 0
        is a suite whose author forgot `process.exitCode`. Trusting the exit code alone
        would call that a pass."""
        self.write('test_liar.mjs',
                   "console.log('RESULT: 3 passed, 1 failed');\n")
        self.commit_all()
        code, out = self.run_gate()
        self.assertEqual(code, 1, out)
        self.assertIn('test_liar.mjs', out)
        self.assertIn('DO NOT PUSH', out)

    def test_tap_failure_is_caught(self):
        self.write('test_tap.mjs',
                   "console.log('\u2139 pass 2');\n"
                   "console.log('\u2139 fail 1');\n"
                   "process.exitCode = 1;\n")
        self.commit_all()
        code, out = self.run_gate()
        self.assertEqual(code, 1, out)
        self.assertIn('test_tap.mjs', out)

    def test_a_prefixed_count_suite_is_understood(self):
        self.write('test_prefixed.mjs', "console.log('T056: 5 passed, 0 failed');\n")
        self.commit_all()
        code, out = self.run_gate()
        self.assertEqual(code, 0, out)
        # The gate reports assertions, so a suite written with a task-id prefix has to
        # contribute to that count rather than be read as "no summary".
        self.assertIn('5 assertions', out)

    def test_a_shared_helper_is_not_counted_as_a_suite(self):
        self.write('test_helper.mjs', 'export const shared = 1;\n')
        self.commit_all()
        code, out = self.run_gate()
        self.assertEqual(code, 0, out)
        self.assertIn('0 suites', out)

    def test_a_helper_that_crashes_on_import_fails_the_gate(self):
        self.write('test_helper.mjs', "throw new Error('imported a broken helper');\n")
        self.commit_all()
        code, out = self.run_gate()
        self.assertEqual(code, 1, out)


class HygieneVerdictTest(TreeCase):
    def test_an_identifier_in_a_tracked_file_blocks_the_push(self):
        secretish = 'session-' + 'c9d8e7f6' + '-1a2b-4c3d-8e9f-' + '0a1b2c3d4e5f'
        self.write('leaky.py', "SESSION = '%s'\n" % secretish)
        self.commit_all()
        code, out = self.run_gate()
        self.assertEqual(code, 1, out)
        self.assertIn('session-id', out)
        # And the value itself must not be republished by the gate.
        self.assertNotIn(secretish, out)

    def test_an_untracked_leak_does_not_block(self):
        """It is not going anywhere: `git ls-files` is the publish set."""
        self.commit_all()
        secretish = 'session-' + 'c9d8e7f6' + '-1a2b-4c3d-8e9f-' + '0a1b2c3d4e5f'
        self.write('leaky.py', "SESSION = '%s'\n" % secretish)
        code, out = self.run_gate('--skip-worktree')
        self.assertEqual(code, 0, out)

    def test_a_tree_with_no_python_test_at_all_fails(self):
        """unittest exits 5 and prints NO TESTS RAN; an empty suite must not read as a
        pass, because "the tests passed" and "there were no tests" are different."""
        self.write('test_seed_ok.py', '# deliberately not a test module\n')
        self.commit_all()
        code, out = self.run_gate()
        self.assertEqual(code, 1, out)
        self.assertIn('python suite', out)


class ReportingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gate = load_gate()

    def test_escape_follows_the_workflow_command_rules(self):
        self.assertEqual(self.gate.github_escape('a:b,c%d\ne'),
                         'a%3Ab%2Cc%25d%0Ae')

    def test_a_posix_path_is_scrubbed_too(self):
        """Found by the Linux CI job, on its first run: the scrubber only knew drive
        letters, so a runner's `/tmp/gate-hang-xxxx` reached a public annotation."""
        for text in ('AssertionError: /tmp/gate-hang-kkc6kzxv unexpectedly found',
                     'File "/home/runner/work/agent-relay/agent-relay/x.py", line 3',
                     'at /usr/local/lib/python3.12/unittest/case.py'):
            scrubbed = self.gate.scrub(text)
            self.assertIn('<path>', scrubbed, text)
            for leaked in ('/tmp/gate-hang', 'runner', '/usr/local'):
                self.assertNotIn(leaked, scrubbed, '%s survived in %r' % (leaked, scrubbed))

    def test_a_url_keeps_its_scheme(self):
        """Over-scrubbing a URL would make a real message unreadable, and a double slash
        after a colon is not a filesystem path."""
        text = 'see https://github.com/actions/runner-images/issues/14748 for detail'
        self.assertIn('https://github.com/actions/runner-images/issues/14748',
                      self.gate.scrub(text))

    def test_a_relative_path_is_left_alone(self):
        text = '  LEAK  session-id  tools/example.py:12'
        self.assertIn('tools/example.py:12', self.gate.scrub(text))

    def test_a_path_is_scrubbed_out_of_an_annotation(self):
        two = chr(92)
        text = 'File "' + 'C:' + two + 'Users' + two + 'someone' + two + 'work.py"'
        scrubbed = self.gate.scrub(text)
        self.assertNotIn('someone', scrubbed)
        self.assertIn('<path>', scrubbed)

    def test_an_account_segment_without_a_drive_letter_is_scrubbed(self):
        """`\\Users\\name` can appear without a drive prefix, e.g. inside a longer access
        path, and ABSOLUTE_PATH alone would not touch it."""
        two = chr(92)
        text = 'opened ' + two + 'Users' + two + 'someone' + two + 'log.txt'
        scrubbed = self.gate.scrub(text)
        self.assertNotIn('someone', scrubbed)
        self.assertIn('<user>', scrubbed)

    def test_a_single_test_is_counted(self):
        """unittest prints `Ran 1 test`, singular. Requiring the plural called every
        repository with exactly one test a failure."""
        self.assertIsNotNone(self.gate.PY_RAN.search('Ran 1 test in 0.001s'))
        self.assertIsNotNone(self.gate.PY_RAN.search('Ran 17 tests in 0.4s'))

    def test_hygiene_detail_is_read_from_its_scan_step(self):
        """The rule name lives in the scan step's output, not in the part's own."""
        part = {'name': 'hygiene', 'ok': False,
                'detail': {'output': '  LEAK     session-id    f.py:1  session-a...'}}
        self.assertIn('session-id', ' '.join(self.gate.detail_lines(part)))
        self.assertIn('hygiene', self.gate.headline(part))

    def test_the_assertion_outranks_the_traceback(self):
        part = {'output': 'Traceback (most recent call last):\n'
                          '  File "x.py", line 1\n'
                          'AssertionError: 1 != 2\n'
                          'FAILED (failures=1)\n'}
        lines = self.gate.detail_lines(part)
        self.assertTrue(lines[0].startswith('AssertionError'), lines)

    def test_a_passing_suite_with_no_skips_is_not_a_failure(self):
        """unittest prints a bare `OK` when nothing was skipped. Requiring the
        parenthesised `(skipped=0)` made every clean single-test suite read as
        "neither passed nor skipped", and `NO TESTS RAN` -- which prints no summary at
        all -- has to stay distinguishable from it."""
        self.assertEqual(self.gate.python_skips('Ran 3 tests\n\nOK\n'), 0)
        self.assertEqual(self.gate.python_skips('Ran 3 tests\n\nOK (skipped=2)\n'), 2)
        self.assertIsNone(self.gate.python_skips('\nNO TESTS RAN\n'))

    def test_skips_are_counted_even_when_the_run_failed(self):
        """`FAILED (failures=1, errors=2, skipped=43)` is how unittest reports a broken
        run that also skipped. Reading only `(skipped=N)` as the whole parenthesis made
        the gate print "0 skips" for a run that skipped forty-three."""
        text = 'Ran 300 tests\n\nFAILED (failures=1, errors=2, skipped=43)\n'
        self.assertEqual(self.gate.python_skips(text), 43)
        self.assertEqual(self.gate.python_skips('Ran 3 tests\n\nFAILED (failures=1)\n'), 0)

    def test_skip_reasons_are_summarised(self):
        part = {'output': "test_a ... skipped 'no launcher'\n"
                          "test_b ... skipped 'no launcher'\n"
                          "test_c ... skipped 'no zstd'\n"}
        summary = self.gate.skip_summary(part)
        self.assertIn("2x no launcher", summary)
        self.assertIn("1x no zstd", summary)

    def test_summary_parsing_covers_every_convention(self):
        parse = self.gate.parse_summary
        self.assertEqual(parse('RESULT: 9 passed, 0 failed'), ('RESULT', 9, 0))
        self.assertEqual(parse('T056: 4 passed, 1 failed'), ('COUNT', 4, 1))
        self.assertEqual(parse('\u2139 pass 7\n\u2139 fail 0'), ('TAP', 7, 0))
        self.assertEqual(parse('RESULT: popup flow passed'), ('sentence', 0, 0))
        self.assertIsNone(parse('nothing here'))


class MissingCompressorTest(unittest.TestCase):
    """A missing optional tool is a skip with a reason, never a traceback.

    CI ran red for six pushes because the zstd fixture builder used `check=True` on a Node
    fallback that needs Node 22.15. Six tests reported errors instead of one honest skip,
    and the reason was invisible because job logs need `actions: read`.
    """

    def test_no_compressor_skips_with_the_reason(self):
        import subprocess
        import test_t069_terminal_precision as suite
        original_module = suite.zstandard
        original_run = subprocess.run

        class Failed(object):
            returncode = 1
            stdout = b''
            stderr = b"TypeError: zlib.zstdCompressSync is not a function"

        try:
            suite.zstandard = None
            # `zstd_bytes` imports subprocess inside the function, so patching the module
            # the interpreter already holds is what takes effect.
            subprocess.run = lambda *a, **k: Failed()
            with self.assertRaises(unittest.SkipTest) as caught:
                suite.zstd_bytes(b'{}')
        finally:
            suite.zstandard = original_module
            subprocess.run = original_run
        self.assertIn('22.15', str(caught.exception))
        self.assertIn('zstdCompressSync', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
