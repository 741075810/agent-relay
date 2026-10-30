"""T095B95: the boundaries of the tree kill T094 added.

T094 replaced "find the tree through the parent's pid" with ownership: a Windows job object
with `KILL_ON_JOB_CLOSE`, and a pre-created session on POSIX. That closed the reported
failure. These are the edges it did not address, and each is pinned here:

  * the job handle is opened on every step and was closed only on the timeout path, so a
    normal run leaked one handle per step -- and a leaked handle means `KILL_ON_JOB_CLOSE`
    never fires while the gate lives;
  * when the job cannot be created at all (an external job already owns the process, an
    older Windows, a permission problem) the fallback is `taskkill /T`, which has exactly the
    weakness the job was introduced to fix. Reporting that as ordinary cleanup would be a
    claim the code cannot support.
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools', 'release_gate.py')


def load_gate():
    spec = importlib.util.spec_from_file_location('release_gate_under_test', GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GATE_MODULE = load_gate()


class JobBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t095-gate-')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_normal_step_does_not_leak_its_job_handle(self):
        outcome = GATE_MODULE.run([sys.executable, '-B', '-c', 'print("ok")'],
                                  cwd=self.root, timeout=60)
        self.assertEqual(outcome['returncode'], 0, outcome['output'])
        open_jobs = getattr(GATE_MODULE, '_OPEN_JOBS', None)
        self.assertIsNotNone(open_jobs, 'the gate keeps no record of open job handles, so a '
                                        'leak cannot be seen at all')
        self.assertEqual(open_jobs, set(),
                         'a job handle stayed open after the step finished')

    def test_a_job_that_cannot_be_created_is_not_reported_as_cleanup(self):
        """The fallback has the old weakness; the outcome has to say so."""
        real = GATE_MODULE._assign_job

        def refuse(proc):
            return None

        GATE_MODULE._assign_job = refuse
        try:
            started = time.time()
            outcome = GATE_MODULE.run([sys.executable, '-B', '-c',
                                       'import time; time.sleep(120)'],
                                      cwd=self.root, timeout=2)
            seconds = time.time() - started
        finally:
            GATE_MODULE._assign_job = real
        self.assertTrue(outcome['timeout'])
        self.assertLess(seconds, 90)
        self.assertIn('cleanup_guaranteed', outcome,
                      'the gate does not report whether the tree kill could be guaranteed')
        self.assertFalse(outcome['cleanup_guaranteed'],
                         'a best-effort fallback was reported as guaranteed cleanup')
        self.assertEqual(outcome['tree_kill'], 'best_effort')

    def test_a_job_that_is_created_is_reported_as_guaranteed(self):
        if os.name != 'nt':
            self.skipTest('job objects are a Windows mechanism')
        outcome = GATE_MODULE.run([sys.executable, '-B', '-c',
                                   'import time; time.sleep(120)'],
                                  cwd=self.root, timeout=2)
        self.assertTrue(outcome['timeout'])
        self.assertTrue(outcome['cleanup_guaranteed'], outcome)
        self.assertEqual(outcome['tree_kill'], 'job')

    def test_a_command_that_does_not_exist_fails_before_any_job_exists(self):
        with self.assertRaises(OSError):
            GATE_MODULE.run(['definitely-not-a-real-command-t095'], cwd=self.root, timeout=5)
        self.assertEqual(GATE_MODULE._OPEN_JOBS, set())

    def test_two_descendants_holding_the_pipe_are_both_killed(self):
        helper = os.path.join(self.root, 'helper.py')
        with open(helper, 'w', encoding='utf-8') as out:
            out.write('import os, sys, time\n'
                      'lock = sys.argv[1]\n'
                      'handle = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)\n'
                      'if os.name == "nt":\n'
                      '    import msvcrt\n'
                      '    if os.fstat(handle).st_size == 0:\n'
                      '        os.write(handle, b"0")\n'
                      '    os.lseek(handle, 0, os.SEEK_SET)\n'
                      '    msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)\n'
                      'else:\n'
                      '    import fcntl\n'
                      '    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)\n'
                      'time.sleep(300)\n')
        first = os.path.join(self.root, 'first.lock')
        second = os.path.join(self.root, 'second.lock')
        spawner = ('import subprocess, sys, time\n'
                   'subprocess.Popen([sys.executable, %r, %r])\n'
                   'subprocess.Popen([sys.executable, %r, %r])\n'
                   'time.sleep(300)\n' % (helper, first, helper, second))
        thread = __import__('threading').Thread(
            target=lambda: GATE_MODULE.run([sys.executable, '-B', '-c', spawner],
                                           cwd=self.root, timeout=4))
        thread.start()

        def held(path):
            try:
                handle = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
            except OSError:
                return False
            try:
                if os.name == 'nt':
                    import msvcrt
                    if os.fstat(handle).st_size == 0:
                        os.write(handle, b'0')
                    os.lseek(handle, 0, os.SEEK_SET)
                    msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(handle)
                return True
            os.close(handle)
            return False

        deadline = time.time() + 20
        while time.time() < deadline and not (held(first) and held(second)):
            time.sleep(0.2)
        self.assertTrue(held(first) and held(second), 'the helpers never started')
        thread.join(120)
        deadline = time.time() + 20
        while time.time() < deadline and (held(first) or held(second)):
            time.sleep(0.2)
        self.assertFalse(held(first), 'the first helper survived the kill')
        self.assertFalse(held(second), 'the second helper survived the kill')


if __name__ == '__main__':
    unittest.main()
