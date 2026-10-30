"""T095B105: the token update happens in place, so a short write leaves a token nobody wrote.

T104 stopped truncating the lock file: the acquisition now overwrites the 16-byte token in
place. `os.write` returning a short count was never checked, so a partial write -- a full disk,
a quota, a filesystem that declines the rest -- leaves the first k bytes of this acquisition's
token in a file that still carries the marker. `__exit__` then looks for `self.token`, does not
find it, and reports "the file was replaced while this write held it": a false accusation of
lock theft when the truth is "the disk would not take the bytes".

The distinction matters more than the write: a misdiagnosis here sends an operator hunting a
host that does not exist, which is the failure this repository's AGENTS.md names explicitly
("fail closed, and say which way you failed").

Scenarios below are all real writes to a real file in an anonymous temp directory; `os.write` is
replaced only for the length of the token, and restored in tearDown.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import host

ROOT = os.path.dirname(os.path.abspath(__file__))
TOKEN_LEN = 16


class ShortWriteTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t105-state-')
        self.path = os.path.join(self.state, host.LOCK_FILE)
        self.original = host.os.write

    def tearDown(self):
        host.os.write = self.original
        shutil.rmtree(self.state, ignore_errors=True)

    def shorten(self, take, always=False):
        """Cut the token write down to `take` bytes; other writes pass through unchanged."""
        def writer(fd, data):
            if len(data) == TOKEN_LEN:
                return self.original(fd, bytes(data[:take]))
            return self.original(fd, data)
        host.os.write = writer
        return always

    def stored_token(self):
        with open(self.path, 'rb') as handle:
            blob = handle.read(128)
        offset = 1 + len(host.LOCK_MARKER) + 1
        return blob[offset:offset + TOKEN_LEN], blob

    def test_a_short_token_write_is_completed_before_the_write_is_trusted(self):
        """One short write must not be the end of it: retry until the token is whole."""
        lock = host._Lock(self.state)
        self.shorten(TOKEN_LEN // 3)
        with lock:
            host.save_queue(self.state, {'events': [], 'acked': [], 'next_seq': 0})
        host.os.write = self.original
        stored, blob = self.stored_token()
        self.assertTrue(blob.startswith(b'\x00' + host.LOCK_MARKER), blob[:32])
        self.assertEqual(stored, lock.token,
                         'the file kept a partial token, so the next __exit__ would call this '
                         'a swap: stored=%r expected=%r' % (stored, lock.token))

    def test_a_write_that_never_progresses_is_named_and_the_lock_is_released(self):
        """No progress is a refusal, not a partial token, and not a swap allegation."""
        lock = host._Lock(self.state)
        self.shorten(0)                     # every attempt reports zero bytes written
        with self.assertRaises(host.HostError) as caught:
            lock.__enter__()
        host.os.write = self.original
        message = str(caught.exception).lower()
        self.assertIn('token', message, str(caught.exception))
        self.assertNotIn('replaced', message,
                         'zero progress must not be reported as lock theft: %s'
                         % caught.exception)
        # The OS lock must be free again: another acquisition in this process has to succeed.
        with host._Lock(self.state):
            host.save_queue(self.state, {'events': [], 'acked': [], 'next_seq': 0})
        stored, _blob = self.stored_token()
        self.assertNotEqual(stored, b'\x00' * TOKEN_LEN)

    def test_a_partial_token_left_by_a_dead_process_does_not_block_the_next_writer(self):
        """A crashed process can leave the first bytes of its token; that must be harmless."""
        lock = host._Lock(self.state)
        with lock:
            pass                            # an ordinary acquisition and release
        offset = 1 + len(host.LOCK_MARKER) + 1
        with open(self.path, 'r+b') as handle:
            handle.seek(offset)
            handle.write(lock.token[:5] + b'\x00' * (TOKEN_LEN - 5))
        with host._Lock(self.state) as second:
            pass                            # the acquisition must succeed despite the residue
        # Read only after release: on Windows a second handle on a lock file held by this
        # process is refused, which is why every check here runs outside the critical section.
        after, blob = self.stored_token()
        self.assertTrue(blob.startswith(b'\x00' + host.LOCK_MARKER), blob[:32])
        self.assertEqual(after, second.token,
                         'the residue was never replaced; a partial token stayed on disk')

    def test_a_real_swap_is_still_reported_as_a_swap(self):
        """The other direction: a token that genuinely went away must not be excused."""
        lock = host._Lock(self.state)
        lock.__enter__()
        offset = 1 + len(host.LOCK_MARKER) + 1
        with open(self.path, 'r+b') as handle:
            handle.seek(offset)
            handle.write(b'f' * TOKEN_LEN)
        with self.assertRaises(host.HostError) as caught:
            lock.__exit__(None, None, None)
        self.assertIn('replaced', str(caught.exception).lower())
        host.os.link = host.os.link


KILLER = '''\
import os, sys
sys.path.insert(0, sys.argv[3])
import host

state, flag, root = sys.argv[1], sys.argv[2], sys.argv[3]
original = os.write
def writer(fd, data):
    if len(data) == 16:
        original(fd, bytes(data[:3]))       # a third of the token, then die
        with open(flag, 'w') as out:
            out.write('partial')
        os._exit(9)
    return original(fd, data)
host.os.write = writer
try:
    with host._Lock(state):
        with open(flag + '.wrong', 'w') as out:
            out.write('the critical section was entered with a partial token')
        os._exit(10)
except Exception as exc:
    with open(flag + '.error', 'w') as out:
        out.write('%s: %s' % (type(exc).__name__, exc))
'''


class CrashMidTokenTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t105-crash-')
        self.work = tempfile.mkdtemp(prefix='t105-work-')
        self.children = []

    def tearDown(self):
        for proc in self.children:
            if proc.poll() is None:
                proc.kill()
            try:
                proc.wait(30)
            except subprocess.TimeoutExpired:
                proc.kill()
        for path in (self.state, self.work):
            shutil.rmtree(path, ignore_errors=True)

    def wait_file(self, path, seconds=60.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if os.path.exists(path):
                with open(path, encoding='utf-8') as handle:
                    return handle.read()
            if any(proc.poll() is not None for proc in self.children) and not os.path.exists(path):
                return None
            time.sleep(0.02)
        return None

    def test_a_process_killed_mid_token_leaves_a_lock_the_next_one_can_take(self):
        flag = os.path.join(self.work, 'flag')
        script = os.path.join(self.work, 'killer.py')
        with open(script, 'w', encoding='utf-8') as out:
            out.write(KILLER)
        proc = subprocess.Popen([sys.executable, '-B', script, self.state, flag, ROOT],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(proc)
        seen = self.wait_file(flag)
        proc.wait(60)
        self.assertEqual(seen, 'partial', 'the child never reached the token write')
        self.assertFalse(os.path.exists(flag + '.wrong'),
                         'the critical section was entered after a partial token')
        self.assertEqual(proc.returncode, 9)
        # The OS released the dead process's lock; a new writer must get in, and must leave a
        # whole token behind.
        with host._Lock(self.state) as lock:
            pass
        stored, _blob = self.stored_token_bytes()
        self.assertEqual(stored, lock.token)

    def stored_token_bytes(self):
        path = os.path.join(self.state, host.LOCK_FILE)
        with open(path, 'rb') as handle:
            blob = handle.read(128)
        offset = 1 + len(host.LOCK_MARKER) + 1
        return blob[offset:offset + TOKEN_LEN], blob


if __name__ == '__main__':
    unittest.main()
