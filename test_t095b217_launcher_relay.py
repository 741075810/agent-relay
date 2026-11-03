"""T217: the launcher is the only component that decides the host's command line.

A host that understands `--relay-url` is unreachable unless the binary that spawns it forwards the flag. This suite runs
the real `host_launcher.exe` twice against a probe `host.py` that records its own argv, so the claim is about argv and
exit codes rather than about source text:

  * no `relay.txt`   -> the command line is exactly the one that shipped before T217 (relay absent, nothing invented);
  * `relay.txt`      -> `--relay-url` and `--relay-token-file` are appended, token path absolute, token value never on
                        the command line;
  * a named token file that is missing -> exit 4 and no host process, because a host that silently runs without its
                        relay turns "no notification" into "nothing finished".

Then the same binary is pointed at the real `host.py` beside a real relay service, and a framed `terminal-list` must
come back through the pipe: the launcher must be transparent to the wire protocol, not merely argument-correct.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.join(ROOT, 'host_launcher.exe')
HAVE_LAUNCHER = os.path.isfile(LAUNCHER)
PYTHON = sys.executable
CHROME_ORIGIN = 'chrome-extension://' + 'a' * 32 + '/'

PROBE = '''import json, os, struct, sys
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'argv.json'), 'w', encoding='utf-8') as handle:
    json.dump(sys.argv[1:], handle)
mode = os.environ.get('T217_PROBE_MODE', 'reply')
if mode == 'reply':
    raw = sys.stdin.buffer.read(4)
    length = struct.unpack('<I', raw)[0] if len(raw) == 4 else 0
    body = sys.stdin.buffer.read(length) if length else b'{}'
    reply = json.dumps({'ok': True, 'echo': json.loads(body.decode('utf-8') or '{}')}).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(reply)) + reply)
    sys.stdout.buffer.flush()
'''


def frame(obj):
    body = json.dumps(obj).encode('utf-8')
    return struct.pack('<I', len(body)) + body


def read_frame(stream):
    head = stream.read(4)
    if len(head) != 4:
        return None
    return json.loads(stream.read(struct.unpack('<I', head)[0]).decode('utf-8'))


@unittest.skipUnless(HAVE_LAUNCHER, 'host_launcher.exe is not built; run launcher\\build_launcher.ps1')
class LauncherForwardsRelayArguments(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='t217-launcher-')
        self.addCleanup(shutil.rmtree, self.dir, True)
        shutil.copyfile(LAUNCHER, os.path.join(self.dir, 'host_launcher.exe'))
        with open(os.path.join(self.dir, 'host.py'), 'w', encoding='utf-8') as handle:
            handle.write(PROBE)
        with open(os.path.join(self.dir, 'host_manifest.json'), 'w', encoding='utf-8') as handle:
            json.dump({'name': 'com.dsh.notify', 'type': 'stdio',
                       'path': os.path.join(self.dir, 'host_launcher.exe'),
                       'allowed_origins': [CHROME_ORIGIN]}, handle)
        self.token = os.path.join(self.dir, 'service.token')
        with open(self.token, 'w', encoding='utf-8') as handle:
            handle.write('t' * 48 + '\n')

    def run_launcher(self, message=None, timeout=60):
        exe = os.path.join(self.dir, 'host_launcher.exe')
        proc = subprocess.Popen([exe, CHROME_ORIGIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
        try:
            out, err = proc.communicate(frame(message) if message is not None else None, timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise
        return proc.returncode, out, err

    def argv(self):
        path = os.path.join(self.dir, 'argv.json')
        self.assertTrue(os.path.isfile(path), 'the probe host never started')
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)

    def test_without_relay_txt_the_command_line_is_unchanged(self):
        code, _out, _err = self.run_launcher({'op': 'hello'})
        self.assertEqual(code, 0)
        argv = self.argv()
        self.assertEqual(argv[:4], ['--state-dir', os.path.join(self.dir, 'state'),
                                    '--manifest', os.path.join(self.dir, 'host_manifest.json')])
        self.assertNotIn('--relay-url', argv)
        self.assertNotIn('--relay-token-file', argv)
        self.assertEqual(argv[-1], CHROME_ORIGIN, 'Chrome appends the caller origin and it must pass through')

    def test_with_relay_txt_the_flags_are_appended_and_the_token_is_not_on_the_command_line(self):
        with open(os.path.join(self.dir, 'relay.txt'), 'w', encoding='utf-8') as handle:
            handle.write('http://127.0.0.1:48123\nservice.token\n')
        code, _out, _err = self.run_launcher({'op': 'hello'})
        self.assertEqual(code, 0)
        argv = self.argv()
        self.assertIn('--relay-url', argv)
        self.assertEqual(argv[argv.index('--relay-url') + 1], 'http://127.0.0.1:48123')
        self.assertIn('--relay-token-file', argv)
        sent = argv[argv.index('--relay-token-file') + 1]
        self.assertEqual(os.path.normcase(sent), os.path.normcase(self.token),
                         'a relative token path must be anchored at the launcher directory')
        self.assertNotIn('t' * 48, ' '.join(argv), 'the token value must never reach the command line')

    def test_a_missing_token_file_stops_the_launcher_before_it_starts_a_host(self):
        with open(os.path.join(self.dir, 'relay.txt'), 'w', encoding='utf-8') as handle:
            handle.write('http://127.0.0.1:48123\nno-such.token\n')
        code, _out, err = self.run_launcher({'op': 'hello'})
        self.assertEqual(code, 4, err[-400:])
        self.assertIn(b'relay token file not found', err)
        self.assertFalse(os.path.isfile(os.path.join(self.dir, 'argv.json')),
                         'the host must not have been started')

    def test_a_blank_relay_txt_means_no_relay(self):
        with open(os.path.join(self.dir, 'relay.txt'), 'w', encoding='utf-8') as handle:
            handle.write('\n\n')
        code, _out, _err = self.run_launcher({'op': 'hello'})
        self.assertEqual(code, 0)
        self.assertNotIn('--relay-url', self.argv())


@unittest.skipUnless(HAVE_LAUNCHER, 'host_launcher.exe is not built; run launcher\\build_launcher.ps1')
class LauncherIsTransparentToTheWire(unittest.TestCase):
    """The real host, reached through the real launcher, beside a real relay service.

    The arm snapshot is written by the shipping tool rather than by this test: a hand-written snapshot is exactly the
    synthetic consent artefact the repository forbids, and the host rejects it (`arm_snapshot_unreadable`), which is how
    this test learned to do it properly.

    What this class can and cannot prove. It proves the launcher forwards the flags, that the real host parses them, and
    that the real relay service is reached by the process the launcher started. It cannot prove what the host decides
    about individual runs: the launcher owns the command line and passes only `--state-dir` and `--manifest`, so the
    Bridge database, the ledger root and the native logs are whichever the machine has. `DSH_BRIDGE_DB` and
    `DSH_BRIDGE_LEDGER` narrow two of those three; the native root has no environment override at all, which is a real
    property of the shipped launcher and is recorded in the runbook rather than papered over here.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='t217-chain-')
        self.addCleanup(shutil.rmtree, self.dir, True)
        for name in os.listdir(ROOT):
            if name.endswith('.py') and not name.startswith('test_'):
                shutil.copyfile(os.path.join(ROOT, name), os.path.join(self.dir, name))
        shutil.copytree(os.path.join(ROOT, 'tools', 'service'), os.path.join(self.dir, 'tools', 'service'))
        shutil.copyfile(LAUNCHER, os.path.join(self.dir, 'host_launcher.exe'))
        with open(os.path.join(self.dir, 'host_manifest.json'), 'w', encoding='utf-8') as handle:
            json.dump({'name': 'com.dsh.notify', 'type': 'stdio',
                       'path': os.path.join(self.dir, 'host_launcher.exe'),
                       'allowed_origins': [CHROME_ORIGIN]}, handle)
        for name in ('state', 'ledger', 'svc'):
            os.makedirs(os.path.join(self.dir, name))
        # the arming tool reads a real ledger shape: one *.runs.json under a per-endpoint directory
        session = os.path.join(self.dir, 'ledger', 'b' * 64)
        os.makedirs(session)
        with open(os.path.join(session, 'endpoint.json.runs.json'), 'w', encoding='utf-8') as handle:
            json.dump([], handle)
        # The launcher has no way to pass --bridge-db, so a spawned host always resolves the default database. The
        # supported override is the environment, and using it is what keeps this suite off the operator's real Bridge.
        from test_t095b211_completion_evidence import build_bridge_db
        self.bridge = os.path.join(self.dir, 'bridge.sqlite')
        build_bridge_db(self.bridge, [])
        self.ledger = os.path.join(self.dir, 'ledger')
        self.env = dict(os.environ, DSH_BRIDGE_DB=self.bridge, DSH_BRIDGE_LEDGER=self.ledger)

    def start_service(self):
        proc = subprocess.Popen(['node', os.path.join(self.dir, 'tools', 'service', 'relay_service.mjs'),
                                 '--state-dir', os.path.join(self.dir, 'svc')],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: (proc.kill(), proc.wait())[0])
        line = proc.stdout.readline().decode('utf-8', 'replace')
        info = json.loads(line)
        return info['base'] if 'base' in info else info.get('url')

    def arm(self, base):
        token = os.path.join(self.dir, 'svc', 'service.token')
        done = subprocess.run([sys.executable, '-B', os.path.join(self.dir, 'tools', 'service', 'arm_with_relay.py'),
                               '--state-dir', os.path.join(self.dir, 'state'),
                               '--ledger-root', os.path.join(self.dir, 'ledger'),
                               '--relay-url', base, '--relay-token-file', token,
                               '--epoch', 't217', '--json'],
                              capture_output=True, text=True, timeout=180)
        return json.loads(done.stdout or '{}'), done.stderr

    def round_trip(self, extra=None):
        exe = os.path.join(self.dir, 'host_launcher.exe')
        message = {'v': 1, 'id': 't217', 'op': 'terminal-list', 'epoch': 't217'}
        message.update(extra or {})
        proc = subprocess.Popen([exe, CHROME_ORIGIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=self.env)
        try:
            out, err = proc.communicate(frame(message), timeout=180)
            code = proc.returncode
        finally:
            if proc.poll() is None:
                proc.kill()
        self.assertEqual(code, 0, err[-800:])
        self.assertTrue(out, 'the launcher swallowed the reply')
        length = struct.unpack('<I', out[:4])[0]
        return json.loads(out[4:4 + length].decode('utf-8'))

    def test_the_host_reads_the_arm_snapshot_that_was_written_beside_it(self):
        base = self.start_service()
        report, err = self.arm(base)
        self.assertTrue(report.get('ok'), (report, err))
        self.assertIn('relay', report.get('sources') or [])
        with open(os.path.join(self.dir, 'state', 'terminal-arm.json'), encoding='utf-8') as handle:
            snapshot = json.load(handle)
        self.assertIn('armTakenAtMs', snapshot, 'the arming tool must record a millisecond boundary')
        with open(os.path.join(self.dir, 'relay.txt'), 'w', encoding='utf-8') as handle:
            handle.write('%s\n%s\n' % (base, os.path.join(self.dir, 'svc', 'service.token')))
        reply = self.round_trip()
        self.assertTrue(reply.get('ok'), reply)
        result = reply.get('result') or {}
        self.assertNotEqual(result.get('code'), 'arm_snapshot_unreadable',
                            'the host could not read the snapshot the tool wrote: %s' % result)
        self.assertEqual(result.get('armEpoch'), 't217', 'the epoch the tool armed is the epoch the host reports')
        self.assertEqual(result.get('armPrecision'), 'ms', 'the boundary the tool wrote must be millisecond-precise')
        self.assertTrue(result.get('armRelayCovered'), 'the snapshot covered the relay and must say so')
        # The launcher passes no source flags, so a host it starts reads this machine's real ledger, Bridge and native
        # logs. That is the production arrangement, and it is why this test asserts wire-level facts -- the arming
        # snapshot was read, the relay was reached -- and never that a particular candidate should or should not be
        # offered. Content-level assertions belong to the suites that can pass --native-root and --bridge-db.
        for candidate in result.get('candidates') or []:
            self.assertIn('runId', candidate)
            self.assertIn('postArm', candidate)

    def test_an_unreachable_relay_is_reported_rather_than_hidden(self):
        base = self.start_service()
        report, err = self.arm(base)
        self.assertTrue(report.get('ok'), (report, err))
        with open(os.path.join(self.dir, 'relay.txt'), 'w', encoding='utf-8') as handle:
            handle.write('http://127.0.0.1:9\n%s\n' % os.path.join(self.dir, 'svc', 'service.token'))
        reply = self.round_trip()
        self.assertTrue(reply.get('ok'), reply)
        result = reply.get('result') or {}
        relayish = {key: value for key, value in result.items() if 'relay' in key.lower()}
        self.assertTrue(relayish, 'a host given a relay must say what it found: %s' % sorted(result))
        self.assertEqual(relayish.get('relayCode'), 'relay_unavailable',
                         'nothing is listening on that port: %s' % relayish)
        self.assertNotEqual(relayish.get('relayActivation'), 'active',
                            'an unreachable relay must not look like an active one: %s' % relayish)


class AuditNoticesAGenerationMismatch(unittest.TestCase):
    """The near-miss this round produced: a new `host.py` beside an old `terminal_source.py`.

    It does not fail loudly. The host is only re-read when Chrome spawns it, so the symptom is an extension that stops
    offering work, with nothing in any UI. The audit has to be able to see the mismatch from the files alone.
    """

    def setUp(self):
        sys.path.insert(0, os.path.join(ROOT, 'tools', 'rollout'))
        import readiness_audit
        self.audit = readiness_audit
        self.dir = tempfile.mkdtemp(prefix='t217-modules-')
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write(self, name, text):
        with open(os.path.join(self.dir, name), 'w', encoding='utf-8') as handle:
            handle.write(text)

    def test_a_new_host_beside_an_old_terminal_source_is_reported_as_incoherent(self):
        self.write('host.py', 'RELAY = "--relay-url"\n')
        self.write('terminal_source.py', 'def sample(state, ledger=None):\n    pass\n')
        facts = self.audit.module_coherence(self.dir)
        self.assertFalse(facts['coherent'])
        self.assertTrue(facts['host_mentions_relay'])
        self.assertFalse(facts['terminal_source_accepts_relay_source'])
        self.assertFalse(facts['relay_merge_present'])

    def test_the_matching_set_is_coherent(self):
        self.write('host.py', 'RELAY = "--relay-url"\n')
        self.write('terminal_source.py', 'def sample(state, relay_source=None):\n    pass\n')
        self.write('relay_merge.py', '# merge\n')
        self.assertTrue(self.audit.module_coherence(self.dir)['coherent'])

    def test_a_host_without_the_relay_does_not_need_the_new_modules(self):
        self.write('host.py', 'OPS = ()\n')
        self.write('terminal_source.py', 'def sample(state):\n    pass\n')
        facts = self.audit.module_coherence(self.dir)
        self.assertTrue(facts['coherent'], 'a pre-relay install must not be reported as broken')

    def test_the_millisecond_marker_is_looked_for_in_the_module_that_writes_it(self):
        """`armTakenAtMs` is written by terminal_source.arm_snapshot, not by host.py.

        Scanning only the host reported a capable install as incapable, which would have blocked a correct switch.
        """
        self.write('host.py', 'OPS = ()\n')
        self.write('terminal_source.py', 'snapshot = {"armTakenAtMs": 1}\n')
        self.assertTrue(self.audit.arm_ms_supported(self.dir))
        self.write('terminal_source.py', 'snapshot = {}\n')
        self.assertFalse(self.audit.arm_ms_supported(self.dir))

    def test_a_dotnet_launcher_is_read_as_utf16_not_only_as_ascii(self):
        """A .NET literal is UTF-16LE; an ASCII-only scan calls a capable launcher incapable."""
        wide = os.path.join(self.dir, 'wide.exe')
        with open(wide, 'wb') as handle:
            handle.write(b'MZ' + '--relay-url'.encode('utf-16-le') + b'\x00' * 40)
        self.assertTrue(self.audit.launcher_forwards(wide))

    def test_the_probe_reports_a_refusal_instead_of_guessing(self):
        """`installed_chain_probe.py` must name what it saw, and exit non-zero when the host refused."""
        probe = os.path.join(ROOT, 'tools', 'rollout', 'installed_chain_probe.py')
        empty = tempfile.mkdtemp(prefix='t217-probe-')
        self.addCleanup(shutil.rmtree, empty, True)
        done = subprocess.run([sys.executable, '-B', probe, '--dir', empty, '--origin', CHROME_ORIGIN],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 2)
        self.assertIn('missing_launcher', done.stderr)


if __name__ == '__main__':
    unittest.main()
