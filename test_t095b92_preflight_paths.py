"""T095B92: the preflight's own path handling is part of its trust boundary.

T091 stopped it following a symbolic link it could see. What it could not see is the rest of
the window: a link that appears between `lstat` and `open`, a directory reached through a
link, a Windows junction (which `os.lstat` reports as a *directory*, not a link), a file it
cannot read, and a file whose contents are valid JSON but not a queue.

The distinction this suite enforces is the one an operator needs: what the disks says is a
fact and gets a verdict; whether a process is running is not, and stays a question.
"""
import io
import json
import os
import shutil
import stat
import tempfile
import unittest

import host

from test_t095b90_upgrade_preflight import PREFLIGHT, snapshot


class Base(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t092-preflight-')
        self.outside = tempfile.mkdtemp(prefix='t092-outside-')

    def tearDown(self):
        for path in (self.state, self.outside):
            try:
                os.chmod(path, 0o755)
            except OSError:
                pass
            shutil.rmtree(path, ignore_errors=True)

    def inspect(self, **kwargs):
        before = snapshot(self.state)
        report = PREFLIGHT.inspect(self.state, **kwargs)
        self.assertEqual(snapshot(self.state), before,
                         'the preflight changed the directory it inspected')
        return report


class MalformedQueueTest(Base):
    def test_a_queue_that_is_valid_json_but_not_a_document_is_named(self):
        """`load_queue` raises HostError for damaged JSON; a JSON *list* is not a queue at
        all, and the summariser called `.get` on it and died with a traceback."""
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as out:
            json.dump([1, 2, 3], out)
        report = self.inspect(host_stopped=True)
        self.assertFalse(report['queue']['readable'])
        self.assertTrue(report['queue']['error'])
        self.assertNotEqual(report['exit_code'], 0)
        self.assertIn('queue', ' '.join(report['reasons']).lower())

    def test_a_queue_that_is_a_string_is_named(self):
        with io.open(os.path.join(self.state, host.QUEUE_FILE), 'w', encoding='utf-8') as out:
            json.dump('not a queue', out)
        report = self.inspect(host_stopped=True)
        self.assertFalse(report['queue']['readable'])
        self.assertNotEqual(report['exit_code'], 0)


class SwapDuringInspectTest(Base):
    def test_a_lock_replaced_between_the_check_and_the_open_is_not_believed(self):
        """lstat says "ordinary file", then somebody swaps a symlink in. Reading next would
        report on the target; the fd is the only thing that cannot lie about what was
        opened."""
        lock = os.path.join(self.state, host.LOCK_FILE)
        with io.open(lock, 'wb') as out:
            out.write(b'\x00' + host.LOCK_MARKER + b' aaaaaaaa')
        real_lstat = os.lstat
        swapped = {}

        def lying_lstat(path):
            info = real_lstat(path)
            if not swapped and str(path).endswith(host.LOCK_FILE):
                swapped['done'] = True
                target = os.path.join(self.outside, 'other-lock')
                with io.open(target, 'wb') as out:
                    out.write(b'\x00' + host.LOCK_MARKER + b' bbbbbbbb')
                os.unlink(path)
                os.symlink(target, path)
            return info

        PREFLIGHT.os.lstat = lying_lstat
        try:
            # No snapshot equality here on purpose: this test mutates the directory as part
            # of the injection, so read-onlyness is checked by the other cases in this file.
            report = PREFLIGHT.inspect(self.state, host_stopped=True)
        finally:
            PREFLIGHT.os.lstat = real_lstat
        self.assertTrue(swapped.get('done'), 'the swap was never injected')
        self.assertNotIn(report['lock'].get('token'), ('bbbbbbbb',),
                         'the preflight reported the token of a file that replaced the lock '
                         'between the check and the open')
        self.assertTrue(report['lock'].get('raced') or report['lock']['kind'] in
                        ('symlink', 'raced', 'unreadable'),
                        'the swap was invisible: %r' % (report['lock'],))

    def test_an_unreadable_lock_is_named_not_crashed(self):
        if os.name == 'nt':
            self.skipTest('chmod does not deny the owner a read on Windows')
        lock = os.path.join(self.state, host.LOCK_FILE)
        with io.open(lock, 'wb') as out:
            out.write(b'\x00' + host.LOCK_MARKER)
        os.chmod(lock, 0o000)
        report = self.inspect(host_stopped=True)
        self.assertIn(report['lock']['kind'], ('unreadable', 'symlink'))
        self.assertNotEqual(report['exit_code'], 0)


class PathTrustTest(Base):
    def test_a_state_directory_reached_through_a_link_says_so(self):
        real = os.path.join(self.outside, 'real-state')
        os.makedirs(real)
        host.append_events(real, [{'eventId': 'e1', 'runId': 'run-e1', 'text': 'x'}])
        link = os.path.join(self.outside, 'linked-state')
        os.symlink(real, link)
        before = snapshot(real)
        report = PREFLIGHT.inspect(link, host_stopped=True)
        self.assertEqual(snapshot(real), before)
        self.assertIn('realpath', report['paths'])
        self.assertTrue(report['paths']['through_symlink'],
                        'the preflight did not mention that the path it inspected is a link')
        self.assertIn('symbolic link', ' '.join(report['reasons']).lower())

    @unittest.skipIf(os.name != 'nt', 'junctions only exist on Windows')
    def test_a_windows_junction_is_not_mistaken_for_a_directory(self):
        import subprocess
        target = os.path.join(self.outside, 'junction-target')
        os.makedirs(target)
        junction = os.path.join(self.state, host.LOCK_FILE)
        result = subprocess.run(['cmd', '/c', 'mklink', '/J', junction, target],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if result.returncode != 0:
            self.skipTest('mklink /J unavailable: %s' % result.stdout.decode('utf-8', 'replace'))
        report = self.inspect(host_stopped=True)
        self.assertNotEqual(report['lock']['kind'], 'absent',
                            'a junction at the lock path was reported as an absent file')
        self.assertNotEqual(report['exit_code'], 0)


class StillReadOnlyTest(Base):
    def test_the_snapshot_matches_for_every_verdict(self):
        cases = [b'', b'\x00' + host.LOCK_MARKER + b' token', b'\x00weird content']
        for payload in cases:
            with io.open(os.path.join(self.state, host.LOCK_FILE), 'wb') as out:
                out.write(payload)
            self.inspect(host_stopped=True)
            self.inspect()


if __name__ == '__main__':
    unittest.main()
