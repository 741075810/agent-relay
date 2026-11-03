"""Shadow observation: what the chain *would* report, computed against a copy, with nothing switched on.

Default is **off**. Without `--enable` this prints one line and exits 0. With it:

  * the Bridge database is read through `mode=ro` and copied into a temporary directory;
  * the real `host.py` is run against that copy, with a temporary state directory and an empty ledger root;
  * the answer is printed as a table: what would be offered, why, and what would be refused.

It never starts the relay service, never posts candidates, never writes to the production state directory, and never
touches a page. `productionWrites` in the output is a claim the tests check by hashing the source database before and
after, and by running against a state directory whose contents must be unchanged.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

OPS = ('terminal-mirror',)


def prove_read_only(conn):
    """Try to write through the handle and require the database to refuse.

    A claim of "read-only" that is only a comment is worth nothing; this makes SQLite itself answer.
    """
    try:
        conn.execute('create table shadow_write_probe(x)')
    except Exception as exc:                                     # noqa: BLE001 - the refusal is the evidence
        return 'refused:%s' % exc.__class__.__name__
    return 'WROTE'


def copy_database(source, target_dir):
    """A private copy, so even a bad SQL cannot reach the operator's file."""
    conn = sqlite3_connect_readonly(source)
    try:
        target = os.path.join(target_dir, 'shadow-service.sqlite')
        destination = sqlite3_connect(target)
        try:
            conn.backup(destination)
        finally:
            destination.close()
        return target
    finally:
        conn.close()


def sqlite3_connect_readonly(path):
    import sqlite3
    uri = 'file:%s?mode=ro' % path.replace('\\', '/').replace('?', '%3f').replace('#', '%23')
    conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    conn.execute('pragma query_only=1')
    return conn


def sqlite3_connect(path):
    import sqlite3
    return sqlite3.connect(path)


def run_mirror(repo_root, db_path, state_dir, native_root, ledger_root=None):
    """The shipping host, unmodified, pointed at the copy."""
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    host = os.path.join(repo_root, 'host.py')
    manifest = os.path.join(state_dir, 'shadow_manifest.json')
    with open(manifest, 'w', encoding='utf-8') as handle:
        json.dump({'name': 'com.dsh.notify.shadow', 'type': 'stdio',
                   'allowed_origins': ['chrome-extension://' + 'a' * 32 + '/']}, handle)
    fixture = os.path.join(state_dir, 'shadow-origin.fixture.json')
    with open(fixture, 'w', encoding='utf-8') as handle:
        json.dump({'version': 1, 'bridge': '*'}, handle)
    argv = [sys.executable, '-B', host, 'chrome-extension://' + 'a' * 32 + '/',
            '--state-dir', state_dir, '--ledger-root', os.path.join(state_dir, 'empty-ledger'),
            '--manifest', manifest, '--bridge-db', db_path, '--bridge-db-fixture', fixture,
            '--native-root', native_root]
    if ledger_root:
        argv[argv.index('--ledger-root') + 1] = ledger_root
    os.makedirs(argv[argv.index('--ledger-root') + 1], exist_ok=True)
    os.makedirs(native_root, exist_ok=True)
    import protocol as P
    request = {'v': P.PROTOCOL_VERSION, 'id': 'shadow-1', 'op': 'terminal-mirror'}
    proc = subprocess.run(argv, input=P.encode(request), capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode('utf-8', 'replace')[-400:])
    import io
    reply = P.read_message(io.BytesIO(proc.stdout))
    if not reply.get('ok'):
        raise RuntimeError('host refused: %s' % reply)
    return reply['result']


def classify(result, arm_ms):
    """What the sampling host would do with each candidate, given an arm instant."""
    rows = []
    for item in result.get('candidates') or []:
        instant = item.get('completedAt')
        source = item.get('completedAtSource')
        verdict = 'deferred'
        if isinstance(instant, (int, float)) and source and source.startswith('bridge.task_events.'):
            if arm_ms is None:
                # No boundary supplied: the evidence exists, but whether it is *after consent* is not this tool's call.
                verdict = 'evidence-ok (no arm supplied)'
            else:
                verdict = 'history (before consent)' if instant <= arm_ms else 'would-announce'
        elif not source or source == 'unknown':
            verdict = 'deferred (no terminal event)'
        rows.append({'runId': str(item.get('runId'))[:8], 'status': item.get('status'),
                     'completedAt': instant, 'source': source, 'verdict': verdict})
    return rows


def run_shadow(options):
    source = options.bridge_db
    before = _digest(source)
    probe = sqlite3_connect_readonly(source)
    try:
        read_only_proof = prove_read_only(probe)
    finally:
        probe.close()
    with tempfile.TemporaryDirectory(prefix='relay-shadow-') as work:
        db = copy_database(source, work)
        state = os.path.join(work, 'state')
        os.makedirs(state)
        ledger = options.ledger_root or os.path.join(work, 'empty-ledger')
        result = run_mirror(options.repo_root, db, state, os.path.join(work, 'native'), ledger)
    after = _digest(source)
    rows = classify(result, options.arm_ms)
    counts = {}
    for row in rows:
        counts[row['verdict']] = counts.get(row['verdict'], 0) + 1
    return {'candidates': len(rows), 'byVerdict': counts, 'rows': rows,
            'completionError': result.get('completionError'),
            'readOnlyProof': read_only_proof,
            'ledgerRoot': options.ledger_root or 'empty (no runs to match)',
            # The Bridge writes while it runs, so on a live database the digest moves for reasons that have nothing to
            # do with this tool. What is provable is the handle: SQLite itself refuses a write through it.
            'sourceDigestChanged': before != after,
            'productionWrites': 0 if read_only_proof != 'WROTE' else 1}


def _digest(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 16), b''):
            digest.update(block)
    return digest.hexdigest()


def render(report):
    lines = ['relay shadow observation (no service, no send, no page)']
    lines.append('candidates        : %d' % report['candidates'])
    for verdict, count in sorted(report['byVerdict'].items()):
        lines.append('  %-24s %d' % (verdict, count))
    if report['completionError']:
        lines.append('completion error  : %s' % str(report['completionError'])[:120])
    for row in report['rows'][:40]:
        lines.append('  %-8s %-12s %-15s %-32s %s' % (row['runId'], row['status'] or '-',
                                                      row['completedAt'] or '-', row['source'] or '-', row['verdict']))
    if len(report['rows']) > 40:
        lines.append('  ... %d more' % (len(report['rows']) - 40))
    lines.append('read-only proof   : %s (productionWrites=%d)' % (report['readOnlyProof'], report['productionWrites']))
    lines.append('ledger root       : %s' % report['ledgerRoot'])
    if report['sourceDigestChanged']:
        lines.append('source digest     : changed during the run -- the Bridge is live and still appending;'
                     ' this tool only holds a read-only handle')
    return '\n'.join(lines)


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description='Shadow observation of the terminal chain (default: disabled).')
    ap.add_argument('--enable', action='store_true', help='required; without it nothing runs')
    ap.add_argument('--repo-root', default=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    ap.add_argument('--bridge-db', default=None)
    ap.add_argument('--ledger-root', default=None,
                    help='DSH session ledger to match runs against (read by the production host already);'
                         ' omit to report the database side alone')
    ap.add_argument('--arm-ms', type=int, default=None,
                    help='the arm instant to judge against; omit to treat every candidate as undecided')
    ap.add_argument('--json', action='store_true')
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not args.enable:
        print('shadow observation: disabled (pass --enable; nothing was read and nothing was started)')
        return 0
    if not args.bridge_db:
        print('shadow observation: --bridge-db is required')
        return 2
    report = run_shadow(args)
    print(json.dumps(report, indent=2, sort_keys=True) if args.json else render(report))
    return 0


if __name__ == '__main__':
    sys.exit(main())
