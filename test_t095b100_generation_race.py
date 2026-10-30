"""T095B100: can a stale writer make another writer's event disappear?

T086 proved the generation check refuses a stale save, and T087 proved it is not a CAS: there
is a window between reading the generation and replacing the file. T099 showed a second way
into that window -- `os.replace` onto `queue.lock` gives a new inode, so two processes can hold
"the" lock and both be inside the critical section.

`append_events` passes `expect=` and is therefore protected. `ack_events` calls
`save_queue(state_dir, doc)` with no expectation at all, so if its `doc` was loaded before a
concurrent writer saved, its write puts the old document back -- and the other writer's event
is gone, with nothing raised on either side.

The interleaving is built with a hook inside `load_queue` in a real second process: it loads,
announces itself, waits for the parent's go, and only then returns. The parent's write happens
in between, exactly where a writer on a swapped inode would be. No lock swap is needed to reach
that state, so the Windows run measures it too; a second case repeats it through a real
`os.replace` on POSIX, which is how it happens in the field.
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

ACKER = '''\
import os, sys, time
sys.path.insert(0, sys.argv[4])
import host

state, ready, go, root, consumer = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
original = host.load_queue
def hooked(path):
    document = original(path)
    with open(ready + '.tmp', 'w') as out:
        out.write(str(document.get('generation')))
    os.replace(ready + '.tmp', ready)
    deadline = time.time() + 120
    while time.time() < deadline:
        if os.path.exists(go):
            break
        time.sleep(0.02)
    return document
host.load_queue = hooked
try:
    added = host.ack_events(state, ['evt-a'], consumer=None if consumer == '-' else consumer)
    outcome = 'acked %s' % added
except Exception as exc:
    outcome = '%s: %s' % (type(exc).__name__, exc)
with open(os.path.join(state, 'ack-result.tmp'), 'w') as out:
    out.write(outcome)
os.replace(os.path.join(state, 'ack-result.tmp'), os.path.join(state, 'ack-result'))
'''


def bump(state_dir, event_id):
    """A writer that the lock did not exclude: it saves over whatever is on disk."""
    document = host.load_queue(state_dir)
    document['events'].append({'eventId': event_id, 'runId': 'run-' + event_id,
                               'text': 'from the concurrent writer'})
    document['next_seq'] = (document.get('next_seq') or 0) + 1
    document['generation'] = (document.get('generation') or 0) + 1
    host.save_queue(state_dir, document)
    return document


class Acker(object):
    def __init__(self, state_dir, workdir, consumer='page'):
        self.script = os.path.join(workdir, 'acker.py')
        with open(self.script, 'w', encoding='utf-8') as out:
            out.write(ACKER)
        self.ready = os.path.join(workdir, 'ready')
        self.go = os.path.join(workdir, 'go')
        self.result = os.path.join(state_dir, 'ack-result')
        self.proc = subprocess.Popen(
            [sys.executable, '-B', self.script, state_dir, self.ready, self.go, ROOT,
             consumer or '-'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def wait_ready(self, seconds=60.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if os.path.exists(self.ready):
                with open(self.ready, encoding='utf-8') as handle:
                    return handle.read().strip()
            if self.proc.poll() is not None:
                break
            time.sleep(0.02)
        return None

    def finish(self, seconds=120.0):
        with open(self.go + '.tmp', 'w') as out:
            out.write('go')
        os.replace(self.go + '.tmp', self.go)
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


class StaleAckTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t100-state-')
        self.work = tempfile.mkdtemp(prefix='t100-work-')
        self.acker = None
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'run-a',
                                         'text': 'the one being acked'}])

    def tearDown(self):
        if self.acker is not None:
            self.acker.kill()
        for path in (self.state, self.work):
            shutil.rmtree(path, ignore_errors=True)

    def assert_no_silent_loss(self, outcome):
        known = host.known_event_ids(host.load_queue(self.state))
        self.assertIn('evt-a', known, 'the base event vanished: %s' % outcome)
        if 'evt-b' not in known:
            self.fail('SILENT LOSS: the concurrent writer reported success, its event is gone '
                      'from the persisted queue, and the acknowledgement said "%s"'
                      % outcome)

    def test_a_stale_ack_does_not_erase_a_concurrent_write(self):
        self.acker = Acker(self.state, self.work)
        generation = self.acker.wait_ready()
        self.assertIsNotNone(generation, 'the acker never loaded the queue')
        bump(self.state, 'evt-b')
        outcome = self.acker.finish()
        self.acker = None
        self.assert_no_silent_loss(outcome)

    def test_a_stale_ack_without_a_consumer_also_does_not(self):
        self.acker = Acker(self.state, self.work, consumer='-')
        self.assertIsNotNone(self.acker.wait_ready(), 'the acker never loaded the queue')
        bump(self.state, 'evt-b')
        outcome = self.acker.finish()
        self.acker = None
        self.assert_no_silent_loss(outcome)

    @unittest.skipIf(os.name == 'nt',
                     'Windows will not replace a file that is open; the POSIX swap is the case '
                     'that reaches this state in the field')
    def test_the_same_through_a_real_inode_swap(self):
        path = os.path.join(self.state, host.LOCK_FILE)
        self.acker = Acker(self.state, self.work)
        self.assertIsNotNone(self.acker.wait_ready(), 'the acker never loaded the queue')
        before = os.stat(path).st_ino
        replacement = path + '.intruder'
        with open(replacement, 'wb') as out:
            out.write(b'\x00' + host.LOCK_MARKER + b'intruder-token')
        os.replace(replacement, path)
        self.assertNotEqual(os.stat(path).st_ino, before, 'the swap did not change the inode')
        host.append_events(self.state, [{'eventId': 'evt-b', 'runId': 'run-b',
                                         'text': 'through the new lock'}])
        outcome = self.acker.finish()
        self.acker = None
        self.assert_no_silent_loss(outcome)


class ExpectControlTest(unittest.TestCase):
    def test_a_stale_save_that_states_its_generation_is_refused(self):
        """The control: this is what `ack_events` is missing."""
        state = tempfile.mkdtemp(prefix='t100-control-')
        try:
            host.append_events(state, [{'eventId': 'evt-a', 'runId': 'run-a', 'text': 'x'}])
            stale = host.load_queue(state)
            bump(state, 'evt-b')
            with self.assertRaises(host.HostError):
                host.save_queue(state, stale, expect=stale.get('generation'))
        finally:
            shutil.rmtree(state, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
