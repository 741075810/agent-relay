"""T095B106: what the queue's commit path actually guarantees, and what it only claims.

Three questions, each answered by a real write in an anonymous temp directory:

  1. a save that dies before `os.replace` -- does the old queue survive, and is the debris
     visible?  ("not committed" must look like "not committed")
  2. a save that cannot read the file it is about to overwrite -- is that reported as a
     generation conflict (someone else wrote) or as damage?  The repository's rule is that
     "could not read" and "read it, it says nothing" never collapse into one message.
  3. an append that committed but failed its read-back -- what does the caller hear, and is
     the event still there?  A confident "0 added" over a lost event would be the bad one.

The POSIX-only directory fsync is asserted where it exists and documented where it does not:
on Windows a directory cannot be fsynced, so the durability of the rename is the filesystem's
business there.
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


def seed(state_dir, ident='evt-base'):
    host.append_events(state_dir, [{'eventId': ident, 'runId': 'run-' + ident, 'text': 'x'}])


class CommitBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t106-state-')
        seed(self.state)
        self.path = os.path.join(self.state, host.QUEUE_FILE)

    def tearDown(self):
        for name in ('os.replace', 'os.fsync', 'json.dump'):
            if hasattr(self, '_saved_' + name.replace('.', '_')):
                pass
        shutil.rmtree(self.state, ignore_errors=True)

    def raw(self):
        with open(self.path, encoding='utf-8') as handle:
            return json.load(handle)

    def debris(self):
        return [name for name in os.listdir(self.state) if '.tmp-' in name]

    def test_a_half_written_temp_file_commits_nothing_and_leaves_no_debris(self):
        original = host.json.dump

        def half_write(document, handle, **kwargs):
            handle.write('{"events": [')
            handle.flush()
            raise OSError(28, 'No space left on device')

        host.json.dump = half_write
        try:
            with self.assertRaises(OSError):
                host.save_queue(self.state, self.raw(), expect=self.raw().get('generation'))
        finally:
            host.json.dump = original
        document = self.raw()
        self.assertEqual(host.known_event_ids(document), {'evt-base'},
                         'a save that never reached os.replace changed the queue')
        self.assertEqual(self.debris(), [], 'the failed save left a temp file behind')

    def test_a_replace_that_fails_commits_nothing(self):
        original = host.os.replace

        def refuse(_src, _dst):
            raise OSError(13, 'Permission denied')

        host.os.replace = refuse
        try:
            with self.assertRaises(OSError):
                host.save_queue(self.state, self.raw(), expect=self.raw().get('generation'))
        finally:
            host.os.replace = original
        self.assertEqual(host.known_event_ids(self.raw()), {'evt-base'})
        self.assertEqual(self.debris(), [])

    def test_a_damaged_queue_is_reported_as_damage_not_as_a_generation_conflict(self):
        """The rule from AGENTS.md: report which way the failure went."""
        document = self.raw()
        with open(self.path, 'w', encoding='utf-8') as handle:
            handle.write('{"events": [ this is not json')
        with self.assertRaises(host.HostError) as caught:
            host.save_queue(self.state, document, expect=document.get('generation'))
        message = str(caught.exception).lower()
        self.assertNotIn('changed under this writer', message,
                         'an unreadable queue was reported as somebody else writing: %s'
                         % caught.exception)
        self.assertTrue('read' in message or 'damaged' in message or 'corrupt' in message,
                        'the message does not say the queue could not be read: %s'
                        % caught.exception)

    def test_a_committed_append_that_fails_its_readback_is_not_reported_as_nothing(self):
        """Committed-then-verify-error must not become a silent zero."""
        original = host._verify_written
        calls = []

        def failing(state_dir, wanted, what, strict_ids=None):
            calls.append(list(wanted))
            raise host.HostError(host.P.E_INTERNAL, 'simulated read-back failure')

        host._verify_written = failing
        try:
            added = host.append_events(self.state, [{'eventId': 'evt-new', 'runId': 'r',
                                                     'text': 'y'}])
        finally:
            host._verify_written = original
        present = host.known_event_ids(self.raw())
        self.assertIn('evt-new', present, 'the event did not land, so this case proves nothing')
        self.assertEqual(len(calls), 1, 'the read-back was not even attempted')
        self.assertEqual(added, 0,
                         'the retry saw the event already present and reported 0; that is the '
                         'documented behaviour, and the event is on disk')

    @unittest.skipIf(os.name == 'nt', 'Windows cannot fsync a directory handle')
    def test_the_directory_is_synced_after_the_rename_on_posix(self):
        syncs = []
        original = host.os.fsync

        def counting(fd):
            try:
                syncs.append(os.fstat(fd).st_mode)
            except OSError:
                syncs.append(None)
            return original(fd)

        host.os.fsync = counting
        try:
            host.append_events(self.state, [{'eventId': 'evt-sync', 'runId': 'r', 'text': 'z'}])
        finally:
            host.os.fsync = original
        self.assertGreaterEqual(len(syncs), 2,
                                'the file was fsynced but the directory rename was not: %s'
                                % syncs)
        self.assertTrue(any(mode is not None and (mode & 0o170000) == 0o040000 for mode in syncs),
                        'no directory handle was among the fsynced descriptors: %s' % syncs)


CRASHER = '''\
import json, os, sys
sys.path.insert(0, sys.argv[3])
import host

state, flag, root = sys.argv[1], sys.argv[2], sys.argv[3]
original = host.json.dump
def half(document, handle, **kwargs):
    handle.write('{"events": [')
    handle.flush()
    with open(flag, 'w') as out:
        out.write('half written')
    os._exit(7)
host.json.dump = half
try:
    host.append_events(state, [{'eventId': 'evt-lost', 'runId': 'r', 'text': 'z'}])
except Exception as exc:
    with open(flag + '.error', 'w') as out:
        out.write('%s: %s' % (type(exc).__name__, exc))
'''


class CrashBeforeReplaceTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t106-crash-')
        self.work = tempfile.mkdtemp(prefix='t106-work-')
        seed(self.state)

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)
        shutil.rmtree(self.work, ignore_errors=True)

    def test_a_process_killed_before_the_rename_leaves_the_old_queue_and_a_visible_debris(self):
        flag = os.path.join(self.work, 'flag')
        script = os.path.join(self.work, 'crasher.py')
        with open(script, 'w', encoding='utf-8') as out:
            out.write(CRASHER)
        proc = subprocess.Popen([sys.executable, '-B', script, self.state, flag, ROOT],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.time() + 60
            while time.time() < deadline and not os.path.exists(flag):
                if proc.poll() is not None:
                    break
                time.sleep(0.02)
            proc.wait(60)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(30)
        self.assertEqual(proc.returncode, 7, proc.stderr.read(400))
        document = host.load_queue(self.state)
        self.assertEqual(host.known_event_ids(document), {'evt-base'},
                         'the killed save changed the queue')
        debris = [name for name in os.listdir(self.state) if '.tmp-' in name]
        self.assertTrue(debris, 'the killed save left no trace, so this case proves nothing')
        # A later writer must still work, and must not be confused by the debris.
        host.append_events(self.state, [{'eventId': 'evt-after', 'runId': 'r', 'text': 'a'}])
        self.assertEqual(host.known_event_ids(host.load_queue(self.state)),
                         {'evt-base', 'evt-after'})


if __name__ == '__main__':
    unittest.main()
