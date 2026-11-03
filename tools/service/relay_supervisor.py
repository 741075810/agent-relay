#!/usr/bin/env python3
"""T221: keep the relay service and its sidecar alive for a logged-on Windows user, without a second task system.

The relay has two processes: `relay_service.mjs` (loopback HTTP, holds the token) and `host_mirror.mjs` (the sidecar that
mirrors the Bridge's terminal state into it). Both were started by hand in T219 and stayed up only because they were
detached from the shell that started them. Nothing brings them back after a crash or a reboot.

This is the smallest thing that fixes that, and it deliberately is not a service:

    python -B tools/service/relay_supervisor.py --once --install-dir <INSTALL>     # one reconcile, for a scheduled task
    python -B tools/service/relay_supervisor.py --status --install-dir <INSTALL>   # what it last did
    python -B tools/service/relay_supervisor.py --loop --interval 60 ...           # stay resident instead

Properties that are required rather than nice:

  * **Single instance.** A named mutex (`Global\\`-free, per-session name) makes a second invocation exit with
    `already_running` instead of starting a second sidecar. Two sidecars would double-post candidates; two services on the
    same port would fail, and one of them would shadow the other's state.
  * **It starts processes; it never writes their state.** The host's `state\\`, the arm snapshot, the Bridge database and
    the relay's `relay.json` are read-only to this tool. Restarting a process must not look like re-arming.
  * **The token never appears on a command line or in a log.** `relay.txt` names a token *file*; the sidecar is given that
    path, exactly as the launcher is. Health probes read the file into memory and compare nothing but the status code.
  * **Everything is reversible by deleting one scheduled task.** No service is installed, no registry key is created, no
    files outside the install directory and the task definition.

Refusal codes are named and reach the caller: `relay_unconfigured`, `token_missing`, `manifest_missing`,
`already_running`, `service_unreachable`, `sidecar_missing`.
"""

import argparse
import ctypes
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

MUTEX_PREFIX = 'DSH-Relay-Supervisor-'
LOG_MAX_BYTES = 512 * 1024


def now():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def mutex_name(install):
    """One mutex per install directory: two supervisors for the same relay is the failure being prevented, while a
    drill install and the production install are genuinely different relays and must not block each other."""
    digest = hashlib.sha1(os.path.abspath(install).lower().encode('utf-8')).hexdigest()[:12]
    return MUTEX_PREFIX + digest


def acquire_mutex(install):
    """A kernel mutex: released by the OS when the process dies, so a crash cannot leave a stale lock."""
    if os.name != 'nt':
        return None, 'unsupported_platform'
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateMutexW(None, False, mutex_name(install))
    if not handle:
        return None, 'mutex_failed'
    if kernel32.GetLastError() == 183:            # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        return None, 'already_running'
    return handle, None


def read_config(install):
    path = os.path.join(install, 'relay_autostart.json')
    try:
        with open(path, encoding='utf-8-sig') as handle:
            return json.load(handle) or {}
    except (OSError, ValueError):
        return {}


def read_relay(install):
    path = os.path.join(install, 'relay.txt')
    try:
        with open(path, encoding='utf-8-sig') as handle:
            lines = [line.strip() for line in handle.read().splitlines() if line.strip()]
    except OSError:
        return None, None
    if len(lines) < 2:
        return None, None
    return lines[0], lines[1]


def manifest_origin(install):
    try:
        with open(os.path.join(install, 'host_manifest.json'), encoding='utf-8-sig') as handle:
            doc = json.load(handle) or {}
    except (OSError, ValueError):
        return None
    origins = doc.get('allowed_origins') or []
    return origins[0] if origins else None


def health(base, token_file, timeout=5):
    """(state, detail): healthy / unauthorized / unreachable. Never returns or logs the token."""
    token = ''
    try:
        with open(token_file, encoding='utf-8') as handle:
            token = handle.read().strip()
    except OSError:
        return 'token_missing', None
    request = urllib.request.Request(base.rstrip('/') + '/health',
                                     headers={'authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            body = response.read(4000).decode('utf-8', 'replace')
    except urllib.error.HTTPError as exc:
        return ('unauthorized' if exc.code in (401, 403) else 'unexpected_status'), 'HTTP %d' % exc.code
    except (urllib.error.URLError, OSError):
        return 'unreachable', None
    if status != 200:
        return 'unexpected_status', 'HTTP %d' % status
    # A 200 is not enough: any listener can return one. Only a reply carrying the service's own envelope counts, so an
    # unrelated program on the port cannot be mistaken for a healthy relay.
    try:
        doc = json.loads(body)
    except ValueError:
        return 'not_a_relay', 'the reply is not JSON'
    if not isinstance(doc, dict) or doc.get('ok') is not True or 'version' not in doc:
        return 'not_a_relay', 'the reply has no ok/version envelope'
    return 'healthy', 'v%s' % doc.get('version')


def listening(port, timeout=2):
    if not port:
        return False
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex(('127.0.0.1', int(port))) == 0


def port_of(base):
    try:
        return int(base.rsplit(':', 1)[1].split('/')[0])
    except (IndexError, ValueError):
        return None


def find_processes(install):
    """Node processes whose command line names this install, split by which script they run.

    Via PowerShell's CIM query rather than `wmic`: wmic is deprecated and absent on current Windows, and a silent empty
    result there would look exactly like "nothing is running", which is the answer that spawns a duplicate.
    """
    found = {'service': [], 'sidecar': []}
    command = ("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
               "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress")
    try:
        out = subprocess.run(['powershell', '-NoProfile', '-Command', command],
                             capture_output=True, text=True, timeout=60).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return found, 'query_failed'
    if not out:
        return found, None
    try:
        rows = json.loads(out)
    except ValueError:
        return found, 'query_unparsable'
    if isinstance(rows, dict):
        rows = [rows]
    wanted = os.path.abspath(install).lower()
    for row in rows:
        text = (row.get('CommandLine') or '').lower()
        if wanted not in text:
            continue
        if 'relay_service.mjs' in text:
            found['service'].append(int(row['ProcessId']))
        elif 'host_mirror.mjs' in text:
            found['sidecar'].append(int(row['ProcessId']))
    return found, None


def process_map(install):
    """{pid: 'service'|'sidecar'} for the node processes whose command line names this install.

    The pid file alone proves nothing: pids are reused, and a pid that is alive can be any program at all. What makes a
    process "ours" is its command line naming this install and the script it runs, which is what this returns.
    """
    found, trouble = find_processes(install)
    mapping = {}
    for pid in found['service']:
        mapping[pid] = 'service'
    for pid in found['sidecar']:
        mapping[pid] = 'sidecar'
    return mapping, trouble


def pid_exists(pid):
    """Whether *any* process holds this pid. Used only to tell "gone" from "something else is wearing this pid"."""
    if not pid:
        return False
    try:
        out = subprocess.run(['tasklist', '/FI', 'PID eq %d' % int(pid), '/NH'],
                             capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return bool(out.strip()) and 'No tasks' not in out


def kill_pid(pid):
    try:
        subprocess.run(['taskkill', '/PID', str(int(pid)), '/F'], capture_output=True, timeout=30)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def spawn(command, cwd, log_path, env=None):
    """Detached: no inherited handles, so the caller can exit and the child keeps running."""
    flags = 0
    if os.name == 'nt':
        flags = 0x00000008 | 0x00000200            # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    handle = open(log_path, 'ab')
    try:
        proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=handle, stderr=handle,
                                close_fds=True, creationflags=flags, env=env)
    finally:
        handle.close()
    return proc.pid


class Supervisor:

    def __init__(self, install):
        self.install = os.path.abspath(install)
        self.config = read_config(self.install)
        self.relay_dir = os.path.join(self.install, 'relay')
        self.log_path = os.path.join(self.relay_dir, 'supervisor.log')
        self.status_path = os.path.join(self.relay_dir, 'supervisor.json')
        self.sidecar_pid_path = os.path.join(self.relay_dir, 'sidecar.pid')
        self.service_pid_path = os.path.join(self.relay_dir, 'service.pid')
        os.makedirs(self.relay_dir, exist_ok=True)
        self.actions = []

    # ---- logging ---------------------------------------------------------------------------------------------------
    def log(self, code, detail=''):
        line = '%s %s %s\n' % (now(), code, detail)
        try:
            if os.path.getsize(self.log_path) > LOG_MAX_BYTES:
                os.replace(self.log_path, self.log_path + '.1')
        except OSError:
            pass
        with open(self.log_path, 'a', encoding='utf-8') as handle:
            handle.write(line)

    def record(self, code, detail=''):
        self.actions.append({'at': now(), 'code': code, 'detail': detail})
        self.log(code, detail)

    # ---- identity ---------------------------------------------------------------------------------------------------
    def inventory(self, quiet=False):
        """A fresh map of pids this install owns. A query failure is a refusal, not an empty answer: "I could not look"
        and "nothing is running" must not collapse into one, because the second one starts a duplicate process."""
        mapping, trouble = process_map(self.install)
        if trouble:
            if not quiet:
                self.record('inventory_unavailable', trouble)
            return None
        return mapping

    def read_pid(self, path):
        try:
            with open(path, encoding='ascii') as handle:
                return int(handle.read().strip() or 0) or None
        except (OSError, ValueError):
            return None

    def write_pid(self, path, pid):
        with open(path, 'w', encoding='ascii') as handle:
            handle.write('%d\n' % pid)

    def service_owner(self, inventory):
        """The pid of the relay service that belongs to this install, or None when that cannot be proven."""
        pid = self.read_pid(self.service_pid_path)
        if pid and inventory.get(pid) == 'service':
            return pid
        candidates = sorted(pid for pid, kind in inventory.items() if kind == 'service')
        if len(candidates) == 1:
            return candidates[0]
        return None

    def stop_managed(self, pid, kind):
        """Stop a process this install owns, and prove it left the process table.

        Returns (verdict, detail) with verdict in stopped / not_owned / still_running / unverified. A failed inventory
        query *after* the kill is `unverified`, never `stopped`: reading "I could not look" as "it is gone" is what
        licenses starting a replacement beside a process that may still be running.
        """
        inventory = self.inventory()
        if inventory is None:
            return 'unverified', 'the process inventory was unreadable before the kill'
        if inventory.get(int(pid)) != kind:
            return 'not_owned', 'pid %s is not this install\'s %s' % (pid, kind)
        kill_pid(pid)
        deadline = time.time() + 10
        trouble = None
        while time.time() < deadline:
            time.sleep(0.25)
            fresh = self.inventory(quiet=True)
            if fresh is None:
                trouble = 'the process inventory was unreadable after the kill'
                continue
            if int(pid) not in fresh:
                return 'stopped', 'pid %d left the process table' % int(pid)
        fresh = self.inventory(quiet=True)
        if fresh is None:
            return 'unverified', trouble or 'the process inventory was unreadable after the kill'
        return 'still_running', 'pid %d is still in the process table' % int(pid)

    def await_service(self, base, token_file, seconds=10):
        deadline = time.time() + seconds
        state, detail = 'unreachable', None
        while time.time() < deadline:
            if not os.path.isfile(token_file):
                time.sleep(0.25)
                continue
            state, detail = health(base, token_file, timeout=3)
            if state in ('healthy', 'unauthorized'):
                return state, detail
            time.sleep(0.25)
        return state, detail

    # ---- the two processes ----------------------------------------------------------------------------------------
    def service_command(self, base):
        repo = self.config.get('repo') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        script = os.path.join(repo, 'tools', 'service', 'relay_service.mjs')
        node = self.config.get('node') or 'node'
        return [node, script, '--state-dir', self.relay_dir, '--port', str(port_of(base) or 0)]

    def sidecar_command(self, base, token_file, origin):
        repo = self.config.get('repo') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        script = os.path.join(repo, 'tools', 'service', 'host_mirror.mjs')
        node = self.config.get('node') or 'node'
        python = self.config.get('python') or sys.executable
        poll = int(self.config.get('pollMs') or 20000)
        extra = [str(item) for item in (self.config.get('sidecarArgs') or [])]
        return [node, script,
                '--host-script', os.path.join(self.install, 'host.py'),
                '--python', python,
                '--origin', origin,
                '--state-dir', os.path.join(self.install, 'state'),
                '--manifest', os.path.join(self.install, 'host_manifest.json'),
                '--service-url', base,
                '--service-token-file', token_file,
                '--poll-ms', str(poll)] + extra

    def reconcile(self):
        base, token_file = read_relay(self.install)
        if not base or not token_file:
            self.record('relay_unconfigured', 'relay.txt is absent or short: nothing to keep alive')
            return 'relay_unconfigured'
        origin = manifest_origin(self.install)
        if not origin:
            self.record('manifest_missing', 'no allowed origin in the installed manifest')
            return 'manifest_missing'

        inventory = self.inventory()
        if inventory is None:
            return 'inventory_unavailable'

        # Ordering: on a first run the token does not exist yet -- the service creates it. So a missing token only refuses
        # when something is already listening on that port; otherwise the service is what will produce it.
        if not os.path.isfile(token_file) and listening(port_of(base)):
            self.record('token_missing', 'the port is in use but the token file relay.txt names is absent')
            return 'token_missing'

        state, detail = health(base, token_file)
        if state == 'token_missing':
            # The dangerous shape (port in use, token gone) was refused above. What is left is a first run: the token does
            # not exist because the service has not created it yet.
            state, detail = 'unreachable', None
        restarted_service = False

        if state == 'unreachable':
            # Something may be starting, or wedged, or the port may be free while a process of ours is stuck. Spawning
            # here without looking is how two services end up on one port. So: look first, and only ever replace, never
            # add.
            owned = sorted(pid for pid, kind in inventory.items() if kind == 'service')

            if len(owned) > 1:
                self.record('service_ambiguous',
                            '%d services belong to this install; refusing to add another' % len(owned))
                self.record('sidecar_deferred', 'more than one service is running for this install')
                return 'service_ambiguous'

            if not owned:
                pid = spawn(self.service_command(base), self.install, os.path.join(self.relay_dir, 'service.log'))
                self.write_pid(self.service_pid_path, pid)
                self.record('service_started', 'pid %d' % pid)
                restarted_service = True
                state, detail = self.await_service(base, token_file)
                if state == 'unreachable':
                    self.record('service_unresponsive',
                                'pid %d was started and did not answer /health' % pid)
                    self.record('sidecar_deferred', 'the service has not answered yet; not adding a sidecar')
                    return 'service_unresponsive'
            else:
                live = owned[0]
                self.write_pid(self.service_pid_path, live)
                self.record('service_unresponsive',
                            'pid %d belongs to this install but /health does not answer; not starting a second one' % live)
                state, detail = self.await_service(base, token_file, seconds=8)
                if state == 'unreachable':
                    if listening(port_of(base)):
                        # Something holds the port and does not answer our token: never a reason to start another.
                        self.record('sidecar_deferred', 'the port is held by a process that does not answer')
                        return 'service_unresponsive'
                    verdict, why = self.stop_managed(live, 'service')
                    self.record('service_stop_' + verdict, why)
                    if verdict != 'stopped':
                        self.record('service_restart_refused',
                                    'the unresponsive service could not be stopped verifiably (%s)' % verdict)
                        self.record('sidecar_deferred', 'no replacement is started while the old one is unaccounted for')
                        return 'service_stop_unverified'
                    pid = spawn(self.service_command(base), self.install,
                                os.path.join(self.relay_dir, 'service.log'))
                    self.write_pid(self.service_pid_path, pid)
                    self.record('service_restarted_unresponsive', 'pid %d replaced unresponsive pid %d' % (pid, live))
                    restarted_service = True
                    state, detail = self.await_service(base, token_file)
                    if state != 'healthy':
                        self.record('service_restart_failed', detail or state)
                        self.record('sidecar_deferred', 'service is %s after the restart' % state)
                        return 'service_restart_failed'

        elif state == 'healthy':
            owner = self.service_owner(inventory)
            if owner is None:
                # A 200 with our token, but nothing of this install is in the process table: the listener is not
                # attributable, so readiness is not claimed and no sidecar is added to feed it.
                self.record('service_healthy_unowned',
                            'a listener answers /health but no process of this install owns it')
                self.record('sidecar_deferred', 'the healthy listener cannot be attributed to this install')
                return 'service_healthy_unowned'
            if self.read_pid(self.service_pid_path) != owner:
                self.write_pid(self.service_pid_path, owner)
                self.record('service_adopted', 'pid %d' % owner)
            self.record('service_healthy', 'pid %d (%s)' % (owner, detail or 'v?'))

        elif state == 'unauthorized':
            # The token file changed under a running service: the repair is to restart the service this install owns, so
            # it reads the file again. If no process of this install can be shown to own the listener, the honest answer is
            # to refuse -- killing whatever else answers on that port would be acting on a program we cannot identify.
            owner = self.service_owner(inventory)
            if owner is None:
                self.record('service_unauthorized_foreign',
                            'a listener answers 401 and no process of this install owns it; refusing to touch it')
                self.record('sidecar_deferred', 'service is unauthorized and unowned; a sidecar would post into a wall')
                return 'service_unauthorized_foreign'
            self.record('service_token_rotated', 'restarting the service this install owns (pid %d)' % owner)
            verdict, why = self.stop_managed(owner, 'service')
            if verdict != 'stopped':
                self.record('service_restart_refused',
                            'pid %d could not be stopped verifiably (%s: %s)' % (owner, verdict, why))
                self.record('sidecar_deferred', 'service could not be restarted safely')
                return 'service_stop_unverified' if verdict == 'unverified' else 'service_restart_refused'
            pid = spawn(self.service_command(base), self.install, os.path.join(self.relay_dir, 'service.log'))
            self.write_pid(self.service_pid_path, pid)
            self.record('service_restarted', 'pid %d (after the token file changed)' % pid)
            restarted_service = True
            state, detail = self.await_service(base, token_file)
            if state != 'healthy':
                self.record('service_restart_failed', detail or state)
                self.record('sidecar_deferred', 'service is %s after the restart' % state)
                return 'service_restart_failed'

        else:
            self.record('service_' + state, detail or '')
            self.record('sidecar_deferred', 'service is %s, so a sidecar would post into a wall' % state)
            return 'service_' + state

        inventory = self.inventory()
        if inventory is None:
            return 'inventory_unavailable'

        pid = self.read_pid(self.sidecar_pid_path)
        kind = inventory.get(pid) if pid else None

        if kind == 'sidecar':
            self.record('sidecar_alive', 'pid %d' % pid)
        else:
            if pid and pid_exists(pid):
                # The pid in the file is alive but is not this install's sidecar: pids get reused. Saying "alive" here is
                # how a dead sidecar stays dead while the supervisor reports success.
                self.record('sidecar_pid_foreign', 'pid %d is alive but is not this install\'s sidecar' % pid)
            candidates = sorted(pid_ for pid_, kind_ in inventory.items() if kind_ == 'sidecar')
            if len(candidates) == 1:
                self.write_pid(self.sidecar_pid_path, candidates[0])
                self.record('sidecar_adopted', 'pid %d (the pid file said %s)' % (candidates[0], pid or 'nothing'))
            elif len(candidates) > 1:
                self.record('sidecar_ambiguous',
                            '%d sidecars belong to this install; refusing to add another' % len(candidates))
                self.write_status(base, token_file, origin)
                return 'sidecar_ambiguous'
            else:
                if not os.path.isfile(os.path.join(self.install, 'host.py')):
                    self.record('sidecar_missing', 'host.py is not in the install directory')
                    return 'sidecar_missing'
                new_pid = spawn(self.sidecar_command(base, token_file, origin), self.install,
                                os.path.join(self.relay_dir, 'sidecar.log'))
                self.write_pid(self.sidecar_pid_path, new_pid)
                self.record('sidecar_started',
                            'pid %d%s' % (new_pid, ' (after service restart)' if restarted_service else ''))

        self.write_status(base, token_file, origin)
        return 'ok'

    def write_status(self, base, token_file, origin):
        doc = {
            'version': 1,
            'at': now(),
            'install': self.install,
            'serviceUrl': base,
            'tokenFile': token_file,
            'originPresent': bool(origin),
            'originLength': len(origin) if origin else 0,
            'actions': self.actions[-12:],
            'health': health(base, token_file)[0],
        }
        tmp = self.status_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, indent=2, sort_keys=True)
        os.replace(tmp, self.status_path)


def main(argv=None):
    ap = argparse.ArgumentParser(description='keep the relay service and sidecar alive')
    ap.add_argument('--install-dir', required=True)
    ap.add_argument('--once', action='store_true', help='one reconcile pass, for a scheduled task')
    ap.add_argument('--loop', action='store_true', help='stay resident and reconcile every --interval seconds')
    ap.add_argument('--interval', type=int, default=60)
    ap.add_argument('--status', action='store_true', help='print the last recorded status')
    ap.add_argument('--adopt', action='store_true',
                    help='record the pids of relay processes that are already running, so the supervisor manages them '
                         'instead of starting a second copy')
    args = ap.parse_args(argv)

    if args.status:
        path = os.path.join(args.install_dir, 'relay', 'supervisor.json')
        try:
            with open(path, encoding='utf-8') as handle:
                print(handle.read())
            return 0
        except OSError:
            print('no status recorded at %s' % path, file=sys.stderr)
            return 2

    if args.adopt:
        supervisor = Supervisor(args.install_dir)
        found, trouble = find_processes(supervisor.install)
        report = {'service': found['service'], 'sidecar': found['sidecar']}
        if trouble:
            print(json.dumps({'ok': False, 'code': trouble, 'found': report}, sort_keys=True))
            return 1
        if not found['service'] and not found['sidecar']:
            # Nothing to adopt is a refusal, not a success: reporting ok here is how a duplicate gets started later.
            print(json.dumps({'ok': False, 'code': 'adopt_nothing_found', 'found': report}, sort_keys=True))
            return 1
        if len(found['service']) == 1:
            with open(supervisor.service_pid_path, 'w', encoding='ascii') as writer:
                writer.write('%d\n' % found['service'][0])
            supervisor.record('adopted_service', 'pid %d' % found['service'][0])
        if len(found['sidecar']) == 1:
            with open(supervisor.sidecar_pid_path, 'w', encoding='ascii') as writer:
                writer.write('%d\n' % found['sidecar'][0])
            supervisor.record('adopted_sidecar', 'pid %d' % found['sidecar'][0])
        ambiguous = [name for name, pids in found.items() if len(pids) > 1]
        if ambiguous:
            supervisor.record('adopt_ambiguous', ', '.join('%s=%d' % (name, len(found[name])) for name in ambiguous))
        print(json.dumps({'ok': not ambiguous, 'code': 'adopted' if not ambiguous else 'adopt_ambiguous',
                          'found': report}, sort_keys=True))
        return 0 if not ambiguous else 1

    handle, refusal = acquire_mutex(args.install_dir)
    if refusal:
        print(json.dumps({'ok': False, 'code': refusal}, sort_keys=True))
        return 0 if refusal == 'already_running' else 1

    supervisor = Supervisor(args.install_dir)
    if args.loop:
        while True:
            code = supervisor.reconcile()
            print(json.dumps({'ok': code == 'ok', 'code': code, 'actions': supervisor.actions[-4:]}, sort_keys=True))
            time.sleep(max(5, args.interval))
    code = supervisor.reconcile()
    print(json.dumps({'ok': code == 'ok', 'code': code, 'actions': supervisor.actions[-4:]}, sort_keys=True))
    return 0 if code == 'ok' else 1


if __name__ == '__main__':
    raise SystemExit(main())
