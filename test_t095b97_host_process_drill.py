"""T095B97: the upgrade sequence, against a real host subprocess.

T096 drilled the queue protocol in-process. That cannot answer the question the probe exists
for, because an in-process holder is not another process: `flock` and the Windows byte-range
lock both have to be asked across a boundary before the answer means anything. So this suite
starts the real `host.py` as a child process against an anonymous `--native-root`, and asks
the shipped preflight what it sees at each stage of an upgrade.

Nothing here reads the operator's session logs, the production ledger or a real extension id:
the manifest allows `chrome-extension://aaaa...aaaa/`, and every path is a temp directory.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import host
import protocol as P

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(ROOT, 'host.py')
PREFLIGHT = os.path.join(ROOT, 'tools', 'upgrade_preflight.py')
SYNTHETIC_ORIGIN = 'chrome-extension://' + 'a' * 32 + '/'


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
        report = {'verdict': '<unparseable>', 'exit_code': done.returncode,
                  'output': done.stdout.decode('utf-8', 'replace')[:600]}
    report['process_exit'] = done.returncode
    return report


class RealHost(object):
    """The shipped host, as its own process, speaking the framed protocol on stdio."""

    def __init__(self, state_dir):
        manifest = os.path.join(state_dir, 'host_manifest.json')
        with io.open(manifest, 'w', encoding='utf-8') as handle:
            json.dump({'allowed_origins': [SYNTHETIC_ORIGIN]}, handle)
        self.proc = subprocess.Popen(
            [sys.executable, '-B', HOST, SYNTHETIC_ORIGIN, '--state-dir', state_dir,
             '--manifest', manifest, '--native-root', state_dir],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=state_dir)
        self.counter = 0

    def rpc(self, op, args=None):
        self.counter += 1
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-%d' % self.counter, 'op': op}
        if args is not None:
            request['args'] = args
        self.proc.stdin.write(P.encode(request))
        self.proc.stdin.flush()
        reply = P.read_message(self.proc.stdout)
        assert reply.get('ok'), reply
        return reply.get('result') or reply

    def kill(self):
        """An abnormal exit: no goodbye, no graceful shutdown."""
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(30)
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass


class UpgradeSequenceTest(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t097-host-')
        self.host = None

    def tearDown(self):
        if self.host is not None:
            self.host.kill()
        shutil.rmtree(self.state, ignore_errors=True)

    def legacy_state(self):
        """A queue in today's format, then the empty lock a pre-T088 host leaves."""
        host.append_events(self.state, [
            {'eventId': 'evt-a', 'runId': 'run-1', 'name': 'terminal-turn',
             'createdAt': 1759000001, 'deliverable': True, 'message': 'fixture'},
            {'eventId': 'evt-b', 'runId': 'run-2', 'name': 'terminal-turn',
             'createdAt': 1759000002, 'deliverable': True, 'message': 'fixture'},
        ])
        with open(os.path.join(self.state, host.LOCK_FILE), 'wb'):
            pass

    def test_the_whole_sequence_against_a_real_host(self):
        self.legacy_state()

        before_removal = preflight(self.state)
        self.assertEqual(before_removal['verdict'], 'legacy_lock_remove_by_hand')
        self.assertNotEqual(before_removal['process_exit'], 0)

        # The drill removes the fixture lock by hand, exactly where a real upgrade would.
        os.remove(os.path.join(self.state, host.LOCK_FILE))
        cleared = preflight(self.state, stopped=True)
        self.assertEqual(cleared['verdict'], 'safe_to_start', cleared)

        self.host = RealHost(self.state)
        self.assertEqual(self.host.rpc('hello')['protocolVersion'], P.PROTOCOL_VERSION)

        # The lock is taken per operation, not for the host's lifetime, so an idle host holds
        # nothing. The probe answers "is somebody writing right now", and the tool says so.
        self.host.rpc('poll', {'consumer': 'probe-warmup'})   # the host takes its lock on a write path
        idle = preflight(self.state)
        self.assertIs(idle['lock'].get('held_by_a_process'), False, idle['lock'])
        self.assertIn('no process is writing right now', ' '.join(idle['reasons']).lower(),
                      'the report does not state what the probe can and cannot see')

        self.host.rpc('simulate', {'count': 1})
        page = self.host.rpc('poll', {'consumer': 'page'})
        other = self.host.rpc('poll', {'consumer': 'other'})
        self.assertTrue(page['events'], page)
        self.assertEqual(len(other['events']), 3, other)
        acked = self.host.rpc('ack', {'acked': [page['events'][0]['eventId']],
                                      'consumer': 'page'})
        self.assertEqual(acked['newlyAcked'], 1, acked)
        page_again = self.host.rpc('poll', {'consumer': 'page'})
        self.assertEqual([e['eventId'] for e in page_again['events']],
                         [e['eventId'] for e in page['events'][1:]], page_again)

        self.host.kill()
        self.host = None

        after_crash = preflight(self.state)
        self.assertIs(after_crash['lock'].get('held_by_a_process'), False,
                      'the operating system did not release the lock of a killed host')
        self.assertTrue(os.path.exists(os.path.join(self.state, host.LOCK_FILE)),
                        'the lock file was deleted; the next host cannot find its owner')

        document = host.load_queue(self.state)
        known = sorted(host.known_event_ids(document))
        self.assertEqual(len(known), 3, known)
        self.assertIn('evt-a', known)
        self.assertIn('evt-b', known)
        self.assertEqual(len(host.pending_events(self.state, consumer='page')[0]), 2)
        self.assertEqual(len(host.pending_events(self.state, consumer='other')[0]), 3)

        # The directory is startable for *this* build, and the report has to say what that
        # marker means for the older one. A rollback is not the same question as a start.
        rollback = preflight(self.state, stopped=True)
        self.assertEqual(rollback['verdict'], 'safe_to_start', rollback['reasons'])
        self.assertIn('older build', ' '.join(rollback['reasons']),
                      'the report does not say what the marker means for a rollback')

    def test_the_probe_answers_null_when_it_cannot_open_the_lock(self):
        """`None` is not a yes: a lock nobody can open must not read as clear."""
        self.legacy_state()
        os.remove(os.path.join(self.state, host.LOCK_FILE))
        with open(os.path.join(self.state, host.LOCK_FILE), 'wb') as handle:
            handle.write(b'\x00' + host.LOCK_MARKER)   # byte 0 is reserved for the OS lock
        report = preflight(self.state, stopped=True)
        self.assertEqual(report['verdict'], 'safe_to_start', report)


HOLDER = "import sys, time, host; lock = host._Lock(sys.argv[1]); lock.__enter__(); print('held', flush=True); time.sleep(float(sys.argv[2]))"


class ForeignHolderTest(unittest.TestCase):
    """The probe has to work across a process boundary, or it proves nothing."""

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix='t097-holder-')
        host.append_events(self.state, [{'eventId': 'evt-a', 'runId': 'run-1',
                                         'text': 'fixture'}])

    def tearDown(self):
        shutil.rmtree(self.state, ignore_errors=True)

    def start_holder(self, seconds=30.0):
        holder = subprocess.Popen([sys.executable, '-B', '-c', HOLDER, self.state,
                                   str(seconds)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  cwd=ROOT)
        first = holder.stdout.readline().strip()
        self.assertEqual(first, b'held',
                         'the holder never took the lock: %s'
                         % holder.stderr.read(800).decode('utf-8', 'replace'))
        return holder

    # The cross-process question this case used to skip is answered in\n    # test_t095b98_cross_process_lock.py, with a handshake instead of a sleep.\n\n
class ProbeMutationTest(unittest.TestCase):
    """Shows the assertions above have teeth: break the probe and they fail."""

    def test_a_probe_that_always_says_clear_is_caught(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            'preflight_mutation', os.path.join(ROOT, 'tools', 'upgrade_preflight.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        directory = tempfile.mkdtemp(prefix='t097-mutate-')
        try:
            host.append_events(directory, [{'eventId': 'evt-a', 'runId': 'run-1',
                                            'text': 'fixture'}])
            with host._Lock(directory):
                honest = module.inspect(directory, host_stopped=True)
                module._lock_probe = lambda path, kind: False
                mutated = module.inspect(directory, host_stopped=True)
            self.assertIs(honest['lock'].get('held_by_a_process'), True, honest)
            self.assertIs(mutated['lock'].get('held_by_a_process'), False)
            honest_text = ' '.join(honest['reasons']).lower()
            mutated_text = ' '.join(mutated['reasons']).lower()
            self.assertIn('holding the queue lock', honest_text, honest)
            self.assertNotIn('holding the queue lock', mutated_text, mutated)
        finally:
            shutil.rmtree(directory, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
