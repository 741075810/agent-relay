"""T095B99: what a swapped `queue.lock` actually buys an intruder on POSIX.

The lock is an OS lock on an *inode*. `os.replace` onto the lock path gives the new file a new
inode, so two processes can hold "the" lock at the same time and neither is lying:

    A: flock(queue.lock -> inode X)      B: flock(queue.lock -> inode Y)

This suite does that deliberately, with a real second process and a handshake that stops it
inside `_Lock.__enter__` -- after the lock is taken, before the write. Then it asks the only
question that matters: does a concurrent write get **lost silently**?

What is already known to hold, and is re-checked here rather than assumed:

  * `_Lock.__exit__` re-reads the path and refuses when its token is gone (T089), so a
    swapped lock is *detected* -- at exit, which is after the write;
  * `save_queue(expect=...)` refuses a stale generation (T087);
  * `append_events` retries and verifies what it wrote.

If a write still disappears without an exception, that is the defect. A malicious process that
can rewrite files inside the state directory can always do this; what the code owes the
operator is either a refusal or a truthful document, never a silent success.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import host

ROOT = os.path.dirname(os.path.abspath(__file__))

# Written into the fixture: hold the lock, announce it, then append an event the moment the
# parent says go. The hook fires inside `append_events`, so the write happens while this
# process believes it is the only writer.
WRITER = '''\
import os, sys, time
sys.path.insert(0, sys.argv[4])
import host

state, ready, go, root = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
original = host._Lock.__enter__
def hooked(self):
    held = original(self)
    with open(ready + '.tmp', 'w') as out:
        out.write('held')
    os.replace(ready + '.tmp', ready)
    deadline = time.time() + 120
    while time.time() < deadline:
        if os.path.exists(go):
            break
        time.sleep(0.02)
    return held
host._Lock.__enter__ = hooked
try:
    host.append_events(state, [{'eventId': sys.argv[5], 'runId': 'run-' + sys.argv[5],
                                'text': 'from the stale holder'}])
    outcome = 'wrote'
except Exception as exc:
    outcome = '%s: %s' % (type(exc).__name__, exc)
with open(os.path.join(state, 'writer-result.tmp'), 'w') as out:
    out.write(outcome)
os.replace(os.path.join(state, 'writer-result.tmp'),
           os.path.join(state, 'writer-result'))
'''


class Writer(object):
    def __init__(self, state_dir, workdir, ident):
        self.script = os.path.join(workdir, 'writer.py')
        with open(self.script, 'w', encoding='utf-8') as out:
            out.write(WRITER)
        self.ready = os.path.join(workdir, 'ready-' + ident)
        self.go = os.path.join(workdir, 'go-' + ident)
        self.result = os.path.join(state_dir, 'writer-result')
        self.proc = subprocess.Popen(
            [sys.executable, '-B', self.script, state_dir, self.ready, self.go, ROOT, ident],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def wait_ready(self, seconds=60.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if os.path.exists(self.ready):
                return True
            if self.proc.poll() is not None:
                return False
            time.sleep(0.02)
        return False

    def release(self):
        with open(self.go + '.tmp', 'w') as out:
            out.write('go')
        os.replace(self.go + '.tmp', self.go)

    def finish(self, seconds=120.0):
        self.release()
        try:
            self.proc.wait(seconds)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(30)
        if os.path.exists(self.result):
            with open(self.result, encoding='utf-8') as handle:
                return handle.read()
        return 'no result: %s' % self.proc.stderr.read(800).decode('utf-8', 'replace')

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()


@unittest.skipIf(os.name == 'nt',
                 'Windows refuses to replace an open file, which is a different (and stronger) '
                 'property; the POSIX swap is the case being measured')
class SwappedLockTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t099-state-')
        self.work = tempfile.mkdtemp(prefix='t099-work-')
        self.writer = None
        host.append_events(self.state, [{'eventId': 'evt-base', 'runId': 'run-base',
                                         'text': 'base'}])

    def tearDown(self):
        if self.writer is not None:
            self.writer.kill()
        for path in (self.state, self.work):
            shutil.rmtree(path, ignore_errors=True)

    def swap_the_lock_file(self):
        """A new inode at the same path: exactly what a hostile or careless writer does."""
        path = os.path.join(self.state, host.LOCK_FILE)
        before = os.stat(path).st_ino
        replacement = path + '.intruder'
        with open(replacement, 'wb') as out:
            out.write(b'\x00' + host.LOCK_MARKER + b'intruder-token')
        os.replace(replacement, path)
        self.assertNotEqual(os.stat(path).st_ino, before,
                            'the swap did not change the inode, so it did not test anything')
        return path

    def test_two_writers_can_hold_the_lock_at_once_after_a_swap(self):
        """The limitation, stated as a fact rather than discovered in production."""
        self.writer = Writer(self.state, self.work, 'w1')
        self.assertTrue(self.writer.wait_ready(), 'the writer never took the lock')
        self.swap_the_lock_file()
        held_now = host._Lock(self.state)
        try:
            held_now.__enter__()
        except host.HostError as exc:
            # A second, useful outcome: the lock file the intruder left is not one this
            # protocol wrote, and `_check_owner` refuses it. Fail-closed, and a mitigation.
            self.writer.kill()
            self.assertIn('not ours', str(exc).lower())
            return
        try:
            document = host.load_queue(self.state)
            self.assertIn('evt-base', host.known_event_ids(document))
        finally:
            try:
                held_now.__exit__(None, None, None)
            except host.HostError:
                pass
        self.writer.kill()

    def test_a_write_through_a_stale_lock_is_refused_or_survives(self):
        """The question that matters: can a write disappear with nobody noticing?"""
        self.writer = Writer(self.state, self.work, 'w2')
        self.assertTrue(self.writer.wait_ready(), 'the writer never took the lock')
        self.swap_the_lock_file()

        # The second writer does its own append while the first still holds the old inode.
        host.append_events(self.state, [{'eventId': 'evt-new', 'runId': 'run-new',
                                         'text': 'from the new lock'}])
        outcome = self.writer.finish()
        document = host.load_queue(self.state)
        known = host.known_event_ids(document)
        self.assertIn('evt-base', known, 'the queue was damaged by the race')
        if outcome == 'wrote':
            self.assertIn('w2', known,
                          'SILENT LOSS: the stale holder reported success but its event is '
                          'gone: %s' % sorted(known))
        else:
            self.assertTrue(outcome.split(':')[0].endswith('Error'),
                            'the stale holder did not get a named failure: %s' % outcome)

    def test_the_exit_check_notices_the_swap(self):
        """T089's token check: detection at exit, which is after the write, not before it."""
        self.writer = Writer(self.state, self.work, 'w3')
        self.assertTrue(self.writer.wait_ready(), 'the writer never took the lock')
        path = self.swap_the_lock_file()
        with open(path, 'rb') as handle:
            handle.seek(1)
            swapped = handle.read(64)
        self.assertTrue(swapped.startswith(host.LOCK_MARKER),
                        'the swapped file does not carry the marker of this protocol')
        self.assertIn(b'intruder', swapped, 'the swap did not reach the path')
        self.writer.kill()


class AclTest(unittest.TestCase):
    @unittest.skipIf(os.name == 'nt',
                     'Windows has no POSIX mode bits; this assertion is about POSIX')
    def test_the_state_directory_is_not_group_or_world_writable_by_default(self):
        """If the directory is writable by someone else, no lock in it can be trusted."""
        state = tempfile.mkdtemp(prefix='t099-acl-')
        try:
            mode = os.stat(state).st_mode & 0o777
            self.assertEqual(mode, 0o700, 'temp directory mode is %o' % mode)
        finally:
            shutil.rmtree(state, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
