"""A hung step, and the three ways a step can lie about passing.

The gate's job is to produce a verdict. The first version let `TimeoutExpired` escape, so
a hung suite killed the gate itself with a traceback: the run that exists to explain a
failure became an unexplained failure of its own. These cases hang on purpose, and they
check that the gate comes back with `FAIL` and a name, in bounded time, with nothing left
running.

Every case is a throwaway repository. `--step-timeout` is a real option because a test
cannot wait half an hour to find out, and because CI would rather name the hung suite than
let the job time out with no verdict at all.
"""
import io
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, 'tools', 'release_gate.py')


def free_port():
    holder = socket.socket()
    holder.bind(('127.0.0.1', 0))
    port = holder.getsockname()[1]
    holder.close()
    return port


class Tree(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='gate-hang-')
        self.addCleanup(shutil.rmtree, self.root, True)
        shutil.copytree(os.path.join(HERE, 'tools'), os.path.join(self.root, 'tools'))
        self.write('seed.py', 'VALUE = 1\n')
        self.write('test_seed_ok.py',
                   'import unittest\n'
                   'class Seed(unittest.TestCase):\n'
                   '    def test_it(self):\n'
                   '        self.assertTrue(True)\n')

    def write(self, name, body):
        with io.open(os.path.join(self.root, name), 'w', encoding='utf-8',
                     newline='\n') as handle:
            handle.write(body)

    def commit(self):
        for command in (['init', '--quiet'], ['config', 'user.email', 'f@l'],
                        ['config', 'user.name', 'f'], ['add', '-A'],
                        ['commit', '--quiet', '-m', 'x']):
            subprocess.run(['git'] + command, cwd=self.root, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)

    def gate(self, *extra, timeout=180):
        started = time.time()
        done = subprocess.run([sys.executable, '-B', GATE, '--root', self.root,
                               '--skip-worktree'] + list(extra),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=timeout)
        return (done.returncode, done.stdout.decode('utf-8', 'replace'),
                round(time.time() - started, 1))


class HungStepTest(Tree):
    def test_a_hung_suite_fails_the_gate_and_is_named(self):
        self.write('test_hang.py',
                   'import time, unittest\n'
                   'class Hang(unittest.TestCase):\n'
                   '    def test_it(self):\n'
                   '        time.sleep(600)\n')
        self.commit()
        code, out, seconds = self.gate('--step-timeout', '4')
        self.assertEqual(code, 1, out)
        self.assertIn('timed out', out)
        self.assertIn('python suite', out)
        self.assertIn('DO NOT PUSH', out)
        # Bounded by the timeout plus teardown, not by the suite's own idea of patience.
        self.assertLess(seconds, 90, 'the gate took %.1fs for a 4s step timeout' % seconds)

    def test_a_step_that_prints_a_pass_and_then_hangs_does_not_pass(self):
        """`RESULT: 5 passed, 0 failed` followed by a hang is the interesting lie: the
        summary is already on the wire, and only the timeout says otherwise."""
        self.write('test_hangpass.mjs',
                   "console.log('RESULT: 5 passed, 0 failed');\n"
                   "setTimeout(() => {}, 600000);\n")
        self.commit()
        code, out, seconds = self.gate('--step-timeout', '4')
        self.assertEqual(code, 1, out)
        self.assertIn('test_hangpass.mjs', out)
        self.assertLess(seconds, 90, 'the gate took %.1fs for a 4s step timeout' % seconds)

    def test_the_children_of_a_hung_step_are_killed_too(self):
        """The e2e suites start their own host. Killing the node process alone left that
        host holding the pipe, so the gate waited anyway.

        The child proves it is alive by counting, not by being found in a process
        listing: `wmic` is gone from current Windows images and `ps` output is a parsing
        exercise. A counter that stops moving is the fact being asserted -- the child is
        not doing work any more -- and it reads the same on both platforms.
        """
        beat = os.path.join(self.root, 'heartbeat')
        self.write('child.py',
                   'import sys, time\n'
                   'path = sys.argv[1]\n'
                   'count = 0\n'
                   'while True:\n'
                   '    count += 1\n'
                   '    open(path, "w").write(str(count))\n'
                   '    time.sleep(0.2)\n')
        self.write('test_spawn_and_hang.py',
                   'import subprocess, sys, time, unittest\n'
                   'class Spawn(unittest.TestCase):\n'
                   '    def test_it(self):\n'
                   '        subprocess.Popen([sys.executable, %r, %r])\n'
                   '        time.sleep(600)\n'
                   % ('child.py', beat))
        self.commit()
        code, out, _ = self.gate('--step-timeout', '6')
        self.assertEqual(code, 1, out)

        def counter():
            try:
                with open(beat) as handle:
                    return int(handle.read().strip() or 0)
            except (OSError, ValueError):
                return None

        deadline = time.time() + 20
        while time.time() < deadline and not counter():
            time.sleep(0.2)
        self.assertTrue(counter(), 'the child never started; the case is void')
        time.sleep(1.0)
        first = counter()
        time.sleep(2.0)
        second = counter()
        self.assertIsNotNone(second)
        self.assertEqual(first, second,
                         'the grandchild was still counting after the gate timed out '
                         '(%s -> %s): it survived the kill' % (first, second))


class ExitCodeLieTest(Tree):
    def test_a_suite_that_prints_pass_and_exits_nonzero_fails(self):
        self.write('test_lie.mjs',
                   "console.log('RESULT: 9 passed, 0 failed');\n"
                   "process.exitCode = 2;\n")
        self.commit()
        code, out, _ = self.gate()
        self.assertEqual(code, 1, out)
        self.assertIn('test_lie.mjs', out)

    def test_a_suite_that_exits_zero_without_a_summary_is_a_helper_not_a_pass(self):
        self.write('test_silent.mjs', "// imported by other suites, prints nothing\n")
        self.commit()
        code, out, _ = self.gate()
        self.assertEqual(code, 0, out)

    def test_a_helper_that_exits_nonzero_fails(self):
        self.write('test_brokenhelper.mjs', 'process.exit(7);\n')
        self.commit()
        code, out, _ = self.gate()
        self.assertEqual(code, 1, out)

    def test_a_suite_that_reports_failures_and_exits_zero_fails(self):
        self.write('test_claims.mjs', "console.log('RESULT: 1 passed, 2 failed');\n")
        self.commit()
        code, out, _ = self.gate()
        self.assertEqual(code, 1, out)
        self.assertIn('test_claims.mjs', out)


class ReportHygieneTest(Tree):
    def test_the_report_names_every_step_and_no_private_path(self):
        self.write('test_bad.py',
                   'import unittest\n'
                   'class Bad(unittest.TestCase):\n'
                   '    def test_it(self):\n'
                   '        self.assertEqual(1, 2, "deliberate")\n'
                   '    def test_also(self):\n'
                   '        self.assertIn(1, [], 2)\n')
        self.commit()
        code, out, _ = self.gate('--github')
        self.assertEqual(code, 1, out)
        # All five checks appear, pass or fail, in one table.
        for name in ('worktree', 'dependencies', 'hygiene', 'python suite',
                     'js suites'):
            self.assertIn(name, out)
        # The verdict is last and unambiguous.
        self.assertIn('DO NOT PUSH', out)
        self.assertIn('::error', out)
        # No operator path survives into a public annotation.
        self.assertNotIn(self.root, out.replace('\\r', ''))
        self.assertNotIn(tempfile.gettempdir().split(os.sep)[-1] + os.sep + 'gate-hang',
                         out)


if __name__ == '__main__':
    unittest.main()
