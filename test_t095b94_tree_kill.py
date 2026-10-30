"""T095B94: what the gate's tree kill actually guarantees.

T088 saw `test_the_children_of_a_hung_step_are_killed_too` fail now and then, with the
grandchild still working after the gate had given up. The cause is not slowness, it is the
shape of the kill: the tree is found **through the direct child's pid**, and the direct child
is exactly the process that may already be gone in the case this code exists for -- a suite
that spawns a helper and exits, while the helper holds the output pipe open. On POSIX
`os.getpgid(pid)` then raises and the fallback `proc.kill()` does nothing; on Windows
`taskkill /T` needs the parent alive to walk the tree.

The helper here holds an **operating-system lock** instead of counting heartbeats: the lock is
held for exactly as long as the process exists, so "is it dead" becomes "can the lock be
taken", which is a fact rather than a sample. A second process, deliberately outside the
step's tree, keeps its own lock and must survive.
"""
import os
import subprocess
import sys
import tempfile
import time
import unittest

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools', 'release_gate.py')

HOLDER = '''\
import os, sys, time
path = sys.argv[1]
handle = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
if os.name == 'nt':
    import msvcrt
    if os.fstat(handle).st_size == 0:
        os.write(handle, b'0')
    os.lseek(handle, 0, os.SEEK_SET)
    msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
else:
    import fcntl
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
os.write(handle, str(os.getpid()).encode())
while True:
    time.sleep(0.5)
'''

SPAWN_AND_EXIT = '''\
import subprocess, sys, unittest
class SpawnAndLeave(unittest.TestCase):
    def test_it(self):
        subprocess.Popen([sys.executable, %r, %r])
        # No sleep: this suite is done. The helper it started keeps the pipe open.
'''


def take_lock(path):
    """Try to hold the same lock; returns the handle, or None when somebody else holds it."""
    handle = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
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
        return None
    return handle


def release(handle):
    if handle is None:
        return
    try:
        if os.name == 'nt':
            import msvcrt
            os.lseek(handle, 0, os.SEEK_SET)
            msvcrt.locking(handle, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_UN)
    except OSError:
        pass
    os.close(handle)


class Tree(object):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t094-tree-')
        self.holder = os.path.join(self.root, 'hold.py')
        with open(self.holder, 'w', encoding='utf-8') as out:
            out.write(HOLDER)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, name, text):
        path = os.path.join(self.root, name)
        with open(path, 'w', encoding='utf-8') as out:
            out.write(text)
        return path

    def commit(self):
        for command in (['git', 'init', '-q'],
                        ['git', 'add', '-A'],
                        ['git', '-c', 'user.name=t', '-c', 'user.email=t@t',
                         'commit', '-qm', 'tree']):
            subprocess.run(command, cwd=self.root, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)

    def gate(self, timeout=180):
        return subprocess.run([sys.executable, '-B', GATE, '--root', self.root,
                               '--skip-worktree', '--step-timeout', '5'],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=timeout)

    def wait_for_free(self, lock_path, seconds=15.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            handle = take_lock(lock_path)
            if handle is not None:
                release(handle)
                return True
            time.sleep(0.2)
        return False

    def wait_for_held(self, lock_path, seconds=20.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if os.path.exists(lock_path) and take_lock(lock_path) is None:
                return True
            time.sleep(0.1)
        return False


class OrphanTest(Tree, unittest.TestCase):
    def test_a_helper_outlives_a_step_whose_direct_child_exits(self):
        """The gate must kill a tree even when the process it knows the pid of is gone."""
        held = os.path.join(self.root, 'held.lock')
        self.write('test_spawn_and_exit.py', SPAWN_AND_EXIT % (self.holder, held))
        self.commit()
        done = self.gate()
        out = done.stdout.decode('utf-8', 'replace')
        self.assertEqual(done.returncode, 1, out)
        self.assertIn('timed out', out)
        self.assertTrue(self.wait_for_free(held, 15.0),
                        'the helper was still alive after the gate returned: the tree kill '
                        'lost it because the direct child had already exited')

    def test_a_process_outside_the_step_is_not_killed(self):
        """Proof that the kill is scoped: a bystander holding its own lock survives."""
        bystander_lock = os.path.join(self.root, 'bystander.lock')
        bystander = subprocess.Popen([sys.executable, self.holder, bystander_lock])
        try:
            self.assertTrue(self.wait_for_held(bystander_lock, 20.0),
                            'the bystander never started; the case is void')
            held = os.path.join(self.root, 'held.lock')
            self.write('test_spawn_and_exit.py', SPAWN_AND_EXIT % (self.holder, held))
            self.commit()
            done = self.gate()
            self.assertEqual(done.returncode, 1, done.stdout.decode('utf-8', 'replace'))
            self.assertIsNone(bystander.poll(),
                              'an unrelated process was killed by the gate')
            self.assertIsNone(take_lock(bystander_lock) and None)
            handle = take_lock(bystander_lock)
            self.assertIsNone(handle, 'the bystander lost its lock')
        finally:
            bystander.kill()
            bystander.wait(10)


if __name__ == '__main__':
    unittest.main()
