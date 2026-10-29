"""T095B81: what the host does when its own state file is damaged.

A crash mid-write, a filesystem that published a short file, or a power cut right after
`os.replace` all leave `terminal-source.json` in a shape no code path wrote deliberately.
The interesting question is not whether it can happen -- it can -- but whether the host
then says something true.

Two failure directions, and both are silent:

  * **an exception** leaves Chrome with no answer at all. Every later poll repeats it, so
    one short file bricks the notify chain until someone deletes it, and the operator sees
    "nothing is running" forever;
  * **a quiet empty answer** is worse. The state file is where `pendingIds` lives, so
    synthesising a fresh one absorbs whatever was waiting there. The completion is gone
    without a trace, and the report says silence is correct.

Only one answer is honest: refuse, name the code, write nothing, and leave the damaged
file where a human can look at it.

The second half of this suite is durability. `save_queue` in `host.py` already writes to a
pid-unique temporary, flushes, fsyncs and renames; `save_state` and `save_arm` did not.
The contract is asserted here rather than assumed, because "the two writers cannot share
one temporary" is exactly the kind of property that quietly stops being true.
"""
import io
import json
import os
import shutil
import tempfile
import unittest

import host
import protocol as P
import terminal_source
from test_t059_terminal_wire import run, uuid

BASE_MS = 1759000000000


def load_doctor():
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        'notify_doctor', os.path.join(here, 'tools', 'notify_doctor.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CrashScene(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t081-root-')
        self.state = tempfile.mkdtemp(prefix='t081-state-')
        sub = os.path.join(self.root, 'f' * 64)
        os.makedirs(sub)
        self.ledger = os.path.join(sub, 'endpoint.json.runs.json')
        self._saved_ledger = terminal_source.DEFAULT_LEDGER
        self._saved_native = terminal_source.native_turns.sample
        terminal_source.DEFAULT_LEDGER = self.root
        terminal_source.native_turns.sample = staticmethod(
            lambda root=None, now=None, **_kwargs: {
                'ok': True, 'code': None, 'turns': [], 'running': [],
                'runningStale': 0, 'sessions': 1, 'files': 1, 'error': None,
                'source': 'stub', 'root': root})
        self.manifest = os.path.join(self.state, 'host_manifest.json')
        with io.open(self.manifest, 'w', encoding='utf-8') as handle:
            json.dump({'allowed_origins':
                       ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']}, handle)
        self.state_file = os.path.join(self.state, terminal_source.STATE_NAME)

    def tearDown(self):
        terminal_source.native_turns.sample = self._saved_native
        terminal_source.DEFAULT_LEDGER = self._saved_ledger
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.state, ignore_errors=True)

    def write_ledger(self, runs):
        with io.open(self.ledger, 'w', encoding='utf-8') as handle:
            json.dump(runs, handle)

    def rpc(self, op, args=None):
        request = {'v': P.PROTOCOL_VERSION, 'id': 'req-1', 'op': op}
        if args is not None:
            request['args'] = args
        out = io.BytesIO()
        host.serve(self.state, self.manifest, io.BytesIO(P.encode(request)), out)
        out.seek(0)
        return P.read_message(out)

    def offer_something(self):
        """Baseline, then one new completion, so the state file holds a pending id."""
        self.write_ledger([run(uuid(1), 'completed')])
        self.rpc('terminal-list')
        self.write_ledger([run(uuid(1), 'completed'),
                           run(uuid(2), 'completed', BASE_MS + 1000)])
        reply = self.rpc('terminal-list')
        self.assertEqual([c['runId'] for c in reply['result']['candidates']],
                         [uuid(2)])
        with open(self.state_file, 'rb') as handle:
            return handle.read()


class DamagedStateTest(CrashScene):
    """Six shapes a crash can leave behind, and one honest answer for all of them."""

    def damages(self, good):
        return {
            'truncated': good[:len(good) // 2],
            'empty': b'',
            'half-json': b'{"version": 1, "baselineIds": [',
            'wrong-version': json.dumps({'version': 99, 'baselineIds': [],
                                        'pendingIds': [], 'ackedIds': []}).encode(),
            'missing-lists': json.dumps({'version': 1}).encode(),
            'not-an-object': json.dumps([1, 2, 3]).encode(),
        }

    def test_a_damaged_state_is_refused_with_a_code_not_an_exception(self):
        good = self.offer_something()
        for name, payload in self.damages(good).items():
            with open(self.state_file, 'wb') as handle:
                handle.write(payload)
            try:
                reply = self.rpc('terminal-list')
            except Exception as exc:                      # noqa: BLE001
                self.fail('%s: the host raised %s out of serve instead of answering: %s'
                          % (name, type(exc).__name__, exc))
            # The RPC envelope succeeded; the payload refuses. That is the same shape the
            # missing-ledger path already uses, so the extension has one rule to learn:
            # read `result.ok`.
            self.assertIs(reply.get('ok'), True, '%s: %r' % (name, reply))
            result = reply.get('result') or {}
            self.assertIs(result.get('ok'), False, '%s: %r' % (name, result))
            self.assertIn(result.get('code'), ('state_unreadable', 'source_unavailable'),
                          '%s answered %r' % (name, result))
            self.assertEqual(result.get('candidates'), [], name)

    def test_a_damaged_state_never_looks_authorised_or_delivered(self):
        """The extension must not be able to arm or send on this answer."""
        good = self.offer_something()
        with open(self.state_file, 'wb') as handle:
            handle.write(good[:len(good) // 3])
        result = self.rpc('terminal-list').get('result') or {}
        self.assertIs(result.get('deliverable'), False)
        self.assertIs(result.get('confirmed'), False)

    def test_the_damaged_file_is_left_exactly_as_it_was(self):
        """Refusing must not repair, because repairing destroys the evidence and can
        absorb the pending ids that were in the file."""
        good = self.offer_something()
        damaged = good[:len(good) // 2]
        with open(self.state_file, 'wb') as handle:
            handle.write(damaged)
        self.rpc('terminal-list')
        self.rpc('terminal-list')
        with open(self.state_file, 'rb') as handle:
            self.assertEqual(handle.read(), damaged)

    def test_an_ack_against_damaged_state_is_a_named_error(self):
        good = self.offer_something()
        with open(self.state_file, 'wb') as handle:
            handle.write(b'{')
        reply = self.rpc('terminal-ack', {'acked': [uuid(2)]})
        self.assertFalse(reply['ok'])
        self.assertIn('error', reply)


class StaleTemporaryTest(CrashScene):
    def test_a_temporary_left_by_a_crash_is_ignored(self):
        good = self.offer_something()
        with open(self.state_file + '.tmp', 'wb') as handle:
            handle.write(b'{"version": 1, "half')
        with open(self.state_file, 'wb') as handle:
            handle.write(good)
        reply = self.rpc('terminal-list')
        self.assertTrue(reply['ok'])
        self.assertEqual([c['runId'] for c in reply['result']['candidates']], [uuid(2)])


class DurabilityContractTest(CrashScene):
    """`save_queue` already does this; the sampler's own files must too."""

    def setUp(self):
        super(DurabilityContractTest, self).setUp()
        self.synced = []
        self.replaced = []
        self._real_fsync = os.fsync
        self._real_replace = os.replace
        os.fsync = lambda handle: self.synced.append(handle)
        os.replace = lambda src, dst: self.replaced.append((src, dst))

    def tearDown(self):
        os.fsync = self._real_fsync
        os.replace = self._real_replace
        super(DurabilityContractTest, self).tearDown()

    def test_the_state_file_is_flushed_to_disk_before_it_is_published(self):
        terminal_source.save_state(self.state, {'version': terminal_source.STATE_VERSION,
                                                'baselineIds': [], 'pendingIds': [],
                                                'ackedIds': []})
        self.assertTrue(self.synced,
                        'save_state published without fsync: a crash can leave a short '
                        'file that reads as damaged state')

    def test_the_arm_snapshot_is_flushed_too(self):
        terminal_source.save_arm(self.state, {'version': terminal_source.ARM_VERSION,
                                             'ids': [], 'takenAt': BASE_MS // 1000,
                                             'epoch': uuid(9), 'truncated': False})
        self.assertTrue(self.synced, 'save_arm published without fsync')

    def test_two_writers_cannot_share_one_temporary_file(self):
        """A fixed `.tmp` name means two host processes interleave their bytes into the
        same file and one of them publishes the mixture."""
        terminal_source.save_state(self.state, {'version': terminal_source.STATE_VERSION,
                                                'baselineIds': [], 'pendingIds': [],
                                                'ackedIds': []})
        self.assertTrue(self.replaced)
        source, target = self.replaced[-1]
        self.assertEqual(target, self.state_file)
        self.assertNotEqual(source, target + '.tmp',
                            'the temporary is a fixed name, so two writers share it')
        self.assertIn(str(os.getpid()), source,
                      'the temporary does not carry the writer identity')

    def test_no_temporary_survives_a_successful_write(self):
        terminal_source.save_state(self.state, {'version': terminal_source.STATE_VERSION,
                                                'baselineIds': [], 'pendingIds': [],
                                                'ackedIds': []})
        # The patched os.replace did not actually move anything, so clean the fake up and
        # then do a real write to check the real directory.
        os.replace = self._real_replace
        for name in os.listdir(self.state):
            if '.tmp' in name:
                os.remove(os.path.join(self.state, name))
        terminal_source.save_state(self.state, {'version': terminal_source.STATE_VERSION,
                                                'baselineIds': [], 'pendingIds': [],
                                                'ackedIds': []})
        leftovers = [name for name in os.listdir(self.state) if '.tmp' in name]
        self.assertEqual(leftovers, [], 'a temporary file survived the write')


class DoctorOnDamagedStateTest(CrashScene):
    """The diagnosis of a state directory that is damaged on purpose."""

    def test_the_doctor_calls_it_a_blocker_and_never_a_delivery(self):
        good = self.offer_something()
        with open(self.state_file, 'wb') as handle:
            handle.write(good[:len(good) // 2])
        doctor = load_doctor()
        report = doctor.diagnose(self.state, now_ms=BASE_MS + 60000)
        stats = doctor.stats_only(report)
        self.assertIn('artifact_unreadable', stats['codes'])
        self.assertGreaterEqual(stats['grades']['blocker'], 1)
        self.assertIs(stats['chain_intact'], False)
        self.assertNotEqual(stats['primary'], 'delivered')

    def test_the_diagnosis_of_a_damaged_state_leaks_nothing(self):
        good = self.offer_something()
        with open(self.state_file, 'wb') as handle:
            handle.write(b'{"version": 1, "baselineIds": [')
        doctor = load_doctor()
        text = json.dumps(doctor.stats_only(
            doctor.diagnose(self.state, now_ms=BASE_MS + 60000)), ensure_ascii=False)
        for secret in (self.state, self.root, uuid(1), uuid(2), 'secret-project'):
            self.assertNotIn(secret, text, 'the stats form leaked %r' % (secret,))


if __name__ == '__main__':
    unittest.main()
