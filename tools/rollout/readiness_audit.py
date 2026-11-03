"""Release-readiness audit: read-only facts about what is installed, and what a rollout would need.

Default is **off**. Without `--audit` this prints one line and exits 0, so nothing can be run by accident. With it, every
access is read-only by construction:

  * files are opened with mode `'r'` and never written, renamed or deleted;
  * the Bridge database is opened through the `file:...?mode=ro` URI with `pragma query_only=1`;
  * the relay service is not contacted at all unless `--probe-relay` is passed.

Nothing it prints is a credential: bearer tokens are reported as `present` plus their length, extension ids are replaced
by `<EXT_ID>`, and home directories are shortened to `~`. The audit's job is to say which components in this chain are
production, which are only ever used by isolated tests, and whether the requested rollout is possible without touching
the operator's Chrome extension.
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys

AUDIT_VERSION = 1
EXT_ID = re.compile(r'chrome-extension://([a-p]{32})')
TERMINAL_KINDS = ('task.completed', 'task.failed', 'task.interrupted')

# Each check answers one question asked by the rollout: can this component do the job it would be asked to do?
CHECKS = (
    ('installed_host_reads_relay', 'the installed host accepts --relay-url/--relay-token-file'),
    ('installed_host_arm_ms', 'the installed host records a millisecond arm instant (armTakenAtMs)'),
    ('installed_host_arm_snapshot', 'the installed host offers terminal-arm-snapshot'),
    ('installed_ext_epoch_bound', 'the installed extension binds postArm to an arm epoch (postArmEpoch)'),
    ('installed_ext_postarm', 'the installed extension honours a host postArm verdict at all'),
    ('launcher_passes_relay', 'the installed launcher forwards --relay-url to the host it starts'),
    ('launcher_present', 'the registered launcher exists at the manifest path'),
    ('manifest_registered', 'a native-messaging manifest names this host for a Chrome extension'),
    ('bridge_db_readable', 'the Bridge database is readable and carries terminal events'),
    ('state_dir_present', 'a terminal-source state directory exists for the sampling host'),
    ('arm_snapshot_present', 'an arm snapshot exists (without one, long runs can never be authorised)'),
)


def shorten(text, home=None):
    """Keep paths useful without publishing an account name."""
    if not isinstance(text, str):
        return text
    home = home or os.path.expanduser('~')
    if home and text.lower().startswith(home.lower()):
        return '~' + text[len(home):]
    return text


def read_text(path):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            return handle.read()
    except OSError:
        return None


def file_sha256(path):
    digest = hashlib.sha256()
    try:
        with open(path, 'rb') as handle:
            for block in iter(lambda: handle.read(1 << 16), b''):
                digest.update(block)
    except OSError:
        return None
    return digest.hexdigest().upper()


def redact(text):
    """Replace real extension ids; the audit is quotable."""
    if not isinstance(text, str):
        return text
    return EXT_ID.sub('chrome-extension://<EXT_ID>', text)


def load_manifest(path):
    """The registered manifest, with the extension id replaced but the count kept."""
    text = read_text(path)
    if text is None:
        return None, 'unreadable'
    try:
        doc = json.loads(text)
    except ValueError:
        return None, 'malformed'
    origins = doc.get('allowed_origins') or []
    return {
        'name': doc.get('name'),
        'type': doc.get('type'),
        'path': shorten(doc.get('path')),
        # Kept unshortened: the launcher has to be opened, and `~` is a display convention, not a path.
        'rawPath': doc.get('path'),
        'path_exists': bool(doc.get('path') and os.path.isfile(doc.get('path'))),
        'origin_count': len(origins),
        'origins': [redact(item) for item in origins],
    }, None


def open_readonly(path):
    """A connection that cannot write even if the SQL tried to."""
    uri = 'file:%s?mode=ro' % path.replace('\\', '/').replace('?', '%3f').replace('#', '%23')
    conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    conn.execute('pragma query_only=1')
    return conn


def inspect_bridge(path):
    """How many terminal runs could ever be authorised, and how many cannot."""
    report = {'path': shorten(path), 'exists': bool(path and os.path.isfile(path))}
    if not report['exists']:
        report['error'] = 'bridge database not found'
        return report
    try:
        conn = open_readonly(path)
    except sqlite3.Error as exc:
        report['error'] = 'unreadable: %s' % exc.__class__.__name__
        return report
    try:
        tables = {row[0] for row in conn.execute("select name from sqlite_master where type='table'")}
        report['has_tasks'] = 'bridge_service_tasks' in tables
        report['has_events'] = 'bridge_service_task_events' in tables
        if not (report['has_tasks'] and report['has_events']):
            report['error'] = 'terminal tables absent'
            return report
        marks = ','.join('?' * len(TERMINAL_KINDS))
        report['terminal_runs'] = conn.execute(
            'select count(distinct t.provider_run_id) from bridge_service_tasks t join bridge_service_task_events e '
            'on e.task_id = t.task_id where e.kind in (%s)' % marks, TERMINAL_KINDS).fetchone()[0]
        report['terminal_without_event'] = conn.execute(
            'select count(*) from bridge_service_tasks t where t.status in (?,?,?) and not exists ('
            'select 1 from bridge_service_task_events e where e.task_id = t.task_id and e.kind in (%s))'
            % marks, ('completed', 'failed', 'interrupted') + TERMINAL_KINDS).fetchone()[0]
        report['repeated_terminal_events'] = conn.execute(
            'select count(*) from (select task_id from bridge_service_task_events where kind in (%s) '
            'group by task_id having count(*) > 1)' % marks, TERMINAL_KINDS).fetchone()[0]
    except sqlite3.Error as exc:
        report['error'] = 'query failed: %s' % exc.__class__.__name__
    finally:
        conn.close()
    return report


def inspect_component(label, root, markers, extra=None):
    """Presence and capability of one source tree, judged by reading it."""
    report = {'label': label, 'root': shorten(root), 'exists': bool(root and os.path.isdir(root))}
    if not report['exists']:
        return report
    found = {}
    for name, needle in markers.items():
        path = os.path.join(root, name)
        text = read_text(path)
        found[name] = None if text is None else (needle in text)
    report['markers'] = found
    if extra:
        report['extra'] = extra(root)
    return report


def tree_facts(root):
    """Sizes and hashes of the files a rollout would replace."""
    facts = {}
    for name in ('host.py', 'host_launcher.exe', 'extension/manifest.json', 'extension/background.js'):
        path = os.path.join(root, name.replace('/', os.sep))
        if os.path.isfile(path):
            facts[name] = {'sha256': file_sha256(path), 'bytes': os.path.getsize(path)}
    return facts


def launcher_forwards(path, needle=b'--relay-url'):
    """Whether the installed launcher's own bytes mention a flag.

    The launcher builds the host command line itself -- `--state-dir` and `--manifest`, then Chrome's arguments -- so a
    relay flag can only reach the host if the binary knows the string. Dropping a new `host.py` beside a launcher that
    never says `--relay-url` therefore enables nothing, and that is worth answering from the binary rather than from a
    README.
    """
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, 'rb') as handle:
            if needle in handle.read():
                return True
            handle.seek(0)
            for block in iter(lambda: handle.read(1 << 16), b''):
                if needle in block:
                    return True
            return False
    except OSError:
        return None


def token_facts(path):
    """Present or not, and how long -- never the value."""
    if not path or not os.path.isfile(path):
        return {'present': False}
    try:
        value = read_text(path) or ''
    except OSError:
        return {'present': True, 'readable': False}
    return {'present': True, 'length': len(value.strip()), 'path': shorten(path)}


def verdict(checks):
    """A rollout is GO only when every blocking check passes."""
    blocking = ('installed_host_reads_relay', 'installed_host_arm_ms', 'installed_host_arm_snapshot',
                'installed_ext_epoch_bound', 'installed_ext_postarm', 'launcher_passes_relay',
                'launcher_present', 'manifest_registered', 'bridge_db_readable')
    failed = [name for name in blocking if checks.get(name, {}).get('ok') is not True]
    return {'decision': 'GO' if not failed else 'NO-GO', 'blocking_failed': failed}


def run_audit(options):
    repo = options.repo_root
    installed = options.installed_root
    report = {'auditVersion': AUDIT_VERSION, 'mode': 'read-only'}

    manifest, manifest_error = load_manifest(options.manifest) if options.manifest else (None, 'not given')
    report['manifest'] = manifest or {'error': manifest_error}

    report['installed'] = inspect_component(
        'installed', installed,
        {'host.py': '--relay-url', 'extension/background.js': 'postArmEpoch',
         'extension/lib/terminal_trigger.js': 'postArmUsable'},
        extra=tree_facts)
    report['repo'] = inspect_component(
        'repo', repo,
        {'host.py': '--relay-url', 'extension/background.js': 'postArmEpoch',
         'extension/lib/terminal_trigger.js': 'postArmUsable'},
        extra=tree_facts)

    bridge = inspect_bridge(options.bridge_db)
    report['bridge'] = bridge
    report['state'] = {'dir': shorten(options.state_dir), 'exists': bool(options.state_dir and os.path.isdir(options.state_dir))}
    if report['state']['exists']:
        arm = os.path.join(options.state_dir, 'terminal-arm.json')
        report['state']['armSnapshot'] = os.path.isfile(arm)
        if report['state']['armSnapshot']:
            try:
                doc = json.loads(read_text(arm) or '{}')
            except ValueError:
                doc = {}
            report['state']['armPrecision'] = 'ms' if isinstance(doc.get('armTakenAtMs'), int) else 'second'
    launcher_path = options.launcher or ((manifest or {}).get('rawPath') if manifest else None)
    report['launcher'] = {'path': launcher_path,
                          'forwards_relay_flag': launcher_forwards(options.launcher or launcher_path)}
    report['token'] = token_facts(options.token_file)
    if options.probe_relay and options.relay_url:
        report['relayProbe'] = probe_relay(options.relay_url, options.token_file)

    installed_markers = report['installed'].get('markers') or {}
    checks = {
        'installed_host_reads_relay': {'ok': installed_markers.get('host.py') is True},
        'installed_host_arm_ms': {'ok': arm_ms_supported(installed)},
        'installed_host_arm_snapshot': {'ok': host_has(installed, 'terminal-arm-snapshot')},
        'installed_ext_epoch_bound': {'ok': installed_markers.get('extension/background.js') is True
                                      and installed_markers.get('extension/lib/terminal_trigger.js') is True},
        'installed_ext_postarm': {'ok': ext_has(installed, 'postArm')},
        'launcher_passes_relay': {'ok': report['launcher']['forwards_relay_flag'] is True},
        'launcher_present': {'ok': bool((manifest or {}).get('path_exists'))},
        'manifest_registered': {'ok': bool(manifest and manifest.get('origin_count'))},
        'bridge_db_readable': {'ok': bridge.get('has_events') is True and 'error' not in bridge},
        'state_dir_present': {'ok': report['state']['exists']},
        'arm_snapshot_present': {'ok': bool(report['state'].get('armSnapshot'))},
    }
    for name, detail in CHECKS:
        checks[name]['question'] = detail
    report['checks'] = checks
    report['verdict'] = verdict(checks)
    return report


def host_has(root, needle):
    if not root:
        return False
    text = read_text(os.path.join(root, 'host.py'))
    return bool(text and needle in text)


def ext_has(root, needle):
    """A capability in the installed extension's own service worker, not in the host."""
    if not root:
        return False
    text = read_text(os.path.join(root, 'extension', 'background.js'))
    return bool(text and needle in text)


def arm_ms_supported(installed):
    return host_has(installed, 'armTakenAtMs')


def probe_relay(url, token_file):
    """Optional, explicit: one GET against /health, read-only and without printing the token."""
    import urllib.error
    import urllib.request
    token = None
    if token_file and os.path.isfile(token_file):
        token = (read_text(token_file) or '').strip() or None
    request = urllib.request.Request(url.rstrip('/') + '/health', method='GET')
    if token:
        request.add_header('authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            body = response.read(400).decode('utf-8', 'replace')
        return {'reachable': True, 'status': 200, 'body': redact(body)[:200]}
    except urllib.error.HTTPError as exc:
        return {'reachable': True, 'status': exc.code}
    except Exception as exc:                                    # noqa: BLE001 - reported, not raised
        return {'reachable': False, 'error': exc.__class__.__name__}


def render(report):
    lines = ['release readiness audit v%d (read-only)' % AUDIT_VERSION]
    installed = report['installed']
    lines.append('installed tree : %s' % (installed.get('root') if installed.get('exists') else 'absent'))
    if installed.get('extra'):
        for name, facts in sorted(installed['extra'].items()):
            lines.append('  %-28s %7d B  %s' % (name, facts['bytes'], facts['sha256'][:16]))
    if installed.get('markers'):
        for name, value in sorted(installed['markers'].items()):
            lines.append('  %-28s capability %s' % (name, 'yes' if value else 'no'))
    manifest = report.get('manifest') or {}
    launcher = report['launcher']
    lines.append('launcher       : %s' % (launcher.get('path') or 'unknown'))
    lines.append('  forwards --relay-url : %s' % launcher.get('forwards_relay_flag'))
    lines.append('manifest       : %s' % (manifest.get('name') or manifest.get('error')))
    if manifest.get('path'):
        lines.append('  launcher     : %s (exists=%s)' % (manifest['path'], manifest.get('path_exists')))
        lines.append('  origins      : %d' % (manifest.get('origin_count') or 0))
    bridge = report['bridge']
    lines.append('bridge db      : %s' % bridge.get('path'))
    if 'error' in bridge:
        lines.append('  error        : %s' % bridge['error'])
    else:
        lines.append('  terminal runs            : %s' % bridge.get('terminal_runs'))
        lines.append('  terminal without event   : %s  (can never be authorised)'
                     % bridge.get('terminal_without_event'))
        lines.append('  repeated terminal events : %s' % bridge.get('repeated_terminal_events'))
    token = report['token']
    lines.append('relay token    : %s' % ('present, %d chars' % token['length'] if token.get('present') else 'absent'))
    lines.append('checks:')
    for name, entry in report['checks'].items():
        lines.append('  %-26s %-5s %s' % (name, 'ok' if entry['ok'] else 'FAIL', entry['question']))
    lines.append('verdict        : %s' % report['verdict']['decision'])
    if report['verdict']['blocking_failed']:
        lines.append('  blocking     : %s' % ', '.join(report['verdict']['blocking_failed']))
    return '\n'.join(lines)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='Read-only release-readiness audit (default: disabled).')
    ap.add_argument('--audit', action='store_true',
                    help='required; without it nothing is read and the tool exits 0')
    ap.add_argument('--repo-root', default=None)
    ap.add_argument('--installed-root', default=None)
    ap.add_argument('--manifest', default=None)
    ap.add_argument('--bridge-db', default=None)
    ap.add_argument('--state-dir', default=None)
    ap.add_argument('--token-file', default=None)
    ap.add_argument('--launcher', default=None,
                    help='launcher executable to inspect (default: the manifest path); read as bytes, never executed')
    ap.add_argument('--relay-url', default=None)
    ap.add_argument('--probe-relay', action='store_true', help='one GET /health; still writes nothing')
    ap.add_argument('--json', action='store_true')
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not args.audit:
        print('readiness audit: disabled (pass --audit to read-only inspect; nothing was touched)')
        return 0
    report = run_audit(args)
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else render(report))
    return 0 if report['verdict']['decision'] == 'GO' else 3


if __name__ == '__main__':
    sys.exit(main())
