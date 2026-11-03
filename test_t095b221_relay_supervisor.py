"""T221: the relay supervisor, exercised against real processes in a temporary install.

The supervisor's job is to keep two processes alive without becoming a second notification path. So the properties worth
testing are the refusals and the absences:

  * nothing starts when the relay is unconfigured, when the token disappeared under a live service, or when the manifest
    names no origin -- a supervisor that starts a sidecar which cannot authenticate turns one failure into two;
  * a second invocation does not start a second pair (`already_running` via a kernel mutex, and adoption of processes that
    are already there);
  * a killed process comes back;
  * the host's `state/` directory -- which holds the arm snapshot, i.e. the operator's consent -- is byte-identical after
    every run, because "restarted the relay" must never be mistakable for "re-armed a task";
  * the token value appears in no file the supervisor writes.

Real components throughout: the real `relay_service.mjs`, the real `host_mirror.mjs` and the real `host.py`, all pointed at
a temporary install and an empty `--native-root`. Node is required; the suite skips without it.
"""

import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SUPERVISOR = os.path.join(HERE, 'tools', 'service', 'relay_supervisor.py')
HOST_FILES = ('host.py', 'protocol.py', 'terminal_source.py', 'relay_merge.py', 'run_origin.py', 'native_turns.py')


def node_available():
    return shutil.which('node') is not None


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def digest(path):
    if not os.path.exists(path):
        return None
    if os.path.isdir(path):
        hasher = hashlib.sha256()
        for root, dirs, files in os.walk(path):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(root, name)
                hasher.update(os.path.relpath(full, path).encode())
                with open(full, 'rb') as handle:
                    hasher.update(handle.read())
        return hasher.hexdigest()
    with open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


SUPERVISOR_MODULE = os.path.join(HERE, 'tools', 'service', 'relay_supervisor.py')

# Asks Windows whether the console window this process owns is visible. `[Console]::Title` is the wrong question:
# CREATE_NO_WINDOW still creates a console, it just never shows one.
CONSOLE_PROBE = """
Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
'@
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
'@
$h = [W.K]::GetConsoleWindow()
if ($h -eq [System.IntPtr]::Zero) { 'no-console-window' }
elseif ([W.U]::IsWindowVisible($h)) { 'VISIBLE' } else { 'hidden' }
"""

# The driver runs under pythonw.exe (no console of its own), which is the parent the scheduled task creates: a console
# child of a console-less parent gets a brand-new console window unless CREATE_NO_WINDOW is asked for.
CONSOLE_DRIVER = """
import importlib.util, subprocess, sys
spec = importlib.util.spec_from_file_location('sup', sys.argv[3])
sup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sup)
probe, out = sys.argv[1], sys.argv[2]
command = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe]
fixed = sup.run_hidden(command, timeout=60)
plain = subprocess.run(command, capture_output=True, text=True, timeout=60)
with open(out, 'w', encoding='utf-8') as handle:
    handle.write('|'.join([(fixed.stdout or '').strip(), (plain.stdout or '').strip()]))
"""

# Runs the supervisor with the process inventory failing after N successful queries: the shape of "the CIM query broke
# right after the kill", which is where a naive implementation reads "could not look" as "it is gone".
INVENTORY_FAILS_AFTER = """
import importlib.util, sys
spec = importlib.util.spec_from_file_location('sup', r'%s')
sup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sup)
real = sup.process_map
counter = {'n': 0}
limit = int(sys.argv[2])
def flaky(install):
    counter['n'] += 1
    if counter['n'] > limit:
        return {}, 'query_failed'
    return real(install)
sup.process_map = flaky
raise SystemExit(sup.main(['--once', '--install-dir', sys.argv[1]]))
""" % SUPERVISOR_MODULE


class FakeHTTP:
    """A listener that answers whatever the test tells it to: 200 with a relay-shaped body, 200 with junk, or 401."""

    def __init__(self, port, status=200, body=b'{"ok":true,"version":"9.9.9","seq":1}'):
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.HTTPServer(('127.0.0.1', port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.alive = True

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.alive = False


# Runs the supervisor with the process inventory deliberately broken, via the same code path the tool uses at run time.
UNREADABLE_INVENTORY = """
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('sup', r'%s')
sup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sup)
sup.process_map = lambda install: ({}, 'query_failed')
raise SystemExit(sup.main(['--once', '--install-dir', sys.argv[1]]))
""" % SUPERVISOR_MODULE


def pid_alive(pid):
    if not pid:
        return False
    out = subprocess.run(['tasklist', '/FI', 'PID eq %d' % int(pid), '/NH'],
                         capture_output=True, text=True, timeout=20).stdout
    return bool(out.strip()) and 'No tasks' not in out


def process_map_for(install):
    import importlib.util
    spec = importlib.util.spec_from_file_location('sup_map', SUPERVISOR_MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    mapping, _trouble = module.process_map(install)
    return mapping


class Fake401:
    """A listener that answers 401 to everything: the shape of a service whose token we do not have."""

    def __init__(self, port):
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b'{"ok":false}')

            def log_message(self, *args):
                pass

        self.server = http.server.HTTPServer(('127.0.0.1', port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.alive = True

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.alive = False


def start_401_server(port):
    return Fake401(port)


@unittest.skipUnless(sys.platform == 'win32', 'the supervisor uses a Windows mutex and tasklist')
@unittest.skipUnless(node_available(), 'node is not on PATH')
class RelaySupervisorTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='t221-sup-')
        self.install = os.path.join(self.root, 'install')
        os.makedirs(os.path.join(self.install, 'relay'))
        os.makedirs(os.path.join(self.install, 'state'))
        os.makedirs(os.path.join(self.root, 'native'))
        for name in HOST_FILES:
            source = os.path.join(HERE, name)
            if os.path.isfile(source):
                shutil.copy2(source, self.install)
        with open(os.path.join(self.install, 'host_manifest.json'), 'w', encoding='utf-8') as handle:
            json.dump({'name': 'drill', 'type': 'stdio', 'path': 'host_launcher.exe',
                       'allowed_origins': ['chrome-extension://' + 'a' * 32 + '/']}, handle)
        # a state file that must survive every run untouched
        with open(os.path.join(self.install, 'state', 'terminal-arm.json'), 'w', encoding='utf-8') as handle:
            json.dump({'epoch': 'e' * 8, 'armTakenAtMs': 42, 'relayCovered': False}, handle)
        self.port = free_port()
        self.write_config()

    def write_config(self, **overrides):
        config = {
            'repo': HERE,
            'install': self.install,
            'pollMs': 20000,
            'python': sys.executable,
            'node': shutil.which('node') or 'node',
            'sidecarArgs': ['--native-root', os.path.join(self.root, 'native')],
        }
        config.update(overrides)
        with open(os.path.join(self.install, 'relay_autostart.json'), 'w', encoding='utf-8') as handle:
            json.dump(config, handle)

    def write_relay_txt(self, token_name='service.token'):
        with open(os.path.join(self.install, 'relay.txt'), 'w', encoding='ascii') as handle:
            handle.write('http://127.0.0.1:%d\n%s\n' % (self.port, os.path.join(self.install, 'relay', token_name)))

    def tearDown(self):
        self.kill_children()
        shutil.rmtree(self.root, ignore_errors=True)

    # ---- helpers ------------------------------------------------------------------------------------------------
    def run_once(self, expect=0):
        proc = subprocess.run([sys.executable, '-B', SUPERVISOR, '--once', '--install-dir', self.install],
                              capture_output=True, text=True, timeout=180)
        self.assertEqual(proc.returncode, expect, proc.stdout + proc.stderr)
        for line in proc.stdout.splitlines():
            line = line.strip()
            if line.startswith('{'):
                return json.loads(line)
        self.fail('no JSON on stdout: %r' % proc.stdout)

    def children(self):
        """Pids the supervisor recorded, filtered to ones still alive."""
        alive = []
        for name in ('service.pid', 'sidecar.pid'):
            path = os.path.join(self.install, 'relay', name)
            if not os.path.exists(path):
                continue
            with open(path, encoding='ascii') as handle:
                pid = int(handle.read().strip() or 0)
            if pid and subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/NH'],
                                      capture_output=True, text=True, timeout=30).stdout.count(str(pid)):
                alive.append(pid)
        return alive

    def kill_children(self):
        for pid in self.children():
            subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True, timeout=30)
        time.sleep(0.5)

    def wait_for(self, predicate, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(0.25)
        return False

    # ---- refusals ------------------------------------------------------------------------------------------------
    def test_unconfigured_relay_starts_nothing(self):
        result = self.run_once(expect=1)
        self.assertEqual(result['code'], 'relay_unconfigured')
        self.assertEqual(self.children(), [])

    def test_missing_manifest_origin_starts_nothing(self):
        self.write_relay_txt()
        with open(os.path.join(self.install, 'host_manifest.json'), 'w', encoding='utf-8') as handle:
            json.dump({'name': 'drill'}, handle)
        result = self.run_once(expect=1)
        self.assertEqual(result['code'], 'manifest_missing')
        self.assertEqual(self.children(), [])

    def test_token_missing_while_the_port_is_in_use_is_refused(self):
        """The dangerous shape: a service is up, its token file is gone. A sidecar now would post into a wall."""
        self.write_relay_txt()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', self.port))
            listener.listen(1)
            result = self.run_once(expect=1)
        self.assertEqual(result['code'], 'token_missing')
        self.assertNotIn('sidecar.pid', os.listdir(os.path.join(self.install, 'relay')))

    # ---- starting and staying single -----------------------------------------------------------------------------
    def test_starts_the_pair_then_leaves_it_alone(self):
        self.write_relay_txt()
        first = self.run_once()
        self.assertEqual(first['code'], 'ok')
        codes = [action['code'] for action in first['actions']]
        self.assertIn('service_started', codes)
        self.assertIn('sidecar_started', codes)
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30),
                        'the two children are not both alive: %r' % self.children())
        before = self.children()

        second = self.run_once()
        self.assertEqual(second['code'], 'ok')
        self.assertEqual([action['code'] for action in second['actions']], ['service_healthy', 'sidecar_alive'])
        self.assertEqual(self.children().__len__(), 2)
        self.assertEqual(sorted(before), sorted(self.children()), 'a second reconcile replaced a live process')

    def test_killed_service_is_restarted_and_the_sidecar_is_not(self):
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        service_pid, sidecar_pid = self.first_pids()
        subprocess.run(['taskkill', '/PID', str(service_pid), '/F'], capture_output=True, timeout=30)
        self.assertTrue(self.wait_for(lambda: service_pid not in self.children(), timeout=20))
        result = self.run_once()
        self.assertIn('service_started', [action['code'] for action in result['actions']])
        self.assertIn('sidecar_alive', [action['code'] for action in result['actions']])
        self.assertIn(sidecar_pid, self.children())

    def test_killed_sidecar_is_restarted(self):
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        service_pid, sidecar_pid = self.first_pids()
        subprocess.run(['taskkill', '/PID', str(sidecar_pid), '/F'], capture_output=True, timeout=30)
        self.assertTrue(self.wait_for(lambda: sidecar_pid not in self.children(), timeout=20))
        result = self.run_once()
        self.assertIn('sidecar_started', [action['code'] for action in result['actions']])
        self.assertIn(service_pid, self.children(), 'the service was restarted for no reason')

    def first_pids(self):
        pids = []
        for name in ('service.pid', 'sidecar.pid'):
            with open(os.path.join(self.install, 'relay', name), encoding='ascii') as handle:
                pids.append(int(handle.read().strip()))
        return pids[0], pids[1]

    def test_a_resident_loop_holds_the_instance_and_a_second_run_refuses(self):
        self.write_relay_txt()
        loop = subprocess.Popen([sys.executable, '-B', SUPERVISOR, '--loop', '--interval', '120',
                                 '--install-dir', self.install], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(3)
            result = self.run_once()
            self.assertEqual(result['code'], 'already_running')
        finally:
            loop.terminate()
            loop.wait(timeout=30)

    def test_adopt_records_a_running_pair_and_refuses_when_there_is_nothing_to_adopt(self):
        empty = subprocess.run([sys.executable, '-B', SUPERVISOR, '--adopt', '--install-dir', self.install],
                               capture_output=True, text=True, timeout=120)
        self.assertEqual(json.loads(empty.stdout.strip().splitlines()[-1])['code'], 'adopt_nothing_found')
        self.assertEqual(empty.returncode, 1)

        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        for name in ('service.pid', 'sidecar.pid'):
            os.remove(os.path.join(self.install, 'relay', name))
        adopted = subprocess.run([sys.executable, '-B', SUPERVISOR, '--adopt', '--install-dir', self.install],
                                 capture_output=True, text=True, timeout=120)
        self.assertEqual(adopted.returncode, 0, adopted.stdout + adopted.stderr)
        self.assertEqual(len(json.loads(adopted.stdout.strip().splitlines()[-1])['found']['service']), 1)
        self.assertEqual(sorted(self.children()).__len__(), 2)

    # ---- the two things that must not happen ---------------------------------------------------------------------
    def test_consent_state_is_byte_identical_after_a_full_cycle(self):
        arm = os.path.join(self.install, 'state', 'terminal-arm.json')
        before = digest(arm)
        self.write_relay_txt()
        self.run_once()
        self.wait_for(lambda: len(self.children()) == 2, timeout=30)
        self.run_once()
        self.assertEqual(digest(arm), before, 'the supervisor touched the consent snapshot')

    def test_the_token_value_is_written_nowhere(self):
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        token_path = os.path.join(self.install, 'relay', 'service.token')
        self.assertTrue(self.wait_for(lambda: os.path.exists(token_path), timeout=20))
        with open(token_path, encoding='ascii') as handle:
            token = handle.read().strip()
        self.assertGreater(len(token), 16)
        leaking = []
        for root, _, files in os.walk(os.path.join(self.install, 'relay')):
            for name in files:
                if name == 'service.token':
                    continue
                with open(os.path.join(root, name), 'rb') as handle:
                    if token.encode() in handle.read():
                        leaking.append(name)
        self.assertEqual(leaking, [], 'the token appears in %r' % leaking)
        status = json.load(open(os.path.join(self.install, 'relay', 'supervisor.json'), encoding='utf-8'))
        self.assertNotIn('origin', status, 'the status file names the extension id')

    # ---- T222: identity, ownership, and the unauthorized path ----------------------------------------------------
    def unrelated_process(self):
        """A live process that is definitely not this install's sidecar, standing in for a reused pid."""
        proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(180)'])
        self.addCleanup(proc.kill)
        self.assertTrue(self.wait_for(lambda: pid_alive(proc.pid), timeout=20))
        return proc.pid

    def test_a_rotated_token_restarts_the_service_this_install_owns(self):
        """A token file replaced under a running service is a 401 forever unless the service is restarted. It may only be
        restarted when the process can be shown to belong to this install."""
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        service_pid, sidecar_pid = self.first_pids()
        with open(os.path.join(self.install, 'relay', 'service.token'), 'w', encoding='ascii') as handle:
            handle.write('f' * 48 + '\n')

        result = self.run_once()
        codes = [action['code'] for action in result['actions']]
        self.assertEqual(result['code'], 'ok', codes)
        self.assertIn('service_token_rotated', codes)
        self.assertIn('service_restarted', codes)
        self.assertIn('sidecar_alive', codes, 'the sidecar was restarted although only the service was stale')
        self.assertIn(sidecar_pid, self.children(), 'the sidecar was replaced for no reason')
        self.assertNotEqual(self.read_pid('service.pid'), service_pid, 'the stale service was not replaced')
        status = json.load(open(os.path.join(self.install, 'relay', 'supervisor.json'), encoding='utf-8'))
        self.assertEqual(status['health'], 'healthy')

    def test_unauthorized_from_a_listener_this_install_does_not_own_is_refused(self):
        """Something answers 401 on our port and no process of ours owns it: refuse, and touch nothing."""
        server = start_401_server(self.port)
        try:
            self.write_relay_txt()
            with open(os.path.join(self.install, 'relay', 'service.token'), 'w', encoding='ascii') as handle:
                handle.write('a' * 48 + '\n')
            result = self.run_once(expect=1)
            self.assertEqual(result['code'], 'service_unauthorized_foreign')
            codes = [action['code'] for action in result['actions']]
            self.assertIn('sidecar_deferred', codes)
            self.assertTrue(server.alive, 'the foreign listener was killed')
            self.assertEqual([pid for pid, kind in process_map_for(self.install).items() if kind == 'service'], [],
                             'a service was started although a foreign listener holds the port')
        finally:
            server.stop()

    def test_a_reused_pid_is_not_mistaken_for_a_live_sidecar(self):
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        service_pid, sidecar_pid = self.first_pids()
        subprocess.run(['taskkill', '/PID', str(sidecar_pid), '/F'], capture_output=True, timeout=30)
        self.assertTrue(self.wait_for(lambda: not pid_alive(sidecar_pid), timeout=20))
        squatter = self.unrelated_process()
        self.write_pid('sidecar.pid', squatter)

        result = self.run_once()
        codes = [action['code'] for action in result['actions']]
        self.assertEqual(result['code'], 'ok', codes)
        self.assertIn('sidecar_pid_foreign', codes, 'a live foreign pid was accepted as the sidecar')
        self.assertIn('sidecar_started', codes)
        self.assertTrue(pid_alive(squatter), 'the unrelated process was killed')
        new_sidecar = self.read_pid('sidecar.pid')
        self.assertNotEqual(new_sidecar, squatter)
        self.assertTrue(pid_alive(new_sidecar))

    def test_a_wrong_pid_file_adopts_the_running_sidecar_instead_of_adding_one(self):
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        real_sidecar = self.first_pids()[1]
        squatter = self.unrelated_process()
        self.write_pid('sidecar.pid', squatter)

        result = self.run_once()
        codes = [action['code'] for action in result['actions']]
        self.assertEqual(result['code'], 'ok', codes)
        self.assertIn('sidecar_adopted', codes)
        self.assertNotIn('sidecar_started', codes, 'a second sidecar was started beside a live one')
        self.assertEqual(self.read_pid('sidecar.pid'), real_sidecar)
        sidecars = [pid for pid, kind in process_map_for(self.install).items() if kind == 'sidecar']
        self.assertEqual(len(sidecars), 1, sidecars)

    def test_an_unreadable_process_inventory_is_a_refusal(self):
        """'I could not look' must not become 'nothing is running' -- that answer starts a duplicate sidecar."""
        self.write_relay_txt()
        # A file, not `-c`: Windows command-line quoting mangles a multi-line program and the failure then looks like
        # "the supervisor printed nothing".
        script = os.path.join(self.root, 'unreadable_inventory.py')
        with open(script, 'w', encoding='utf-8') as handle:
            handle.write(UNREADABLE_INVENTORY)
        proc = subprocess.run([sys.executable, '-B', script, self.install], capture_output=True, text=True,
                              timeout=120)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn('inventory_unavailable', proc.stdout)
        self.assertEqual(self.children(), [])

    def read_pid(self, name):
        with open(os.path.join(self.install, 'relay', name), encoding='ascii') as handle:
            return int(handle.read().strip())

    def write_pid(self, name, pid):
        with open(os.path.join(self.install, 'relay', name), 'w', encoding='ascii') as handle:
            handle.write('%d\n' % pid)

    # ---- T223: a failed verification is not a success ------------------------------------------------------------
    def test_a_failed_inventory_after_the_kill_is_not_taken_for_an_exit(self):
        """The kill worked; the proof did not. No replacement may be started, because "I could not look" is not "gone"."""
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        service_pid, _sidecar = self.first_pids()
        with open(os.path.join(self.install, 'relay', 'service.token'), 'w', encoding='ascii') as handle:
            handle.write('e' * 48 + '\n')

        script = os.path.join(self.root, 'flaky_inventory.py')
        with open(script, 'w', encoding='utf-8') as handle:
            handle.write(INVENTORY_FAILS_AFTER)
        proc = subprocess.run([sys.executable, '-B', script, self.install, '2'], capture_output=True, text=True,
                              timeout=180)
        output = proc.stdout
        self.assertEqual(proc.returncode, 1, output + proc.stderr)
        self.assertIn('service_stop_unverified', output, output)
        self.assertNotIn('service_restarted', output, 'a replacement was started without proof that the old one stopped')
        self.assertNotIn('service_started', output)
        self.assertIn('sidecar_deferred', output)
        self.assertTrue(self.wait_for(lambda: not pid_alive(service_pid), timeout=20), 'the stale service survived')
        services = [pid for pid, kind in process_map_for(self.install).items() if kind == 'service']
        self.assertEqual(services, [], 'a second service was started beside an unverified stop: %r' % services)

    def test_unreachable_health_with_an_owned_service_replaces_it_instead_of_adding_one(self):
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        old_service = self.first_pids()[0]
        # Point the relay at a port nothing holds: health is unreachable while our service is still running.
        self.port = free_port()
        self.write_relay_txt()

        result = self.run_once()
        codes = [action['code'] for action in result['actions']]
        self.assertNotIn('service_started', codes, 'a second service was spawned beside a running one: %r' % codes)
        self.assertIn('service_restarted_unresponsive', codes, codes)
        self.assertTrue(self.wait_for(lambda: not pid_alive(old_service), timeout=20))
        services = [pid for pid, kind in process_map_for(self.install).items() if kind == 'service']
        self.assertEqual(len(services), 1, 'expecting exactly one replacement, saw %r' % services)

    def test_unreachable_health_with_a_held_port_kills_nothing(self):
        self.write_relay_txt()
        self.run_once()
        self.assertTrue(self.wait_for(lambda: len(self.children()) == 2, timeout=30))
        service_pid = self.first_pids()[0]

        # A port held by something that never answers HTTP, while our own service is alive on another port. The backlog
        # is deep on purpose: the health probe consumes a slot before the port check runs, and a backlog of one makes
        # the later probe look like "nothing is listening" -- which would test the wrong branch.
        held = socket.socket()
        held.bind(('127.0.0.1', 0))
        held.listen(64)
        self.addCleanup(held.close)
        self.port = held.getsockname()[1]
        self.write_relay_txt()

        result = self.run_once(expect=1)
        self.assertEqual(result['code'], 'service_unresponsive')
        self.assertIn('sidecar_deferred', [action['code'] for action in result['actions']])
        self.assertTrue(pid_alive(service_pid), 'a running service was killed because another port was held')

    def test_a_healthy_listener_this_install_does_not_own_is_not_ready(self):
        """200 with our token is not enough: if no process of ours owns the listener, readiness is not claimed."""
        server = FakeHTTP(self.port)
        try:
            self.write_relay_txt()
            with open(os.path.join(self.install, 'relay', 'service.token'), 'w', encoding='ascii') as handle:
                handle.write('b' * 48 + '\n')
            result = self.run_once(expect=1)
            self.assertEqual(result['code'], 'service_healthy_unowned')
            self.assertIn('sidecar_deferred', [action['code'] for action in result['actions']])
            self.assertTrue(server.alive, 'the foreign listener was killed')
            self.assertEqual(self.children(), [], 'a sidecar was started against an unattributable listener')
        finally:
            server.stop()

    def test_a_two_hundred_without_the_relay_envelope_is_not_healthy(self):
        server = FakeHTTP(self.port, status=200, body=b'{"hello":"world"}')
        try:
            self.write_relay_txt()
            with open(os.path.join(self.install, 'relay', 'service.token'), 'w', encoding='ascii') as handle:
                handle.write('c' * 48 + '\n')
            result = self.run_once(expect=1)
            self.assertEqual(result['code'], 'service_not_a_relay')
            self.assertEqual(self.children(), [])
        finally:
            server.stop()

    # ---- T225: no console window may appear on the operator's desktop -------------------------------------------
    def test_a_console_child_of_a_console_less_parent_gets_no_window(self):
        """The defect and the fix, measured in the condition production runs in.

        Under pythonw, `subprocess.run` hands the child a console whose window is visible -- that is the shell that flashed
        every two minutes. Through `run_hidden` the child gets no console window at all.
        """
        pythonw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')
        if not os.path.exists(pythonw):
            self.skipTest('pythonw.exe is not next to the interpreter')
        probe = os.path.join(self.root, 'console_probe.ps1')
        with open(probe, 'w', encoding='utf-8') as handle:
            handle.write(CONSOLE_PROBE)
        driver = os.path.join(self.root, 'console_driver.py')
        with open(driver, 'w', encoding='utf-8') as handle:
            handle.write(CONSOLE_DRIVER)
        out = os.path.join(self.root, 'console_result.txt')
        subprocess.run([pythonw, '-B', driver, probe, out, SUPERVISOR_MODULE], timeout=180, check=True)
        fixed, plain = open(out, encoding='utf-8').read().strip().split('|')
        self.assertIn(fixed, ('no-console-window', 'hidden'),
                      'run_hidden still leaves a visible console window: %r' % fixed)
        # The control is what proves the mechanism, and it puts a real window on the operator's desktop for a moment.
        # The gate runs this suite on every change, so the control is opt-in only: DSH_T226_VISIBLE_CONTROL=1.
        if os.environ.get('DSH_T226_VISIBLE_CONTROL') == '1':
            self.assertEqual(plain, 'VISIBLE', 'the pre-fix path no longer reproduces the visible console')
        else:
            self.assertIn(plain, ('VISIBLE', 'no-console-window', 'hidden'))

    def test_every_console_child_goes_through_the_hidden_helper(self):
        """A new `subprocess.run` anywhere else would reintroduce the flashing window, so the shape is asserted."""
        import ast
        tree = ast.parse(open(SUPERVISOR_MODULE, encoding='utf-8').read())
        allowed = {'run_hidden', 'spawn'}
        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for inner in ast.walk(node):
                if not isinstance(inner, ast.Call) or not isinstance(inner.func, ast.Attribute):
                    continue
                if not (isinstance(inner.func.value, ast.Name) and inner.func.value.id == 'subprocess'):
                    continue
                if inner.func.attr in ('run', 'Popen', 'call', 'check_output', 'check_call') \
                        and node.name not in allowed:
                    offenders.append('%s() calls subprocess.%s' % (node.name, inner.func.attr))
        self.assertEqual(offenders, [], offenders)

    def test_run_hidden_asks_windows_for_no_window(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('sup_flags', SUPERVISOR_MODULE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        captured = {}

        class Recorder:
            def __init__(self, *args, **kwargs):
                captured.update(kwargs)
                self.returncode = 0
                self.stdout = ''
                self.stderr = ''

        original = module.subprocess.run
        module.subprocess.run = Recorder
        try:
            module.run_hidden(['tasklist', '/?'])
        finally:
            module.subprocess.run = original
        self.assertEqual(captured.get('creationflags'), module.CREATE_NO_WINDOW)
        startup = captured.get('startupinfo')
        self.assertIsNotNone(startup)
        self.assertTrue(startup.dwFlags & module.subprocess.STARTF_USESHOWWINDOW)
        self.assertEqual(startup.wShowWindow, module.subprocess.SW_HIDE)

    def test_status_mode_reports_the_last_run(self):
        self.write_relay_txt()
        self.run_once()
        proc = subprocess.run([sys.executable, '-B', SUPERVISOR, '--status', '--install-dir', self.install],
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)['health'], 'healthy')


if __name__ == '__main__':
    unittest.main()
