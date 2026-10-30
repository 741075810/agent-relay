"""T095B98: can the preflight see a lock that another process is holding?

T097 could not answer this: the case was skipped with the reason "a holder in another process
was not seen". A skip is not an answer, and the report around it was rightly treated as a
limitation rather than a proof. This suite builds the missing evidence.

The holder is a real second process. It announces itself **after** taking the lock, through a
file that is written to a temporary name and renamed, so the parent cannot read a half-written
handshake. The holder also records, from inside its own process, which byte offsets it sees as
blocked -- that is the fact that tells us whether the probe is asking about the same byte the
host locked. Nothing here terminates a real host: every process started here is started by this
file and killed in tearDown.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import time

import host

ROOT = os.path.dirname(os.path.abspath(__file__))
PREFLIGHT = os.path.join(ROOT, 'tools', 'upgrade_preflight.py')

HOLDER = '''\
import json, os, sys, time
sys.path.insert(0, sys.argv[3])
import host

state, ready, root = sys.argv[1], sys.argv[2], sys.argv[3]
lock = host._Lock(state)
lock.__enter__()
report = {'pid': os.getpid(), 'lock_file': host.LOCK_FILE}
path = os.path.join(state, host.LOCK_FILE)
info = {'size': os.path.getsize(path)}
if os.name == 'nt':
    import msvcrt
    handle = os.open(path, os.O_RDWR)
    blocked = []
    for offset in range(0, 9):
        try:
            os.lseek(handle, offset, os.SEEK_SET)
            msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
            msvcrt.locking(handle, msvcrt.LK_UNLCK, 1)
        except OSError:
            blocked.append(offset)
    os.close(handle)
    info['blocked_offsets'] = blocked
else:
    import fcntl
    handle = os.open(path, os.O_RDWR)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(handle, fcntl.LOCK_UN)
        info['blocked_offsets'] = []
    except OSError:
        info['blocked_offsets'] = ['flock']
    os.close(handle)
report['own_process'] = info
with open(ready + '.tmp', 'w') as out:
    json.dump(report, out)
os.replace(ready + '.tmp', ready)
time.sleep(300)
'''


def preflight(state_dir, stopped=False, extra=()):
    command = [sys.executable, '-B', PREFLIGHT, '--state', state_dir, '--json']
    if stopped:
        command.append('--host-stopped')
    command.extend(extra)
    done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          timeout=300)
    try:
        report = json.loads(done.stdout.decode('utf-8', 'replace'))
    except ValueError:
        report = {'verdict': '<unparseable>', 'process_exit': done.returncode,
                  'output': done.stdout.decode('utf-8', 'replace')[:600]}
    report['process_exit'] = done.returncode
    return report


class Holder(object):
    """A second process that holds the lock and says so, once it really does."""

    def __init__(self, state_dir, workdir):
        self.script = os.path.join(workdir, 'holder.py')
        with open(self.script, 'w', encoding='utf-8') as out:
            out.write(HOLDER)
        self.ready = os.path.join(workdir, 'ready.json')
        self.proc = subprocess.Popen(
            [sys.executable, '-B', self.script, state_dir, self.ready, ROOT],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def wait_ready(self, seconds=60.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if os.path.exists(self.ready):
                with open(self.ready, encoding='utf-8') as handle:
                    return json.load(handle)
            if self.proc.poll() is not None:
                break
            time.sleep(0.05)
        return {'error': self.proc.stderr.read(2000).decode('utf-8', 'replace')}

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(30)
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass


class CrossProcessTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t098-state-')
        self.work = tempfile.mkdtemp(prefix='t098-work-')
        self.holder = None
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'run-1',
                                         'text': 'fixture'}])

    def tearDown(self):
        if self.holder is not None:
            self.holder.stop()
        for path in (self.state, self.work):
            shutil.rmtree(path, ignore_errors=True)

    def start_holder(self):
        self.holder = Holder(self.state, self.work)
        ready = self.holder.wait_ready()
        self.assertNotIn('error', ready, 'the holder never announced itself: %s' % (ready,))
        self.assertIsNone(self.holder.proc.poll(), 'the holder died after announcing itself')
        return ready

    def test_a_lock_held_by_another_process_is_seen_and_blocks_approval(self):
        ready = self.start_holder()
        report = preflight(self.state, stopped=True)
        self.assertIs(report['lock'].get('held_by_a_process'), True,
                      'the probe did not see a lock held by pid %s: %s'
                      % (ready.get('pid'), {'holder': ready.get('own_process'),
                                            'report': report.get('lock'),
                                            'reasons': report.get('reasons')}))
        self.assertNotEqual(report['verdict'], 'safe_to_start',
                            'a state whose lock is held by another process was approved')
        self.assertIn('holding the queue lock', ' '.join(report['reasons']).lower())

    def test_an_attestation_does_not_override_a_live_holder(self):
        self.start_holder()
        attested = preflight(self.state, stopped=True)
        plain = preflight(self.state, stopped=False)
        self.assertNotEqual(attested['verdict'], 'safe_to_start')
        self.assertNotEqual(plain['verdict'], 'safe_to_start')

    def test_after_the_holder_is_gone_the_attestation_is_what_decides(self):
        self.start_holder()
        self.holder.stop()
        self.holder = None
        without = preflight(self.state, stopped=False)
        self.assertEqual(without['verdict'], 'needs_operator_confirmation',
                         'with nobody holding the lock, the stop statement is the only '
                         'remaining evidence and the tool must ask for it')
        with_attestation = preflight(self.state, stopped=True)
        self.assertIs(with_attestation['lock'].get('held_by_a_process'), False)
        self.assertEqual(with_attestation['verdict'], 'safe_to_start')

    @unittest.skipIf(os.name != 'nt',
                     'on POSIX a file can be replaced while a holder keeps the old inode '
                     'locked, and the probe then describes the new file; recorded as a '
                     'limitation in docs/UPGRADE_DRILL.md rather than asserted')
    def test_the_lock_file_cannot_be_swapped_while_it_is_held(self):
        """On Windows the held file is open, so the swap fails -- a property worth pinning,
        because it is what stops a half-replaced lock from being read as a clear one."""
        self.start_holder()
        path = os.path.join(self.state, host.LOCK_FILE)
        replacement = path + '.new'
        with open(replacement, 'wb') as out:
            out.write(b'\x00' + host.LOCK_MARKER + b'REPLACED-BY-THE-TEST')
        with self.assertRaises(OSError):
            os.replace(replacement, path)
        self.assertTrue(os.path.exists(path))

    def test_a_lock_nobody_can_open_is_not_approved(self):
        if os.name == 'nt':
            self.skipTest('a chmod does not deny the owner a read on Windows')
        path = os.path.join(self.state, host.LOCK_FILE)
        with open(path, 'wb') as out:
            out.write(b'\x00' + host.LOCK_MARKER)
        os.chmod(path, 0)
        try:
            report = preflight(self.state, stopped=True)
        finally:
            os.chmod(path, 0o600)
        self.assertNotEqual(report['verdict'], 'safe_to_start')
        self.assertIsNone(report['lock'].get('held_by_a_process'))


if __name__ == '__main__':
    unittest.main()
