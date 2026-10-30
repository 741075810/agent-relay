"""T095B101: the lock file must never be visible without its marker.

T100 found the window by accident: a writer creates `queue.lock` with `O_CREAT` (so the file
exists, empty) and only then writes the marker. A second writer that opens the path in that
window reads nothing and concludes "this belongs to another protocol", which is a true
statement about a false situation -- the file is not a legacy lock, it is a lock being born.

This suite measures the window directly, with a watcher process that polls the path and records
any moment at which it exists without its marker. The creator's first write is delayed on
purpose (a real 300 ms pause injected into `os.write` in a child process), so the window is not
a matter of luck: with the old code the watcher sees it every run, and with an atomic publish
the path never exists before it has content.
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

WATCHER = '''\
import os, sys, time
sys.path.insert(0, sys.argv[3])
import host

state, report, root = sys.argv[1], sys.argv[2], sys.argv[3]
path = os.path.join(state, host.LOCK_FILE)
seen = []
deadline = time.time() + 25
while time.time() < deadline:
    try:
        size = os.path.getsize(path)
    except OSError:
        size = None
    if size == 0:
        seen.append('empty')
        break
    if size:
        try:
            with open(path, 'rb') as handle:
                blob = handle.read(64)
            if host.LOCK_MARKER not in blob:
                seen.append('unmarked')
                break
        except OSError:
            pass
    time.sleep(0.001)
with open(report + '.tmp', 'w') as out:
    out.write(','.join(seen) if seen else 'clean')
os.replace(report + '.tmp', report)
'''

CREATOR = '''\
import os, sys, time
sys.path.insert(0, sys.argv[3])
import host

state, report, root = sys.argv[1], sys.argv[2], sys.argv[3]
lock_path = os.path.join(state, host.LOCK_FILE)
identity = None
try:
    info = os.stat(lock_path)
    identity = (info.st_dev, info.st_ino)
except OSError:
    pass
original = os.write
delayed = []
def slow(fd, data):
    global identity
    try:
        mine = os.fstat(fd)
        is_lock = identity is None or (mine.st_dev, mine.st_ino) == identity
    except OSError:
        is_lock = False
    if is_lock and not delayed:
        delayed.append(1)
        time.sleep(0.3)          # the window, made long enough to be seen
    return original(fd, data)
host.os.write = slow
try:
    host.append_events(state, [{'eventId': 'evt-a', 'runId': 'run-a', 'text': 'x'}])
    outcome = 'ok'
except Exception as exc:
    outcome = '%s: %s' % (type(exc).__name__, exc)
with open(report + '.tmp', 'w') as out:
    out.write(outcome)
os.replace(report + '.tmp', report)
'''


class Scene(object):
    def __init__(self):
        self.state = tempfile.mkdtemp(prefix='t101-state-')
        self.work = tempfile.mkdtemp(prefix='t101-work-')
        self.children = []

    def script(self, name, text):
        path = os.path.join(self.work, name)
        with open(path, 'w', encoding='utf-8') as out:
            out.write(text)
        return path

    def spawn(self, path, report, extra=None):
        command = [sys.executable, '-B', path, self.state, report, ROOT]
        if extra:
            command.extend(extra)
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(proc)
        return proc

    def wait_file(self, path, seconds=60.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if os.path.exists(path):
                with open(path, encoding='utf-8') as handle:
                    return handle.read()
            time.sleep(0.02)
        return None

    def close(self):
        for proc in self.children:
            if proc.poll() is None:
                proc.kill()
            try:
                proc.wait(30)
            except subprocess.TimeoutExpired:
                proc.kill()
        for path in (self.state, self.work):
            shutil.rmtree(path, ignore_errors=True)


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.scene = Scene()

    def tearDown(self):
        self.scene.close()

    def test_the_lock_file_is_never_visible_without_its_marker(self):
        watch_report = os.path.join(self.scene.work, 'watch.txt')
        create_report = os.path.join(self.scene.work, 'create.txt')
        watcher = self.scene.script('watcher.py', WATCHER)
        creator = self.scene.script('creator.py', CREATOR)
        self.scene.spawn(watcher, watch_report)
        time.sleep(0.2)
        self.scene.spawn(creator, create_report)
        outcome = self.scene.wait_file(create_report)
        self.assertIsNotNone(outcome, 'the creator never finished')
        self.assertEqual(outcome, 'ok', outcome)
        seen = self.scene.wait_file(watch_report)
        self.assertIsNotNone(seen, 'the watcher never finished')
        self.assertEqual(seen, 'clean',
                         'the lock file existed without its marker (%s): a second writer '
                         'would read an empty file and call it another protocol' % seen)

    def test_a_legacy_empty_lock_is_still_refused_and_not_upgraded(self):
        path = os.path.join(self.scene.state, host.LOCK_FILE)
        with open(path, 'wb'):
            pass
        before = os.stat(path).st_ino
        with self.assertRaises(host.HostError) as caught:
            host.append_events(self.scene.state, [{'eventId': 'evt-a', 'runId': 'run-a',
                                                   'text': 'x'}])
        self.assertIn('pre-t088', str(caught.exception).lower())
        self.assertEqual(os.stat(path).st_ino, before,
                         'the legacy lock was replaced; an upgrade must never be automatic')
        self.assertEqual(os.path.getsize(path), 0, 'the legacy lock was written to')

    def test_a_normal_acquisition_publishes_the_marker_and_keeps_the_token(self):
        host.append_events(self.scene.state, [{'eventId': 'evt-a', 'runId': 'run-a',
                                               'text': 'x'}])
        path = os.path.join(self.scene.state, host.LOCK_FILE)
        with open(path, 'rb') as handle:
            blob = handle.read(200)
        self.assertTrue(blob.startswith(b'\x00' + host.LOCK_MARKER), blob[:64])
        self.assertEqual(os.path.getsize(path), len(blob))
        leftovers = [name for name in os.listdir(self.scene.state) if '.tmp-' in name]
        self.assertEqual(leftovers, [], 'a temporary file was left behind: %s' % leftovers)

    def test_a_second_writer_while_the_first_holds_waits_rather_than_failing(self):
        ok = []

        def worker():
            host.append_events(self.scene.state, [{'eventId': 'evt-b', 'runId': 'run-b',
                                                   'text': 'y'}])
            ok.append(1)

        thread = __import__('threading').Thread(target=worker)
        with host._Lock(self.scene.state):
            thread.start()
            time.sleep(0.3)
        thread.join(60)
        self.assertEqual(ok, [1], 'a writer that had to wait did not complete')
        document = host.load_queue(self.scene.state)
        self.assertEqual(len(host.known_event_ids(document)) >= 1, True, document)


if __name__ == '__main__':
    unittest.main()
